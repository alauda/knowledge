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

# Node maintenance on ACP: OS reinstall or replacement, hostname, IP, NIC, and cluster name changes

## Issue

Planned changes to the identity of nodes that are already in a cluster raise the same questions repeatedly:

- A machine's OS was reinstalled. How does it rejoin the cluster?
- Compute nodes must move from CentOS to Kylin, keeping their IPs, and TopoLVM is in use.
- Node hostnames are inconsistent. Can the hostnames be changed? Can the node names be changed?
- The node IPs must change. Is a redeploy needed, and how do removed nodes come back? Can the VIP and node IPs of a whole `global` and workload cluster be changed?
- VMs move to another virtualization platform and the NIC name changes (for example from `ens192` to `ens3`).
- Can the cluster be renamed?

Related articles: "Node maintenance on ACP: resizing nodes and masters, host shutdown, and disk expansion" covers resource changes.

## Root Cause

### Cause 1: A reinstalled machine is a new host to the cluster

After an OS reinstall the host has none of the files the cluster gave it, while the cluster may still hold its node object and network or storage state. Remove the node from the cluster, run the node cleanup script on the host before it rejoins, then add the node again.

### Cause 2: Replacing the OS of compute nodes that keep their IPs

Changing compute nodes from CentOS to Kylin Linux Advanced Server V10 (for example on ACP 4.2.1) means taking each node out of the cluster, reinstalling it, and rejoining it with the same IP. The target OS and kernel must be in the verified list of the platform version. Nodes that host log or monitoring storage, middleware, DevOps components, or TopoLVM volumes need their data moved first.

### Cause 3: The node name is fixed at join; hostnames of IP-named nodes can change

A joined node does not support changing its Node name; the name is fixed when the node joins.

- Nodes named by hostname: changing the hostname afterwards can make node identity, certificates, kubelet registration, and the platform display disagree. Keep the hostnames unchanged.
- Nodes named by IP: the hostnames can be changed.

### Cause 4: Node IPs cannot be changed in place

- A worker's IP is changed by deleting the node in the UI and adding it again with the new IP. Changing the IPs of all machines at once is not supported (for example on TKE 3.8.1).
- Nodes already removed because their IPs changed cannot be re-added through a backend method. Run `cleanup.sh` and `init.sh` on the node and add it again under Platform Management > Cluster. The cleanup script deletes the cluster data on that node.
- A workload cluster whose IPs must all change and that runs no business workloads yet is deleted and recreated with the new IPs, rather than changed node by node.
- There is no procedure for changing both the cluster VIP and the node IPs of a running `global` cluster and its workload clusters with workloads and Harbor on them. That is an architecture and network re-planning project that needs a separate evaluation with Alauda.

### Cause 5: VMs moved to another virtualization platform get a new NIC name

Moving nodes to another virtualization platform requires shutting the VMs down. When IPs, disks, and paths stay the same, the only platform-side impact is the NIC name. On Calico, `IP_AUTODETECTION_METHOD` of the `calico-node` DaemonSet matches interface names (for example `interface=^eth0$`) and must also match the new name. On Kube-OVN, the tunnel interface setting of the node is the equivalent; when a migrated master's NIC name changes, `ovn-cni` can fail to start until the node annotation is updated to the new interface name.

### Cause 6: The cluster name cannot be modified

Renaming a cluster after it is deployed is not supported. The only option is to redeploy the cluster with the new name. Only the display name can be edited.

## Resolution

### Cause 1: A reinstalled machine is a new host to the cluster

Remove the node from the cluster through the platform, run the cleanup script for your platform version on the host, prepare the host as for a new node, and add it again. The same sequence applies to nodes that must be repartitioned (for example to give `/var/lib/containerd` and `/cpaas` their own partitions) while they run no workloads: delete the node, run the cleanup script, partition, run the initialization script, add it again.

```bash
kubectl get node <node-name>
kubectl get machine -A | grep <node-ip>
```

### Cause 2: Replacing the OS of compute nodes that keep their IPs

