---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a cluster using the Ceph-based storage stack that backs ACP `storage/storagesystem_ceph`, the `ceph-csi-controller-manager` pod enters `CrashLoopBackOff`. The pod description shows the `manager` container was killed for exceeding its memory limit:

```text
$ kubectl -n <storage-ns> get pods
NAME                                            READY  STATUS             RESTARTS
ceph-csi-controller-manager-847c49bf46-lprvv    1/2    CrashLoopBackOff   13 (33s ago)
csi-addons-controller-manager-68cffdb84b-9k7nn  2/2    Running            2 (39m ago)

$ kubectl -n <storage-ns> describe pod ceph-csi-controller-manager-847c49bf46-lprvv
...
State:         Waiting
  Reason:      CrashLoopBackOff
Last State:    Terminated
  Reason:      OOMKilled
  Exit Code:   137
  Started:     ...
  Finished:    ...   (~18s after start)
Restart Count: 13
```

The controller runs for a handful of seconds, the Linux kernel OOM-killer reaps it (exit 137 = SIGKILL from an OOM event), and kubelet restarts it. The cycle repeats and the controller never settles into a steady state, so volume attach/detach operations across the cluster stall and reconcile slowly or not at all.

## Root Cause

The `ClusterServiceVersion` (CSV) shipped with the ceph-csi-operator declares conservative memory requests and limits for the controller container (`requests.memory=64Mi`, `limits.memory=128Mi` on typical versions). These values are too low for clusters with many PVCs, heavy reconcile pressure, or a working set of snapshots and volume attributes that forces the controller to hold more metadata in memory than the packaged default allows.

When usage crosses the limit the cgroup OOM-killer terminates the process. There is nothing wrong with the Ceph backend itself; the crash is purely a quota issue on the Kubernetes controller wrapper.

A related caveat: the CSV is owned by the operator bundle. On upgrade, the operator re-applies the bundle's default values and overwrites any in-place edits, which means the fix below may need to be re-applied after every storage stack upgrade until upstream defaults are raised.

## Resolution

Raise the memory `requests` and `limits` for both containers (the `manager` container plus the companion `kube-rbac-proxy` sidecar, whichever pair the CSV defines) on the ceph-csi-operator CSV.

### 1. Capture the current CSV

```bash
NS=<storage-ns>
kubectl -n $NS get csv -l operators.coreos.com/cephcsi-operator.$NS
```

Note the full CSV name (for example `cephcsi-operator.vX.Y.Z-xxxx`).

### 2. Edit the CSV

```bash
kubectl -n $NS edit csv cephcsi-operator.vX.Y.Z-xxxx
```

In the spec, find the `deployments[].spec.template.spec.containers[]` entries and double (or quadruple, if the pod still gets OOMKilled) the memory values. A reasonable starting point:

```yaml
# container "manager"
resources:
  limits:
    cpu: 500m
    memory: 256Mi       # was 128Mi
  requests:
    cpu: 5m
    memory: 128Mi       # was 64Mi

# container "kube-rbac-proxy" (or the sidecar equivalent)
resources:
  limits:
    cpu: 500m
    memory: 256Mi       # was 128Mi
  requests:
    cpu: 10m
    memory: 128Mi       # was 64Mi
```

The operator reconciles the deployment, a new replica is rolled out with the new limits, and the pod stops being reaped.

### 3. Verify the adjusted values landed

```bash
kubectl -n $NS get csv cephcsi-operator.vX.Y.Z-xxxx \
  -o jsonpath='{.spec.install.spec.deployments[*].spec.template.spec.containers[*].resources}' \
  | python3 -m json.tool

# or, more readable:
kubectl -n $NS get csv cephcsi-operator.vX.Y.Z-xxxx -o json \
  | jq '.spec.install.spec.deployments[].spec.template.spec.containers[].resources'
```

Expected output: both containers show the new `limits.memory` and `requests.memory`.

### 4. Watch the pod recover

```bash
kubectl -n $NS rollout status deploy/ceph-csi-controller-manager
kubectl -n $NS get pods -l app.kubernetes.io/name=ceph-csi-controller-manager
```

If the pod still OOMs within a few minutes, repeat the edit with a larger value (512Mi, 1Gi, …). Use the running-pod metric trace from the Diagnostic Steps below to pick the next ceiling; there is no magic number, it scales with how many PVCs, snapshots, and reconcile events the controller is handling.

### 5. Record the change because upgrades overwrite it

The CSV is managed by the operator bundle, so a subsequent ceph-csi-operator upgrade (or ACP `storage/storagesystem_ceph` upgrade that bumps the bundle) resets the limits to the bundle defaults. Track the applied override in change management and re-apply after upgrades until the upstream defaults rise above what the cluster needs. A pragmatic way to automate this is a post-upgrade hook or a GitOps reconciler that re-patches the CSV after the bundle lands.

### OSS fallback

If the cluster is running ceph-csi directly (not through an operator / CSV), the same change is a deployment edit:

```bash
kubectl -n <ns> set resources deploy/ceph-csi-controller \
  -c manager --limits=memory=256Mi --requests=memory=128Mi
```

The only substantive difference is that a manual deployment edit is not overwritten by an operator and therefore persists across upgrades without extra plumbing.

## Diagnostic Steps

1. Confirm the container was OOMKilled rather than exiting on a panic or a probe failure:

   ```bash
   kubectl -n <storage-ns> describe pod -l app.kubernetes.io/name=ceph-csi-controller-manager \
     | sed -n '/Last State/,/Restart Count/p'
   ```

   `Reason: OOMKilled` with `Exit Code: 137` is the signature.

2. Observe the memory high-water mark the controller reaches during its short-lived runs. If the metrics stack is available:

   ```bash
   # adjust the metric name to the current labels the cluster exposes
   container_memory_working_set_bytes{pod=~"ceph-csi-controller-manager.*",container="manager"}
   ```

   Pick a limit that leaves 50 % headroom above the peak.

3. Compare the container's allocated limits against observed usage at crash time:

   ```bash
   kubectl -n <storage-ns> get pod -l app.kubernetes.io/name=ceph-csi-controller-manager \
     -o jsonpath='{.items[0].spec.containers[*].resources.limits}' ; echo
   ```

4. Rule out an actual Ceph-cluster problem driving the controller into a reconcile storm:

   ```bash
   kubectl -n <storage-ns> get cephcluster -o yaml | grep -A3 status
   kubectl -n <storage-ns> get events --sort-by='.lastTimestamp' \
     | grep -Ei 'ceph|csi' | tail -n 20
   ```

   A healthy backend with a tight controller memory budget points squarely at OOM; a degraded backend is a separate, bigger incident.

5. After the CSV edit, monitor the pod for at least one full reconciliation cycle (several minutes under load) before declaring the fix. The restart count should stabilise, volume operations should flow, and `container_memory_working_set_bytes` should plateau below the new limit.
