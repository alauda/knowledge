---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500249
---

# Pods Evicted Without a Grace Period Under Node Disk or Memory Pressure

## Issue

On Alauda Container Platform nodes running Kubernetes v1.34.5, workloads can be terminated abruptly when a node comes under disk or memory pressure, with no grace period to shut down cleanly. When the kubelet crosses a hard eviction threshold it terminates the affected pods immediately and does not honor any grace period. By default only the hard eviction thresholds are in effect, and hard thresholds carry no grace period by design, so under disk or memory pressure pods are evicted immediately with no grace period.

## Root Cause

The kubelet's eviction manager supports two threshold types with different timing semantics. Hard eviction thresholds cause immediate pod termination once crossed, with no grace period applied. Soft eviction thresholds (`evictionSoft`) instead honor an associated grace period (`evictionSoftGracePeriod`) before the kubelet evicts a pod. Soft eviction thresholds are not configured on the kubelet by default, which leaves only the hard thresholds active and produces the abrupt, no-grace eviction behavior.

The kubelet's default configuration populates an `evictionHard` map while leaving `evictionSoft` and `evictionSoftGracePeriod` absent from the live merged configuration. This configuration is uniform across worker and control-plane nodes: the same hard thresholds are present and the soft-eviction keys are absent on each node.

## Diagnostic Steps

The kubelet's live merged eviction configuration can be read from its `/configz` endpoint through the kube-apiserver node proxy at `/api/v1/nodes/<node>/proxy/configz`. Querying this endpoint returns the active KubeletConfiguration as JSON, including the eviction threshold maps in effect on that node.

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz"
```

The default response carries an `evictionHard` map with thresholds for `memory.available`, `nodefs.available`, `nodefs.inodesFree`, `imagefs.available`, `imagefs.inodesFree`, and `pid.available`, and contains no `evictionSoft` or `evictionSoftGracePeriod` keys. The absence of `evictionSoft` and `evictionSoftGracePeriod` in the `/configz` output confirms that soft eviction is not configured on that node.

```text
"evictionHard": {
  "memory.available": "100Mi",
  "nodefs.available": "10%",
  "nodefs.inodesFree": "5%",
  "imagefs.available": "15%",
  "imagefs.inodesFree": "5%",
  "pid.available": "10%"
}
```

## Resolution

Configuring `evictionSoft` together with `evictionSoftGracePeriod` introduces a grace period before eviction, giving workloads time to terminate. `evictionSoft` is a map of eviction signal to threshold value — for example `memory.available`, `nodefs.available`, `nodefs.inodesFree`, `imagefs.available`, and `imagefs.inodesFree`. `evictionSoftGracePeriod` is a map of the same eviction signals to a grace duration, for example `memory.available` set to `1m30s`. Both keys must be set as a pair: the grace duration in `evictionSoftGracePeriod` is honored only when the corresponding `evictionSoft` threshold is also set.

The remedy is to set the `evictionSoft` and `evictionSoftGracePeriod` pair on the node's kubelet. Mechanically, this is a standard kubelet-config change: the two maps are added to the kubelet's configuration source (commonly the node-local kubelet config file, such as `/var/lib/kubelet/config.yaml`) and the kubelet is restarted so it reloads the merged configuration. The eviction signals used in both maps are the standard node-pressure signals the kubelet already tracks.

```yaml
evictionSoft:
  memory.available: "500Mi"
  nodefs.available: "15%"
  imagefs.available: "20%"
evictionSoftGracePeriod:
  memory.available: "1m30s"
  nodefs.available: "1m30s"
  imagefs.available: "1m30s"
```

```bash
systemctl restart kubelet
```

Re-read the `/configz` endpoint to inspect the kubelet's current merged eviction configuration on that node; in the default state, the absence of `evictionSoft` and `evictionSoftGracePeriod` confirms soft eviction is off.
