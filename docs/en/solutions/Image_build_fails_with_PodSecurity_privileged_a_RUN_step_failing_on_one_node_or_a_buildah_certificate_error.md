---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.3"
---

# Image build fails with PodSecurity privileged, a RUN step failing on one node, or a buildah certificate error

## Issue

The image build task of a pipeline fails while the clone and compile tasks pass. One of these symptoms is shown:

- The BuildKit task Pod is never created, and the TaskRun reports:

  ```text
  pods "<run>-build-image-buildkit-v1-pod" is forbidden: violates PodSecurity "baseline:latest": privileged (containers "step-prepare", "step-build", "step-push" must not set securityContext.privileged=true)
  ```

  After the task's privilege setting is turned off, the Pod starts but the `build` step fails with `failed to read dockerfile: failed to mount /tmp/buildkit-mount<id>: [...]: operation not permitted`.
- A Dockerfile `RUN` step, for example `RUN chmod +x ./apps/start.sh && chown -R <user>:<user> /data`, fails with `did not complete successfully: exit code: 1`, but only for build Pods scheduled on one particular node. Restarting that node does not help.
- A buildah build or push to Harbor fails certificate verification, although the registry certificate is issued by a public CA that browsers trust. The pipeline runs when TLS verification is disabled.

## Root Cause

### Cause 1: BuildKit needs a privileged container and the namespace enforces `baseline` or `restricted`

From ACP 4.0 onward, the BuildKit build task requests privileged containers for its steps (`step-prepare`, `step-build`, `step-push`). A namespace that enforces the Pod Security Standard `baseline` rejects `securityContext.privileged=true`, so the Pod is rejected at admission. A namespace that enforces `restricted` rejects the same steps.

Setting the task's `privilege` field to `false` is not a workaround. The Pod is admitted, but BuildKit then cannot mount its snapshot (`failed to mount /tmp/buildkit-mount<id>: [{Type:bind Source:/var/lib/buildkit/runc-native/snapshots/snapshots/1 Target: Options:[rbind ro]}]: operation not permitted`), even for a simple `FROM` / `COPY` / `CMD` Dockerfile. BuildKit pipelines can run only in a namespace whose Pod Security level allows privileged containers.

### Cause 2: containerd's `runc` runtime on one node lacks `SystemdCgroup = true`

The build log on the failing node contains a cgroup error such as:

```text
stat /sys/fs/cgroup/cpuset/kubepods-burstable-pod<uid>.slice:cri-containerd:<id>/buildkit/...: no such file or directory
```

kubelet on the node uses `cgroupDriver: systemd`, but `/etc/containerd/config.toml` on that node has no `SystemdCgroup = true` under `plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options` (it may be set only for another runtime, such as `nvidia`). containerd and runc then use the cgroupfs driver for ordinary containers while kubelet uses systemd. The failing node shows flat cgroup paths such as `/sys/fs/cgroup/cpuset/kubepods-burstable-pod<uid>.slice:cri-containerd:<id>`, while a healthy node shows the systemd hierarchy `/sys/fs/cgroup/<controller>/kubepods.slice/...`. With that mismatch, BuildKit's nested container cannot create its sub-cgroup under the cpuset hierarchy, and the `RUN` step fails. Other workloads, such as Maven Pods on the same node, can still complete.

### Cause 3: the buildah task Pod carries no CA certificates

The buildah Pod of the Buildah task does not include any CA certificates, so it cannot verify the Harbor registry certificate, even one issued by a public CA. To keep TLS verification on, the CA chain has to be given to the buildah container through the Buildah task's `cert-dir` workspace.

## Resolution

### Cause 1: BuildKit needs a privileged container and the namespace enforces `baseline` or `restricted`

1. Read the namespace's Pod Security labels and confirm that the rejected containers are the BuildKit steps:

   ```bash
   kubectl get ns <pipeline-namespace> --show-labels | tr ',' '\n' | grep pod-security
   kubectl get taskrun -n <pipeline-namespace> <taskrun> -o jsonpath='{.status.conditions[0].message}{"\n"}'
   ```

2. Leave the task's `privilege` field at its default (`true`). If it was changed to `false`, set it back; otherwise the `operation not permitted` mount error stays.

3. Allow privileged containers in the namespace, from the namespace settings in the console or with the label.

   > **Warning:** The `privileged` level lets every Pod in the namespace run privileged containers, mount host paths, and run as root. Precondition: only when the TaskRun is rejected with `violates PodSecurity ... privileged` for the BuildKit steps and the namespace is used for pipeline runs. Record the current label values first. Rollback: set `pod-security.kubernetes.io/enforce` back to the recorded value. Prefer a namespace dedicated to pipeline runs, so that application namespaces keep `baseline` or `restricted`.

   ```bash
   kubectl label ns <pipeline-namespace> pod-security.kubernetes.io/enforce=privileged --overwrite
   ```

