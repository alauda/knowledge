---
title: Inspecting kubelet CPU Manager state and cpuset pinnings on ACP nodes
component: configure
scenario: how-to
tags: [kubelet, cpu-manager, cpuset, guaranteed-pod, node]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Inspecting kubelet CPU Manager state and cpuset pinnings on ACP nodes

## Issue

On Alauda Container Platform (lab cluster running Kubernetes `v1.34.5-1` on Ubuntu 22.04.1 nodes with containerd 2.2.1-5), workloads that rely on exclusive CPU pinning — Guaranteed-class Pods requesting whole CPUs while the kubelet runs with the static CPU Manager policy — need a node-side way to inspect which logical CPUs the kubelet has handed to which container, and to confirm that those assignments are preserved across kubelet restarts. The kubelet exposes the CPU Manager policy in its live runtime configuration through the read-only `/configz` endpoint, and persists per-Pod assignments to a small JSON state file on the node's local filesystem; both surfaces are vanilla upstream and ship with the kubelet binary at `/usr/bin/kubelet` on every ACP node [ev:c1][ev:c2].

## Root Cause

The static CPU Manager keeps its allocation table in a single on-disk JSON document under `/var/lib/kubelet/`. When the kubelet starts, it reads that file to recover the previous `defaultCpuSet` and per-container assignments, so already-running Guaranteed Pods continue to be pinned to the same logical CPUs across a kubelet restart. If the state file is missing or unreadable at startup, the static policy has nothing to recover and reconstructs assignments from scratch — which means new pinnings may not match what the running Pods were previously pinned to, even though the Pods themselves were never restarted [ev:c2].

## Resolution

On ACP nodes the kubelet runs as a host systemd unit (`kubelet.service`) and its on-disk state files live next to its config under `/var/lib/kubelet/`. To inspect the current CPU Manager assignments, read the state file directly from a privileged node-shell with the node's host filesystem mounted, or via a hostPath Pod targeted at the node of interest. The file's JSON shape is upstream-generic: a top-level object with `policyName`, `defaultCpuSet`, an optional `entries` map keyed by Pod UID containing `{containerName: cpusetString}` pairs (omitted when the policy is `none`), and a `checksum` integer [ev:c1][ev:c4]:

```bash
cat /var/lib/kubelet/cpu_manager_state
```

```text
{"policyName":"none","defaultCpuSet":"","checksum":1353318690}
```

The same path applies on every ACP worker; the file mode is `0600 root:root` and the kubelet writes it whenever an assignment changes. To preserve CPU Manager assignments across a deliberate kubelet restart, leave the state file in place — the kubelet recovers from it on the next startup and continues to pin the existing Guaranteed Pods to the same logical CPUs they held before the restart [ev:c2].

The companion file `/var/lib/kubelet/memory_manager_state` follows the same persistence pattern for the Memory Manager policy and is read on the same kubelet startup path [ev:c1].

## Diagnostic Steps

Confirm the effective CPU Manager policy from the live kubelet by reading the read-only `/configz` proxy on the node of interest; this round-trips the kubelet's own view of its configuration and is the authoritative source for the policy in force, the reconcile period, and the matching Memory Manager and Topology Manager policies [ev:c1]:

```bash
kubectl get --raw /api/v1/nodes/<node-name>/proxy/configz \
 | python3 -m json.tool \
 | grep -iE 'cpuManager|memoryManager|topology'
```

```text
"cpuManagerPolicy": "none",
"cpuManagerReconcilePeriod": "10s",
"memoryManagerPolicy": "None",
"topologyManagerPolicy": "none",
"topologyManagerScope": "container",
```

On a default ACP install every node returns `cpuManagerPolicy: "none"`, in which case `/var/lib/kubelet/cpu_manager_state` records the same `policyName: "none"`, an empty `defaultCpuSet`, and no `entries` map — exclusive CPU pinning is not in effect and Guaranteed-class Pods share the shared CPU pool with the rest of the node's workloads [ev:c1].

To snapshot the assignments before and after a kubelet restart and compare them, capture the state file twice — once while the kubelet is running with its current assignments, then again after the restart — and diff the `entries` map and the `defaultCpuSet` field. If both snapshots are byte-identical for the `policyName`, `defaultCpuSet`, and `entries` fields, the static policy preserved its allocations across the restart and already-running Guaranteed Pods continue to be pinned to the same logical CPUs [ev:c2][ev:c4]:

```bash
cat /var/lib/kubelet/cpu_manager_state > /tmp/cpu_state.before
systemctl restart kubelet
sleep 5
cat /var/lib/kubelet/cpu_manager_state > /tmp/cpu_state.after
diff /tmp/cpu_state.before /tmp/cpu_state.after
```
