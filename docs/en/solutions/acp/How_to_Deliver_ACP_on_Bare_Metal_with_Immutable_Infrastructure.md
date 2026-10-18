---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# How to Deliver ACP on Bare Metal with Immutable Infrastructure

## Purpose

This article is the Bare Metal part of the standard delivery of Alauda Container Platform (ACP) 4.4 on
Immutable Infrastructure (Alauda OS nodes). It covers both kinds of cluster that run on physical
servers: the `global` cluster — a primary and a standby for disaster recovery (DR), including the
preparation that turns `global` into the management cluster for Bare Metal workload clusters — and
the workload clusters. Every step comes with the manifest or command to run and the check that
proves it worked.

Read [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md)
first. It owns the provider-neutral parts that this article links to instead of repeating: the
[reference design](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#reference-design),
the [parameter files, `render`, `load_env` and `apply_rendered`](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files),
the [delivery flow](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#delivery-flow),
the [platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins),
[machine configuration](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines),
[sizing](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters) and
[acceptance](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#accept-the-delivery).
Its conventions apply here too: every command block names the cluster it runs against, and manifests
are files `<cluster-dir>/<NN>-<name>.yaml` numbered in apply order below `50`.

Scope:

- **ACP 4.4** with the **Alauda Container Platform Bare Metal Infrastructure Provider v1.0.0** (the
  first release of the provider, compatible with ACP 4.4, `linux/amd64` only), the Kubeadm Provider
  delivered with the same release, and the Bare Metal Alauda OS archive published for the same ACP 4.4
  patch release.
- **YAML only.** The Bare Metal provider has no web console workflow for creating clusters; every
  cluster step in this article is `kubectl`.
- **Physical servers** (or lab virtual machines) that boot an ISO through BMC virtual media. Nodes
  that run a traditional operating system are out of scope; use the
  [standard installation path](https://docs.alauda.io/container_platform/4.4/install/index.html) for
  those.
- **Worker pools for applications are out of scope** — they follow the customer's machines. This
  article creates the control planes and the platform `infra` pools, and shows one generic
  [worker pool](#worker-pools) to start from; add the customer's pools before handover.

Validation status: the manifests in this article are assembled from the ACP 4.4 product documentation
and the provider version named above. Validate them in a staging environment before a production
delivery.

## Resolution

### Bare-Metal-specific design

#### Hosts are registered and reprovisioned, not created

Bare Metal has no IaaS API that creates a machine. A host is installed once from an ISO, registers
itself, and from then on Cluster API borrows it for one Kubernetes node at a time
([Bare Metal Provider](https://docs.alauda.io/immutable-infra/1.0/overview/providers/bare-metal.html#concepts-and-terminology)):

| Object | Written by | Role |
| --- | --- | --- |
| `MachineRegistration` | You, once per cluster | Registration endpoint and first-install settings, baked into the ISO |
| `SeedImage` | You, once per cluster | Builds that ISO from the `baremetal-base-image-iso` image |
| `MachineInventory` | `elemental-operator`, when a host registers | The long-lived identity of one physical host. It survives every reprovision, node deletion and cluster deletion |
| `MachineInventoryPool` | You, one per node pool | The exact inventories a pool may use — nothing outside the list is ever provisioned |
| `BaremetalMachineTemplate` | You, one per node pool | Points a `KubeadmControlPlane` or `MachineDeployment` at its pool |
| `BaremetalMachine` | The provider | Binds one `Machine` to one inventory and drives the host with `reprovision` and `clean` plans |
| `elemental-image-catalog` ConfigMap | You patch it | Maps each Kubernetes version to the `baremetal-base-image` that reprovisions a host. The provider chart creates it **empty** |

What this means for the delivery:

- **Manifests are applied in two passes.** Inventory names are generated at registration
  (`<cluster>-<SMBIOS UUID>`), so the pools can only be written after the hosts have booted the ISO:
  registration first, everything else once the inventories exist.
- **`maxSurge: 0` on every pool.** There is no spare machine to create; a replacement is
  delete-then-add from the same pool.
- **A catalog miss is terminal.** A `BaremetalMachine` that hits `ImageCatalogMiss` stays `Failed`
  even after you add the entry; only deleting its `Machine` recovers it. Fill the catalog before the
  first cluster manifest, not after the first failure.
- **Nothing deletes a host.** Removing a node or a whole cluster returns the inventory to its pool.

#### Control-plane endpoint: `Internal` Self-built VIP (Alive)

Main line: `BaremetalCluster.spec.controlPlaneLoadBalancer.type: Internal`. The provider runs Alive
(keepalived, IPVS and Lease arbitration) on the control-plane nodes and moves the VIP itself, so no
load balancer is needed and the backend list follows node replacement without anyone editing it. Its
requirements fail silently when missed, so confirm each one with the network team
([Network Connectivity](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#network-connectivity)):

- The VIP is an unused IPv4 address **in the same Layer-2 broadcast domain** as the control-plane
  node IPs — VRRP and gratuitous ARP do not cross a router.
- The `vrid` is **unique in that Layer-2 domain**, across every cluster on the segment; a collision
  leaves the VIP unreachable.
- Switches and security policy allow VRRP and gratuitous ARP, and the node image provides IPVS and
  lets Alive set `net.ipv4.conf.all.arp_accept=1` and `net.ipv4.vs.conntrack=1` — checked on every
  control-plane node in [Workload cluster checks](#workload-cluster-checks).
- Three control-plane nodes. The Bare Metal provider does not support a single-node control plane,
  and the same three nodes arbitrate the VIP.

Alternative: `type: External` when the customer insists on its own Layer-4 load balancer for the API.
The load balancer owner then maintains the backend list on every control-plane change — see
[External load balancer for the control-plane endpoint](#external-load-balancer-for-the-control-plane-endpoint).

Either way the endpoint is an IP address, never a domain name: the API server certificate is issued by
the cluster's own CA, so a customer certificate cannot be served on it. The address is written into
certificates and kubeconfigs and does not change after `kubeadm init`.

#### Persistent `/var/cpaas` is a managed data volume of the inventory

Every node has a system disk for Alauda OS and **one data disk for `/var/cpaas`** (platform state;
monitoring writes under it, and the log collector too once the logging stack is installed — see the
common [reference design](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#reference-design)).
On Bare Metal the persistent disk is declared in `MachineInventory.spec.storage`, not in any Cluster
API template ([Manage Data Disks on Bare-Metal Hosts](https://docs.alauda.io/immutable-infra/1.0/how-to/manage-bare-metal-storage.html)):

- **It belongs to the host, not to the node.** Prepare (format a blank disk, or adopt an existing
  filesystem) runs while the inventory is unallocated; a reprovision mounts the volume before kubelet
  starts; deleting the node unmounts it and keeps the filesystem and its data.
- **Declare it before the inventory joins a pool.** The declaration cannot change while the inventory
  is allocated, and an inventory with a declaration is not `Available` until Prepare succeeds.
- **Select the disk by a stable ID** (`wwn:`, `nvme-eui:`, `nvme-nguid:`). `/dev/sdX` names change
  between boots.
- **Keep each pool at exactly its replica count.** Data stays on the host and does not follow a
  replacement `Machine`. With no spare inventory in the pool, the host released by a deleted node is
  the only one the replacement can take, so it comes back on the same host and finds its own
  `/var/cpaas`. Adding a successor host to a pool is a deliberate act — and that node starts with an
  empty `/var/cpaas`.
- **Formatting needs an approval.** `InitializeIfBlank` is authorized per inventory with the
  `storagectl` binary built from the same provider revision; never write the approval by hand.
- **A disk for TopoLVM is not a managed volume.**
  [Local storage: TopoLVM](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#local-storage-topolvm)
  needs one unformatted whole disk on every node that joins the storage cluster, in addition to the
  `/var/cpaas` disk. Managed storage cannot provide it: it makes a whole-device XFS or ext4
  filesystem, or adopts an existing one, and it does not create partitions or manage LVM
  ([Step 2: Define the Managed Volumes](https://docs.alauda.io/immutable-infra/1.0/how-to/manage-bare-metal-storage.html#step-2-define-the-managed-volumes)).
  A disk meant for TopoLVM is therefore left out of `spec.storage` — no device is selected
  automatically, so the provider never touches it — but the provider documentation does not describe
  that as a TopoLVM path. Do not improvise one: put the requirement into the hardware plan (one extra
  unformatted disk per node of the logging pool) and confirm the approach with Alauda support before
  the hosts are ordered.

#### A reprovision wipes the system state

Every node attach runs `cloud-init clean`, `elemental upgrade` and a reboot, after which the initramfs
clears `/var/lib/kubelet`, `/var/lib/containerd`, `/var/lib/etcd` and `/etc/kubernetes`
([host lifecycle plans](https://docs.alauda.io/immutable-infra/1.0/overview/providers/bare-metal.html#clean-reprovision)).
A Kubernetes upgrade replaces every node the same way. Therefore:

- Nothing survives a replacement except the managed volumes. Do not leave delivery artifacts, scripts
  or data anywhere else on a node.
- Control-plane nodes are replaced one at a time (`maxSurge: 0`), so etcd keeps quorum while each
  member is rebuilt from its peers.
- The `COS_STATE` partition must hold two complete systems during an upgrade. Size it to 20 GiB in the
  `SeedImage` at install time; it cannot be resized later without reinstalling the host
  ([Size COS_STATE before the first install](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#size-cos-state)).

#### Network identity is captured at first boot

`elemental-register` records the Live ISO network — addresses, bonds, VLANs, default route and DNS —
as `MachineInventory.spec.observedNetwork`, and the first install and every reprovision replay it
([network identity](https://docs.alauda.io/immutable-infra/1.0/overview/providers/bare-metal.html#observed-network)).
The network you configure in the Live ISO **is** the node's permanent network:

- Give each host its planned production address in the Live ISO — statically with `nmcli`, or with a
  DHCP reservation. A random DHCP lease becomes the node's permanent address.
- Configure bonds and VLANs in the Live ISO the way the node must keep them.
- Check `spec.observedNetwork` against the plan before an inventory enters a pool.

#### Every host has more than one disk

With a system disk and a `/var/cpaas` disk, Elemental may install onto either one when
`install.device` is empty, and `/dev/sda` can name a different disk in the Live ISO than in the
installed system. Every host in this article therefore uses the fail-closed fixed-system-disk
workflow: the ISO targets `/dev/elemental-install-target`, which the operator links to the system
disk's WWN at the console before starting the installation
([Select a Fixed System Disk on Multi-Disk Bare-Metal Hosts](https://docs.alauda.io/immutable-infra/1.0/how-to/configure-fixed-install-disk-bare-metal.html)).
A third disk for TopoLVM makes this gate more important, not less: pin the system disk by WWN and
leave the TopoLVM disk undeclared, so that neither the installer nor managed storage can claim it.

#### What disaster recovery adds on Bare Metal

On top of the increments every provider shares — one encryption configuration, the same etcd server
certificate SANs, the import ConfigMap on both sides — Bare Metal DR needs its own
([Bare Metal DR Model](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#bare-metal-dr-model)):

| Increment | Why |
| --- | --- |
| Same ServiceAccount signing key on both sides | The workload `baremetal-system-agent` token issued by the primary must be accepted by the standby API server after a failover |
| Split system-agent identity: `splitAuthEnabled: true`; `sharedAuthReadOnly: false` on the active side, `true` on the standby | `global` hosts use a cluster-local identity; workload hosts use a shared identity that is synchronized from primary to standby |
| `baremetal.cluster.io/system-agent-auth-scope: global` on the bootstrap `MachineRegistration` | Marks the `global` hosts for the handoff |
| `handoffHook.directAPIServer: true` | After handoff, `global` hosts report to their local VIP on `6443`, not to the bootstrap node |
| `baremetal-dr-rules` ConfigMap on both sides **before** `etcd-sync` | Keeps each side's `global` plan Secrets out of synchronization. Without it, the first sync gives the standby hosts the primary's plans |
| Same trusted `thirdParty` platform certificate on both sides | Hosts and the standby reach the platform through the one domain |
| Same Registry address `<PLATFORM_HOST>:11443` on both sides | Synchronization then replicates the Registry keys as a no-op instead of overwriting the standby |

In the main line all of these are already in the manifests and the cluster files below;
[Single cluster](#single-cluster) lists what to remove when there is no DR.

### Parameters

Use the parameter files and the helpers from
[Prepare the parameter files](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files).
Bare Metal adds entries to `site.env` and to every cluster file, and one small file per host, because
the data disk of every host has its own ID. In every shell — on the bootstrap nodes as well as on the
delivery host — define the common helpers first, then run the commands in the delivery directory after
`load_env <cluster>.env`. Commands marked `# on the bootstrap cluster` run on that side's bootstrap
node with `BOOTSTRAP_KUBECONFIG`, the kubeconfig that Step 2 of the product procedure copies to
`/root/.kube/config`.

Common variables with a Bare Metal constraint:

- `PLATFORM_HOST` is a domain name in the DR topology; only this domain switches during DR.
- `REGISTRY_DOMAIN` must be `<PLATFORM_HOST>:11443` on Bare Metal — the same value on both `global`
  sides.
- `CLUSTER_NAME` is `global` in both `global` cluster files. The `global` manifests write the `global`
  names literally, so a wrong value cannot break the naming rule.
- `K8S_VERSION` is the Kubernetes version of the Bare Metal OS archive with its leading `v` (for ACP
  4.4.1, `v1.35.6-acp.9` per the
  [OS Support Matrix](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html)); it
  becomes the `elemental-image-catalog` key.
- `CONTROL_PLANE_VIP` sits in the Layer-2 domain of that cluster's control-plane nodes.

`site.env` — Bare Metal entries:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `LOCAL_REGISTRY_ADDRESS` | Bootstrap Registry as seen from the bootstrap node (pushing) | `127.0.0.1:11443` | Fixed product value |
| `BOOTSTRAP_REGISTRY_ADDRESS` | Bootstrap Registry as seen from inside the bootstrap cluster (AppRelease `repoURL`, bootstrap `SeedImage`) | `172.18.0.1:11443` | Fixed product value |
| `INGRESS_CLASS_NAME` | Ingress class of the platform's built-in bootstrap ingress, referenced by the provider AppReleases | `global-alb2` | Fixed product value; not an application-ingress choice |
| `KUBEADM_PROVIDER_PACK` | Kubeadm Provider package on the bootstrap node | `/root/pkgs/cluster-api-provider-kubeadm.amd64.vX.Y.Z.tgz` | Customer Portal |
| `BAREMETAL_PROVIDER_PACK` | Bare Metal Infrastructure Provider package on the bootstrap node | `/root/pkgs/cluster-api-provider-baremetal.amd64.vX.Y.Z.tgz` | Customer Portal |
| `KUBEADM_PROVIDER_VERSION` | Chart version of the Kubeadm Provider | `vX.Y.Z` | Tag list of `ait/chart-cluster-api-provider-kubeadm` after the push in [Prepare the bootstrap cluster](#prepare-the-bootstrap-cluster) |
| `BAREMETAL_PROVIDER_VERSION` | Chart version of the Bare Metal provider | `vX.Y.Z` | Tag list of `ait/chart-cluster-api-provider-baremetal` after the same push |
| `OS_IMAGE_ARCHIVE` | Bare Metal Alauda OS archive (one OCI layout holding two images) | `/root/pkgs/baremetal-os.tar` | Customer Portal OS download page, Bare Metal entry |
| `OS_IMAGE_TAG` | Tag shared by `baremetal-base-image` and `baremetal-base-image-iso` | `vX.Y.Z` | `ctr -n bare-metal-os images ls -q` after the import |
| `DNS_IMAGE_TAG` | CoreDNS image tag preloaded in the OS image | `1.14.7-v4.4.7` | `coredns` column of the OS Support Matrix row of your ACP release |
| `ETCD_IMAGE_TAG` | etcd image tag preloaded in the OS image | `v3.6.13-acp.2` | `etcd` column of the same row |
| `KUBE_OVN_VERSION` | Kube-OVN **chart** version pinned on each `Cluster` | `v4.4.12` | `kube-ovn (chart)` column of the same row — not the Kube-OVN component version |
| `PRIMARY_CLUSTER_VIP` | Control-plane VIP of the primary `global` (DR) | `192.0.2.10` | Network plan; equals `CONTROL_PLANE_VIP` of `global-primary.env` |
| `STANDBY_CLUSTER_VIP` | Control-plane VIP of the standby `global` (DR) | `203.0.113.10` | Network plan; equals `CONTROL_PLANE_VIP` of `global-standby.env` |
| `ENCRYPTION_PROVIDER_CONF` | Path of the shared encryption configuration on both bootstrap nodes (DR) | `/root/global-dr/encryption-provider.conf` | Created in [Generate the shared DR material](#generate-the-shared-dr-material) |
| `BM_STORAGECTL` | Path of the `storagectl` binary | `/root/pkgs/storagectl` | See [Download the materials](#download-the-materials) |

Cluster files — the same names in every file:

| Variable | Meaning | Example (`global-primary` / `global-standby` / `wl-prod`) | Where to get it |
| --- | --- | --- | --- |
| `BOOTSTRAP_KUBECONFIG` | Kubeconfig of this side's bootstrap cluster, on its bootstrap node (`global` files only) | `/root/.kube/config` / `/root/.kube/config` / — | Copied from `/var/cpaas/data/alauda.kubeconfig` in [Prepare the bootstrap cluster](#prepare-the-bootstrap-cluster) |
| `HOST_IP` | Static IP of this side's bootstrap node (`global` files only) | `192.0.2.5` / `203.0.113.5` / — | Bootstrap node |
| `NODE_REGISTRY_ADDRESS` | `<HOST_IP>:11443`, the Registry the `global` hosts pull from during installation (`global` files only) | `192.0.2.5:11443` / `203.0.113.5:11443` / — | Derived from `HOST_IP` |
| `BM_CONTROL_PLANE_VRID` | Keepalived `virtual_router_id` of this cluster's VIP | `51` / `52` / `61` | Unique in the control-plane Layer-2 domain |
| `BM_DIRECT_API_SERVER` | Hand the `global` hosts off to the local VIP (`global` files only) | `true` / `true` / — | `true` for DR, `false` for a single cluster |
| `BM_SPLIT_AUTH_ENABLED` | Split `global` and workload system-agent identities (`global` files only) | `true` / `true` / — | `true` for DR, `false` for a single cluster |
| `BM_SHARED_AUTH_READ_ONLY` | Shared workload identity is read-only on this side (`global` files only) | `false` / `true` / — | `false` on the active side, `true` on the standby; `false` for a single cluster |
| `BM_CP_INVENTORY_1` | `MachineInventory` of control-plane host 1 | `global-00000000-0000-0000-0000-000000000001` | Registration, see [Record the inventories](#record-the-inventories) |
| `BM_CP_INVENTORY_2` | `MachineInventory` of control-plane host 2 | `global-00000000-0000-0000-0000-000000000002` | Registration |
| `BM_CP_INVENTORY_3` | `MachineInventory` of control-plane host 3 | `global-00000000-0000-0000-0000-000000000003` | Registration |
| `BM_CP_HOSTNAME_1` | Node hostname of control-plane host 1 | `primary-global-cp-1` / `standby-global-cp-1` / `wl-prod-cp-1` | Naming plan; the side prefix tells the DR pair apart at a glance |
| `BM_CP_HOSTNAME_2` | Node hostname of control-plane host 2 | `primary-global-cp-2` | Naming plan |
| `BM_CP_HOSTNAME_3` | Node hostname of control-plane host 3 | `primary-global-cp-3` | Naming plan |
| `BM_INFRA_INVENTORY_1` | `MachineInventory` of `infra` host 1 | `global-00000000-0000-0000-0000-000000000004` | Registration |
| `BM_INFRA_INVENTORY_2` | `MachineInventory` of `infra` host 2 | `global-00000000-0000-0000-0000-000000000005` | Registration |
| `BM_INFRA_INVENTORY_3` | `MachineInventory` of `infra` host 3 | `global-00000000-0000-0000-0000-000000000006` | Registration |
| `BM_INFRA_HOSTNAME_1` | Node hostname of `infra` host 1 | `primary-global-infra-1` | Naming plan |
| `BM_INFRA_HOSTNAME_2` | Node hostname of `infra` host 2 | `primary-global-infra-2` | Naming plan |
| `BM_INFRA_HOSTNAME_3` | Node hostname of `infra` host 3 | `primary-global-infra-3` | Naming plan |
| `BM_INGRESS_INVENTORY_1` | [Dedicated pools](#dedicated-pools) only: `MachineInventory` of `ingress` host 1; `_2`, `_3` and the `MONITOR` / `LOG` equivalents follow the same pattern | — / — / `wl-prod-00000000-0000-0000-0000-000000000021` | Registration |
| `BM_WORKER_INVENTORY_1` | [Worker pools](#worker-pools) only: `MachineInventory` of worker host 1; `_2` and `_3` follow the same pattern | — / — / `wl-prod-00000000-0000-0000-0000-000000000031` | Registration |
| `BM_WORKER_HOSTNAME_1` | [Worker pools](#worker-pools) only: node hostname of worker host 1, same pattern | — / — / `wl-prod-worker-1` | Naming plan |
| `BM_INGRESS_HOSTNAME_1` | [Dedicated pools](#dedicated-pools) only: node hostname of `ingress` host 1, same pattern | — / — / `wl-prod-ingress-1` | Naming plan |

Host files — one per host, `hosts/<cluster>/<role>-<n>.env`:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `BM_INVENTORY` | `MachineInventory` of this host | `global-00000000-0000-0000-0000-000000000001` | Registration |
| `BM_DATA_DISK_ID` | Stable ID of the `/var/cpaas` data disk | `wwn:0x5000000000000001` | `status.observedStorage` of the inventory, see [Prepare /var/cpaas on every inventory](#prepare-varcpaas-on-every-inventory) |
| `BM_DATA_DISK_MIN_SIZE` | Smallest size the disk must have; Prepare refuses a smaller device | `200Gi` | [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters) |

Session variables — set by the commands of this article, never stored in a file:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `INSTALLER_IP` | Pod IP of the installer in the bootstrap cluster | (set at run time) | `kubectl get pods -n cpaas-system -l service_name=cpaas-installer` |
| `ENCRYPTION_PROVIDER_SECRET_B64` | The shared etcd encryption key (DR) | (never stored) | Generated once in [Generate the shared DR material](#generate-the-shared-dr-material); never written to a file other than `ENCRYPTION_PROVIDER_CONF` |
| `GLOBAL_REGISTRY_ADDRESS` | Registry address recorded in `ProductBase` | `acp.example.com:11443` | Read from `ProductBase` |
| `GLOBAL_REGISTRY_PASSWORD` | `admin` password of that Registry | (never stored) | Read from `cpaas-system/registry-admin`; held in the shell only |
| `BM_NS` | Namespace of every Bare Metal object | `cpaas-system` | Fixed |
| `BM_STORAGE_FILE` | Rendered storage declaration of one host | `/tmp/baremetal-storage.yaml` | Working file |
| `BM_INVENTORY_FILE` | Live copy of one inventory | `/tmp/baremetal-machineinventory.json` | Working file |
| `BM_PATCH_FILE` | Patch generated by `storagectl` | `/tmp/baremetal-storage.patch.json` | Working file |
| `PRIMARY_GLOBAL_KUBECONFIG` | Kubeconfig of the primary `global` (DR checks) | `/root/.kube/acp/global-primary.kubeconfig` | `GLOBAL_KUBECONFIG` of `global-primary.env` |
| `STANDBY_GLOBAL_KUBECONFIG` | Kubeconfig of the standby `global` (DR checks) | `/root/.kube/acp/global-standby.kubeconfig` | `GLOBAL_KUBECONFIG` of `global-standby.env` |
| `PRIMARY_BOOTSTRAP_KUBECONFIG` | Copy, on the delivery host, of the primary `BOOTSTRAP_KUBECONFIG` (DR checks) | `/root/.kube/acp/bootstrap-primary.kubeconfig` | `/root/.kube/config` of the primary bootstrap node |
| `STANDBY_BOOTSTRAP_KUBECONFIG` | Copy, on the delivery host, of the standby `BOOTSTRAP_KUBECONFIG` (DR checks) | `/root/.kube/acp/bootstrap-standby.kubeconfig` | The same file on the standby bootstrap node |
| `PRIMARY_GLOBAL_HOSTS` | Management addresses of the six primary `global` hosts | `"192.0.2.21 ... 192.0.2.26"` | Network plan |
| `STANDBY_GLOBAL_HOSTS` | Management addresses of the six standby `global` hosts | `"203.0.113.21 ... 203.0.113.26"` | Network plan |
| `PRIMARY_GLOBAL_REGISTRATION_NAME` | Bootstrap `MachineRegistration` of the primary | `global-registration` | `10-registration.yaml` |
| `STANDBY_GLOBAL_REGISTRATION_NAME` | Bootstrap `MachineRegistration` of the standby | `global-registration` | `10-registration.yaml` |

Example entries. The addresses are documentation addresses; replace every value.

```bash
# site.env — Bare Metal entries, appended to the common entries
LOCAL_REGISTRY_ADDRESS='127.0.0.1:11443'
BOOTSTRAP_REGISTRY_ADDRESS='172.18.0.1:11443'
INGRESS_CLASS_NAME='global-alb2'
KUBEADM_PROVIDER_PACK='/root/pkgs/cluster-api-provider-kubeadm.amd64.vX.Y.Z.tgz'
BAREMETAL_PROVIDER_PACK='/root/pkgs/cluster-api-provider-baremetal.amd64.vX.Y.Z.tgz'
KUBEADM_PROVIDER_VERSION='vX.Y.Z'
BAREMETAL_PROVIDER_VERSION='vX.Y.Z'
OS_IMAGE_ARCHIVE='/root/pkgs/baremetal-os.tar'
OS_IMAGE_TAG='vX.Y.Z'
DNS_IMAGE_TAG='1.14.7-v4.4.7'
ETCD_IMAGE_TAG='v3.6.13-acp.2'
KUBE_OVN_VERSION='v4.4.12'
PRIMARY_CLUSTER_VIP='192.0.2.10'
STANDBY_CLUSTER_VIP='203.0.113.10'
ENCRYPTION_PROVIDER_CONF='/root/global-dr/encryption-provider.conf'
BM_STORAGECTL='/root/pkgs/storagectl'
```

```bash
# global-primary.env — Bare Metal entries, appended to the common entries
# (CLUSTER_NAME='global', CONTROL_PLANE_VIP='192.0.2.10', the CIDRs and both kubeconfigs are common entries)
BOOTSTRAP_KUBECONFIG='/root/.kube/config'
HOST_IP='192.0.2.5'
NODE_REGISTRY_ADDRESS='192.0.2.5:11443'
BM_CONTROL_PLANE_VRID='51'
BM_DIRECT_API_SERVER='true'
BM_SPLIT_AUTH_ENABLED='true'
BM_SHARED_AUTH_READ_ONLY='false'
# filled in after registration
BM_CP_INVENTORY_1='global-00000000-0000-0000-0000-000000000001'
BM_CP_INVENTORY_2='global-00000000-0000-0000-0000-000000000002'
BM_CP_INVENTORY_3='global-00000000-0000-0000-0000-000000000003'
BM_CP_HOSTNAME_1='primary-global-cp-1'
BM_CP_HOSTNAME_2='primary-global-cp-2'
BM_CP_HOSTNAME_3='primary-global-cp-3'
BM_INFRA_INVENTORY_1='global-00000000-0000-0000-0000-000000000004'
BM_INFRA_INVENTORY_2='global-00000000-0000-0000-0000-000000000005'
BM_INFRA_INVENTORY_3='global-00000000-0000-0000-0000-000000000006'
BM_INFRA_HOSTNAME_1='primary-global-infra-1'
BM_INFRA_HOSTNAME_2='primary-global-infra-2'
BM_INFRA_HOSTNAME_3='primary-global-infra-3'
```

`global-standby.env` has the same names with the standby values: `HOST_IP='203.0.113.5'`,
`NODE_REGISTRY_ADDRESS='203.0.113.5:11443'`, its own `vrid`, inventories and hostnames, and
`BM_SHARED_AUTH_READ_ONLY='true'`.

```bash
# wl-prod.env — Bare Metal entries, appended to the common entries; no bootstrap or DR entries
BM_CONTROL_PLANE_VRID='61'
BM_CP_INVENTORY_1='wl-prod-00000000-0000-0000-0000-000000000011'
BM_CP_INVENTORY_2='wl-prod-00000000-0000-0000-0000-000000000012'
BM_CP_INVENTORY_3='wl-prod-00000000-0000-0000-0000-000000000013'
BM_CP_HOSTNAME_1='wl-prod-cp-1'
BM_CP_HOSTNAME_2='wl-prod-cp-2'
BM_CP_HOSTNAME_3='wl-prod-cp-3'
BM_INFRA_INVENTORY_1='wl-prod-00000000-0000-0000-0000-000000000014'
BM_INFRA_INVENTORY_2='wl-prod-00000000-0000-0000-0000-000000000015'
BM_INFRA_INVENTORY_3='wl-prod-00000000-0000-0000-0000-000000000016'
BM_INFRA_HOSTNAME_1='wl-prod-infra-1'
BM_INFRA_HOSTNAME_2='wl-prod-infra-2'
BM_INFRA_HOSTNAME_3='wl-prod-infra-3'
```

```bash
# hosts/global-primary/cp-1.env — one file per host
BM_INVENTORY='global-00000000-0000-0000-0000-000000000001'
BM_DATA_DISK_ID='wwn:0x5000000000000001'
BM_DATA_DISK_MIN_SIZE='200Gi'
```

Intentional `${...}` literals: `${System Information/UUID}` and `${System Information/Serial Number}`
in the two `10-registration.yaml` files are expanded by `elemental-register` from SMBIOS data on each
host. `render` leaves them alone because they are not parameter names, so those two files are applied
with a check that filters them out instead of with `apply_rendered`.

### Prepare Bare Metal

#### Collect the facts

| Scope | Fact | Why it matters |
| --- | --- | --- |
| Per host | Serial number, SMBIOS UUID, BMC address | Maps a registered inventory to its role. BMC credentials stay with the customer and never enter a file |
| Per host | System disk WWN, data disk stable ID and size, any disk that must keep data | Install target, `/var/cpaas` declaration, and what must never be wiped |
| Per host | NICs, bonds, VLANs, planned IP, gateway, DNS | Becomes the permanent network at first boot |
| Per host | Real hardware TPM present (`/dev/tpm0`) or not | Decides `emulate-tpm` |
| Per cluster | Control-plane VIP and `vrid`, Pod / Service / Join CIDRs | Must not overlap each other, the host network or another cluster |
| Site | Platform domain and its DNS record, internal DNS and NTP servers, platform certificate (DR: one trusted certificate for the domain) | Registration, the clock gate, DR |

#### Prepare every host

Do this on every host **before** it boots the ISO; each item is a failure that otherwise surfaces much
later ([Host Disk and Boot Preparation](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#host-disk-and-boot-preparation)):

- **CPU baseline.** The Alauda OS images require `x86-64-v2` on x86_64 hosts. Check the CPU model
  against the vendor specification, or run this in the Live ISO console — no output means the
  baseline is met:

```bash
# in the Live ISO console
for f in cx16 lahf_lm popcnt pni sse4_1 sse4_2 ssse3; do grep -qw "$f" /proc/cpuinfo || echo "missing $f"; done
```

- **Disks.** In the RAID controller, present one system disk and one `/var/cpaas` data disk per host.
  Classify every disk or virtual disk; wipe the system disk and any obsolete boot disk so that no old
  operating system can boot; remove residual `COS_STATE`, `COS_PERSISTENT`, `COS_OEM` and
  `COS_RECOVERY` labels from **all** disks and multipath paths — a stale label on a second disk makes
  Elemental resolve the wrong device. Never wipe a disk that holds data to keep.
- **Boot.** Enable BMC virtual media and boot the virtual CD for the installation. After the
  installation, eject the media and restore disk-first boot.
- **TPM.** A host with a working hardware TPM can register with `emulate-tpm: false`; every host
  without one — virtual machines and TPM-less servers alike — needs `emulate-tpm: true` with
  `emulated-tpm-seed: -1`. The manifests below use emulation; switch a cluster's registration to
  `false` only when every host of that cluster has a hardware TPM. A host without a TPM and without
  emulation never sends its registration request.

#### Pass the clock gate

Every host must carry the correct time **before** it boots the ISO
([Host Time Synchronization](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#host-time-synchronization)).
The whole cluster PKI inherits the clock of the host that runs `kubeadm init`: a host running ahead
issues certificates that every other node treats as not yet valid, and the control plane never comes
up. Nothing on this path checks it for you.

1. Make the site NTP servers reachable from the host subnet (UDP `123`). Do not depend on public NTP.
2. Set the clock in the BIOS/UEFI setup or through the BMC, with the hardware clock on UTC — the disk
   has no operating system yet to run a command in.
3. Compare the hosts with each other, not only with a reference: the spread across all hosts of one
   cluster must stay within 10 seconds before any of them boots the ISO.
4. After the nodes are `Ready`, confirm with `timedatectl` and `chronyc tracking` on each node. The
   NTP `MachineConfig` of [Configure machines](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines)
   keeps the time right afterwards; it cannot fix a host that is still installing.

#### Open the network flows by stage

Bare Metal hosts are installed and joined entirely over the network, so every path must be open
before the first host boots. Approve the flows from the authoritative tables, not from a copy:

| Stage | Flows | Authority |
| --- | --- | --- |
| `global` installation (bootstrap phase) | `global` hosts → bootstrap node `12443` (registration) and `11443` (images); bootstrap node → `global` VIP `6443` | [Bootstrap node network](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-network) |
| Workload hosts: first boot, provisioning, join, steady state | DNS, NTP, platform HTTPS (registration and plan polling), Registry `11443`, the cluster's own endpoint, node-to-node traffic | [Network Connectivity](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#network-connectivity) |
| `global` hosts after handoff (DR) | Each `global` host → its local VIP `6443` | [Endpoint and Identity](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#endpoint-and-identity) |
| `global` ↔ workload management | `global` nodes → every workload endpoint `6443`; in DR from both `global` sides | [Connecting global Cluster and Workload Cluster](https://docs.alauda.io/container_platform/4.4/configure/clusters/on-premises.html#connecting-global-cluster-and-workload-cluster) |
| Between the two `global` sides | `443`, `6443`, `11443`, `2379` (and `80` for HTTP access), in **both** directions | [DR Network Requirements](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#network-requirements) |
| Inside a cluster | Component port inventory | [ACP 4.4 Communication Matrix](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html) |
| Self-built VIP | VRRP and gratuitous ARP inside the control-plane Layer-2 domain | [Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html) |

An approval that covers only `443` produces hosts that register and then fail during install or join,
where the cause is much harder to see. The Alauda OS host firewall is maintained by the platform; the
flows above are for site firewalls, security groups and router ACLs.

#### Provide the bootstrap nodes

Two bootstrap nodes for the DR topology — one per side, never one reused for both — and one for a
single cluster ([Bootstrap Node Requirements](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-requirements)):
4 cores, 8 GB and 300 GB or more on x86_64, a traditional 64-bit Linux with Bash, `root`, `curl`,
`jq` and `openssl`. Give each a **static IP** for the whole installation: `HOST_IP` is written into
the registration endpoint, its certificate SAN and the Registry annotation the hosts pull from, and a
change part-way through breaks node provisioning.

#### Download the materials

Besides the Core Package and the plugin packages of the common article (which include `etcd-sync`
for DR): the Kubeadm Provider package, the Bare Metal Infrastructure Provider package, the Bare Metal
OS archive of the same ACP release
([Downloading Alauda OS](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html#downloading-alauda-os)),
and the `storagectl` binary built from exactly the same revision as the Bare Metal provider package,
because it reuses the provider's validation and approval-hash code. The product documentation does not
name a download location for `storagectl`; request the matching binary from Alauda technical support
together with the provider version, and never use one from another release. Put the two provider
packages into `packages/plugins/` so that the common upload step pushes them to `global` as well. Take
both OS images from the same archive; never pair images from different archives.

#### Generate the shared DR material

DR only. Generate the encryption configuration and the ServiceAccount signing key **once**, on the
primary bootstrap node, before either installation. Both sides must use the same files: a different
encryption key makes synchronized Secrets undecryptable on the standby, and a different signing key
makes every workload host fail authentication after a failover — both show only at the first failover
drill.

```bash
# on the primary bootstrap node
load_env global-primary.env
umask 077
mkdir -p /root/global-dr
ENCRYPTION_PROVIDER_SECRET_B64="$(head -c 32 /dev/urandom | base64)"
cat > "${ENCRYPTION_PROVIDER_CONF}" <<EOF_CONF
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - aescbc:
      keys:
      - name: key1
        secret: ${ENCRYPTION_PROVIDER_SECRET_B64}
EOF_CONF
unset ENCRYPTION_PROVIDER_SECRET_B64

openssl genrsa -out /root/global-dr/sa.key 2048
openssl rsa -in /root/global-dr/sa.key -pubout -out /root/global-dr/sa.pub
chmod 0600 "${ENCRYPTION_PROVIDER_CONF}" /root/global-dr/sa.key
chmod 0644 /root/global-dr/sa.pub
sha256sum "${ENCRYPTION_PROVIDER_CONF}" /root/global-dr/sa.key /root/global-dr/sa.pub
```

Copy `/root/global-dr/` over a secure channel to the standby bootstrap node (for example
`scp -rp /root/global-dr root@<standby-bootstrap-node>:/root/`) and compare the three digests there.
These files are credentials: keep an access-controlled offline copy, keep them out of the delivery
directory and the archive, and never print their content.

#### Prepare the bootstrap cluster

Do this on **each** bootstrap node with its own cluster file — Steps 2 and 3 of
[Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html).

Create the bootstrap cluster:

```bash
# on the bootstrap node
mkdir -p /root/cpaas-install
tar -xvf <core-package> -C /root/cpaas-install
cd /root/cpaas-install/installer
bash setup.sh
mkdir -p "$HOME/.local/bin" ~/.kube

if ! command -v kubectl >/dev/null 2>&1; then
  nerdctl cp minialauda-control-plane:/usr/bin/kubectl \
    "$HOME/.local/bin/kubectl"
  chmod 0755 "$HOME/.local/bin/kubectl"
  export PATH="$HOME/.local/bin:$PATH"
fi

cp /var/cpaas/data/alauda.kubeconfig ~/.kube/config      # = BOOTSTRAP_KUBECONFIG of this side
kubectl get nodes
```

The bootstrap Registry is anonymous by default. If you configured Registry credentials during
`setup.sh`, add `spec.source.chartPullSecret: global-registry-auth` and
`spec.values.global.registry.imagePullSecrets: [global-registry-auth]` to both AppReleases below and
`-u <username>` to the `ctr` pushes (`ctr` then prompts for the password); otherwise add nothing.

Push the provider packages and read their chart versions into `site.env`:

```bash
# on the bootstrap node, in the delivery directory
load_env global-primary.env
/root/cpaas-install/installer/res/amd64/packtool pack push \
  -r "${LOCAL_REGISTRY_ADDRESS}" -c "${BAREMETAL_PROVIDER_PACK}"
/root/cpaas-install/installer/res/amd64/packtool pack push \
  -r "${LOCAL_REGISTRY_ADDRESS}" -c "${KUBEADM_PROVIDER_PACK}"

curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/ait/chart-cluster-api-provider-kubeadm/tags/list"
curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/ait/chart-cluster-api-provider-baremetal/tags/list"
```

Import both OS images and push them to the bootstrap Registry. `/var/lib/containerd` needs free space
of at least the archive size. Keep the images in the `bare-metal-os` namespace: they are pushed again to
the `global` Registry after installation.

```bash
# on the bootstrap node
ctr -n bare-metal-os images import --all-platforms --no-unpack "${OS_IMAGE_ARCHIVE}"
ctr -n bare-metal-os images ls -q     # both images, one tag: set OS_IMAGE_TAG in site.env, then load_env again

for repo in baremetal-base-image baremetal-base-image-iso; do
  ctr -n bare-metal-os images push --plain-http \
    "${LOCAL_REGISTRY_ADDRESS}/tkestack/${repo}:${OS_IMAGE_TAG}" "${repo}:${OS_IMAGE_TAG}"
  curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/tkestack/${repo}/tags/list"
done
```

The bootstrap registration endpoint `https://<HOST_IP>:12443` needs a serving certificate with
`HOST_IP` as an IP SAN before the provider is installed; `elemental-system-agent` verifies it in
`strict` mode. This certificate belongs to the bootstrap phase only — it is never imported into the
final cluster.

`global-primary/01-bootstrap-dex-tls.yaml`:

```yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: baremetal-bootstrap-selfsigned
  namespace: cpaas-system
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: baremetal-bootstrap-ca
  namespace: cpaas-system
spec:
  secretName: baremetal-bootstrap-ca
  commonName: baremetal-bootstrap-ca
  duration: 87600h
  renewBefore: 720h
  isCA: true
  privateKey:
    algorithm: RSA
    size: 2048
  usages:
    - cert sign
    - crl sign
  issuerRef:
    name: baremetal-bootstrap-selfsigned
    kind: Issuer
---
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: baremetal-bootstrap-ca
  namespace: cpaas-system
spec:
  ca:
    secretName: baremetal-bootstrap-ca
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: dex-tls-bootstrap
  namespace: cpaas-system
spec:
  secretName: dex.tls
  commonName: ${HOST_IP}
  duration: 87600h
  renewBefore: 720h
  privateKey:
    algorithm: RSA
    size: 2048
  usages:
    - digital signature
    - key encipherment
    - server auth
  ipAddresses:
    - "${HOST_IP}"
    - "127.0.0.1"
  dnsNames:
    - global-alb2
    - global-alb2.cpaas-system.svc
    - global-alb2.cpaas-system.svc.cluster.local
  issuerRef:
    name: baremetal-bootstrap-ca
    kind: Issuer
```

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get crd certificates.cert-manager.io issuers.cert-manager.io
apply_rendered global-primary.env global-primary/01-bootstrap-dex-tls.yaml "${BOOTSTRAP_KUBECONFIG}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system wait certificate/baremetal-bootstrap-ca --for=condition=Ready --timeout=120s
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system wait certificate/dex-tls-bootstrap --for=condition=Ready --timeout=120s

# expect ca.crt,tls.crt,tls.key — list the keys, never print the values
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret dex.tls -o json | jq -r '.data | keys | join(",")'
tmp_dir=$(mktemp -d)
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret dex.tls -o jsonpath='{.data.ca\.crt}' | base64 -d > "${tmp_dir}/ca.crt"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret dex.tls -o jsonpath='{.data.tls\.crt}' | base64 -d > "${tmp_dir}/tls.crt"
openssl verify -CAfile "${tmp_dir}/ca.crt" "${tmp_dir}/tls.crt"
openssl x509 -in "${tmp_dir}/tls.crt" -noout -text | grep "IP Address:${HOST_IP}"
echo | openssl s_client -connect "${HOST_IP}:12443" -servername "${HOST_IP}" \
  -CAfile "${tmp_dir}/ca.crt" -verify_return_error 2>&1 | grep "Verify return code: 0 (ok)"
rm -rf "${tmp_dir}"
```

If the last check still sees an older certificate, run
`kubectl -n cpaas-system rollout restart deploy/global-alb2` and check again.

DR only — create the two shared Secrets in this bootstrap cluster from the shared files, with
`kubectl create` as the common [Credentials](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#credentials)
rule requires.

```bash
# on the bootstrap cluster (both sides)
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system create secret generic global-encryption-provider-config \
  --from-file=encryption-provider.conf="${ENCRYPTION_PROVIDER_CONF}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system create secret generic global-sa-signing-key \
  --from-file=sa.key=/root/global-dr/sa.key \
  --from-file=sa.pub=/root/global-dr/sa.pub
```

Install the two providers. The DR values come from the cluster file, so each side gets its
role-specific values without a later patch, and the catalog entry for `K8S_VERSION` is filled at the
same time — without it every `global` `BaremetalMachine` fails with `ImageCatalogMiss`.

`global-primary/02-provider-appreleases.yaml`:

```yaml
apiVersion: operator.alauda.io/v1alpha1
kind: AppRelease
metadata:
  annotations:
    auto-recycle: "true"
    interval-sync: "true"
  name: cluster-api-provider-kubeadm
  namespace: cpaas-system
spec:
  destination:
    cluster: ""
    namespace: ""
  source:
    charts:
      - name: ait/chart-cluster-api-provider-kubeadm
        releaseName: cluster-api-provider-kubeadm
        targetRevision: ${KUBEADM_PROVIDER_VERSION}
    repoURL: ${BOOTSTRAP_REGISTRY_ADDRESS}
  timeout: 120
  values:
    global:
      albName: ${INGRESS_CLASS_NAME}
      auth:
        default_admin: admin@cpaas.io
      cluster:
        isGlobal: true
        name: global
        networkType: kube-ovn
        type: Baremetal
      host: ${PLATFORM_HOST}
      ingress:
        ingressClassName: ${INGRESS_CLASS_NAME}
      labelBaseDomain: cpaas.io
      namespace: cpaas-system
      platformUrl: https://${PLATFORM_HOST}
      protectSecretFiles:
        enabled: false
      region: global
      registry:
        address: ${BOOTSTRAP_REGISTRY_ADDRESS}
      replicas: 1
      scheme: https
---
apiVersion: operator.alauda.io/v1alpha1
kind: AppRelease
metadata:
  annotations:
    auto-recycle: "true"
    interval-sync: "true"
  name: cluster-api-provider-baremetal
  namespace: cpaas-system
spec:
  destination:
    cluster: ""
    namespace: ""
  source:
    charts:
      - name: ait/chart-cluster-api-provider-baremetal
        releaseName: cluster-api-provider-baremetal
        targetRevision: ${BAREMETAL_PROVIDER_VERSION}
    repoURL: ${BOOTSTRAP_REGISTRY_ADDRESS}
  timeout: 120
  values:
    global:
      albName: ${INGRESS_CLASS_NAME}
      auth:
        default_admin: admin@cpaas.io
      cluster:
        isGlobal: true
        name: global
        networkType: kube-ovn
        type: Baremetal
      host: ${PLATFORM_HOST}
      ingress:
        ingressClassName: ${INGRESS_CLASS_NAME}
        tls:
          secretName: dex.tls
      labelBaseDomain: cpaas.io
      namespace: cpaas-system
      # Bootstrap phase: registration goes to this bootstrap node, not to the platform domain.
      platformUrl: https://${HOST_IP}
      protectSecretFiles:
        enabled: false
      region: global
      registry:
        address: ${BOOTSTRAP_REGISTRY_ADDRESS}
      replicas: 1
      scheme: https
    provider:
      imageCatalog:
        images:
          ${K8S_VERSION}:
            repository: tkestack/baremetal-base-image
            tag: ${OS_IMAGE_TAG}
    handoffHook:
      directAPIServer: ${BM_DIRECT_API_SERVER}
      controlPlaneVIP: ${CONTROL_PLANE_VIP}
      delivery:
        enabled: true
        mode: always
    elemental:
      server:
        url: https://${HOST_IP}:12443
      systemAgent:
        authMode: shared
        splitAuthEnabled: ${BM_SPLIT_AUTH_ENABLED}
        serviceAccountName: baremetal-system-agent
        globalServiceAccountName: baremetal-global-system-agent
        sharedAuthReadOnly: ${BM_SHARED_AUTH_READ_ONLY}
      tls:
        agentTLSMode: strict
        caCertSecretName: dex.tls
        caCertSecretKey: ca.crt
```

```bash
# on the bootstrap cluster
apply_rendered global-primary.env global-primary/02-provider-appreleases.yaml "${BOOTSTRAP_KUBECONFIG}"

for crd in kubeadmcontrolplanes.controlplane.cluster.x-k8s.io \
           baremetalclusters.infrastructure.cluster.x-k8s.io \
           machineinventories.elemental.cattle.io; do
  until kubectl get crd "${crd}" >/dev/null 2>&1; do sleep 10; done
done

kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get pods | grep -E 'cluster-api-provider-baremetal|elemental'
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system logs deploy/elemental-operator --tail=100
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get configmap elemental-image-catalog -o jsonpath='{.data}'; echo   # contains K8S_VERSION

kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get apprelease cluster-api-provider-baremetal -o json | \
  jq -e --argjson direct "${BM_DIRECT_API_SERVER}" --argjson split "${BM_SPLIT_AUTH_ENABLED}" \
        --argjson ro "${BM_SHARED_AUTH_READ_ONLY}" '
    .spec.values.handoffHook.directAPIServer == $direct and
    .spec.values.elemental.systemAgent.splitAuthEnabled == $split and
    .spec.values.elemental.systemAgent.sharedAuthReadOnly == $ro'
```

Continue only when the catalog lists `K8S_VERSION` and the last command prints `true`. A
`CrashLoopBackOff` with an unknown flag such as `--system-agent-auth-mode` means the chart and the
`elemental-operator` image come from different release payloads.

Enable `Machine`-to-`Node` label synchronization on the bootstrap cluster's Cluster API controller.
It provisions the `global` nodes, and the `infra` role label reaches the nodes only through it; without
it every plugin pinned to `infra` stays `Pending`, which looks exactly like a wrong label
([Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)).

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].args}'; echo
# only if no --additional-sync-machine-labels argument is present yet (otherwise extend its value):
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system patch deploy capi-controller-manager --type json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--additional-sync-machine-labels=node-role.kubernetes.io/.*"}]'
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system rollout status deploy/capi-controller-manager
```

### Install the global cluster

This section installs one `global` side: three control-plane hosts and three `infra` hosts. In the DR
main line it runs for the primary with `global-primary.env` while the platform domain resolves to
`PRIMARY_CLUSTER_VIP`, then for the standby as described in
[Add disaster recovery](#add-disaster-recovery). The standby uses an unchanged copy of the
`global-primary/` directory — every difference between the sides is in the cluster file.

| File | Applied to | Content |
| --- | --- | --- |
| `01-bootstrap-dex-tls.yaml`, `02-provider-appreleases.yaml` | Bootstrap cluster | [Prepare the bootstrap cluster](#prepare-the-bootstrap-cluster) |
| `10-registration.yaml` | Bootstrap cluster | `MachineRegistration` and `SeedImage` |
| `15-var-cpaas-storage.yaml` | Input of `storagectl`, once per host | `/var/cpaas` declaration |
| `20-pools.yaml` | Bootstrap cluster | Two `MachineInventoryPool` objects |
| `30-control-plane.yaml` | Bootstrap cluster | `BaremetalCluster`, control-plane template, `KubeadmControlPlane`, `Cluster` |
| `40-infra-pool.yaml` | Bootstrap cluster | `infra` template, bootstrap template, `MachineDeployment` |
| `45-import-extra-resources.yaml` | Bootstrap cluster | Installer import list |
| `48-installer-config.json` | Installer API | Installation request without credentials |

The naming rule is a hard requirement: the `Cluster` and the `BaremetalCluster` are named exactly
`global`, and every other resource starts with `global-`. A resource without the prefix installs and
runs normally and is then invisible to DR — its machines are deleted at the first failover
([naming convention](https://docs.alauda.io/immutable-infra/1.0/global/install.html#common-prerequisites)).

#### Build the registration ISO

The bootstrap `MachineRegistration` registers the hosts against the bootstrap node. In DR it carries
the `global` auth-scope annotation — the only DR annotation allowed before handoff; never set
`baremetal.cluster.io/system-agent-server-url` on it.

`global-primary/10-registration.yaml`:

```yaml
apiVersion: elemental.cattle.io/v1beta1
kind: MachineRegistration
metadata:
  name: global-registration
  namespace: cpaas-system
  labels:
    app.kubernetes.io/part-of: cluster-api-provider-baremetal
  annotations:
    # DR only: marks the global hosts for the handoff. Remove for a single cluster.
    baremetal.cluster.io/system-agent-auth-scope: global
spec:
  # ${System Information/...} are expanded by elemental-register from SMBIOS data, not by render.
  machineName: "global-${System Information/UUID}"
  machineInventoryLabels:
    app.kubernetes.io/part-of: cluster-api-provider-baremetal
    pool.baremetal.alauda.io/eligible: "true"
    elemental.cattle.io/serial-number: "${System Information/Serial Number}"
  machineInventoryAnnotations:
    elemental.cattle.io/machine-uuid: "${System Information/UUID}"
  config:
    elemental:
      install:
        # Fail-closed install target, linked to the system disk WWN at the console.
        device: /dev/elemental-install-target
        eject-cd: true
        reboot: true
        snapshotter:
          type: btrfs
          maxSnaps: 4
      registration:
        auth: tpm
        # Hosts without a hardware TPM. With a hardware TPM on every host:
        # emulate-tpm: false and remove emulated-tpm-seed.
        emulate-tpm: true
        emulated-tpm-seed: -1
---
apiVersion: elemental.cattle.io/v1beta1
kind: SeedImage
metadata:
  name: global-registration-iso
  namespace: cpaas-system
  labels:
    app.kubernetes.io/part-of: cluster-api-provider-baremetal
spec:
  type: iso
  baseImage: ${BOOTSTRAP_REGISTRY_ADDRESS}/tkestack/baremetal-base-image-iso:${OS_IMAGE_TAG}
  registrationRef:
    apiVersion: elemental.cattle.io/v1beta1
    kind: MachineRegistration
    name: global-registration
    namespace: cpaas-system
  targetPlatform: linux/amd64
  size: 20Gi
  cleanupAfterMinutes: 120
  cloud-config:
    stages:
      boot:
        - name: "Size COS_STATE for reprovisioning"
          files:
            - path: /etc/elemental/config.d/partitions.yaml
              permissions: 0644
              content: |
                install:
                  partitions:
                    state:
                      size: 20480
```

```bash
# on the bootstrap cluster
render global-primary.env global-primary/10-registration.yaml > /tmp/out.yaml
grep -n '\${' /tmp/out.yaml | grep -v 'System Information/' && echo "unreplaced variables" || \
  kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply -f /tmp/out.yaml

kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system wait --for=condition=SeedImageReady=True \
  seedimage/global-registration-iso --timeout=30m
reason=$(kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get seedimage global-registration-iso \
  -o jsonpath='{.status.conditions[?(@.type=="SeedImageReady")].reason}')
iso_url=$(kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get seedimage global-registration-iso -o jsonpath='{.status.downloadURL}')
sum_url=$(kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get seedimage global-registration-iso -o jsonpath='{.status.checksumURL}')
echo "${reason} ${iso_url} ${sum_url}"   # SeedImageBuildSuccess and two non-empty URLs

curl -fL -k -o global-registration.iso "${iso_url}"
curl -fsL -k "${sum_url}"; echo; sha256sum global-registration.iso   # the two digests must match
```

Do not use `status.state` as the gate; the controller does not fill it. The URLs are cleared when the
download lifetime (`cleanupAfterMinutes`) expires even though the condition stays `True` — download
within that window. Use `--cacert` with the bootstrap CA instead of `-k` when you have it at hand.

#### Boot and register the hosts

Per host, one host at a time when disks have to be cleaned
([fixed system disk workflow](https://docs.alauda.io/immutable-infra/1.0/how-to/configure-fixed-install-disk-bare-metal.html)):

1. Confirm the clock gate for this host.
2. Mount `global-registration.iso` through BMC virtual media and boot from it.
3. In the Live ISO console, block the automatic installer and confirm the ISO is the expected one:

```bash
# in the Live ISO console
systemctl stop elemental-register-install.service
systemctl mask elemental-register-install.service
systemctl reset-failed elemental-register-install.service
grep -n '/dev/elemental-install-target' /run/initramfs/live/livecd-cloud-config.yaml
```

4. Configure the planned production network unless DHCP hands out exactly the planned address — this
   becomes the node's permanent network. Look up the real connection name first:

```bash
# in the Live ISO console
nmcli connection show
nmcli connection modify "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.0.2.21/24 ipv4.gateway 192.0.2.1 ipv4.dns 192.0.2.53 ipv4.ignore-auto-dns yes
nmcli connection up "Wired connection 1"
ip -br addr; ip route
```

5. Identify the system disk by WWN, size, model and controller address — never by kernel name alone.
   When the host is being reinstalled, clean the approved disks and verify that no `COS_*` label
   remains, as in the product procedure. Then link the install target and start the installation:

```bash
# in the Live ISO console
lsblk -d -e7 -o NAME,PATH,TYPE,SIZE,MODEL,SERIAL,WWN,HCTL
ls -l /dev/disk/by-id/wwn-*
test ! -e /dev/elemental-install-target
ln -s /dev/disk/by-id/wwn-0x5000000000000000 /dev/elemental-install-target   # this host's system disk
test -b /dev/elemental-install-target && readlink -f /dev/elemental-install-target

systemctl unmask elemental-register-install.service
systemctl reset-failed elemental-register-install.service
systemctl start elemental-register-install.service
journalctl -fu elemental-register-install.service
```

6. After the installation reboots the host, eject the virtual media, restore disk-first boot and
   confirm the host does not return to the Live ISO.

On the first host, confirm the `COS_STATE` size before the rest of the fleet installs: on the host
console, `lsblk -o NAME,SIZE,LABEL | grep COS_STATE` must show about 20G, not 8G.

#### Record the inventories

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machineinventories.elemental.cattle.io \
  -o custom-columns='NAME:.metadata.name,SERIAL:.metadata.labels.elemental\.cattle\.io/serial-number,READY:.status.conditions[?(@.type=="Ready")].status,PLAN:.status.plan.secretRef.name'
```

Match each serial number with the host plan, write the six inventory names and the hostnames into
the cluster file, and load it again. Then check every inventory — `Ready=True`, a plan Secret, the
planned network, and a fresh storage observation:

```bash
# on the bootstrap cluster
load_env global-primary.env
for inv in "${BM_CP_INVENTORY_1}" "${BM_CP_INVENTORY_2}" "${BM_CP_INVENTORY_3}" \
           "${BM_INFRA_INVENTORY_1}" "${BM_INFRA_INVENTORY_2}" "${BM_INFRA_INVENTORY_3}"; do
  echo "== ${inv}"
  kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machineinventory.elemental.cattle.io "${inv}" -o json | jq '{
    ready: ([.status.conditions[]? | select(.type=="Ready") | .status] | first),
    plan: .status.plan.secretRef.name,
    observedAt: .status.observedStorage.observedAt,
    network: .spec.observedNetwork}'
done
```

#### Prepare /var/cpaas on every inventory

Declare the data disk while the inventory is still outside any pool. Find the disk on each inventory
— use only a device whose `systemRole` is `Data` and whose report is fresh — and write the host file.
An empty `status.observedStorage` means the host OS has no `elemental-storage-observer.service` and
cannot use managed storage; stop and obtain an observer-capable image pair
([Availability and Upgrade Boundary](https://docs.alauda.io/immutable-infra/1.0/how-to/manage-bare-metal-storage.html#availability-and-upgrade-boundary)).

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machineinventory.elemental.cattle.io "${BM_CP_INVENTORY_1}" -o json \
  | jq -r '.status.observedStorage.devices[] |
      [.id,.kind,.systemRole,(.sizeBytes|tostring),(.filesystem.type//"-"),([.mounts[].path]|join(","))] | @tsv'
```

`global-primary/15-var-cpaas-storage.yaml` — the input of `storagectl`, never applied directly:

```yaml
storage:
  retryNonce: 0
  volumes:
    - name: cpaas-data
      source:
        deviceID: "${BM_DATA_DISK_ID}"
        minimumSize: ${BM_DATA_DISK_MIN_SIZE}
      filesystem:
        policy: InitializeIfBlank
        type: xfs
      mount:
        path: /var/cpaas
        required: true
        options:
          - noatime
```

`InitializeIfBlank` formats the disk only when it is objectively blank, and only with an approval bound
to this inventory. The identity that applies it needs `update` on the virtual
`machineinventories/storageinitialize` subresource; the first command below must print `yes`. Per
host:

```bash
# on the bootstrap cluster, one host at a time
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" auth can-i update machineinventories.elemental.cattle.io --subresource=storageinitialize -n cpaas-system
export BM_NS=cpaas-system
export BM_STORAGE_FILE=/tmp/baremetal-storage.yaml
export BM_INVENTORY_FILE=/tmp/baremetal-machineinventory.json
export BM_PATCH_FILE=/tmp/baremetal-storage.patch.json
host_file=hosts/global-primary/cp-1.env

set -a; . "./${host_file}"; set +a
render "${host_file}" global-primary/15-var-cpaas-storage.yaml > "${BM_STORAGE_FILE}"
"${BM_STORAGECTL}" hash --storage "${BM_STORAGE_FILE}"

kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n "${BM_NS}" get machineinventory.elemental.cattle.io "${BM_INVENTORY}" -o json > "${BM_INVENTORY_FILE}"
counter=$(( $(jq '.status.storage.lastConsumedInitializationApprovalCounter // 0' "${BM_INVENTORY_FILE}") + 1 ))
"${BM_STORAGECTL}" render-patch --inventory "${BM_INVENTORY_FILE}" \
  --storage "${BM_STORAGE_FILE}" --counter "${counter}" > "${BM_PATCH_FILE}"

# inspect spec.storage, the device ID, the path and the approval in this output first
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n "${BM_NS}" patch machineinventory.elemental.cattle.io "${BM_INVENTORY}" \
  --type=merge --patch-file="${BM_PATCH_FILE}" --dry-run=server -o yaml
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n "${BM_NS}" patch machineinventory.elemental.cattle.io "${BM_INVENTORY}" \
  --type=merge --patch-file="${BM_PATCH_FILE}"

kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n "${BM_NS}" get machineinventory.elemental.cattle.io "${BM_INVENTORY}" -o json \
  | jq '.status.storage | {phase, conditions, operation}'
```

Expect `phase=Prepared`, `StoragePrepared=True/AllRequiredVolumesPrepared`,
`StorageActive=False/Inactive` and `operation=null` on all six inventories before you continue. On a
`resourceVersion` conflict, fetch the inventory again and regenerate the patch; never strip
`resourceVersion` from it.

#### Create the pools

`global-primary/20-pools.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: MachineInventoryPool
metadata:
  name: global-control-plane-pool
  namespace: cpaas-system
spec:
  clusterName: global
  machineInventories:
    - name: ${BM_CP_INVENTORY_1}
      hostname: ${BM_CP_HOSTNAME_1}
    - name: ${BM_CP_INVENTORY_2}
      hostname: ${BM_CP_HOSTNAME_2}
    - name: ${BM_CP_INVENTORY_3}
      hostname: ${BM_CP_HOSTNAME_3}
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: MachineInventoryPool
metadata:
  name: global-infra-pool
  namespace: cpaas-system
spec:
  clusterName: global
  machineInventories:
    - name: ${BM_INFRA_INVENTORY_1}
      hostname: ${BM_INFRA_HOSTNAME_1}
    - name: ${BM_INFRA_INVENTORY_2}
      hostname: ${BM_INFRA_HOSTNAME_2}
    - name: ${BM_INFRA_INVENTORY_3}
      hostname: ${BM_INFRA_HOSTNAME_3}
```

```bash
# on the bootstrap cluster
apply_rendered global-primary.env global-primary/20-pools.yaml "${BOOTSTRAP_KUBECONFIG}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machineinventorypools.infrastructure.cluster.x-k8s.io
```

Both pools must report `Ready=True` with `Total=3` and `Available=3`. A member that is missing, not
`Ready`, without a plan Secret or with unprepared storage raises `unavailable` and shows up in the
`MembersValid` condition.

#### Create the control plane

The `KubeadmControlPlane` is the production profile of
[Complete KubeadmControlPlane Configuration](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#complete-kubeadmcontrolplane-configuration)
merged with the `global` requirements of Step 4 and the DR increments. Keep the Kubernetes images on
`cloud.alauda.io/alauda`: they are preloaded in the OS image, and any other repository produces image
references that do not exist on the host. In DR, the `BaremetalCluster` references the shared
encryption Secret and the provider injects `/etc/kubernetes/encryption-provider.conf` from it; do not
also add that file to `files`.

`global-primary/30-control-plane.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalCluster
metadata:
  name: global
  namespace: cpaas-system
spec:
  controlPlaneLoadBalancer:
    type: Internal
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
    vrid: ${BM_CONTROL_PLANE_VRID}
  networkType: kube-ovn
  # DR only: the shared encryption configuration. Remove for a single cluster.
  encryptionProviderConfigRef:
    name: global-encryption-provider-config
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalMachineTemplate
metadata:
  name: global-control-plane-template
  namespace: cpaas-system
spec:
  template:
    spec:
      machineInventoryPoolRef:
        name: global-control-plane-pool
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: global-kcp
  namespace: cpaas-system
  annotations:
    controlplane.cluster.x-k8s.io/skip-kube-proxy: ""
spec:
  replicas: 3
  version: "${K8S_VERSION}"
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
  machineTemplate:
    nodeDrainTimeout: 1m
    nodeDeletionTimeout: 5m
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: BaremetalMachineTemplate
      name: global-control-plane-template
  kubeadmConfigSpec:
    format: cloud-config
    users:
      - name: boot
        sudo: ALL=(ALL) NOPASSWD:ALL
        shell: /bin/bash
        sshAuthorizedKeys:
          - "${BOOT_SSH_PUBLIC_KEY}"
    files:
      - path: /etc/kubernetes/admission/psa-config.yaml
        owner: "root:root"
        permissions: "0644"
        content: |
          apiVersion: apiserver.config.k8s.io/v1
          kind: AdmissionConfiguration
          plugins:
          - name: PodSecurity
            configuration:
              apiVersion: pod-security.admission.config.k8s.io/v1
              kind: PodSecurityConfiguration
              defaults:
                enforce: "privileged"
                enforce-version: "latest"
                audit: "baseline"
                audit-version: "latest"
                warn: "baseline"
                warn-version: "latest"
              exemptions:
                usernames: []
                runtimeClasses: []
                namespaces:
                - kube-system
                - cpaas-system
      - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
        owner: "root:root"
        permissions: "0644"
        content: |
          {
            "apiVersion": "kubelet.config.k8s.io/v1beta1",
            "kind": "KubeletConfiguration",
            "imagePullCredentialsVerificationPolicy": "NeverVerify",
            "protectKernelDefaults": true,
            "tlsCertFile": "/etc/kubernetes/pki/kubelet.crt",
            "tlsPrivateKeyFile": "/etc/kubernetes/pki/kubelet.key",
            "streamingConnectionIdleTimeout": "5m",
            "clientCAFile": "/etc/kubernetes/pki/ca.crt"
          }
      - path: /etc/kubernetes/audit/policy.yaml
        owner: "root:root"
        permissions: "0644"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          omitStages:
          - "RequestReceived"
          rules:
          - level: None
            users:
            - system:kube-controller-manager
            - system:kube-scheduler
            - system:serviceaccount:kube-system:endpoint-controller
            verbs: ["get", "update"]
            namespaces: ["kube-system"]
            resources:
            - group: ""
              resources: ["endpoints"]
          - level: None
            nonResourceURLs:
            - /healthz*
            - /version
            - /swagger*
          - level: None
            resources:
            - group: ""
              resources: ["events"]
          - level: None
            verbs: ["get", "list", "watch"]
          - level: None
            resources:
            - group: "coordination.k8s.io"
              resources: ["leases"]
          - level: None
            resources:
            - group: "authorization.k8s.io"
              resources: ["subjectaccessreviews", "selfsubjectaccessreviews"]
            - group: "authentication.k8s.io"
              resources: ["tokenreviews"]
          - level: Metadata
            resources:
            - group: ""
              resources: ["secrets", "configmaps"]
          - level: RequestResponse
            resources:
            - group: ""
            - group: "apps"
            - group: "rbac.authorization.k8s.io"
            - group: "storage.k8s.io"
            - group: "networking.k8s.io"
          - level: Metadata
      # DR only: the shared ServiceAccount signing key. Remove both entries for a single cluster.
      - path: /etc/kubernetes/pki/sa.key
        owner: root:root
        permissions: "0600"
        contentFrom:
          secret:
            name: global-sa-signing-key
            key: sa.key
      - path: /etc/kubernetes/pki/sa.pub
        owner: root:root
        permissions: "0644"
        contentFrom:
          secret:
            name: global-sa-signing-key
            key: sa.pub
    postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
    clusterConfiguration:
      imageRepository: cloud.alauda.io/alauda
      dns:
        imageTag: "${DNS_IMAGE_TAG}"
      etcd:
        local:
          imageTag: "${ETCD_IMAGE_TAG}"
          # DR list, identical on both sides. Single cluster: CONTROL_PLANE_VIP and PLATFORM_HOST only.
          serverCertSANs:
            - "${PRIMARY_CLUSTER_VIP}"
            - "${STANDBY_CLUSTER_VIP}"
            - "${PLATFORM_HOST}"
            - "etcd.kube-system"
      apiServer:
        extraArgs:
          audit-log-format: json
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "200"
          profiling: "false"
          audit-log-mode: batch
          audit-log-path: /etc/kubernetes/audit/audit.log
          audit-policy-file: /etc/kubernetes/audit/policy.yaml
          tls-cipher-suites: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384"
          admission-control-config-file: /etc/kubernetes/admission/psa-config.yaml
          tls-min-version: VersionTLS12
          kubelet-certificate-authority: /etc/kubernetes/pki/ca.crt
          # DR only: sign and verify ServiceAccount tokens with the shared key.
          service-account-key-file: /etc/kubernetes/pki/sa.pub
          service-account-signing-key-file: /etc/kubernetes/pki/sa.key
          service-account-issuer: https://kubernetes.default.svc.cluster.local
          api-audiences: https://kubernetes.default.svc.cluster.local
        extraVolumes:
        - name: vol-dir-0
          hostPath: /etc/kubernetes
          mountPath: /etc/kubernetes
          pathType: Directory
      controllerManager:
        extraArgs:
          bind-address: "::"
          profiling: "false"
          tls-min-version: VersionTLS12
          # DR only.
          service-account-private-key-file: /etc/kubernetes/pki/sa.key
      scheduler:
        extraArgs:
          bind-address: "::"
          tls-min-version: VersionTLS12
          profiling: "false"
    initConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: global
  namespace: cpaas-system
  labels:
    cluster-type: ProviderBaremetal
  annotations:
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: BaremetalCluster
    cpaas.io/kube-ovn-join-cidr: "${KUBE_OVN_JOIN_CIDR}"
    cpaas.io/kube-ovn-version: "${KUBE_OVN_VERSION}"
    # The bootstrap Registry; the installer rewrites it to the platform Registry after installation.
    cpaas.io/registry-address: "${NODE_REGISTRY_ADDRESS}"
    cpaas.io/sentry-deploy-type: Baremetal
    cpaas.io/alb-address-type: ClusterAddress   # required literal of the Bare Metal profile
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - ${CLUSTER_CIDR}
    services:
      cidrBlocks:
        - ${SERVICE_CIDR}
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: global-kcp
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: BaremetalCluster
    name: global
```

Check before applying: three replicas; the endpoint is an IP; the three CIDRs overlap neither each
other nor the host, VIP or other-cluster networks; in DR, the SAN list matches the other side's.

```bash
# on the bootstrap cluster
apply_rendered global-primary.env global-primary/30-control-plane.yaml "${BOOTSTRAP_KUBECONFIG}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get baremetalmachines.infrastructure.cluster.x-k8s.io -w   # Pending → Allocated → Reprovisioning → Running
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get clusters.cluster.x-k8s.io global
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane global-kcp
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get baremetalcluster global \
  -o jsonpath='{.status.conditions[?(@.type=="EndpointReady")].status}'; echo
```

The control plane is ready when the `KubeadmControlPlane` reports `Ready: True` and the `Cluster`
reports `Phase: Provisioned`. Save the `global` kubeconfig as described in the common
[Kubeconfig convention](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#kubeconfig-convention)
— read it before the bootstrap cluster is removed:

```bash
# on the bootstrap cluster
umask 077; mkdir -p /root/.kube/acp
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret global-kubeconfig -o jsonpath='{.data.value}' | base64 -d \
  > "${CLUSTER_KUBECONFIG}"
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get nodes -o wide
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n kube-system get pods -l app=alive -o wide
```

#### Add the infra pool

Apply the `infra` pool after the control plane is `Ready`. Labels and the taint are declared on the
pool, never set by hand on nodes; the `worker` role label puts the nodes into the default worker
MachineConfigPool, without which they silently miss time zone and NTP configuration.

`global-primary/40-infra-pool.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalMachineTemplate
metadata:
  name: global-infra-template
  namespace: cpaas-system
spec:
  template:
    spec:
      machineInventoryPoolRef:
        name: global-infra-pool
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: global-worker-bootstrap
  namespace: cpaas-system
spec:
  template:
    spec:
      users:
        - name: boot
          sudo: ALL=(ALL) NOPASSWD:ALL
          shell: /bin/bash
          sshAuthorizedKeys:
            - "${BOOT_SSH_PUBLIC_KEY}"
      files:
        - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
          owner: "root:root"
          permissions: "0644"
          content: |
            {
              "apiVersion": "kubelet.config.k8s.io/v1beta1",
              "kind": "KubeletConfiguration",
              "imagePullCredentialsVerificationPolicy": "NeverVerify",
              "protectKernelDefaults": true,
              "staticPodPath": null,
              "tlsCertFile": "/etc/kubernetes/pki/kubelet.crt",
              "tlsPrivateKeyFile": "/etc/kubernetes/pki/kubelet.key",
              "streamingConnectionIdleTimeout": "5m",
              "clientCAFile": "/etc/kubernetes/pki/ca.crt"
            }
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: global-infra
  namespace: cpaas-system
spec:
  clusterName: global
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels: {}
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: global
        pool.name: global-infra
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: global
      version: "${K8S_VERSION}"
      nodeDrainTimeout: 5m
      nodeVolumeDetachTimeout: 5m
      taints:
        - key: node-role.kubernetes.io/infra
          value: reserved
          effect: NoSchedule
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: global-worker-bootstrap
          namespace: cpaas-system
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: BaremetalMachineTemplate
        name: global-infra-template
        namespace: cpaas-system
```

```bash
# on the bootstrap cluster
apply_rendered global-primary.env global-primary/40-infra-pool.yaml "${BOOTSTRAP_KUBECONFIG}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machinedeployment global-infra
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get baremetalmachine -l cluster.x-k8s.io/cluster-name=global \
  -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,INVENTORY:.status.machineInventoryRef.name'
# on global: labels and taints arrived on the nodes, not only on the Machines
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get nodes -L node-role.kubernetes.io/infra,node-role.kubernetes.io/worker
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

Continue when all six `BaremetalMachine` objects are `Running`, each on the inventory you planned for
it.

#### Import the provider resources

The import ConfigMap must exist **before** the installer request. It carries the Bare Metal and
Elemental owner objects that the handoff uses to enumerate the `global` machines; without it the
handoff runs with an empty target list (Step 7 of
[Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html)). It
must not import plan Secrets, `KubeadmConfig` objects, bootstrap data Secrets, `SeedImage` objects or
the registration token Secret: imported too early, a plan Secret still points at the bootstrap owner
UID and is garbage-collected. All six `global` inventories are listed, so the `infra` hosts are handed
off too.

`global-primary/45-import-extra-resources.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcs-import-extra-resources
  namespace: cpaas-system
data:
  resources.yaml: |
    resources:
    - resource: "customresourcedefinitions.apiextensions.k8s.io"
      names:
        - baremetalclusters.infrastructure.cluster.x-k8s.io
        - baremetalmachines.infrastructure.cluster.x-k8s.io
        - baremetalmachinetemplates.infrastructure.cluster.x-k8s.io
        - machineinventorypools.infrastructure.cluster.x-k8s.io
        - machineinventories.elemental.cattle.io
        - machineregistrations.elemental.cattle.io
        - seedimages.elemental.cattle.io
      method: kubectl
    - resource: "baremetalclusters.infrastructure.cluster.x-k8s.io"
      names: ["global"]
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/baremetalclusters/cpaas-system/"
      method: etcdctl
    - resource: "baremetalmachinetemplates.infrastructure.cluster.x-k8s.io"
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/baremetalmachinetemplates/cpaas-system/"
      method: etcdctl
    - resource: "baremetalmachines.infrastructure.cluster.x-k8s.io"
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/baremetalmachines/cpaas-system/"
      method: etcdctl
    - resource: "machineinventorypools.infrastructure.cluster.x-k8s.io"
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/machineinventorypools/cpaas-system/"
      method: etcdctl
    - resource: "machineinventories.elemental.cattle.io"
      names:
        - "${BM_CP_INVENTORY_1}"
        - "${BM_CP_INVENTORY_2}"
        - "${BM_CP_INVENTORY_3}"
        - "${BM_INFRA_INVENTORY_1}"
        - "${BM_INFRA_INVENTORY_2}"
        - "${BM_INFRA_INVENTORY_3}"
      etcdKeyBase: "/registry/elemental.cattle.io/machineinventories/cpaas-system/"
      method: etcdctl
    - resource: "machineregistrations.elemental.cattle.io"
      names: ["global-registration"]
      etcdKeyBase: "/registry/elemental.cattle.io/machineregistrations/cpaas-system/"
      method: etcdctl
    # DR only: the Secret referenced by BaremetalCluster.spec.encryptionProviderConfigRef.
    # Remove this entry for a single cluster.
    - resource: "secrets"
      names:
        - "global-encryption-provider-config"
      method: kubectl
```

```bash
# on the bootstrap cluster: the live inventory references must equal the six names in the file
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get baremetalmachine -l cluster.x-k8s.io/cluster-name=global \
  -o jsonpath='{range .items[*]}{.status.machineInventoryRef.name}{"\n"}{end}' | sort
apply_rendered global-primary.env global-primary/45-import-extra-resources.yaml "${BOOTSTRAP_KUBECONFIG}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get cm dcs-import-extra-resources -o yaml
# DR only: must print global-encryption-provider-config, the Secret name listed in the file
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get baremetalcluster global \
  -o jsonpath='{.spec.encryptionProviderConfigRef.name}'; echo
```

In DR, an empty result means the installed `BaremetalCluster` CRD dropped the reference; stop, because
the control plane is then running without the shared encryption configuration.

#### Trigger the platform installation

The request file is a template without credentials. The passwords are read at a prompt, injected with
`jq` into a `0600` working copy, and the copy is deleted right after the request. On Bare Metal,
`REGISTRY_DOMAIN` is `<PLATFORM_HOST>:11443` and `registry.externalAddress` stays unset, so the
installer deploys the platform Registry. `console.host` is the local VIP, never the domain; the domain
goes into `console.globalHost`.

`global-primary/48-installer-config.json`:

```json
{
  "basic": {
    "username": "admin@cpaas.io",
    "password": ""
  },
  "registry": {
    "domain": "${REGISTRY_DOMAIN}",
    "username": "",
    "password": ""
  },
  "console": {
    "host": [
      "${CONTROL_PLANE_VIP}"
    ],
    "globalHost": "${PLATFORM_HOST}",
    "httpPort": 80,
    "httpsPort": 443,
    "cert": {
      "selfSigned": {}
    }
  },
  "cluster": {
    "clusterCIDR": "${CLUSTER_CIDR}",
    "serviceCIDR": "${SERVICE_CIDR}",
    "features": {
      "ha": {
        "vip": "${CONTROL_PLANE_VIP}",
        "vport": 6443,
        "isThirdParty": true
      }
    }
  },
  "product": [
    "base",
    "acp"
  ],
  "deployMode": "normal",
  "hostIP": "${HOST_IP}"
}
```

DR: both sides must serve the **same trusted third-party certificate** for `PLATFORM_HOST`; two
unrelated self-signed certificates break the hosts and the standby after a failover. Replace
`"selfSigned": {}` with the `thirdParty` block that carries the base64 full chain and private key, as
the Third-Party Console Certificates note of Step 8 in
[Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
describes, and inject the private key at submit time the same way as the passwords — never into the
template. Its SAN is the platform domain; add a VIP only when clients really use platform HTTPS through
that VIP. Use the same platform administrator and Registry credentials on both sides, as
[Global Cluster Disaster Recovery](https://docs.alauda.io/container_platform/4.4/install/global_dr.html)
requires.

```bash
# on the bootstrap node
load_env global-primary.env
export INSTALLER_IP=$(kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get pods -n cpaas-system -l service_name=cpaas-installer \
  -o jsonpath='{.items[0].status.podIP}')
umask 077
mkdir -p /root/yamls
read -rsp 'Platform admin password: ' pw; echo
export ADMIN_PASSWORD_B64="$(printf '%s' "${pw}" | base64 -w0)"
read -rp 'Registry username: ' REGISTRY_USERNAME; export REGISTRY_USERNAME
read -rsp 'Registry password: ' pw; echo
export REGISTRY_PASSWORD_B64="$(printf '%s' "${pw}" | base64 -w0)"
unset pw

render global-primary.env global-primary/48-installer-config.json | jq '
    .basic.password = env.ADMIN_PASSWORD_B64
  | .registry.username = env.REGISTRY_USERNAME
  | .registry.password = env.REGISTRY_PASSWORD_B64' > /root/yamls/installer-config.json
unset ADMIN_PASSWORD_B64 REGISTRY_USERNAME REGISTRY_PASSWORD_B64

grep -n '\${' /root/yamls/installer-config.json && echo "unreplaced variables" || \
  curl -k -X POST "http://${INSTALLER_IP}:8080/cpaas-installer/api/config/dcs" \
    -H 'Content-Type: application/json' -d @/root/yamls/installer-config.json
rm -f /root/yamls/installer-config.json
```

#### Monitor and verify

A `global` installation takes 30 to 60 minutes (Step 9):

```bash
# on the bootstrap node
curl "http://${INSTALLER_IP}:8080/cpaas-installer/api/progress"
tail -f /var/cpaas/data/installer.log
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get nodes
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get clusters.platform.tkestack.io global -o jsonpath='{.status.phase}'; echo
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get pods -n cpaas-system
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get clustermodule global
```

The installation is complete when the progress API reports `status: Success` and `type: Complete`,
all six nodes are `Ready`, the critical `cpaas-system` Pods are `Running` or `Completed`, and
`ClusterModule/global` reports the base module healthy. Then check the Bare Metal specifics:

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get nodes \
  -o custom-columns='NAME:.metadata.name,PROVIDER_ID:.spec.providerID,IP:.status.addresses[?(@.type=="InternalIP")].address'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cluster.cluster.x-k8s.io global \
  -o jsonpath='{.metadata.annotations.cpaas\.io/registry-address}'; echo      # now REGISTRY_DOMAIN

# DR only: the imported encryption Secret matches the shared file (compare digests, never print it)
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret global-encryption-provider-config \
  -o jsonpath='{.data.encryption-provider\.conf}' | base64 -d | sha256sum
sha256sum "${ENCRYPTION_PROVIDER_CONF}"
# DR only: the KubeadmControlPlane reads the signing key from this Secret whenever it builds a new
# control-plane node, so it must exist on global as well
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret global-sa-signing-key
```

Expect six nodes, every `providerID` `baremetal:///<inventory-name>`, and the planned node IPs.

The product's import list does not include `global-sa-signing-key`, and the product documentation does
not say how `global` obtains it after handoff. If it is missing on `global`, create it there from the
shared files with the same `kubectl create secret` command as on the bootstrap cluster, while the
bootstrap node still holds them: the `KubeadmControlPlane` cannot build bootstrap data for a new
control-plane node without it. DR only — on one control-plane node of each side, the digests must equal
those of the shared files and the flags must be identical on both sides:

```bash
# on a control-plane node of each global side
sudo sha256sum /etc/kubernetes/pki/sa.key /etc/kubernetes/pki/sa.pub /etc/kubernetes/encryption-provider.conf
sudo grep -E 'service-account-(issuer|key-file|signing-key-file)|api-audiences|encryption-provider-config' \
  /etc/kubernetes/manifests/kube-apiserver.yaml
sudo grep service-account-private-key-file /etc/kubernetes/manifests/kube-controller-manager.yaml
```

#### Prepare global as the management cluster

The installation imports only the Bare Metal CRDs. It does not install the providers on `global`, nor
the OS images, nor the catalog entry; without this step `global` cannot replace its own nodes once the
bootstrap node is gone, and cannot create workload clusters
([Prepare the global Cluster as a Management Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html#prepare-global-as-management-cluster)).
Run it on every `global` side **while the platform domain resolves to that side**: the Registry
address in `ProductBase` is `<PLATFORM_HOST>:11443` on both sides, so the domain decides which Registry
receives the push, and the push must authenticate with the `registry-admin` credential of that same
side.

```bash
# on the bootstrap node of this side
load_env global-primary.env
getent hosts "${PLATFORM_HOST}"     # must print this side's CONTROL_PLANE_VIP
GLOBAL_REGISTRY_ADDRESS="$(kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" \
  get productbase.product.alauda.io base -o jsonpath='{.spec.registry.address}')"
GLOBAL_REGISTRY_PASSWORD="$(kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system \
  get secret registry-admin -o jsonpath='{.data.password}' | base64 -d)"
```

1. **Upload the packages and enable label synchronization on this side** — the common
   [Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)
   (Upload the packages, Enable label synchronization). The upload carries the two provider packages
   and, for DR, `etcd-sync`. Replacement `infra` nodes and every workload node get their labels from
   this side's controller from now on.

2. **Install both providers on `global`** as cluster plugins
   ([Cluster Plugin, Installing via YAML](https://docs.alauda.io/container_platform/4.4/extend/cluster_plugin.html#installing-via-yaml)).
   The product documentation does not list the plugin's configuration keys, so read the Bare Metal
   provider's `ModuleConfig` first and set through it the same system-agent values as on this side's
   bootstrap release, plus the final certificate key — the check below is the gate:
   `elemental.systemAgent.splitAuthEnabled` = `BM_SPLIT_AUTH_ENABLED`,
   `elemental.systemAgent.sharedAuthReadOnly` = `BM_SHARED_AUTH_READ_ONLY`, and
   `elemental.tls.caCertSecretKey: tls.crt`. On `global`, `dex.tls` comes from the installer and has no
   `ca.crt` key; with the default key `elemental-operator` never starts
   (`references non-existent secret key: ca.crt`). Then verify the effective values:

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy \
  cluster-api-provider-baremetal-manager elemental-operator
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret dex.tls -o json \
  | jq -r '.data | keys | join(",")'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get apprelease -A -o json | \
  jq -e --argjson split "${BM_SPLIT_AUTH_ENABLED}" --argjson ro "${BM_SHARED_AUTH_READ_ONLY}" '
    [.items[] | select(any(.spec.source.charts[]?; .name | test("baremetal")))] |
    length == 1 and
    (.[0].spec.values.elemental.systemAgent.splitAuthEnabled // false) == $split and
    (.[0].spec.values.elemental.systemAgent.sharedAuthReadOnly // false) == $ro and
    .[0].spec.values.elemental.tls.caCertSecretKey == "tls.crt"'
```

3. **Push both OS images to this side's Registry.** Workload `SeedImage` builds and every later
   reprovision of a `global` node pull from it; until then an ISO build fails with
   `MANIFEST_UNKNOWN`.

```bash
# on the bootstrap node
for repo in baremetal-base-image baremetal-base-image-iso; do
  ctr -n bare-metal-os images push --local --skip-verify \
    -u "admin:${GLOBAL_REGISTRY_PASSWORD}" \
    "${GLOBAL_REGISTRY_ADDRESS}/tkestack/${repo}:${OS_IMAGE_TAG}" "${repo}:${OS_IMAGE_TAG}"
  curl -sk -u "admin:${GLOBAL_REGISTRY_PASSWORD}" \
    "https://${GLOBAL_REGISTRY_ADDRESS}/v2/tkestack/${repo}/tags/list"
done
unset GLOBAL_REGISTRY_PASSWORD
```

Each response must list `OS_IMAGE_TAG`. Then remove the local copies with
`ctr -n bare-metal-os images rm`.

4. **Add the catalog entry.** `global` does not inherit the bootstrap entry. Patch, do not replace,
   so that entries added later for upgrades survive:

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system patch configmap elemental-image-catalog --type merge \
  -p "{\"data\":{\"${K8S_VERSION}\":\"${GLOBAL_REGISTRY_ADDRESS}/tkestack/baremetal-base-image:${OS_IMAGE_TAG}\"}}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get configmap elemental-image-catalog -o jsonpath='{.data}'; echo
```

#### Retire the bootstrap cluster

Single cluster: retire it after this gate. DR: only after the handoff gate has passed on **both**
sides in [Add disaster recovery](#add-disaster-recovery). Do not retire it because the installer
reports success or the handoff Job is `Complete` — every imported host must have reported to the final
cluster first
([Decommission the Bootstrap Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html#decommission-bootstrap-cluster)):

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get configmap baremetal-system-agent-handoff \
  -o jsonpath='{.data.ready}'; echo                                          # true
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machineinventories.elemental.cattle.io \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.plan.state}{"\n"}{end}'   # all Applied
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get serviceaccount,secret,role,rolebinding \
  | grep -E 'baremetal-(global-)?system-agent'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system \
  get rolebinding baremetal-global-system-agent-handoff-bridge               # NotFound
```

Never patch `data.ready` by hand. With split authentication disabled (single cluster) `global`
carries only the shared `baremetal-system-agent` identity; with it enabled it also carries
`baremetal-global-system-agent`, and the two Roles never name the same plan Secret. Then remove only
the bootstrap cluster `minialauda` and its KIND container network from the bootstrap node; the product
documentation names these two objects but gives no removal command, so obtain it from Alauda technical
support rather than improvising one. **Never
delete the `Cluster`, `KubeadmControlPlane` or Bare Metal objects as cleanup** — they now own the live
`global` nodes, and deleting them destroys the cluster you just installed.

### Add disaster recovery

#### Install order

Two bootstrap nodes, one per side. The order is fixed, and what switches is only the platform domain —
each cluster is always reached through its own VIP
([Optional Disaster Recovery Deployment](https://docs.alauda.io/immutable-infra/1.0/global/install.html#optional-disaster-recovery-deployment)).
The stages are those of the common
[delivery flow](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#delivery-flow):

| Common stage | Platform domain resolves to | Bare Metal action |
| ---: | --- | --- |
| 4 | — | [Prepare Bare Metal](#prepare-bare-metal), including [Generate the shared DR material](#generate-the-shared-dr-material); confirm the bidirectional DR network |
| 7 | `PRIMARY_CLUSTER_VIP` | Primary: [Prepare the bootstrap cluster](#prepare-the-bootstrap-cluster) and [Install the global cluster](#install-the-global-cluster) up to [Prepare global as the management cluster](#prepare-global-as-the-management-cluster) |
| 8 | `PRIMARY_CLUSTER_VIP` | Common plugins and machine configuration on the primary |
| 9 | `STANDBY_CLUSTER_VIP` | Standby: [Install the standby](#install-the-standby) |
| 10 | `STANDBY_CLUSTER_VIP` | Common plugins and machine configuration on the standby |
| 11 | `PRIMARY_CLUSTER_VIP` | [Handoff gate](#verify-the-handoff-on-both-sides), [rule ConfigMap](#apply-the-rule-configmap-on-both-sides), [etcd-sync](#install-etcd-sync-on-the-standby), [verification](#verify-synchronization) |
| 12 | `PRIMARY_CLUSTER_VIP` | Retire both bootstrap clusters |

The common delivery flow explains why the domain moves. After every switch, confirm with
`getent hosts "${PLATFORM_HOST}"` on the bootstrap node and on a node of the side — a cached record
silently installs half a side against the other one.

#### Install the standby

On the standby bootstrap node, with the shared files in `/root/global-dr/`:

```bash
# on the standby bootstrap node, in the delivery directory
cp -r global-primary global-standby     # unchanged copy; every difference is in global-standby.env
load_env global-standby.env
getent hosts "${PLATFORM_HOST}"          # must print STANDBY_CLUSTER_VIP
```

Run [Prepare the bootstrap cluster](#prepare-the-bootstrap-cluster) and every step of
[Install the global cluster](#install-the-global-cluster) with `global-standby.env`, the
`global-standby/` files and the `hosts/global-standby/` files. The differences come only from the
cluster file: `HOST_IP` and `NODE_REGISTRY_ADDRESS` of the standby bootstrap node, `CONTROL_PLANE_VIP`
= `STANDBY_CLUSTER_VIP` (in the `BaremetalCluster`, `handoffHook.controlPlaneVIP`, `console.host` and
`cluster.features.ha.vip`), its own `vrid`, inventories and hostnames, and
`BM_SHARED_AUTH_READ_ONLY='true'`. `REGISTRY_DOMAIN` stays `<PLATFORM_HOST>:11443`, and `INSTALLER_IP`
is read from the standby bootstrap cluster, never reused from the primary.

#### Verify the handoff on both sides

Once stage 10 is complete on the standby, switch the platform domain back to `PRIMARY_CLUSTER_VIP` and
confirm it; the checks below do not depend on the domain. Run them from the delivery host, with SSH
access to the `global` hosts and four kubeconfigs: both `global` ones and a copy of each side's
`BOOTSTRAP_KUBECONFIG`. Keep shell tracing off, because the files read on the hosts contain a bearer
token ([Verify Before Decommissioning Either Bootstrap Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bare-metal-dr-verification)).

```bash
# on the delivery host
load_env global-primary.env
set +x
export PRIMARY_GLOBAL_KUBECONFIG=/root/.kube/acp/global-primary.kubeconfig
export STANDBY_GLOBAL_KUBECONFIG=/root/.kube/acp/global-standby.kubeconfig
export PRIMARY_BOOTSTRAP_KUBECONFIG=/root/.kube/acp/bootstrap-primary.kubeconfig
export STANDBY_BOOTSTRAP_KUBECONFIG=/root/.kube/acp/bootstrap-standby.kubeconfig
export PRIMARY_GLOBAL_HOSTS="192.0.2.21 192.0.2.22 192.0.2.23 192.0.2.24 192.0.2.25 192.0.2.26"
export STANDBY_GLOBAL_HOSTS="203.0.113.21 203.0.113.22 203.0.113.23 203.0.113.24 203.0.113.25 203.0.113.26"
export PRIMARY_GLOBAL_REGISTRATION_NAME=global-registration
export STANDBY_GLOBAL_REGISTRATION_NAME=global-registration
```

First the Registry propagation. Both sides must carry the identical `<PLATFORM_HOST>:11443`
everywhere, which is what lets synchronization replicate these keys without overwriting anything:

```bash
# on the delivery host
verify_baremetal_global_registry() {
  kubeconfig=$1
  expected_registry=$2

  test "$(kubectl --kubeconfig "${kubeconfig}" \
    get productbase.product.alauda.io base \
    -o jsonpath='{.spec.registry.address}')" = "${expected_registry}"
  test "$(kubectl --kubeconfig "${kubeconfig}" \
    get cluster.platform.tkestack.io global \
    -o jsonpath='{.metadata.annotations.cpaas\.io/registry-address}')" = \
    "${expected_registry}"
  test "$(kubectl --kubeconfig "${kubeconfig}" -n cpaas-system \
    get cluster.cluster.x-k8s.io global \
    -o jsonpath='{.metadata.annotations.cpaas\.io/registry-address}')" = \
    "${expected_registry}"
  test "$(kubectl --kubeconfig "${kubeconfig}" -n cpaas-system \
    get secret public-registry-credential -o jsonpath='{.data.registry}' | \
    base64 -d)" = "${expected_registry}"

  if kubectl --kubeconfig "${kubeconfig}" -n cpaas-system \
    get secret global-registry-auth >/dev/null 2>&1; then
    kubectl --kubeconfig "${kubeconfig}" -n cpaas-system \
      get secret global-registry-auth -o jsonpath='{.data.\.dockerconfigjson}' | \
      base64 -d | jq -e --arg registry "${expected_registry}" \
        '.auths[$registry] != null' >/dev/null
  fi

  kubectl --kubeconfig "${kubeconfig}" get apprelease -A -o json | \
    jq -e --arg registry "${expected_registry}" '
      all(.items[];
        .spec.source.repoURL == $registry and
        .spec.values.global.registry.address == $registry)
    ' >/dev/null
}

verify_baremetal_global_registry "${PRIMARY_GLOBAL_KUBECONFIG}" "${REGISTRY_DOMAIN}" && echo "primary ok"
verify_baremetal_global_registry "${STANDBY_GLOBAL_KUBECONFIG}" "${REGISTRY_DOMAIN}" && echo "standby ok"
```

Then the complete handoff gate. Save the three functions `verify_global_auth_scope`,
`verify_baremetal_handoff` and `verify_global_local_system_agent_rbac` from the product section
verbatim as `dr-gate.sh` — per host they check that the system agent uses the local VIP, the local
token and CA, its own plan Secret and strict TLS, and that the two permission sets do not overlap —
then run:

```bash
# on the delivery host
( set -euo pipefail
  . ./dr-gate.sh
  verify_baremetal_handoff \
    "${PRIMARY_BOOTSTRAP_KUBECONFIG}" "${PRIMARY_GLOBAL_KUBECONFIG}" \
    "${PRIMARY_CLUSTER_VIP}" \
    "${PRIMARY_GLOBAL_HOSTS}" "${PRIMARY_GLOBAL_REGISTRATION_NAME}"
  verify_baremetal_handoff \
    "${STANDBY_BOOTSTRAP_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}" \
    "${STANDBY_CLUSTER_VIP}" \
    "${STANDBY_GLOBAL_HOSTS}" "${STANDBY_GLOBAL_REGISTRATION_NAME}"
  verify_global_local_system_agent_rbac "${PRIMARY_GLOBAL_KUBECONFIG}"
  verify_global_local_system_agent_rbac "${STANDBY_GLOBAL_KUBECONFIG}"
  echo "handoff gate passed" )
```

The script logs in to the hosts as `root`; provide an SSH identity that can read the agent files on
every `global` host. Do not reduce acceptance to `data.ready`: a token or CA mismatch, a stale
bootstrap endpoint in `/oem/elemental-system-agent.yaml`, a failed plan probe or a wrong permission
boundary means the handoff is incomplete even when `ready` is `true`. Do not create the shared
`baremetal-system-agent` bundle by hand to satisfy the gate — it appears with the first workload
registration and is then synchronized.

#### Apply the rule ConfigMap on both sides

Create `baremetal-dr-rules` on **both** sides **before** installing `etcd-sync`: installing the plugin with the
active VIP and token set opens the sync path at once, and a sync without this rule source gives the
standby hosts the primary's plans. The ConfigMap lists every `global` plan Secret of both sides; read
them now — the handoff created them, so names collected earlier are stale
([Synchronization Rules](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#synchronization-rules)).

```bash
# on the delivery host
mkdir -p global-dr
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "${kc}" -n cpaas-system get machineinventories.elemental.cattle.io -o json | \
    jq -r '.items[]
      | select(.metadata.annotations["baremetal.cluster.io/system-agent-auth-scope"] == "global")
      | "/registry/secrets/cpaas-system/" + .status.plan.secretRef.name'
done | sort -u > global-dr/ignore-equal.txt
wc -l < global-dr/ignore-equal.txt          # 12: six hosts per side

for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "${kc}" -n cpaas-system create configmap baremetal-dr-rules \
      --from-file=ignore-equal.txt=global-dr/ignore-equal.txt --dry-run=client -o yaml | \
    kubectl label --local -f - etcd-sync.cpaas.io/enabled=true -o yaml | \
    kubectl annotate --local -f - etcd-sync.cpaas.io/weight=100 -o yaml | \
    kubectl --kubeconfig "${kc}" apply -f -
done
```

The result is the product template: `ConfigMap/cpaas-system/baremetal-dr-rules` with the label
`etcd-sync.cpaas.io/enabled: "true"`, the annotation `etcd-sync.cpaas.io/weight: "100"` and one
`ignore-equal.txt` line per `global` plan Secret. The plugin chart supplies every other Bare Metal rule;
do not duplicate them. Update the ConfigMap on both sides whenever a `global` plan Secret is added or
replaced — for example after a `global` host is registered again.

#### Install etcd-sync on the standby

Install the `etcd-sync` plugin (ACP 4.4.0 or later; the package is `etcd-sync`, not `global-etcd-sync`)
on the **standby only** — never on both sides at once
([Install etcd-sync](https://docs.alauda.io/immutable-infra/1.0/global/install.html#install-etcd-sync)).

Create the token Secret on the standby from the active cluster's `k8sadmin` token. The pipe keeps the
token off the screen, the command line and the shell history:

```bash
# on the delivery host: from the primary global into the standby global
kubectl --kubeconfig "${PRIMARY_GLOBAL_KUBECONFIG}" -n cpaas-system get secret k8sadmin \
    -o jsonpath='{.data.token}' | base64 -d | \
  kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system \
    create secret generic etcd-sync-active-cluster-token --from-file=token=/dev/stdin
```

Install the plugin on the standby `global` — Web Console through the standby VIP, Marketplace →
Cluster Plugins, **etcd Synchronizer** — with:

| Parameter | Value |
| --- | --- |
| Active Global Cluster VIP | `PRIMARY_CLUSTER_VIP` |
| Active Global Cluster ETCD Endpoints | `https://<PRIMARY_CLUSTER_VIP>:2379`, unless a load balancer forwards `2379` |
| Standby Cluster ETCD Endpoints | Default |
| Active Global Cluster Token Secret | `etcd-sync-active-cluster-token` |
| Data Check Interval | Default |
| Print detail logs | Disabled |

```bash
# on the standby global (from the delivery host)
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get configmap baremetal-dr-rules \
  -o jsonpath='{.metadata.annotations.etcd-sync\.cpaas\.io/status}'; echo     # accepted
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get configmap etcd-sync-rule-snapshot \
  -o jsonpath='{.data.snapshot\.json}'; echo                                  # contains the source
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get job etcd-sync-bootstrap
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get po -l app=etcd-sync
```

A `rejected` rule source is not active: fix it (data keys, syntax, the `message` annotation) before
the mirror is allowed to write.

#### Verify synchronization

On a standby control-plane node, trigger the monitor check; it answers HTTP `425` until a check is
allowed. Require zero missed and zero surplus keys
([Enable etcd Synchronization](https://docs.alauda.io/container_platform/4.4/install/global_dr.html#etcd_sync)):

```bash
# on a control-plane node of the standby global
mirror_svc=$(sudo kubectl get svc -n cpaas-system etcd-sync-monitor -o jsonpath='{.spec.clusterIP}')
until curl -fsg "http://${mirror_svc}/check"; do sleep 30; done
```

The shared workload system-agent bundle must be absent on both sides or complete on both sides:

```bash
# on the delivery host
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "${kc}" -n cpaas-system get --ignore-not-found -o name \
    serviceaccount/baremetal-system-agent secret/baremetal-system-agent-token \
    role/baremetal-system-agent rolebinding/baremetal-system-agent | wc -l
done                                                    # 0 and 0, or 4 and 4
```

Restart the Pods that load DR and endpoint configuration, on a primary and on a standby control-plane
node:

```bash
# on a control-plane node of each global side
sudo kubectl delete po -n cpaas-system -l 'service_name in (alertmanager,vmselect,vminsert)'
sudo kubectl delete po -n cpaas-system -l service_name=cpaas-elasticsearch
sudo kubectl delete po -n cpaas-system -l service_name=cluster-transformer
```

Then retire both bootstrap clusters as in [Retire the bootstrap cluster](#retire-the-bootstrap-cluster).
AppRelease readiness alone is not the DR acceptance — the failover drill is
([Failover](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#failover-procedure)).
Before any later uninstall of `etcd-sync` — failover, failback, a DR-aware upgrade — the check above
must report zero differences: an inconsistent standby can resolve owner references wrongly and delete
workload `Machine` objects, which on Bare Metal runs `clean` plans on real hosts.

#### Register a replacement global host after handoff

The bootstrap `global` ISO points at a bootstrap endpoint that no longer exists. To add or replace a
`global` host later, create a new registration and `SeedImage` on the **active** `global`, named with
the `global-` prefix, with the local identity annotations
([Endpoint and Identity](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#endpoint-and-identity)):

```yaml
metadata:
  annotations:
    baremetal.cluster.io/system-agent-auth-scope: global
    baremetal.cluster.io/system-agent-server-url: https://${CONTROL_PLANE_VIP}:6443
    baremetal.cluster.io/system-agent-endpoint-mode: direct-apiserver
```

Point its `SeedImage.spec.baseImage` at `REGISTRY_DOMAIN`, prepare `/var/cpaas` on the new inventory,
add it to the pool, and add its plan Secret to `baremetal-dr-rules` on both sides. Never synchronize a
primary `global` registration to the standby.

#### DR checks

- Both sides passed [Monitor and verify](#monitor-and-verify) and the handoff gate.
- The encryption configuration, the signing key files and the etcd SAN list are identical on both
  sides.
- `baremetal-dr-rules` is `accepted` on the standby and present on the primary.
- The monitor reports zero missed and zero surplus keys.
- A failover drill has been run, and after it the
  [Bare Metal acceptance](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#bare-metal-dr-model)
  holds: workload `Cluster`, `Machine` and `BaremetalMachine` objects intact; a workload plan reaches
  `Applied`; worker scale-out and scale-in work; a workload ISO still registers a host; `global` hosts
  still use their local VIP, token and plan Secrets.

### Create a workload cluster

#### Before you start

Create workload clusters on the **active** `global` (in DR, the primary). Check on `global`:

```bash
# on global
load_env wl-prod.env
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get configmap elemental-image-catalog \
  -o jsonpath='{.data}'; echo                                                 # contains K8S_VERSION
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cluster.cluster.x-k8s.io global \
  -o jsonpath='{.metadata.annotations.cpaas\.io/registry-address}'; echo      # REGISTRY_DOMAIN
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].args}'; echo                # label sync enabled
```

- **Name.** `CLUSTER_NAME` must not be `global`
  ([Creating Clusters on Bare Metal](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html#cluster-creation-workflow)).
  Do not start it with `global-` either: DR identifies the resources of the `global` pair by that prefix
  ([naming convention](https://docs.alauda.io/immutable-infra/1.0/global/install.html#common-prerequisites)),
  and every workload resource name starts with `CLUSTER_NAME`.
- **Registry.** A cluster is bound to its Registry at creation and cannot move later. The default is
  the `global` Registry; decide before applying
  ([Choose the Image Registry for a Workload Cluster](https://docs.alauda.io/immutable-infra/1.0/how-to/workload-cluster-image-registry.html)).
- **Network.** Workload hosts reach the platform through the domain on `443` (registration and plan
  polling on `/kubernetes/global`) and the Registry on `11443`; both `global` sides reach the workload
  VIP on `6443`. A workload ISO is built on `global` with the platform domain, so it stays valid
  across a failover.
- **Hosts.** The same preparation as for `global`: [Prepare every host](#prepare-every-host) and
  [Pass the clock gate](#pass-the-clock-gate).

#### Workload manifests

The files differ from the `global` ones by the cluster name prefix, the platform Registry as image
source, no bootstrap or DR settings, and the workload timeouts of the product page.

`wl-prod/10-registration.yaml`:

```yaml
apiVersion: elemental.cattle.io/v1beta1
kind: MachineRegistration
metadata:
  name: ${CLUSTER_NAME}-registration
  namespace: cpaas-system
  labels:
    app.kubernetes.io/part-of: cluster-api-provider-baremetal
spec:
  # ${System Information/...} are expanded by elemental-register from SMBIOS data, not by render.
  machineName: "${CLUSTER_NAME}-${System Information/UUID}"
  machineInventoryLabels:
    app.kubernetes.io/part-of: cluster-api-provider-baremetal
    pool.baremetal.alauda.io/eligible: "true"
    elemental.cattle.io/serial-number: "${System Information/Serial Number}"
  machineInventoryAnnotations:
    elemental.cattle.io/machine-uuid: "${System Information/UUID}"
  config:
    elemental:
      install:
        device: /dev/elemental-install-target
        eject-cd: true
        reboot: true
        snapshotter:
          type: btrfs
          maxSnaps: 4
      registration:
        auth: tpm
        emulate-tpm: true
        emulated-tpm-seed: -1
---
apiVersion: elemental.cattle.io/v1beta1
kind: SeedImage
metadata:
  name: ${CLUSTER_NAME}-registration-iso
  namespace: cpaas-system
  labels:
    app.kubernetes.io/part-of: cluster-api-provider-baremetal
spec:
  type: iso
  baseImage: ${REGISTRY_DOMAIN}/tkestack/baremetal-base-image-iso:${OS_IMAGE_TAG}
  registrationRef:
    apiVersion: elemental.cattle.io/v1beta1
    kind: MachineRegistration
    name: ${CLUSTER_NAME}-registration
    namespace: cpaas-system
  targetPlatform: linux/amd64
  size: 20Gi
  cleanupAfterMinutes: 120
  cloud-config:
    stages:
      boot:
        - name: "Size COS_STATE for reprovisioning"
          files:
            - path: /etc/elemental/config.d/partitions.yaml
              permissions: 0644
              content: |
                install:
                  partitions:
                    state:
                      size: 20480
```

A workload `MachineRegistration` never carries the `system-agent-auth-scope: global` annotation: its
hosts register through the platform domain and get the shared identity, which keeps them reporting
after a failover.

`wl-prod/15-var-cpaas-storage.yaml` is identical to `global-primary/15-var-cpaas-storage.yaml`; copy
it.

`wl-prod/20-pools.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: MachineInventoryPool
metadata:
  name: ${CLUSTER_NAME}-control-plane-pool
  namespace: cpaas-system
spec:
  clusterName: ${CLUSTER_NAME}
  machineInventories:
    - name: ${BM_CP_INVENTORY_1}
      hostname: ${BM_CP_HOSTNAME_1}
    - name: ${BM_CP_INVENTORY_2}
      hostname: ${BM_CP_HOSTNAME_2}
    - name: ${BM_CP_INVENTORY_3}
      hostname: ${BM_CP_HOSTNAME_3}
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: MachineInventoryPool
metadata:
  name: ${CLUSTER_NAME}-infra-pool
  namespace: cpaas-system
spec:
  clusterName: ${CLUSTER_NAME}
  machineInventories:
    - name: ${BM_INFRA_INVENTORY_1}
      hostname: ${BM_INFRA_HOSTNAME_1}
    - name: ${BM_INFRA_INVENTORY_2}
      hostname: ${BM_INFRA_HOSTNAME_2}
    - name: ${BM_INFRA_INVENTORY_3}
      hostname: ${BM_INFRA_HOSTNAME_3}
```

`wl-prod/30-control-plane.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
spec:
  controlPlaneLoadBalancer:
    type: Internal
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
    vrid: ${BM_CONTROL_PLANE_VRID}
  networkType: kube-ovn
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-control-plane-template
  namespace: cpaas-system
spec:
  template:
    spec:
      machineInventoryPoolRef:
        name: ${CLUSTER_NAME}-control-plane-pool
---
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: ${CLUSTER_NAME}-control-plane
  namespace: cpaas-system
spec:
  replicas: 3
  version: "${K8S_VERSION}"
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
  machineTemplate:
    nodeDrainTimeout: 5m
    nodeVolumeDetachTimeout: 5m
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: BaremetalMachineTemplate
      name: ${CLUSTER_NAME}-control-plane-template
  kubeadmConfigSpec:
    users:
      - name: boot
        sudo: ALL=(ALL) NOPASSWD:ALL
        shell: /bin/bash
        sshAuthorizedKeys:
          - "${BOOT_SSH_PUBLIC_KEY}"
    files:
      - path: /etc/kubernetes/admission/psa-config.yaml
        owner: "root:root"
        permissions: "0644"
        content: |
          apiVersion: apiserver.config.k8s.io/v1
          kind: AdmissionConfiguration
          plugins:
          - name: PodSecurity
            configuration:
              apiVersion: pod-security.admission.config.k8s.io/v1
              kind: PodSecurityConfiguration
              defaults:
                enforce: "privileged"
                enforce-version: "latest"
                audit: "baseline"
                audit-version: "latest"
                warn: "baseline"
                warn-version: "latest"
              exemptions:
                usernames: []
                runtimeClasses: []
                namespaces:
                - kube-system
                - cpaas-system
      - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
        owner: "root:root"
        permissions: "0644"
        content: |
          {
            "apiVersion": "kubelet.config.k8s.io/v1beta1",
            "kind": "KubeletConfiguration",
            "imagePullCredentialsVerificationPolicy": "NeverVerify",
            "protectKernelDefaults": true,
            "tlsCertFile": "/etc/kubernetes/pki/kubelet.crt",
            "tlsPrivateKeyFile": "/etc/kubernetes/pki/kubelet.key",
            "streamingConnectionIdleTimeout": "5m",
            "clientCAFile": "/etc/kubernetes/pki/ca.crt"
          }
      - path: /etc/kubernetes/audit/policy.yaml
        owner: "root:root"
        permissions: "0644"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          omitStages:
          - "RequestReceived"
          rules:
          - level: None
            users:
            - system:kube-controller-manager
            - system:kube-scheduler
            - system:serviceaccount:kube-system:endpoint-controller
            verbs: ["get", "update"]
            namespaces: ["kube-system"]
            resources:
            - group: ""
              resources: ["endpoints"]
          - level: None
            nonResourceURLs:
            - /healthz*
            - /version
            - /swagger*
          - level: None
            resources:
            - group: ""
              resources: ["events"]
          - level: None
            verbs: ["get", "list", "watch"]
          - level: None
            resources:
            - group: "coordination.k8s.io"
              resources: ["leases"]
          - level: None
            resources:
            - group: "authorization.k8s.io"
              resources: ["subjectaccessreviews", "selfsubjectaccessreviews"]
            - group: "authentication.k8s.io"
              resources: ["tokenreviews"]
          - level: Metadata
            resources:
            - group: ""
              resources: ["secrets", "configmaps"]
          - level: RequestResponse
            resources:
            - group: ""
            - group: "apps"
            - group: "rbac.authorization.k8s.io"
            - group: "storage.k8s.io"
            - group: "networking.k8s.io"
          - level: Metadata
    postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
    clusterConfiguration:
      imageRepository: cloud.alauda.io/alauda
      dns:
        imageTag: "${DNS_IMAGE_TAG}"
      etcd:
        local:
          imageTag: "${ETCD_IMAGE_TAG}"
      apiServer:
        extraArgs:
          audit-log-format: json
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "200"
          profiling: "false"
          audit-log-mode: batch
          audit-log-path: /etc/kubernetes/audit/audit.log
          audit-policy-file: /etc/kubernetes/audit/policy.yaml
          tls-cipher-suites: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384"
          admission-control-config-file: /etc/kubernetes/admission/psa-config.yaml
          tls-min-version: VersionTLS12
          kubelet-certificate-authority: /etc/kubernetes/pki/ca.crt
        extraVolumes:
        - name: vol-dir-0
          hostPath: /etc/kubernetes
          mountPath: /etc/kubernetes
          pathType: Directory
      controllerManager:
        extraArgs:
          bind-address: "::"
          profiling: "false"
          tls-min-version: VersionTLS12
      scheduler:
        extraArgs:
          bind-address: "::"
          tls-min-version: VersionTLS12
          profiling: "false"
    initConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
  labels:
    cluster-type: ProviderBaremetal
  annotations:
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: BaremetalCluster
    cpaas.io/kube-ovn-join-cidr: "${KUBE_OVN_JOIN_CIDR}"
    cpaas.io/kube-ovn-version: "${KUBE_OVN_VERSION}"
    cpaas.io/sentry-deploy-type: Baremetal
    cpaas.io/alb-address-type: ClusterAddress   # required literal of the Bare Metal profile
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - ${CLUSTER_CIDR}
    services:
      cidrBlocks:
        - ${SERVICE_CIDR}
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: ${CLUSTER_NAME}-control-plane
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: BaremetalCluster
    name: ${CLUSTER_NAME}
```

`wl-prod/40-infra-pool.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-infra-template
  namespace: cpaas-system
spec:
  template:
    spec:
      machineInventoryPoolRef:
        name: ${CLUSTER_NAME}-infra-pool
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: ${CLUSTER_NAME}-worker-bootstrap
  namespace: cpaas-system
spec:
  template:
    spec:
      users:
        - name: boot
          sudo: ALL=(ALL) NOPASSWD:ALL
          shell: /bin/bash
          sshAuthorizedKeys:
            - "${BOOT_SSH_PUBLIC_KEY}"
      files:
        - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
          owner: "root:root"
          permissions: "0644"
          content: |
            {
              "apiVersion": "kubelet.config.k8s.io/v1beta1",
              "kind": "KubeletConfiguration",
              "imagePullCredentialsVerificationPolicy": "NeverVerify",
              "protectKernelDefaults": true,
              "staticPodPath": null,
              "tlsCertFile": "/etc/kubernetes/pki/kubelet.crt",
              "tlsPrivateKeyFile": "/etc/kubernetes/pki/kubelet.key",
              "streamingConnectionIdleTimeout": "5m",
              "clientCAFile": "/etc/kubernetes/pki/ca.crt"
            }
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: ${CLUSTER_NAME}-infra
  namespace: cpaas-system
spec:
  clusterName: ${CLUSTER_NAME}
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels: {}
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
        pool.name: ${CLUSTER_NAME}-infra
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: ${CLUSTER_NAME}
      version: "${K8S_VERSION}"
      nodeDrainTimeout: 5m
      nodeVolumeDetachTimeout: 5m
      taints:
        - key: node-role.kubernetes.io/infra
          value: reserved
          effect: NoSchedule
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: ${CLUSTER_NAME}-worker-bootstrap
          namespace: cpaas-system
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: BaremetalMachineTemplate
        name: ${CLUSTER_NAME}-infra-template
        namespace: cpaas-system
```

#### Apply order

Everything runs against `global` with `wl-prod.env` loaded. Steps 1 to 3 reuse the commands of the
`global` installation: replace `"${BOOTSTRAP_KUBECONFIG}"` with `"${GLOBAL_KUBECONFIG}"` and the
`global-primary` file names with the `wl-prod` ones. Apply one file at a time and check it before the
next — never the whole directory.

1. **Registration ISO.** Render and apply `10-registration.yaml` with the SMBIOS-filtered check, wait
   for `SeedImageReady=True` with reason `SeedImageBuildSuccess`, and download the ISO and its checksum
   within the cleanup window — the commands of [Build the registration ISO](#build-the-registration-iso)
   with `seedimage/${CLUSTER_NAME}-registration-iso`.
2. **Hosts.** [Boot and register the hosts](#boot-and-register-the-hosts). The Live ISO must resolve
   `PLATFORM_HOST`, because registration goes to the platform domain.
3. **Inventories.** [Record the inventories](#record-the-inventories) into `wl-prod.env`, then
   [Prepare /var/cpaas on every inventory](#prepare-varcpaas-on-every-inventory) with the
   `hosts/wl-prod/` files and `wl-prod/15-var-cpaas-storage.yaml`.
4. **Pools, control plane, `infra` pool** — in this order, each after the previous one is healthy:

```bash
# on global
apply_rendered wl-prod.env wl-prod/20-pools.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machineinventorypools.infrastructure.cluster.x-k8s.io \
  "${CLUSTER_NAME}-control-plane-pool" "${CLUSTER_NAME}-infra-pool"          # Ready, Total=3, Available=3

apply_rendered wl-prod.env wl-prod/30-control-plane.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane "${CLUSTER_NAME}-control-plane" -w

apply_rendered wl-prod.env wl-prod/40-infra-pool.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machinedeployment "${CLUSTER_NAME}-infra" -w
```

Save the workload kubeconfig as in the common
[Kubeconfig convention](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#kubeconfig-convention)
once the control plane is up. Then add the customer's worker pools as in [Worker pools](#worker-pools):
the main line has no untainted node.

#### Workload cluster checks

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cluster.cluster.x-k8s.io "${CLUSTER_NAME}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get baremetalmachines.infrastructure.cluster.x-k8s.io \
  -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}" \
  -o custom-columns='NAME:.metadata.name,PHASE:.status.phase,READY:.status.ready,INVENTORY:.status.machineInventoryRef.name'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machineinventories.elemental.cattle.io \
  -o custom-columns='NAME:.metadata.name,PLAN:.status.plan.state,STORAGE:.status.storage.phase,ACTIVE:.status.storage.conditions[?(@.type=="StorageActive")].status'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get baremetalcluster "${CLUSTER_NAME}" \
  -o jsonpath='{.spec.controlPlaneLoadBalancer.type}{" "}{.spec.controlPlaneEndpoint.host}{":"}{.spec.controlPlaneEndpoint.port}'; echo
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide \
  -L node-role.kubernetes.io/infra,node-role.kubernetes.io/worker
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n kube-system get pods -l app=alive -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get --raw=/version
```

Expect: the `Cluster` `Ready`; three control-plane replicas `Ready`; six `BaremetalMachine` objects
`Running` and `ready`, each on its planned inventory; every used inventory with `PLAN=Applied`,
`STORAGE=Active` and `StorageActive=True`; each pool with
`available + allocated + preparing + reprovisioning + unavailable = total`; all nodes `Ready` with the
planned IPs; the `infra` nodes labeled and tainted; the Alive Pods `Ready` and the API reachable
through the VIP. On each control-plane node, `sudo sysctl net.ipv4.conf.all.arp_accept
net.ipv4.vs.conntrack` prints `1` for both. When something stalls, start from the condition reason on
the `BaremetalMachine`
([Common Failure Modes](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/bare-metal.html#common-failure-modes)):
`PoolMissing`, `PoolExhausted`, `ImageCatalogMiss` (delete the `Machine` after fixing the catalog), or
a `Failed` reprovision plan (plan Secret `failed-output`, the host serial console, Registry
reachability).

### Variants

#### Single cluster

`global` doubles as the workload cluster: one bootstrap node, no standby, no `etcd-sync`, and the
application ingress also lands on the `infra` pool (placement per the common article). Remove the DR
increments:

```diff
# global-primary.env
-BM_DIRECT_API_SERVER='true'
-BM_SPLIT_AUTH_ENABLED='true'
+BM_DIRECT_API_SERVER='false'
+BM_SPLIT_AUTH_ENABLED='false'
 BM_SHARED_AUTH_READ_ONLY='false'
```

```diff
# global-primary/10-registration.yaml (MachineRegistration)
   labels:
     app.kubernetes.io/part-of: cluster-api-provider-baremetal
-  annotations:
-    baremetal.cluster.io/system-agent-auth-scope: global
```

```diff
# global-primary/30-control-plane.yaml
   networkType: kube-ovn
-  encryptionProviderConfigRef:
-    name: global-encryption-provider-config
 ...
-      - path: /etc/kubernetes/pki/sa.key
-        ...                              # both signing-key file entries
-      - path: /etc/kubernetes/pki/sa.pub
-        ...
 ...
           serverCertSANs:
-            - "${PRIMARY_CLUSTER_VIP}"
-            - "${STANDBY_CLUSTER_VIP}"
+            - "${CONTROL_PLANE_VIP}"
             - "${PLATFORM_HOST}"
-            - "etcd.kube-system"
 ...
-          service-account-key-file: /etc/kubernetes/pki/sa.pub
-          service-account-signing-key-file: /etc/kubernetes/pki/sa.key
-          service-account-issuer: https://kubernetes.default.svc.cluster.local
-          api-audiences: https://kubernetes.default.svc.cluster.local
 ...
-          service-account-private-key-file: /etc/kubernetes/pki/sa.key
```

```diff
# global-primary/45-import-extra-resources.yaml
-    - resource: "secrets"
-      names:
-        - "global-encryption-provider-config"
-      method: kubectl
```

Skip [Generate the shared DR material](#generate-the-shared-dr-material) and the two shared Secrets;
the platform certificate may stay self-signed or be the customer's own. Retire the bootstrap cluster
right after its gate in [Retire the bootstrap cluster](#retire-the-bootstrap-cluster).

#### Dedicated pools

For larger workload clusters, replace the `infra` pool with `ingress`, `monitor` and `log` pools. Each
pool gets its own inventory pool, machine template and `MachineDeployment`, its own role label and
taint key, plus the `worker` role label; the bootstrap template is shared. Register the extra hosts,
prepare their `/var/cpaas`, and add `BM_INGRESS_INVENTORY_n` / `BM_INGRESS_HOSTNAME_n` (and the
`MONITOR` and `LOG` equivalents) to the cluster file. The `ingress` pool, as a diff of the `infra`
resources:

```diff
# wl-prod/20-pools.yaml — one pool per role
-  name: ${CLUSTER_NAME}-infra-pool
+  name: ${CLUSTER_NAME}-ingress-pool
 ...
-    - name: ${BM_INFRA_INVENTORY_1}
-      hostname: ${BM_INFRA_HOSTNAME_1}
+    - name: ${BM_INGRESS_INVENTORY_1}
+      hostname: ${BM_INGRESS_HOSTNAME_1}
```

```diff
# wl-prod/40-infra-pool.yaml — one template and one MachineDeployment per role
-  name: ${CLUSTER_NAME}-infra-template
+  name: ${CLUSTER_NAME}-ingress-template
 ...
-        name: ${CLUSTER_NAME}-infra-pool
+        name: ${CLUSTER_NAME}-ingress-pool
 ...
-  name: ${CLUSTER_NAME}-infra
+  name: ${CLUSTER_NAME}-ingress
 ...
-        pool.name: ${CLUSTER_NAME}-infra
-        node-role.kubernetes.io/infra: ""
+        pool.name: ${CLUSTER_NAME}-ingress
+        node-role.kubernetes.io/ingress: ""
         node-role.kubernetes.io/worker: ""
 ...
       taints:
-        - key: node-role.kubernetes.io/infra
+        - key: node-role.kubernetes.io/ingress
           value: reserved
           effect: NoSchedule
 ...
-        name: ${CLUSTER_NAME}-infra-template
+        name: ${CLUSTER_NAME}-ingress-template
```

Distinct taint keys make a misplaced plugin `Pending` immediately instead of landing silently on the
wrong pool. Size each dedicated pool exactly to its replicas, for the same reason as the `infra` pool.

#### Worker pools

The main line leaves a workload cluster without an untainted node: the control-plane nodes carry the
kubeadm control-plane taint and the `infra` nodes carry `node-role.kubernetes.io/infra`. Add the
customer's worker pools before handing the cluster over. Each one is built like this generic pool from
[Worker Node Deployment](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/bare-metal.html#worker-node-deployment):
no taint, no platform role label, only the `worker` role label that puts the nodes into the default
worker MachineConfigPool. Register the hosts and prepare their `/var/cpaas` as for the `infra` hosts,
add their entries to the cluster file, and size the pool exactly to its replicas.

```bash
# wl-prod.env — worker pool entries
BM_WORKER_INVENTORY_1='wl-prod-00000000-0000-0000-0000-000000000031'
BM_WORKER_INVENTORY_2='wl-prod-00000000-0000-0000-0000-000000000032'
BM_WORKER_INVENTORY_3='wl-prod-00000000-0000-0000-0000-000000000033'
BM_WORKER_HOSTNAME_1='wl-prod-worker-1'
BM_WORKER_HOSTNAME_2='wl-prod-worker-2'
BM_WORKER_HOSTNAME_3='wl-prod-worker-3'
```

`wl-prod/42-worker-pool.yaml` (it reuses the bootstrap template of `40-infra-pool.yaml`):

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: MachineInventoryPool
metadata:
  name: ${CLUSTER_NAME}-worker-pool
  namespace: cpaas-system
spec:
  clusterName: ${CLUSTER_NAME}
  machineInventories:
    - name: ${BM_WORKER_INVENTORY_1}
      hostname: ${BM_WORKER_HOSTNAME_1}
    - name: ${BM_WORKER_INVENTORY_2}
      hostname: ${BM_WORKER_HOSTNAME_2}
    - name: ${BM_WORKER_INVENTORY_3}
      hostname: ${BM_WORKER_HOSTNAME_3}
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: BaremetalMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-worker-template
  namespace: cpaas-system
spec:
  template:
    spec:
      machineInventoryPoolRef:
        name: ${CLUSTER_NAME}-worker-pool
---
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: ${CLUSTER_NAME}-workers
  namespace: cpaas-system
spec:
  clusterName: ${CLUSTER_NAME}
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels: {}
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
        pool.name: ${CLUSTER_NAME}-workers
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: ${CLUSTER_NAME}
      version: "${K8S_VERSION}"
      nodeDrainTimeout: 5m
      nodeVolumeDetachTimeout: 5m
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: ${CLUSTER_NAME}-worker-bootstrap
          namespace: cpaas-system
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: BaremetalMachineTemplate
        name: ${CLUSTER_NAME}-worker-template
        namespace: cpaas-system
```

```bash
# on global
apply_rendered wl-prod.env wl-prod/42-worker-pool.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machinedeployment "${CLUSTER_NAME}-workers" -w
# on the workload cluster: the new nodes carry the worker label and no taint
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -l node-role.kubernetes.io/worker \
  -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

#### External load balancer for the control-plane endpoint

When the customer provides a Layer-4 load balancer for the API, provision it before applying the
control plane: TCP passthrough on `6443`, the VIP as frontend, every control-plane node IP as a
backend, an HTTPS `/healthz` check expecting `200`, reachable from the bootstrap node or `global` and
from all nodes. The load balancer owner adds and removes backends on every control-plane change
([External LoadBalancer Contract](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html#external-loadbalancer-contract)).

```diff
# 30-control-plane.yaml (BaremetalCluster)
   controlPlaneLoadBalancer:
-    type: Internal
+    type: External
     host: "${CONTROL_PLANE_VIP}"
     port: 6443
-    vrid: ${BM_CONTROL_PLANE_VRID}
```

`BM_CONTROL_PLANE_VRID` is then unused for that cluster. For `global`, the installer request is
unchanged: `console.host` and `cluster.features.ha.vip` stay the VIP; the load balancer must then also
forward the platform ports of
[LoadBalancer Forwarding Rules](https://docs.alauda.io/container_platform/4.4/install/prepare/prerequisites.html#port-forward)
and, in DR, those of [DR Network Requirements](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#network-requirements),
because the platform and the peer side reach `global` through the same VIP. Check before creation with
`nc -vz <vip> 6443`, and after the control plane is up with
`curl -kfsS https://<control-plane-node-ip>:6443/healthz` per backend.

### Continue with the common steps

Continue with the provider-neutral steps, keeping these Bare Metal points in mind:

- [Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)
  — MetalLB in Layer-2 mode announces the ingress VIP by ARP from the `infra` (or `ingress`) nodes, so
  the ingress VIP must be in their Layer-2 segment. Monitoring writes under the managed `/var/cpaas`
  volume, and the log collector will too once the logging stack is installed
  ([Logging](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#logging)); their
  storage paths cannot be changed after installation. Stateful platform components take their
  PersistentVolumes from the local storage class
  ([Local storage: TopoLVM](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#local-storage-topolvm)),
  which needs its own undeclared disk on every node of the storage cluster.
- [Configure machines](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines)
  — every `MachineDeployment` in this article carries the `worker` role label that the default worker
  MachineConfigPool selects on; a host added later still has to pass the firmware
  [clock gate](#pass-the-clock-gate).
- [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters)
  — on Bare Metal the `/var/cpaas` size is the data disk you declare; `BM_DATA_DISK_MIN_SIZE` is the
  floor Prepare enforces.
- [Accept the delivery](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#accept-the-delivery)
  — add the Bare Metal checks below.

Bare Metal acceptance checks:

1. **Inventories and pools.** Every used inventory `Ready`, plan `Applied`, storage `Active`; every
   pool's `Total` equals its replica count, and nothing is `unavailable`.
2. **Host state.** On one node per pool: `findmnt /var/cpaas` shows the managed volume;
   `lsblk -o NAME,SIZE,LABEL | grep COS_STATE` shows about 20G; `timedatectl` reports the clock
   synchronized; the node IP equals the address recorded in `spec.observedNetwork`.
3. **Reprovision test and inventory return** — on a workload cluster, before handover. Record the
   inventory, IP and `/var/cpaas` filesystem UUID (`findmnt -no UUID /var/cpaas`) of one `infra` node,
   then delete its `Machine`:

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machines.cluster.x-k8s.io \
  -l cluster.x-k8s.io/deployment-name="${CLUSTER_NAME}-infra"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system delete machine <machine-name>
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get baremetalmachines.infrastructure.cluster.x-k8s.io -w
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machineinventory.elemental.cattle.io <inventory-name> \
  -o jsonpath='{.metadata.annotations}'; echo
```

Pass: the old `BaremetalMachine` goes `Preparing`, and the inventory returns to the pool —
`baremetal.alauda.io/allocation-state` back to `Available`, the `baremetal.alauda.io/owner-*`
annotations cleared, the pool annotation kept; the replacement goes `Reprovisioning` → `Running` on
the **same** inventory, with the same IP, the same `/var/cpaas` filesystem UUID and its data, the
node `Ready` with its labels and taint, and the DaemonSets back on it.
4. **VIP failover drill** (`Internal`): find the control-plane node holding the VIP
   (`ip -br addr | grep <vip>` on each node), reboot it, and confirm the API stays reachable through
   the VIP while that node is down.
5. **Handoff.** In the DR topology, the gate of
   [Verify the handoff on both sides](#verify-the-handoff-on-both-sides) passed on both sides.
6. **Archive without secrets.** The parameter and host files, the rendered manifests and the check
   outputs go into the delivery archive; the shared DR files, kubeconfigs, the installer request and
   any certificate key never do.

## Related Information

- [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md) — the common article
- [How to Deliver ACP on Huawei DCS with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_DCS_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on Huawei Cloud Stack with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_Cloud_Stack_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on VMware vSphere with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_VMware_vSphere_with_Immutable_Infrastructure.md)
- [Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
- [Global Cluster Disaster Recovery (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html)
- [Creating Clusters on Bare Metal](https://docs.alauda.io/immutable-infra/1.0/create-cluster/bare-metal.html)
- [Managing Nodes on Bare Metal](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/bare-metal.html)
- [Manage Data Disks on Bare-Metal Hosts](https://docs.alauda.io/immutable-infra/1.0/how-to/manage-bare-metal-storage.html)
- [Select a Fixed System Disk on Multi-Disk Bare-Metal Hosts](https://docs.alauda.io/immutable-infra/1.0/how-to/configure-fixed-install-disk-bare-metal.html)
- [Bare Metal Provider](https://docs.alauda.io/immutable-infra/1.0/overview/providers/bare-metal.html)
- [Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html)
- [Upgrading Clusters on Bare Metal](https://docs.alauda.io/immutable-infra/1.0/upgrade-cluster/bare-metal.html)
- [Global Cluster Disaster Recovery (ACP)](https://docs.alauda.io/container_platform/4.4/install/global_dr.html)
