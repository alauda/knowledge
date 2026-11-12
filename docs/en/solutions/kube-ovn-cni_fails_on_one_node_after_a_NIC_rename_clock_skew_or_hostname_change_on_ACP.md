---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# kube-ovn-cni fails on one node after a NIC rename, clock skew or hostname change on ACP

Related articles: [Pods fail on one Kube-OVN node after Docker or a second runtime is installed or old cluster state remains on ACP](Pods_fail_on_one_Kube-OVN_node_after_Docker_or_a_second_runtime_is_installed_or_old_cluster_state_remains_on_ACP.md).

## Issue

`kube-ovn-cni` keeps restarting on one node or a group of nodes, or Pods there cannot be created, and the network plugin itself is not what broke. Typical reports:

- After a master VM was migrated, `kube-ovn-cni` on it does not start. It is in `BackOff`, and the `cni-server` log ends with `"failed to parse config" err="network interface <old-nic> not exist"`.
- After an IaaS upgrade renamed the NICs of every worker (IPs unchanged), many Pods are `Unknown`, `kube-ovn-cni` logs `iface <old-nic> has no valid IP address`, and restarting `ovs-ovn` does not help.
- Adding a node fails with `Check network interface`, or a node whose NIC was renamed never brings OVN up.
- A node that was powered off came back with a wrong clock, and `kube-ovn-cni` and `ovs-ovn` there cannot create Pods.
- A node (for example a GPU node) was removed from the cluster, its hostname was changed, and after it rejoined, the component Pods on it are abnormal.

Each cause below is a property of the host: its interface names, its clock, or its identity in the OVN database.

## Root Cause

### Cause 1: Check network interface, the configured interface name is not on the node

The cluster was created with one interface name, but some machines use another name, so those nodes never finish joining. Separately, renaming a NIC on a node that is already in the cluster leaves OVN unable to start, because restarting `ovs-ovn` does not re-read host NIC configuration. At cluster creation the platform can take a different interface name per node. For a node already in the cluster, check Cause 2 first; re-adding the node after the name is corrected is the fallback.

### Cause 2: failed to parse config or failed to initialize config for the old NIC after a VM migration or IaaS upgrade

`kube-ovn-cni` reads the tunnel interface of a node from the Node annotation `ovn.kubernetes.io/tunnel_interface`. The per-node annotation overrides the DaemonSet `--iface` argument. When the NIC is renamed on the host side (VM migration, IaaS upgrade) and the annotation still holds the old name, `kube-ovn-cni` cannot build its configuration and `cni-server` keeps restarting.

After a VM migration (Kube-OVN `v1.9.25`), the events show `NodeNotReady`, `SandboxChanged`, `Error: services have not yet been read at least once, cannot construct envvars`, repeated restarts of the `cni-server` container and `Back-off restarting failed container`. The `cni-server` log reads:

```text
Find node tunnel interface name: <old-nic>
network interface <old-nic> not exist
failed to find iface <old-nic>, network interface <old-nic> not exist
"failed to parse config" err="network interface <old-nic> not exist"
```

After an IaaS upgrade that renamed the NICs but kept the IPs (Kube-OVN `v1.15.17`), the old name may still exist without the node IP:

```text
iface <old-nic> has no valid IP address
"failed to initialize config" err="iface <old-nic> has no valid IP address"
```

Restarting `ovs-ovn` does not help in either case. Setting the annotation to the current interface name does.

### Cause 3: the node clock is far from the cluster after a power cycle

After a node is shut down and powered on again, its clock can be far from the rest of the cluster. `kube-ovn-cni` and `ovs-ovn` on that node then cannot create Pods, a large set of Pods stays abnormal, and new Pods cannot be created there. A clock hours ahead of the API server also makes the API server reject that node's clients. The platform requires node clocks to stay within 10 seconds of each other.

### Cause 4: the node rejoined with a new hostname and OVN still holds its old chassis

When a node is removed, renamed and joined again (seen on ACP 3.12), the OVN southbound database still holds a chassis record for the old hostname. The component Pods on the node are abnormal until that stale chassis is destroyed. A node that moves between clusters or gets a new management IP can leave the same stale row.

## Resolution

### Cause 1: Check network interface, the configured interface name is not on the node

- For a cluster that has not finished creating, recreate it and set each node's interface to the name shown by `ip -br link` on that machine. Do not keep a single global name that only some nodes have.
- For a node already in the cluster whose interface was renamed, try Cause 2 first. If the `kube-ovn-cni` log shows no Cause 2 signature, or the annotation did not recover the node, remove the node, fix the host interface name (or the per-node interface setting) so it matches what Kube-OVN was given, and add the node again through the platform node workflow.

  > **Warning:** `kubectl drain` evicts workloads and `kubectl delete node` removes the node from scheduling. Pods with local storage stay stranded. Add the node back before leaving the maintenance window. Precondition: no Cause 2 signature, or the Cause 2 annotation did not recover the node. With a Cause 2 signature, do not drain or delete the node; annotate it instead.

  ```bash
  kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
  kubectl delete node <node-name>
  ```

### Cause 2: failed to parse config or failed to initialize config for the old NIC after a VM migration or IaaS upgrade

