---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.8"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Node maintenance on ACP: resizing nodes and masters, host shutdown, and disk expansion

## Issue

Planned resource work on nodes that are already in a cluster raises the same questions repeatedly:

- CPU or memory was hot-added to a node VM, but the node still shows the old capacity.
- The three masters of a business cluster are oversized and the CPU license is exhausted. Can they be reduced to free cores for new workers?
- Control-plane, monitoring, and log nodes must become smaller. How do I tell whether a node can be shrunk, and can the Pod requests on it be lowered?
- The hypervisor hosts need a fix. Can the platform VMs be shut down one host at a time?
- After a node disk expansion, restarted component Pods stay in the image-pulling state.

Related articles: "Node maintenance on ACP: OS reinstall or replacement, hostname, IP, NIC, and cluster name changes" covers changes to node identity.

## Root Cause

### Cause 1: Node capacity does not change after a CPU or memory hot-add

kubelet reports the CPU and memory capacity it read when it started. After a hot expansion the node keeps showing the old capacity until kubelet is restarted on that node.

### Cause 2: Shrinking a master or other node is a per-node resize gated by Pod requests

Reducing oversized masters (for example three 64-core, 256 GB business-cluster masters at low utilization with no business workloads or logs, reduced to 16 cores and 32 GB to free licensed cores) is feasible as a per-node resize, one master at a time.

A node can be reduced only when both its utilization and its request rate are low, and at least 3 control-plane nodes must remain. Utilization alone is misleading: a control-plane node with 8 cores and 31.34 Gi can show 11.79% CPU utilization but an 84.00% CPU request rate (limit rate 329.10%), with requests coming largely from Pods such as `region-alb` (2050m), `vmagent-agent` (600m), `ovn-central` (300m), `kube-apiserver` (250m), and `ovs-ovn` and `kube-ovn-monitor` (200m each), well above their actual use. Pod request values like these can be lowered appropriately before the node is resized.

### Cause 3: Host shutdowns must not take several platform VMs down at once

A hypervisor host often carries several platform VMs. Shutting the host down stops all of them together, which can take more than one master down and lose the etcd quorum. Back up etcd first, then handle one VM at a time.

### Cause 4: Pods stay pulling images after a disk expansion because the registry's MinIO cluster broke

After a node disk expansion, restarted component Pods stay in the image-pulling state. The platform image registry's MinIO is abnormal: its three instances cannot form a cluster, so the registry is unavailable. A new raw disk was added directly while the node's containers were still in place and kubelet and containerd had not been stopped correctly; the existing containers then read their original data abnormally, which broke the MinIO cluster. Restarting MinIO and the registry restores it.

## Resolution

### Cause 1: Node capacity does not change after a CPU or memory hot-add

> **Warning:** Restarting kubelet briefly stops status updates for that node; running Pods keep running. Do it in a maintenance window, one node at a time. There is no rollback; if kubelet does not come back, read `journalctl -u kubelet`.

```bash
kubectl get node <node-name> -o jsonpath='{.status.capacity}{"\n"}'
sudo systemctl restart kubelet
systemctl status kubelet --no-pager
kubectl get node <node-name> -o jsonpath='{.status.capacity}{"\n"}'
```

The general cordon, drain, resize, uncordon loop is in "Safely resizing CPU and memory on Alauda Container Platform nodes".

### Cause 2: Shrinking a master or other node is a per-node resize gated by Pod requests

Check usage and placement first. Node names on ACP are often the node IP; use the exact name from `kubectl get nodes`.

```bash
kubectl get nodes -o wide
kubectl top node
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>
```

The request rate decides as much as the usage. The node's monitoring tab in the console shows CPU and memory request rates; the same figures are in `kubectl describe node`:

```bash
kubectl describe node <node-name> | sed -n '/Allocated resources/,/Events/p'
kubectl get pods -A --field-selector spec.nodeName=<node-name> \
  -o custom-columns='NAMESPACE:.metadata.namespace,POD:.metadata.name,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory'
```

