---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# How to Deliver ACP on Huawei Cloud Stack with Immutable Infrastructure

## Purpose

This article is the Huawei Cloud Stack (HCS) part of the standard delivery of Alauda Container
Platform (ACP) 4.4 on Immutable Infrastructure (Alauda OS nodes). It installs the `global` cluster —
a primary and a standby for disaster recovery (DR) — and creates workload clusters on HCS: complete
manifests with `${VAR}` placeholders, the order in which to apply them, and the check that proves
each step worked.

Read [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#how-to-use-these-articles)
first. That common article owns the reference design (topologies, node pools, labels and taints,
disks), the parameter files and helpers, the delivery flow, the platform plugins, machine
configuration, sizing and acceptance. This article covers what is specific to HCS and links back for
the rest.

Versions this article is written for:

| Component | Version | Why |
| --- | --- | --- |
| ACP | 4.4.x | The release these articles are pinned to |
| Alauda Container Platform HCS Infrastructure Provider | `v1.0.4` or later | First release that selects the ACP 4.4 component repositories (Kube-OVN chart `v4.4`, CoreDNS tags with the `v4.4` suffix, kube-proxy for Kubernetes 1.35) — see the [release notes](https://docs.alauda.io/immutable-infra/1.0/release-notes/huawei_cloud_stack.html#v1-0-4). Pool-managed persistent disks alone need `v1.0.1` or later |
| Alauda Container Platform Kubeadm Provider | The version delivered with your ACP 4.4 release | Must match the Cluster API control plane resources in the manifests |
| Alauda OS | The `qcow2` image published for your ACP 4.4 patch | HCS uses the `qcow2` format; the image fixes the Kubernetes and component versions |

Scope:

- Alauda OS nodes only. For a traditional operating system, use the
  [standard installation path](https://docs.alauda.io/container_platform/4.4/install/index.html).
- Every cluster's API endpoint is the Elastic Load Balance (ELB) instance that the HCS provider
  creates. No commercial load balancer is needed for platform or cluster VIPs.
- Clusters are created with YAML. Application worker pools follow the customer's machines and
  application storage is planned separately; both are out of scope beyond the notes below.

**Validation status.** The manifests are assembled from the ACP 4.4 product documentation and the
provider versions named above. Validate them in a staging environment before a production delivery.

## Resolution

### Huawei Cloud Stack-specific design

#### Control plane endpoint: the ELB the provider creates

- For every cluster, the HCS provider creates an ELB for the Kubernetes API server and owns its VIP.
  You plan addresses, not a load balancer: the VIP (`vipAddress`) in its subnet (`vipSubnetName`)
  and, because the ELB runs with Hybrid Load Balancing so that cluster nodes can reach their own API
  server through it, two fixed L4 and two fixed L7 virtual subnet IPs. Every subnet that these
  addresses or the nodes use must be listed in `HCSCluster.spec.network.subnets`.
- The endpoint is the VIP — an IP address. Leave `vipDomainName` unset: cluster access by domain is
  not supported, because the API server certificate can only be issued by the cluster's own CA. Do
  not write `controlPlaneEndpoint` in the manifest; the controller fills it from the ELB. The VIP is
  written into the API server certificate and every kubeconfig, so freeze it before installation.
- The provider overview also mentions bandwidth and a public-IP preference as ELB inputs. The
  documented create flow sets neither, and this design leaves `publicIpOption` unset: the endpoint
  is a private VIP inside the customer network.
- **`global` only:** the provider allocates the additional ELB listeners `443` (web console),
  `11443` (registry and console) and `2379` (DR etcd synchronization) only when the infrastructure
  cluster is named exactly `global`. Another name installs without error and then breaks registry
  pulls, DR synchronization and the web console. Port `80` is not among them — plan platform access
  over HTTPS.
- Never disable Hybrid Load Balancing on a provider-created ELB; the nodes reach the API server
  through it.

#### Persistent `/var/cpaas` disks

- `/var/cpaas` on every node is a pool-managed EVS disk declared in
  `HCSMachineConfigPool.spec.configs[].persistentDisks[]`. During a rolling replacement the provider
  moves it from the old ECS to the new one, keyed by `(hostname, slot)`, so platform state,
  monitoring data and the log collector's working data survive node replacement.
- Kafka, Keeper and ClickHouse keep their data on PersistentVolumes of the StorageClasses in the
  customer's storage plan, not on `/var/cpaas` (common article,
  [Disks](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#disks)). The HCS product
  pages mention an HCS EVS CSI only as external storage and do not document its installation, so agree
  on the StorageClass with the customer before the logging stage.
- Never declare `/var/cpaas` in `HCSMachineTemplate.spec.template.spec.dataVolumes[]` — data volumes
  are recreated with each ECS. Use them only for `/var/lib/etcd`, `/var/lib/kubelet` and
  `/var/lib/containerd`, and never declare the same mount path in both places.
- `slot`, `size`, `type`, `format` and `mountPath` are the disk's identity and cannot be changed
  after the provider has accepted the entry. Size `/var/cpaas` before the first apply
  ([Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters));
  growing it later is a migration, not an edit.
- Every pool with persistent disks rolls with `maxSurge: 0`: a surge machine cannot take the
  hostname, IP and disk slot of the machine it replaces. The field paths differ —
  `KubeadmControlPlane.spec.rolloutStrategy.rollingUpdate.maxSurge` (no `maxUnavailable` exists
  there) and `MachineDeployment.spec.strategy.rollingUpdate` (`maxSurge: 0`, `maxUnavailable: 1`).
  Copying the `MachineDeployment` block into the `KubeadmControlPlane` leaves the control plane on
  the default surge.
- From HCS provider `v1.0.4`, Pod logs (`/var/log/pods`) are placed on the `/var/lib/containerd`
  data volume when that volume exists; size it accordingly.

#### Availability zones and host spread

- One `HCSMachineTemplate` selects one availability zone. All control plane nodes share one zone,
  each worker pool sits in one zone, separate pools can use separate zones, and one pool never
  spreads across zones.
- Set `availabilityZone` explicitly with the HCS API `ZoneName`, not a tenant console display name.
  When it is omitted, the provider takes the first zone HCS reports as available — an order HCS
  controls.
- A persistent disk locks the replacement ECS to the disk's zone. Never change the zone of a template
  whose pool already owns disks; the replacement fails with an availability zone conflict.
- `HCSCluster.spec.controlPlaneHA` spreads the three control plane ECS instances across physical
  hosts through a provider-owned server group — hosts, not zones. This design enables it with
  `soft-anti-affinity` (best effort, never blocks creation). Use `anti-affinity` when strict
  separation is required and the zone has the capacity; a hard rule that cannot be met fails ECS
  creation. See [Control Plane HA Placement Plan](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-cloud-stack.html#control-plane-ha-placement).
- In a DR pair, place the primary and the standby in different failure domains.

#### Node identity

- Static IPs and hostnames come from `HCSMachineConfigPool`, one entry per node. With `maxSurge: 0`,
  exactly as many entries as replicas is enough.
- Hostnames use lowercase letters, digits, `-` and `.`. A dotted hostname becomes the node's FQDN and
  its first label the POSIX hostname — see
  [Hostname behavior on the node](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html#hostname-behavior-on-the-node).
- Give the primary and the standby `global` different hostnames, as the
  [ACP DR notes](https://docs.alauda.io/container_platform/4.4/install/global_dr.html) recommend:
  both clusters carry the same resource names (`global`, `global-*`), and persistent disks are keyed
  by `(hostname, slot)`. If both sides share one HCS project, validate in staging that their ELBs
  and disks stay apart — the product pages do not say how the provider names them.
- Bootstrap data is `cloud-config`; the HCS provider rejects `ignition`. Never set `providerID` or
  `serverId` in a template — the provider assigns them. It also injects the kubelet serving
  certificate and, on control plane nodes, an encryption provider file (for DR see
  [What changes for DR on HCS](#what-changes-for-dr-on-hcs)).
- The HCS manifests take no SSH key. The `boot` user's key (`BOOT_SSH_PUBLIC_KEY`) reaches the nodes
  through the common article's machine configuration.

#### Application ingress on an HCS VPC

The common article announces the ingress VIP with MetalLB in Layer 2 mode, which answers ARP for an
address that is not bound to the node's NIC. HCS VPC ports may drop traffic for such addresses
(source and destination checking). The product documentation does not cover MetalLB on an HCS VPC,
so treat it as a staging test item: before you install the ingress plugins, have the HCS
administrator confirm how the ingress VIP is permitted on the `infra` nodes' NICs, and test the VIP
from a client network. If the VPC cannot carry it, use the common article's alternative: a
load balancer in front of the `infra` nodes (on HCS, an ELB that the customer creates for application
traffic) with `IngressNginx.spec.controller.hostNetwork: true`. Never combine it with MetalLB on the
same VIP.

### Parameters

The parameter files and the `render`, `load_env` and `apply_rendered` helpers are defined in
[Prepare the parameter files](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files).
Run every command in Bash from the delivery directory, after loading the helpers with
`. ./acp-helpers.sh` in each new shell. The common
variables keep their meaning. On HCS, `CONTROL_PLANE_VIP` is the ELB VIP
(`HCSCluster.spec.controlPlaneLoadBalancer.vipAddress`), and `CLUSTER_KUBECONFIG` of a `global` side
is written in Step 5. HCS adds these variables to the same files:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `CORE_PACKAGE` | Core Package archive on the bootstrap node | `/root/packages/acp-core-package.tar` | Downloaded with `violet` for your ACP 4.4 patch |
| `KUBEADM_PROVIDER_PACK` | Kubeadm Provider package on the bootstrap node | `/root/packages/cluster-api-provider-kubeadm.amd64.v1.0.14.tgz` | Customer Portal: Alauda Container Platform Kubeadm Provider |
| `KUBEADM_PROVIDER_VERSION` | Kubeadm Provider chart version | `v1.0.14` | Version in the package file name; confirmed by the registry tag list in Step 2 |
| `HCS_PROVIDER_PACK` | HCS provider package on the bootstrap node | `/root/packages/cluster-api-provider-hcs.amd64.v1.0.4.tgz` | Customer Portal: Alauda Container Platform HCS Infrastructure Provider, `v1.0.4` or later |
| `HCS_PROVIDER_VERSION` | HCS provider chart version | `v1.0.4` | Version in the package file name; confirmed in Step 2 |
| `LOCAL_REGISTRY_ADDRESS` | Bootstrap registry as seen from the bootstrap node (package push) | `127.0.0.1:11443` | Fixed value from the installation guide |
| `BOOTSTRAP_REGISTRY_ADDRESS` | Bootstrap registry as seen from Pods in the bootstrap cluster (`AppRelease` `repoURL`) | `172.18.0.1:11443` | Fixed value from the installation guide |
| `INGRESS_CLASS_NAME` | Platform entrance name that the provider charts expect | `global-alb2` | Fixed value from the installation guide. Keep it; it is not the application ingress |
| `BOOTSTRAP_KUBECONFIG` | Kubeconfig of this side's bootstrap cluster, on that side's bootstrap node | `/root/.kube/config` | The path the installation guide copies the bootstrap kubeconfig to (Step 1 below). Empty in workload files |
| `HOST_IP` | Static IP of this side's bootstrap node | `192.0.2.5` | The bootstrap node; must not change until handoff. Empty in workload files |
| `NODE_REGISTRY_ADDRESS` | Registry that provisioned `global` nodes pull from until the `global` registry takes over | `192.0.2.5:11443` | `HOST_IP` plus `:11443`; `<host>:<port>` only, never `/v2/`. Empty in workload files |
| `PROVIDER_SECRET_NAME` | HCS credential Secret, referenced by `HCSCluster.spec.identityRef.name` | `global-hcs-credential` | Choose; `global-` prefix for `global`; identical on both DR sides |
| `HCS_PROJECT_ID` | Resource Space (project) ID | `0123456789abcdef0123456789abcdef` | HCS **My Settings** > **Resource Spaces** — the ID, not the display name |
| `HCS_REGION` | Region API value used by the provider | `region-example-1` | HCS administrator; tenant administrators cannot read it in the HCS UI |
| `HCS_EXTERNAL_GLOBAL_DOMAIN` | HCS platform domain the provider calls | `hcs.example.com` | HCS administrator |
| `HCS_VPC_NAME` | Existing VPC of the cluster | `vpc-example` | HCS network inventory |
| `HCS_SUBNET_NAME` | Subnet of the nodes, the ELB VIP and the ELB L4/L7 IPs | `subnet-example-global` | HCS network inventory; in `HCS_VPC_NAME` |
| `HCS_SECURITY_GROUP_NAME` | Existing security group of the cluster | `sg-example` | HCS network inventory |
| `HCS_ELB_L4_IP_1` | First L4 virtual subnet IP of the control plane ELB | `192.0.2.31` | Free IP in `HCS_SUBNET_NAME` |
| `HCS_ELB_L4_IP_2` | Second L4 virtual subnet IP | `192.0.2.32` | Free IP in `HCS_SUBNET_NAME` |
| `HCS_ELB_L7_IP_1` | First L7 virtual subnet IP | `192.0.2.33` | Free IP in `HCS_SUBNET_NAME` |
| `HCS_ELB_L7_IP_2` | Second L7 virtual subnet IP | `192.0.2.34` | Free IP in `HCS_SUBNET_NAME` |
| `HCS_CP_HA_POLICY` | Control plane host spread (`HCSCluster.spec.controlPlaneHA.policy`) | `soft-anti-affinity` | `soft-anti-affinity` or `anti-affinity` — see the design above |
| `HCS_IMAGE_NAME` | Alauda OS image name in HCS | `alaudaos-4.4-x86_64-example` | Exact name of the uploaded `qcow2` image |
| `HCS_CP_FLAVOR` | ECS flavor of the control plane nodes | `example.8u32g` | HCS administrator: the `Flavor.Name` API value. Size from the common article |
| `HCS_CP_AZ` | Availability zone of the control plane | `az-example-1` | HCS administrator: the `ZoneName` API value; confirm it is available |
| `HCS_INFRA_FLAVOR` | ECS flavor of the `infra` nodes | `example.16u64g` | As `HCS_CP_FLAVOR` |
| `HCS_INFRA_AZ` | Availability zone of the `infra` pool | `az-example-1` | As `HCS_CP_AZ` |
| `HCS_DISK_TYPE` | EVS disk type for root, data and persistent disks | `SSD` | Disk types available in the target zones |
| `CP_CPAAS_DISK_GB` | Size of `/var/cpaas` on control plane nodes, GB | `100` | Common article sizing; `10`–`32768`; cannot be changed later |
| `INFRA_CPAAS_DISK_GB` | Size of `/var/cpaas` on `infra` nodes, GB | `500` | Common article sizing: platform state, monitoring data and collector working data (plus Kafka and ClickHouse volumes only if their StorageClass provisions on this disk); cannot be changed later |
| `CP1_HOSTNAME` | Hostname of control plane node 1 | `global-primary-cp-1` | Node naming plan; different on each DR side |
| `CP1_IP` | IP of control plane node 1 | `192.0.2.11` | Free IP in `HCS_SUBNET_NAME` |
| `CP2_HOSTNAME` | Hostname of control plane node 2 | `global-primary-cp-2` | Node naming plan |
| `CP2_IP` | IP of control plane node 2 | `192.0.2.12` | Free IP in `HCS_SUBNET_NAME` |
| `CP3_HOSTNAME` | Hostname of control plane node 3 | `global-primary-cp-3` | Node naming plan |
| `CP3_IP` | IP of control plane node 3 | `192.0.2.13` | Free IP in `HCS_SUBNET_NAME` |
| `INFRA1_HOSTNAME` | Hostname of `infra` node 1 | `global-primary-infra-1` | Node naming plan |
| `INFRA1_IP` | IP of `infra` node 1 | `192.0.2.14` | Free IP in `HCS_SUBNET_NAME` |
| `INFRA2_HOSTNAME` | Hostname of `infra` node 2 | `global-primary-infra-2` | Node naming plan |
| `INFRA2_IP` | IP of `infra` node 2 | `192.0.2.15` | Free IP in `HCS_SUBNET_NAME` |
| `INFRA3_HOSTNAME` | Hostname of `infra` node 3 | `global-primary-infra-3` | Node naming plan |
| `INFRA3_IP` | IP of `infra` node 3 | `192.0.2.16` | Free IP in `HCS_SUBNET_NAME` |
| `IMAGE_REPOSITORY` | Repository of the kubeadm-managed images (`clusterConfiguration.imageRepository`) | `cloud.alauda.io/alauda` | Approved release baseline. The DCS and Bare Metal guides use this value, which matches the images preloaded in Alauda OS; confirm it for your release |
| `DNS_IMAGE_TAG` | CoreDNS image tag | `1.14.3-v4.4.6` | [OS Support Matrix](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html), row of your ACP 4.4 patch (4.4.0 shown) |
| `ETCD_IMAGE_TAG` | etcd image tag | `v3.6.13-acp.0` | OS Support Matrix, same row |
| `KUBE_OVN_VERSION` | Kube-OVN chart version | `v4.4.6` | OS Support Matrix, same row (`kube-ovn (chart)`) |
| `PRIMARY_CLUSTER_VIP` | ELB VIP of the primary `global` | `192.0.2.10` | Equals `CONTROL_PLANE_VIP` in `global-primary.env` |
| `STANDBY_CLUSTER_VIP` | ELB VIP of the standby `global` | `203.0.113.10` | Equals `CONTROL_PLANE_VIP` in `global-standby.env` |

Runtime secrets — typed at a prompt or read from a protected file when needed, never stored in a
parameter file (in addition to the common article's `REGISTRY_USERNAME`, `REGISTRY_PASSWORD` and
`ACP_TOKEN`):

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `HCS_ACCESS_KEY` | Access key ID of the HCS user the provider acts as | (never stored) | HCS **My Settings** > **Access Keys** |
| `HCS_SECRET_KEY` | Secret access key of that user | (never stored) | As above |
| `PLATFORM_ADMIN_PASSWORD` | Password of the platform administrator `admin@cpaas.io`, set by the installer | (never stored) | Chosen by the customer; the same on both DR sides |
| `PLATFORM_ADMIN_PASSWORD_B64` | Base64 form of it for the installer request | (never stored) | Computed in Step 8 |
| `REGISTRY_PASSWORD_B64` | Base64 form of the platform registry password for the installer request | (never stored) | Computed in Step 8 |
| `ACTIVE_CLUSTER_TOKEN` | Bearer token of the primary's `cpaas-system/k8sadmin` ServiceAccount for etcd-sync | (never stored) | Read from the primary in [Install etcd-sync](#install-etcd-sync-acp-440) |
| `ENCRYPTION_PROVIDER_SECRET_B64` | Shared etcd encryption key (base64 of 32 random bytes) | (never stored) | Generated once in [Prepare the shared DR values](#prepare-the-shared-dr-values); lives only in `/root/dr/encryption-key.b64` |

Two manifests contain intentional `${...}` that `render` leaves in place: `12-kcp.yaml` of `global`
(`ENCRYPTION_PROVIDER_SECRET_B64`) and `40-installer-config.json` (`REGISTRY_USERNAME`,
`PLATFORM_ADMIN_PASSWORD_B64`, `REGISTRY_PASSWORD_B64`). The steps that use them fill them at apply
time and never write the result to the delivery directory.

HCS additions to `site.env`, identical on every bootstrap node and delivery host:

```bash
CORE_PACKAGE='/root/packages/acp-core-package.tar'
KUBEADM_PROVIDER_PACK='/root/packages/cluster-api-provider-kubeadm.amd64.v1.0.14.tgz'
KUBEADM_PROVIDER_VERSION='v1.0.14'
HCS_PROVIDER_PACK='/root/packages/cluster-api-provider-hcs.amd64.v1.0.4.tgz'
HCS_PROVIDER_VERSION='v1.0.4'
LOCAL_REGISTRY_ADDRESS='127.0.0.1:11443'
BOOTSTRAP_REGISTRY_ADDRESS='172.18.0.1:11443'
INGRESS_CLASS_NAME='global-alb2'
HCS_PROJECT_ID='0123456789abcdef0123456789abcdef'
HCS_REGION='region-example-1'
HCS_EXTERNAL_GLOBAL_DOMAIN='hcs.example.com'
HCS_IMAGE_NAME='alaudaos-4.4-x86_64-example'
HCS_DISK_TYPE='SSD'
IMAGE_REPOSITORY='cloud.alauda.io/alauda'
DNS_IMAGE_TAG='1.14.3-v4.4.6'
ETCD_IMAGE_TAG='v3.6.13-acp.0'
KUBE_OVN_VERSION='v4.4.6'
PRIMARY_CLUSTER_VIP='192.0.2.10'
STANDBY_CLUSTER_VIP='203.0.113.10'
```

HCS additions to `global-primary.env` (its common part has `CLUSTER_NAME='global'` and
`CONTROL_PLANE_VIP='192.0.2.10'`):

```bash
BOOTSTRAP_KUBECONFIG='/root/.kube/config'
HOST_IP='192.0.2.5'
NODE_REGISTRY_ADDRESS='192.0.2.5:11443'
PROVIDER_SECRET_NAME='global-hcs-credential'
HCS_VPC_NAME='vpc-example'
HCS_SUBNET_NAME='subnet-example-global'
HCS_SECURITY_GROUP_NAME='sg-example'
HCS_ELB_L4_IP_1='192.0.2.31'
HCS_ELB_L4_IP_2='192.0.2.32'
HCS_ELB_L7_IP_1='192.0.2.33'
HCS_ELB_L7_IP_2='192.0.2.34'
HCS_CP_HA_POLICY='soft-anti-affinity'
HCS_CP_FLAVOR='example.8u32g'
HCS_CP_AZ='az-example-1'
HCS_INFRA_FLAVOR='example.16u64g'
HCS_INFRA_AZ='az-example-1'
CP_CPAAS_DISK_GB='100'
INFRA_CPAAS_DISK_GB='500'
CP1_HOSTNAME='global-primary-cp-1'
CP1_IP='192.0.2.11'
CP2_HOSTNAME='global-primary-cp-2'
CP2_IP='192.0.2.12'
CP3_HOSTNAME='global-primary-cp-3'
CP3_IP='192.0.2.13'
INFRA1_HOSTNAME='global-primary-infra-1'
INFRA1_IP='192.0.2.14'
INFRA2_HOSTNAME='global-primary-infra-2'
INFRA2_IP='192.0.2.15'
INFRA3_HOSTNAME='global-primary-infra-3'
INFRA3_IP='192.0.2.16'
```

`global-standby.env` is a copy of `global-primary.env`: keep `CLUSTER_NAME`,
`PROVIDER_SECRET_NAME` and `BOOTSTRAP_KUBECONFIG` (the same path, on the standby's own bootstrap
node), change the common values as the common article describes, and change these HCS values
(network and zone values too if the standby sits elsewhere):

```bash
HOST_IP='203.0.113.5'
NODE_REGISTRY_ADDRESS='203.0.113.5:11443'
HCS_SUBNET_NAME='subnet-example-standby'
HCS_CP_AZ='az-example-2'
HCS_INFRA_AZ='az-example-2'
HCS_ELB_L4_IP_1='203.0.113.31'
HCS_ELB_L4_IP_2='203.0.113.32'
HCS_ELB_L7_IP_1='203.0.113.33'
HCS_ELB_L7_IP_2='203.0.113.34'
CP1_HOSTNAME='global-standby-cp-1'
CP1_IP='203.0.113.11'
CP2_HOSTNAME='global-standby-cp-2'
CP2_IP='203.0.113.12'
CP3_HOSTNAME='global-standby-cp-3'
CP3_IP='203.0.113.13'
INFRA1_HOSTNAME='global-standby-infra-1'
INFRA1_IP='203.0.113.14'
INFRA2_HOSTNAME='global-standby-infra-2'
INFRA2_IP='203.0.113.15'
INFRA3_HOSTNAME='global-standby-infra-3'
INFRA3_IP='203.0.113.16'
```

HCS additions to a workload cluster file, here `wl-prod.env` (its common part has
`CLUSTER_NAME='wl-prod'` and `CONTROL_PLANE_VIP='192.0.2.20'`):

```bash
BOOTSTRAP_KUBECONFIG=''
HOST_IP=''
NODE_REGISTRY_ADDRESS=''
PROVIDER_SECRET_NAME='global-hcs-credential'
HCS_VPC_NAME='vpc-example'
HCS_SUBNET_NAME='subnet-example-wl-prod'
HCS_SECURITY_GROUP_NAME='sg-example'
HCS_ELB_L4_IP_1='192.0.2.41'
HCS_ELB_L4_IP_2='192.0.2.42'
HCS_ELB_L7_IP_1='192.0.2.43'
HCS_ELB_L7_IP_2='192.0.2.44'
HCS_CP_HA_POLICY='soft-anti-affinity'
HCS_CP_FLAVOR='example.8u32g'
HCS_CP_AZ='az-example-1'
HCS_INFRA_FLAVOR='example.16u64g'
HCS_INFRA_AZ='az-example-1'
CP_CPAAS_DISK_GB='100'
INFRA_CPAAS_DISK_GB='500'
CP1_HOSTNAME='wl-prod-cp-1'
CP1_IP='192.0.2.21'
CP2_HOSTNAME='wl-prod-cp-2'
CP2_IP='192.0.2.22'
CP3_HOSTNAME='wl-prod-cp-3'
CP3_IP='192.0.2.23'
INFRA1_HOSTNAME='wl-prod-infra-1'
INFRA1_IP='192.0.2.24'
INFRA2_HOSTNAME='wl-prod-infra-2'
INFRA2_IP='192.0.2.25'
INFRA3_HOSTNAME='wl-prod-infra-3'
INFRA3_IP='192.0.2.26'
```

### Prepare Huawei Cloud Stack

#### Collect the HCS facts

Collect every value before you write a file; several can only be read by the HCS administrator. The
full checklist is
[Infrastructure Resources for Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-cloud-stack.html).

| Fact | Goes into | Notes |
| --- | --- | --- |
| HCS user (IAM) and its access key pair | Credential Secret `accessKey`, `secretKey` | **My Settings** > **Access Keys** of the user the provider acts as. The provider creates and deletes ECS instances, EVS disks, the control plane ELB and the control plane server group, and reads the VPC, subnets and security group; the product documentation names no minimum policy, so agree the role with the HCS administrator |
| Project (Resource Space) ID, region API value, HCS platform domain | `HCS_PROJECT_ID`, `HCS_REGION`, `HCS_EXTERNAL_GLOBAL_DOMAIN` | The region value is not visible to tenant administrators |
| HCS API and IAM endpoints | Network paths and DNS | Host names and ports that the provider reaches; the IAM endpoint uses `https` unless the administrator says otherwise |
| VPC, subnets, security group | `HCS_VPC_NAME`, `HCS_SUBNET_NAME`, `HCS_SECURITY_GROUP_NAME` | All subnets of one cluster in one VPC, and mutually reachable |
| Free IPs per cluster | ELB VIP, 2 L4 + 2 L7 ELB IPs, one IP per node | Reserve them in the HCS subnet plan so nothing else takes them |
| Flavors and availability zones | `HCS_*_FLAVOR`, `HCS_*_AZ` | The `Flavor.Name` and `ZoneName` API values, not the tenant console display names |
| EVS disk type | `HCS_DISK_TYPE` | Must exist in every zone you use |

#### Upload the Alauda OS image

Download the `qcow2` Alauda OS image for your ACP 4.4 patch from the OS download page of the Customer
Portal ([Downloading Alauda OS](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html#downloading-alauda-os)),
upload it to the HCS image service of the project, and record its exact name as `HCS_IMAGE_NAME`. The
image fixes the Kubernetes version, so `K8S_VERSION`, `DNS_IMAGE_TAG` and `ETCD_IMAGE_TAG` must come
from the same OS Support Matrix row. The underlying CPUs must support the `x86-64-v2` baseline.

#### Open the network paths

Confirm each path with the customer's network team before installing, in addition to the flows in
the common article's [Reference design](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#reference-design):

- **Bootstrap node → HCS API and IAM endpoints.** The providers run inside the bootstrap cluster
  during the `global` installation. See the bootstrap
  [Network](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-network)
  table, which also lists bootstrap node → `global` VIP `6443` and `global` nodes → bootstrap node
  `11443`.
- **`global` nodes → HCS API and IAM endpoints.** The product table lists only the bootstrap path,
  but after handoff `global` owns its providers
  ([Installation Lifecycle](https://docs.alauda.io/immutable-infra/1.0/global/install.html#installation-lifecycle)),
  which create workload clusters and replace nodes from there. Test this path from a `global` node
  before the first scale-out.
- **`global` nodes → each workload cluster's ELB VIP `6443`.** Cluster API on `global` manages the
  workload control plane through it
  ([Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html#external-loadbalancer-contract)).
- **DNS.** The platform domain resolves for users, bootstrap nodes and all cluster nodes; the HCS
  endpoint names resolve for the bootstrap nodes and the `global` nodes. Nodes use the DNS servers of
  their HCS subnet.
- **Security group.** It must allow the cluster-internal traffic and the ELB's traffic to the control
  plane nodes on the listener ports. Use the
  [ACP 4.4 Communication Matrix](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html)
  for port approvals and read its [list of flows it does not cover](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html#not_covered)
  (traffic between `global` and workload clusters, load balancer forwarding, DR).
- **DR.** Allow `443`, `6443`, `11443` and `2379` in both directions between the primary and standby
  networks — see the [DR network requirements](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#network-requirements).
  On HCS the ELB listeners themselves come from the provider; only the network rules are yours to
  prepare.

#### Prepare the provider packages

Download the two cluster plugins — **Alauda Container Platform Kubeadm Provider** and **Alauda
Container Platform HCS Infrastructure Provider** (`v1.0.4` or later) — from the Customer Portal, and
copy them with the Core Package to the paths in `site.env` on each bootstrap node. The bootstrap
cluster installs both providers from the file below. Its values are fixed by the installation guide;
`global.cluster.type: Baremetal` is a chart-internal classifier, not the IaaS name.

`global-primary/00-provider-appreleases.yaml`

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
  name: cluster-api-provider-hcs
  namespace: cpaas-system
spec:
  destination:
    cluster: ""
    namespace: ""
  source:
    charts:
      - name: ait/chart-cluster-api-provider-hcs
        releaseName: cluster-api-provider-hcs
        targetRevision: ${HCS_PROVIDER_VERSION}
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
```

The embedded bootstrap registry is anonymous by default. Only if you set a registry user and password
during `setup.sh`, add `spec.source.chartPullSecret: global-registry-auth` and
`spec.values.global.registry.imagePullSecrets: [global-registry-auth]` to both releases, as Step 3 of
[Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
shows; never create a placeholder Secret.

#### Create the credential Secret

The provider reads the HCS credential from a Secret in `cpaas-system` of the cluster it runs in: the
bootstrap cluster during the `global` installation, `global` afterwards. Create it with
`kubectl create`, never as a manifest with `kubectl apply` — client-side apply stores the secret key in
the Secret's own `last-applied-configuration` annotation, and base64 is an encoding, not protection.
The keys are passed through process substitution, so they never appear on a command line.
Set `KUBECONFIG_FOR_SECRET` to the kubeconfig of the target cluster first — `${BOOTSTRAP_KUBECONFIG}`
during the `global` installation, `${GLOBAL_KUBECONFIG}` later; the block refuses to run without it.

```bash
# on the bootstrap cluster (global installation) or on global (later), cluster file loaded
: "${KUBECONFIG_FOR_SECRET:?set KUBECONFIG_FOR_SECRET to the target cluster first}"
read -rsp 'HCS access key ID: ' HCS_ACCESS_KEY; echo
read -rsp 'HCS secret access key: ' HCS_SECRET_KEY; echo
kubectl --kubeconfig "${KUBECONFIG_FOR_SECRET}" -n cpaas-system create secret generic "${PROVIDER_SECRET_NAME}" \
  --from-file=accessKey=<(printf '%s' "${HCS_ACCESS_KEY}") \
  --from-file=secretKey=<(printf '%s' "${HCS_SECRET_KEY}") \
  --from-literal=projectID="${HCS_PROJECT_ID}" \
  --from-literal=region="${HCS_REGION}" \
  --from-literal=externalGlobalDomain="${HCS_EXTERNAL_GLOBAL_DOMAIN}"
unset HCS_ACCESS_KEY HCS_SECRET_KEY
# lets the web UI list this credential (node pool management on global)
kubectl --kubeconfig "${KUBECONFIG_FOR_SECRET}" -n cpaas-system label secret "${PROVIDER_SECRET_NAME}" \
  capi.cpaas.io/provider=cluster-api-provider-hcs
```

Add `--from-literal=schema=http` only if the HCS IAM endpoint uses plain HTTP; the default is `https`.

### Install the global cluster

The overall order of the delivery is in the common article's
[Delivery flow](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#delivery-flow).
The steps below follow [Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html),
Steps 1–9, Huawei Cloud Stack tabs, with the `global` resources assembled into complete files. Read
the [naming convention](https://docs.alauda.io/immutable-infra/1.0/global/install.html#common-prerequisites)
first: `Cluster` and `HCSCluster` are named exactly `global`, every other resource starts with
`global-`. A resource without the prefix installs normally and is then invisible to DR — the standby's
machines are deleted at the first failover.

The manifests are the multi-cluster main line, with the DR increments already in place (marked in
the files). **Before you start, complete [Prepare the shared DR values](#prepare-the-shared-dr-values)
and point the platform domain at the primary VIP.** For a single cluster without DR, use the
[Single cluster](#single-cluster) variant. The steps are shown for the primary; the standby runs the
same steps with `global-standby.env` and `global-standby/` (see
[Install the primary and the standby](#install-the-primary-and-the-standby)).

Each side needs its own bootstrap node — 4 cores and 8 GB minimum (x86_64), 300 GB disk, a
traditional Linux operating system and a static IP — see
[Bootstrap Node Requirements](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-requirements).
The simplest placement is an ECS in the same VPC as the `global` nodes.

#### Step 1: Create the bootstrap cluster

```bash
# on the bootstrap node, in the delivery directory
load_env global-primary.env
mkdir -p /root/cpaas-install
tar -xvf "${CORE_PACKAGE}" -C /root/cpaas-install
( cd /root/cpaas-install/installer && bash setup.sh )
if ! command -v kubectl >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  nerdctl cp minialauda-control-plane:/usr/bin/kubectl "$HOME/.local/bin/kubectl"
  chmod 0755 "$HOME/.local/bin/kubectl"
  export PATH="$HOME/.local/bin:$PATH"
fi
( umask 077; mkdir -p "$(dirname "${BOOTSTRAP_KUBECONFIG}")"; cp /var/cpaas/data/alauda.kubeconfig "${BOOTSTRAP_KUBECONFIG}" )
# Steps 4 and 8 call envsubst (gettext) directly
command -v envsubst >/dev/null || echo "envsubst missing - install gettext before Step 4"
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get nodes
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get pods
```

The bootstrap cluster `minialauda` is `Ready` and the installer Pods run. Both `global` cluster
files use the same `BOOTSTRAP_KUBECONFIG` path, so run every `# on the bootstrap cluster` command on
that side's own bootstrap node.

#### Step 2: Install the provider packages

```bash
# on the bootstrap node
/root/cpaas-install/installer/res/amd64/packtool pack push \
  -r "${LOCAL_REGISTRY_ADDRESS}" -c "${HCS_PROVIDER_PACK}"
/root/cpaas-install/installer/res/amd64/packtool pack push \
  -r "${LOCAL_REGISTRY_ADDRESS}" -c "${KUBEADM_PROVIDER_PACK}"
# the tags must contain HCS_PROVIDER_VERSION and KUBEADM_PROVIDER_VERSION
curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/ait/chart-cluster-api-provider-hcs/tags/list"; echo
curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/ait/chart-cluster-api-provider-kubeadm/tags/list"; echo
# on the bootstrap cluster
apply_rendered global-primary.env global-primary/00-provider-appreleases.yaml "${BOOTSTRAP_KUBECONFIG}"
until kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get crd kubeadmcontrolplanes.controlplane.cluster.x-k8s.io >/dev/null 2>&1; do sleep 10; done
until kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get crd hcsclusters.infrastructure.cluster.x-k8s.io >/dev/null 2>&1; do sleep 10; done
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get apprelease \
  -o custom-columns='NAME:.metadata.name,REQUESTED:.spec.source.charts[*].targetRevision,INSTALLED:.status.charts[*].installedRevision,PHASE:.status.charts[*].phase'
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get crd | grep -E '^hcs.*\.infrastructure\.cluster\.x-k8s\.io'
```

Both releases report `Success` with the requested revision, and the four `hcs*` CRDs exist
(`hcsclusters`, `hcsmachines`, `hcsmachinetemplates`, `hcsmachineconfigpools`).

#### Step 3: Create the credential Secret

Point the credential block at the bootstrap cluster, run
[Create the credential Secret](#create-the-credential-secret), then check the Secret:

```bash
# on the bootstrap cluster
KUBECONFIG_FOR_SECRET="${BOOTSTRAP_KUBECONFIG}"
# ... the commands of "Create the credential Secret" ...
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}"
```

#### Step 4: Apply the control plane

Five files. The pool assigns hostnames, IPs and the `/var/cpaas` disk; the template sets image,
flavor, zone and temporary volumes:

`global-primary/10-cp-pool.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineConfigPool
metadata:
  name: global-cp-pool
  namespace: cpaas-system
  labels:
    cluster.x-k8s.io/cluster-name: global
spec:
  configs:
    - hostname: ${CP1_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${CP1_IP}
      persistentDisks:
        - slot: 0
          size: ${CP_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${CP2_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${CP2_IP}
      persistentDisks:
        - slot: 0
          size: ${CP_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${CP3_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${CP3_IP}
      persistentDisks:
        - slot: 0
          size: ${CP_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
```

`global-primary/11-cp-template.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineTemplate
metadata:
  name: global-cp-machine-template
  namespace: cpaas-system
spec:
  template:
    spec:
      imageName: ${HCS_IMAGE_NAME}
      flavorName: ${HCS_CP_FLAVOR}
      availabilityZone: ${HCS_CP_AZ}
      rootVolume:
        type: ${HCS_DISK_TYPE}
        size: 100
      configPoolRef:
        name: global-cp-pool
      dataVolumes:
        - size: 10
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/etcd
          format: xfs
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/kubelet
          format: xfs
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/containerd
          format: xfs
```

The `KubeadmControlPlane` body is the one from
[Creating Clusters on Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html#using-yaml)
with the `global` changes: `global-` names, `format: cloud-config`, the etcd server certificate SANs,
and the encryption provider entry. Keep `apiServer.extraArgs.encryption-provider-config`. The kubelet
setting `imagePullCredentialsVerificationPolicy` is required because ACP 4.4 runs Kubernetes 1.35.

`global-primary/12-kcp.yaml`

```yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: global-kcp
  namespace: cpaas-system
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
      kind: HCSMachineTemplate
      name: global-cp-machine-template
  kubeadmConfigSpec:
    format: cloud-config
    files:
      - path: /etc/kubernetes/admission/psa-config.yaml
        owner: root:root
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
        owner: root:root
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
        owner: root:root
        permissions: "0644"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          rules:
          - level: Metadata
      # DR increment: identical on the primary and the standby.
      - path: /etc/kubernetes/encryption-provider.conf
        owner: "root:root"
        append: false
        permissions: "0644"
        content: |
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
    clusterConfiguration:
      imageRepository: ${IMAGE_REPOSITORY}
      dns:
        imageTag: ${DNS_IMAGE_TAG}
      etcd:
        local:
          imageTag: ${ETCD_IMAGE_TAG}
          # DR increment: the same list on the primary and the standby.
          serverCertSANs:
            - "${PRIMARY_CLUSTER_VIP}"
            - "${STANDBY_CLUSTER_VIP}"
            - "${PLATFORM_HOST}"
            - "etcd.kube-system"
      apiServer:
        extraArgs:
          audit-log-format: json
          audit-log-mode: batch
          audit-log-path: /etc/kubernetes/audit/audit.log
          audit-policy-file: /etc/kubernetes/audit/policy.yaml
          admission-control-config-file: /etc/kubernetes/admission/psa-config.yaml
          encryption-provider-config: /etc/kubernetes/encryption-provider.conf
          kubelet-certificate-authority: /etc/kubernetes/pki/ca.crt
          profiling: "false"
          tls-min-version: VersionTLS12
        extraVolumes:
          - name: vol-dir-0
            hostPath: /etc/kubernetes
            mountPath: /etc/kubernetes
            pathType: Directory
      controllerManager:
        extraArgs:
          bind-address: "::"
          flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          profiling: "false"
          tls-min-version: VersionTLS12
      scheduler:
        extraArgs:
          bind-address: "::"
          profiling: "false"
          tls-min-version: VersionTLS12
    postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
    initConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
          protect-kernel-defaults: "true"
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
```

`global-primary/13-hcscluster.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSCluster
metadata:
  name: global
  namespace: cpaas-system
spec:
  controlPlaneHA:
    enabled: true
    policy: ${HCS_CP_HA_POLICY}
  controlPlaneLoadBalancer:
    vipAddress: ${CONTROL_PLANE_VIP}
    vipSubnetName: ${HCS_SUBNET_NAME}
    elbVirsubnetL4Ips:
      - subnetName: ${HCS_SUBNET_NAME}
        ips:
          - ${HCS_ELB_L4_IP_1}
          - ${HCS_ELB_L4_IP_2}
    elbVirsubnetL7Ips:
      - subnetName: ${HCS_SUBNET_NAME}
        ips:
          - ${HCS_ELB_L7_IP_1}
          - ${HCS_ELB_L7_IP_2}
  networkType: kube-ovn
  network:
    vpc:
      name: ${HCS_VPC_NAME}
    subnets:
      - name: ${HCS_SUBNET_NAME}
    securityGroup:
      name: ${HCS_SECURITY_GROUP_NAME}
  identityRef:
    name: ${PROVIDER_SECRET_NAME}
```

If the ELB VIP must sit in another subnet than the nodes, add that subnet as a second
`spec.network.subnets` entry and point `vipSubnetName` (or the L4/L7 `subnetName`) at it — every
referenced subnet must be in the list.

The `Cluster` carries the HCS annotations of the create-cluster page plus the `global` label and the
temporary registry address (the installer rewrites it to the permanent `global` registry later):

`global-primary/14-cluster.yaml`

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: global
  namespace: cpaas-system
  labels:
    cluster-type: HCS
    is-global: "true"
  annotations:
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: HCSCluster
    cpaas.io/registry-address: "${NODE_REGISTRY_ADDRESS}"
    cpaas.io/sentry-deploy-type: Baremetal
    cpaas.io/alb-address-type: ClusterAddress
    cpaas.io/kube-ovn-join-cidr: ${KUBE_OVN_JOIN_CIDR}
    cpaas.io/kube-ovn-version: ${KUBE_OVN_VERSION}
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
    kind: HCSCluster
    name: global
```

Check before applying: exactly three control plane entries; no CIDR overlaps the node, VIP or HCS
subnets, another cluster or a customer network; the VIP is an IP address; `/root/dr/encryption-key.b64`
exists. Apply the pool and the template:

```bash
# on the bootstrap cluster
for f in 10-cp-pool 11-cp-template; do
  apply_rendered global-primary.env "global-primary/$f.yaml" "${BOOTSTRAP_KUBECONFIG}" || break
done
```

The `KubeadmControlPlane` needs the shared key, which is injected from its protected file into a
rendered copy inside `/root/dr` (mode `700`) and deleted after the apply:

```bash
# on the bootstrap cluster
if [ -s /root/dr/encryption-key.b64 ]; then
  render global-primary.env global-primary/12-kcp.yaml \
    | ENCRYPTION_PROVIDER_SECRET_B64="$(cat /root/dr/encryption-key.b64)" \
      envsubst '${ENCRYPTION_PROVIDER_SECRET_B64}' > /root/dr/12-kcp.yaml
  if grep -n '\${' /root/dr/12-kcp.yaml; then
    echo "unreplaced variables - nothing applied"
  else
    kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply --dry-run=server -f /root/dr/12-kcp.yaml >/dev/null \
      && kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply -f /root/dr/12-kcp.yaml
  fi
  rm -f /root/dr/12-kcp.yaml
else
  echo "shared DR key missing - see Prepare the shared DR values"
fi
```

By product design the key becomes part of the `KubeadmControlPlane` object. Treat read access to
`KubeadmControlPlane` objects in `cpaas-system` as access to the key, and archive the template of
`12-kcp.yaml`, never a rendered copy. The common archive scan matches `aescbc` in the `12-kcp.yaml`
templates; every hit must be followed by `${ENCRYPTION_PROVIDER_SECRET_B64}` or
`bootstrap-placeholder`, never a key. When the `KubeadmControlPlane` applied without error, create the
infrastructure cluster and the `Cluster`:

```bash
# on the bootstrap cluster
for f in 13-hcscluster 14-cluster; do
  apply_rendered global-primary.env "global-primary/$f.yaml" "${BOOTSTRAP_KUBECONFIG}" || break
done
```

#### Step 5: Wait for the control plane

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get cluster global
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane global-kcp
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machines,hcsmachines
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get hcscluster global \
  -o jsonpath='ready={.status.ready} endpoint={.spec.controlPlaneEndpoint.host}:{.spec.controlPlaneEndpoint.port}{"\n"}'
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get hcscluster global \
  -o jsonpath='{range .status.conditions[?(@.type=="ControlPlaneHAReady")]}{.status} {.reason} {.message}{"\n"}{end}'
# on the bootstrap node
curl -sk "https://${CONTROL_PLANE_VIP}:6443/readyz"; echo
```

The control plane is ready when `KubeadmControlPlane` is `Ready` with 3 replicas, the `Cluster` is
`Provisioned`, the `HCSCluster` is ready with the endpoint `${CONTROL_PLANE_VIP}:6443`, and
`ControlPlaneHAReady` is `True`. A machine that stays `Pending` shows the HCS reason (quota, network,
credential) on its conditions (`kubectl describe machine`). Save the kubeconfig that Cluster API
publishes — it points at the VIP — as the common article's
[Prepare the parameter files](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files)
describes:

```bash
# on the bootstrap cluster
( umask 077; mkdir -p "$(dirname "${CLUSTER_KUBECONFIG}")"
  kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret global-kubeconfig \
    -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}" )
# on global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide
```

#### Step 6: Add the infra pool

Three `infra` nodes carry monitoring and logging of `global`. The role label, the `worker` label (the
default worker MachineConfigPool selects on it) and the taint are declared on the pool:

`global-primary/20-infra-pool.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineConfigPool
metadata:
  name: global-infra-pool
  namespace: cpaas-system
  labels:
    cluster.x-k8s.io/cluster-name: global
spec:
  configs:
    - hostname: ${INFRA1_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${INFRA1_IP}
      persistentDisks:
        - slot: 0
          size: ${INFRA_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${INFRA2_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${INFRA2_IP}
      persistentDisks:
        - slot: 0
          size: ${INFRA_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${INFRA3_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${INFRA3_IP}
      persistentDisks:
        - slot: 0
          size: ${INFRA_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
```

The temporary volumes use the control plane sizes rather than the 20 GB of the generic worker
example: `infra` nodes pull large platform images, and their Pod logs land on the containerd volume.

`global-primary/21-infra-template.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineTemplate
metadata:
  name: global-infra-template
  namespace: cpaas-system
spec:
  template:
    spec:
      imageName: ${HCS_IMAGE_NAME}
      flavorName: ${HCS_INFRA_FLAVOR}
      availabilityZone: ${HCS_INFRA_AZ}
      rootVolume:
        type: ${HCS_DISK_TYPE}
        size: 100
      configPoolRef:
        name: global-infra-pool
      dataVolumes:
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/kubelet
          format: xfs
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/containerd
          format: xfs
```

`global-primary/22-infra-kct.yaml`

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: global-infra-kct
  namespace: cpaas-system
spec:
  template:
    spec:
      files:
        - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
          owner: root:root
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
      postKubeadmCommands:
        - chmod 600 /var/lib/kubelet/config.yaml
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
        nodeRegistration:
          kubeletExtraArgs:
            volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
```

`global-primary/23-infra-md.yaml`

```yaml
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
  template:
    metadata:
      labels:
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: global
      version: "${K8S_VERSION}"
      nodeDrainTimeout: 1m
      nodeDeletionTimeout: 5m
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: global-infra-kct
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: HCSMachineTemplate
        name: global-infra-template
      taints:
        - key: node-role.kubernetes.io/infra
          value: reserved
          effect: NoSchedule
```

```bash
# on the bootstrap cluster
for f in 20-infra-pool 21-infra-template 22-infra-kct 23-infra-md; do
  apply_rendered global-primary.env "global-primary/$f.yaml" "${BOOTSTRAP_KUBECONFIG}" || break
done
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machinedeployment global-infra
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machines -l cluster.x-k8s.io/cluster-name=global -o wide
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get hcsmachineconfigpool \
  -o custom-columns='NAME:.metadata.name,TOTAL:.status.totalCount,AVAILABLE:.status.availableCount'
# on global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

Continue when six machines are `Running` (three control plane, three `infra`), `global-infra` reports
3/3 ready, both pools have no available entry left, and the `infra` nodes carry the taint. Their role
labels appear once label synchronization is enabled in the common steps.

#### Step 7: Import provider resources

The installer copies the HCS resources and the credential Secret into the new `global` cluster only
if this ConfigMap exists before Step 8 — on every HCS `global` installation, with or without DR. The
`dcs` prefix of its name is historical. A missing ConfigMap is a silent failure: `global` installs,
but its HCS provider has no credential and fails at the first scale-out or node replacement.

`global-primary/30-import-extra-resources.yaml`

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: dcs-import-extra-resources
  namespace: cpaas-system
data:
  resources.yaml: |
    resources:
    - resource: "secrets"
      names: ["${PROVIDER_SECRET_NAME}"]
      method: kubectl
    - resource: "hcsclusters.infrastructure.cluster.x-k8s.io"
      names: ["global"]
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/hcsclusters/cpaas-system/"
      method: etcdctl
    - resource: "hcsmachinetemplates.infrastructure.cluster.x-k8s.io"
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/hcsmachinetemplates/cpaas-system/"
      method: etcdctl
    - resource: "hcsmachineconfigpools.infrastructure.cluster.x-k8s.io"
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/hcsmachineconfigpools/cpaas-system/"
      method: etcdctl
    - resource: "hcsmachines.infrastructure.cluster.x-k8s.io"
      etcdKeyBase: "/registry/infrastructure.cluster.x-k8s.io/hcsmachines/cpaas-system/"
      method: etcdctl
```

```bash
# on the bootstrap cluster
apply_rendered global-primary.env global-primary/30-import-extra-resources.yaml "${BOOTSTRAP_KUBECONFIG}"
```

#### Step 8: Trigger the platform installation

The HCS request body has no `cluster` block — the ELB in `HCSCluster` owns the VIP. `console.host` is
the local VIP, never the domain; the platform domain goes into `console.globalHost`. The registry
user and the two passwords are intentional placeholders, filled at submit time:

`global-primary/40-installer-config.json`

```json
{
  "basic": {
    "username": "admin@cpaas.io",
    "password": "${PLATFORM_ADMIN_PASSWORD_B64}"
  },
  "registry": {
    "domain": "${REGISTRY_DOMAIN}",
    "username": "${REGISTRY_USERNAME}",
    "password": "${REGISTRY_PASSWORD_B64}"
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
  "product": [
    "base",
    "acp"
  ],
  "deployMode": "normal",
  "hostIP": "${HOST_IP}"
}
```

In a DR delivery replace `console.cert` with the shared platform certificate first — see
[Prepare the shared DR values](#prepare-the-shared-dr-values). The request is piped straight to the
installer, so the passwords never reach a file:

```bash
# on the bootstrap node
INSTALLER_IP=$(kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get pods -n cpaas-system \
  -l service_name=cpaas-installer -o jsonpath='{.items[0].status.podIP}')
# exactly the three intentional placeholders may remain:
render global-primary.env global-primary/40-installer-config.json | grep -n '\${'
read -rsp 'Platform admin password: ' PLATFORM_ADMIN_PASSWORD; echo
read -rp 'Platform registry user: ' REGISTRY_USERNAME
read -rsp 'Platform registry password: ' REGISTRY_PASSWORD; echo
render global-primary.env global-primary/40-installer-config.json \
  | REGISTRY_USERNAME="${REGISTRY_USERNAME}" \
    PLATFORM_ADMIN_PASSWORD_B64="$(printf '%s' "${PLATFORM_ADMIN_PASSWORD}" | base64 -w0)" \
    REGISTRY_PASSWORD_B64="$(printf '%s' "${REGISTRY_PASSWORD}" | base64 -w0)" \
    envsubst '${REGISTRY_USERNAME} ${PLATFORM_ADMIN_PASSWORD_B64} ${REGISTRY_PASSWORD_B64}' \
  | curl -k -X POST "http://${INSTALLER_IP}:8080/cpaas-installer/api/config/dcs" \
      -H 'Content-Type: application/json' -d @-
unset PLATFORM_ADMIN_PASSWORD REGISTRY_USERNAME REGISTRY_PASSWORD
```

The endpoint path ends in `/dcs` for every provider. In a DR pair, use the same administrator
password and the same registry user and password on both sides.

#### Step 9: Monitor and verify

```bash
# on the bootstrap node
curl -s "http://${INSTALLER_IP}:8080/cpaas-installer/api/progress"; echo
tail -f /var/cpaas/data/installer.log
```

A typical installation takes 30–60 minutes; for stalls, use the table under Step 9 of the
installation guide. When the progress API reports `status: Success` and `type: Complete`:

```bash
# on global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get clusters.platform.tkestack.io global -o jsonpath='{.status.phase}{"\n"}'
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get pods --field-selector=status.phase!=Running,status.phase!=Succeeded
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get clustermodule global
# the HCS handoff: credential, HCS resources and providers now live on global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}"
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get hcscluster,hcsmachinetemplate,hcsmachineconfigpool,hcsmachine
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get apprelease \
  -o custom-columns='NAME:.metadata.name,INSTALLED:.status.charts[*].installedRevision,PHASE:.status.charts[*].phase' | grep -E 'NAME|provider'
# on the bootstrap node - the global ELB listeners: any HTTP status proves a listener, a timeout does not
for p in 6443 443 11443; do
  curl -sk -o /dev/null -w "$p %{http_code}\n" "https://${CONTROL_PLANE_VIP}:$p/"
done
timeout 3 bash -c "</dev/tcp/${CONTROL_PLANE_VIP}/2379" && echo "2379 open"
```

Pass criteria: six `Ready` nodes (three control plane, three `infra`, nothing else); the platform
cluster phase is `Running`; no failing Pods in `cpaas-system`; `ClusterModule/global` healthy; the
credential Secret and all HCS resources present on `global`; both provider releases `Success`; all
four ELB ports answer.

#### Step 10: Retire the bootstrap cluster

Keep the bootstrap cluster until the side is verified — in a DR delivery until etcd-sync is verified
(stage 12 of the delivery flow). Then remove the temporary `minialauda` cluster and its KIND network
on the bootstrap node as
[Decommission the Bootstrap Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html#decommission-bootstrap-cluster)
describes, after the checks of Step 9 passed and `${CLUSTER_KUBECONFIG}` is saved. Never delete the
`Cluster`, `KubeadmControlPlane` or HCS objects as a cleanup step — they own the live `global`
machines, and deleting them deletes the control plane VMs.

### Add disaster recovery

DR on HCS follows [Optional Disaster Recovery Deployment](https://docs.alauda.io/immutable-infra/1.0/global/install.html#optional-disaster-recovery-deployment)
and the [HCS provider notes](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#provider-notes).
Each side is a complete installation from its own bootstrap node — never reuse one bootstrap node for
both, because until handoff it holds the installer, registry and provider resources of the side it
installs.

#### What changes for DR on HCS

| Increment | Where | Rule |
| --- | --- | --- |
| Shared encryption key | `encryption-provider.conf` entry in `12-kcp.yaml` | Same key on both sides. HCS uses the `KubeadmControlPlane` file entry — no `HCSCluster` Secret reference. A different key installs cleanly; Secrets synchronized to the standby then cannot be decrypted, which surfaces only at failover |
| etcd server certificate SANs | `serverCertSANs` in `12-kcp.yaml` | Both VIPs, the platform domain and `etcd.kube-system`, identical on both sides. Never copy them into the platform certificate |
| Import ConfigMap | `30-import-extra-resources.yaml` | Created on both sides before Step 8 |
| Provider fields | `console.host` and `HCSCluster.spec.controlPlaneLoadBalancer.vipAddress` | Each side's own VIP — `CONTROL_PLANE_VIP` from its cluster file |
| Platform certificate | `console.cert` in `40-installer-config.json` | The same trusted certificate on both sides (delivery standard, see below) |
| Credentials | Administrator password, registry user and password, credential Secret name | The same on both sides. Workload `HCSCluster` objects reference the credential Secret by name and must reconcile on whichever side is active |

The first four are already in the manifests, and an identical `site.env` on both sides keeps the SAN
list and the names aligned.

The product pages disagree on how HCS pins the key. The DR procedure
([Add Provider-Specific DR Fields](https://docs.alauda.io/immutable-infra/1.0/global/install.html#add-provider-specific-dr-fields),
HCS tab, and the HCS provider notes) uses the `KubeadmControlPlane` file entry, and this article
follows it. [Configure KubeadmControlPlane](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html#using-yaml)
says that a controller-generated file takes precedence over a bootstrap file at that path, and the
`HCSCluster` API also offers `spec.encryptionProviderConfigRef`. Do not add that reference on your own
initiative. Instead, the node-level check before etcd-sync (step 8 below) proves on the running
control plane nodes that both sides use the same key. If they do not, stop and escalate.

#### Prepare the shared DR values

Generate the encryption key once and give both bootstrap nodes the same file:

```bash
# on the primary bootstrap node, once
install -d -m 700 /root/dr
( umask 077; head -c 32 /dev/urandom | base64 > /root/dr/encryption-key.b64 )
```

Copy `/root/dr/encryption-key.b64` to `/root/dr/` (mode `700` directory, mode `600` file) on the
standby bootstrap node over an encrypted channel. It is a secret: never put it into a parameter file,
a ticket or the delivery archive, and keep it only as long as the customer's key-handling policy
allows — rebuilding a side needs it. Then prove that both bootstrap nodes hold the same inputs:

```bash
# on each bootstrap node, in the delivery directory - the two outputs must be identical
sha256sum /root/dr/encryption-key.b64 site.env
```

Platform certificate: the installation guide requires one shared trusted certificate for Bare Metal
DR and is silent for HCS. This design applies the same rule to HCS, because the standby and its
etcd-sync reach the active platform through the one domain. Two unrelated self-signed certificates
would change the certificate behind that domain at every switch. Obtain one trusted certificate whose
SAN covers `${PLATFORM_HOST}` (add a VIP only if clients use HTTPS directly on that VIP). On both sides,
replace `"selfSigned": {}` in `40-installer-config.json` with the `thirdParty` block described under
*Third-Party Console Certificates* in Step 8 of the installation guide. Fill in its certificate and
key fields at submit time, the same way as the passwords. Never store the private key in the
template.

Lower the TTL of the platform domain's DNS record before you start; the delivery switches it three
times.

#### Install the primary and the standby

The order is fixed, and it matches stages 7–12 of the common
[Delivery flow](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#delivery-flow).
What switches is the platform domain; each cluster is always reached by its own VIP.

1. Point `${PLATFORM_HOST}` at `${PRIMARY_CLUSTER_VIP}` and check it from the primary bootstrap node
   with `getent hosts "${PLATFORM_HOST}"`.
2. On the primary bootstrap node, run [Install the global cluster](#install-the-global-cluster)
   Steps 1–9 with `global-primary.env` and `global-primary/`.
3. On the primary, complete the common stage 8: upload the packages, enable label synchronization,
   install Machine Configuration and configure the machines, then monitoring and logging
   ([Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)).
4. Point `${PLATFORM_HOST}` at `${STANDBY_CLUSTER_VIP}` and check it from the standby bootstrap node.
   Several platform resources are rendered with the domain while the standby installer runs, so it
   must resolve to the side being installed.
5. On the standby bootstrap node, copy the manifest directory (`cp -r global-primary global-standby`)
   and run Steps 1–9 with `global-standby.env` and `global-standby/` — in every command, replace
   `global-primary` with `global-standby`. The manifests are identical; the cluster file gives the
   standby its own VIP in `console.host` and `vipAddress`, its own `hostIP`, and its own kubeconfigs.
   Take `INSTALLER_IP` from the standby bootstrap cluster.
6. On the standby, complete the common stage 10 — the same plugins, uploaded through the standby's
   own VIP and registry.
7. Point `${PLATFORM_HOST}` back at `${PRIMARY_CLUSTER_VIP}` **before** installing etcd-sync: the
   primary is the source of the first synchronization, and etcd-sync refuses to start when the domain
   points at a cluster that runs etcd-sync itself.
8. Prove that both control planes use the same encryption key. Run the command on one control plane
   node of each side (log in as `boot`; the key arrived with the machine configuration). The two
   hashes must be identical. If they differ, the standby cannot decrypt synchronized Secrets: do not
   install etcd-sync. Resolve it with the platform team.

   ```bash
   # on a node: one control-plane node of the primary, then one of the standby
   sudo sha256sum /etc/kubernetes/encryption-provider.conf
   ```

9. [Install etcd-sync (ACP 4.4.0+)](#install-etcd-sync-acp-440) on the standby, then
   [check the DR pair](#check-the-dr-pair) and retire both bootstrap clusters (Step 10).

From step 7 on, the commands touch both sides at once. Run them on the delivery host, which holds a
copy of both `global` kubeconfigs (copied from the bootstrap nodes over an encrypted channel), and
name the two kubeconfigs explicitly. Confirm the switch-back from inside both clusters as well,
because cluster DNS can keep the old answer:

```bash
# on global (both sides), in the delivery directory
load_env global-primary.env
export PRIMARY_GLOBAL_KUBECONFIG=/root/.kube/acp/global-primary.kubeconfig
export STANDBY_GLOBAL_KUBECONFIG=/root/.kube/acp/global-standby.kubeconfig
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system exec deployments/sentry -- nslookup "${PLATFORM_HOST}"
done
```

Both clusters must resolve `${PLATFORM_HOST}` to `${PRIMARY_CLUSTER_VIP}`. If one does not, restart
its CoreDNS Pods and retry.

#### Install etcd-sync (ACP 4.4.0+)

Install the `etcd-sync` plugin on the standby only, as in
[Install etcd-sync (ACP 4.4.0+)](https://docs.alauda.io/immutable-infra/1.0/global/install.html#install-etcd-sync).
The package is published as `etcd-sync` (`packages/etcd-sync/<minor>/etcd-sync.amd64.<version>.tgz`),
not as `global-etcd-sync`, and is not in the installer bundle; the common article's package upload to
the standby (step 6 above) must include it:

```bash
# on global (standby): the plugin must be published here, not only on the primary
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" get moduleplugins | grep -i etcd
```

Create the token Secret on the standby with the primary's `k8sadmin` token. Use `kubectl create`; the
`--dry-run | kubectl apply` form of the product page records the token in
`last-applied-configuration`. The token passes from one cluster to the other through a shell
variable and is never displayed or stored:

```bash
# on global (primary, then standby)
ACTIVE_CLUSTER_TOKEN=$(kubectl --kubeconfig "${PRIMARY_GLOBAL_KUBECONFIG}" -n cpaas-system \
  get secret k8sadmin -o jsonpath='{.data.token}' | base64 -d)
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system create secret generic \
  etcd-sync-active-cluster-token --from-file=token=<(printf '%s' "${ACTIVE_CLUSTER_TOKEN}")
unset ACTIVE_CLUSTER_TOKEN
```

When you repeat this step, delete the old Secret first; `create` does not overwrite. Then, in the
standby web console (`https://${STANDBY_CLUSTER_VIP}`), **Administrator** > **Marketplace** >
**Cluster Plugins**, cluster `global`, install **Alauda Container Platform etcd Synchronizer** with:

| Parameter | Value |
| --- | --- |
| Active Global Cluster VIP | `${PRIMARY_CLUSTER_VIP}` |
| Active Global Cluster ETCD Endpoints | `https://${PRIMARY_CLUSTER_VIP}:2379` — the primary's HCS ELB forwards `2379` |
| Standby Cluster ETCD Endpoints | Default |
| Active Global Cluster Token Secret | `etcd-sync-active-cluster-token` |
| Data Check Interval | Default |
| Print detail logs | Disabled |

```bash
# on global (standby)
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get job etcd-sync-bootstrap
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get secret remote-etcd-ca remote-etcd-client
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get issuer remote-etcd-issuer
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get certificate remote-etcd-client
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get pods -l app=etcd-sync
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get lease etcd-sync-mirror -o jsonpath='{.spec.holderIdentity}{"\n"}'
```

The monitor Service has only a cluster IP, so run the consistency check on a standby control plane
node. An answer of HTTP `425` means a check is not allowed yet; the loop retries:

```bash
# on a node: a control-plane node of the standby
mirror_host=$(sudo kubectl -n cpaas-system get svc etcd-sync-monitor -o jsonpath='{.spec.clusterIP}')
case "$mirror_host" in *:*) mirror_host="[$mirror_host]" ;; esac   # IPv6 Service address
until code=$(curl -sg -o /tmp/etcd-sync-check.txt -w '%{http_code}' "http://$mirror_host/check") && [ "$code" != 425 ]; do sleep 30; done
cat /tmp/etcd-sync-check.txt
```

The bootstrap Job completes, the runtime resources exist, the leader holds the lease, and the check
reports zero missed and zero surplus keys. Missed keys usually clear after restarting the current
leader Pod; surplus keys are resolved with the platform team, never deleted on a guess. Then restart
the Pods that load the DR endpoint configuration, on both sides:

```bash
# on global (both sides)
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system delete po -l 'service_name in (alertmanager,vmselect,vminsert)'
  kubectl --kubeconfig "$kc" -n cpaas-system delete po -l service_name=cluster-transformer
done
```

#### Check the DR pair

```bash
# on global (both sides) - each pair of lines must be identical
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system get kubeadmcontrolplane global-kcp \
    -o jsonpath='{.spec.kubeadmConfigSpec.clusterConfiguration.etcd.local.serverCertSANs}{"\n"}'
done
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system get kubeadmcontrolplane global-kcp \
    -o jsonpath='{.spec.kubeadmConfigSpec.files[?(@.path=="/etc/kubernetes/encryption-provider.conf")].content}' | sha256sum
done
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}" -o name
done
# on the delivery host
getent hosts "${PLATFORM_HOST}"
```

Pass criteria: both sides passed Step 9; the SAN lists and the declared encryption hashes are
identical, and the node-level check of step 8 passed; the credential Secret exists on both sides; the
platform domain resolves to the primary VIP; the etcd-sync check reports zero differences. The
failover drill is part of acceptance — see
[Continue with the common steps](#continue-with-the-common-steps). Before any failover or DR-aware
upgrade uninstalls etcd-sync, the consistency check must show zero differences: on Immutable
Infrastructure an inconsistent sync can delete workload `Machine` objects and their VMs.

### Create a workload cluster

Workload clusters are created on `global` — the active side, the primary in normal operation — from
YAML, as in [Creating Clusters on Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html#using-yaml).
A guided [web UI](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html#using-the-web-ui)
also exists (Fleet Essentials `1.0.2`+ with HCS provider `v1.0.3`+), but its node pool steps do not set
labels or taints, so this article uses YAML.

#### Before you start

```bash
# on global
load_env wl-prod.env
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get apprelease \
  -o custom-columns='NAME:.metadata.name,CHART:.spec.source.charts[*].name,INSTALLED:.status.charts[*].installedRevision,PHASE:.status.charts[*].phase' | grep -E 'NAME|provider'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get crd | grep -E '^hcs.*\.infrastructure\.cluster\.x-k8s\.io'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}'
```

The HCS provider is installed at `v1.0.4` or later and `Success`; label synchronization is enabled
(the common stage 8); the credential Secret exists. A workload cluster in the same HCS project and
region references the Secret that `global` already holds. For another project or region, set a new
`PROVIDER_SECRET_NAME` in the cluster file and override `HCS_PROJECT_ID` (and `HCS_REGION`,
`HCS_EXTERNAL_GLOBAL_DOMAIN` if they differ) there. Then run
[Create the credential Secret](#create-the-credential-secret) with
`KUBECONFIG_FOR_SECRET="${GLOBAL_KUBECONFIG}"`, and in a DR pair repeat it against the standby
`global`, with the same name. `cpaas-system` is excluded from etcd synchronization, so a Secret that
exists only on the primary is missing after a failover. The cluster
pulls platform images from the `global` registry by default; see
[Choose the Image Registry for a Workload Cluster](https://docs.alauda.io/immutable-infra/1.0/how-to/workload-cluster-image-registry.html)
for a dedicated registry.

#### Naming

`Cluster` and `HCSCluster` are named `${CLUSTER_NAME}` — lowercase letters, digits and hyphens, never
`global` and never starting with `global-`: failover selects resources by that prefix and would treat
them as `global`'s. Every other resource is prefixed `${CLUSTER_NAME}-`. Everything lives in
`cpaas-system`. One manifest set per cluster: copy `wl-prod/` and `wl-prod.env` for the next cluster
and change every value — a value left over from another cluster modifies that cluster's resources.

#### Manifests

`wl-prod/10-cp-pool.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineConfigPool
metadata:
  name: ${CLUSTER_NAME}-cp-pool
  namespace: cpaas-system
  labels:
    cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
spec:
  configs:
    - hostname: ${CP1_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${CP1_IP}
      persistentDisks:
        - slot: 0
          size: ${CP_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${CP2_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${CP2_IP}
      persistentDisks:
        - slot: 0
          size: ${CP_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${CP3_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${CP3_IP}
      persistentDisks:
        - slot: 0
          size: ${CP_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
```

`wl-prod/11-cp-template.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-control-plane
  namespace: cpaas-system
spec:
  template:
    spec:
      imageName: ${HCS_IMAGE_NAME}
      flavorName: ${HCS_CP_FLAVOR}
      availabilityZone: ${HCS_CP_AZ}
      rootVolume:
        type: ${HCS_DISK_TYPE}
        size: 100
      configPoolRef:
        name: ${CLUSTER_NAME}-cp-pool
      dataVolumes:
        - size: 10
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/etcd
          format: xfs
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/kubelet
          format: xfs
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/containerd
          format: xfs
```

The workload `KubeadmControlPlane` is the create-cluster body with its placeholder encryption entry —
the HCS controller generates the real key for the first control plane machine and reuses it for the
others:

`wl-prod/12-kcp.yaml`

```yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: ${CLUSTER_NAME}-kcp
  namespace: cpaas-system
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
      kind: HCSMachineTemplate
      name: ${CLUSTER_NAME}-control-plane
  kubeadmConfigSpec:
    format: cloud-config
    files:
      - path: /etc/kubernetes/admission/psa-config.yaml
        owner: root:root
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
        owner: root:root
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
      # Placeholder only: the HCS controller writes the real file.
      - path: /etc/kubernetes/encryption-provider.conf
        owner: root:root
        permissions: "0600"
        content: |
          apiVersion: apiserver.config.k8s.io/v1
          kind: EncryptionConfiguration
          resources:
          - resources:
            - secrets
            providers:
            - aescbc:
                keys:
                - name: key1
                  secret: bootstrap-placeholder
      - path: /etc/kubernetes/audit/policy.yaml
        owner: root:root
        permissions: "0644"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          rules:
          - level: Metadata
    clusterConfiguration:
      imageRepository: ${IMAGE_REPOSITORY}
      dns:
        imageTag: ${DNS_IMAGE_TAG}
      etcd:
        local:
          imageTag: ${ETCD_IMAGE_TAG}
      apiServer:
        extraArgs:
          audit-log-format: json
          audit-log-mode: batch
          audit-log-path: /etc/kubernetes/audit/audit.log
          audit-policy-file: /etc/kubernetes/audit/policy.yaml
          admission-control-config-file: /etc/kubernetes/admission/psa-config.yaml
          encryption-provider-config: /etc/kubernetes/encryption-provider.conf
          kubelet-certificate-authority: /etc/kubernetes/pki/ca.crt
          profiling: "false"
          tls-min-version: VersionTLS12
        extraVolumes:
          - name: vol-dir-0
            hostPath: /etc/kubernetes
            mountPath: /etc/kubernetes
            pathType: Directory
      controllerManager:
        extraArgs:
          bind-address: "::"
          flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          profiling: "false"
          tls-min-version: VersionTLS12
      scheduler:
        extraArgs:
          bind-address: "::"
          profiling: "false"
          tls-min-version: VersionTLS12
    postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
    initConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
          protect-kernel-defaults: "true"
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
```

`wl-prod/13-hcscluster.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
spec:
  controlPlaneHA:
    enabled: true
    policy: ${HCS_CP_HA_POLICY}
  controlPlaneLoadBalancer:
    vipAddress: ${CONTROL_PLANE_VIP}
    vipSubnetName: ${HCS_SUBNET_NAME}
    elbVirsubnetL4Ips:
      - subnetName: ${HCS_SUBNET_NAME}
        ips:
          - ${HCS_ELB_L4_IP_1}
          - ${HCS_ELB_L4_IP_2}
    elbVirsubnetL7Ips:
      - subnetName: ${HCS_SUBNET_NAME}
        ips:
          - ${HCS_ELB_L7_IP_1}
          - ${HCS_ELB_L7_IP_2}
  networkType: kube-ovn
  network:
    vpc:
      name: ${HCS_VPC_NAME}
    subnets:
      - name: ${HCS_SUBNET_NAME}
    securityGroup:
      name: ${HCS_SECURITY_GROUP_NAME}
  identityRef:
    name: ${PROVIDER_SECRET_NAME}
```

`wl-prod/14-cluster.yaml`

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
  labels:
    cluster-type: HCS
  annotations:
    cpaas.io/sentry-deploy-type: Baremetal
    cpaas.io/alb-address-type: ClusterAddress
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: HCSCluster
    cpaas.io/kube-ovn-join-cidr: ${KUBE_OVN_JOIN_CIDR}
    cpaas.io/kube-ovn-version: ${KUBE_OVN_VERSION}
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
    kind: HCSCluster
    name: ${CLUSTER_NAME}
```

The `infra` pool carries ingress, monitoring and logging of the workload cluster:

`wl-prod/20-infra-pool.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineConfigPool
metadata:
  name: ${CLUSTER_NAME}-infra-pool
  namespace: cpaas-system
  labels:
    cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
spec:
  configs:
    - hostname: ${INFRA1_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${INFRA1_IP}
      persistentDisks:
        - slot: 0
          size: ${INFRA_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${INFRA2_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${INFRA2_IP}
      persistentDisks:
        - slot: 0
          size: ${INFRA_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
    - hostname: ${INFRA3_HOSTNAME}
      networks:
        - subnetName: ${HCS_SUBNET_NAME}
          ipAddress: ${INFRA3_IP}
      persistentDisks:
        - slot: 0
          size: ${INFRA_CPAAS_DISK_GB}
          type: ${HCS_DISK_TYPE}
          mountPath: /var/cpaas
          format: xfs
```

`wl-prod/21-infra-template.yaml`

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: HCSMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-infra-template
  namespace: cpaas-system
spec:
  template:
    spec:
      imageName: ${HCS_IMAGE_NAME}
      flavorName: ${HCS_INFRA_FLAVOR}
      availabilityZone: ${HCS_INFRA_AZ}
      rootVolume:
        type: ${HCS_DISK_TYPE}
        size: 100
      configPoolRef:
        name: ${CLUSTER_NAME}-infra-pool
      dataVolumes:
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/kubelet
          format: xfs
        - size: 100
          type: ${HCS_DISK_TYPE}
          mountPath: /var/lib/containerd
          format: xfs
```

`wl-prod/22-infra-kct.yaml`

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: ${CLUSTER_NAME}-infra-kct
  namespace: cpaas-system
spec:
  template:
    spec:
      files:
        - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
          owner: root:root
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
      postKubeadmCommands:
        - chmod 600 /var/lib/kubelet/config.yaml
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
        nodeRegistration:
          kubeletExtraArgs:
            volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
```

`wl-prod/23-infra-md.yaml`

```yaml
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
  template:
    metadata:
      labels:
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: ${CLUSTER_NAME}
      version: "${K8S_VERSION}"
      nodeDrainTimeout: 1m
      nodeDeletionTimeout: 5m
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: ${CLUSTER_NAME}-infra-kct
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: HCSMachineTemplate
        name: ${CLUSTER_NAME}-infra-template
      taints:
        - key: node-role.kubernetes.io/infra
          value: reserved
          effect: NoSchedule
```

#### Apply and check

Apply the control plane first and verify it, then the pool. Never apply the whole directory at once —
pool machines of a broken control plane wait with nothing to join.

```bash
# on global
for f in 10-cp-pool 11-cp-template 12-kcp 13-hcscluster 14-cluster; do
  apply_rendered wl-prod.env "wl-prod/$f.yaml" "${GLOBAL_KUBECONFIG}" || break
done
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cluster "${CLUSTER_NAME}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane "${CLUSTER_NAME}-kcp"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machines -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}" -o wide
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get hcscluster "${CLUSTER_NAME}" \
  -o jsonpath='ready={.status.ready} endpoint={.spec.controlPlaneEndpoint.host}:{.spec.controlPlaneEndpoint.port}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get hcscluster "${CLUSTER_NAME}" \
  -o jsonpath='{range .status.conditions[?(@.type=="ControlPlaneHAReady")]}{.status} {.reason}{"\n"}{end}'
```

When the control plane is `Ready` (3/3) and the endpoint is `${CONTROL_PLANE_VIP}:6443`:

```bash
# on global
for f in 20-infra-pool 21-infra-template 22-infra-kct 23-infra-md; do
  apply_rendered wl-prod.env "wl-prod/$f.yaml" "${GLOBAL_KUBECONFIG}" || break
done
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machinedeployment "${CLUSTER_NAME}-infra"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get clustermodule "${CLUSTER_NAME}" -o jsonpath='{.status.base.deployStatus}{"\n"}'
( umask 077; kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret "${CLUSTER_NAME}-kubeconfig" \
    -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}" )
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide \
  -L node-role.kubernetes.io/infra,node-role.kubernetes.io/worker
```

Pass criteria: `Cluster` `Provisioned`/`Running`; six machines `Running`; six nodes `Ready`, the three
`infra` nodes labeled and tainted; `ClusterModule` deploy status `Completed`. If the cluster stays
`Provisioned` with `NotReady` nodes, start with
[Troubleshoot Huawei Cloud Stack Workload Clusters](https://docs.alauda.io/immutable-infra/1.0/how-to/troubleshoot-workload-cluster-huawei-cloud-stack.html).

The cluster now has only tainted nodes. Add the customer's worker pools before you hand it over —
see [Worker pools](#worker-pools).

### Variants

#### Single cluster

`global` doubles as the workload cluster: one bootstrap node, no standby, no etcd-sync, no workload
cluster creation. Skip [Add disaster recovery](#add-disaster-recovery) and change `12-kcp.yaml`: remove
the `encryption-provider.conf` entry (the HCS controller then generates the key) and use the non-DR
SAN list:

```yaml
# global-primary/12-kcp.yaml - single cluster: replaces the DR serverCertSANs list
          serverCertSANs:
            - "${CONTROL_PLANE_VIP}"
            - "${PLATFORM_HOST}"
```

In Step 4, apply `12-kcp.yaml` with `apply_rendered` like the other files; there is no key to inject.
The `infra` pool also carries ingress
([Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)).
Its application worker pools ([Worker pools](#worker-pools)) belong to `global` and therefore carry
the `global-` prefix:

```yaml
# a worker pool on a single-cluster global - differs from 23-infra-md.yaml in these fields
metadata:
  name: global-worker
spec:
  template:
    metadata:
      labels:
        node-role.kubernetes.io/worker: ""
    spec:
      bootstrap:
        configRef:
          name: global-worker-kct
      infrastructureRef:
        name: global-worker-template
      # no taints
```

#### Dedicated pools

For a larger workload cluster, replace the `infra` pool with `ingress`, `monitor` and `log` pools. Copy
`20`–`23` once per pool, replace `infra` with the pool name in every resource name, the role label and
the taint key, give each pool its own node variables (for example `LOG1_HOSTNAME` and `LOG1_IP`) and,
if needed, its own flavor and zone. Each pool keeps `node-role.kubernetes.io/worker` and its own taint
key. The `log` pool's `MachineDeployment`, for example:

```yaml
# wl-prod/23-log-md.yaml - differs from 23-infra-md.yaml in these fields
metadata:
  name: ${CLUSTER_NAME}-log
spec:
  template:
    metadata:
      labels:
        node-role.kubernetes.io/log: ""
        node-role.kubernetes.io/worker: ""
    spec:
      bootstrap:
        configRef:
          name: ${CLUSTER_NAME}-log-kct
      infrastructureRef:
        name: ${CLUSTER_NAME}-log-template
      taints:
        - key: node-role.kubernetes.io/log
          value: reserved
          effect: NoSchedule
```

The `HCSMachineTemplate` of each pool references that pool's `HCSMachineConfigPool`
(`configPoolRef.name: ${CLUSTER_NAME}-log-pool`). Number the extra files below `50` (for example
`24`–`35`), because the common article uses `50`–`79` in the same directory. Size each pool's
`/var/cpaas` for what it hosts. The `global` cluster keeps the single `infra` pool in this design.

#### Worker pools

The main line creates no untainted node: the control plane nodes carry the kubeadm control plane
taint and the `infra` nodes carry `node-role.kubernetes.io/infra=reserved:NoSchedule`. Before you hand
a workload cluster (or a single-cluster `global`) over, add at least one untainted worker pool sized
to the customer's machines. Build it with the four resources of
[Managing Nodes on Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-cloud-stack.html#using-yaml):
copy `20`–`23` to the next free numbers below `50` (for example `24`–`27`), and replace `infra` with
`worker` in every resource name and in
`configPoolRef.name`. Give the pool one `HCSMachineConfigPool` entry per replica with its own node
variables (for example `WORKER1_HOSTNAME` and `WORKER1_IP`), and its own flavor and zone if needed.
Set `replicas` to the number of entries. Keep `maxSurge: 0`, because the `/var/cpaas` persistent
disk stays on every worker. The `MachineDeployment` drops the role label and the taint, and keeps
`node-role.kubernetes.io/worker` so that the nodes receive machine configuration:

```yaml
# wl-prod/27-worker-md.yaml - differs from 23-infra-md.yaml in these fields
metadata:
  name: ${CLUSTER_NAME}-worker
spec:
  template:
    metadata:
      labels:
        node-role.kubernetes.io/worker: ""
    spec:
      bootstrap:
        configRef:
          name: ${CLUSTER_NAME}-worker-kct
      infrastructureRef:
        name: ${CLUSTER_NAME}-worker-template
      # no taints
```

Check that the new nodes are `Ready` and carry no taint:
`kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'`.

### Continue with the common steps

With the clusters up, continue in the common article on every cluster:

1. [Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins)
   — on HCS, settle the ingress VIP path from
   [Application ingress on an HCS VPC](#application-ingress-on-an-hcs-vpc) before MetalLB.
2. [Configure machines](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines)
   — this also delivers the `boot` user's SSH key used by the node checks below.
3. [Accept the delivery](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#accept-the-delivery),
   including the DR failover drill in [Failover](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#failover-procedure).

HCS-specific acceptance checks, run for each cluster file (`load_env <cluster>.env`):

```bash
# on global - every HCS cluster: ready, endpoint = VIP, host spread active
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get hcscluster \
  -o custom-columns='NAME:.metadata.name,READY:.status.ready,ENDPOINT:.spec.controlPlaneEndpoint.host,HA-POLICY:.status.controlPlaneHA.policy'
# every machine: ECS active, planned zone, provider ID set
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get hcsmachine \
  -o custom-columns='NAME:.metadata.name,STATE:.status.instanceState,READY:.status.ready,ZONE:.spec.availabilityZone,PROVIDERID:.spec.providerID'
# every persistent disk: one slot-0 disk per node, Attached, in the planned zone
for p in $(kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get hcsmachineconfigpool -o name); do
  echo "== $p"
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get "$p" \
    -o jsonpath='{range .status.persistentDiskStatus[*]}{.hostname}{"\t"}{.slot}{"\t"}{.phase}{"\t"}{.availabilityZone}{"\n"}{end}'
done
```

```bash
# on global - label synchronization is still configured (the provider AppRelease may reconcile the Deployment)
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}' | grep -o -- '--additional-sync-machine-labels=[^"]*'
# on a node (one per pool, as the boot user) - /var/cpaas is the persistent EVS disk, mounted once
findmnt -no SOURCE,FSTYPE,SIZE /var/cpaas
```

Pass criteria: every `HCSCluster` ready with its VIP as endpoint; every `HCSMachine` `ACTIVE` in its
planned zone with a provider ID; every node's `/var/cpaas` an attached slot-0 EVS disk of the planned
size, and no other `/var/cpaas` mount; the label synchronization argument still present on each
`global` side. In a DR pair, the node-level encryption check of
[Install the primary and the standby](#install-the-primary-and-the-standby) (step 8) has passed. Rerun
it after any control plane rollout on either side, because the provider rebuilds that file for every
new control plane machine.

## Related Information

- [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md) — the common article
- [How to Deliver ACP on Huawei DCS with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_DCS_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on Bare Metal with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Bare_Metal_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on VMware vSphere with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_VMware_vSphere_with_Immutable_Infrastructure.md)
- [Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
- [Global Cluster Disaster Recovery (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html)
- [Global Cluster Disaster Recovery (ACP, traditional OS)](https://docs.alauda.io/container_platform/4.4/install/global_dr.html#etcd_sync) — synchronized scope and switchover detail
- [Huawei Cloud Stack Provider](https://docs.alauda.io/immutable-infra/1.0/overview/providers/huawei-cloud-stack.html)
- [Huawei Cloud Stack Provider Installation](https://docs.alauda.io/immutable-infra/1.0/install/huawei-cloud-stack.html)
- [Infrastructure Resources for Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-cloud-stack.html)
- [Creating Clusters on Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html)
- [Managing Nodes on Huawei Cloud Stack](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-cloud-stack.html)
- [Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html)
- [Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)
- [Huawei Cloud Stack Provider Release Notes](https://docs.alauda.io/immutable-infra/1.0/release-notes/huawei_cloud_stack.html)
