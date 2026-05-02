---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Reading the ovn-controller Thread Model Inside the Node Networking Pod
## Overview

`ovn-controller` is the per-node daemon that turns the global OVN southbound database into the local OpenFlow rules a node actually programs into Open vSwitch. When operators see an `ovn-controller` process consuming *several hundred percent CPU* on a single node, the first instinct is to assume a leak; the reality is usually that multiple threads are doing legitimate work in parallel and a process-level CPU view is summing them.

This note explains the thread model of `ovn-controller` so operators can read CPU samples correctly and decide whether what they see is steady-state work, an actual hot loop, or a configuration shape that produces avoidable churn.

## Resolution

### Where ovn-controller Runs in ACP (Kube-OVN)

ACP uses **Kube-OVN** as its CNI. Unlike host-level OVN deployments, `ovn-controller` does **not** run as a process on the node — it runs inside the per-node networking Pod. The concrete shape on this platform is:

| Component | Value |
|---|---|
| DaemonSet | `kube-ovn-cni` |
| Namespace | `kube-system` |
| Container | `cni-server` |
| Pod label selector | `app=kube-ovn-cni` |

Every diagnostic command in this article runs through `kubectl exec` into that container — `kubectl debug node` + `chroot /host` will not find the process and is rejected by the cluster Pod Security Admission policy on ACP.

Pick the Pod for the node under inspection:

```bash
NODE=<node-name>
POD=$(kubectl -n kube-system get pod -l app=kube-ovn-cni \
        --field-selector=spec.nodeName=$NODE,status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}')
echo $POD
```

### The Threads

`ovn-controller` is **multi-threaded** by design. The threads share the same southbound-DB view but specialise on different work types:

| Thread (top -H name) | Role | Hot signal |
|---|---|---|
| **ovn-controller** (main) | Processes southbound-DB changes; computes and installs OpenFlow flows on the local bridge | CPU correlates with logical-flow churn (Pod create/delete, port bindings, ACL changes) |
| **ovn_pinctrl0** | Handles packets that have been punted to userspace (PACKET_IN), including ARP/NDP responses and DNS interception | CPU correlates with userspace packet rate, often spikes during connectivity storms |
| **ovn_statctrl3** | Refreshes FDB (forwarding DB) and MAC-binding entries from the datapath | CPU correlates with churn in the L2 neighbour set; chatty in large flat networks |

A combined process-CPU view easily exceeds 100 % when even two of these threads are warm; sustained `300 %` is consistent with a node that is simultaneously installing flows, handling punted packets, and refreshing a large MAC-binding table. That is *not* an anomaly on its own.

### When the High CPU Is a Real Symptom

The thread model should be used as a filter for genuine pathology:

- **main thread (`ovn-controller`) pinned alone** at high CPU usually means the local node is repeatedly recomputing the same flows — look for a control-plane hot loop creating/deleting Pods, or a churning NetworkPolicy that the node is recompiling.
- **`ovn_pinctrl0` pinned alone** points at a packet path that should not be in userspace at all — a misconfigured load balancer that is hairpinning, or a broken ACL forcing the slow path.
- **`ovn_statctrl3` pinned alone** points at MAC-binding churn — a flapping endpoint or a network with too many concurrent ARP/NDP entries.

The point is that the thread *which* is hot is more diagnostic than the absolute CPU figure.

## Diagnostic Steps

Read live per-thread CPU. `top -H` lists threads, not just processes; run it inside the `cni-server` container:

```bash
NODE=<node-name>
POD=$(kubectl -n kube-system get pod -l app=kube-ovn-cni \
        --field-selector=spec.nodeName=$NODE,status.phase=Running \
        -o jsonpath='{.items[0].metadata.name}')

PID=$(kubectl -n kube-system exec $POD -c cni-server -- pgrep -x ovn-controller)
kubectl -n kube-system exec $POD -c cni-server -- top -H -b -n 1 -p $PID | head -n 40
```

The `COMMAND` column reveals which thread holds the CPU.

Sample `ovn-controller`'s own profiling counters via the local `unixctl` socket — `ovn-appctl` is shipped inside the same container and talks to the daemon directly:

```bash
kubectl -n kube-system exec $POD -c cni-server -- \
  ovn-appctl -t ovn-controller coverage/show
```

`coverage/show` exposes counters such as `flow_install`, `pinctrl_run`, and `lflow_run` — increments per second translate directly to the workload each thread is doing. A low `lflow_run` rate combined with high main-thread CPU is the signature of repeated no-op recomputation.

Inspect southbound-DB churn. The SB database is hosted by the **`ovn-central`** Deployment (3 replicas under `kube-system`); query it from any of those Pods. The `kube-ovn-cni` pod *can* see the SB socket only on nodes that happen to also host an ovn-central replica (shared `hostPath`), so do not rely on it from arbitrary worker nodes.

```bash
CENTRAL=$(kubectl -n kube-system get pod -l app=ovn-central \
            -o jsonpath='{.items[0].metadata.name}')

kubectl -n kube-system exec $CENTRAL -- \
  ovn-sbctl --no-leader-only \
    --columns=_uuid,logical_port,external_ids list Port_Binding | wc -l
```

`--no-leader-only` is required because ovn-central runs as a 3-replica Raft cluster — without it `ovn-sbctl` may refuse to query a follower. In the OVN southbound schema the `Port_Binding` table uses `logical_port`, not `name`.

A port-binding count that grows continuously without a matching workload increase usually points to a controller leak in the cluster (Pods not being garbage-collected from the SB database) — surface that to the network operator team rather than treating it as a node-local issue.

For deeper traces, redirect `ovn-controller` to verbose logging *briefly* and capture a 30-second window:

```bash
kubectl -n kube-system exec $POD -c cni-server -- \
  ovn-appctl -t ovn-controller vlog/set ANY:console:dbg
sleep 30
kubectl -n kube-system exec $POD -c cni-server -- \
  ovn-appctl -t ovn-controller vlog/set ANY:console:info
```

Verbose logs grow fast — keep the window short and do not leave the level at `dbg`.