4. Run the pipeline again. The BuildKit Pod is created and the `build` step reads the Dockerfile.

When application namespaces must stay at `restricted`, run the BuildKit pipelines in a separate namespace used only for pipeline runs, label only that namespace `privileged`, and leave the application namespaces unchanged.

### Cause 2: containerd's `runc` runtime on one node lacks `SystemdCgroup = true`

Apply this only when all failing builds are on one node and the error is the cgroup `stat ... no such file or directory`.

1. Compare the failing node with a node where builds pass:

   ```bash
   kubectl get pod -A -o wide | grep image-build
   # on both nodes
   grep -n -A2 -E 'runtimes\.(runc|nvidia)\.options' /etc/containerd/config.toml
   grep -i cgroupDriver /var/lib/kubelet/config.yaml
   ls /sys/fs/cgroup/cpuset/ | grep -m3 kubepods
   ```

   `cgroupDriver: systemd` on both nodes, `SystemdCgroup = true` under `runtimes.runc.options` only on the healthy node, and flat `kubepods-burstable-pod...slice:cri-containerd:...` directories on the failing node confirm this cause.

2. Add the section on the failing node so that it matches the healthy node:

   ```toml
   [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
     SystemdCgroup = true
   ```

3. containerd reads `config.toml` at start, so restart containerd. Containers already running on the node were created under the old driver, so drain the node first to have its Pods recreated under the new one.

   > **Warning:** Draining evicts every Pod on the node, and restarting containerd interrupts container operations on that node until it is back. Precondition: only when builds fail on this node only, the cgroup `stat` error is confirmed, and the healthy node's `runc` section has `SystemdCgroup = true`. Back up the file first. Rollback: restore the backup, restart containerd, and uncordon the node.

   ```bash
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   # on the node
   cp /etc/containerd/config.toml /etc/containerd/config.toml.bak
   vi /etc/containerd/config.toml
   systemctl restart containerd
   systemctl is-active containerd
   # from a client
   kubectl uncordon <node>
   ```

4. Run the pipeline again on that node. The image-build Pod completes there, and the cgroup paths are under `/sys/fs/cgroup/<controller>/kubepods.slice/`.

### Cause 3: the buildah task Pod carries no CA certificates

1. Get the CA chain that issued the registry certificate (root and intermediate) in PEM form, and store it in the pipeline namespace:

   ```bash
   openssl s_client -connect <harbor-host>:443 -servername <harbor-host> -showcerts </dev/null 2>/dev/null | grep -E 's:|i:'
   kubectl -n <pipeline-namespace> create configmap registry-ca --from-file=ca.crt=<ca-chain.pem>
   ```

2. Bind that ConfigMap to the Buildah task's `cert-dir` workspace (in the workspace section of the pipeline, next to `source`). In PipelineRun YAML:

   ```yaml
   workspaces:
     - name: cert-dir
       configMap:
         name: registry-ca
   ```

   Use the workspace name that your pipeline maps to the task's `cert-dir` workspace.

3. Turn TLS verification back on and run the pipeline. The build and the push to Harbor complete with verification enabled. If verification is still refused, compare the issuer printed by `openssl s_client` with the certificates in the ConfigMap; the chain must contain the issuer of the server certificate.

## Diagnostic Steps

```bash
kubectl get taskrun -n <pipeline-namespace> | tail -10
kubectl get pod -A -o wide | grep image-build
kubectl logs -n <pipeline-namespace> <build-pod> --all-containers --tail=60
```

- TaskRun message `violates PodSecurity "baseline:latest": privileged` (or `restricted:latest` listing `privileged` for the BuildKit steps), or `failed to mount /tmp/buildkit-mount... operation not permitted` after privilege was turned off: Cause 1.
- `RUN` step `exit code: 1` with a cgroup `stat ... no such file or directory`, and every failure on the same node: Cause 2.
- A certificate verification error from buildah to a registry whose certificate is publicly trusted, and the run passes with TLS verification off: Cause 3.

A TaskRun Pod rejected by `restricted:latest` for Tekton containers such as `prepare`, `place-scripts`, or `step-clone` (not BuildKit steps) is covered in "Pipeline task Pod does not start: connector-csi OOMKilled, controller image pull, Connector placeholder, or PodSecurity". A rejection that names the `katanomi-setting-init` init container is covered in "Tekton pipeline Pod rejected by Pod Security admission because of the katanomi-setting-init init container".
