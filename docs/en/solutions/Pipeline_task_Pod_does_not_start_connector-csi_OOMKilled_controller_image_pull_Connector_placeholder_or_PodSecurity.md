---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2.0"
  - "4.3"
  - "4.3.2"
---

# Pipeline task Pod does not start: connector-csi OOMKilled, controller image pull, Connector placeholder, or PodSecurity

## Issue

A DevOps v4 (Tekton) pipeline is created or run, and a task Pod does not start. One of these symptoms is shown:

- The gitclone Pod stays unstarted while its volume is being mounted.
- The continuous-build API returns HTTP 500, and `katanomi-controller` cannot pull its own image.
- A buildah Pod stays in `Init:0/3`, and kubelet repeats:

  ```text
  Warning FailedMount ... kubelet MountVolume.SetUp failed for volume "ws-<suffix>" : rpc error: code = Unknown desc = failed to get Connector <namespace>/{selectedConnectors()}: Connector.connectors.alauda.io "{selectedConnectors()}" not found
  ```

- The TaskRun Pod is rejected at admission:

  ```text
  pods "<pod>" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false (containers "prepare", "place-scripts", "step-clone" ...)
  ```

  followed by the `capabilities.drop`, `runAsNonRoot`, and `seccompProfile` requirements. Namespaces are created with `pod-security.kubernetes.io/enforce: restricted` by default, and relaxing an application namespace to `privileged` is not acceptable because it places no constraint on user deployments.

A clone that starts and then fails with `fatal: could not read Username` is a missing Git credential, not a mount failure. A step that fails inside Maven, the JDK, or Node.js after the Pod is Running is a build-environment problem.

## Root Cause

### Cause 1: gitclone Pod does not start because `connector-csi` is `OOMKilled`

The gitclone Pod waits for a volume provided by the `connector-csi` component. The `connector-csi` Pod log shows a timeout fetching a ConfigMap, which looks like an API problem, but the Pod's container status shows that it was `OOMKilled` and restarted. The mount handler does not stay alive long enough to finish the volume setup, so the gitclone Pod never leaves the mount phase. Raising the `connector-csi` memory limit lets the mount complete. A ConfigMap RBAC error without `OOMKilled` is not this cause.

### Cause 2: continuous build returns HTTP 500 because `katanomi-controller` cannot pull its image

The controller Pod is not Ready because its image pull fails, so the API it serves returns HTTP 500. Once the pull can succeed, recreating the Pod clears the 500. A 500 while the controller Pod is Running and its image is pulled is a different fault.

### Cause 3: the buildah Pod volume carries the `{selectedConnectors()}` placeholder

A pipeline created in the UI uses the buildah task to build and push to Harbor. The Pod's CSI volume (driver `connectors.alauda.io`, attributes `configuration.names: registry-config`, `connectors: '{selectedConnectors()}'`) still carries the placeholder instead of the Connector selected in the UI, so the CSI driver looks up a Connector that does not exist. This is a known defect in Alauda DevOps Pipelines `tektoncd-operator.v4.8.0` (seen with ACP 4.2.0 and `connectors-operator.v1.9.0`), fixed in Alauda DevOps Pipelines 4.10.

### Cause 4: the namespace enforces `restricted` and the Tekton containers do not meet it

The namespace where the pipeline runs enforces the `restricted` Pod Security Standard, and the Tekton init containers (`prepare`, `place-scripts`) and step containers (`step-*`) do not set the required securityContext fields. The Pod is rejected at admission and never exists.

The Tekton `set-security-context` feature flag is not sufficient on its own. In upstream Tekton the flag only gives a restricted-compatible securityContext to the containers that Tekton injects (init containers such as `prepare` and `place-scripts`, and the affinity assistant). `step-*` containers keep the securityContext that the Task defines, and a BuildKit step that requests `privileged: true` is still rejected by `restricted`. BuildKit build tasks require privileged containers; with privilege turned off the build fails with `operation not permitted`.

## Resolution

### Cause 1: gitclone Pod does not start because `connector-csi` is `OOMKilled`

1. Confirm `OOMKilled` on `connector-csi` and find its owner:

   ```bash
   kubectl get pods -A | grep connector-csi
   kubectl -n <namespace> get pod <connector-csi-pod> -o jsonpath='{.metadata.ownerReferences[0].kind}{" "}{.metadata.ownerReferences[0].name}{"\n"}{.status.containerStatuses[*].name}{" "}{.status.containerStatuses[*].lastState.terminated.reason}{"\n"}'
   ```

   `OOMKilled` in the output is required before the change. Note the owner kind, its name, and the container name, and record the current limits.

2. Raise that container's memory limit on the owning workload. Doubling the current limit is a starting point. Keep the request less than or equal to the new limit.

   > **Warning:** `kubectl set resources` rolls the `connector-csi` Pods. New gitclone mounts fail until the new Pod is Ready; task Pods that already mounted are not affected. Precondition: only when the last terminated reason is `OOMKilled`. Rollback: set the memory limit back to the recorded value with the same command. If a controller reverts the change, the limit is owned by an operator resource or plugin configuration; set it there.

   ```bash
   kubectl -n <namespace> set resources <kind>/<name> -c <container> --limits=memory=<new-limit> --requests=memory=<new-request>
   kubectl -n <namespace> rollout status <kind>/<name>
   ```

   For example, when the old limit was `256Mi`: `--limits=memory=512Mi --requests=memory=256Mi`.

3. Watch the new Pod. Another `OOMKilled` means the limit is still too low; raise it again. The gitclone Pod passes the mount and starts its container.