1. Confirm the signature, and compare the annotation with the interfaces the node really has. `ip link` prints a VLAN interface as `<name>@<parent>` (for example `bond0.1341@bond0`); compare the part before `@` with the annotation.

   ```bash
   kubectl -n kube-system logs <kube-ovn-cni-pod-on-this-node> -c cni-server --tail=100 | grep -E 'tunnel interface|not exist|no valid IP|failed to (parse|initialize) config'
   kubectl get node <node-name> -o jsonpath='{.metadata.annotations.ovn\.kubernetes\.io/tunnel_interface}{"\n"}'
   kubectl -n kube-system get ds kube-ovn-cni -o yaml | grep -- '--iface'
   ip -br addr
   ip route show default
   kubectl get node <node-name> -o yaml > /root/node-<node-name>.before.yaml
   ```

2. Set the annotation to the NIC that now holds the node IP.

   > **Warning:** The annotation decides which NIC Kube-OVN uses for the tunnel on this node; a wrong name leaves the node without a working tunnel. Only when the log names the old NIC (`not exist` or `has no valid IP address`), `ip -br addr` shows the node IP on another NIC, and the NIC changed on the host side. To roll back, restore the annotation from the saved node YAML.

   ```bash
   kubectl annotate node <node-name> --overwrite ovn.kubernetes.io/tunnel_interface=<new-nic>
   kubectl -n kube-system get pod -o wide | grep -E 'kube-ovn-cni|ovs-ovn' | grep <node-name>
   ```

   After a VM migration, `kube-ovn-cni` starts after the annotation update; no Pod deletion, drain or node re-add is needed. Annotate every renamed node.

3. If `kube-ovn-cni` stays in back-off (as after the IaaS upgrade), restart it on that node.

   > **Warning:** Deleting the `kube-ovn-cni` Pod stops sandbox creation on that node until the new Pod is Ready. Only after the annotation names the NIC that holds the node IP. The DaemonSet recreates the Pod; there is nothing to roll back.

   ```bash
   kubectl -n kube-system delete pod -l app=kube-ovn-cni --field-selector spec.nodeName=<node-name>
   ```

### Cause 3: the node clock is far from the cluster after a power cycle

1. Compare the clock with a healthy node, and set it from the same time source the healthy nodes use:

   ```bash
   timedatectl
   chronyc tracking || true
   ```

2. Delete the `kube-ovn-cni` and `ovs-ovn` Pods on that node so the DaemonSets recreate them.

   > **Warning:** Deleting `ovs-ovn` drops forwarding on that node until the new Pod is Ready. Confirm the clock is correct first. Stepping the clock by hours can expire TLS sessions on the node; that is part of the repair, and local clients reconnect. There is no rollback of a deleted Pod; the DaemonSet creates another.

   ```bash
   kubectl -n kube-system delete pod <kube-ovn-cni-pod-on-this-node> <ovs-ovn-pod-on-this-node>
   ```

3. If a TopoLVM volume-prepare Pod in `nativestor-system` is still not `Completed` after the network Pods are Ready, delete that prepare Pod too; it is recreated and reaches `Completed`. Skip this when that namespace has no stuck prepare Pod.

   > **Warning:** Deleting the TopoLVM prepare Pod retries volume-group setup and can disrupt a volume that was mid-prepare.

   ```bash
   kubectl -n nativestor-system delete pod <topolvm-prepare-vg-pod>
   ```

### Cause 4: the node rejoined with a new hostname and OVN still holds its old chassis

Find the chassis whose hostname is the node's old name, destroy only that row, and restart the OVN Pods on the node.

> **Warning:** Destroying a chassis takes effect immediately. Destroying the chassis of a live node cuts that node's Pod traffic until its `ovn-controller` registers again. Match the old hostname exactly and save the list first. There is no undo other than the node registering again.

```bash
kubectl ko sbctl --columns=_uuid,name,hostname list chassis | tee /root/chassis.before
kubectl ko sbctl destroy chassis <uuid-of-chassis-with-old-hostname>
kubectl -n kube-system delete pod <ovs-ovn-pod-on-this-node> <kube-ovn-cni-pod-on-this-node>
kubectl ko sbctl --columns=name,hostname list chassis | grep -A1 <new-hostname>
```

## Diagnostic Steps

Look at the host before touching Kube-OVN objects:

```bash
kubectl get nodes -o wide
kubectl -n kube-system get pod -o wide | grep -E 'kube-ovn-cni|ovs-ovn|kube-ovn-pinger' | grep <node-name>
kubectl -n kube-system describe pod <kube-ovn-cni-pod-on-this-node> | tail -20
kubectl -n kube-system logs <kube-ovn-cni-pod-on-this-node> -c cni-server --tail=100
ip -br link
timedatectl
kubectl ko sbctl --columns=name,hostname list chassis
```

- A node-add check that names an interface the machine does not have is Cause 1.
- `network interface <old-nic> not exist` (`failed to parse config`) or `iface <old-nic> has no valid IP address` (`failed to initialize config`) after a VM migration or IaaS upgrade is Cause 2.
- A clock that differs from healthy nodes by more than a few seconds (often hours) after power-on is Cause 3.
- A rejoined node whose old hostname is still listed in the chassis table is Cause 4.
- If Pods fail on the node with `no packets received from gateway` after Docker or another runtime was installed, or the node used to belong to another cluster, see the related article.
