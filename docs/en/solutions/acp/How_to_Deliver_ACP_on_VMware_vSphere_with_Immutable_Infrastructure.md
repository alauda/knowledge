---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# How to Deliver ACP on VMware vSphere with Immutable Infrastructure

## Purpose

This guide is the VMware vSphere part of the standard delivery of Alauda Container Platform (ACP) 4.4 on
Immutable Infrastructure (Alauda OS nodes). It covers **workload clusters only**: the vSphere-specific
design decisions, the parameters, preparing vCenter and the `global` cluster, and the complete manifest
set for one workload cluster — three control-plane nodes and the `infra` pool — with the checks that prove
each step worked.

Scope and assumptions:

- **`global` is never on vSphere in this delivery.** It already runs on another provider and was delivered
  with [Huawei DCS](/solutions/acp/How_to_Deliver_ACP_on_Huawei_DCS_with_Immutable_Infrastructure.md),
  [Huawei Cloud Stack](/solutions/acp/How_to_Deliver_ACP_on_Huawei_Cloud_Stack_with_Immutable_Infrastructure.md)
  or [Bare Metal](/solutions/acp/How_to_Deliver_ACP_on_Bare_Metal_with_Immutable_Infrastructure.md).
  This article therefore has no "Install the global cluster" and no "Add disaster recovery" section;
  the `global` cluster and its standby are covered there.
- **Read the common article first:**
  [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md).
  The reference design, the parameter files and the `render` helper, the platform plugins, machine
  configuration, sizing and acceptance live there and are not repeated here.
