---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500172
---

# Recovering a node DaemonSet pod stuck on a missing container image layer

## Issue

On an Alauda Container Platform worker node running the `containerd://2.2.1-5` runtime, a pod owned by an `apps/v1` DaemonSet can fail to start in a way that surfaces as a container-creation or image-pull waiting reason in the pod status column (for example `CreateContainerError`, `ImagePullBackOff`, or `ErrImagePull`) returned by `kubectl get pods -n <namespace>`. The condition is node-local — only pods scheduled to the affected node go into the waiting state, while replicas of the same DaemonSet on other nodes continue to start normally.

## Root Cause

The DaemonSet's pod on the affected node cannot get past the container-creation / image-pull stage, so the kubelet keeps reporting the same waiting reason (`CreateContainerError`, `ImagePullBackOff`, or `ErrImagePull`) on the pod status column on every retry. Because the DaemonSet controller pins one pod per node, the same retry loop will continue against that node until the local condition is cleared, while the DaemonSet's pods on other nodes remain unaffected.

## Resolution

Open a shell on the affected node with `kubectl debug node/<node>` and run `crictl rmi --prune` against the local CRI socket — the `crictl` client ships with containerd installs and the `--prune` subcommand is CRI-generic, so it removes unused and dangling images from the runtime regardless of which CRI implementation is in use. After the prune completes, the kubelet's next container-create attempt re-pulls the image and rebuilds the layer cleanly, which is sufficient to clear the waiting state in the common case.

```bash
# from a workstation with kubectl access to the cluster
kubectl debug node/<node> -it --image=<debug-image>

# inside the debug pod
crictl rmi --prune
```

If `crictl rmi --prune` itself returns a socket error, the containerd daemon on the node is not running and the CLI cannot reach the CRI socket (`containerd.sock`); resolve that first by bringing the runtime back up before retrying the prune. The same dependency holds for any other `crictl` subcommand that talks to the runtime.

When the runtime cannot be brought back up in place and the node has to be remediated offline, evict the workload first with `kubectl drain --ignore-daemonsets --delete-emptydir-data <node>` — without `--ignore-daemonsets` the drain refuses to proceed because DaemonSet-managed pods are not evictable by default; with the flag, drain marks the node unschedulable and evicts the non-DaemonSet pods so the node can be worked on. After the runtime is healthy again, return the node to the scheduler with `kubectl uncordon <node>` so it accepts new pods again.

```bash
kubectl drain --ignore-daemonsets --delete-emptydir-data <node>
# remediate the runtime on the node, then:
kubectl uncordon <node>
```

## Diagnostic Steps

Confirm the failure is node-scoped by listing the DaemonSet's pods and reading the waiting reason from the status column — pods on healthy nodes are `Running`, while the pod on the affected node stays in a waiting state such as `ImagePullBackOff` or `ErrImagePull`:

```bash
kubectl get pods -n <namespace> -o wide -l <daemonset-selector>
```

From a node shell opened with `kubectl debug node/<node>`, verify that the runtime is reachable before attempting any cleanup; if `crictl` commands fail with a socket error, the containerd daemon is down and must be recovered first, because every `crictl` operation depends on that CRI socket being up. Once `crictl` responds, `crictl rmi --prune` is the least-invasive next step and is preferred over any on-disk deletion.

If the node has to be taken out of service for runtime remediation, run `kubectl drain --ignore-daemonsets --delete-emptydir-data <node>` and wait for the eviction to complete before touching the runtime — drain alone (without the flag) will refuse to start because of the DaemonSet-managed pods on the node. After remediation, `kubectl uncordon <node>` flips the node back to schedulable so the scheduler resumes placing pods on it.