A node whose usage is low but whose request rate is high cannot simply be made smaller: the Pods placed there would no longer fit in its allocatable resources, and Pods that do not fit are rejected (for example `OutOfcpu`) or stay `Pending`. Lower the requests of the Pods that over-request first, then resize. Keep at least 3 control-plane nodes throughout.

> **Warning:** A master that is powered off for the resize removes one etcd member and one API server from service. Never take a second master down until the first is back. Back up etcd before starting, and make sure the new size still covers the control-plane Pods listed above. Rollback is resizing the VM back to its old size.

For each master in turn: shut it down, resize it, start it, restart and check kubelet, and wait until the node and its etcd Pod are back before moving on:

```bash
sudo systemctl restart kubelet
systemctl status kubelet --no-pager
kubectl get node <master-node-name>
kubectl -n kube-system get pods -l component=etcd -o wide
```

### Cause 3: Host shutdowns must not take several platform VMs down at once

Back up etcd first. Then choose one of two plans:

- **Business can stop:** stop the business containers, restart the compute nodes one by one and confirm each is normal before the next, then restart the control-plane nodes one by one, then start the business again.
- **Business keeps running:** for one VM at a time, mark it unschedulable and evict the business containers, confirm the business recovered elsewhere, shut down the VM for the fix, start it, make it schedulable again, then move to the next VM.

> **Warning:** Evicting Pods interrupts single-replica workloads until they start on another node. Do not shut down several platform VMs at the same time; two masters down at once loses the etcd quorum of a three-master cluster. Data services such as MySQL or Redis in the cluster need their own plan based on how they are deployed. Rollback for a VM is `kubectl uncordon` after it is back.

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
# shut down, fix, and start the VM, then:
kubectl get node <node-name>
kubectl uncordon <node-name>
```

### Cause 4: Pods stay pulling images after a disk expansion because the registry's MinIO cluster broke

Find the MinIO and registry Pods and read their logs; MinIO instances that cannot form a cluster are this cause:

```bash
kubectl get pods -A -o wide | grep -i -E 'minio|registry'
kubectl logs -n <namespace> <minio-pod> --tail=200
kubectl describe pod -n <namespace> <pod-stuck-pulling> | sed -n '/Events/,$p'
```

> **Warning:** Restarting MinIO and the registry makes image pulls and pushes against the platform registry fail until the new Pods are Ready. Precondition: the stuck Pods pull from the platform registry and the MinIO logs or status show the instances are not forming a cluster. The controllers recreate the Pods, so there is nothing to roll back; the restart does not repair data that is actually damaged on disk.

```bash
kubectl delete pod -n <namespace> <minio-pod-1> <minio-pod-2> <minio-pod-3>
kubectl delete pod -n <namespace> <registry-pod>
kubectl get pods -A -o wide | grep -i -E 'minio|registry'
```

The registry returns to normal and the component Pods finish pulling. For the next disk change on a node, stop kubelet, delete the containers on the node, and stop containerd before the disk is added.

## Diagnostic Steps

Before and after each maintenance step:

```bash
kubectl get nodes -o wide
kubectl get node <node-name> -o jsonpath='{.status.capacity}{"\n"}{.status.allocatable}{"\n"}'
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name> | grep -v Running
kubectl -n kube-system get pods -l component=etcd -o wide
```

- Capacity still shows the old CPU or memory after a resize: kubelet has not been restarted on that node (Cause 1).
- A node with low usage but a high request rate: lower requests before shrinking it (Cause 2).
- More than one master on the same hypervisor host that is about to be shut down: Cause 3.
- Pods stuck pulling images after a disk expansion, with the platform registry's MinIO unable to form a cluster: Cause 4.
- A node that is `NotReady` after it is back is not a maintenance-plan question; see "Diagnosing a node that reports NotReady on Alauda Container Platform".
