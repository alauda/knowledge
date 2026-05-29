---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Node reports NotReady after missing /var/lib/kubelet/config.json on ACP

## Issue

On Alauda Container Platform clusters whose worker nodes run the vanilla upstream kubelet (observed on cluster `jingguo-7gm6m`, KVM-backed Ubuntu 22.04.1 LTS nodes with kubelet `v1.34.5` and containerd `2.2.1-5`), one node flips to `NotReady` in `kubectl get node` output and stays there. The kubelet on that node has not started and is not posting any node-status heartbeat to the apiserver. The upstream kubelet binary opens `/var/lib/kubelet/config.json` from its startup arguments as the docker-config-style container-registry pull credentials file consumed by the image-pull machinery the kubelet drives directly.

## Root Cause

When `/var/lib/kubelet/config.json` is absent or unreadable, the kubelet fails to start on that node — the binary cannot complete the startup path that opens this credentials file, so the kubelet process never reaches the steady state where it posts the `Ready` condition (`reason=KubeletReady`, message `kubelet is posting ready status`) on its `Node` object. With no kubelet running, the per-node `Lease` in `kube-node-lease` is not renewed: kubelet normally updates `Lease.renewTime` and `Node.status.conditions.lastHeartbeatTime` every `nodeStatusUpdateFrequency=8s` against a `leaseDurationSeconds=40`. Once the lease has not been renewed past that grace window, the node-lifecycle controller flips the `Ready` condition to `Unknown` and the apiserver reports the node as `NotReady`.

## Resolution

Restore `/var/lib/kubelet/config.json` on the affected node by copying the file from any healthy `Ready` node in the same cluster, where a healthy peer with the same image-pull configuration is available. All ACP nodes in a given cluster run a uniform kubelet and node OS build (here `v1.34.5` on Ubuntu 22.04.1 with containerd `2.2.1-5`), so any healthy node is a safe donor for this file; no MCO-style controller stomps the file, so a manually restored copy remains in place after the kubelet comes back. Once the file is present and readable, the kubelet starts on the affected node, begins posting the `Ready` condition and renewing its node lease, and the apiserver flips the node back to `Ready`.

Read the file on a healthy donor node, then write the same bytes to the affected node at `/var/lib/kubelet/config.json` with mode `0600` owned by `root:root`. The read-write path on an ACP node is either direct SSH to the host or `kubectl debug node/<node-name> --image=<utility-image>` mounting the host filesystem under `/host` — the kubelet credentials file lives at `/host/var/lib/kubelet/config.json` from the debug pod's view:

```bash
# From a workstation that can reach a healthy donor node over SSH
ssh <user>@<healthy-node> sudo cat /var/lib/kubelet/config.json > /tmp/kubelet-config.json

# Push the file onto the affected node
scp /tmp/kubelet-config.json <user>@<affected-node>:/tmp/kubelet-config.json
ssh <user>@<affected-node> sudo install -m 0600 -o root -g root \
    /tmp/kubelet-config.json /var/lib/kubelet/config.json

# Start the kubelet on the affected node
ssh <user>@<affected-node> sudo systemctl start kubelet
```

After the kubelet starts, confirm recovery by watching the node flip back to `Ready` and the lease renew within the grace window:

```bash
kubectl get node <affected-node> -o wide
kubectl get lease -n kube-node-lease <affected-node> \
    -o jsonpath='{.spec.renewTime}'
```

## Diagnostic Steps

Identify the affected node and confirm the apiserver-side symptom: a single node sitting at `NotReady` with the `Ready` condition reporting `status=Unknown` (the controller-set "missing heartbeat" form) rather than `status=False` with a kubelet-authored message. Compare the node's `lastHeartbeatTime` against the current time — a value older than the `leaseDurationSeconds=40` grace window confirms the kubelet is not renewing its lease:

```bash
kubectl get node
kubectl get node <affected-node> \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'
kubectl get lease -n kube-node-lease <affected-node> \
    -o jsonpath='{.spec.renewTime}'
```

On the affected node, confirm the kubelet process is not running and that `/var/lib/kubelet/config.json` is absent or unreadable. The kubelet opens this file directly from its startup arguments, so any error reading it surfaces as a kubelet that fails to reach the running state:

```bash
ssh <user>@<affected-node> sudo systemctl status kubelet
ssh <user>@<affected-node> sudo ls -l /var/lib/kubelet/config.json
ssh <user>@<affected-node> sudo journalctl -u kubelet --no-pager | tail -50
```