### Cause 2: continuous build returns HTTP 500 because `katanomi-controller` cannot pull its image

1. Find the controller Pod and read why the pull failed:

   ```bash
   kubectl get pods -A | grep katanomi-controller
   kubectl -n <namespace> describe pod <katanomi-controller-pod> | sed -n '/Events/,$p'
   ```

   `ImagePullBackOff` or `ErrImagePull` on `katanomi-controller`, together with HTTP 500 from continuous build, is this cause.

2. Fix the reason for the pull failure first (registry reachability, scheme, or pull rate), or the replacement Pod hits the same error.

3. Recreate the Pod.

   > **Warning:** Deleting the `katanomi-controller` Pod stops continuous-build reconciliation until the replacement is Ready. Precondition: only when the Pod event is an image-pull failure and the registry path is restored. Rollback: none needed; the owner recreates the Pod from an unchanged spec.

   ```bash
   kubectl -n <namespace> delete pod <katanomi-controller-pod>
   kubectl -n <namespace> rollout status deploy/katanomi-controller
   ```

   If the owner is not a Deployment of that name, wait on the owner from `ownerReferences` instead. The new Pod is Running and continuous-build calls no longer return 500.

### Cause 3: the buildah Pod volume carries the `{selectedConnectors()}` placeholder

1. Confirm the placeholder in the Pod spec and record the operator versions:

   ```bash
   kubectl -n <namespace> describe pod <buildah-pod> | sed -n '/Events/,$p'
   kubectl -n <namespace> get pod <buildah-pod> -o yaml | grep -n 'selectedConnectors'
   kubectl get csv -A | grep -Ei 'tektoncd-operator|connectors-operator'
   ```

   The literal `{selectedConnectors()}` in the volume attributes, with `tektoncd-operator` older than 4.10, is this cause.

2. Download the Alauda DevOps Pipelines 4.10 package from the Alauda application marketplace (for example `tektoncd-operator.latest.amd64.v4.10.0.tgz`, listed as compatible with ACP 4.0 to 4.3), publish it to the cluster, and upgrade.

   > **Warning:** Upgrading Alauda DevOps Pipelines rolls the Tekton controllers and webhooks; PipelineRuns that start during the rollout can fail admission or wait. Precondition: only when the FailedMount names `{selectedConnectors()}` and the installed `tektoncd-operator` is older than 4.10. Upgrade in a quiet window and note the current CSV. Treat the upgrade as one-way: going back requires reinstalling the previous version.

3. Run the pipeline again. The buildah Pod leaves `Init`, and the CSI volume names the real Connector.

### Cause 4: the namespace enforces `restricted` and the Tekton containers do not meet it

1. Read the namespace labels and the containers named in the admission error:

   ```bash
   kubectl get ns <namespace> --show-labels | tr ',' '\n' | grep pod-security
   kubectl get taskrun -n <namespace> <taskrun> -o jsonpath='{.status.conditions[0].message}{"\n"}'
   ```

2. Run pipelines in a namespace that is used only for pipeline runs, and change only that namespace's container security policy (Pod Security Admission level) to privileged, from the namespace settings in the console or with the label. Leave the application namespaces at `restricted`, so user deployments stay constrained.

   > **Warning:** The `privileged` level lets any Pod in that namespace run privileged containers, mount host paths, and run as root. Precondition: only when the error is `violates PodSecurity "restricted:latest"` for Tekton containers such as `prepare`, `place-scripts`, or `step-*`, and the namespace is used for pipeline runs. Record the current labels. Rollback: set `pod-security.kubernetes.io/enforce` back to the recorded value.

   ```bash
   kubectl label ns <pipeline-namespace> pod-security.kubernetes.io/enforce=privileged --overwrite
   kubectl get ns -L pod-security.kubernetes.io/enforce
   ```

   The expected result is `privileged` on the pipeline namespace only and `restricted` on the application namespaces.

3. Run the pipeline again in the pipeline namespace. The TaskRun Pod is created. If a deploy step then fails with `Forbidden` on an application namespace, grant the pipeline's ServiceAccount the permissions it needs in that namespace.

To check whether the Tekton flag is set and which containers the error lists:

```bash
kubectl get tektonpipelines.operator.tekton.dev -o yaml | grep -n 'set-security-context'
kubectl get cm -A | grep feature-flags
```

`step-*` containers in the message depend on the securityContext the Task defines, not on the flag. `privileged` listed for BuildKit steps means the namespace that runs them needs the privileged level.

## Diagnostic Steps

```bash
kubectl get pods -A | grep -Ei 'connector-csi|gitclone|katanomi-controller'
kubectl get events -n <namespace> --sort-by=.lastTimestamp | grep -Ei 'OOMKilled|FailedMount|Forbidden|Failed' | tail -40
```

- gitclone stuck mounting, and `connector-csi` last state `OOMKilled`: Cause 1.
- HTTP 500 from continuous build, and `katanomi-controller` in `ImagePullBackOff`: Cause 2.
- `FailedMount` naming `{selectedConnectors()}`: Cause 3.
- `violates PodSecurity "restricted:latest"` for `prepare`, `place-scripts`, or `step-*`: Cause 4.

A Pending gitclone Pod whose event is `0/N nodes are available` is a scheduling problem, not CSI. A rejection that names the `katanomi-setting-init` init container is covered in "Tekton pipeline Pod rejected by Pod Security admission because of the katanomi-setting-init init container". BuildKit steps rejected for `privileged` are covered in "Image build fails with PodSecurity privileged, a RUN step failing on one node, or a buildah certificate error".
