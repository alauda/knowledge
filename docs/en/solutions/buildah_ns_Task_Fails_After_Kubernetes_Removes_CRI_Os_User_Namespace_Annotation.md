---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Tekton pipeline that uses the `buildah-ns` task variant (the one that runs `buildah` inside a **user namespace** to avoid needing root on the node) fails to start the container. The task pod lands in `Init:CreateContainerError` and the container's log carries a specific filesystem error:

```text
Error: reading ID mappings from "/proc/0/uid_map":
  open /proc/0/uid_map: no such file or directory
```

The same pipeline, against the same images, on the same git source, **works** on an older cluster version. The break is exactly at the cluster upgrade that crossed into Kubernetes 1.33 territory — everything worked on the older Kubernetes, nothing does after.

## Root Cause

The `buildah-ns` task relies on running inside a **user namespace**, which reshapes UID/GID mappings so a rootless build can manipulate filesystems that would normally require root. On older cluster versions, user namespaces were requested via a CRI-O-specific pod annotation:

```text
io.kubernetes.cri-o.userns-mode: "auto"
```

CRI-O, on seeing the annotation, created the pod with its own user namespace. `buildah` inside read `/proc/0/uid_map` to discover its namespace's mapping and operated within it.

Kubernetes 1.33 removed that annotation path. User namespaces are now supported through a standard Kubernetes field — `pod.spec.hostUsers: false` — which landed as stable in 1.33. With the annotation path gone and the new field not yet consumed by the pipeline task, the `buildah-ns` task lands in a pod that has neither mechanism in effect: no user namespace is created, `/proc/0/uid_map` does not exist (because the pod is using the host's uid map and `/proc/0` is the host init), and `buildah` exits with the read error above.

The durable fix requires the pipeline task template to set `hostUsers: false` on its `TaskRun`'s pod template. Until the task ships with that update, users either stay on a cluster version that still honours the annotation (older Kubernetes) or use the plain `buildah` task without the user-namespace variant.

## Resolution

### Preferred — wait for a task update that uses `hostUsers: false`

The upstream Tekton catalog and the bundled Pipelines operator versions track this; a `buildah-ns` task revision that sets `hostUsers: false` on its pod template arrives along with the rest of the 1.33-aware task set. Once the updated task is available, replace the task reference in the pipeline (or upgrade the Pipelines operator, which reconciles the shipped tasks), and re-run.

After the update, the pod is created with a dedicated user namespace by kubelet/CRI-O, `/proc/0/uid_map` exists and is readable, and `buildah` runs through its normal code path.

Verify on a test run:

```bash
kubectl -n <pipeline-ns> logs <taskrun-pod> -c place-scripts | head
# Should NOT contain the "/proc/0/uid_map" error.
```

### Workaround — use the non-userns `buildah` task

If the pipeline does not require rootless user-namespace isolation (i.e. the pipeline's security posture is already acceptable with the shipped `buildah` task running as a container user configured through `securityContext`), substitute the task reference:

```yaml
# Before
- name: build-image
  taskRef:
    name: buildah-ns
# After
- name: build-image
  taskRef:
    name: buildah
```

This trades user-namespace isolation for the task variant that does not depend on it. Some organisations use user namespaces for multi-tenant cluster isolation where many pipelines share a node; if that is the design goal, the workaround is not acceptable and the fix has to wait for the updated task.

### Workaround — author a custom Task that sets `hostUsers: false`

For environments that must keep user-namespace isolation on a newer cluster before the task update arrives, author a local `Task` (or override the reconciled one) that sets `hostUsers: false` on its pod template:

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: buildah-userns-local
spec:
  podTemplate:
    hostUsers: false          # This is what the shipped task update will eventually do.
  params:
    - name: IMAGE
      description: Image to build / push
  workspaces:
    - name: source
  steps:
    - name: build
      image: quay.io/buildah/stable:latest
      script: |
        #!/usr/bin/env bash
        set -euo pipefail
        cd "$(workspaces.source.path)"
        buildah build -t "$(params.IMAGE)" .
        buildah push "$(params.IMAGE)"
      # The pod-level hostUsers:false propagates here; buildah sees a usable uid_map.
```

Reference `buildah-userns-local` from the pipeline in place of `buildah-ns`. Remove this local task once the bundled one updates, so the pipeline's source of truth goes back to the shipped catalog.

### What does not work

- Adding the old `io.kubernetes.cri-o.userns-mode: "auto"` annotation to the pod. The annotation is ignored on the newer Kubernetes; CRI-O no longer reads it.
- Setting `securityContext.privileged: true` to give `buildah` root. It does not create a user namespace — it just gives the pod broader access — and `buildah-ns` explicitly checks for a user-namespace uid_map, so the check still fails.
- Mounting `/proc/self/uid_map` into the container. The file has to come from kernel-level user-namespace setup; a bind mount from `/proc/self/uid_map` just exposes the host's mapping, which is not what `buildah-ns` expects.

## Diagnostic Steps

Confirm the failure signature on the `TaskRun`'s pod:

```bash
kubectl -n <pipeline-ns> get taskrun <name> -o yaml | \
  yq '.status.conditions[] | select(.type=="Succeeded")'

kubectl -n <pipeline-ns> get pod -l tekton.dev/taskRun=<taskrun-name> \
  -o jsonpath='{.items[0].status.containerStatuses[*].state}{"\n"}' | jq
```

`state.terminated.reason: Error` with a message containing `/proc/0/uid_map` is the exact signature. If the reason is a different string (image pull error, invalid registry secret, etc.), the issue is not this note.

Inspect the task definition to confirm it does not yet declare `hostUsers`:

```bash
kubectl get task buildah-ns -o yaml | yq '.spec.podTemplate // "no podTemplate"'
```

Empty `podTemplate` or a `podTemplate` without `hostUsers` means the task still uses the annotation path. After applying the update (or the local-task workaround), the same query should show `hostUsers: false`.

Finally, validate on a one-off `TaskRun` against a throwaway workspace. If the workaround task runs through to completion and produces the expected image, the fix is correctly applied.
