---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Shutting down or rebooting ACP nodes for maintenance

## Issue

Typical questions before planned work on nodes:

- "We need to reboot some worker nodes. Can we just reboot the servers?"
- "A server's RAID card or memory failed and must be shut down for replacement. What must the platform side do?"
- "One global (management) server needs a memory replacement. What is the shutdown plan, how do we back up etcd, and what do we check after the restart?"
- "A node of the logging cluster hosts Kafka, ZooKeeper and Elasticsearch and will be shut down for repair. Do the logging components need any preparation?"
- "We will upgrade the kernel, or the OS (for example Kylin SP2 to SP3). What must be done before the reboot?"
- "The IaaS will migrate all VMs for a hardware expansion, with short interruptions on every node. Will the cluster be affected?"
- "After patching we rebooted the nodes; the Pods on each node were evicted and recreated elsewhere, so replicas are now unevenly spread. Does the platform taint the node during a reboot, and can the eviction time be controlled?"
- "All three masters of a test environment restarted at the same time. Nodes look normal; is anything else needed?"

These procedures take nodes down one at a time while the rest of the cluster keeps running. Shutting down every node of the platform at once (a planned power outage of the whole site) is not covered here.

Related articles: *Node capacity, pod limit or data disk after resizing or replacing node hardware on ACP* (capacity that does not update after a resize, `maxPods`, and replacing a data disk), and *Safely resizing CPU and memory on Alauda Container Platform nodes*.

## Root Cause

These are planned operations, not faults. The procedures exist for three reasons:

- **Pods move only if they are evicted first.** If a node is rebooted without preparation, its Pods stay bound to it and are unavailable until it returns. Pods pinned to the node (`nodeSelector`, local volumes) never move and are unavailable while it is down.
- **Control-plane and global nodes hold etcd and platform components.** Losing one member of a 3-node etcd keeps quorum, but the data has to be protected against a second failure during the work.
- **Node failures are handled with taints.** About 40 seconds after a node stops reporting, kube-controller-manager adds the `node.kubernetes.io/not-ready` or `node.kubernetes.io/unreachable` taint with effect `NoExecute`. The platform does not add any taint of its own during a reboot.

### Cause 1: A worker node is rebooted or shut down

The node's business Pods have to be evicted first so they run elsewhere during the work. Without preparation, Pods are deleted when their toleration for the `NoExecute` taint expires (300 seconds by default in upstream Kubernetes, unless the Pod sets its own) and replaced on other nodes; they are not moved back afterwards, which leaves replicas unevenly spread. Replacement Pods that cannot be placed show `FailedScheduling ... node(s) had untolerated taint {node.kubernetes.io/unreachable: }`.

### Cause 2: A control-plane node or a global-cluster node is shut down

etcd runs on the control-plane nodes. With 3 control-plane nodes, one can be down while etcd keeps quorum; an etcd backup protects against a second failure. While a global node is down, platform pages, log and monitoring collection, and components fixed to that node can be affected; business services already running in business clusters are generally not affected.

### Cause 3: A node of the logging cluster (Kafka, ZooKeeper, Elasticsearch) is shut down

The logging components on that node have to be stopped before the node goes down, whether the Elasticsearch instance on it is a data node or a master node.

### Cause 4: Kernel or OS upgrade with reboots

Each node is rebooted, so the worker procedure applies node by node, after an etcd backup. There is no platform-specific OS upgrade procedure; the OS upgrade is carried out by the user, and the target OS version must be one the platform supports.

### Cause 5: IaaS hardware expansion or VM migration

Whether preparation is needed depends on whether the cluster runs business workloads at all. Decide this from what is deployed, not from the cluster's name or type: a new business cluster can still hold only platform base components.

## Resolution

### Cause 1: A worker node is rebooted or shut down

Work on **one node at a time**; start the next node only when the previous one is `Ready` and its Pods are running.

1. Check that the remaining nodes can absorb the node's Pods:

```bash
kubectl describe nodes | grep -A8 'Allocated resources'
kubectl get pdb -A
```

2. Mark the node unschedulable and evict its Pods. In the console this is the node's **Evict Pods** action; from the CLI:

> **Warning:** Eviction restarts every non-DaemonSet Pod of the node on other nodes, and `--delete-emptydir-data` deletes their `emptyDir` data. Single-replica services are briefly unavailable, and Pods pinned to this node stay down until it returns. Precondition: the other nodes have room, and PodDisruptionBudgets allow the eviction. Roll back with `kubectl uncordon <node-name>`; evicted Pods do not move back by themselves.

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data --timeout=10m
```

3. Reboot, or shut down and do the hardware work (RAID controller, memory, VM specification):

```bash
systemctl reboot        # or: shutdown -h now
```

4. When the node is back and `Ready`, re-enable scheduling and check for Pods that are not running:

```bash
kubectl get node <node-name>
kubectl uncordon <node-name>
kubectl get pods -A -o wide | grep -viE 'Running|Completed'
```

Platform components on a worker need no extra handling; they recover by themselves after the restart. Rebooting directly without cordon and eviction is not recommended on clusters that carry business workloads.

**Keeping Pods on a node through a short reboot.** To keep Pods bound to the node for up to 15 minutes while it reboots, so that only their restart count increases, set both tolerations in each workload's Pod template:

```yaml
spec:
  tolerations:
  - key: "node.kubernetes.io/not-ready"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 900
  - key: "node.kubernetes.io/unreachable"
    operator: "Exists"
    effect: "NoExecute"
    tolerationSeconds: 900
