---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# How to Deliver ACP on Huawei DCS with Immutable Infrastructure

## Purpose

This article is the Huawei DCS part of the standard delivery of Alauda Container Platform (ACP) 4.4 on Immutable Infrastructure. It takes a prepared Huawei Datacenter Virtualization Solution (DCS) site to a `global` cluster pair — primary and standby, with disaster recovery — and to workload clusters managed by `global`. Every cluster gets a three-node control plane and one `infra` pool, built from complete manifests in which you only fill in parameters, and every step ends with the check that proves it worked.

Read [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md) first. It defines the reference design, the parameter files and the `render` helper used below, the platform plugins, machine configuration, sizing, and acceptance. This article adds only what is specific to Huawei DCS.

Versions this article is written for:

- ACP 4.4, with every node built from the Alauda OS image published for the same ACP release.
- Alauda Container Platform DCS Infrastructure Provider `v1.0.22` or later. `v1.0.21` is the minimum for ACP 4.4 images; `v1.0.22` adds the Self-built VIP that every cluster endpoint in this article uses.
- The Alauda Container Platform Kubeadm Provider delivered with the release.

Validation status: the manifests are assembled from the ACP 4.4 product documentation and the documentation of DCS Provider `v1.0.22`. Validate them in a staging environment before a production delivery.

