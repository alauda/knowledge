---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A node suddenly drops to `NotReady`, the kubelet stops posting status, and the rest of the cluster can no longer reach it — SSH hangs, and even ICMP to the node address fails:

```text
Node status: NotReady
Reason:     kubelet stopped posting status
```

The node is still powered on and the kubelet process is still running locally; from the node's own perspective, the network stack looks intact. The problem is that external packets never make it in or out.

## Root Cause

A host-level security agent — deployed cluster-wide as a privileged `DaemonSet` with `hostNetwork: true` and its own kernel module — has taken control of the node's primary network interface for traffic inspection. When the agent's user-space controller crashes, deadlocks, or fails to re-authenticate with its management plane, the kernel module can fall into a fail-closed state that drops every ingress and egress packet on that interface.

The failure mode is characteristic:

- The node is not partitioned at the hypervisor or switch level — other VMs on the same host are fine.
- The kubelet itself has not crashed; it simply cannot renew its lease because its heartbeat to the API server is blocked by the same filter that is blocking everything else.
- Captures on upstream switches show traffic arriving at the node interface but no replies leaving.

Any workload that installs a kernel-level packet filter — third-party endpoint protection, host IDS/IPS, custom eBPF network enforcement — can trigger this shape of outage.

## Resolution

The node will not recover on its own; the misbehaving agent has to be stopped at the host level, and the node has to be rebooted to guarantee the kernel module is unloaded cleanly.

1. Cordon the node from a healthy node that still has API access:

   ```bash
   kubectl cordon <node-name>
   ```

2. Gain host-level access. Network-based tools (SSH, `kubectl debug node/`) will not work while the filter is blocking traffic, so physical console access (iDRAC/iLO/IPMI, hypervisor console, or the VM vendor's remote console) is usually required. If the host uses an immutable base image and you cannot unlock the admin account through normal login, the operator documentation for the node OS describes how to reset the core user's password through the bootloader recovery path.

3. On the node console, stop and disable the agent's system service, unload its kernel module, and verify the interface is back under the OS's control:

   ```bash
   systemctl stop <agent>.service
   systemctl disable <agent>.service
   modprobe -r <agent-kmod>
   ip link show <primary-iface>
   ```

4. Remove the workload pod from the node by deleting the DaemonSet (or, if only this one node is affected, tainting the node so the agent's DaemonSet no longer schedules onto it):

   ```bash
   kubectl -n <agent-namespace> delete daemonset <agent-ds>
   # or, to isolate only this node:
   kubectl taint node <node-name> agent-quarantine=true:NoSchedule
   ```

5. Reboot the node to clear any residual state left by the kernel module, then wait for the kubelet to re-register:

   ```bash
   systemctl reboot
   kubectl get node <node-name> -w
   ```

6. Once the node reports `Ready`, uncordon it and resume normal scheduling:

   ```bash
   kubectl uncordon <node-name>
   ```

Before reintroducing the security agent to the fleet, review the failure mode with the agent vendor — a "fail closed" default on a network-filtering kernel module is generally unsafe for cluster nodes, and most vendors expose a `fail-open` or `monitor-only` mode for production use.

## Diagnostic Steps

- Confirm an agent pod is (or was) running on the affected node and note its namespace:

  ```bash
  kubectl describe node <node-name> | grep -Ei '<agent-name>'
  kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>
  ```

- From a neighbour node, arrange a packet capture toward the affected node to confirm the asymmetry (packets arrive but never return):

  ```bash
  tcpdump -ni <uplink> host <affected-node-ip>
  ```

- After console login, compare the live routing table and netfilter/`nftables` rulesets against a healthy node in the same cluster. A healthy node will not show the agent's custom hook chains on the default interface:

  ```bash
  nft list ruleset
  ip route show
  ```

- Cross-check the node's kernel log for messages from the agent's module right before the outage started. A sudden burst of module error messages followed by the kubelet losing API connectivity is the signature:

  ```bash
  journalctl -k -b | grep -i <agent-kmod>
  ```