```

> **Warning:** Changing the Pod template rolls out new Pods for the workload. A longer toleration also delays replacement when a node really fails: its Pods stay unavailable for up to `tolerationSeconds` before they are recreated elsewhere. Agree the value with the application owner and apply it in a change window. Roll back by removing the tolerations or restoring the previous value.

```bash
kubectl get pod <pod-name> -n <namespace> -o jsonpath='{range .spec.tolerations[*]}{.key}{" "}{.effect}{" "}{.tolerationSeconds}{"\n"}{end}'
```

On clusters whose node configuration is managed by Machine Configuration, a node left cordoned also keeps its machine configuration pool from reporting all machines ready: a node counts as ready only when it is `NodeReady=True` and not unschedulable. For example, a cordoned master with its configuration applied shows `MachineCount = 3`, `UpdatedMachineCount = 3`, `ReadyMachineCount = 2`, with no errors in the controller logs. That is expected; uncordon the node when its maintenance is over:

```bash
kubectl get nodes | grep SchedulingDisabled
kubectl uncordon <node-name>
```

### Cause 2: A control-plane node or a global-cluster node is shut down

1. Confirm that the cluster has 3 control-plane nodes, and shut down only one at a time.
2. Back up etcd first. Use the platform's etcd backup feature if it is configured (see the etcd backup documentation for your ACP version), and take a manual snapshot from the etcd static Pod. Read the certificate paths and data directory from the Pod spec instead of guessing them:

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
kubectl -n kube-system get pod etcd-<node-name> -o yaml | grep -E -- '--(cert-file|key-file|trusted-ca-file|data-dir)='
kubectl -n kube-system exec etcd-<node-name> -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=<trusted-ca-file> --cert=<cert-file> --key=<key-file> \
  snapshot save <data-dir>/snapshot-before-maintenance.db
```

Copy the snapshot file off the node (it is under the data directory on the host) and confirm its size is not zero.

3. Shut the node down normally:

```bash
shutdown -h now
```

4. After the repair and power-on, check that the node is `Ready` and the platform Pods on it are healthy, then handle any component that does not recover. On a node that runs Ceph, also check that Ceph has returned to normal.

```bash
kubectl get nodes
kubectl -n kube-system get pods -o wide | grep <node-name>
kubectl get pods -A -o wide | grep <node-name> | grep -viE 'Running|Completed'
```

### Cause 3: A node of the logging cluster (Kafka, ZooKeeper, Elasticsearch) is shut down

Stop the logging components first, then shut the node down for repair. Cordon and drain are the worker procedure for business workloads, not part of this step. To confirm the Elasticsearch role or cluster health before the shutdown, use read-only checks only. After the repair and power-on, confirm the node is `Ready` and the logging components on it are running again:

```bash
kubectl get node <node-name>
kubectl get pods -A -o wide | grep <node-name> | grep -viE 'Running|Completed'
```

### Cause 4: Kernel or OS upgrade with reboots

Back up etcd first (Cause 2). Then:

**Business can be stopped:**

1. Stop the business containers.
2. Upgrade and reboot the compute nodes one by one, confirming each node is normal before the next.
3. Upgrade the control-plane nodes one by one.
4. Start the business.

**Business cannot be stopped:**

1. For each compute node: cordon it, evict the business Pods (Cause 1), and confirm the business has recovered on other nodes.
2. Upgrade the kernel and reboot. Confirm the node has rejoined normally, then uncordon it.
3. Repeat for the other compute nodes, then upgrade the control-plane nodes one by one.

Schedule an OS version upgrade in a coordinated maintenance window, with the same node-by-node approach.

### Cause 5: IaaS hardware expansion or VM migration

Ask the cluster owner, and list what runs outside the platform's own namespaces (read-only):

```bash
kubectl get ns
kubectl get deploy,sts -A
```

- **No business workloads** (only platform base components): there is no significant risk. The expansion and VM migration can go ahead directly, and the hosts can simply be rebooted. Wait a while after the reboot, then list the Pods that are not running:

```bash
kubectl get po -A | grep -vi run
```

- **Business workloads**: migrate or restart nodes one at a time with the Cause 1 procedure, for example shutting each node down, giving it a new VM specification or moving it to another resource pool, and restarting it, with each node `Ready` before the next.

After any VM migration, check the container runtime on each node; a migration can corrupt the runtime data directory and runtime binaries.

## Diagnostic Steps

Before maintenance:

```bash
kubectl get nodes -o wide
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>
kubectl get pdb -A
kubectl -n kube-system get pods -l component=etcd -o wide
```

Pods with a local PV, or a `nodeSelector` or `nodeName` for this node, will not move; plan their downtime. Fewer than 3 etcd members means no control-plane node can be shut down safely.

After maintenance:

```bash
kubectl get node <node-name>
kubectl get pods -A | grep -vi run
```

After an unplanned restart of all masters at once, the same check is the first step. Periodic job Pods in `cpaas-system` (names such as `<name>-<number>-<suffix>`) in state `0/1 Completed` with 0 restarts are normal; with no remaining alerts, no further action is needed.

If a node gets stuck during `shutdown`, power it on again, check that the system time is right with `date`, and collect the shutdown logs for analysis:

```bash
journalctl --since "<YYYY-MM-DD>" > ~/shutdown-log.log
ls -lh ~/shutdown-log.log
```