1. Confirm the target OS and kernel against the verified list of your version (`cat /etc/os-release` and `uname -r` on a host already running it).
2. List what runs on the nodes: log and monitoring storage, middleware, DevOps components, TopoLVM volumes.
3. If spare capacity allows, add the new nodes first. Then cordon and drain the nodes being replaced and wait until their Pods run on other nodes.
4. For TopoLVM, back up or migrate TopoLVM-backed services, then take the node out of TopoLVM following the product documentation for removing a TopoLVM storage node (see also "Preserving TopoLVM Data of KubeVirt VMs When Reinstalling Node Operating Systems on ACP").
5. Remove the node from the cluster, reinstall the OS, prepare the host, and add it again with the same IP.

> **Warning:** `kubectl drain` evicts every Pod on the node that is not a DaemonSet Pod; single-replica workloads are unavailable until they start elsewhere. Data on local TopoLVM volumes of that node is lost with the reinstall unless it was backed up or migrated first. Confirm the data is backed up or not needed before step 5. Rollback of a drain is `kubectl uncordon <node-name>`; a reinstall cannot be rolled back.

```bash
kubectl cordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name>
kubectl -n nativestor-system get topolvmcluster topolvm -o yaml
```

### Cause 3: The node name is fixed at join; hostnames of IP-named nodes can change

Check how the nodes are named (Platform Management > Cluster Management > Nodes, or compare `NAME` with `INTERNAL-IP` below) and compare with the current OS hostname:

```bash
kubectl get nodes -o wide
hostname; hostnamectl
```

- Named by hostname: keep the hostname each node had when it joined; there is no rename procedure.
- Named by IP: change the hostnames as required, then confirm every node is still `Ready`.

### Cause 4: Node IPs cannot be changed in place

For one worker or compute node, delete it in the UI, then on the host:

> **Warning:** `cleanup.sh` removes the cluster data on that node (container data, kubelet and Kubernetes files). Confirm that nothing that must be kept lives in those paths before running it; it cannot be undone.

```bash
sudo bash cleanup.sh
sudo bash init.sh
ip -br addr
```

Then add the node with its new IP under Platform Management > Cluster. If the add reports that a NIC cannot be found (for example `检查网卡：找不到网卡: <nic>`, "check NIC: NIC not found"), enter the interface that now carries the node IP. An expired license must be renewed before nodes can be added. For a whole cluster with no workloads, delete it and create it again with the new addresses.

### Cause 5: VMs moved to another virtualization platform get a new NIC name

Move one node at a time: cordon and drain it, shut it down, move it, start it, uncordon it, and only then take the next. Before the first node with the new name starts, let Calico match both names.

> **Warning:** A wrong `IP_AUTODETECTION_METHOD` makes `calico-node` pick no address or the wrong one when the DaemonSet rolls, which breaks Pod traffic on every node. Save the current value; rollback is setting it back.

```bash
kubectl get ds -A | grep calico-node
kubectl -n <calico-namespace> get ds calico-node -o yaml | grep -A2 IP_AUTODETECTION_METHOD
kubectl -n <calico-namespace> set env ds/calico-node IP_AUTODETECTION_METHOD='interface=^(ens192|ens3)$'
```

The regular expression must keep every interface name that nodes use today and add the new one. Use the namespace that `kubectl get ds -A` prints (commonly `kube-system`).

As an alternative to moving the `global` workers, they can be replaced: add new workers; cordon the old ones; uninstall the log collection components (`nevermore`) on `global` and the business clusters and the `global` Elasticsearch log storage plugin; evict the Pods to the new workers and check `kubectl get pod -A | grep -v Running`; reinstall the Elasticsearch log storage plugin pinned to the new nodes; reinstall log collection with `global` as the storage cluster.

### Cause 6: The cluster name cannot be modified

Plan the name before creation. To use another name, create the cluster again with that name. For an imported cluster, re-importing it is the alternative to assess.

```bash
kubectl get cls
```

## Diagnostic Steps

```bash
kubectl get nodes -o wide
kubectl get machine -A
cat /etc/os-release; uname -r
ip -br addr
```

- A host whose OS was reinstalled while its node object still exists: Cause 1.
- An OS change on nodes that keep their IPs, especially with TopoLVM volumes: Cause 2.
- `NAME` equal to the hostname versus equal to `INTERNAL-IP` decides whether hostnames may change: Cause 3.
- Any node IP change: Cause 4.
- A NIC name that changed after a VM migration, with `calico-node` or `ovn-cni` failing on that node: Cause 5.
- A request to rename a cluster: Cause 6.