- **Versions:** ACP 4.4, VMware vSphere Infrastructure Provider `v1.0.17`, and the Alauda OS
  OVA published for the delivered ACP 4.4 release, with the Kubernetes, CoreDNS, etcd and Kube-OVN
  versions from that release's row in the
  [OS Support Matrix](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html#version-mapping)
  (Kubernetes 1.35 on ACP 4.4).
- Deliveries on a traditional operating system are not covered here; see the
  [standard installation path](https://docs.alauda.io/container_platform/4.4/install/).

**Validation status.** The manifests in this article are assembled from the ACP 4.4 product
documentation and the VMware vSphere Provider `v1.0.17` documentation. Validate them in a staging
environment before you use them in a production delivery.

## Resolution

### VMware vSphere-specific design

#### Control-plane endpoint: Self-built VIP

The workload cluster's API endpoint is a **Self-built VIP**:
`VSphereCluster.spec.controlPlaneLoadBalancer.type: internal`. The provider injects the VIP on the first
control-plane node while `kubeadm init` runs, then installs Alive (keepalived and IPVS) into the
workload cluster through a `ModuleInfo` and keeps the VIP on the control-plane nodes. No load balancer
device is involved.

- **It needs vSphere Provider `v1.0.17` or later and ACP 4.4 or later**, the `alive` cluster plugin
  deployable on `global`, VRRP (IP protocol `112`, multicast `224.0.0.18`) and gratuitous ARP allowed
  between the control-plane nodes — check the dvPortGroup security policy and any NSX-T distributed
  firewall rule — and an `ip_vs`-capable VM template. See
  [Self-built VIP prerequisites](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#self-built-vip-prerequisites).
- **It is a creation-time choice and the field is write-once.** `type`, `host`, `port`, `vrid` and
  `interface` are frozen once the cluster exists, and a cluster created without the field — including
  one created before the provider was upgraded to `v1.0.17` — can never adopt the VIP. Correcting a
  mistake means rebuilding the cluster, so decide and check everything before the first apply.
- **The VIP is an IPv4 address, never a domain name.** The API server certificate is issued by the
  cluster's own CA, so a customer certificate for a domain name can never be served on the endpoint.
  It must be unused, in the same Layer-2 segment as the control-plane node IPs, not one of the slot
  addresses of this cluster, and outside every external IPAM range — the provider checks slot addresses
  but cannot see IPAM pools.
- **The VRID is unique on the segment.** Two clusters with the same VRID on one Layer-2 segment take part
  in each other's VRRP election.
- `interface` is left out: with one NIC the provider picks the interface that holds the node's primary IP.
  With a second NIC, set it explicitly at creation — a wrong auto-detected interface cannot be patched.
- **Alternative: an external Layer 4 load balancer.** Leave `controlPlaneLoadBalancer` out entirely
  rather than writing `type: external` — an absent field already means an external load balancer, and
  writing it only pins a frozen second copy of the address. See
  [External load balancer instead of the Self-built VIP](#external-load-balancer-instead-of-the-self-built-vip).

#### Node slots: `VSphereMachineConfigPool`

Every node is cut from a slot in a `VSphereMachineConfigPool`: a fixed hostname, a static IP with gateway
and DNS, and the node's data disks. The rules that keep this working:

- **One pool per controller.** `<cluster>-cp-pool` serves the `KubeadmControlPlane`, `<cluster>-infra-pool`
  the `infra` `MachineDeployment`, and each dedicated pool gets its own. The provider records the owning
  controller on first allocation and rejects a second one.
- **Hostnames are `<cluster>-<pool>-<n>`.** They must be unique across every cluster in the vCenter, not
  only within this cluster: the vSphere CPI can fall back to a lookup by guest hostname, and an old VM
  that still reports the same hostname makes it reject the new node, which then never gets a
  `providerID`. Deriving the hostname from the cluster name rules that out by construction.
- **Plan every slot completely before the first apply.** Once a slot is `InUse` or `Released`, its IP and
  disks are frozen; only additional disks are accepted. Hostnames and primary IPs must be unique across
  all pools of the cluster — the admission webhook enforces it.
- **Keep pool names for the life of the cluster.** A pool with a new name owns new slots and new VMDKs.
  Retrying a failed creation under new pool names accumulates complete disk sets on the datastore until
  provider-managed reclaim finishes. Never delete VMDKs or remove pool finalizers by hand. See
  [Persistent disk lifecycle](https://docs.alauda.io/immutable-infra/1.0/infrastructure/vmware-vsphere.html#persistent-disk-lifecycle).

#### Disks

- **The standard disk set, per slot:** `/var/cpaas` as a persistent disk; `/var/lib/kubelet`,
  `/var/lib/containerd` and, on control-plane nodes, `/var/lib/etcd` as ephemeral disks. A persistent disk
  is reattached to the VM that replaces the node, so platform state and the monitoring and log data under
  `/var/cpaas` survive a node replacement. Ephemeral disks are recreated empty, so a replacement
  control-plane node never carries stale etcd member data into `kubeadm join`.
- **The split is a creation-time layout** (`ephemeralDisks[]` exists from provider `v1.0.17`). A slot can
  never move a disk from one list to the other later, and sizes of allocated disks cannot change — size
  `/var/cpaas` from the capacity pages before the first apply (see
  [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters)).
- **`diskGiB` is the system disk only.** Data disks are declared in the pool; adding their sizes to
  `diskGiB` doubles the capacity. The templates use `cloneMode: fullClone` so that `diskGiB` takes effect —
  a linked clone keeps the template's disk size and ignores it. `diskGiB` must be at least the template's
  system disk.
- **Pod logs move onto the ephemeral containerd disk** and are lost with the VM. Logs you need to keep are
  the log stack's job, not the node's.

#### Rollouts and immutable templates

- **No surge machine exists in a fixed-slot pool.** The `KubeadmControlPlane` uses
  `spec.rolloutStrategy.rollingUpdate.maxSurge: 0` with three replicas; a `MachineDeployment` uses
  `spec.strategy.rollingUpdate.maxSurge: 0` with `maxUnavailable: 1`. The provider's admission webhooks
  reject anything else. The two field paths differ — `KubeadmControlPlane` has no `strategy` and no
  `maxUnavailable` — and the Cluster API default `maxUnavailable: 0` deadlocks against `maxSurge: 0`.
- **Templates are immutable.** A change to VM size, VM template, network devices or bootstrap
  configuration is a new `VSphereMachineTemplate` or `KubeadmConfigTemplate` under a new name
  (`<cluster>-infra-v2`) plus a reference switch, which rolls the pool node by node. Rolling back is
  switching the reference back. See
  [Roll out updated worker node configuration](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/vmware-vsphere.html#roll-out-updated-worker-node-configuration).
- **The provider owns some `KubeadmControlPlane` fields.** It adds the CoreDNS and kube-proxy skip
  annotations and sets `dns.imageRepository`. Set `dns.imageTag` with its `-v4.4.x` suffix and never set
  `dns.imageRepository` — the provider reads the suffix to choose the repository. Never re-apply or
  replace the stored control-plane manifest after creation; change the control plane in place with
  `kubectl edit` or `kubectl patch`, as the product upgrade and node procedures do. See
  [Provider-managed fields on your manifests](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#provider-managed-fields).
- **Operate VMs through Cluster API, not vCenter.** Since `v1.0.17` a VM powered off in vCenter stays off
  and its Machine reports not ready; power it on in vCenter to recover.

#### vSphere CPI through `ClusterResourceSet`

The vSphere cloud provider (CPI) is delivered by a `ClusterResourceSet` on `global` as soon as the
workload API server answers; it sets each node's `providerID`. Two delivery rules:

- The `ClusterResourceSet`, its ConfigMaps and its Secret live in `cpaas-system`, the namespace of the
  `Cluster` — a `ClusterResourceSet` in another namespace silently delivers nothing.
- **The selector is scoped to one cluster.** The product example selects on
  `addons.cluster.x-k8s.io/vsphere-cpi: "enabled"`, which every vSphere cluster carries; with several
  workload clusters, every cluster's `ClusterResourceSet` would bind to every cluster and push its own
  credentials and CPI configuration into all of them. This delivery adds
  `cluster.x-k8s.io/cluster-name: <cluster>` — a label the product manifest already sets on the
  `Cluster` — to the selector; `matchLabels` entries must all match, so the set binds to its own
  cluster only. A set created earlier with the product selector still binds to every new cluster, which
  is why [Check before applying](#check-before-applying) looks for one.

#### Failure domains

The main line is one datacenter, one port group and one NIC per node. To spread nodes across
datacenters or compute clusters, use `VSphereFailureDomain` and `VSphereDeploymentZone` — they belong
together with `VSphereCluster.spec.failureDomainSelector` and the CPI `[Labels]` block as one
configuration set; enabling only part of it leaves nodes with unresolvable zone labels or a control
plane without a placement target. The template, port group and datastore names must resolve in every
datacenter. Follow
[Multiple datacenters and failure domains](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#multiple-datacenters-and-failure-domains)
and introduce one topology variant at a time.

#### Secrets and keys

- **vCenter credentials** go into two Secrets per cluster — the identity referenced by `VSphereCluster`
  and the CPI credential — both created with `kubectl create` from values typed at a prompt. Never
  `kubectl apply` a Secret that carries a credential: client-side apply stores the full manifest in the
  `last-applied-configuration` annotation of the Secret itself.
- **Encryption at rest.** The product example writes the AES key inline into the `KubeadmControlPlane`.
  This delivery keeps the same `kubeadmConfigSpec.files` entry but fills it with
  `contentFrom.secret` — the Kubeadm Provider mechanism the product also uses for the Bare Metal
  ServiceAccount key files
  ([Prepare Shared ServiceAccount Signing Key](https://docs.alauda.io/immutable-infra/1.0/global/install.html#prepare-shared-serviceaccount-signing-key)) —
  so the key appears in no parameter file, manifest or archive. Generate the key once: a later
  control-plane node with a different key cannot decrypt the Secrets already stored in etcd. Keep the
  Secret on whichever `global` is active; a new control-plane machine cannot bootstrap without it.

#### Kubernetes 1.35 kubelet setting

ACP 4.4 ships Kubernetes 1.35, so both kubelet patches carry
`"imagePullCredentialsVerificationPolicy": "NeverVerify"`, as the product page requires for 1.35 — its
baseline manifests omit the field because they are written for Kubernetes 1.34 and earlier. Without it,
the 1.35 kubelet can verify pull credentials even for the images preloaded in the template. See
[Required kubelet patch for Kubernetes 1.35](https://docs.alauda.io/immutable-infra/1.0/upgrade-cluster/index.html#kubernetes-1-35-kubelet-patch).

### Parameters

Each workload cluster has its own cluster file, `wl-<name>.env`, next to the shared `site.env` — see
[Prepare the parameter files](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files).
The common variables (`CLUSTER_NAME`, `CONTROL_PLANE_VIP`, `CLUSTER_CIDR`, `SERVICE_CIDR`,
`KUBE_OVN_JOIN_CIDR`, `INGRESS_VIP_RANGE`, `GLOBAL_KUBECONFIG`, `CLUSTER_KUBECONFIG`, `K8S_VERSION`,
`BOOT_SSH_PUBLIC_KEY`, `PLATFORM_HOST`, `REGISTRY_DOMAIN`, `ACP_TOKEN`, …) and the helpers `render`,
`load_env` and `apply_rendered` are defined there. A vSphere workload cluster file adds the following.

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `CONTROL_PLANE_VRID` | Keepalived VRID of the Self-built VIP, `1`–`255` | `51` | Network team; unique on the control-plane Layer-2 segment |
| `VSPHERE_SERVER` | vCenter address (FQDN or IP) as reached from `global` and the workload nodes | `vcenter.example.com` | vSphere administrator |
| `VSPHERE_THUMBPRINT` | SHA-1 fingerprint of the vCenter certificate | `00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33` | `openssl` command in [Collect the vCenter facts](#collect-the-vcenter-facts) |
| `VSPHERE_DATACENTER` | vCenter datacenter of the nodes | `dc-a` | `govc find / -type d`, confirmed by the vSphere administrator |
| `VSPHERE_DATASTORE` | Datastore for the VM system disks | `datastore-a` | `govc find / -type s`, confirmed by the vSphere administrator |
| `VSPHERE_FOLDER` | VM folder of this cluster, `/<datacenter>/vm/<cluster>` | `/dc-a/vm/wl-prod` | Created in vCenter before the first apply |
| `VSPHERE_NETWORK` | Port group of the node NIC | `pg-wl-prod` | `govc find / -type n`, confirmed by the network team |
| `VSPHERE_TEMPLATE` | VM template created from the Alauda OS OVA | `alauda-os-4.4.0` | Name given when the OVA was imported |
| `VSPHERE_CPI_IMAGE_TAG` | Tag of `ait/cloud-provider-vsphere` | `v1.33.1-alauda.1` | Registry tag list after the provider package is uploaded |
| `CLUSTER_REGISTRY_ADDRESS` | Permanent platform registry, `<host>:<port>`, for `cpaas.io/registry-address` | `acp.example.com:11443` | `cpaas.io/registry-address` annotation of the `global` `Cluster`; normally the value of `REGISTRY_DOMAIN` |
| `IMAGE_REGISTRY_ADDRESS` | Registry of the kubeadm `imageRepository` and the CPI image | `acp.example.com:11443` | Normally the same as `CLUSTER_REGISTRY_ADDRESS` |
| `KUBE_OVN_VERSION` | Kube-OVN chart version | `v4.4.6` | OS Support Matrix row of the delivered ACP release, column *kube-ovn (chart)* |
| `DNS_IMAGE_TAG` | CoreDNS tag, copied with its `-v4.4.x` suffix | `1.14.3-v4.4.6` | Same row, column *coredns* |
| `ETCD_IMAGE_TAG` | etcd tag | `v3.6.13-acp.0` | Same row, column *etcd* |
| `NODE_PREFIX` | Prefix length of the node subnet | `24` | Network team |
| `NODE_GATEWAY` | Default gateway of the node subnet | `192.0.2.1` | Network team |
| `NODE_DNS` | DNS server written to the nodes' `/etc/resolv.conf` | `203.0.113.53` | Customer DNS; must resolve the platform domain and, when `VSPHERE_SERVER` is a name, the vCenter |
| `CP_NODE_IP_1` | Control-plane node 1 IP, without prefix | `192.0.2.11` | IP plan |
| `CP_NODE_IP_2` | Control-plane node 2 IP | `192.0.2.12` | IP plan |
| `CP_NODE_IP_3` | Control-plane node 3 IP | `192.0.2.13` | IP plan |
| `INFRA_NODE_IP_1` | `infra` node 1 IP | `192.0.2.21` | IP plan |
| `INFRA_NODE_IP_2` | `infra` node 2 IP | `192.0.2.22` | IP plan |
| `INFRA_NODE_IP_3` | `infra` node 3 IP | `192.0.2.23` | IP plan |
| `CP_NUM_CPUS` | vCPUs per control-plane node | `4` | [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters) |
| `CP_MEMORY_MIB` | Memory per control-plane node, MiB | `16384` | Same |
| `CP_SYSTEM_DISK_GIB` | Control-plane system disk, GiB | `300` | At least the template's system disk; `300` is the product's baseline example |
| `CP_VAR_CPAAS_SIZE_GIB` | Control-plane `/var/cpaas` (persistent), GiB | `100` | Product minimum 100 |
| `CP_VAR_LIB_KUBELET_SIZE_GIB` | Control-plane `/var/lib/kubelet` (ephemeral), GiB | `100` | Product minimum 100 |
| `CP_VAR_LIB_CONTAINERD_SIZE_GIB` | Control-plane `/var/lib/containerd` (ephemeral), GiB | `100` | Product minimum 100 |
| `CP_VAR_LIB_ETCD_SIZE_GIB` | Control-plane `/var/lib/etcd` (ephemeral), GiB | `20` | Product minimum 20 |
| `INFRA_NUM_CPUS` | vCPUs per `infra` node | `8` | [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters) |
| `INFRA_MEMORY_MIB` | Memory per `infra` node, MiB | `32768` | Same |
| `INFRA_SYSTEM_DISK_GIB` | `infra` system disk, GiB | `300` | At least the template's system disk; `300` is the product's baseline example |
| `INFRA_VAR_CPAAS_SIZE_GIB` | `infra` `/var/cpaas` (persistent), GiB | `100` | Product minimum 100, plus the log and monitoring data from [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters) |
| `INFRA_VAR_LIB_KUBELET_SIZE_GIB` | `infra` `/var/lib/kubelet` (ephemeral), GiB | `100` | Product minimum 100 |
| `INFRA_VAR_LIB_CONTAINERD_SIZE_GIB` | `infra` `/var/lib/containerd` (ephemeral), GiB | `100` | Product minimum 100 |
| `LOG_NODE_IP_1` | Dedicated-pool variant only: `log` node 1 IP (one variable per slot, like `INFRA_NODE_IP_<n>`) | `192.0.2.41` | IP plan |
| `LOG_NUM_CPUS` | Dedicated-pool variant only: vCPUs per `log` node | `8` | Size the clusters |
| `LOG_MEMORY_MIB` | Dedicated-pool variant only: memory per `log` node, MiB | `32768` | Size the clusters |
| `LOG_VAR_CPAAS_SIZE_GIB` | Dedicated-pool variant only: `log` `/var/cpaas`, GiB | `100` | Size the clusters |

Values that never go into a file — typed at a prompt when a command needs them (the platform token `ACP_TOKEN` is defined in the common article):

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `VSPHERE_USERNAME` | vCenter account used by the provider and the CPI | `svc-capv@vsphere.example.com` | vSphere administrator |
| `VSPHERE_PASSWORD` | Its password | (typed) | vSphere administrator |

Append the vSphere variables to the workload cluster file, after the common values:

```bash
# wl-prod.env (continued) — VMware vSphere variables of workload cluster wl-prod
CONTROL_PLANE_VRID='51'
VSPHERE_SERVER='vcenter.example.com'
VSPHERE_THUMBPRINT='00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33'
VSPHERE_DATACENTER='dc-a'
VSPHERE_DATASTORE='datastore-a'
VSPHERE_FOLDER='/dc-a/vm/wl-prod'
VSPHERE_NETWORK='pg-wl-prod'
VSPHERE_TEMPLATE='alauda-os-4.4.0'
VSPHERE_CPI_IMAGE_TAG='v1.33.1-alauda.1'
CLUSTER_REGISTRY_ADDRESS='acp.example.com:11443'
IMAGE_REGISTRY_ADDRESS='acp.example.com:11443'
KUBE_OVN_VERSION='v4.4.6'
DNS_IMAGE_TAG='1.14.3-v4.4.6'
ETCD_IMAGE_TAG='v3.6.13-acp.0'
NODE_PREFIX='24'
NODE_GATEWAY='192.0.2.1'
NODE_DNS='203.0.113.53'
CP_NODE_IP_1='192.0.2.11'
CP_NODE_IP_2='192.0.2.12'
CP_NODE_IP_3='192.0.2.13'
INFRA_NODE_IP_1='192.0.2.21'
INFRA_NODE_IP_2='192.0.2.22'
INFRA_NODE_IP_3='192.0.2.23'
CP_NUM_CPUS='4'
CP_MEMORY_MIB='16384'
CP_SYSTEM_DISK_GIB='300'
CP_VAR_CPAAS_SIZE_GIB='100'
CP_VAR_LIB_KUBELET_SIZE_GIB='100'
CP_VAR_LIB_CONTAINERD_SIZE_GIB='100'
CP_VAR_LIB_ETCD_SIZE_GIB='20'
INFRA_NUM_CPUS='8'
INFRA_MEMORY_MIB='32768'
INFRA_SYSTEM_DISK_GIB='300'
INFRA_VAR_CPAAS_SIZE_GIB='100'
INFRA_VAR_LIB_KUBELET_SIZE_GIB='100'
INFRA_VAR_LIB_CONTAINERD_SIZE_GIB='100'
```

Commands in this article that are not `apply_rendered` calls use the parameters directly; run them in
the delivery directory after `load_env wl-prod.env`.

### Prepare VMware vSphere

#### Collect the vCenter facts

Query vCenter read-only and have the vSphere administrator confirm each selection — a discovered object
is a candidate, not a decision.

```bash
# on a workstation where govc is already authenticated
govc find / -type d    # datacenters      -> VSPHERE_DATACENTER
govc find / -type n    # port groups      -> VSPHERE_NETWORK
govc find / -type s    # datastores       -> VSPHERE_DATASTORE
govc find / -type m    # VMs and templates -> VSPHERE_TEMPLATE (confirm it is a template)
govc find / -type c    # compute clusters  (failure-domain variant only)
govc find / -type p    # resource pools    (failure-domain variant only)

# vCenter certificate fingerprint -> VSPHERE_THUMBPRINT
openssl s_client -connect "${VSPHERE_SERVER}:443" -servername "${VSPHERE_SERVER}" </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha1
```

Also settle with the vSphere administrator:

- **The vCenter account** (`VSPHERE_USERNAME`) can clone the template and create and manage VMs in the
  folder, datastore and port group above, and holds **Global → Manage custom attributes** and
  **Global → Set custom attribute** — the provider needs both whenever a `vsphere.cluster.x-k8s.io/*`
  annotation is present, and a missing privilege fails VM reconciliation instead of being skipped. See
  [VMware vSphere Provider Installation](https://docs.alauda.io/immutable-infra/1.0/install/vmware-vsphere.html#prerequisites).
- **The VM folder** `VSPHERE_FOLDER` exists; one folder per cluster shows in vCenter which VMs belong to it.
- **The port group** lets VRRP and gratuitous ARP through for the Self-built VIP (dvPortGroup security
  policy, NSX-T distributed firewall), and the node IPs, `CONTROL_PLANE_VIP` and the MetalLB pool
  `INGRESS_VIP_RANGE` (with `INGRESS_VIP`) are reserved in its subnet.
- **The datastore** has room for every slot's disks: system disk, `/var/cpaas` and the ephemeral disks.
  Persistent disks of a deleted cluster stay on the datastore until provider-managed reclaim finishes.

#### Prepare the VM template

**Import the OVA.** Download the Alauda OS **OVA** for the delivered ACP 4.4 release from the OS download
page in Customer Portal
([image format by provider](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html#image-format-by-provider))
and import it as a template named `VSPHERE_TEMPLATE` in `VSPHERE_DATACENTER` — in every datacenter when
failure domains are used, because the name must resolve in each.

**Check what it contains.** The template must carry `cloud-init`, VMware Tools or `open-vm-tools`,
`containerd`, the kubeadm baseline components and the preloaded image tar files under `/root/images/`:
static IPs and hostnames depend on `cloud-init`, node IP reporting on the guest tools, and an air-gapped
bootstrap on the preloaded images. For the Self-built VIP, the `ip_vs` module family must be loadable.

**Validate the preloaded images on a disposable VM** cloned from the template. Run inside that VM:

```bash
# inside a disposable VM cloned from VSPHERE_TEMPLATE
sudo bash -euo pipefail <<'EOF'
shopt -s nullglob
image_files=(/root/images/*.tar)
if (( ${#image_files[@]} == 0 )); then
  echo "ERROR: no tar files found in /root/images" >&2
  exit 1
fi
systemctl restart containerd
for image_file in "${image_files[@]}"; do
  ctr -n k8s.io images import "${image_file}"
done
ctr -n k8s.io images list -q | sort -u
EOF

sudo grep -nE '^[[:space:]]*(sandbox_image|sandbox)[[:space:]]*=' /etc/containerd/config.toml
```

The list must contain kube-apiserver, kube-controller-manager, kube-scheduler and etcd under exactly the
references kubeadm will ask for — `IMAGE_REGISTRY_ADDRESS` + `/tkestack`, with the tags derived from
`K8S_VERSION` and `ETCD_IMAGE_TAG` — and the sandbox image exactly as `containerd` is configured. A
missing or different reference makes the node pull that image from `IMAGE_REGISTRY_ADDRESS` instead; in
an air-gapped site, confirm that the registry serves it under that exact reference, or correct the
template, before you continue. Discard the VM afterwards; never convert it back into the template. Repeat
the check whenever the template, `K8S_VERSION`, `IMAGE_REGISTRY_ADDRESS` or `ETCD_IMAGE_TAG` changes. See
[Validate the locally preloaded images](https://docs.alauda.io/immutable-infra/1.0/infrastructure/vmware-vsphere.html#validate-the-locally-preloaded-images).

#### Approve the network flows

| From | To | Port | Why |
| --- | --- | --- | --- |
| `global` nodes | vCenter (`VSPHERE_SERVER`) | TCP `443` | The provider clones and manages the VMs |
| Workload nodes | vCenter (`VSPHERE_SERVER`) | TCP `443` | The vSphere CPI runs on the workload nodes (`port = "443"` in its configuration) |
| `global` | Workload control-plane nodes and `CONTROL_PLANE_VIP` | TCP `6443`, `11780` | Management of the workload cluster — see [Connecting `global` Cluster and Workload Cluster](https://docs.alauda.io/container_platform/4.4/configure/clusters/on-premises.html#connecting-global-cluster-and-workload-cluster) |
| Workload nodes | `global` registry (`CLUSTER_REGISTRY_ADDRESS`) and platform address (`PLATFORM_HOST`) | TCP `11443`, `443` | Platform images, plugins and platform access |
| Workload control-plane nodes | Each other | VRRP (IP protocol `112`), gratuitous ARP | Self-built VIP |
| Workload nodes | Customer DNS and NTP | `53`, `123` | Name resolution and time — see [Configure machines](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines) |

These flows add to the ones in
[Reference design](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#reference-design).
On Alauda OS nodes the platform maintains the node port configuration, so the approvals above concern
firewalls between networks. For anything not listed, use the
[Communication Matrix](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html#not_covered)
of ACP 4.4 and the pages it points to — do not copy its tables into the change request.

#### Prepare the `global` cluster

Workload cluster objects are created on `global` in `cpaas-system`, and the vSphere provider there does
the work. A `global` cluster on DCS, HCS or Bare Metal does not carry the vSphere provider until you
install it.

**1. Check the providers.**

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get minfo -l cpaas.io/module-name=cluster-api-provider-vsphere
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get minfo -l cpaas.io/module-name=cluster-api-provider-kubeadm
```

Both must exist and be `Running`. If the vSphere provider is missing, download
**Alauda Container Platform VMware vSphere Infrastructure Provider** (`v1.0.17`) — and
**Alauda Container Platform Kubeadm Provider** only if it is missing too — from Customer Portal into
`packages/vsphere-provider/`, push that directory with `violet` (the account needs the
`platform-admin-system` role), and install the plugins on `global` from **Administrator** >
**Marketplace** > **Cluster Plugins** (or with a `ModuleInfo`, see
[Installing via YAML](https://docs.alauda.io/container_platform/4.4/extend/cluster_plugin.html#installing-via-yaml)).
The vSphere provider package also carries the CPI image.

```bash
# on the delivery host — primary global, while the platform domain points at it
load_env wl-prod.env
read -rsp 'Platform API token: ' ACP_TOKEN; echo
violet push packages/vsphere-provider --platform-address "https://${PLATFORM_HOST}" --platform-token "${ACP_TOKEN}"
unset ACP_TOKEN
```

**2. Verify the provider installation** — nine `vsphere*` CRDs and the admission webhooks.

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get crd | grep -E '^vsphere[a-z]+\.infrastructure\.cluster\.x-k8s\.io\b'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get validatingwebhookconfiguration \
  -o jsonpath='{range .items[*]}{range .webhooks[*]}{.name}{"\n"}{end}{end}' \
  | grep -E 'vsphere|capv'
```

Expect `validation.kubeadmcontrolplane.capv.cluster.x-k8s.io` and
`validation.machinedeployment.capv.cluster.x-k8s.io` among the five webhooks: they reject a wrong rollout
setting up front. Without them a wrong value is not rejected — the rollout just stalls for want of a free
slot. See
[Verify the installation](https://docs.alauda.io/immutable-infra/1.0/install/vmware-vsphere.html#verify-the-installation).

**3. Check the management controller, registry and DR role.**

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret public-registry-credential -o name
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cluster global \
  -o jsonpath='{.metadata.annotations.cpaas\.io/registry-address}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n kube-public get configmap etcd-sync -o name 2>/dev/null || echo "not standby"

curl -sk "https://${CLUSTER_REGISTRY_ADDRESS}/v2/acp/chart-kube-ovn/tags/list"
curl -sk "https://${IMAGE_REGISTRY_ADDRESS}/v2/acp/coredns/tags/list"
curl -sk "https://${IMAGE_REGISTRY_ADDRESS}/v2/ait/cloud-provider-vsphere/tags/list"
```

Pass criteria:

- The controller arguments contain `ClusterResourceSet=true` — without it the CPI is never delivered.
- They also contain `--additional-sync-machine-labels` covering `node-role.kubernetes.io/`. Pool labels
  reach the Node only through it; without it every plugin `nodeSelector` stays `Pending`, which looks
  exactly like a wrong label. If it is missing, enable it now as described under *Enable label
  synchronization* in
  [Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)
  (product reference:
  [Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)) —
  the Node label check in step 6 of [Apply and verify](#apply-and-verify) depends on it.
- `public-registry-credential` exists (its content is not printed) and the registry annotation equals
  `CLUSTER_REGISTRY_ADDRESS` — the workload cluster inherits this registry. A dedicated registry per
  workload cluster is decided now or never; see
  [Choose the Image Registry for a Workload Cluster](https://docs.alauda.io/immutable-infra/1.0/how-to/workload-cluster-image-registry.html).
- `not standby` is printed. On a disaster-recovery standby the provider skips every object that does not
  belong to `global`, so a creation there looks stalled rather than failed. Create workload clusters on
  the active `global` only.
- The tag lists contain `KUBE_OVN_VERSION`, `DNS_IMAGE_TAG` and `VSPHERE_CPI_IMAGE_TAG`. A `NAME_UNKNOWN`
  answer means a wrong repository name, not a missing tag. An authenticated registry answers
  `UNAUTHORIZED`; repeat with `-u <registry user>` and let `curl` prompt for the password.

**4. Check the `alive` plugin** that the Self-built VIP depends on.

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get clustermodule global -o jsonpath='{.spec.version}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleplugin alive -o jsonpath='{.status.targetClusterVersions}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleplugin alive -o jsonpath='{.status.latestVersion}{"\n"}'
```

Take the `alive` version from the `targetClusterVersions` entry of the printed `ClusterModule` version
(`latestVersion` only when there is no entry), then
`kubectl get moduleconfig alive-<that version> -o jsonpath='{.status.readyForDeploy}{"\n"}'` must print
`true`. If the plugin is absent or not ready, the Self-built VIP cannot be installed: obtain the matching
plugin package from Alauda support, or use the external load balancer variant. See
[Self-built VIP prerequisites](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#self-built-vip-prerequisites).

**5. With a `global` DR pair**, install the same provider version on the standby too, so that the standby
can manage the vSphere workload clusters after a failover. Each side has its own registry: push
`packages/vsphere-provider` to the standby through its own VIP and registry, exactly as
[Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)
uploads `packages/plugins` there (see also
[Upload an Operator to a Standby Global Cluster](https://docs.alauda.io/container_platform/4.4/extend/upload_package.html#upload-an-operator-to-a-standby-global-cluster)).
While `etcd-sync` runs on the standby, its provider leaves the workload clusters alone (see
[Standby Management Clusters](https://docs.alauda.io/immutable-infra/1.0/install/vmware-vsphere.html#standby-management-cluster)).
After a failover, confirm on the new active side that the three Secrets of every vSphere workload
cluster ([Create the credential Secrets](#create-the-credential-secrets)) exist before any node of that
cluster is replaced: the provider cannot reach vCenter without the first, and a new control-plane node
cannot bootstrap without the third.

#### Create the credential Secrets

Three Secrets per workload cluster, all in `cpaas-system` on `global`, all created with `kubectl create`.
The values are typed at a prompt and passed through bash process substitution, so they reach neither a
file, the shell history nor the process list.

```bash
# on global, in bash with the parameter files loaded
: "${CLUSTER_NAME:?load the parameter files first}" "${VSPHERE_SERVER:?load the parameter files first}"
read -rp  'vCenter username: ' VSPHERE_USERNAME
read -rsp 'vCenter password: ' VSPHERE_PASSWORD; echo

# 1. Identity referenced by VSphereCluster.spec.identityRef
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system create secret generic "${CLUSTER_NAME}-vsphere-credentials" \
  --from-file=username=<(printf '%s' "${VSPHERE_USERNAME}") \
  --from-file=password=<(printf '%s' "${VSPHERE_PASSWORD}")

# 2. CPI credential, delivered into the workload cluster by the ClusterResourceSet
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system create secret generic "${CLUSTER_NAME}-vsphere-cpi-secret" \
  --type=addons.cluster.x-k8s.io/resource-set \
  --from-file=data=<(printf '%s\n' \
    'apiVersion: v1' \
    'kind: Secret' \
    'metadata:' \
    '  name: vsphere-cloud-secret' \
    '  namespace: kube-system' \
    'type: Opaque' \
    'data:' \
    "  ${VSPHERE_SERVER}.username: $(printf '%s' "${VSPHERE_USERNAME}" | base64 | tr -d '\n')" \
    "  ${VSPHERE_SERVER}.password: $(printf '%s' "${VSPHERE_PASSWORD}" | base64 | tr -d '\n')")

unset VSPHERE_USERNAME VSPHERE_PASSWORD

# 3. Encryption-at-rest configuration, generated once; the key exists only in this Secret
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system create secret generic "${CLUSTER_NAME}-encryption-provider-config" \
  --from-file=encryption-provider.conf=<(printf '%s\n' \
    'apiVersion: apiserver.config.k8s.io/v1' \
    'kind: EncryptionConfiguration' \
    'resources:' \
    '- resources:' \
    '  - secrets' \
    '  providers:' \
    '  - aescbc:' \
    '      keys:' \
    '      - name: key1' \
    "        secret: $(head -c 32 /dev/urandom | base64 | tr -d '\n')")
```

- The CPI payload uses base64 `data` rather than the product example's `stringData`, so a password
  containing YAML-significant characters (`:`, `#`, quotes, a leading `*`) cannot break it. The Secret's
  only key must be `data`.
- If a command reports `AlreadyExists`, keep the existing Secret. Never delete or recreate the
  encryption Secret while the cluster exists: every new control-plane node reads it, and a new key
  cannot decrypt the data already in etcd.

### Create a workload cluster

All objects are created on `global`; the workload cluster's own kubeconfig is used only for checks. Each
file is applied on its own with `apply_rendered` from
[Prepare the parameter files](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files),
which refuses an unreplaced `${...}` and lets the server-side admission webhooks judge the file before it
is applied — a client-side dry run contacts no server and would not catch, for example, an out-of-range
`vrid`. **Never apply the directory at once**: each step's check is what catches a wrong value while it
is still cheap to fix. Templates and their controllers are separate files so that the controller's
server-side check finds the template it references. There is no namespace manifest: the objects go to
`cpaas-system`, which always exists on `global`.

```text
wl-prod/
├── 10-cluster.yaml                 # Cluster + VSphereCluster (Self-built VIP)
├── 15-vsphere-cpi.yaml             # CPI ConfigMaps + ClusterResourceSet
├── 20-control-plane-pool.yaml      # VSphereMachineConfigPool, 3 control-plane slots
├── 21-control-plane-template.yaml  # VSphereMachineTemplate
├── 22-control-plane.yaml           # KubeadmControlPlane
├── 30-infra-pool.yaml              # VSphereMachineConfigPool, infra slots
├── 31-infra-templates.yaml         # VSphereMachineTemplate + KubeadmConfigTemplate
└── 32-infra.yaml                   # MachineDeployment
```

#### Check before applying

These are the mistakes that otherwise surface as half-provisioned machines or a cluster that has to be
rebuilt:

- `CLUSTER_NAME` is not `global` and does not start with `global-` (both are reserved for the `global`
  cluster's DR workflow, which selects resources by that prefix), is a valid DNS-1123 label, and is short
  enough that `<cluster>-infra-3` still is one.
- Pod, Service and Join CIDRs overlap neither each other nor the node subnet, the VIPs, the vCenter
  networks, `global`'s CIDRs, other workload clusters' CIDRs or customer networks — nothing checks this
  at creation.
- `CONTROL_PLANE_VIP` is an unused IPv4 address in the node subnet and not one of the slot IPs;
  `CONTROL_PLANE_VRID` is unused on the segment.
- Every slot IP is unused, and every hostname is unused in the vCenter.
- `CP_SYSTEM_DISK_GIB` and `INFRA_SYSTEM_DISK_GIB` are at least the template's system disk.
- The three Secrets exist — the command prints names only, never contents.
- No existing `ClusterResourceSet` selects on `addons.cluster.x-k8s.io/vsphere-cpi` without also
  selecting its own `cluster.x-k8s.io/cluster-name`. Such a set — one created with the product's
  example selector — also binds to the new cluster and pushes another cluster's CPI configuration and
  vCenter credential into it. Resolve it with the platform team before step 1.

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret "${CLUSTER_NAME}-vsphere-credentials" \
  "${CLUSTER_NAME}-vsphere-cpi-secret" "${CLUSTER_NAME}-encryption-provider-config" -o name
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get clusterresourceset \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.clusterSelector.matchLabels}{"\n"}{end}'
```

#### Manifests

`wl-prod/10-cluster.yaml` — the cluster root and the vCenter connection. The `Cluster` annotations are
read by platform controllers, which install Kube-OVN and bind the registry; the registry binding is read
once, at creation.

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
  labels:
    cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
    cluster-type: VSphere
    addons.cluster.x-k8s.io/vsphere-cpi: "enabled"
  annotations:
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: VSphereCluster
    cpaas.io/sentry-deploy-type: Baremetal
    cpaas.io/alb-address-type: ClusterAddress
    cpaas.io/network-type: kube-ovn
    cpaas.io/kube-ovn-version: ${KUBE_OVN_VERSION}
    cpaas.io/kube-ovn-join-cidr: ${KUBE_OVN_JOIN_CIDR}
    cpaas.io/registry-address: ${CLUSTER_REGISTRY_ADDRESS}
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
    name: ${CLUSTER_NAME}-kcp
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: VSphereCluster
    name: ${CLUSTER_NAME}
---
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
spec:
  controlPlaneEndpoint:
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
  controlPlaneLoadBalancer:          # write-once: decided at creation, never changed
    type: internal
    host: "${CONTROL_PLANE_VIP}"     # must equal controlPlaneEndpoint.host
    port: 6443                       # must equal controlPlaneEndpoint.port
    vrid: ${CONTROL_PLANE_VRID}
  identityRef:
    kind: Secret
    name: ${CLUSTER_NAME}-vsphere-credentials
  server: "${VSPHERE_SERVER}"
  thumbprint: "${VSPHERE_THUMBPRINT}"
```

`wl-prod/15-vsphere-cpi.yaml` — the CPI configuration and manifests, delivered by a `ClusterResourceSet`
that matches this cluster only. `insecure-flag = "1"` lets the CPI connect when the nodes do not trust the
vCenter certificate. Add a `[Labels]` block only together with failure domains.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${CLUSTER_NAME}-vsphere-cpi-config
  namespace: cpaas-system
data:
  data: |
    apiVersion: v1
    kind: ConfigMap
    metadata:
      name: cloud-config
      namespace: kube-system
    data:
      vsphere.conf: |
        [Global]
        secret-name = "vsphere-cloud-secret"
        secret-namespace = "kube-system"
        service-account = "cloud-controller-manager"
        port = "443"
        insecure-flag = "1"
        datacenters = "${VSPHERE_DATACENTER}"

        [VirtualCenter "${VSPHERE_SERVER}"]
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${CLUSTER_NAME}-vsphere-cpi-manifests
  namespace: cpaas-system
data:
  data: |
    apiVersion: v1
    kind: ServiceAccount
    metadata:
      name: cloud-controller-manager
      namespace: kube-system
    automountServiceAccountToken: false
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: ClusterRole
    metadata:
      name: system:cloud-controller-manager
    rules:
    - apiGroups: [""]
      resources: ["events"]
      verbs: ["create", "patch", "update"]
    - apiGroups: [""]
      resources: ["nodes"]
      verbs: ["*"]
    - apiGroups: [""]
      resources: ["nodes/status"]
      verbs: ["patch"]
    - apiGroups: [""]
      resources: ["services"]
      verbs: ["list", "patch", "update", "watch"]
    - apiGroups: [""]
      resources: ["services/status"]
      verbs: ["patch"]
    - apiGroups: [""]
      resources: ["serviceaccounts"]
      verbs: ["create", "get", "list", "watch", "update"]
    - apiGroups: [""]
      resources: ["persistentvolumes"]
      verbs: ["get", "list", "update", "watch"]
    - apiGroups: [""]
      resources: ["endpoints"]
      verbs: ["create", "get", "list", "watch", "update"]
    - apiGroups: [""]
      resources: ["secrets"]
      verbs: ["get", "list", "watch"]
    - apiGroups: ["coordination.k8s.io"]
      resources: ["leases"]
      verbs: ["get", "list", "watch", "create", "update"]
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: RoleBinding
    metadata:
      name: servicecatalog.k8s.io:apiserver-authentication-reader
      namespace: kube-system
    roleRef:
      apiGroup: rbac.authorization.k8s.io
      kind: Role
      name: extension-apiserver-authentication-reader
    subjects:
    - apiGroup: ""
      kind: ServiceAccount
      name: cloud-controller-manager
      namespace: kube-system
    - apiGroup: ""
      kind: User
      name: cloud-controller-manager
    ---
    apiVersion: rbac.authorization.k8s.io/v1
    kind: ClusterRoleBinding
    metadata:
      name: system:cloud-controller-manager
    roleRef:
      apiGroup: rbac.authorization.k8s.io
      kind: ClusterRole
      name: system:cloud-controller-manager
    subjects:
    - kind: ServiceAccount
      name: cloud-controller-manager
      namespace: kube-system
    - kind: User
      name: cloud-controller-manager
    ---
    apiVersion: apps/v1
    kind: DaemonSet
    metadata:
      annotations:
        scheduler.alpha.kubernetes.io/critical-pod: ""
      labels:
        component: cloud-controller-manager
        tier: control-plane
        k8s-app: vsphere-cloud-controller-manager
      name: vsphere-cloud-controller-manager
      namespace: kube-system
    spec:
      selector:
        matchLabels:
          k8s-app: vsphere-cloud-controller-manager
      updateStrategy:
        type: RollingUpdate
      template:
        metadata:
          labels:
            component: cloud-controller-manager
            k8s-app: vsphere-cloud-controller-manager
        spec:
          securityContext:
            runAsUser: 1001
          automountServiceAccountToken: true
          # The platform syncs "global-registry-auth" into the workload cluster when the
          # global registry is authenticated (public-registry-credential). Remove these
          # two lines when the registry allows anonymous pulls.
          imagePullSecrets:
          - name: global-registry-auth
          serviceAccountName: cloud-controller-manager
          hostNetwork: true
          tolerations:
          - operator: Exists
          - key: node.cloudprovider.kubernetes.io/uninitialized
            value: "true"
            effect: NoSchedule
          - key: node-role.kubernetes.io/master
            effect: NoSchedule
          - key: node.kubernetes.io/not-ready
            effect: NoSchedule
            operator: Exists
          containers:
          - name: vsphere-cloud-controller-manager
            image: ${IMAGE_REGISTRY_ADDRESS}/ait/cloud-provider-vsphere:${VSPHERE_CPI_IMAGE_TAG}
            args:
            - --v=2
            - --cloud-provider=vsphere
            - --cloud-config=/etc/cloud/vsphere.conf
            volumeMounts:
            - mountPath: /etc/cloud
              name: vsphere-config-volume
              readOnly: true
            resources:
              requests:
                cpu: 200m
          volumes:
          - name: vsphere-config-volume
            configMap:
              name: cloud-config
    ---
    apiVersion: v1
    kind: Service
    metadata:
      labels:
        component: cloud-controller-manager
      name: vsphere-cloud-controller-manager
      namespace: kube-system
    spec:
      type: NodePort
      ports:
      - port: 43001
        protocol: TCP
        targetPort: 43001
      selector:
        component: cloud-controller-manager
---
apiVersion: addons.cluster.x-k8s.io/v1beta1
kind: ClusterResourceSet
metadata:
  name: ${CLUSTER_NAME}-vsphere-cpi
  namespace: cpaas-system
spec:
  strategy: Reconcile
  clusterSelector:
    matchLabels:
      addons.cluster.x-k8s.io/vsphere-cpi: "enabled"
      cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}   # this cluster only
  resources:
  - name: ${CLUSTER_NAME}-vsphere-cpi-config
    kind: ConfigMap
  - name: ${CLUSTER_NAME}-vsphere-cpi-secret
    kind: Secret
  - name: ${CLUSTER_NAME}-vsphere-cpi-manifests
    kind: ConfigMap
```

`wl-prod/20-control-plane-pool.yaml` — three control-plane slots. `releaseDelayHours` is the reclaim grace
period of an unused released slot, not a delay before reuse; a replacement in the same pool reuses a
released slot immediately.

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereMachineConfigPool
metadata:
  name: ${CLUSTER_NAME}-cp-pool
  namespace: cpaas-system
spec:
  clusterRef:
    apiVersion: cluster.x-k8s.io/v1beta1
    kind: Cluster
    name: ${CLUSTER_NAME}
  datacenter: "${VSPHERE_DATACENTER}"
  releaseDelayHours: 24
  configs:
  - hostname: "${CLUSTER_NAME}-cp-1"
    datacenter: "${VSPHERE_DATACENTER}"
    network:
      primary:
        networkName: "${VSPHERE_NETWORK}"
        ip: "${CP_NODE_IP_1}/${NODE_PREFIX}"
        gateway: "${NODE_GATEWAY}"
        dns:
        - "${NODE_DNS}"
    persistentDisks:
    - name: var-cpaas
      sizeGiB: ${CP_VAR_CPAAS_SIZE_GIB}
      mountPath: /var/cpaas
      fsFormat: ext4
    ephemeralDisks:
    - name: var-lib-kubelet
      sizeGiB: ${CP_VAR_LIB_KUBELET_SIZE_GIB}
      mountPath: /var/lib/kubelet
      fsFormat: ext4
    - name: var-lib-containerd
      sizeGiB: ${CP_VAR_LIB_CONTAINERD_SIZE_GIB}
      mountPath: /var/lib/containerd
      fsFormat: ext4
    - name: var-lib-etcd
      sizeGiB: ${CP_VAR_LIB_ETCD_SIZE_GIB}
      mountPath: /var/lib/etcd
      fsFormat: ext4
  - hostname: "${CLUSTER_NAME}-cp-2"
    datacenter: "${VSPHERE_DATACENTER}"
    network:
      primary:
        networkName: "${VSPHERE_NETWORK}"
        ip: "${CP_NODE_IP_2}/${NODE_PREFIX}"
        gateway: "${NODE_GATEWAY}"
        dns:
        - "${NODE_DNS}"
    persistentDisks:
    - name: var-cpaas
      sizeGiB: ${CP_VAR_CPAAS_SIZE_GIB}
      mountPath: /var/cpaas
      fsFormat: ext4
    ephemeralDisks:
    - name: var-lib-kubelet
      sizeGiB: ${CP_VAR_LIB_KUBELET_SIZE_GIB}
      mountPath: /var/lib/kubelet
      fsFormat: ext4
    - name: var-lib-containerd
      sizeGiB: ${CP_VAR_LIB_CONTAINERD_SIZE_GIB}
      mountPath: /var/lib/containerd
      fsFormat: ext4
    - name: var-lib-etcd
      sizeGiB: ${CP_VAR_LIB_ETCD_SIZE_GIB}
      mountPath: /var/lib/etcd
      fsFormat: ext4
  - hostname: "${CLUSTER_NAME}-cp-3"
    datacenter: "${VSPHERE_DATACENTER}"
    network:
      primary:
        networkName: "${VSPHERE_NETWORK}"
        ip: "${CP_NODE_IP_3}/${NODE_PREFIX}"
        gateway: "${NODE_GATEWAY}"
        dns:
        - "${NODE_DNS}"
    persistentDisks:
    - name: var-cpaas
      sizeGiB: ${CP_VAR_CPAAS_SIZE_GIB}
      mountPath: /var/cpaas
      fsFormat: ext4
    ephemeralDisks:
    - name: var-lib-kubelet
      sizeGiB: ${CP_VAR_LIB_KUBELET_SIZE_GIB}
      mountPath: /var/lib/kubelet
      fsFormat: ext4
    - name: var-lib-containerd
      sizeGiB: ${CP_VAR_LIB_CONTAINERD_SIZE_GIB}
      mountPath: /var/lib/containerd
      fsFormat: ext4
    - name: var-lib-etcd
      sizeGiB: ${CP_VAR_LIB_ETCD_SIZE_GIB}
      mountPath: /var/lib/etcd
      fsFormat: ext4
```

`wl-prod/21-control-plane-template.yaml` — the control-plane VM. A later change to it is a new template
under a new name, never an edit of this one.

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-control-plane
  namespace: cpaas-system
spec:
  template:
    spec:
      server: "${VSPHERE_SERVER}"
      template: "${VSPHERE_TEMPLATE}"
      cloneMode: fullClone
      folder: "${VSPHERE_FOLDER}"
      datastore: "${VSPHERE_DATASTORE}"
      diskGiB: ${CP_SYSTEM_DISK_GIB}
      memoryMiB: ${CP_MEMORY_MIB}
      numCPUs: ${CP_NUM_CPUS}
      os: Linux
      powerOffMode: trySoft
      network:
        devices:
        - networkName: "${VSPHERE_NETWORK}"
      machineConfigPoolRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: VSphereMachineConfigPool
        name: ${CLUSTER_NAME}-cp-pool
        namespace: cpaas-system
```

`wl-prod/22-control-plane.yaml` — the `KubeadmControlPlane`. `{{ ds.meta_data.hostname }}` and
`{{ local_hostname }}` are cloud-init expressions and the `$` in the image-import script are shell — both
stay literal; `render` substitutes only the parameter-file variables. The encryption configuration comes
from the Secret created earlier.

```yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: ${CLUSTER_NAME}-kcp
  namespace: cpaas-system
spec:
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
  version: "${K8S_VERSION}"
  replicas: 3
  machineTemplate:
    nodeDrainTimeout: 1m
    nodeDeletionTimeout: 5m
    metadata:
      labels:
        node-role.kubernetes.io/control-plane: ""
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: VSphereMachineTemplate
      name: ${CLUSTER_NAME}-control-plane
  kubeadmConfigSpec:
    users:
    - name: boot
      sudo: ALL=(ALL) NOPASSWD:ALL
      sshAuthorizedKeys:
      - "${BOOT_SSH_PUBLIC_KEY}"
    files:
    - path: /etc/resolv.conf
      owner: "root:root"
      append: false
      permissions: "0644"
      content: |
        nameserver ${NODE_DNS}
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
          "streamingConnectionIdleTimeout": "5m",
          "tlsCertFile": "/etc/kubernetes/pki/kubelet.crt",
          "tlsPrivateKeyFile": "/etc/kubernetes/pki/kubelet.key"
        }
    - path: /etc/kubernetes/encryption-provider.conf
      owner: "root:root"
      append: false
      permissions: "0644"
      contentFrom:
        secret:
          name: ${CLUSTER_NAME}-encryption-provider-config
          key: encryption-provider.conf
    - path: /etc/kubernetes/audit/policy.yaml
      owner: "root:root"
      append: false
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
          resources:
          - group: "devops.alauda.io"
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
        - level: None
          resources:
          - group: "app.alauda.io"
            resources: ["imagewhitelists"]
          - group: "k8s.io"
            resources: ["namespaceoverviews"]
        - level: Metadata
          resources:
          - group: ""
            resources: ["secrets", "configmaps"]
        - level: Metadata
          resources:
          - group: "operator.connectors.alauda.io"
            resources: ["installmanifests"]
          - group: "operators.katanomi.dev"
            resources: ["katanomis"]
        - level: RequestResponse
          resources:
          - group: ""
          - group: "aiops.alauda.io"
          - group: "apps"
          - group: "app.k8s.io"
          - group: "authentication.istio.io"
          - group: "auth.alauda.io"
          - group: "autoscaling"
          - group: "asm.alauda.io"
          - group: "clusterregistry.k8s.io"
          - group: "crd.alauda.io"
          - group: "infrastructure.alauda.io"
          - group: "monitoring.coreos.com"
          - group: "operators.coreos.com"
          - group: "networking.istio.io"
          - group: "extensions.istio.io"
          - group: "install.istio.io"
          - group: "security.istio.io"
          - group: "telemetry.istio.io"
          - group: "opentelemetry.io"
          - group: "networking.k8s.io"
          - group: "portal.alauda.io"
          - group: "rbac.authorization.k8s.io"
          - group: "storage.k8s.io"
          - group: "tke.cloud.tencent.com"
          - group: "devopsx.alauda.io"
          - group: "core.katanomi.dev"
          - group: "deliveries.katanomi.dev"
          - group: "integrations.katanomi.dev"
          - group: "artifacts.katanomi.dev"
          - group: "builds.katanomi.dev"
          - group: "versioning.katanomi.dev"
          - group: "sources.katanomi.dev"
          - group: "tekton.dev"
          - group: "operator.tekton.dev"
          - group: "eventing.knative.dev"
          - group: "flows.knative.dev"
          - group: "messaging.knative.dev"
          - group: "operator.knative.dev"
          - group: "sources.knative.dev"
          - group: "operator.devops.alauda.io"
          - group: "flagger.app"
          - group: "jaegertracing.io"
          - group: "velero.io"
            resources: ["deletebackuprequests"]
          - group: "connectors.alauda.io"
          - group: "operator.connectors.alauda.io"
            resources: ["connectorscores", "connectorsgits", "connectorsocis"]
        - level: Metadata
    - path: /usr/local/bin/capv-load-local-images.sh
      owner: "root:root"
      permissions: "0755"
      content: |
        #!/bin/bash
        set -euo pipefail
        until mountpoint -q /var/lib/containerd; do
          echo "waiting for /var/lib/containerd mount"
          sleep 1
        done
        systemctl restart containerd
        until systemctl is-active --quiet containerd; do
          echo "waiting for containerd"
          sleep 1
        done
        if [ ! -d "/root/images" ]; then
          echo "ERROR: /root/images directory not found" >&2
          exit 1
        fi
        image_count=0
        for image_file in /root/images/*.tar; do
          if [ -f "$image_file" ]; then
            echo "importing image: $image_file"
            ctr -n k8s.io images import "$image_file"
            image_count=$((image_count + 1))
          fi
        done
        if [ "$image_count" -eq 0 ]; then
          echo "ERROR: no tar files found in /root/images" >&2
          exit 1
        fi
        echo "imported $image_count images"
    preKubeadmCommands:
    - hostnamectl set-hostname "{{ ds.meta_data.hostname }}"
    - echo "::1         ipv6-localhost ipv6-loopback localhost6 localhost6.localdomain6" >/etc/hosts
    - echo "127.0.0.1   {{ ds.meta_data.hostname }} {{ local_hostname }} localhost localhost.localdomain localhost4 localhost4.localdomain4" >>/etc/hosts
    - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
    - /usr/local/bin/capv-load-local-images.sh
    postKubeadmCommands:
    - chmod 600 /var/lib/kubelet/config.yaml
    clusterConfiguration:
      imageRepository: ${IMAGE_REGISTRY_ADDRESS}/tkestack
      dns:
        imageTag: ${DNS_IMAGE_TAG}
      etcd:
        local:
          imageTag: ${ETCD_IMAGE_TAG}
      apiServer:
        extraArgs:
          admission-control-config-file: /etc/kubernetes/admission/psa-config.yaml
          audit-log-format: json
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "200"
          audit-log-mode: batch
          audit-log-path: /etc/kubernetes/audit/audit.log
          audit-policy-file: /etc/kubernetes/audit/policy.yaml
          encryption-provider-config: /etc/kubernetes/encryption-provider.conf
          kubelet-certificate-authority: /etc/kubernetes/pki/ca.crt
          profiling: "false"
          tls-cipher-suites: TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
          tls-min-version: VersionTLS12
        extraVolumes:
        - hostPath: /etc/kubernetes
          mountPath: /etc/kubernetes
          name: vol-dir-0
          pathType: Directory
      controllerManager:
        extraArgs:
          bind-address: "::"
          cloud-provider: external
          flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          profiling: "false"
          tls-min-version: VersionTLS12
      scheduler:
        extraArgs:
          bind-address: "::"
          profiling: "false"
          tls-min-version: VersionTLS12
    initConfiguration:
      nodeRegistration:
        criSocket: /var/run/containerd/containerd.sock
        ignorePreflightErrors:
        - ImagePull
        kubeletExtraArgs:
          cloud-provider: external
          node-labels: kube-ovn/role=master
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
        name: '{{ local_hostname }}'
      patches:
        directory: /etc/kubernetes/patches
    joinConfiguration:
      nodeRegistration:
        criSocket: /var/run/containerd/containerd.sock
        ignorePreflightErrors:
        - ImagePull
        kubeletExtraArgs:
          cloud-provider: external
          node-labels: kube-ovn/role=master
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
        name: '{{ local_hostname }}'
      patches:
        directory: /etc/kubernetes/patches
```

`wl-prod/30-infra-pool.yaml` — the `infra` slots. The manifest shows three nodes; take the count from
[Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters)
and keep `replicas` in `32-infra.yaml` equal to it.

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereMachineConfigPool
metadata:
  name: ${CLUSTER_NAME}-infra-pool
  namespace: cpaas-system
spec:
  clusterRef:
    apiVersion: cluster.x-k8s.io/v1beta1
    kind: Cluster
    name: ${CLUSTER_NAME}
  datacenter: "${VSPHERE_DATACENTER}"
  releaseDelayHours: 24
  configs:
  - hostname: "${CLUSTER_NAME}-infra-1"
    datacenter: "${VSPHERE_DATACENTER}"
    network:
      primary:
        networkName: "${VSPHERE_NETWORK}"
        ip: "${INFRA_NODE_IP_1}/${NODE_PREFIX}"
        gateway: "${NODE_GATEWAY}"
        dns:
        - "${NODE_DNS}"
    persistentDisks:
    - name: var-cpaas
      sizeGiB: ${INFRA_VAR_CPAAS_SIZE_GIB}
      mountPath: /var/cpaas
      fsFormat: ext4
    ephemeralDisks:
    - name: var-lib-kubelet
      sizeGiB: ${INFRA_VAR_LIB_KUBELET_SIZE_GIB}
      mountPath: /var/lib/kubelet
      fsFormat: ext4
    - name: var-lib-containerd
      sizeGiB: ${INFRA_VAR_LIB_CONTAINERD_SIZE_GIB}
      mountPath: /var/lib/containerd
      fsFormat: ext4
  - hostname: "${CLUSTER_NAME}-infra-2"
    datacenter: "${VSPHERE_DATACENTER}"
    network:
      primary:
        networkName: "${VSPHERE_NETWORK}"
        ip: "${INFRA_NODE_IP_2}/${NODE_PREFIX}"
        gateway: "${NODE_GATEWAY}"
        dns:
        - "${NODE_DNS}"
    persistentDisks:
    - name: var-cpaas
      sizeGiB: ${INFRA_VAR_CPAAS_SIZE_GIB}
      mountPath: /var/cpaas
      fsFormat: ext4
    ephemeralDisks:
    - name: var-lib-kubelet
      sizeGiB: ${INFRA_VAR_LIB_KUBELET_SIZE_GIB}
      mountPath: /var/lib/kubelet
      fsFormat: ext4
    - name: var-lib-containerd
      sizeGiB: ${INFRA_VAR_LIB_CONTAINERD_SIZE_GIB}
      mountPath: /var/lib/containerd
      fsFormat: ext4
  - hostname: "${CLUSTER_NAME}-infra-3"
    datacenter: "${VSPHERE_DATACENTER}"
    network:
      primary:
        networkName: "${VSPHERE_NETWORK}"
        ip: "${INFRA_NODE_IP_3}/${NODE_PREFIX}"
        gateway: "${NODE_GATEWAY}"
        dns:
        - "${NODE_DNS}"
    persistentDisks:
    - name: var-cpaas
      sizeGiB: ${INFRA_VAR_CPAAS_SIZE_GIB}
      mountPath: /var/cpaas
      fsFormat: ext4
    ephemeralDisks:
    - name: var-lib-kubelet
      sizeGiB: ${INFRA_VAR_LIB_KUBELET_SIZE_GIB}
      mountPath: /var/lib/kubelet
      fsFormat: ext4
    - name: var-lib-containerd
      sizeGiB: ${INFRA_VAR_LIB_CONTAINERD_SIZE_GIB}
      mountPath: /var/lib/containerd
      fsFormat: ext4
```

`wl-prod/31-infra-templates.yaml` — the `infra` VM template and bootstrap template.

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: VSphereMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-infra
  namespace: cpaas-system
spec:
  template:
    spec:
      server: "${VSPHERE_SERVER}"
      template: "${VSPHERE_TEMPLATE}"
      cloneMode: fullClone
      folder: "${VSPHERE_FOLDER}"
      datastore: "${VSPHERE_DATASTORE}"
      diskGiB: ${INFRA_SYSTEM_DISK_GIB}
      memoryMiB: ${INFRA_MEMORY_MIB}
      numCPUs: ${INFRA_NUM_CPUS}
      os: Linux
      powerOffMode: trySoft
      network:
        devices:
        - networkName: "${VSPHERE_NETWORK}"
      machineConfigPoolRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: VSphereMachineConfigPool
        name: ${CLUSTER_NAME}-infra-pool
        namespace: cpaas-system
---
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: ${CLUSTER_NAME}-infra-bootstrap
  namespace: cpaas-system
spec:
  template:
    spec:
      files:
      - path: /etc/resolv.conf
        owner: "root:root"
        append: false
        permissions: "0644"
        content: |
          nameserver ${NODE_DNS}
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
            "streamingConnectionIdleTimeout": "5m",
            "tlsCertFile": "/etc/kubernetes/pki/kubelet.crt",
            "tlsPrivateKeyFile": "/etc/kubernetes/pki/kubelet.key"
          }
      - path: /usr/local/bin/capv-load-local-images.sh
        owner: "root:root"
        permissions: "0755"
        content: |
          #!/bin/bash
          set -euo pipefail
          until mountpoint -q /var/lib/containerd; do
            echo "waiting for /var/lib/containerd mount"
            sleep 1
          done
          systemctl restart containerd
          until systemctl is-active --quiet containerd; do
            echo "waiting for containerd"
            sleep 1
          done
          if [ ! -d "/root/images" ]; then
            echo "ERROR: /root/images directory not found" >&2
            exit 1
          fi
          image_count=0
          for image_file in /root/images/*.tar; do
            if [ -f "$image_file" ]; then
              echo "importing image: $image_file"
              ctr -n k8s.io images import "$image_file"
              image_count=$((image_count + 1))
            fi
          done
          if [ "$image_count" -eq 0 ]; then
            echo "ERROR: no tar files found in /root/images" >&2
            exit 1
          fi
          echo "imported $image_count images"
      joinConfiguration:
        nodeRegistration:
          criSocket: /var/run/containerd/containerd.sock
          ignorePreflightErrors:
          - ImagePull
          kubeletExtraArgs:
            cloud-provider: external
            volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          name: '{{ local_hostname }}'
        patches:
          directory: /etc/kubernetes/patches
      preKubeadmCommands:
      - hostnamectl set-hostname "{{ ds.meta_data.hostname }}"
      - echo "::1         ipv6-localhost ipv6-loopback localhost6 localhost6.localdomain6" >/etc/hosts
      - echo "127.0.0.1   {{ ds.meta_data.hostname }} {{ local_hostname }} localhost localhost.localdomain localhost4 localhost4.localdomain4" >>/etc/hosts
      - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
      - /usr/local/bin/capv-load-local-images.sh
      postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
      users:
      - name: boot
        sudo: ALL=(ALL) NOPASSWD:ALL
        sshAuthorizedKeys:
        - "${BOOT_SSH_PUBLIC_KEY}"
```

`wl-prod/32-infra.yaml` — the `infra` `MachineDeployment`. Labels and the taint are declared here, on the
pool, never by hand on nodes: `node-role.kubernetes.io/infra` is what the plugins select and tolerate, and
`node-role.kubernetes.io/worker` is what the default worker MachineConfigPool selects — without it these
nodes silently miss the machine configuration.

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: ${CLUSTER_NAME}-infra
  namespace: cpaas-system
spec:
  clusterName: ${CLUSTER_NAME}
  replicas: 3                        # = number of slots in 30-infra-pool.yaml
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels:
      nodepool: infra
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
        nodepool: infra
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: ${CLUSTER_NAME}
      version: "${K8S_VERSION}"
      taints:
      - key: node-role.kubernetes.io/infra
        value: reserved
        effect: NoSchedule
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: ${CLUSTER_NAME}-infra-bootstrap
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: VSphereMachineTemplate
        name: ${CLUSTER_NAME}-infra
```

#### Apply and verify

Apply the files in order. Each step names its pass criteria; do not start the next step until they hold.

**1. Cluster root.**

```bash
# on global
apply_rendered wl-prod.env wl-prod/10-cluster.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cluster,vspherecluster "${CLUSTER_NAME}"
```

**2. CPI delivery.**

```bash
# on global
apply_rendered wl-prod.env wl-prod/15-vsphere-cpi.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get clusterresourceset "${CLUSTER_NAME}-vsphere-cpi"
```

**3. Control-plane slots.**

```bash
# on global
apply_rendered wl-prod.env wl-prod/20-control-plane-pool.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool "${CLUSTER_NAME}-cp-pool"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool "${CLUSTER_NAME}-cp-pool" \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} ({.reason}){"\n"}{end}'
```

Pass: `TOTAL` is `3`; `ClusterRefReady`, `VCenterAvailable`, `MembersValid`, `MembersUnique` and `Ready`
are `True`. `VCenterAvailable=False` means the identity Secret, the thumbprint or the reachability of
vCenter from `global` is wrong — fix it now, before any VM exists.

**4. Control plane.**

```bash
# on global
apply_rendered wl-prod.env wl-prod/21-control-plane-template.yaml "${GLOBAL_KUBECONFIG}"
apply_rendered wl-prod.env wl-prod/22-control-plane.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane "${CLUSTER_NAME}-kcp"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machine \
  -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}" -w
```

The three control-plane Machines come up one after the other. If one stalls, stop the watch (`-w`
accepts a single resource type) and read its infrastructure objects:
`kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachine,vspherevm -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}"`.
While the Machines come up, confirm the new cluster's
own `ClusterModule` version as soon as it exists
(`kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get clustermodule "${CLUSTER_NAME}"`) and, if it differs
from `global`'s, repeat the `alive` readiness check for the version it resolves to: the VIP mode can no
longer be changed once the control plane has bootstrapped.

When the `KubeadmControlPlane` reports three ready replicas, fetch the workload kubeconfig as the
[kubeconfig convention](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files)
describes, then check the endpoint, the CPI and the nodes:

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspherecluster "${CLUSTER_NAME}" \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} ({.reason}){"\n"}{end}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get clusterresourcesetbinding "${CLUSTER_NAME}"
(umask 077; kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret "${CLUSTER_NAME}-kubeconfig" \
  -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}")

# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get --raw=/version
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n kube-system get pods -l app=alive -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get apprelease alive
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n kube-system get daemonset vsphere-cloud-controller-manager
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerID}{"\n"}{end}'
```

Pass:

- `SelfBuiltLoadBalancerReady=True` and `KubeOvnAppReleaseReady=True` on the `VSphereCluster`. Neither
  gates `VSphereCluster` readiness, so the infrastructure can report ready while the VIP still converges —
  read the conditions, not only `READY`.
- `/version` answers through the VIP **with** TLS verification (the kubeconfig carries the cluster CA);
  one `alive` Pod per control-plane node; the `alive` `AppRelease` is healthy.
- The CPI DaemonSet is ready on every node, and every node has a `vsphere://` `providerID`. A node
  without one usually means a duplicate guest hostname in the vCenter or a CPI that never got its
  configuration — see the product
  [Troubleshooting](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#troubleshooting).
- Three nodes are `Ready`, named `<cluster>-cp-<n>`, with `INTERNAL-IP` equal to their slot IPs.

**5. `infra` slots** — same pass criteria as step 3, for `${CLUSTER_NAME}-infra-pool`.

```bash
# on global
apply_rendered wl-prod.env wl-prod/30-infra-pool.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool "${CLUSTER_NAME}-infra-pool"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool "${CLUSTER_NAME}-infra-pool" \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} ({.reason}){"\n"}{end}'
```

**6. `infra` pool.**

```bash
# on global
apply_rendered wl-prod.env wl-prod/31-infra-templates.yaml "${GLOBAL_KUBECONFIG}"
apply_rendered wl-prod.env wl-prod/32-infra.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machinedeployment "${CLUSTER_NAME}-infra" -w
```

When the `MachineDeployment` reports three ready replicas, stop the watch and check the nodes and disks:

```bash
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -l node-role.kubernetes.io/infra -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'

# on global — persistent disks of both pools
for pool in cp-pool infra-pool; do
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool "${CLUSTER_NAME}-${pool}" \
    -o jsonpath='{range .status.persistentDiskStatuses[*]}{.hostname}{" "}{.name}{" "}{.phase}{"\n"}{end}'
done
```

Pass: the `MachineDeployment` has three ready replicas; the `infra` nodes are `Ready`, carry the
`node-role.kubernetes.io/infra` and `node-role.kubernetes.io/worker` labels **on the Node** (not only on
the Machine — a label only on the Machine means label sync is off on `global`) and the
`node-role.kubernetes.io/infra=reserved:NoSchedule` taint; every `var-cpaas` disk reports `Attached`.

**Optional, before installing plugins: prove the slot model.** Delete one `infra` Machine
(`kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system delete machine <name>`). Its replacement
must come back with the same hostname, the same IP and the same `var-cpaas` disk (`Attached` again), and
the slot returns to `InUse`. This is the cheapest moment to find a pool, datastore or template problem
that would otherwise surface during the first upgrade.

Archive the parameter files and the manifests. By construction they contain no credential and no key;
confirm it in the delivery directory before archiving — the command must print nothing:

```bash
# on the delivery host, in the delivery directory
grep -rnIiE 'aescbc|password[[:space:]]*[:=][[:space:]]*[^[:space:]]|_TOKEN=|BEGIN [A-Z ]*PRIVATE KEY' .
```

`CLUSTER_KUBECONFIG` is a cluster-admin credential: keep it outside the delivery directory and out of
the archive.

### Variants

#### Single cluster

Does not apply: the single-cluster topology makes `global` the workload cluster, and `global` is never
on vSphere in this delivery.

#### Dedicated pools

The dedicated layout replaces the `infra` pool with `ingress`, `monitor` and `log`, each with its own
three files (`30`–`32` ingress, `33`–`35` monitor, `36`–`38` log). Each set is a copy of the `infra` set
with every `infra` replaced by the pool name — names, hostnames, selector, labels and taint key — and its
own node IPs, CPU, memory and `/var/cpaas` size, named like the `LOG_*` rows of the parameter table
(`INGRESS_*` and `MONITOR_*` likewise). The system disk and the ephemeral disks keep the `INFRA_*`
sizes. The `log` set:

```diff
# wl-prod/36-log-pool.yaml (copy of 30-infra-pool.yaml), shown for the first slot; repeat per slot
 metadata:
-  name: ${CLUSTER_NAME}-infra-pool
+  name: ${CLUSTER_NAME}-log-pool
 ...
-  - hostname: "${CLUSTER_NAME}-infra-1"
+  - hostname: "${CLUSTER_NAME}-log-1"
 ...
-        ip: "${INFRA_NODE_IP_1}/${NODE_PREFIX}"
+        ip: "${LOG_NODE_IP_1}/${NODE_PREFIX}"
 ...
-      sizeGiB: ${INFRA_VAR_CPAAS_SIZE_GIB}
+      sizeGiB: ${LOG_VAR_CPAAS_SIZE_GIB}
```

```diff
# wl-prod/37-log-templates.yaml (copy of 31-infra-templates.yaml)
 kind: VSphereMachineTemplate
 metadata:
-  name: ${CLUSTER_NAME}-infra
+  name: ${CLUSTER_NAME}-log
 ...
-      memoryMiB: ${INFRA_MEMORY_MIB}
-      numCPUs: ${INFRA_NUM_CPUS}
+      memoryMiB: ${LOG_MEMORY_MIB}
+      numCPUs: ${LOG_NUM_CPUS}
 ...
-        name: ${CLUSTER_NAME}-infra-pool
+        name: ${CLUSTER_NAME}-log-pool
 ...
 kind: KubeadmConfigTemplate
 metadata:
-  name: ${CLUSTER_NAME}-infra-bootstrap
+  name: ${CLUSTER_NAME}-log-bootstrap
```

```diff
# wl-prod/38-log.yaml (copy of 32-infra.yaml)
 kind: MachineDeployment
 metadata:
-  name: ${CLUSTER_NAME}-infra
+  name: ${CLUSTER_NAME}-log
 ...
     matchLabels:
-      nodepool: infra
+      nodepool: log
 ...
-        nodepool: infra
-        node-role.kubernetes.io/infra: ""
+        nodepool: log
+        node-role.kubernetes.io/log: ""
         node-role.kubernetes.io/worker: ""
 ...
       taints:
-      - key: node-role.kubernetes.io/infra
+      - key: node-role.kubernetes.io/log
         value: reserved
         effect: NoSchedule
 ...
-          name: ${CLUSTER_NAME}-infra-bootstrap
+          name: ${CLUSTER_NAME}-log-bootstrap
 ...
-        name: ${CLUSTER_NAME}-infra
+        name: ${CLUSTER_NAME}-log
```

Each dedicated pool has its **own** taint key, so a plugin with the wrong placement stays `Pending`
instead of silently landing on another pool; keep `node-role.kubernetes.io/worker` on every pool so
machine configuration reaches it. Apply and verify each set like steps 5 and 6, one pool at a time, and
extend the disk loop of step 6 to the new pool names. Plugin placement for this layout is in
[Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins).

#### External load balancer instead of the Self-built VIP

Use it when the customer mandates a load balancer device for API endpoints, or when the `alive` plugin
is not deployable. Remove the whole `controlPlaneLoadBalancer` block from `10-cluster.yaml` and drop
`CONTROL_PLANE_VRID` from the cluster file; `CONTROL_PLANE_VIP` becomes the load balancer's frontend
address:

```diff
 spec:
   controlPlaneEndpoint:
     host: "${CONTROL_PLANE_VIP}"
     port: 6443
-  controlPlaneLoadBalancer:          # write-once: decided at creation, never changed
-    type: internal
-    host: "${CONTROL_PLANE_VIP}"     # must equal controlPlaneEndpoint.host
-    port: 6443                       # must equal controlPlaneEndpoint.port
-    vrid: ${CONTROL_PLANE_VRID}
   identityRef:
```

Provision the load balancer before step 1 per the
[External LoadBalancer Contract](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html#external-loadbalancer-contract):
Layer 4 TCP with TLS passthrough, the three control-plane slot IPs as backends on `6443`, an HTTPS
`/healthz` health check, and a named owner who maintains the backends. Skip the `alive` check in
[Prepare the `global` cluster](#prepare-the-global-cluster), and in step 4 replace the Self-built VIP
checks with `/version` through the load balancer. The decision is as final as the Self-built VIP: a
cluster created this way can never move to it.

#### Failure domains and a second NIC

Both are creation-time variants of the product page:
[Multiple datacenters and failure domains](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#multiple-datacenters-and-failure-domains)
and
[Creation-Time Topology Variants](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#creation-time-topology-variants).
With a second NIC, also set `controlPlaneLoadBalancer.interface` (and `deviceName` in the slots)
explicitly. Add one variant at a time to this manifest set and validate it before combining them.

#### Worker pools

Application workers follow the customer's machines and are not part of this delivery. When the cluster
needs a generic pool, copy the three `infra` files to `40`–`42` with `worker` in place of `infra` in the
names, hostnames, selector and variables, then remove the `node-role.kubernetes.io/infra` label and the
taint from the `MachineDeployment` so that ordinary workloads can schedule there. Keep
`node-role.kubernetes.io/worker`, the standard disk set, `maxSurge: 0` with `maxUnavailable: 1`, and
`replicas` no larger than the number of slots in the pool.

### Continue with the common steps

With the cluster and its pools up, continue in the common article on the new workload cluster:

1. [Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)
   — placement on `infra` (or the dedicated pools). `INGRESS_VIP_RANGE` (and the `INGRESS_VIP` in it) must lie in
   the node subnet of `VSPHERE_NETWORK`, outside every slot IP and `CONTROL_PLANE_VIP`; in Layer 2 mode
   MetalLB announces it with ARP, so the port-group policy that lets the Self-built VIP's gratuitous ARP
   through must allow it as well.
2. [Configure machines](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines)
   — the Machine Configuration plugin on this cluster first, then time zone, NTP and the `boot` SSH key.
3. [Accept the delivery](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#accept-the-delivery)
   — plus the vSphere-specific checks below.

| Check | Evidence | Pass |
| --- | --- | --- |
| Slot pools | Commands below | Every pool of the cluster `Ready=True`; `ALLOCATED` equals its running Machines |
| Persistent disks | Loop in step 6 | Every `var-cpaas` disk `Attached` |
| Ephemeral disks | Commands below | Every ephemeral disk of every allocated slot listed with a unit number |
| Node identity | `providerID` command in step 4 | Every node has a `vsphere://` ID; names and IPs equal the slots |
| CPI | `ClusterResourceSetBinding` and DaemonSet in step 4 | Binding exists; DaemonSet ready on every node |
| Endpoint | `VSphereCluster` conditions and `/version` in step 4 | `SelfBuiltLoadBalancerReady=True`; one `alive` Pod per control-plane node; `/version` with TLS verification |
| Admission | Webhook command in [Prepare the `global` cluster](#prepare-the-global-cluster) | Both `capv` rollout webhooks registered |
| Rollout settings | Commands below | `maxSurge: 0` on the control plane and every pool; `maxUnavailable: 1` on every `MachineDeployment` |
| Archive | `grep` before archiving | No credential, key or kubeconfig in the archive |

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool
for pool in cp-pool infra-pool; do
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get vspheremachineconfigpool "${CLUSTER_NAME}-${pool}" \
    -o jsonpath='{range .status.ephemeralDiskStatuses[*]}{.hostname}{" "}{.name}{" unit="}{.unitNumber}{"\n"}{end}'
done
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane "${CLUSTER_NAME}-kcp" \
  -o jsonpath='{.spec.replicas}{" "}{.spec.rolloutStrategy.rollingUpdate}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machinedeployment -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}" \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.strategy.rollingUpdate}{"\n"}{end}'
```

Day-2 operations — scale-out (add slots first, then raise `replicas`), template changes, Kubernetes
upgrades and provider upgrades — follow
[Managing Nodes on VMware vSphere](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/vmware-vsphere.html),
[Upgrading Clusters on VMware vSphere](https://docs.alauda.io/immutable-infra/1.0/upgrade-cluster/vmware-vsphere.html)
and [Upgrading the Provider](https://docs.alauda.io/immutable-infra/1.0/install/vmware-vsphere.html#upgrade-the-provider).
Re-applying an archived `MachineDeployment` is accepted only while it still carries `maxSurge: 0` and
`maxUnavailable: 1`; the control-plane manifest is never re-applied.

If the delivery has to deviate from this design, stop and resolve the deviation with the platform team
before continuing — on vSphere most of these decisions are frozen at creation, so a deviation found later
is a rebuild.

## Related Information

- [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md) — the common article
- [Creating Clusters on VMware vSphere](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html)
- [VMware vSphere Infrastructure Preparation](https://docs.alauda.io/immutable-infra/1.0/infrastructure/vmware-vsphere.html)
- [VMware vSphere Provider Installation](https://docs.alauda.io/immutable-infra/1.0/install/vmware-vsphere.html)
- [VMware vSphere Provider Release Notes](https://docs.alauda.io/immutable-infra/1.0/release-notes/vmware_vsphere.html#v1-0-17)
- [Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html)
- [Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)
- [Managing Nodes on VMware vSphere](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/vmware-vsphere.html)
- [Upload Packages](https://docs.alauda.io/container_platform/4.4/extend/upload_package.html#violet_push_usage) and [Cluster Plugin](https://docs.alauda.io/container_platform/4.4/extend/cluster_plugin.html)
- [Evaluating Resources for Workload Cluster](https://docs.alauda.io/container_platform/4.4/configure/scalability/evaluating_workload.html)