Out of scope: nodes that run a traditional operating system (use the [standard installation path](https://docs.alauda.io/container_platform/4.4/install/index.html)), the sizing of worker pools for applications (they follow the customer's machines; add them before handover, as [Worker pools](#worker-pools) shows), and storage selection.

## Resolution

### DCS-specific design

- **Cluster endpoint: Self-built VIP.** Every cluster sets `DCSCluster.spec.controlPlaneLoadBalancer.type: internal`. The provider brings the VIP up on the first control-plane node during bootstrap, then installs the `alive` runtime (keepalived and IPVS) on every control-plane node through a provider-managed `alive` ModuleInfo, so no load balancer is needed. The VIP must be an unused IPv4 address in the same Layer 2 network as the control-plane NICs, outside every IP pool, with a VRID that is unique in that network, and the DCS port group must allow VIP ownership, GARP/ARP updates, and VRRP. `type`, `host`, `port`, `vrid`, and `interface` cannot change after the control plane is initialized, because the VIP is written into the API server certificate and every kubeconfig. See "Self-built VIP behavior and limitations" under [Configure DCSCluster](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#configure-dcscluster).
- **Alternative endpoint: an existing external load balancer.** If the customer fronts the API with their own load balancer, replace the load-balancer block of `13-dcscluster.yaml` and validate the device against the [external LoadBalancer contract](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html#external-loadbalancer-contract) before you apply anything. For `global`, the device must also forward the ports in [LoadBalancer Forwarding Rules](https://docs.alauda.io/container_platform/4.4/install/prepare/prerequisites.html#port-forward), plus `2379` for the DR pair:

  ```yaml
  # 13-dcscluster.yaml: external load balancer instead of Self-built VIP
  spec:
    controlPlaneLoadBalancer:
      host: "${CONTROL_PLANE_VIP}"
      port: 6443
      type: external
  ```

  Either way the endpoint is an IP address, never a domain name: the API server certificate is issued by the cluster's own CA, so a domain gains nothing and is not supported.
- **Control-plane spread across hosts: a DRS rule.** The provider cannot pin VMs to DCS hosts, so three control-plane VMs can land on one host. `DCSCluster.spec.controlPlaneHA.enabled: true` makes the provider maintain a DRS mutual-exclusion rule for them. It needs DRS enabled on the DCS compute cluster, at least three usable hosts, datastores visible from all of them, and no blocking device such as a mounted CD-ROM. It is independent of the Self-built VIP. See [Cross-Host High Availability for Control Plane](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#cross-host-ha).
- **`/var/cpaas` is a pool-managed persistent disk.** It is declared in `DCSIpHostnamePool.spec.pool[].persistentDisk`, bound to the `(ip, slot)` identity, and reattached to the replacement VM when a node is replaced. Template disks (`/var/lib/etcd`, `/var/lib/kubelet`, `/var/lib/containerd`) are recreated with the VM. Two consequences:
  - Every pool rolls with `maxSurge: 0`, because a surge machine cannot take over the IP slot and the disk of the machine it replaces. The field paths differ: `KubeadmControlPlane.spec.rolloutStrategy.rollingUpdate.maxSurge` (no `maxUnavailable` there) and `MachineDeployment.spec.strategy.rollingUpdate.maxSurge` with `maxUnavailable: 1`. Never copy the `MachineDeployment` block into the `KubeadmControlPlane`: it has no `spec.strategy`, and the control plane would silently fall back to surging.
  - Entries can be appended but never removed, and `format`, `options`, and `pciType` are fixed at creation, so get the disk right before the first apply. The VM template must be `4.2.1` or later, because safe shutdown and disk detach depend on its guest tools.
- **Datastore binding.** `datastoreName` pins a disk to one datastore, and the DCS scheduler never looks at its siblings; `datastoreClusterName` lets DCS pick a member with free capacity, but every candidate host must see every member. The manifests use `datastoreName`. When the DCS administrator provides a datastore cluster that all candidate hosts can see, replace the key with `datastoreClusterName` in every disk entry of every file. See [Choosing a datastore](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#choosing-datastore).
- **Bootstrap data and encryption at rest.** DCS accepts only `format: ignition`, and the Ignition validator rejects an empty SSH key list, so the `boot` user always carries `BOOT_SSH_PUBLIC_KEY`. The provider writes `/etc/kubernetes/encryption-provider.conf` on control-plane nodes itself and drops any `files` entry for that path; for the DR pair the key is pinned with `DCSCluster.spec.encryptionProviderConfigRef`. See [How the Encryption Provider Configuration Is Delivered](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#encryption-provider-delivery).
- **Provider literals.** `PROVIDER_ID` and `NODE_IP` in the kubelet arguments are replaced by the provider for each machine. They are not `${...}` variables, so `render` leaves them alone; never replace or quote them by hand, or the nodes never register. See [Magic-Token Placeholders](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#magic-tokens).
- **Naming is a hard requirement.** For `global`, the `Cluster` and the `DCSCluster` are named exactly `global` and every other resource starts with `global-`: DR identifies the pair's resources by that prefix, and a resource without it is invisible to DR and loses its machines at the first failover ([naming convention](https://docs.alauda.io/immutable-infra/1.0/global/install.html#common-prerequisites)). A workload cluster is never named `global` and never uses the `global-` prefix ([Workload Cluster Naming](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#workload-cluster-naming)). The `global` manifests below hard-code these names and the workload manifests derive every name from `CLUSTER_NAME`, so a copied file cannot drift.
- **Credentials stay out of manifests.** The DCS API credential Secret is created with `kubectl create`; a Secret applied with `kubectl apply` keeps its content in the `last-applied-configuration` annotation. The installer copies the Secret into `global` through the `dcs-import-extra-resources` ConfigMap, and workload clusters on the same DCS reference that copy instead of writing the password again.
- **One manifest set per cluster.** `global-primary/` and `global-standby/` are byte-identical: every difference between the two sides lives in the cluster env file, and the DR increments read only `site.env`, which is how they stay identical on both sides. A new workload cluster is a copy of `wl-prod/` with its own env file; nothing in the manifests names another cluster.

### Parameters

Use the delivery directory, the parameter files, and the `render`, `load_env`, and `apply_rendered` helpers exactly as defined in [Prepare the parameter files](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#prepare-the-parameter-files), and the kubeconfig variables of its [Kubeconfig convention](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#kubeconfig-convention). Copy the delivery directory to each bootstrap node and keep it on the delivery host; run every command from it, after `load_env` of the cluster the command is for. Each command block states where it runs: `# on the bootstrap node` (a shell on that host), `# on the bootstrap cluster` (on that side's bootstrap node, with `BOOTSTRAP_KUBECONFIG`), `# on global`, `# on the workload cluster`, or `# on a node`.

This article adds these files to each cluster directory, all numbered below `50` (the common article owns `50` to `79`):

```text
global-primary/   00 provider AppReleases, 10-14 control plane, 20-23 infra pool,
                  30 import ConfigMap, 40 installer request
global-standby/   byte-identical copy: cp -r global-primary global-standby
wl-prod/          10-14 control plane, 20-23 infra pool
                  (dedicated layout: 30-33 ingress, 34-37 monitor, 40-43 log; worker pool 44-47)
rendered/         render output (holds no credentials)
```

DCS notes on the common variables, which are defined in the [common variables](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#common-variables) tables:

- `PLATFORM_HOST` is a DNS name. It is the only name that moves during DR.
- `REGISTRY_DOMAIN` is `PLATFORM_HOST` with port `11443`, so both sides of the DR pair register the same platform registry address.
- `CONTROL_PLANE_VIP` is the Self-built VIP of the cluster. In `global-primary.env` set it to `"${PRIMARY_CLUSTER_VIP}"`, in `global-standby.env` to `"${STANDBY_CLUSTER_VIP}"`.
- `CLUSTER_NAME` is `global` in both `global` files.
- `K8S_VERSION` must equal `kubernetesVersion` of the VM template; see [Resolving Placeholder Values](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#resolving-placeholders).
- `BOOT_SSH_PUBLIC_KEY` is mandatory on DCS (see above), and the same key that the common article's machine configuration manages.
- `GLOBAL_KUBECONFIG` and `CLUSTER_KUBECONFIG` both point at the side itself in the two `global` files. For a workload cluster, `GLOBAL_KUBECONFIG` points at the active `global`.

`site.env` — DCS lines:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `IMAGE_REPOSITORY` | Repository of the kubeadm-managed images (`clusterConfiguration.imageRepository`) | `cloud.alauda.io/alauda` | The value in the product's [Complete KubeadmControlPlane Configuration](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#complete-kubeadmcontrolplane-configuration); keep it unless the release baseline says otherwise |
| `DNS_IMAGE_TAG` | CoreDNS image tag in every `KubeadmControlPlane` | `1.14.3-v4.4.6` | `coredns` column of the [OS Support Matrix](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html) row of your ACP release, or `corednsTag` in the `cpaas.io/dcs-vm-template` ConfigMap |
| `ETCD_IMAGE_TAG` | etcd image tag in every `KubeadmControlPlane` | `v3.6.13-acp.0` | `etcd` column of the same row, or `etcdTag` |
| `KUBE_OVN_VERSION` | Kube-OVN chart version pinned on every `Cluster` | `v4.4.6` | `kube-ovn (chart)` column of the same row; on an installed `global`, the `cpaas.io/kube-ovn-version` annotation of `Cluster/global` |
| `DCS_KUBERNETES_FILES_SECRET` | Provider-shipped Secret holding the admission, audit, and kubelet patch files | `dcs-kubernetes-1.35-files` | `kubectl -n cpaas-system get secret -o name \| grep dcs-kubernetes-` once the DCS provider runs |
| `LOCAL_REGISTRY_ADDRESS` | Bootstrap registry as seen from the bootstrap node, for package uploads | `127.0.0.1:11443` | Fixed value from the product page |
| `BOOTSTRAP_REGISTRY_ADDRESS` | Bootstrap registry as seen from inside the bootstrap cluster, for the AppRelease `repoURL` | `172.18.0.1:11443` | Fixed value from the product page |
| `INGRESS_CLASS_NAME` | Ingress class value in the provider AppReleases | `global-alb2` | Fixed value from Step 1 of the product page; keep the value the provider release requires |
| `KUBEADM_PROVIDER_VERSION` | Kubeadm provider chart version | `v1.0.14` | Tag list printed in [Install the provider packages](#install-the-provider-packages) |
| `DCS_PROVIDER_VERSION` | DCS provider chart version | `v1.0.22` | Same |
| `PROVIDER_SECRET_NAME` | DCS credential Secret on each bootstrap cluster and, after the import, on each `global`; every `DCSCluster` references it | `global-secret` | Product default |
| `PRIMARY_CLUSTER_VIP` | Self-built VIP of the primary `global` | `192.0.2.10` | Network plan |
| `STANDBY_CLUSTER_VIP` | Self-built VIP of the standby `global` | `203.0.113.10` | Network plan |
| `DCS_ENCRYPTION_PROVIDER_SECRET` | Secret holding the shared `encryption-provider.conf` | `encryption-provider-config` | Product default |
| `ENCRYPTION_PROVIDER_CONF` | Path of the shared encryption file on both bootstrap nodes, outside the delivery directory | `/root/dr/encryption-provider.conf` | Chosen by the delivery |

Cluster files — DCS lines, the same names in every file:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `NODE_NAME_PREFIX` | Prefix of node hostnames and DCS VM names. Unique per cluster, so the two `global` sides never create VMs with the same name | `global-primary`, `global-standby`, `wl-prod` | Chosen. Workload files use `"${CLUSTER_NAME}"` |
| `HOST_IP` | Static IP of this side's bootstrap node (`global` files only) | `192.0.2.5` | Bootstrap node |
| `BOOTSTRAP_KUBECONFIG` | Kubeconfig of this side's bootstrap cluster (`global` files only) | `/root/.kube/config` | Written by Step 2 in [Bring up the bootstrap nodes](#bring-up-the-bootstrap-nodes) on that side's bootstrap node |
| `NODE_REGISTRY_ADDRESS` | Registry that provisioned nodes pull from, written to `cpaas.io/registry-address` | `global`: `"${HOST_IP}:11443"`; workload: `acp.example.com:11443` | `global`: the bootstrap registry. Workload: [read it from `global`](#read-the-shared-values-from-global) |
| `DCS_API_ENDPOINT` | DCS REST API URL, including the port | `https://192.0.2.200:7443` | DCS administrator. The API port is normally `7443`, not the `8443` web portal |
| `DCS_SITE` | DCS site ID | `A1B2C3D4` | DCS administrator |
| `DCS_HOST_MGMT_IPS` | Management IPs of every DCS host that may receive a clone, space-separated | `192.0.2.201 192.0.2.202 192.0.2.203` | DCS administrator |
| `DCS_HOST_MGMT_PORT` | File-upload port that DCS returns for those hosts | `8443` | DCS administrator |
| `DCS_VM_TEMPLATE` | VM template built from the Alauda OS `qcow2` image | `alauda-os-acp-4.4` | Created in [Collect the DCS facts](#collect-the-dcs-facts) |
| `DCS_VM_FOLDER` | Existing DCS VM folder for the cluster's VMs | `acp-global` | DCS administrator |
| `DCS_DATASTORE` | Datastore for every disk of the cluster | `datastore-01` | DCS administrator |
| `DCS_DVSWITCH` | Distributed virtual switch of the node NIC | `dvs-01` | DCS administrator |
| `DCS_PORT_GROUP` | Port group of the node NIC | `pg-acp-nodes` | DCS administrator |
| `DCS_VRID` | Keepalived VRID of the Self-built VIP, `1` to `255`, unique in the Layer 2 network | `51` | Network plan |
| `DCS_CONTROL_PLANE_HA` | `true` to let the provider keep the control-plane VMs on different hosts | `true` | `false` when DRS is not enabled on the DCS compute cluster |
| `DCS_NODE_MASK` | Prefix length of the node network, without `/` | `24` | Network plan |
| `DCS_NODE_GATEWAY` | Gateway of the node network | `192.0.2.1` | Network plan |
| `DCS_NODE_DNS` | DNS servers of the nodes, `;`-separated | `192.0.2.2` | Network plan |
| `CP_NODE_IP_1` | First control-plane node IP; `CP_NODE_IP_2` and `CP_NODE_IP_3` likewise | `192.0.2.11` | Network plan |
| `INFRA_NODE_IP_1` | First `infra` node IP; `INFRA_NODE_IP_2` and `INFRA_NODE_IP_3` likewise | `192.0.2.14` | Network plan |
| `DCS_CP_CPU` | Control-plane VM CPU cores | `16` | [Size the clusters](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#size-the-clusters) |
| `DCS_CP_MEMORY_MB` | Control-plane VM memory in MB | `32768` | Same |
| `DCS_CP_CPAAS_DISK_GB` | Persistent `/var/cpaas` disk of each control-plane node, in GB | `100` | Same |
| `DCS_INFRA_CPU` | `infra` VM CPU cores | `16` | Same |
| `DCS_INFRA_MEMORY_MB` | `infra` VM memory in MB | `32768` | Same |
| `DCS_INFRA_CPAAS_DISK_GB` | Persistent `/var/cpaas` disk of each `infra` node, in GB | `500` | Same |

The dedicated-pool layout adds the `infra` values once per dedicated pool — `INGRESS_NODE_IP_1` to `_3`, `DCS_INGRESS_CPU`, `DCS_INGRESS_MEMORY_MB`, `DCS_INGRESS_CPAAS_DISK_GB`, and the same for `MONITOR` and `LOG`; see [Dedicated pools](#dedicated-pools). A worker pool adds the same set with the `WORKER` prefix; see [Worker pools](#worker-pools).

Set at run time, never written to a file (in addition to the common article's runtime secrets `ACP_TOKEN`, `REGISTRY_USERNAME`, and `REGISTRY_PASSWORD`):

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `DCS_AUTH_USER` | DCS API user | (never stored) | Prompted by `read` |
| `DCS_AUTH_KEY` | DCS API password | (never stored) | Prompted by `read` |
| `DCS_PROVIDER_PACK` | Path of the downloaded DCS provider package | (set by the command) | Set from `ls` |
| `KUBEADM_PROVIDER_PACK` | Path of the downloaded Kubeadm provider package | (set by the command) | Set from `ls` |
| `ENCRYPTION_PROVIDER_SECRET_B64` | Random 32-byte encryption key, base64-encoded | (never stored) | Generated, then unset |
| `INSTALLER_IP` | Pod IP of `cpaas-installer` on this bootstrap node | (set by the command) | Set from `kubectl` |
| `PLATFORM_ADMIN_PASSWORD_B64` | Base64-encoded platform administrator password for the installer request | (never stored) | Prompted by `read` |
| `REGISTRY_PASSWORD_B64` | Base64-encoded platform registry password for the installer request | (never stored) | Prompted by `read` |
| `ACTIVE_CLUSTER_TOKEN` | Bearer token of the primary's `k8sadmin` ServiceAccount | (never stored) | Read from the primary into the shell |

`site.env` — append the DCS lines to the common lines:

```bash
# site.env: DCS lines
IMAGE_REPOSITORY='cloud.alauda.io/alauda'
DNS_IMAGE_TAG='1.14.3-v4.4.6'
ETCD_IMAGE_TAG='v3.6.13-acp.0'
KUBE_OVN_VERSION='v4.4.6'
DCS_KUBERNETES_FILES_SECRET='dcs-kubernetes-1.35-files'
LOCAL_REGISTRY_ADDRESS='127.0.0.1:11443'
BOOTSTRAP_REGISTRY_ADDRESS='172.18.0.1:11443'
INGRESS_CLASS_NAME='global-alb2'
KUBEADM_PROVIDER_VERSION='v1.0.14'
DCS_PROVIDER_VERSION='v1.0.22'
PROVIDER_SECRET_NAME='global-secret'
# Disaster recovery: read by both global sides, so the increments are identical.
PRIMARY_CLUSTER_VIP='192.0.2.10'
STANDBY_CLUSTER_VIP='203.0.113.10'
DCS_ENCRYPTION_PROVIDER_SECRET='encryption-provider-config'
ENCRYPTION_PROVIDER_CONF='/root/dr/encryption-provider.conf'
```

`global-primary.env` — the common lines that carry DCS-specific values, then the DCS lines:

```bash
# global-primary.env
CLUSTER_NAME='global'
CONTROL_PLANE_VIP="${PRIMARY_CLUSTER_VIP}"
CLUSTER_CIDR='100.3.0.0/16'
SERVICE_CIDR='100.4.0.0/16'
KUBE_OVN_JOIN_CIDR='100.5.0.0/16'
GLOBAL_KUBECONFIG='/root/.kube/acp/global-primary.kubeconfig'
CLUSTER_KUBECONFIG='/root/.kube/acp/global-primary.kubeconfig'
# ... the other common lines (monitoring, logging, ingress) as in the common article

# DCS lines
NODE_NAME_PREFIX='global-primary'
HOST_IP='192.0.2.5'
BOOTSTRAP_KUBECONFIG='/root/.kube/config'
NODE_REGISTRY_ADDRESS="${HOST_IP}:11443"
DCS_API_ENDPOINT='https://192.0.2.200:7443'
DCS_SITE='A1B2C3D4'
DCS_HOST_MGMT_IPS='192.0.2.201 192.0.2.202 192.0.2.203'
DCS_HOST_MGMT_PORT='8443'
DCS_VM_TEMPLATE='alauda-os-acp-4.4'
DCS_VM_FOLDER='acp-global'
DCS_DATASTORE='datastore-01'
DCS_DVSWITCH='dvs-01'
DCS_PORT_GROUP='pg-acp-nodes'
DCS_VRID='51'
DCS_CONTROL_PLANE_HA='true'
DCS_NODE_MASK='24'
DCS_NODE_GATEWAY='192.0.2.1'
DCS_NODE_DNS='192.0.2.2'
CP_NODE_IP_1='192.0.2.11'
CP_NODE_IP_2='192.0.2.12'
CP_NODE_IP_3='192.0.2.13'
INFRA_NODE_IP_1='192.0.2.14'
INFRA_NODE_IP_2='192.0.2.15'
INFRA_NODE_IP_3='192.0.2.16'
DCS_CP_CPU='16'
DCS_CP_MEMORY_MB='32768'
DCS_CP_CPAAS_DISK_GB='100'
DCS_INFRA_CPU='16'
DCS_INFRA_MEMORY_MB='32768'
DCS_INFRA_CPAAS_DISK_GB='500'
```

`global-standby.env` is a copy of `global-primary.env` with the standby's lines changed. When the standby runs in a second DCS site, every `DCS_` fact changes as well:

```bash
# global-standby.env: differences from global-primary.env
CONTROL_PLANE_VIP="${STANDBY_CLUSTER_VIP}"
CLUSTER_CIDR='100.13.0.0/16'
SERVICE_CIDR='100.14.0.0/16'
KUBE_OVN_JOIN_CIDR='100.15.0.0/16'
GLOBAL_KUBECONFIG='/root/.kube/acp/global-standby.kubeconfig'
CLUSTER_KUBECONFIG='/root/.kube/acp/global-standby.kubeconfig'
NODE_NAME_PREFIX='global-standby'
HOST_IP='203.0.113.5'
DCS_VRID='52'
DCS_NODE_GATEWAY='203.0.113.1'
DCS_NODE_DNS='203.0.113.2'
CP_NODE_IP_1='203.0.113.11'
CP_NODE_IP_2='203.0.113.12'
CP_NODE_IP_3='203.0.113.13'
INFRA_NODE_IP_1='203.0.113.14'
INFRA_NODE_IP_2='203.0.113.15'
INFRA_NODE_IP_3='203.0.113.16'
```

`wl-prod.env` — the DCS lines that follow the common lines of the workload cluster (`CLUSTER_NAME='wl-prod'`, `CONTROL_PLANE_VIP='192.0.2.20'`, and so on):

```bash
# wl-prod.env (continued): DCS lines
NODE_NAME_PREFIX="${CLUSTER_NAME}"
NODE_REGISTRY_ADDRESS='acp.example.com:11443'
DCS_API_ENDPOINT='https://192.0.2.200:7443'
DCS_SITE='A1B2C3D4'
DCS_HOST_MGMT_IPS='192.0.2.201 192.0.2.202 192.0.2.203'
DCS_HOST_MGMT_PORT='8443'
DCS_VM_TEMPLATE='alauda-os-acp-4.4'
DCS_VM_FOLDER='acp-wl-prod'
DCS_DATASTORE='datastore-01'
DCS_DVSWITCH='dvs-01'
DCS_PORT_GROUP='pg-acp-nodes'
DCS_VRID='53'
DCS_CONTROL_PLANE_HA='true'
DCS_NODE_MASK='24'
DCS_NODE_GATEWAY='192.0.2.1'
DCS_NODE_DNS='192.0.2.2'
CP_NODE_IP_1='192.0.2.21'
CP_NODE_IP_2='192.0.2.22'
CP_NODE_IP_3='192.0.2.23'
INFRA_NODE_IP_1='192.0.2.24'
INFRA_NODE_IP_2='192.0.2.25'
INFRA_NODE_IP_3='192.0.2.26'
DCS_CP_CPU='8'
DCS_CP_MEMORY_MB='16384'
DCS_CP_CPAAS_DISK_GB='100'
DCS_INFRA_CPU='16'
DCS_INFRA_MEMORY_MB='32768'
DCS_INFRA_CPAAS_DISK_GB='500'
```

### Prepare DCS

#### Collect the DCS facts

Collect these with the DCS administrator before anything is installed, and record each in the cluster file named in the last column.

| Fact | Requirement | Variable |
| --- | --- | --- |
| REST API endpoint | The VRM address and the API port, normally `7443`. The `8443` web portal is for people, not for the provider | `DCS_API_ENDPOINT` |
| API user | Role `administrator`. An interface interconnection user (the default) needs the DCS policy "Whether to modify the password of an interface interconnection user upon password resetting and first login" set to **No**; otherwise the first login forces a password change and provisioning fails. A domain user needs DCS domain authentication and the user pre-created with the `administrator` role. See [Credential User Types](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#user-types) | Prompted, never stored |
| Site ID | All resources of a cluster live in one site | `DCS_SITE` |
| VM template | Built from the Alauda OS `qcow2` image published for the installed ACP 4.4 release ([Downloading Alauda OS](https://docs.alauda.io/immutable-infra/1.0/overview/os-support-matrix.html#downloading-alauda-os)). When the DR pair spans two DCS sites, create a template in each. The DCS hosts must expose the `x86-64-v2` CPU baseline to the VMs | `DCS_VM_TEMPLATE` |
| VM folder | Exists before the cluster is created | `DCS_VM_FOLDER` |
| Compute cluster | DRS enabled and at least three usable hosts, if `DCS_CONTROL_PLANE_HA=true` | `DCS_CONTROL_PLANE_HA` |
| Datastore | Free capacity for the system disk, the template disks, and `/var/cpaas` of every node, kept below roughly 70 % used; visible to every host that may run the VMs; accepts direct file upload for the Ignition ISO (otherwise provide shared storage such as NFS). Use the read-only checks in [DCS Platform Capacity and Placement](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#capacity-and-placement) | `DCS_DATASTORE` |
| DVS and port group | Carry the node NIC; allow VIP ownership, GARP/ARP updates, and VRRP between the control-plane VMs | `DCS_DVSWITCH`, `DCS_PORT_GROUP` |
| Host management IPs | Every host that may receive a clone, and the upload port DCS returns for them (typically `8443`) | `DCS_HOST_MGMT_IPS`, `DCS_HOST_MGMT_PORT` |
| Node network | Node IPs per pool, prefix length, gateway, DNS servers | `CP_NODE_IP_n`, `INFRA_NODE_IP_n`, `DCS_NODE_MASK`, `DCS_NODE_GATEWAY`, `DCS_NODE_DNS` |
| Control-plane VIP | Unused IPv4 address in the control-plane Layer 2 network, outside every pool, and a VRID unique in that network | `CONTROL_PLANE_VIP`, `DCS_VRID` |

For the concepts behind these names — a DCS Cluster is a host pool, not the `DCSCluster` resource — see [Huawei DCS Concepts and Terminology](https://docs.alauda.io/immutable-infra/1.0/overview/providers/huawei-dcs.html#concepts-and-terminology).

#### Open the network paths

These are the DCS-specific flows. Have them approved and tested before you install. For the platform's own port inventory and the flows it lists separately, use the [Communication Matrix](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html).

| From | To | Port | Why |
| --- | --- | --- | --- |
| Bootstrap node | DCS VRM (`DCS_API_ENDPOINT`) | TCP `7443` | The providers run in the bootstrap cluster while `global` is installed: REST API calls and the first step of every file upload (`applyUpload`) |
| Bootstrap node | Every DCS host management IP | `DCS_HOST_MGMT_PORT`, typically TCP `8443` | The Ignition ISO is streamed straight to the host that the `applyUpload` response names. A blocked host shows up as a VM that boots without Ignition and never registers |
| Bootstrap node | `global` control-plane VIP | TCP `6443` | Cluster API reaches the new control plane |
| `global` nodes | Bootstrap node | TCP `11443` | Image pulls until the `global` registry takes over |
| `global` nodes | DCS VRM and every host management IP | TCP `7443` and `DCS_HOST_MGMT_PORT` | After the installation the providers run on `global`: workload clusters, scale-out, and node replacement use the same two paths. On multi-NIC nodes, both must route through the right NIC |
| Control-plane nodes of each cluster | Each other | VRRP (IP protocol 112) and GARP | Self-built VIP |
| `global` nodes | Workload control-plane VIP and control-plane nodes | TCP `6443`, `11780` | `global` manages the workload clusters; see [Connecting global Cluster and Workload Cluster](https://docs.alauda.io/container_platform/4.4/configure/clusters/on-premises.html#connecting-global-cluster-and-workload-cluster) |
| Primary `global` network | Standby `global` network, both directions | TCP `443`, `6443`, `11443`, `2379` (`80` only for HTTP access) | DR; see [Network Requirements](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#network-requirements) |

Check the DCS paths from each bootstrap node:

```bash
# on the bootstrap node, in the delivery directory
load_env global-primary.env
curl -k -sS -o /dev/null --connect-timeout 5 -w 'VRM API: HTTP %{http_code}\n' "${DCS_API_ENDPOINT}"
for ip in ${DCS_HOST_MGMT_IPS}; do
  timeout 5 bash -c "</dev/tcp/$ip/${DCS_HOST_MGMT_PORT}" && echo "$ip open" || echo "$ip BLOCKED"
done
```

Pass: the VRM answers with any HTTP status (`000` means no connection), and every host reports `open`.

#### Bring up the bootstrap nodes

The multi-cluster line uses **two** bootstrap nodes, one per `global` side. Never install both sides from one: until handoff each bootstrap environment carries the installer, the registry, and the provider resources of the side it installs. Each node is x86_64 with at least 4 cores, 8 GB of memory, and 300 GB of disk for `/root/cpaas-install` and `/var/cpaas`; runs a 64-bit traditional Linux distribution with Bash and `root`; and has a static IP (`HOST_IP`), because that address is written into every node's registry annotation. See [Bootstrap Node Requirements](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-requirements).

Run Step 2 of [Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html) on each bootstrap node, replacing `<core-package>` with the Core Package file:

```bash
# on the bootstrap node
mkdir -p /root/cpaas-install
tar -xvf <core-package> -C /root/cpaas-install
cd /root/cpaas-install/installer
bash setup.sh
mkdir -p "$HOME/.local/bin" ~/.kube
if ! command -v kubectl >/dev/null 2>&1; then
  nerdctl cp minialauda-control-plane:/usr/bin/kubectl "$HOME/.local/bin/kubectl"
  chmod 0755 "$HOME/.local/bin/kubectl"
  export PATH="$HOME/.local/bin:$PATH"
fi
cp /var/cpaas/data/alauda.kubeconfig ~/.kube/config
kubectl get nodes
umask 077; mkdir -p /root/.kube/acp     # for the global kubeconfigs of the common Kubeconfig convention
```

`/root/.kube/config` is the `BOOTSTRAP_KUBECONFIG` of this side's cluster file; every `# on the bootstrap cluster` command passes it explicitly, so a kubeconfig of another cluster in the environment cannot redirect it.

#### Install the provider packages

Upload the Kubeadm and DCS provider packages (placed under `/root/packages/` here) to the bootstrap registry, and read the chart versions they carry:

```bash
# on the bootstrap node, in the delivery directory
load_env global-primary.env
DCS_PROVIDER_PACK=$(ls /root/packages/cluster-api-provider-dcs.amd64.*.tgz)
KUBEADM_PROVIDER_PACK=$(ls /root/packages/cluster-api-provider-kubeadm.amd64.*.tgz)
/root/cpaas-install/installer/res/amd64/packtool pack push -r "${LOCAL_REGISTRY_ADDRESS}" -c "${DCS_PROVIDER_PACK}"
/root/cpaas-install/installer/res/amd64/packtool pack push -r "${LOCAL_REGISTRY_ADDRESS}" -c "${KUBEADM_PROVIDER_PACK}"
curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/ait/chart-cluster-api-provider-kubeadm/tags/list"; echo
curl -s "http://${LOCAL_REGISTRY_ADDRESS}/v2/ait/chart-cluster-api-provider-dcs/tags/list"; echo
```

Record the two tags as `KUBEADM_PROVIDER_VERSION` and `DCS_PROVIDER_VERSION` in `site.env` — both bootstrap nodes use the same packages, so the values are shared — and reload it.

`global-primary/00-provider-appreleases.yaml` — the provider AppReleases of Step 3 of the product page, for the default anonymous bootstrap registry. `global.cluster.type: Baremetal` is a chart-internal classifier and stays `Baremetal` on DCS:

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
  name: cluster-api-provider-dcs
  namespace: cpaas-system
spec:
  destination:
    cluster: ""
    namespace: ""
  source:
    charts:
      - name: ait/chart-cluster-api-provider-dcs
        releaseName: cluster-api-provider-dcs
        targetRevision: ${DCS_PROVIDER_VERSION}
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

If you set a registry user and password during the bootstrap setup, `setup.sh` created the `global-registry-auth` Secret; then add `spec.source.chartPullSecret: global-registry-auth` and `spec.values.global.registry.imagePullSecrets: [global-registry-auth]` to both AppReleases, as the product page shows. With the default anonymous registry, add neither.

```bash
# on the bootstrap cluster, in the delivery directory
load_env global-primary.env
apply_rendered global-primary.env global-primary/00-provider-appreleases.yaml "${BOOTSTRAP_KUBECONFIG}"
until kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get crd kubeadmcontrolplanes.controlplane.cluster.x-k8s.io >/dev/null 2>&1; do sleep 10; done
until kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get crd dcsclusters.infrastructure.cluster.x-k8s.io >/dev/null 2>&1; do sleep 10; done
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get pods -n cpaas-system | grep -E 'kubeadm|dcs'
for k in control-plane-kubelet-patch worker-kubelet-patch; do
  kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret "${DCS_KUBERNETES_FILES_SECRET}" -o jsonpath="{.data.$k\.json}" \
    | base64 -d | grep -c imagePullCredentialsVerificationPolicy
done
```

Pass: both CRDs exist, the provider Pods are `Running`, and the loop prints `1` twice — both provider-shipped kubelet patches carry the setting that Kubernetes 1.35 requires. If the Secret is missing, replace the `contentFrom` entries of `12-kcp.yaml` and `22-infra-kct.yaml` with the inline `content` of the [Complete KubeadmControlPlane Configuration](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#complete-kubeadmcontrolplane-configuration) and of the [worker bootstrap template](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-dcs.html#worker-node-deployment).

#### Create the DCS credential Secret

Create the Secret on each bootstrap cluster before its manifests are applied. The user and password pass through process substitution only, so they never reach a disk, the shell history, or a command line:

```bash
# on the bootstrap cluster
read -rp 'DCS API user: ' DCS_AUTH_USER
read -rsp 'DCS API password: ' DCS_AUTH_KEY; echo
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system create secret generic "${PROVIDER_SECRET_NAME}" \
  --from-file=authUser=<(printf '%s' "${DCS_AUTH_USER}") \
  --from-file=authKey=<(printf '%s' "${DCS_AUTH_KEY}") \
  --from-literal=endpoint="${DCS_API_ENDPOINT}" \
  --from-literal=site="${DCS_SITE}"
unset DCS_AUTH_USER DCS_AUTH_KEY
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system label secret "${PROVIDER_SECRET_NAME}" --overwrite cpaas.io/cluster-name=global
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}" -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
```

The last command lists the keys only: `authKey`, `authUser`, `endpoint`, `site`. For a domain user, add `--from-literal=userType=domain`; without that key the provider authenticates as an interface interconnection user. To rotate the password later, patch the Secret as described in [Cloud Credentials](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#using-yaml) — never re-apply a manifest.

### Install the global cluster

This section installs one `global` side from its bootstrap node. It is written for the primary with `global-primary.env`; [Add disaster recovery](#add-disaster-recovery) runs it a second time for the standby. The manifests carry the three DR increments, marked `# DR increment`, because the multi-cluster line always has a standby: complete [Prepare the shared DR inputs](#prepare-the-shared-dr-inputs) before you apply them. For a single `global` without DR, see [Single cluster](#single-cluster).

The resources follow Step 4 of [Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html) and its [complete DCS worked example](https://docs.alauda.io/immutable-infra/1.0/global/install.html#dcs-worked-example) with the Self-built VIP variant, the `kubeadmConfigSpec` body of the [Complete KubeadmControlPlane Configuration](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#complete-kubeadmcontrolplane-configuration), and an `infra` pool built from [Worker Node Deployment](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-dcs.html#worker-node-deployment).

#### Write the manifests

`global-primary/10-cp-pool.yaml` — the control-plane IPs, hostnames, and the persistent `/var/cpaas` disk of each slot:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSIpHostnamePool
metadata:
  name: global-cp-pool
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
spec:
  pool:
  - ip: "${CP_NODE_IP_1}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-cp-1"
    machineName: "${NODE_NAME_PREFIX}-cp-1"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_CP_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${CP_NODE_IP_2}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-cp-2"
    machineName: "${NODE_NAME_PREFIX}-cp-2"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_CP_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${CP_NODE_IP_3}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-cp-3"
    machineName: "${NODE_NAME_PREFIX}-cp-3"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_CP_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
```

`global-primary/11-cp-template.yaml` — the control-plane VM. The four template disks are mandatory for a control-plane template; `/var/cpaas` is deliberately not one of them:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSMachineTemplate
metadata:
  name: global-cp-template
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
spec:
  template:
    spec:
      vmTemplateName: "${DCS_VM_TEMPLATE}"
      location:
        type: folder
        name: "${DCS_VM_FOLDER}"
      vmConfig:
        dvSwitchName: "${DCS_DVSWITCH}"
        portGroupName: "${DCS_PORT_GROUP}"
        dcsMachineCpuSpec:
          quantity: ${DCS_CP_CPU}
        dcsMachineMemorySpec:      # MB
          quantity: ${DCS_CP_MEMORY_MB}
        dcsMachineDiskSpec:        # GB; 0 keeps the size of the VM template's system disk
        - quantity: 0
          datastoreName: "${DCS_DATASTORE}"
          systemVolume: true
        - quantity: 10
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/etcd
          format: xfs
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/kubelet
          format: xfs
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/containerd
          format: xfs
      ipHostPoolRef:
        name: global-cp-pool
```

`global-primary/12-kcp.yaml` — the control plane. Compared with a workload cluster, `global` keeps only the `skip-kube-proxy` annotation and adds etcd server certificate SANs. The three large files come from the provider-shipped Secret:

```yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: global-kcp
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
  annotations:
    controlplane.cluster.x-k8s.io/skip-kube-proxy: ""
spec:
  replicas: 3
  version: ${K8S_VERSION}
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
  machineTemplate:
    nodeDrainTimeout: 1m
    nodeDeletionTimeout: 5m
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: DCSMachineTemplate
      name: global-cp-template
  kubeadmConfigSpec:
    format: ignition
    users:
    - name: boot
      sshAuthorizedKeys:
      - "${BOOT_SSH_PUBLIC_KEY}"
    files:
    - path: /etc/kubernetes/admission/psa-config.yaml
      owner: "root:root"
      permissions: "0644"
      contentFrom:
        secret:
          name: ${DCS_KUBERNETES_FILES_SECRET}
          key: psa-config.yaml
    - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
      owner: "root:root"
      permissions: "0644"
      contentFrom:
        secret:
          name: ${DCS_KUBERNETES_FILES_SECRET}
          key: control-plane-kubelet-patch.json
    - path: /etc/kubernetes/audit/policy.yaml
      owner: "root:root"
      permissions: "0644"
      contentFrom:
        secret:
          name: ${DCS_KUBERNETES_FILES_SECRET}
          key: audit-policy.yaml
    preKubeadmCommands:
    - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
    - mkdir -p /run/cluster-api && restorecon -Rv /run/cluster-api
    - if [ -f /etc/disk-setup.sh ]; then bash /etc/disk-setup.sh; fi
    postKubeadmCommands:
    - chmod 600 /var/lib/kubelet/config.yaml
    clusterConfiguration:
      imageRepository: ${IMAGE_REPOSITORY}
      dns:
        imageTag: "${DNS_IMAGE_TAG}"
      etcd:
        local:
          imageTag: "${ETCD_IMAGE_TAG}"
          serverCertSANs:          # DR increment: the same list on both sides
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
          encryption-provider-config: /etc/kubernetes/encryption-provider.conf
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
          flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
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
          provider-id: PROVIDER_ID
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          protect-kernel-defaults: "true"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-ip: NODE_IP
          node-labels: "kube-ovn/role=master"
          provider-id: PROVIDER_ID
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          protect-kernel-defaults: "true"
```

Keep `encryption-provider-config`: the provider writes the file it points at, and removing the argument turns encryption at rest off.

`global-primary/13-dcscluster.yaml` — the DCS infrastructure cluster with the Self-built VIP:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSCluster
metadata:
  name: global
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
  annotations:
    cpaas.io/registry-address: "${NODE_REGISTRY_ADDRESS}"
spec:
  controlPlaneLoadBalancer:
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
    type: internal
    vrid: ${DCS_VRID}
  controlPlaneEndpoint:
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
  credentialSecretRef:
    name: "${PROVIDER_SECRET_NAME}"
  encryptionProviderConfigRef:     # DR increment
    name: "${DCS_ENCRYPTION_PROVIDER_SECRET}"
  controlPlaneHA:
    enabled: ${DCS_CONTROL_PLANE_HA}
  networkType: kube-ovn
  site: "${DCS_SITE}"
```

`controlPlaneLoadBalancer.interface` is left unset, so the provider detects the NIC from the node IP. Set it (for example to `eth1`) only on multi-NIC nodes where the VIP must sit on a specific interface — it cannot be changed later.

`global-primary/14-cluster.yaml` — the Cluster API `Cluster` with the `global` labels and annotations. The installer later rewrites `cpaas.io/registry-address` on this object and on the `DCSCluster` to the permanent platform registry:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: global
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
    cluster-type: DCS
    is-global: "true"
  annotations:
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: DCSCluster
    capi.cpaas.io/kubernetes: "${K8S_VERSION}"
    cpaas.io/registry-address: "${NODE_REGISTRY_ADDRESS}"
    cpaas.io/nodes-mode: self-managed
    cpaas.io/kube-ovn-join-cidr: "${KUBE_OVN_JOIN_CIDR}"
    cpaas.io/kube-ovn-version: "${KUBE_OVN_VERSION}"
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
      - "${CLUSTER_CIDR}"
    services:
      cidrBlocks:
      - "${SERVICE_CIDR}"
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: global-kcp
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: DCSCluster
    name: global
```

`global-primary/20-infra-pool.yaml` — the `infra` pool slots:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSIpHostnamePool
metadata:
  name: global-infra-pool
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
spec:
  pool:
  - ip: "${INFRA_NODE_IP_1}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-infra-1"
    machineName: "${NODE_NAME_PREFIX}-infra-1"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_INFRA_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${INFRA_NODE_IP_2}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-infra-2"
    machineName: "${NODE_NAME_PREFIX}-infra-2"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_INFRA_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${INFRA_NODE_IP_3}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-infra-3"
    machineName: "${NODE_NAME_PREFIX}-infra-3"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_INFRA_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
```

`global-primary/21-infra-template.yaml` — the `infra` VM; worker templates need the system disk, `/var/lib/kubelet`, and `/var/lib/containerd`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSMachineTemplate
metadata:
  name: global-infra-template
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
spec:
  template:
    spec:
      vmTemplateName: "${DCS_VM_TEMPLATE}"
      location:
        type: folder
        name: "${DCS_VM_FOLDER}"
      vmConfig:
        dvSwitchName: "${DCS_DVSWITCH}"
        portGroupName: "${DCS_PORT_GROUP}"
        dcsMachineCpuSpec:
          quantity: ${DCS_INFRA_CPU}
        dcsMachineMemorySpec:      # MB
          quantity: ${DCS_INFRA_MEMORY_MB}
        dcsMachineDiskSpec:        # GB
        - quantity: 0
          datastoreName: "${DCS_DATASTORE}"
          systemVolume: true
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/kubelet
          format: xfs
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/containerd
          format: xfs
      ipHostPoolRef:
        name: global-infra-pool
```

`global-primary/22-infra-kct.yaml` — the bootstrap template of the `infra` nodes:

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: global-infra-kct
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
spec:
  template:
    spec:
      format: ignition
      users:
      - name: boot
        sshAuthorizedKeys:
        - "${BOOT_SSH_PUBLIC_KEY}"
      files:
      - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
        owner: "root:root"
        permissions: "0644"
        contentFrom:
          secret:
            name: ${DCS_KUBERNETES_FILES_SECRET}
            key: worker-kubelet-patch.json
      preKubeadmCommands:
      - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
      - mkdir -p /run/cluster-api && restorecon -Rv /run/cluster-api
      - if [ -f /etc/disk-setup.sh ]; then bash /etc/disk-setup.sh; fi
      postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
        nodeRegistration:
          kubeletExtraArgs:
            node-ip: NODE_IP
            provider-id: PROVIDER_ID
            volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
            protect-kernel-defaults: "true"
```

`global-primary/23-infra-md.yaml` — the `infra` pool, with its role labels and taint declared on the pool, never on the nodes. `node-role.kubernetes.io/worker` puts the nodes into the default worker MachineConfigPool; the `infra` taint keeps everything that does not tolerate it off the pool:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  name: global-infra
  namespace: cpaas-system
  labels:
    cpaas.io/cluster-name: "global"
spec:
  clusterName: global
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 1
  selector:
    matchLabels: null
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: global
        pool.name: global-infra
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: global
      version: ${K8S_VERSION}
      nodeDrainTimeout: 1m
      nodeDeletionTimeout: 5m
      taints:
      - key: node-role.kubernetes.io/infra
        value: reserved
        effect: NoSchedule
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: global-infra-kct
          namespace: cpaas-system
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: DCSMachineTemplate
        name: global-infra-template
        namespace: cpaas-system
```

`global-primary/30-import-extra-resources.yaml` — Step 7 of the product page. The installer copies the listed Secrets into the new `global`. The built-in DCS migration moves the Cluster API resources but no Secret, so a Secret missing from this list exists only in the bootstrap cluster, and the first scale-out or control-plane replacement after the bootstrap node is gone fails:

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
      names:
        - "${PROVIDER_SECRET_NAME}"
        - "${DCS_ENCRYPTION_PROVIDER_SECRET}"   # DR increment
      method: kubectl
```

`global-primary/40-installer-config.json` — the installer request of Step 8. The two passwords and the registry user are placeholders that the trigger command fills in from prompts, so the file never holds a credential. `console.host` and `cluster.features.ha.vip` are this side's VIP; the platform domain goes only into `console.globalHost`:

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
    "host": ["${CONTROL_PLANE_VIP}"],
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
  "product": ["base", "acp"],
  "deployMode": "normal",
  "hostIP": "${HOST_IP}"
}
```

For the DR pair, prefer one trusted third-party platform certificate on both sides, with `PLATFORM_HOST` in its SAN list, over two unrelated self-signed ones, so that clients see the same certificate whichever side the domain points at. Replace `console.cert` with the `thirdParty` block that Step 8 of the product page describes; the page does not list its field names, so get them from Alauda support, and pass the private key at trigger time like the passwords (a placeholder in the file, added to the second `envsubst` list). This certificate is unrelated to the etcd SANs in `12-kcp.yaml`.

#### Check before applying

Render the control plane and the `infra` pool, and check them before anything reaches DCS:

```bash
# on the bootstrap cluster, in the delivery directory
load_env global-primary.env
mkdir -p rendered
for f in global-primary/1?-*.yaml; do render global-primary.env "$f"; echo '---'; done > rendered/global-primary-cp.yaml
for f in global-primary/2?-infra-*.yaml; do render global-primary.env "$f"; echo '---'; done > rendered/global-primary-infra.yaml
render global-primary.env global-primary/30-import-extra-resources.yaml > rendered/global-primary-30.yaml

grep -n '\${' rendered/global-primary-*.yaml                                  # expect no output
grep -niE 'authkey|authuser|password' rendered/global-primary-*.yaml            # expect no output
grep -c 'provider-id: PROVIDER_ID' rendered/global-primary-cp.yaml              # expect 2
grep -c 'node-ip: NODE_IP' rendered/global-primary-cp.yaml rendered/global-primary-infra.yaml   # expect 1 each
grep -n "ip: \"${CONTROL_PLANE_VIP}\"" rendered/global-primary-*.yaml           # expect no output: the VIP is in no pool
python3 - "${CLUSTER_CIDR}" "${SERVICE_CIDR}" "${KUBE_OVN_JOIN_CIDR}" "${CP_NODE_IP_1}/${DCS_NODE_MASK}" <<'EOF'
import ipaddress, itertools, sys
nets = [ipaddress.ip_network(a, strict=False) for a in sys.argv[1:]]
bad = [(str(a), str(b)) for a, b in itertools.combinations(nets, 2) if a.overlaps(b)]
print("overlap: %s" % bad if bad else "no overlap")
EOF
python3 -c 'import ipaddress, sys; ipaddress.IPv4Address(sys.argv[1]); print("endpoint is an IPv4 address")' "${CONTROL_PLANE_VIP}"
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}" "${DCS_ENCRYPTION_PROVIDER_SECRET}" -o name
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply --dry-run=server -f rendered/global-primary-cp.yaml
```

Pass: every check prints its expected result, both Secrets exist, and the server-side dry run accepts every resource. Also confirm that the three CIDRs overlap none of the VIP, DCS, other-cluster, or customer networks — the script checks only the node subnet.

#### Apply the control plane

Steps 5 and 6 of the product page. The control plane goes first and alone, so a mistake costs three VMs, not six:

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply -f rendered/global-primary-cp.yaml
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get dcsmachine,machines.cluster.x-k8s.io -o wide      # watch the VMs being created
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system wait --for=condition=Ready kubeadmcontrolplane/global-kcp --timeout=60m
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get clusters.cluster.x-k8s.io global -o jsonpath='{.status.phase}{"\n"}'
curl -k "https://${CONTROL_PLANE_VIP}:6443/readyz"; echo
umask 077
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get secret global-kubeconfig -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}"
```

Pass: the `KubeadmControlPlane` is `Ready`, the `Cluster` phase is `Provisioned`, and the VIP answers `ok`. The last command saves the admin kubeconfig that Cluster API generated for the new cluster, as the common [Kubeconfig convention](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#kubeconfig-convention) describes; it is a credential and stays out of every archive.

If a `DCSMachine` stays in `Provisioning`, stop and diagnose before you apply anything else, using [Troubleshooting: VM stuck in creating](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#stuck-creating). Deleting and re-applying only hides the cause.

#### Apply the infra pool

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply --dry-run=server -f rendered/global-primary-infra.yaml && kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply -f rendered/global-primary-infra.yaml
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get machines.cluster.x-k8s.io -l cluster.x-k8s.io/deployment-name=global-infra -o wide
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system wait --for=jsonpath='{.status.readyReplicas}'=3 machinedeployment/global-infra --timeout=60m
```

Pass: three `infra` machines are `Running`, and the MachineDeployment reports three ready replicas.

#### Import the provider Secrets

```bash
# on the bootstrap cluster
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" apply -f rendered/global-primary-30.yaml
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get cm dcs-import-extra-resources -o jsonpath='{.data.resources\.yaml}'
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system get dcscluster global -o jsonpath='{.spec.credentialSecretRef.name}{" "}{.spec.encryptionProviderConfigRef.name}{"\n"}'
```

Pass: both `names` entries are non-empty and equal the two Secret names that the `DCSCluster` references.

#### Trigger the platform installation

Step 8 of the product page. The registry user and the passwords are read at the prompt, the passwords base64-encoded as the installer expects, substituted into the rendered request, and streamed to the installer; they never reach a file or a command line. Use the same values on both `global` sides:

```bash
# on the bootstrap node, in the delivery directory
INSTALLER_IP=$(kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" get pods -n cpaas-system -l service_name=cpaas-installer -o jsonpath='{.items[0].status.podIP}')
read -rsp 'Platform admin password: ' p; echo
PLATFORM_ADMIN_PASSWORD_B64=$(printf '%s' "$p" | base64 -w0)
read -rp 'Platform registry user: ' REGISTRY_USERNAME
read -rsp 'Platform registry password: ' p; echo
REGISTRY_PASSWORD_B64=$(printf '%s' "$p" | base64 -w0); unset p
export PLATFORM_ADMIN_PASSWORD_B64 REGISTRY_USERNAME REGISTRY_PASSWORD_B64
payload=$(render global-primary.env global-primary/40-installer-config.json \
  | envsubst '${PLATFORM_ADMIN_PASSWORD_B64} ${REGISTRY_USERNAME} ${REGISTRY_PASSWORD_B64}')
unset PLATFORM_ADMIN_PASSWORD_B64 REGISTRY_USERNAME REGISTRY_PASSWORD_B64
if printf '%s' "$payload" | grep -q '\${'; then
  echo "unreplaced variables"
else
  printf '%s' "$payload" | curl -k -X POST "http://${INSTALLER_IP}:8080/cpaas-installer/api/config/dcs" \
    -H 'Content-Type: application/json' -d @-
fi
unset payload
```

`40-installer-config.json` is the one manifest with intentional placeholders left after `render`: the three runtime values above. The registry user and password are the ones the common article later prompts for when it uploads packages to the standby.

#### Monitor the installation

Step 9 of the product page; a `global` cluster typically takes 30 to 60 minutes:

```bash
# on the bootstrap node
curl "http://${INSTALLER_IP}:8080/cpaas-installer/api/progress"
tail -f /var/cpaas/data/installer.log
```

The phases, signals, and common stalls are tabulated under Step 9 of [Installing the global Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html). Pass: the progress API reports `status: Success` and `type: Complete`.

#### Verify the global cluster

```bash
# on global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide          # 6 nodes Ready: 3 control plane, 3 infra
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get clusters.platform.tkestack.io global -o jsonpath='{.status.phase}{"\n"}'
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get clustermodule global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get pods -n cpaas-system | grep -vE 'Running|Completed'   # only the header line
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}" "${DCS_ENCRYPTION_PROVIDER_SECRET}" "${DCS_KUBERNETES_FILES_SECRET}" -o name
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get machinedeployment -l cluster.x-k8s.io/cluster-name=global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerID}{"\t"}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'
```

Then check the Self-built VIP and the control-plane spread, as in the verification steps of [Configure DCSCluster](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#configure-dcscluster) and [Verify Control Plane HA](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#verify-control-plane-ha):

```bash
# on global
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get dcscluster global \
  -o jsonpath='{.spec.controlPlaneLoadBalancer.type}{" "}{.spec.controlPlaneEndpoint.host}{":"}{.spec.controlPlaneEndpoint.port}{"\n"}'
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get moduleinfo -l cpaas.io/cluster-name=global,cpaas.io/module-name=alive
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get apprelease alive
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n kube-system get pods -l app=alive -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get --raw=/version
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get dcscluster global \
  -o jsonpath='{range .status.conditions[?(@.type=="ControlPlaneHAReady")]}{.status}{" "}{.reason}{"\n"}{end}'
```

Pass: the installation reports `Success`; six nodes are `Ready`, each with a non-empty `providerID` and the IP of its pool slot; both Secrets were imported, and the provider-shipped files Secret exists, because `12-kcp.yaml` and `22-infra-kct.yaml` read it for every new machine; the endpoint type is `internal` with this side's VIP; an `alive` Pod runs on every control-plane node and `/version` answers through the VIP; `ControlPlaneHAReady` is `True` (when `DCS_CONTROL_PLANE_HA` is `true`).

The `infra` taint is already on the Nodes — taints are applied at registration — but the role labels reach the Nodes only after [Enable label synchronization](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#enable-label-synchronization), the first step of the platform plugins in the common article. Until then, `kubectl get nodes -l node-role.kubernetes.io/infra` returns nothing on this cluster; that is expected, not a wrong label.

Keep the bootstrap node until [Add disaster recovery](#add-disaster-recovery) is verified. Never delete the `Cluster`, `KubeadmControlPlane`, or DCS objects to clean up: they own the running `global` machines.

### Add disaster recovery

The `global` pair is two complete installations, each from its own bootstrap node, that differ only in their cluster env file. Disaster recovery adds three increments that must be **identical on both sides** — the encryption provider Secret built from one shared file, the same etcd server certificate SANs, and the encryption Secret in the import ConfigMap — then an install order driven by the platform domain, and `etcd-sync` on the standby. The authoritative procedure is [Optional Disaster Recovery Deployment](https://docs.alauda.io/immutable-infra/1.0/global/install.html#optional-disaster-recovery-deployment); the DCS notes are in [Provider Notes](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#provider-notes).

#### Before you start

- The [network requirements](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#network-requirements) are open in both directions between the two `global` networks: `443`, `6443`, `11443`, `2379`, and `80` only for HTTP access. The direction of traffic reverses after a failover. The product page asks for load-balancer listeners on each VIP; for a Self-built VIP it does not say which of these ports the VIP serves. Test each port from each side against the other side's VIP once both sides are up, and resolve any failure — `2379` in particular, which `etcd-sync` reads through the primary's VIP — before you install `etcd-sync`.
- `PLATFORM_HOST` is a DNS name whose record you can change. Each cluster is always reached through its own VIP; only the platform domain moves.
- Two bootstrap nodes, both prepared as in [Prepare DCS](#prepare-dcs), each holding the same delivery directory, including `global-standby/` created with `cp -r global-primary global-standby`.
- The Bare Metal-only DR steps (shared ServiceAccount signing key, rule ConfigMap) do not apply to DCS; adding them changes objects that the DCS provider does not expect.

#### Prepare the shared DR inputs

Generate the encryption key once, on the primary bootstrap node. It is a credential: it decrypts every Secret in the `global` etcd.

```bash
# on the primary bootstrap node, in the delivery directory
load_env global-primary.env
umask 077
mkdir -p "$(dirname "${ENCRYPTION_PROVIDER_CONF}")"
ENCRYPTION_PROVIDER_SECRET_B64=$(head -c 32 /dev/urandom | base64)
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
```

Copy the file over an encrypted channel to the same path on the standby bootstrap node, then prove that both nodes hold identical inputs. The increments in `12-kcp.yaml`, `13-dcscluster.yaml`, and `30-import-extra-resources.yaml` read only `site.env`, so identical files mean identical increments:

```bash
# on each bootstrap node, in the delivery directory; the two outputs must be identical
sha256sum site.env "${ENCRYPTION_PROVIDER_CONF}" global-primary/[0-4]* global-standby/[0-4]*
```

On each bootstrap cluster, before its manifests are applied, create the Secret from the shared file. `kubectl create` keeps the key out of the `last-applied-configuration` annotation:

```bash
# on the bootstrap cluster (primary with global-primary.env, standby with global-standby.env)
kubectl --kubeconfig "${BOOTSTRAP_KUBECONFIG}" -n cpaas-system create secret generic "${DCS_ENCRYPTION_PROVIDER_SECRET}" \
  --from-file=encryption-provider.conf="${ENCRYPTION_PROVIDER_CONF}"
```

The provider reads this Secret every time it builds a control-plane machine and never falls back to generating a key, so the Secret must also reach each final `global` — the second entry of `30-import-extra-resources.yaml` takes care of that. Keep the file in the customer's secret store; if it is ever lost, it can be copied back from `/etc/kubernetes/encryption-provider.conf` on a running control-plane node.

#### Install the primary, then the standby

The order matters, because the installer renders several platform resources with the platform domain, so the domain must resolve to the side being installed. It follows the common [Delivery flow](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#delivery-flow):

1. Point `PLATFORM_HOST` at `PRIMARY_CLUSTER_VIP`, and confirm it from the primary bootstrap node with `getent hosts "${PLATFORM_HOST}"`.
2. On the primary bootstrap node, with `global-primary.env`: [Prepare DCS](#prepare-dcs) (bootstrap, providers, credential Secret), the encryption Secret above, and [Install the global cluster](#install-the-global-cluster).
3. While the domain still points at the primary, copy the primary's kubeconfig to the delivery host over an encrypted channel and run the common article's stage for the primary there: upload the packages, enable label synchronization, install the Machine Configuration plugin and configure machines, then monitoring and logging.
4. Point `PLATFORM_HOST` at `STANDBY_CLUSTER_VIP`, and confirm it from the standby bootstrap node.
5. On the standby bootstrap node, repeat step 2 with `global-standby.env`, the `global-standby/` files, and `rendered/global-standby-*` in place of the primary names. `INSTALLER_IP` comes from this node's own installer Pod, and the admin password and registry credentials are the primary's.
6. Repeat step 3 on the standby with `global-standby.env`. The common upload step also pushes the `etcd-sync` package to the standby, addressed through the standby's VIP and registry.
7. Point `PLATFORM_HOST` back at `PRIMARY_CLUSTER_VIP` before anything else. The primary is the source of the first synchronization, and `etcd-sync` refuses to start while the domain points at a cluster that runs it.

From here on, the steps touch both sides at once. On the delivery host — which holds both kubeconfigs, copied from the bootstrap nodes over an encrypted channel — name them explicitly, and confirm the switch-back from inside both clusters, because cluster DNS can keep the old answer:

```bash
# on global (both sides), in the delivery directory
load_env global-primary.env
export PRIMARY_GLOBAL_KUBECONFIG=/root/.kube/acp/global-primary.kubeconfig
export STANDBY_GLOBAL_KUBECONFIG=/root/.kube/acp/global-standby.kubeconfig
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" exec -n cpaas-system deployments/sentry -- nslookup "${PLATFORM_HOST}"
done
```

Pass: both clusters resolve `PLATFORM_HOST` to `PRIMARY_CLUSTER_VIP`. If one does not, restart its CoreDNS Pods and retry.

#### Install etcd-sync

`etcd-sync` (ACP 4.4.0 and later) runs only on the current standby and copies the primary's etcd data into it. Its package is published as `etcd-sync` (`packages/etcd-sync/<minor>/etcd-sync.amd64.<version>.tgz` on the package server); it is not part of the installer bundle and reaches the standby through the common upload step. Follow [Install etcd-sync (ACP 4.4.0+)](https://docs.alauda.io/immutable-infra/1.0/global/install.html#install-etcd-sync):

```bash
# on global (standby): the plugin must be published here, not only on the primary
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" get moduleplugins | grep -i etcd
```

Create the token Secret on the standby. The token is the bearer token of the primary's `cpaas-system/k8sadmin` ServiceAccount; it passes from one cluster to the other through a shell variable and process substitution, and is never displayed, stored, or put on a command line:

```bash
# on global (primary, then standby)
ACTIVE_CLUSTER_TOKEN=$(kubectl --kubeconfig "${PRIMARY_GLOBAL_KUBECONFIG}" -n cpaas-system get secret k8sadmin -o jsonpath='{.data.token}' | base64 -d)
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system create secret generic etcd-sync-active-cluster-token \
  --from-file=token=<(printf '%s' "${ACTIVE_CLUSTER_TOKEN}")
unset ACTIVE_CLUSTER_TOKEN
```

Install the plugin from the standby's web console, opened through `https://${STANDBY_CLUSTER_VIP}`: **Administrator** view, **Marketplace > Cluster Plugins**, cluster `global`, **Alauda Container Platform etcd Synchronizer**, **Install**:

| Parameter | Value |
| --- | --- |
| Active Global Cluster VIP | The value of `PRIMARY_CLUSTER_VIP` |
| Active Global Cluster ETCD Endpoints | `https://${PRIMARY_CLUSTER_VIP}:2379` |
| Standby Cluster ETCD Endpoints | Default |
| Active Global Cluster Token Secret | `etcd-sync-active-cluster-token` |
| Data Check Interval | Default |
| Print detail logs | Disabled |

The `etcd-sync-bootstrap` Job runs before the `etcd-sync` Deployment and prepares the remote etcd CA, issuer, and client certificate; it reaches the primary's API server on `6443`.

#### Verify the pair

On the standby, verify the plugin runtime, following [Enable etcd Synchronization](https://docs.alauda.io/container_platform/4.4/install/global_dr.html#etcd_sync):

```bash
# on global (standby)
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n kube-public get configmap etcd-sync -o name   # present only on the standby
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get job etcd-sync-bootstrap
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get secret remote-etcd-ca remote-etcd-client
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get issuer remote-etcd-issuer
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get certificate remote-etcd-client
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get po -l app=etcd-sync
leader_pod=$(kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system get lease etcd-sync-mirror -o jsonpath='{.spec.holderIdentity}')
kubectl --kubeconfig "${STANDBY_GLOBAL_KUBECONFIG}" -n cpaas-system logs "$leader_pod" | grep -E "Acquired leader lease|Start Sync update"
```

The monitor Service only has a ClusterIP, so run the consistency check on a standby control-plane node (log in as `boot`). A check answered with HTTP `425` is not allowed yet; retry until it runs:

```bash
# on a node: a control-plane node of the standby
mirror_svc=$(sudo kubectl -n cpaas-system get svc etcd-sync-monitor -o jsonpath='{.spec.clusterIP}')
if [[ $mirror_svc =~ ^[0-9a-fA-F:]+$ ]]; then mirror_host="[$mirror_svc]"; else mirror_host="$mirror_svc"; fi
until code=$(curl -sg -o /tmp/etcd-sync-check.txt -w '%{http_code}' "http://$mirror_host/check") && [ "$code" != 425 ]; do sleep 30; done
cat /tmp/etcd-sync-check.txt
```

Pass: zero missed and zero surplus keys. Do not accept the pair on the AppRelease status alone.

Prove that the three increments are identical on both final clusters. The hash compares the encryption key without printing it:

```bash
# on global (both sides); each pair of lines must be identical
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system get secret "${DCS_ENCRYPTION_PROVIDER_SECRET}" -o jsonpath='{.data.encryption-provider\.conf}' | sha256sum
done
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system get kubeadmcontrolplane global-kcp \
    -o jsonpath='{.spec.kubeadmConfigSpec.clusterConfiguration.etcd.local.serverCertSANs}{"\n"}'
done
for kc in "${PRIMARY_GLOBAL_KUBECONFIG}" "${STANDBY_GLOBAL_KUBECONFIG}"; do
  kubectl --kubeconfig "$kc" -n cpaas-system get dcscluster global -o jsonpath='{.spec.encryptionProviderConfigRef.name}{"\n"}'
  kubectl --kubeconfig "$kc" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}" -o name
done
```

Then restart the Pods that load the DR and endpoint configuration, on a control-plane node of each side:

```bash
# on a node: a control-plane node of the primary, then of the standby
sudo kubectl delete po -n cpaas-system -l 'service_name in (alertmanager,vmselect,vminsert)'
sudo kubectl delete po -n cpaas-system -l service_name=cluster-transformer
```

Finally, decommission each bootstrap node once its side's Secrets were verified on the final `global` (stage 12 of the common [Delivery flow](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#delivery-flow)): remove only the `minialauda` bootstrap cluster, as described in [Decommission the Bootstrap Cluster](https://docs.alauda.io/immutable-infra/1.0/global/install.html#decommission-bootstrap-cluster), and delete the encryption file from the node.

The pair is accepted only after a failover drill with [the failover sequence](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#failover-procedure), run at acceptance once the workload clusters exist, so that the drill exercises them. After the switch, verify on the new active side that every workload `Cluster`, `Machine`, and `DCSMachine` is intact, that no VM was deleted, and that both DCS Secrets exist there.

### Create a workload cluster

A workload cluster is created by applying its Cluster API resources to `global` — always to the active side, never to the standby. The resources follow the "Using YAML" section of [Creating Clusters on Huawei DCS](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html) and [Worker Node Deployment](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-dcs.html#worker-node-deployment). All commands of this section run on the delivery host, in the delivery directory, after `load_env wl-prod.env`: `GLOBAL_KUBECONFIG` in `wl-prod.env` points at the active `global` and `CLUSTER_KUBECONFIG` at the new cluster.

#### Check global

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n kube-public get configmap etcd-sync -o name 2>/dev/null || echo "not standby"   # must print "not standby"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get pods -n cpaas-system | grep -E 'kubeadm|dcs'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get crd | grep -E '^dcs.*\.infrastructure\.cluster\.x-k8s\.io'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleconfigs -l cpaas.io/module-name=alive
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret "${PROVIDER_SECRET_NAME}" "${DCS_KUBERNETES_FILES_SECRET}" -o name
```

Pass: this is not the standby; the Kubeadm and DCS provider Pods run and the four DCS CRDs exist (otherwise install the providers as in [Huawei DCS Provider Installation](https://docs.alauda.io/immutable-infra/1.0/install/huawei-dcs.html)); the controller arguments contain `--additional-sync-machine-labels`; both Secrets exist. The `alive` line is an item to validate, not a documented DCS gate: the provider installs the Self-built VIP runtime through an `alive` ModuleInfo, but the DCS pages do not say that `alive` must be published on `global` (the vSphere page does for its provider). If it lists no version, confirm with Alauda support before you create a cluster with `type: internal`. Check the [network paths](#open-the-network-paths) from `global` to DCS and to the new cluster's VIP and nodes as well.

`CLUSTER_NAME` must not be `global` and must not start with `global-`, or a failover can select this cluster's resources as if they belonged to the `global` pair.

#### Read the shared values from global

A workload cluster does not collect its versions again: they already live on `global`, at the places the product's [Resolving Placeholder Values](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html#resolving-placeholders) names:

| Value | Lives on `global` at | Parameter |
| --- | --- | --- |
| Kubernetes version | `data.kubernetesVersion` of the `cpaas.io/dcs-vm-template` ConfigMap | `K8S_VERSION` |
| CoreDNS and etcd tags | `data.corednsTag` and `data.etcdTag` of the same ConfigMap | `DNS_IMAGE_TAG`, `ETCD_IMAGE_TAG` |
| VM template name | Value of the ConfigMap's `cpaas.io/dcs-vm-template` label | `DCS_VM_TEMPLATE` |
| Kube-OVN chart version | `cpaas.io/kube-ovn-version` annotation of `Cluster/global` | `KUBE_OVN_VERSION` |
| Registry address | `cpaas.io/registry-address` annotation of `Cluster/global` | `NODE_REGISTRY_ADDRESS` |
| DCS credential | The Secret imported during the `global` installation | `PROVIDER_SECRET_NAME` |

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get cm -l cpaas.io/dcs-vm-template -o yaml
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get clusters.cluster.x-k8s.io global \
  -o jsonpath='{.metadata.annotations.cpaas\.io/kube-ovn-version}{"\n"}{.metadata.annotations.cpaas\.io/registry-address}{"\n"}'
```

Pass: the values match `site.env`, and `NODE_REGISTRY_ADDRESS` in `wl-prod.env` is the printed registry address. If the ConfigMap query returns nothing, apply the ConfigMap shipped with the Alauda OS release first (its format is shown in [Machine Templates](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#machine-templates)). If the cluster runs in another DCS site or under another DCS account, create a separate credential Secret on `global`, named after the cluster (never with the `global-` prefix), with the commands of [Create the DCS credential Secret](#create-the-dcs-credential-secret) run against `GLOBAL_KUBECONFIG` and without the `cpaas.io/cluster-name=global` label, and set `PROVIDER_SECRET_NAME` to its name in the cluster file. The DR pages do not say how such a Secret reaches the standby `global`; confirm that with Alauda support before you rely on it after a failover.

What a new workload cluster really plans is its name, VIP and VRID, CIDRs, node IPs, sizes, and — in another site — its DCS placement.

#### Write the manifests

`wl-prod/10-cp-pool.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSIpHostnamePool
metadata:
  name: ${CLUSTER_NAME}-cp-pool
  namespace: cpaas-system
spec:
  pool:
  - ip: "${CP_NODE_IP_1}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-cp-1"
    machineName: "${NODE_NAME_PREFIX}-cp-1"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_CP_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${CP_NODE_IP_2}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-cp-2"
    machineName: "${NODE_NAME_PREFIX}-cp-2"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_CP_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${CP_NODE_IP_3}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-cp-3"
    machineName: "${NODE_NAME_PREFIX}-cp-3"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_CP_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
```

`wl-prod/11-cp-template.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-cp-template
  namespace: cpaas-system
spec:
  template:
    spec:
      vmTemplateName: "${DCS_VM_TEMPLATE}"
      location:
        type: folder
        name: "${DCS_VM_FOLDER}"
      vmConfig:
        dvSwitchName: "${DCS_DVSWITCH}"
        portGroupName: "${DCS_PORT_GROUP}"
        dcsMachineCpuSpec:
          quantity: ${DCS_CP_CPU}
        dcsMachineMemorySpec:      # MB
          quantity: ${DCS_CP_MEMORY_MB}
        dcsMachineDiskSpec:        # GB
        - quantity: 0
          datastoreName: "${DCS_DATASTORE}"
          systemVolume: true
        - quantity: 10
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/etcd
          format: xfs
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/kubelet
          format: xfs
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/containerd
          format: xfs
      ipHostPoolRef:
        name: ${CLUSTER_NAME}-cp-pool
```

`wl-prod/12-kcp.yaml` — a workload control plane skips both CoreDNS and kube-proxy, which the platform deploys, and carries no etcd SANs:

```yaml
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  name: ${CLUSTER_NAME}-kcp
  namespace: cpaas-system
  annotations:
    controlplane.cluster.x-k8s.io/skip-coredns: ""
    controlplane.cluster.x-k8s.io/skip-kube-proxy: ""
spec:
  replicas: 3
  version: ${K8S_VERSION}
  rolloutStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
  machineTemplate:
    nodeDrainTimeout: 1m
    nodeDeletionTimeout: 5m
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: DCSMachineTemplate
      name: ${CLUSTER_NAME}-cp-template
  kubeadmConfigSpec:
    format: ignition
    users:
    - name: boot
      sshAuthorizedKeys:
      - "${BOOT_SSH_PUBLIC_KEY}"
    files:
    - path: /etc/kubernetes/admission/psa-config.yaml
      owner: "root:root"
      permissions: "0644"
      contentFrom:
        secret:
          name: ${DCS_KUBERNETES_FILES_SECRET}
          key: psa-config.yaml
    - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
      owner: "root:root"
      permissions: "0644"
      contentFrom:
        secret:
          name: ${DCS_KUBERNETES_FILES_SECRET}
          key: control-plane-kubelet-patch.json
    - path: /etc/kubernetes/audit/policy.yaml
      owner: "root:root"
      permissions: "0644"
      contentFrom:
        secret:
          name: ${DCS_KUBERNETES_FILES_SECRET}
          key: audit-policy.yaml
    preKubeadmCommands:
    - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
    - mkdir -p /run/cluster-api && restorecon -Rv /run/cluster-api
    - if [ -f /etc/disk-setup.sh ]; then bash /etc/disk-setup.sh; fi
    postKubeadmCommands:
    - chmod 600 /var/lib/kubelet/config.yaml
    clusterConfiguration:
      imageRepository: ${IMAGE_REPOSITORY}
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
          encryption-provider-config: /etc/kubernetes/encryption-provider.conf
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
          flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
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
          provider-id: PROVIDER_ID
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          protect-kernel-defaults: "true"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-ip: NODE_IP
          node-labels: "kube-ovn/role=master"
          provider-id: PROVIDER_ID
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          protect-kernel-defaults: "true"
```

`wl-prod/13-dcscluster.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSCluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
spec:
  controlPlaneLoadBalancer:
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
    type: internal
    vrid: ${DCS_VRID}
  controlPlaneEndpoint:
    host: "${CONTROL_PLANE_VIP}"
    port: 6443
  credentialSecretRef:
    name: "${PROVIDER_SECRET_NAME}"
  controlPlaneHA:
    enabled: ${DCS_CONTROL_PLANE_HA}
  networkType: kube-ovn
  site: "${DCS_SITE}"
```

`wl-prod/14-cluster.yaml` — the annotations the operator authors on a workload `Cluster`; ACP writes the computed ones (`cpaas.io/nodes-number` and the like) itself. `cpaas.io/os-family` is omitted on purpose, because it is only for KubeOS templates:

```yaml
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  name: ${CLUSTER_NAME}
  namespace: cpaas-system
  labels:
    cluster-type: DCS
  annotations:
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: DCSCluster
    capi.cpaas.io/kubernetes: "${K8S_VERSION}"
    cpaas.io/kube-ovn-join-cidr: "${KUBE_OVN_JOIN_CIDR}"
    cpaas.io/kube-ovn-version: "${KUBE_OVN_VERSION}"
    cpaas.io/registry-address: "${NODE_REGISTRY_ADDRESS}"
    cpaas.io/nodes-mode: self-managed
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
      - "${CLUSTER_CIDR}"
    services:
      cidrBlocks:
      - "${SERVICE_CIDR}"
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: ${CLUSTER_NAME}-kcp
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: DCSCluster
    name: ${CLUSTER_NAME}
```

The workload cluster inherits the registry of `global`. To bind it to a dedicated registry instead, add the `cpaas.io/registry-reference` label before the first apply — it is read only at creation; see [Choose the Image Registry for a Workload Cluster](https://docs.alauda.io/immutable-infra/1.0/how-to/workload-cluster-image-registry.html).

`wl-prod/20-infra-pool.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSIpHostnamePool
metadata:
  name: ${CLUSTER_NAME}-infra-pool
  namespace: cpaas-system
spec:
  pool:
  - ip: "${INFRA_NODE_IP_1}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-infra-1"
    machineName: "${NODE_NAME_PREFIX}-infra-1"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_INFRA_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${INFRA_NODE_IP_2}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-infra-2"
    machineName: "${NODE_NAME_PREFIX}-infra-2"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_INFRA_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
  - ip: "${INFRA_NODE_IP_3}"
    mask: "${DCS_NODE_MASK}"
    gateway: "${DCS_NODE_GATEWAY}"
    dns: "${DCS_NODE_DNS}"
    hostname: "${NODE_NAME_PREFIX}-infra-3"
    machineName: "${NODE_NAME_PREFIX}-infra-3"
    persistentDisk:
    - slot: 0
      quantityGB: ${DCS_INFRA_CPAAS_DISK_GB}
      datastoreName: "${DCS_DATASTORE}"
      path: /var/cpaas
      format: xfs
      mountOptions:
      - defaults
```

`wl-prod/21-infra-template.yaml`:

```yaml
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSMachineTemplate
metadata:
  name: ${CLUSTER_NAME}-infra-template
  namespace: cpaas-system
spec:
  template:
    spec:
      vmTemplateName: "${DCS_VM_TEMPLATE}"
      location:
        type: folder
        name: "${DCS_VM_FOLDER}"
      vmConfig:
        dvSwitchName: "${DCS_DVSWITCH}"
        portGroupName: "${DCS_PORT_GROUP}"
        dcsMachineCpuSpec:
          quantity: ${DCS_INFRA_CPU}
        dcsMachineMemorySpec:      # MB
          quantity: ${DCS_INFRA_MEMORY_MB}
        dcsMachineDiskSpec:        # GB
        - quantity: 0
          datastoreName: "${DCS_DATASTORE}"
          systemVolume: true
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/kubelet
          format: xfs
        - quantity: 100
          datastoreName: "${DCS_DATASTORE}"
          path: /var/lib/containerd
          format: xfs
      ipHostPoolRef:
        name: ${CLUSTER_NAME}-infra-pool
```

`wl-prod/22-infra-kct.yaml`:

```yaml
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  name: ${CLUSTER_NAME}-infra-kct
  namespace: cpaas-system
spec:
  template:
    spec:
      format: ignition
      users:
      - name: boot
        sshAuthorizedKeys:
        - "${BOOT_SSH_PUBLIC_KEY}"
      files:
      - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
        owner: "root:root"
        permissions: "0644"
        contentFrom:
          secret:
            name: ${DCS_KUBERNETES_FILES_SECRET}
            key: worker-kubelet-patch.json
      preKubeadmCommands:
      - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
      - mkdir -p /run/cluster-api && restorecon -Rv /run/cluster-api
      - if [ -f /etc/disk-setup.sh ]; then bash /etc/disk-setup.sh; fi
      postKubeadmCommands:
      - chmod 600 /var/lib/kubelet/config.yaml
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
        nodeRegistration:
          kubeletExtraArgs:
            node-ip: NODE_IP
            provider-id: PROVIDER_ID
            volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
            protect-kernel-defaults: "true"
```

`wl-prod/23-infra-md.yaml`:

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
  selector:
    matchLabels: null
  template:
    metadata:
      labels:
        cluster.x-k8s.io/cluster-name: ${CLUSTER_NAME}
        pool.name: ${CLUSTER_NAME}-infra
        node-role.kubernetes.io/infra: ""
        node-role.kubernetes.io/worker: ""
    spec:
      clusterName: ${CLUSTER_NAME}
      version: ${K8S_VERSION}
      nodeDrainTimeout: 1m
      nodeDeletionTimeout: 5m
      taints:
      - key: node-role.kubernetes.io/infra
        value: reserved
        effect: NoSchedule
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: ${CLUSTER_NAME}-infra-kct
          namespace: cpaas-system
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: DCSMachineTemplate
        name: ${CLUSTER_NAME}-infra-template
        namespace: cpaas-system
```

A second workload cluster is `cp -r wl-prod wl-prod2` plus its own `wl-prod2.env`. The manifests stay untouched, which is what keeps one cluster's values out of another.

#### Apply the control plane

Render and check both groups, then apply the control plane and verify it before any pool exists:

```bash
# on global, in the delivery directory
for f in wl-prod/1?-*.yaml; do render wl-prod.env "$f"; echo '---'; done > rendered/wl-prod-cp.yaml
for f in wl-prod/2?-infra-*.yaml; do render wl-prod.env "$f"; echo '---'; done > rendered/wl-prod-infra.yaml
grep -n '\${' rendered/wl-prod-*.yaml                                                   # expect no output
grep -nE '^  name: "?global|clusterName: global|cluster-name: "?global' rendered/wl-prod-*.yaml   # expect no output
grep -c 'provider-id: PROVIDER_ID' rendered/wl-prod-cp.yaml                             # expect 2
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" apply --dry-run=server -f rendered/wl-prod-cp.yaml
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" apply -f rendered/wl-prod-cp.yaml
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system wait --for=condition=Ready kubeadmcontrolplane/${CLUSTER_NAME}-kcp --timeout=60m
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get clusters.cluster.x-k8s.io ${CLUSTER_NAME}
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machines.cluster.x-k8s.io,dcsmachine -l cluster.x-k8s.io/cluster-name=${CLUSTER_NAME} -o wide
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get clustermodule ${CLUSTER_NAME} -o jsonpath='{.status.base.deployStatus}{"\n"}'
```

Run the CIDR and endpoint checks of [Check before applying](#check-before-applying) with this cluster's values as well; the workload CIDRs must also stay clear of the `global` CIDRs. Then verify the Self-built VIP and the spread, and save the kubeconfig:

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get moduleinfo -l cpaas.io/cluster-name=${CLUSTER_NAME},cpaas.io/module-name=alive
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get dcscluster ${CLUSTER_NAME} \
  -o jsonpath='{range .status.conditions[?(@.type=="ControlPlaneHAReady")]}{.status}{" "}{.reason}{"\n"}{end}'
umask 077
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get secret ${CLUSTER_NAME}-kubeconfig -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}"
```

```bash
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get apprelease alive
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n kube-system get pods -l app=alive -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get --raw=/version
```

Pass: the control plane is `Ready` with three machines, the base module reports its deploy status as completed, the `alive` ModuleInfo exists and its Pods run on every control-plane node, `/version` answers through the VIP, and `ControlPlaneHAReady` is `True`.

#### Apply the infra pool

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" apply --dry-run=server -f rendered/wl-prod-infra.yaml && kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" apply -f rendered/wl-prod-infra.yaml
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system wait --for=jsonpath='{.status.readyReplicas}'=3 machinedeployment/${CLUSTER_NAME}-infra --timeout=60m
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get dcsiphostnamepool ${CLUSTER_NAME}-infra-pool -o jsonpath='{.status.persistentDiskStatus}{"\n"}'
```

```bash
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -l node-role.kubernetes.io/infra
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.providerID}{"\t"}{.spec.taints}{"\n"}{end}'
```

Pass: six nodes are `Ready`, each with a `providerID` and the IP of its pool slot; the three `infra` Nodes — not only their Machines — carry both role labels and the `infra` taint; the pool reports a persistent disk for every slot.

### Variants

#### Single cluster

`global` doubles as the workload cluster: one bootstrap node, no standby, no `etcd-sync`, no workload clusters. Skip [Add disaster recovery](#add-disaster-recovery), set `CONTROL_PLANE_VIP` directly in `global-primary.env` (the DR variables are not needed), set `INGRESS_VIP_RANGE` and `INGRESS_VIP` there as the common [Single-cluster variant](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#single-cluster-variant) describes, and do not create the encryption Secret — the provider then generates the key itself, and encryption at rest stays on. Remove the three increments:

```diff
# global-primary/12-kcp.yaml
-          serverCertSANs:          # DR increment: the same list on both sides
+          serverCertSANs:
-          - "${PRIMARY_CLUSTER_VIP}"
-          - "${STANDBY_CLUSTER_VIP}"
-          - "${PLATFORM_HOST}"
-          - "etcd.kube-system"
+          - "${CONTROL_PLANE_VIP}"
+          - "${PLATFORM_HOST}"

# global-primary/13-dcscluster.yaml
-  encryptionProviderConfigRef:     # DR increment
-    name: "${DCS_ENCRYPTION_PROVIDER_SECRET}"

# global-primary/30-import-extra-resources.yaml
       names:
         - "${PROVIDER_SECRET_NAME}"
-        - "${DCS_ENCRYPTION_PROVIDER_SECRET}"   # DR increment
```

Drop `"${DCS_ENCRYPTION_PROVIDER_SECRET}"` from the Secret checks in [Check before applying](#check-before-applying) and [Verify the global cluster](#verify-the-global-cluster). The `infra` pool then also carries the application ingress.

#### Dedicated pools

For larger workload clusters, replace the `infra` pool with `ingress` (files `30`–`33`), `monitor` (`34`–`37`), and `log` (`40`–`43`) pools. Each is the `infra` pool with its own name, role label, and taint key — distinct keys make a misplaced plugin `Pending` instead of letting it land silently on the wrong pool — and every pool keeps `node-role.kubernetes.io/worker`. Derive the files, then add the new variables (`INGRESS_NODE_IP_1` to `INGRESS_NODE_IP_3`, `DCS_INGRESS_CPU`, `DCS_INGRESS_MEMORY_MB`, `DCS_INGRESS_CPAAS_DISK_GB`, and the same for `MONITOR` and `LOG`) to the cluster file:

```bash
# on the delivery host, in the delivery directory
for i in 0 1 2 3; do
  for f in wl-prod/2$i-infra-*.yaml; do
    sed -e 's/-infra/-ingress/g' -e 's#/infra#/ingress#g' -e 's/INFRA_/INGRESS_/g' "$f" > "$(echo "$f" | sed "s#/2$i-infra-#/3$i-ingress-#")"
    sed -e 's/-infra/-monitor/g' -e 's#/infra#/monitor#g' -e 's/INFRA_/MONITOR_/g' "$f" > "$(echo "$f" | sed "s#/2$i-infra-#/3$((i + 4))-monitor-#")"
    sed -e 's/-infra/-log/g' -e 's#/infra#/log#g' -e 's/INFRA_/LOG_/g' "$f" > "$(echo "$f" | sed "s#/2$i-infra-#/4$i-log-#")"
  done
done
rm wl-prod/2?-infra-*.yaml
grep -n 'infra' wl-prod/3*.yaml wl-prod/4*.yaml    # expect only infrastructureRef and infrastructure.cluster.x-k8s.io
```

The result for `wl-prod/33-ingress-md.yaml`, compared with the `infra` file:

```diff
-  name: ${CLUSTER_NAME}-infra
+  name: ${CLUSTER_NAME}-ingress
...
-        pool.name: ${CLUSTER_NAME}-infra
-        node-role.kubernetes.io/infra: ""
+        pool.name: ${CLUSTER_NAME}-ingress
+        node-role.kubernetes.io/ingress: ""
         node-role.kubernetes.io/worker: ""
...
-      - key: node-role.kubernetes.io/infra
+      - key: node-role.kubernetes.io/ingress
         value: reserved
         effect: NoSchedule
...
-          name: ${CLUSTER_NAME}-infra-kct
+          name: ${CLUSTER_NAME}-ingress-kct
...
-        name: ${CLUSTER_NAME}-infra-template
+        name: ${CLUSTER_NAME}-ingress-template
```

Render and apply each pool on its own, as in [Apply the infra pool](#apply-the-infra-pool), with the file group `wl-prod/3?-ingress-*.yaml`, then `wl-prod/3?-monitor-*.yaml`, then `wl-prod/4?-log-*.yaml`, and check each pool's Nodes before the next. Size the dedicated pools from the product capacity pages; do not scale the consolidated values.

#### Worker pools

The main line creates only the control plane and the tainted `infra` pool, so a cluster built from it has no untainted node for applications. Add the customer's worker pools before handing the cluster over; they follow the customer's machines. One generic, untainted pool is the `infra` pool without the `infra` role label and taint — the same four resources as the product's [Worker Node Deployment](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-dcs.html#worker-node-deployment), with the persistent `/var/cpaas` disk and `maxSurge: 0`. Derive it as files `44`–`47` from the `infra` files — with the dedicated layout, before the `rm` of [Dedicated pools](#dedicated-pools) removes them — then add `WORKER_NODE_IP_1` to `WORKER_NODE_IP_3` (or as many slots as the pool has replicas), `DCS_WORKER_CPU`, `DCS_WORKER_MEMORY_MB`, and `DCS_WORKER_CPAAS_DISK_GB` to the cluster file:

```bash
# on the delivery host, in the delivery directory (use global-primary/ for a single-cluster global)
for i in 0 1 2 3; do
  for f in wl-prod/2$i-infra-*.yaml; do
    sed -e 's/-infra/-worker/g' -e 's/INFRA_/WORKER_/g' \
        -e '/node-role.kubernetes.io\/infra: ""/d' -e '/^      taints:$/,/^        effect: NoSchedule$/d' \
        "$f" > "$(echo "$f" | sed "s#/2$i-infra-#/4$((i + 4))-worker-#")"
  done
done
grep -n 'infra\|taints' wl-prod/4?-worker-*.yaml    # expect only infrastructureRef and infrastructure.cluster.x-k8s.io
```

The result for `wl-prod/47-worker-md.yaml`, compared with the `infra` file:

```diff
-  name: ${CLUSTER_NAME}-infra
+  name: ${CLUSTER_NAME}-worker
...
-        pool.name: ${CLUSTER_NAME}-infra
-        node-role.kubernetes.io/infra: ""
+        pool.name: ${CLUSTER_NAME}-worker
         node-role.kubernetes.io/worker: ""
...
-      taints:
-      - key: node-role.kubernetes.io/infra
-        value: reserved
-        effect: NoSchedule
...
-          name: ${CLUSTER_NAME}-infra-kct
+          name: ${CLUSTER_NAME}-worker-kct
...
-        name: ${CLUSTER_NAME}-infra-template
+        name: ${CLUSTER_NAME}-worker-template
```

`node-role.kubernetes.io/worker` stays, so the pool receives the machine configuration of the default worker MachineConfigPool. Render and apply the group `wl-prod/4?-worker-*.yaml` as in [Apply the infra pool](#apply-the-infra-pool), with the replica count of the `MachineDeployment` no larger than the number of slots in its pool.

### Continue with the common steps

For the `global` pair, the common plugin and machine-configuration steps already ran inside the DR order (steps 3 and 6 of [Install the primary, then the standby](#install-the-primary-then-the-standby)). For each workload cluster, continue in the common article now:

1. [Install the platform plugins](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#install-the-platform-plugins), placed on the `infra` pool (or on the dedicated pools).
2. [Configure machines](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#configure-machines).
3. Add the customer's worker pools ([Worker pools](#worker-pools)); until then the cluster has no untainted node for applications.
4. [Accept the delivery](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#accept-the-delivery) on every cluster, adding the DCS checks below.

DCS acceptance checks, for each cluster after `load_env` of its file (for the `global` pair, run them once with `global-primary.env` and once with `global-standby.env`; there `GLOBAL_KUBECONFIG` is the side itself):

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get kubeadmcontrolplane ${CLUSTER_NAME}-kcp -o jsonpath='{.spec.rolloutStrategy.rollingUpdate.maxSurge}{"\n"}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machinedeployment -l cluster.x-k8s.io/cluster-name=${CLUSTER_NAME} \
  -o jsonpath='{range .items[*]}{.metadata.name}{" maxSurge="}{.spec.strategy.rollingUpdate.maxSurge}{"\n"}{end}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get dcsmachine -l cluster.x-k8s.io/cluster-name=${CLUSTER_NAME} \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.networkConfig.ip}{"\n"}{end}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get dcsiphostnamepool -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.persistentDiskStatus}{"\n"}{end}'
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get dcscluster ${CLUSTER_NAME} \
  -o jsonpath='{.spec.controlPlaneLoadBalancer.type}{" "}{range .status.conditions[?(@.type=="ControlPlaneHAReady")]}{.status}{end}{"\n"}'
```

```bash
# on a node: each node of the cluster, logged in as boot
findmnt /var/cpaas
```

Pass:

- `maxSurge` is `0` on the control plane and on every MachineDeployment.
- Every `DCSMachine` has the IP of its pool slot, and every node has a non-empty `providerID` (the common node check).
- Every pool reports its persistent disks, and `/var/cpaas` is a single dedicated mount on every node, holding the platform state, the monitoring data, and the log collector's working data. Kafka, Keeper, and ClickHouse use StorageClass volumes instead; see [Disks](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#disks).
- The endpoint type is `internal`, and `ControlPlaneHAReady` is `True`.
- Both `global` sides hold the DCS credential Secret and the same encryption Secret (see [Verify the pair](#verify-the-pair)), and the failover drill passed.
- The credential scan of [Accept the delivery](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md#accept-the-delivery), `grep -rnIiE 'aescbc|password[[:space:]]*[:=][[:space:]]*[^[:space:]]|_TOKEN=|BEGIN [A-Z ]*PRIVATE KEY' .` after every manifest is rendered into `rendered/`, finds nothing: `40-installer-config.json` holds only its three runtime placeholders, and the kubeconfigs and the encryption file are outside the delivery directory.

## Related Information

- [Installing the global Cluster (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
- [Global Cluster Disaster Recovery (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html)
- [Creating Clusters on Huawei DCS](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html)
- [Infrastructure Resources for Huawei DCS](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html)
- [Managing Nodes on Huawei DCS](https://docs.alauda.io/immutable-infra/1.0/manage-nodes/huawei-dcs.html)
- [Huawei DCS Provider](https://docs.alauda.io/immutable-infra/1.0/overview/providers/huawei-dcs.html) and its [release notes](https://docs.alauda.io/immutable-infra/1.0/release-notes/huawei_dcs.html)
- [Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html)
- [Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)
- [Communication Matrix (ACP 4.4)](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html)
- [Global Cluster Disaster Recovery (ACP 4.4)](https://docs.alauda.io/container_platform/4.4/install/global_dr.html)
- [How to Deliver ACP with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_with_Immutable_Infrastructure.md) and the provider articles for [Huawei Cloud Stack](/solutions/acp/How_to_Deliver_ACP_on_Huawei_Cloud_Stack_with_Immutable_Infrastructure.md), [Bare Metal](/solutions/acp/How_to_Deliver_ACP_on_Bare_Metal_with_Immutable_Infrastructure.md), and [VMware vSphere](/solutions/acp/How_to_Deliver_ACP_on_VMware_vSphere_with_Immutable_Infrastructure.md)
