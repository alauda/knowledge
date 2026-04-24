---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

`ovn-controller` is the per-node daemon that turns the global OVN southbound database into the local OpenFlow rules a node actually programs into Open vSwitch. It runs inside the node-side OVN pod (its name and namespace differ between distributions, but the daemon role is identical). When operators see an `ovn-controller` process consuming *several hundred percent CPU* on a single node, the first instinct is to assume a leak; the reality is usually that multiple threads are doing legitimate work in parallel and the host's `top` output is summing them.

This note explains the thread model of `ovn-controller` so operators can read CPU samples correctly and decide whether what they see is steady-state work, an actual hot loop, or a configuration shape that produces avoidable churn.

## Resolution

### ACP Networking Context

The ACP CNI is **Kube-OVN** (`docs/en/networking/`), which embeds OVN/OVS in the same way the upstream OVN-Kubernetes implementation does. The thread model described below is a property of the OVN project, not of any one distribution — it applies equally to a node running the ACP Kube-OVN agent and to any other OVN-based CNI. For day-to-day diagnosis, the ACP `networking` surface exposes per-node OVN telemetry through the platform observability stack; reach for that first before logging into a node directly.

### The Threads

`ovn-controller` is **multi-threaded** by design. The threads share the same southbound-DB view but specialise on different work types:

| Thread | Role | Hot signal |
|---|---|---|
| **main** | Processes southbound-DB changes; computes and installs OpenFlow flows on the local bridge | CPU correlates with logical-flow churn (Pod create/delete, port bindings, ACL changes) |
| **pinctrl** | Handles packets that have been punted to userspace (PACKET_IN), including ARP/NDP responses and DNS interception | CPU correlates with userspace packet rate, often spikes during connectivity storms |
| **statctrl** | Refreshes FDB (forwarding DB) and MAC-binding entries from the datapath | CPU correlates with churn in the L2 neighbour set; chatty in large flat networks |

A combined `top` view easily exceeds 100 % when even two of these threads are warm; sustained `300 %` is consistent with a node that is simultaneously installing flows, handling punted packets, and refreshing a large MAC-binding table. That is *not* an anomaly on its own.

### When the High CPU Is a Real Symptom

The thread model should be used as a filter for genuine pathology:

- **main thread pinned alone** at high CPU usually means the local node is repeatedly recomputing the same flows — look for a control-plane hot loop creating/deleting Pods, or a churning NetworkPolicy that the node is recompiling.
- **pinctrl thread pinned alone** points at a packet path that should not be in userspace at all — a misconfigured load balancer that is hairpinning, or a broken ACL forcing the slow path.
- **statctrl thread pinned alone** points at MAC-binding churn — a flapping endpoint or a network with too many concurrent ARP/NDP entries.

The point is that the thread *which* is hot is more diagnostic than the absolute CPU figure.

## Diagnostic Steps

Read live per-thread CPU on a target node — `top -H` lists threads, not just processes:

```bash
NODE=<node>
kubectl debug node/$NODE -it -- chroot /host \
  top -H -b -n 1 -p $(pgrep -d, -x ovn-controller) | head -n 40
```

The `COMMAND` column reveals which of the three threads (main / pinctrl / statctrl) holds the CPU.

Sample `ovn-controller`'s own profiling counters via the local `unixctl`:

```bash
NODE=<node>
kubectl debug node/$NODE -it -- chroot /host \
  ovn-appctl -t ovn-controller coverage/show
```

`coverage/show` exposes counters such as `flow_install`, `pinctrl_run`, and `lflow_run` — increments per second translate directly to the workload each thread is doing. A low `lflow_run` rate combined with high main-thread CPU is the signature of repeated no-op recomputation.

Inspect southbound-DB churn from the node:

```bash
kubectl debug node/$NODE -it -- chroot /host \
  ovn-sbctl --columns=_uuid,name,external_ids list Port_Binding | wc -l
```

A port-binding count that grows continuously without a matching workload increase usually points to a controller leak in the cluster (Pods not being garbage-collected from the SB database) — surface that to the network operator team rather than treating it as a node-local issue.

For deeper traces, redirect `ovn-controller` to verbose logging *briefly* and capture a 30-second window:

```bash
NODE=<node>
kubectl debug node/$NODE -it -- chroot /host \
  ovn-appctl -t ovn-controller vlog/set ANY:console:dbg
sleep 30
kubectl debug node/$NODE -it -- chroot /host \
  ovn-appctl -t ovn-controller vlog/set ANY:console:info
```

Verbose logs grow fast — keep the window short and do not leave the level at `dbg`.
