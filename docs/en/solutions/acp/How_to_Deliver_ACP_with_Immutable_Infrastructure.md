---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# How to Deliver ACP with Immutable Infrastructure

## Purpose

This guide describes the standard delivery of Alauda Container Platform (ACP) 4.4
on Immutable Infrastructure — clusters whose nodes run Alauda OS and are managed
through Cluster API. It is the provider-neutral part of a set of five articles: the
reference design, the parameter files every manifest is rendered from, the
end-to-end delivery flow, the platform plugins, machine configuration, sizing, and
acceptance. Four provider articles add what differs per infrastructure: the
provider design, the `global` installation with disaster recovery (DR), and
workload cluster creation.

The product documentation remains the field-level reference. These articles fix
the choices — which option, which value, in which order — assemble them into
complete manifests with `${VAR}` placeholders, and give the check that proves each
step worked.

Scope and assumptions:

- **ACP 4.4, Alauda OS nodes only.** For a non-Alauda OS, use the
  [standard installation path](https://docs.alauda.io/container_platform/4.4/install/index.html).
- **Two supported topologies.** A dedicated `global` cluster (primary + standby
  for DR) managing N workload clusters is the main line; a single cluster in which
  `global` doubles as the workload cluster is a supported variant.
- **No commercial load balancer is assumed** for the platform and cluster API
  VIPs. A customer's commercial load balancer, if any, serves application ingress
  only.
- **Worker pools are sized by the customer.** They follow the customer's
  machines; these articles cover the clusters and the platform node pools, but
  every cluster needs worker pools before handover (see
  [Node pools, labels and taints](#node-pools-labels-and-taints)).
- **Application storage is out of scope** and is planned separately.

**Validation status.** The manifests are assembled from the ACP 4.4 product
documentation and the provider versions named in the provider articles. Validate
them in a staging environment before a production delivery.

## Resolution

### How to use these articles

A delivery chooses a provider twice: once for `global` and once for the workload
clusters. They can differ — for example `global` on Huawei DCS and workload
clusters on VMware vSphere.

1. Read this article's [Reference design](#reference-design),
   [Prepare the parameter files](#prepare-the-parameter-files) and
   [Delivery flow](#delivery-flow) end to end.
2. Open the provider article for the infrastructure that hosts `global`; install
   `global` and add disaster recovery.
3. Open the provider article for the workload-cluster infrastructure and create
   the workload clusters.
4. Return here for [Install the platform plugins](#install-the-platform-plugins),
   [Configure machines](#configure-machines) and
   [Accept the delivery](#accept-the-delivery) on every cluster.

| Provider | `global` (primary + standby) | Workload clusters | Article |
| --- | --- | --- | --- |
| Huawei DCS | Yes | Yes | [How to Deliver ACP on Huawei DCS with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_DCS_with_Immutable_Infrastructure.md) |
| Huawei Cloud Stack | Yes | Yes | [How to Deliver ACP on Huawei Cloud Stack with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_Cloud_Stack_with_Immutable_Infrastructure.md) |
| Bare Metal | Yes, including preparing `global` as the management cluster | Yes | [How to Deliver ACP on Bare Metal with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Bare_Metal_with_Immutable_Infrastructure.md) |
| VMware vSphere | No — `global` runs on another provider and already exists | Yes | [How to Deliver ACP on VMware vSphere with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_VMware_vSphere_with_Immutable_Infrastructure.md) |

Conventions shared by all five articles:

- Every command block starts with a comment that names the cluster it runs
  against — `# on the bootstrap cluster`, `# on global`,
  `# on the workload cluster`, or `# on the cluster` for a step that applies to
  every cluster, `global` included — or the host it runs on (`# on the delivery
  host`, `# on a node`). See [Kubeconfig convention](#kubeconfig-convention).
- Manifests are shown as files, `<cluster-dir>/<NN>-<name>.yaml`, numbered in
  apply order. Provider articles number the cluster manifests below `50`; this
  article uses `50` to `79`. Save each block as plain YAML under that name.
- `${VAR}` placeholders are filled from the parameter files by the
  [`render` helper](#the-render-helper); nothing else in a manifest is edited by
  hand.
- Every command runs in Bash, from the delivery directory; see
  [The render helper](#the-render-helper).

### Reference design

#### Component selection

Only choices with a real alternative are listed; everything else follows the
product defaults.

| Area | Selected | Alternative | Why |
| --- | --- | --- | --- |
| Monitoring | **Monitoring for VictoriaMetrics** | Monitoring for Prometheus | Highly available installation and lower resource usage per the [component selection guide](https://docs.alauda.io/container_platform/4.4/observability/monitor/architecture/component_selection_suggestion.html) |
| Log storage | **ClickHouse** | OpenSearch | Lowest resource usage per ingest unit and the highest throughput per node ([Log Component Selection Guide](https://docs.alauda.io/logging-service/4.4/architecture/component_suggestion.html)). ClickHouse does not support IPv6-only or dual-stack workload clusters — use OpenSearch there. The install of the log stack is deferred, see [Logging](#logging) |
| Log buffer | **Kafka** (KRaft mode) | — | Mandatory on ACP 4.4 for both log backends: it buffers records between the collector and the storage backend |
| Application ingress | **Alauda Build of Ingress NGINX Controller** | Envoy Gateway | Current standard path |
| Application ingress VIP | **MetalLB** (Layer 2) | Customer's commercial load balancer | Mutually exclusive on the same VIP — an address cannot be announced by MetalLB (ARP) and forwarded by a load balancer device at the same time. With a commercial load balancer, set `IngressNginx.spec.controller.hostNetwork: true`; otherwise the controller's Service is `ClusterIP` and the load balancer has nothing to forward to |
| Cluster API VIP | Provider mechanism, see [Endpoints and addresses](#endpoints-and-addresses) | External load balancer | No commercial load balancer is assumed |

#### Endpoints and addresses

The **cluster endpoint is always an IP address (a VIP), never a domain name.** The
API server certificate can only be issued by the cluster's own CA, so a
customer-issued certificate cannot be served on the endpoint, and a domain without
that certificate defeats its usual purpose. Only the **platform access address**
(`PLATFORM_HOST`) uses a domain, and only that domain switches during a DR
failover. Plan every VIP as a permanent address: it is written into the API server
certificate, every kubeconfig and every management connection, and changing it
later is a certificate and connectivity migration
([Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html)).

| Provider | Cluster API VIP | Condition |
| --- | --- | --- |
| Huawei DCS | `type: internal` Self-built VIP | DCS Provider `v1.0.22+` with ACP 4.4+. An external load balancer is the alternative |
| Huawei Cloud Stack | ELB created by the provider | — |
| VMware vSphere | `type: internal` Self-built VIP | vSphere Provider `v1.0.17+` with ACP 4.4+. A creation-time choice: it cannot be added to or removed from an existing cluster |
| Bare Metal | `type: Internal` (Alive) or `External` | — |

A Self-built VIP needs an unused IPv4 address in the same Layer-2 network as the
control-plane interfaces, a VRID that is unique in that Layer-2 domain, and VRRP
and gratuitous ARP allowed between the control-plane nodes and the network.

The **application ingress VIP** (`INGRESS_VIP`) comes from a MetalLB address pool
(`INGRESS_VIP_RANGE`). It must be Layer-2 adjacent to the nodes that announce it,
unused by the physical network (no gateway addresses), and outside every cluster
CIDR ([MetalLB constraints](https://docs.alauda.io/container_platform/4.4/networking/operators/metallb_operator.html)).

#### Topologies

**Multi-cluster** — one `global` pair (primary + standby) plus N workload clusters:

```
platform domain ──▶ global primary ──── etcd data ────▶ global standby
                         │                               (runs etcd-sync)
                         │ manages
                         ▼
                  workload cluster × N
```

- Each side of the `global` pair is a complete installation from its own
  bootstrap node, with its own registry, monitoring and logging.
- The DR increments must be identical on both sides: the encryption provider
  configuration created from one shared file, the same etcd server certificate
  SANs, and the provider-specific DR fields. A mismatch installs cleanly and
  surfaces only at the first failover.
- The `global` naming convention is a hard requirement: the CAPI `Cluster` and
  the provider infrastructure cluster are named exactly `global`, and every other
  resource of the `global` cluster carries the `global-` prefix. DR identifies the
  resources of the `global` pair by that prefix; a resource without it is lost at
  failover
  ([naming convention](https://docs.alauda.io/immutable-infra/1.0/global/install.html#common-prerequisites)).

**Single cluster** — `global` doubles as the workload cluster: one bootstrap node,
no DR, no cross-cluster management. `global` then also carries the application
ingress. A customer may run several such clusters that are deliberately
independent of each other.

#### Node pools, labels and taints

| Layout | Pools | When |
| --- | --- | --- |
| Consolidated | `control-plane` + one `infra` pool carrying ingress, monitoring and logging | Up to roughly 20 workers |
| Dedicated | `control-plane` + `ingress` + `monitor` + `log` | Larger clusters; recalculate sizing against the product capacity pages |

`global` uses the consolidated layout. Worker pools for applications are added
per the customer's machines and carry no platform taint. The main line creates
only the control plane, which carries the kubeadm control-plane taint, and tainted
platform pools, so a new cluster has no untainted node. Application workloads, and
any component that does not tolerate those taints, need an untainted worker pool:
add the customer's worker pools as the provider article describes before handing
a cluster over.

| Pool | Labels | Taint |
| --- | --- | --- |
| `infra` | `node-role.kubernetes.io/infra: ""`, `node-role.kubernetes.io/worker: ""` | `node-role.kubernetes.io/infra=reserved:NoSchedule` |
| `ingress` | `node-role.kubernetes.io/ingress: ""`, `node-role.kubernetes.io/worker: ""` | `node-role.kubernetes.io/ingress=reserved:NoSchedule` |
| `monitor` | `node-role.kubernetes.io/monitor: ""`, `node-role.kubernetes.io/worker: ""` | `node-role.kubernetes.io/monitor=reserved:NoSchedule` |
| `log` | `node-role.kubernetes.io/log: ""`, `node-role.kubernetes.io/worker: ""` | `node-role.kubernetes.io/log=reserved:NoSchedule` |

Rules that make the layout work:

- **Labels and taints are declared on the pool resources**, never applied by hand
  on nodes: an Alauda OS node is replaced, not mutated, so a hand-made label
  disappears with the next replacement
  ([Cluster Node Planning](https://docs.alauda.io/container_platform/4.4/configure/nodes/node_planning.html#creating-infra-nodes-on-immutable-clusters)).
  Taints are set on the machine template and applied at node registration.
- **A `Machine` label reaches its `Node` only after label synchronization is
  enabled** on `capi-controller-manager`
  ([Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)).
  Without it every Pod that selects a role label stays `Pending`, which looks
  exactly like a wrong label. The delivery standard syncs the role labels with
  `--additional-sync-machine-labels=node-role.kubernetes.io/.*` (the flag accepts
  regular expressions).
- **Each dedicated pool has its own taint key.** A shared key combined with the
  common `tolerations: [{operator: Exists}]` pattern silently opens every
  dedicated pool to every plugin; distinct keys make a misplaced plugin `Pending`
  immediately, which is the failure you want.
- **Every dedicated pool also carries `node-role.kubernetes.io/worker`.** The
  default `worker` MachineConfigPool selects on it; without it the nodes silently
  miss machine configuration (time zone, NTP, SSH key).
- **Use `NoSchedule`, not `NoExecute`**: a mislabeled pool during delivery should
  block scheduling, not evict running Pods.

Placement by cluster and layout (the pool each plugin runs on):

| Cluster · layout | Ingress (MetalLB + Ingress NGINX) | Monitoring | Logging |
| --- | --- | --- | --- |
| `global` · multi-cluster | — | `infra` | `infra` |
| `global` · single cluster | `infra` | `infra` | `infra` |
| Workload · consolidated | `infra` | `infra` | `infra` |
| Workload · dedicated pools | `ingress` | `monitor` | `log` |

The logging column is the planned placement of the logging pool; the install of
the logging stack itself is deferred, see [Logging](#logging).

DaemonSets that must cover every node (node exporter, CNI, CSI, the machine
configuration daemon, and the log collector once logging is installed) are not
placed; they are checked for coverage in
[DaemonSet coverage](#daemonset-coverage).

#### Disks

**One persistent `/var/cpaas` disk per node.** Monitoring writes to a
sub-directory under it; Alauda OS keeps node-local platform data under
`/var/cpaas`, and the root filesystem is read-only, so the plugin defaults under
`/cpaas/...` are replaced by `/var/cpaas/...` everywhere in this article. Declare
the disk with the provider's persistent-disk mechanism so that it survives node
replacement:

| Provider | Persistent disk field |
| --- | --- |
| Huawei DCS | `DCSIpHostnamePool.spec.pool[].persistentDisk` |
| Huawei Cloud Stack | `HCSMachineConfigPool.spec.configs[].persistentDisks[]` |
| VMware vSphere | `VSphereMachineConfigPool.spec.configs[].persistentDisks[]` |
| Bare Metal | `MachineInventory.spec.storage.volumes[]` |

| Path | Written by | Note |
| --- | --- | --- |
| `/var/cpaas/monitoring` | VictoriaMetrics `LocalVolume` storage | Set in the plugin installation; plan it as fixed |

Components that ask for a PersistentVolume instead of a node path take it from
the local storage system below, not from `/var/cpaas`.

Capacity is the sum of the uses: a consolidated `infra` node carries platform
state, the monitoring data and — once logging is installed — the collector's
working data on its `/var/cpaas` disk, and the volumes of the stateful components
on its local-storage disk (see [Size the clusters](#size-the-clusters)). The
trade-off of the consolidated layout is isolation — a component that fills a disk
can take the platform state with it — so compensate with retention limits and
capacity alerts, not only with a bigger disk.

Pools with persistent disks roll out with `maxSurge: 0` where the provider
requires it: a surge machine cannot take over the hostname, IP and disk slot of
the machine it replaces. The field paths differ — `KubeadmControlPlane` uses
`spec.rolloutStrategy.rollingUpdate.maxSurge` and has no `maxUnavailable`;
`MachineDeployment` uses `spec.strategy.rollingUpdate`. Copying the
`MachineDeployment` block onto a `KubeadmControlPlane` leaves the control plane at
the default surge. The provider article states which pools need it.

#### Local storage: TopoLVM

Stateful platform components — the log storage stack above all — ask for
PersistentVolumes, and this design assumes no shared storage behind them. The
selected local storage system is **TopoLVM**, delivered as the **Alauda Build of
TopoLVM** package and operated as Local Storage in the console. It manages the
nodes' own disks through LVM and, being topology aware, provisions each volume on
the node where the consuming Pod is scheduled
([Introduction](https://docs.alauda.io/container_platform/4.4/storage/storagesystem_topolvm/intro.html)).
Application storage stays out of scope; this is the platform's own storage class.

**TopoLVM is node-local, and that is a design constraint rather than a detail.**
The product page states it plainly: use local storage only for applications that
provide data replication and backup at the application layer, because local
storage gives no independent data persistence guarantee when the underlying node
fails
([Create TopoLVM Local Storage Class](https://docs.alauda.io/container_platform/4.4/configure/storage/functions/topolvm_storageclass.html)).
So anything whose loss would be a data loss either replicates across nodes itself
— which is why the logging stack is deployed with three replicas on three nodes of
the logging pool — or belongs on the persistent `/var/cpaas` disk, which the
provider reattaches to the replacement node. TopoLVM volumes are `ReadWriteOnce`
only, so nothing in this design may expect `ReadWriteMany`
([Access Modes and Volume Modes](https://docs.alauda.io/container_platform/4.4/configure/storage/concepts/selection.html)).

**Installation is console-driven**, per cluster, and has no documented YAML path
([Install](https://docs.alauda.io/container_platform/4.4/storage/storagesystem_topolvm/installation.html)):

1. Upload the **Alauda Container Platform Storage Essentials** and **Alauda Build
   of TopoLVM** packages for the platform's architecture, as in
   [Upload the packages](#upload-the-packages).
2. In **Marketplace** > **OperatorHub**, install **Alauda Container Platform
   Storage Essentials** with installation place **Recommended** — the namespace is
   `acp-storage` and no other namespace is supported — installation mode
   **Cluster**, upgrade strategy **Manual**, channel `stable`.
3. In **Storage Management** > **Local Storage**, click **Configure Now** and
   deploy the operator, then create the cluster by adding devices: a node with at
   least one bare disk, a device class named after the nature of the disks (for
   example `ssd`), and the **whole** device (for example `/dev/sdb`) — a partition
   of a disk is rejected. Add every node of the logging pool. Enable snapshot
   support only if the Volume Snapshot plugin is deployed on that cluster.
4. Create the StorageClass. The product documents the console form and no YAML
   field reference for it, so create it in the console instead of as a manifest of
   this delivery, and record its name in the cluster file as
   `LOCAL_STORAGE_CLASS`. The delivery standard chooses: the device class created
   above (or **Auto-Allocated**), file system **XFS**, access mode
   **ReadWriteOnce** (the only mode TopoLVM offers), reclaim policy **Delete** so
   that a component which recreates its claim does not leave an orphaned volume
   holding the node's space, and **PVC reconstruction disabled** — the product
   requires more storage nodes than application replicas for it, which a
   three-replica component on a three-node pool does not satisfy, and a claim
   rebuilt on another node comes back empty.

```bash
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get storageclass "${LOCAL_STORAGE_CLASS}" -o wide
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get csidrivers
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get csinodes \
  -o custom-columns=NAME:.metadata.name,DRIVERS:.spec.drivers[*].name
```

The StorageClass exists, and the TopoLVM CSI driver is registered on every node
that was added to the storage cluster.

**One unformatted disk per TopoLVM node, in addition to the `/var/cpaas` disk.**
The console accepts only a node with at least one bare disk, and only a whole
device. A node that is to run TopoLVM therefore needs a second data disk that no
provider mechanism has formatted — and only vSphere documents how to get one:

| Provider | Unformatted data disk for TopoLVM |
| --- | --- |
| VMware vSphere | **Documented.** Declare the extra disk in the node slot without `mountPath` and without `fsFormat`; it is attached raw, with a symlink at `/dev/disk/by-capv/<name>` ([Add data disks](https://docs.alauda.io/immutable-infra/1.0/create-cluster/vmware-vsphere.html#add-data-disks)) |
| Huawei DCS | **Not documented.** A pool-managed persistent disk always carries a filesystem: `format` is the filesystem used when the disk is first initialized, and the guest disk setup formats a disk that has none ([Persistent Disks in the IP Pool](https://docs.alauda.io/immutable-infra/1.0/infrastructure/huawei-dcs.html#persistent-disks-in-the-ip-pool)) |
| Huawei Cloud Stack | **Not documented.** `HCSMachineConfigPool.spec.configs[].persistentDisks[].format` defaults to `xfs` when it is omitted ([Configure Machine Configuration Pool](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-cloud-stack.html#configure-machine-configuration-pool)) |
| Bare Metal | **Not documented as a managed volume.** `MachineInventory.spec.storage` makes a whole-device XFS or ext4 filesystem or adopts an existing one, and does not create partitions or manage LVM ([Manage Data Disks on Bare-Metal Hosts](https://docs.alauda.io/immutable-infra/1.0/how-to/manage-bare-metal-storage.html#step-2-define-the-managed-volumes)). A disk meant for TopoLVM is left out of `spec.storage` so that the provider never touches it |

On Huawei DCS, Huawei Cloud Stack and Bare Metal the provider documentation does
not describe how to leave a declared disk unformatted. Do not improvise a
mechanism: put the requirement — one unformatted whole disk per TopoLVM node,
next to the `/var/cpaas` disk — into the hardware plan, and confirm the approach
with Alauda support before the machines are ordered.

**One prerequisite is unresolved on Alauda OS.** The TopoLVM installation page
requires the `lvm2` package on every node of the storage cluster and tells you to
install it with a package manager on the node. That assumes a traditional,
mutable operating system; on Alauda OS the root filesystem is read-only, so a
package cannot be installed on a running node. Confirm with Alauda support that
the Alauda OS image of the delivered release provides `lvm2` and the TopoLVM node
components before committing a delivery to TopoLVM.

#### Observability

Every cluster observes itself: each cluster runs the full monitoring stack and its
own log storage, and each side of the `global` pair collects, stores and queries
only its own data. Synchronization does not change that. `etcd-sync` replicates
etcd under a rule set of key prefixes with a maintained deny-list of platform
objects: most objects cross, Secrets included, but each `global` side keeps its
own plugins — `ModuleInfo` objects whose name starts with `global-` are excluded,
apart from a few re-included by name, while a workload cluster's `ModuleInfo`
objects do cross — and its own machine configuration, which is not synchronized at
all. Observability data is not in etcd in the first place: it lives on the nodes'
disks and in PersistentVolumes, so it never reaches the standby
([Observability Placement](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#observability-placement)).
**Workload cluster metrics and logs are never written to either `global`
cluster** — that data becomes unavailable when the `global` roles change.

On ACP 4.4 the log stack has five parts: on every storage cluster Kafka,
ClickHouse and Alauda Container Platform Log Storage Management (which derives
the ingest and query tier from a `PlatformLogForward`); on every collected cluster
the Log Collector; and on `global` only Log Essentials, which publishes the query
APIs used by the console.

If the customer needs one query point across workload clusters, the product's
aggregation model applies instead: a dedicated workload cluster runs the
VictoriaMetrics Center and the log storage, and the other workload clusters run
agents that point at it — never at `global`. The monitoring manifests below
implement the per-cluster model; the aggregation model changes only the
`crossClusterDependency` values and the agent-only setting. For logging, see the
deferred note in [Logging](#logging).

#### Network flows and ports

Freeze the port approvals before creating any cluster. Use the authoritative
pages instead of copying port tables into the delivery record:

- Component ports: [Communication Matrix](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html),
  including [What This Matrix Does Not Cover](https://docs.alauda.io/container_platform/4.4/install/prepare/communication_matrix.html#not_covered).
  The host firewall of Alauda OS nodes is maintained by the platform; use the
  matrix for the network firewalls between zones.
- `global` DR pair: the bidirectional [DR network requirements](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#network-requirements).
- Bootstrap node and provider API flows: the provider article and the
  [bootstrap network requirements](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-network).

### Prepare the parameter files

#### Files and layout

Every manifest of a delivery is rendered from two parameter files: `site.env`
(values common to every cluster of the delivery) and one file per cluster. Every
cluster file uses **the same variable names** — a new cluster file is a copy of an
existing one with different values. Combined with one manifest directory per
cluster, this makes it impossible to apply one cluster's values to another by
accident.

```
acp-delivery/
├── site.env
├── global-primary.env
├── global-standby.env
├── wl-prod.env             # one file per workload cluster: wl-<name>.env
├── global-primary/         # manifests of the primary global (provider: <50, common: 50–79)
├── global-standby/
└── wl-prod/
```

Rules for the `.env` files:

- One `NAME=value` per line, no `export`, single quotes around any value with
  spaces. Use Unix line endings.
- **No credentials.** Passwords, tokens and keys never go into a `.env` file, a
  manifest or the delivery record; see [Credentials](#credentials).
- Never deliver an example value unchanged. Provider articles add their own
  variables to the same files; they never rename a variable defined here.

#### The render helper

Every command in these articles runs in **Bash**, the shell the product requires on
the bootstrap node. The helpers use Bash-only syntax (`${!name}` indirection, word
splitting of an unquoted variable, `read -s -p`); under zsh `render` silently
substitutes nothing. Save the block below as `acp-helpers.sh` in the delivery
directory and load it in every new shell with `. ./acp-helpers.sh`; it refuses to
load in another shell.

`render` substitutes only the variables defined in `site.env` and the cluster
file; any other `$` in a manifest, such as a shell variable in an embedded script,
stays literal. It uses `envsubst` from gettext and falls back to pure Bash when
`envsubst` is missing.

```bash
#!/usr/bin/env bash
# acp-helpers.sh — load with: . ./acp-helpers.sh   (Bash only)
[ -n "${BASH_VERSION:-}" ] || { echo 'acp-helpers.sh: run these articles in bash' >&2; return 1 2>/dev/null || exit 1; }

# Usage: render <cluster.env> <manifest>   (writes the rendered manifest to stdout)
render() {
  local vars
  vars=$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' site.env "$1" | sort -u)
  (
    set -a; . ./site.env; . "./$1"; set +a
    if command -v envsubst >/dev/null 2>&1; then
      envsubst "$(printf '${%s} ' $vars)" < "$2"
    else
      local line v
      while IFS= read -r line || [ -n "$line" ]; do
        for v in $vars; do line=${line//"\${$v}"/"${!v}"}; done
        printf '%s\n' "$line"
      done < "$2"
    fi
  )
}

# Usage: load_env <cluster.env>   (loads site.env and one cluster file into this shell)
load_env() { set -a; . ./site.env; . "./$1"; set +a; }

# Usage: apply_rendered <cluster.env> <manifest> <kubeconfig>
# Renders, refuses to continue on an unreplaced placeholder, validates server-side, then applies.
apply_rendered() {
  render "$1" "$2" > /tmp/out.yaml || return 1
  if grep -nE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' /tmp/out.yaml; then echo "unreplaced variables in $2" >&2; return 1; fi
  kubectl --kubeconfig "$3" apply --dry-run=server -f /tmp/out.yaml >/dev/null || return 1
  kubectl --kubeconfig "$3" apply -f /tmp/out.yaml
}
```

The basic pattern, which `apply_rendered` wraps:

```bash
render global-primary.env global-primary/10-control-plane.yaml > /tmp/out.yaml
grep -nE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' /tmp/out.yaml && echo "unreplaced variables" || kubectl apply -f /tmp/out.yaml
```

A leftover `${NAME}` means a variable is missing from the parameter files. An
article states explicitly when a manifest contains an intentional `${...}` — a
shell expansion inside an embedded script, for example — and `apply_rendered`
lets an expansion that carries a modifier (such as `${NAME##*-}`) pass.

#### Credentials

Credentials never appear in a `.env` file, a manifest, a command typed into shell
history, or the delivery record. Read them at a prompt, use them once, and forget
them; create Secrets with `kubectl create` and reference them by name. Pass
each value through process substitution, never `--from-literal`: a literal is part
of the `kubectl` command line and visible in the process list.

```bash
# on the cluster that needs the Secret (the provider article or the step names the Secret and its keys)
read -rsp 'Password: ' SECRET_VALUE; echo
kubectl -n cpaas-system create secret generic <secret-name> \
  --from-file=<key>=<(printf '%s' "${SECRET_VALUE}")
unset SECRET_VALUE
```

Never `kubectl apply` a Secret manifest that contains a credential: `apply`
records the full object, credential included, in its
`last-applied-configuration` annotation. Keep shell tracing (`set -x`) off while a
credential is in the environment. The manifests in these articles contain no
credentials, so rendered files can be archived as they are.

#### Kubeconfig convention

Each cluster file names two kubeconfigs:

- `CLUSTER_KUBECONFIG` — the cluster itself. Commands marked
  `# on the workload cluster` (or `# on the cluster` for steps that apply to every
  cluster) use it.
- `GLOBAL_KUBECONFIG` — the `global` cluster that manages this cluster.
  `ModuleInfo` objects are always created there. In `global-primary.env` and
  `global-standby.env` both variables point at that side itself, because each
  side installs its own plugins.

Kubeconfigs are credentials: keep them outside the delivery directory with mode
`0600`, copy them between hosts only over an encrypted channel, and do not
archive them. Cluster API stores each cluster's admin kubeconfig in the Secret
`<cluster-name>-kubeconfig` on the cluster that manages it:

```bash
umask 077; mkdir -p /root/.kube/acp
# on the bootstrap node of each side: the installation guide (Step 2) copies
# /var/cpaas/data/alauda.kubeconfig to /root/.kube/config — the provider articles
# call that path BOOTSTRAP_KUBECONFIG
# on the bootstrap cluster: the global it installed — read it before the bootstrap cluster is removed
load_env global-primary.env
kubectl --kubeconfig /root/.kube/config -n cpaas-system \
  get secret global-kubeconfig -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}"
# on global: a workload cluster, after it is created
load_env wl-prod.env
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system \
  get secret "${CLUSTER_NAME}-kubeconfig" -o jsonpath='{.data.value}' | base64 -d > "${CLUSTER_KUBECONFIG}"
```

#### Common variables

Provider articles reuse these names and add their own (for example `HOST_IP`,
`NODE_REGISTRY_ADDRESS`, `PROVIDER_SECRET_NAME`, and the DR variables).

**`site.env`** — one value for the whole delivery:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `ACP_VERSION` | ACP distribution version of the Core Package | `v4.4.0` | The Core Package you download |
| `PLATFORM_HOST` | Platform access address; a domain that resolves to the active `global` VIP | `acp.example.com` | Customer DNS plan |
| `REGISTRY_DOMAIN` | Platform registry address, `<host>:11443` | `acp.example.com:11443` | Provider article (`global` installation, Step 1) |
| `K8S_VERSION` | Kubernetes version, v-prefixed, matching the Alauda OS image | `v1.35.<patch>` | The Alauda OS image or VM template of the release (provider article) |
| `TIMEZONE` | Node time zone, tz database name | `Asia/Singapore` | Agreed with the customer |
| `NTP_SERVERS` | Customer's internal NTP servers, space-separated | `192.0.2.123 192.0.2.124` | Customer network plan; never a public NTP source in production |
| `BOOT_SSH_PUBLIC_KEY` | Public key for the `boot` user on every node | `ssh-ed25519 AAAAC3...Example delivery@example.com` | Generated by the delivery team; the private key stays with the customer's administrators |
| `CHRONY_CONF_B64` | Base64 of the generated `chrony.conf` | (generated) | Written by the command in [Set NTP](#set-ntp); do not edit |
| `MACHINE_CONFIG_VERSION` | Machine Configuration plugin version | `<version>` | [Look up plugin versions](#look-up-plugin-versions) |
| `METALLB_MODULE_NAME` | Module name of the MetalLB cluster plugin | `<module name>` | [Look up plugin versions](#look-up-plugin-versions) |
| `METALLB_VERSION` | MetalLB plugin version | `<version>` | [Look up plugin versions](#look-up-plugin-versions) |
| `VICTORIAMETRICS_VERSION` | VictoriaMetrics plugin version | `<version>` | [Look up plugin versions](#look-up-plugin-versions) |
| `INGRESS_NGINX_CHANNEL` | Update channel of the Ingress NGINX operator | `stable` | [Look up plugin versions](#look-up-plugin-versions) |
| `INGRESS_NGINX_CSV` | Operator version to install (`startingCSV`) | `<csv name>` | [Look up plugin versions](#look-up-plugin-versions) |

**Cluster files** (`global-primary.env`, `global-standby.env`, `wl-<name>.env`) —
same names, one value per cluster:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `CLUSTER_NAME` | Cluster name; exactly `global` on both sides of the `global` pair | `global`, `wl-prod` | Naming plan |
| `CONTROL_PLANE_VIP` | Cluster API VIP — an IP address, never a domain | `192.0.2.10` (primary), `203.0.113.10` (standby), `192.0.2.20` (`wl-prod`) | Network plan |
| `CLUSTER_CIDR` | Pod CIDR | `100.3.0.0/16` (`global`), `198.18.0.0/16` (`wl-prod`) | Network plan. The Pod, Service and join CIDRs of every cluster must not overlap each other, another cluster's, or any node, VIP or customer network |
| `SERVICE_CIDR` | Service CIDR | `100.4.0.0/16` (`global`), `198.19.0.0/16` (`wl-prod`) | Network plan |
| `KUBE_OVN_JOIN_CIDR` | Kube-OVN join CIDR, a `/16` | `100.5.0.0/16` (`global`), `100.65.0.0/16` (`wl-prod`) | Network plan |
| `INGRESS_VIP_RANGE` | MetalLB address pool for the application ingress VIP; empty on a `global` without application ingress | `192.0.2.50/32` | Network plan |
| `INGRESS_VIP` | The ingress VIP itself, inside `INGRESS_VIP_RANGE` | `192.0.2.50` | Network plan; customer DNS points application domains at it |
| `GLOBAL_KUBECONFIG` | Kubeconfig of the `global` that manages this cluster; on a `global` side, that side itself | `/root/.kube/acp/global-primary.kubeconfig` | [Kubeconfig convention](#kubeconfig-convention) |
| `CLUSTER_KUBECONFIG` | Kubeconfig of this cluster | `/root/.kube/acp/wl-prod.kubeconfig` | [Kubeconfig convention](#kubeconfig-convention) |
| `MONITOR_SIZE` | VictoriaMetrics scale: `Small`, `Medium` or `Large` | `Medium` | [Size the clusters](#size-the-clusters) |
| `MONITOR_STORAGE_GI` | Monitoring storage per node, in Gi | `100` | [Size the clusters](#size-the-clusters) |
| `MONITOR_RETENTION_DAYS` | Metrics retention in days | `7` | Customer requirement |
| `MONITOR_STORAGE_NODES` | Node names that hold monitoring data, as a YAML list; one vmstorage replica per node | `'["wl-prod-infra-1", "wl-prod-infra-2", "wl-prod-infra-3"]'` | `kubectl get nodes -l node-role.kubernetes.io/infra` (or `.../monitor`) after the pool is up |
| `LOCAL_STORAGE_CLASS` | Name of the TopoLVM StorageClass of this cluster, used by stateful platform components | `<storage class>` | Chosen when the StorageClass is created, [Local storage: TopoLVM](#local-storage-topolvm) |

**Runtime secrets** — typed at a prompt when needed, never stored:

| Variable | Meaning | Example | Where to get it |
| --- | --- | --- | --- |
| `AC_TOKEN` | Customer Portal access token for `violet ac` | (never stored) | Customer Portal, **Settings**; valid for 24 hours |
| `ACP_TOKEN` | Platform API token for `violet push` | (never stored) | Web console of the target platform, **Profile** > **API Tokens**; the account needs the `platform-admin-system` role |
| `REGISTRY_USERNAME` | Platform registry user of a `global` side: chosen in the installation request of that side (provider articles), used again to push packages to the standby | (never stored) | Decided by the delivery; record it in the customer's credential store, not in the delivery directory |
| `REGISTRY_PASSWORD` | Platform registry password of that `global` side, likewise | (never stored) | As above |
| `SECRET_VALUE` | Any credential typed for a Secret in the [credential pattern](#credentials) | (never stored) | The system that owns the credential |

#### Example files

`site.env`:

```bash
ACP_VERSION='v4.4.0'
PLATFORM_HOST='acp.example.com'
REGISTRY_DOMAIN='acp.example.com:11443'
K8S_VERSION='v1.35.<patch>'
TIMEZONE='Asia/Singapore'
NTP_SERVERS='192.0.2.123 192.0.2.124'
BOOT_SSH_PUBLIC_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly delivery@example.com'
MACHINE_CONFIG_VERSION='<version>'
METALLB_MODULE_NAME='<module name>'
METALLB_VERSION='<version>'
VICTORIAMETRICS_VERSION='<version>'
INGRESS_NGINX_CHANNEL='stable'
INGRESS_NGINX_CSV='<csv name>'
# CHRONY_CONF_B64 is appended by the command in "Set NTP"
```

`wl-prod.env`:

```bash
CLUSTER_NAME='wl-prod'
CONTROL_PLANE_VIP='192.0.2.20'
CLUSTER_CIDR='198.18.0.0/16'
SERVICE_CIDR='198.19.0.0/16'
KUBE_OVN_JOIN_CIDR='100.65.0.0/16'
INGRESS_VIP_RANGE='192.0.2.50/32'
INGRESS_VIP='192.0.2.50'
GLOBAL_KUBECONFIG='/root/.kube/acp/global-primary.kubeconfig'
CLUSTER_KUBECONFIG='/root/.kube/acp/wl-prod.kubeconfig'
MONITOR_SIZE='Medium'
MONITOR_STORAGE_GI='100'
MONITOR_RETENTION_DAYS='7'
MONITOR_STORAGE_NODES='["wl-prod-infra-1", "wl-prod-infra-2", "wl-prod-infra-3"]'
LOCAL_STORAGE_CLASS='<storage class>'
# provider variables from the provider article follow
```

`global-standby.env` is a copy of `global-primary.env` in which `CLUSTER_NAME`
stays `global` and the addresses, CIDRs, node names and both kubeconfigs are the
standby's.

### Delivery flow

#### Multi-cluster with disaster recovery

| Stage | Action | Pass criteria |
| ---: | --- | --- |
| 1 | Freeze the machine inventory | Counts and specs derived as in [Size the clusters](#size-the-clusters) and signed off |
| 2 | Freeze networks, VIPs, DNS, certificates and port approvals | No Pod, Service or join CIDR overlaps another CIDR of any cluster or any node, VIP or customer network; every VIP is an IP address; port approvals obtained per [Network flows and ports](#network-flows-and-ports) and tested |
| 3 | Fill `site.env` and every cluster file | Every variable filled with real values (`LOCAL_STORAGE_CLASS` follows in stage 8 or 14, when the StorageClass is created); rendering leaves no `${NAME}` placeholder |
| 4 | Prepare the provider: facts, credentials, provider packages — see your provider article | Provider prerequisites checked off |
| 5 | [Download the packages](#download-the-packages) with `violet` | `violet verify` passes for every package |
| 6 | Provision **two** bootstrap nodes, one per side; never reuse one | Each meets the [bootstrap node requirements](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-requirements): at least 4 cores, 8 GB, 300 GB disk (x86_64), static IP |
| 7 | Point the platform domain at the primary VIP; install the primary `global` — see your provider article | Installer reports success; all nodes `Ready`; `ClusterModule/global` healthy |
| 8 | On the primary: upload the packages, [enable label sync](#enable-label-synchronization), install the Machine Configuration plugin and [configure machines](#configure-machines), then [local storage](#local-storage-topolvm) and monitoring | Pools `UPDATED=True`; plugins `Running` on `infra` |
| 9 | Switch the platform domain to the standby VIP; install the standby `global` — see your provider article | As stage 7, on the standby |
| 10 | Repeat stage 8 on the standby with `global-standby.env` | As stage 8, on the standby |
| 11 | Switch the platform domain back to the primary VIP; install `etcd-sync` on the standby — see your provider article | Zero missed and zero surplus keys; the standby's plugins still `Running` |
| 12 | Decommission both bootstrap clusters after the provider handoff checks | Kubeconfigs saved; provider Secrets present on both sides |
| 13 | Create the workload clusters from `global`, including the customer's worker pools — see your provider article | Every pool matches the plan; labels and taints present on the nodes; at least one untainted worker pool |
| 14 | On each workload cluster: upload the operators, install the Machine Configuration plugin and configure machines, then MetalLB and Ingress NGINX, [local storage](#local-storage-topolvm), monitoring | Each plugin verified on its intended pool |
| 15 | [Accept the delivery](#accept-the-delivery), run the failover drill, archive | Checklist passes |

Stages 7 → 9 → 11 must run in that order, and what switches is the **platform
domain** — each cluster is always reached through its own VIP. Several platform
resources are rendered with the platform domain, so it must resolve to the side
being installed; it is switched back before `etcd-sync` because the primary is
the active source of the first synchronization and `etcd-sync` refuses to start
when the domain points at a cluster that runs it
([Install etcd-sync](https://docs.alauda.io/immutable-infra/1.0/global/install.html#install-etcd-sync)).

Each side's `global` plugins are installed while the platform domain points at
that side (stages 8 and 10), before synchronization starts, and they stay that
side's own: the `global-` plugin objects and the machine configuration are not
synchronized (see [Observability](#observability)). Each side's monitoring stores
only that side's data. Keep the machine
configuration identical on both sides (same `site.env`), so that both sides
converge to the same node configuration whichever side is active.

#### Single-cluster variant

One bootstrap node; skip stages 9 to 11 and 13. `global` also receives MetalLB and
Ingress NGINX on its `infra` pool (stage 8), with `INGRESS_VIP_RANGE` and
`INGRESS_VIP` set in `global-primary.env`, and the customer's worker pools for the
applications.

#### Stop rules

Stop and find the cause instead of deleting and re-creating resources:

| Symptom | Stop | Look at first |
| --- | --- | --- |
| Machines stay `Provisioning` | Creating further pools | Provider conditions on the `Machine`, IaaS events, provider controller logs |
| `kubeadm` init or join fails | Further pools | Registry reachability, DNS, NTP, the endpoint VIP |
| API VIP unreachable | Plugin installation | VIP mode prerequisites, port approvals |
| Node without `providerID` or with a wrong IP | Acceptance | Provider resources (see the provider article) |
| Plugin Pod `Pending` or on the wrong pool | Acceptance | `nodeSelector`, taints, tolerations, label sync, local volume node affinity |
| etcd-sync reports differences | Any failover or uninstall of `etcd-sync` | [Failover](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#failover-procedure) prerequisites |

Never delete the `Cluster`, `KubeadmControlPlane` or provider infrastructure
objects of a running cluster as a cleanup step: they own the live machines, and
deleting them deletes the nodes.

### Install the platform plugins

Install plugins only after the target pool's nodes are `Ready` and carry their
labels. Placement is set through each plugin's own parameters — never by patching
the Deployments or StatefulSets that a plugin or operator generates. Ingress NGINX
and MetalLB tolerate no taints by default, so their
`nodeSelector` and tolerations are always set explicitly.

The manifests below are written for the consolidated `infra` layout. For the
dedicated layout, apply the diff shown after each manifest: replace `infra` with
`ingress`, `monitor` or `log` in both the selector and the toleration.

`ModuleInfo` objects are created on `global` even when the target is a workload
cluster. The platform renames a `ModuleInfo` after creation, so apply each one
once; later changes go through the console or the renamed object.

The commands show the workload cluster `wl-prod`. For any other cluster, load its
file and use its directory — for example `load_env global-primary.env` and
`global-primary/65-victoriametrics.yaml` for the primary `global`.

#### Enable label synchronization

Once per `global` side, before the first plugin, make `capi-controller-manager`
sync the role labels from `Machine` to `Node`:

```bash
# on global (each side)
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get deploy capi-controller-manager \
  -o jsonpath='{.spec.template.spec.containers[0].args}'; echo
# only if no --additional-sync-machine-labels argument is present yet:
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system patch deploy capi-controller-manager --type json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--additional-sync-machine-labels=node-role.kubernetes.io/.*"}]'
```

If the argument already exists with other labels, extend its value instead of
adding a second argument. Verify on the `Node`, not only on the `Machine`:

```bash
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -l node-role.kubernetes.io/infra
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
```

#### Download the packages

On a machine with Customer Portal access, install **Violet v4.2.13 or later**
([Download Packages](https://docs.alauda.io/container_platform/4.4/extend/download_package.html))
and download the Core Package and the **Common ACP Extensions** scenario for the
same version and architecture:

```bash
# on the download machine
read -rsp 'Customer Portal access token: ' AC_TOKEN; echo
violet ac login --access-token="${AC_TOKEN}"
unset AC_TOKEN
violet ac download-pkg --arch=x86 --platformVersion="${ACP_VERSION}"
violet ac scenarios --arch=amd64 --platformVersion="${ACP_VERSION}"
violet ac download-app --arch=amd64 --platformVersion="${ACP_VERSION}" --scenario="Common ACP Extensions"
violet ac packages --arch=amd64 --platformVersion="${ACP_VERSION}" --scenario="Common ACP Extensions"
```

Copy only the eight required Aligned extensions into the Core Package's
`plugins/` directory, as listed in
[Required Aligned Extensions](https://docs.alauda.io/container_platform/4.4/install/prepare/download.html#required-aligned-extensions);
everything else is uploaded after installation. Make sure the following packages
are present, and download any that the scenario does not contain by application
ID (`violet ac download-app --appID=<id> --appVersion=<version>`) or from the
Customer Portal:

| Package | Kind | Used for |
| --- | --- | --- |
| Alauda Container Platform Machine Configuration | Cluster plugin; released independently of ACP | Every cluster |
| MetalLB | Cluster plugin | Clusters with application ingress |
| Alauda Build of Ingress NGINX Controller | Operator | Clusters with application ingress |
| ACP Monitoring with VictoriaMetrics | Cluster plugin | Every cluster |
| Alauda Container Platform Storage Essentials | Operator | Every cluster ([local storage](#local-storage-topolvm)) |
| Alauda Build of TopoLVM | Operator; deployed from **Storage Management** > **Local Storage** | Every cluster ([local storage](#local-storage-topolvm)) |
| Alauda Container Platform etcd Synchronizer (`etcd-sync`) | Cluster plugin | Standby `global` (provider article) |

The logging packages are not listed: the install of the logging stack is deferred
and the new deployment scheme names its own packages — see [Logging](#logging).

Verify the signatures, then move the packages to the delivery host:

```bash
# on the download machine
violet verify <packages-directory>
```

#### Upload the packages

Keep operator packages in `packages/operators/` and cluster plugins in
`packages/plugins/`. A cluster plugin is uploaded once per platform and
distributed by its cluster affinity; an operator is uploaded to every cluster
that runs it ([Upload Packages](https://docs.alauda.io/container_platform/4.4/extend/upload_package.html#violet_push_usage)).

```bash
# on the delivery host — primary global, while the platform domain points at it
load_env global-primary.env
read -rsp 'Platform API token (primary): ' ACP_TOKEN; echo
violet push packages/plugins --platform-address "https://${PLATFORM_HOST}" --platform-token "${ACP_TOKEN}"
violet push packages/operators --platform-address "https://${PLATFORM_HOST}" --platform-token "${ACP_TOKEN}"
unset ACP_TOKEN
```

The standby `global` has its own registry, so it receives every package as well.
Address it through its own VIP and registry, as the upload page requires for a
standby; otherwise the images land in the primary's registry:

```bash
# on the delivery host — standby global
load_env global-standby.env
read -rsp 'Platform API token (standby): ' ACP_TOKEN; echo
read -rp 'Standby registry user: ' REGISTRY_USERNAME
read -rsp 'Standby registry password: ' REGISTRY_PASSWORD; echo
for dir in packages/plugins packages/operators; do
  violet push "$dir" --platform-address "https://${CONTROL_PLANE_VIP}" --platform-token "${ACP_TOKEN}" \
    --dest-repo "${CONTROL_PLANE_VIP}:11443" --username "${REGISTRY_USERNAME}" --password "${REGISTRY_PASSWORD}"
done
unset ACP_TOKEN REGISTRY_USERNAME REGISTRY_PASSWORD
```

After each workload cluster is created, upload the operators to it:

```bash
# on the delivery host — one workload cluster
load_env wl-prod.env
read -rsp 'Platform API token: ' ACP_TOKEN; echo
violet push packages/operators --platform-address "https://${PLATFORM_HOST}" --platform-token "${ACP_TOKEN}" \
  --clusters "${CLUSTER_NAME}"
unset ACP_TOKEN
```

`violet` documents no environment-variable or file input for the token and the
registry password, so they are passed as flags from shell variables: they stay out
of shell history but are visible in the process list while `violet` runs, so use
a delivery host that only the delivery team can log in to. The platform needs a
few minutes to synchronize an uploaded version before it can be installed.

#### Look up plugin versions

Read the published names and versions on `global` once and record them in
`site.env`. Install the same version on every cluster of the delivery.

```bash
# on global
for m in machine-config victoriametrics; do
  printf '%s: ' "$m"
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleconfigs -l cpaas.io/module-name="$m" \
    -o jsonpath='{range .items[*]}{.spec.version}{" "}{end}'; echo
done
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleplugins | grep -i metallb   # -> METALLB_MODULE_NAME
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleconfigs -l cpaas.io/module-name="${METALLB_MODULE_NAME}" \
  -o jsonpath='{range .items[*]}{.spec.version}{"\t"}{.spec.config}{"\n"}{end}'
```

For the operator installed by `Subscription` (Ingress NGINX), read the catalog
source, channel and CSV on a cluster it was uploaded to:

```bash
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get packagemanifest ingress-nginx-operator -o json | \
  jq -r '.status.catalogSource as $src | .status.channels[] | .name as $ch | .entries[] | [$src, $ch, .name, .version] | @tsv'
```

If the catalog source is not `platform`, set `source` in `63` to it.

#### Machine Configuration

Install it first, on every cluster: until it is installed, the `MachineConfig`,
`MachineConfigPool` and `MachineConfiguration` APIs do not exist
([Installing Machine Configuration](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/install.html)).
The plugin takes no configuration parameters.

`<cluster>/50-machine-config.yaml` — apply on `global`:

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  labels:
    cpaas.io/cluster-name: ${CLUSTER_NAME}
    cpaas.io/module-name: machine-config
    cpaas.io/module-type: plugin
  name: ${CLUSTER_NAME}-machine-config
spec:
  config: {}
  version: ${MACHINE_CONFIG_VERSION}
```

```bash
# on global
apply_rendered wl-prod.env wl-prod/50-machine-config.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleinfo -l cpaas.io/module-name=machine-config   # STATUS Running
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get deployment machine-config-controller
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get daemonset machine-config-daemon
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get machineconfigpool   # master and worker, MACHINECOUNT = node counts
```

The `worker` pool's machine count must include every `infra` (or dedicated) node;
a node missing from it lacks the `node-role.kubernetes.io/worker` label. Continue
with [Configure machines](#configure-machines) now, before the other plugins, so
that every later component starts with the agreed time zone and time source.

#### MetalLB

On clusters with application ingress: the workload clusters, and `global` in the
single-cluster variant. Confirm that the MetalLB `ModuleConfig` has an empty
`spec.config` (see [Look up plugin versions](#look-up-plugin-versions)); if it
has a form, install from **Administrator** > **Marketplace** > **Cluster
Plugins** instead
([Installing the MetalLB Operator](https://docs.alauda.io/container_platform/4.4/networking/operators/metallb_operator.html#installing_and_uninstalling_metallb)).

`<cluster>/60-metallb.yaml` — apply on `global`:

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  labels:
    cpaas.io/cluster-name: ${CLUSTER_NAME}
    cpaas.io/module-name: ${METALLB_MODULE_NAME}
    cpaas.io/module-type: plugin
  name: ${CLUSTER_NAME}-metallb
spec:
  config: {}
  version: ${METALLB_VERSION}
```

Placement is configured on the `MetalLB` resource that the plugin creates. Its
four fields cover both components: `controllerNodeSelector` and
`controllerTolerations` the controller, `nodeSelector` and `speakerTolerations`
the speaker. Without the speaker toleration the speaker cannot run on the pool and
the VIP is never announced
([Configure Component Placement](https://docs.alauda.io/container_platform/4.4/networking/operators/metallb_operator.html#configure-component-placement)).

`<cluster>/61-metallb-placement.yaml` — apply on the cluster:

```yaml
apiVersion: metallb.io/v1beta1
kind: MetalLB
metadata:
  name: metallb
  namespace: metallb-system
spec:
  controllerNodeSelector:
    node-role.kubernetes.io/infra: ""
  controllerTolerations:
    - key: node-role.kubernetes.io/infra
      operator: Exists
      effect: NoSchedule
  nodeSelector:
    node-role.kubernetes.io/infra: ""
  speakerTolerations:
    - key: node-role.kubernetes.io/infra
      operator: Exists
      effect: NoSchedule
```

The address pool is reserved for the ingress VIP (`autoAssign: false`, so no other
`LoadBalancer` Service can take it), and the Layer-2 advertisement is limited to
the pool that runs the ingress controller, so that the node announcing the VIP is
one that can serve it
([Configure MetalLB](https://docs.alauda.io/container_platform/4.4/networking/functions/configure_metallb.html)).

`<cluster>/62-metallb-ingress-pool.yaml` — apply on the cluster:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: ingress-vip
  namespace: metallb-system
spec:
  addresses:
    - ${INGRESS_VIP_RANGE}
  autoAssign: false
  avoidBuggyIPs: true
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: ingress-vip
  namespace: metallb-system
spec:
  ipAddressPools:
    - ingress-vip
  nodeSelectors:
    - matchLabels:
        node-role.kubernetes.io/infra: ""
```

```bash
# on global
apply_rendered wl-prod.env wl-prod/60-metallb.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleinfo -l cpaas.io/module-name="${METALLB_MODULE_NAME}"
# on the workload cluster, once the MetalLB resource exists
apply_rendered wl-prod.env wl-prod/61-metallb-placement.yaml "${CLUSTER_KUBECONFIG}"
apply_rendered wl-prod.env wl-prod/62-metallb-ingress-pool.yaml "${CLUSTER_KUBECONFIG}"
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n metallb-system get pods -o wide   # controller and speakers on infra nodes
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n metallb-system get ipaddresspool,l2advertisement
```

Dedicated pools — in `61`, and likewise for `nodeSelector`, `speakerTolerations`
and the `L2Advertisement` selector in `62`:

```diff
 spec:
   controllerNodeSelector:
-    node-role.kubernetes.io/infra: ""
+    node-role.kubernetes.io/ingress: ""
   controllerTolerations:
-    - key: node-role.kubernetes.io/infra
+    - key: node-role.kubernetes.io/ingress
       operator: Exists
       effect: NoSchedule
```

#### Ingress NGINX

The operator is installed from OperatorHub through a `Subscription` on the target
cluster; Alauda operators support only `Manual` approval
([Operator](https://docs.alauda.io/container_platform/4.4/extend/operator.html)).
`spec.config` places the operator Pod itself on the pool.

`<cluster>/63-ingress-nginx-operator.yaml` — apply on the cluster:

```yaml
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  annotations:
    cpaas.io/target-namespaces: ""
  name: ingress-nginx-operator
  namespace: ingress-nginx-operator
spec:
  channel: ${INGRESS_NGINX_CHANNEL}
  installPlanApproval: Manual
  name: ingress-nginx-operator
  source: platform
  sourceNamespace: cpaas-system
  startingCSV: ${INGRESS_NGINX_CSV}
  config:
    nodeSelector:
      node-role.kubernetes.io/infra: ""
    tolerations:
      - key: node-role.kubernetes.io/infra
        operator: Exists
        effect: NoSchedule
```

```bash
# on the workload cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" create namespace ingress-nginx-operator
apply_rendered wl-prod.env wl-prod/63-ingress-nginx-operator.yaml "${CLUSTER_KUBECONFIG}"
PLAN=$(kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n ingress-nginx-operator get subscription ingress-nginx-operator \
  -o jsonpath='{.status.installPlanRef.name}')
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n ingress-nginx-operator patch installplan "$PLAN" --type=json \
  -p='[{"op": "replace", "path": "/spec/approved", "value": true}]'
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n ingress-nginx-operator get csv   # PHASE Succeeded
```

The instance uses a `LoadBalancer` Service that requests the ingress VIP from the
MetalLB pool. `externalTrafficPolicy: Local` preserves the client source IP; it
requires the controller's `nodeSelector` to match the `L2Advertisement` node
selector, which `62` already does
([Tasks for Ingress NGINX](https://docs.alauda.io/container_platform/4.4/networking/how_to/tasks_for_ingress_nginx.html)).
The operator creates the IngressClass `ingress-nginx-operator-apps` for this
instance (namespace and name of the resource).

`<cluster>/64-ingress-nginx.yaml` — apply on the cluster:

```yaml
apiVersion: ingress-nginx.alauda.io/v1
kind: IngressNginx
metadata:
  name: apps
  namespace: ingress-nginx-operator
spec:
  controller:
    hostNetwork: false
    replicaCount: 2
    nodeSelector:
      node-role.kubernetes.io/infra: ""
    tolerations:
      - key: node-role.kubernetes.io/infra
        operator: Exists
        effect: NoSchedule
    service:
      type: LoadBalancer
      externalTrafficPolicy: Local
      annotations:
        metallb.universe.tf/address-pool: ingress-vip
        metallb.universe.tf/loadBalancerIPs: "${INGRESS_VIP}"
```

```bash
# on the workload cluster
apply_rendered wl-prod.env wl-prod/64-ingress-nginx.yaml "${CLUSTER_KUBECONFIG}"
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n ingress-nginx-operator get pods -o wide   # controllers on infra nodes
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n ingress-nginx-operator get svc         # EXTERNAL-IP = INGRESS_VIP
curl -s -o /dev/null -w '%{http_code}\n' "http://${INGRESS_VIP}/"                     # 404 from the default backend
```

Dedicated pools: the same `infra` → `ingress` change as for MetalLB, in `63` and
`64`.

With a customer's commercial load balancer instead of MetalLB, skip `60` to `62`,
remove `service` from `64`, and run the controller on the host network so that
the load balancer forwards to ports 80 and 443 of the pool's nodes:

```diff
   controller:
-    hostNetwork: false
+    hostNetwork: true
-    service:
-      type: LoadBalancer
-      externalTrafficPolicy: Local
-      annotations:
-        metallb.universe.tf/address-pool: ingress-vip
-        metallb.universe.tf/loadBalancerIPs: "${INGRESS_VIP}"
```

If the node firewall does not admit those ports, open them with
[Managing Firewall Ports](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/firewall.html)
rather than by changing nodes by hand.

#### Monitoring

Every cluster installs the full VictoriaMetrics stack (`agentOnly: false`) and
keeps its data on `LocalVolume` storage under the persistent `/var/cpaas` disk —
the default `/cpaas/monitoring` is not writable on Alauda OS
([LocalVolume Storage Path on Immutable Infrastructure](https://docs.alauda.io/container_platform/4.4/observability/monitor/install_monitor.html#immutable_storage_path)).
Every node in `MONITOR_STORAGE_NODES` must belong to the monitoring pool and have
the persistent disk; the number of nodes is the number of vmstorage replicas. For a
workload cluster, `global` must reach port 11780 of the workload cluster before
you install.

`<cluster>/65-victoriametrics.yaml` — apply on `global`:

```yaml
kind: ModuleInfo
apiVersion: cluster.alauda.io/v1alpha1
metadata:
  name: ${CLUSTER_NAME}-victoriametrics
  labels:
    cpaas.io/cluster-name: ${CLUSTER_NAME}
    cpaas.io/module-name: victoriametrics
    cpaas.io/module-type: plugin
spec:
  version: ${VICTORIAMETRICS_VERSION}
  config:
    storage:
      type: LocalVolume
      capacity: ${MONITOR_STORAGE_GI}
      nodes: ${MONITOR_STORAGE_NODES}
      path: /var/cpaas/monitoring
      storageClass: ""
      pvSelectorK: ""
      pvSelectorV: ""
    replicas: 1
    agentOnly: false
    agentReplicas: 1
    crossClusterDependency:
      victoriametrics: ""
    components:
      nodeSelector:
        - key: node-role.kubernetes.io/infra
          value: ""
      tolerations:
        - effect: NoSchedule
          key: node-role.kubernetes.io/infra
          operator: Exists
      nodeExporter:
        port: 9100
        resources: null
      vmstorage:
        retention: ${MONITOR_RETENTION_DAYS}
        resources: null
      kubeStateExporter:
        resources: null
      vmalert:
        resources: null
      prometheusAdapter:
        resources: null
      vmagent:
        scrapeInterval: 60
        scrapeTimeout: 45
        resources: null
      vminsert:
        resources: null
      alertmanager:
        resources: null
      vmselect:
        resources: null
    size: ${MONITOR_SIZE}
```

`components.nodeSelector` is a list of `key`/`value` entries, not a map.

```bash
# on global
apply_rendered wl-prod.env wl-prod/65-victoriametrics.yaml "${GLOBAL_KUBECONFIG}"
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleinfo -l cpaas.io/module-name=victoriametrics   # STATUS Running
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n cpaas-system get pods -o wide | \
  grep -E 'vmstorage|vminsert|vmselect|vmagent|vmalert|alertmanager'                              # on infra nodes
```

Dedicated pools:

```diff
       nodeSelector:
-        - key: node-role.kubernetes.io/infra
+        - key: node-role.kubernetes.io/monitor
           value: ""
       tolerations:
         - effect: NoSchedule
-          key: node-role.kubernetes.io/infra
+          key: node-role.kubernetes.io/monitor
           operator: Exists
```

#### Logging

**The logging stack install is deferred.** The deployment scheme of the ACP 4.4
logging stack is being revised; this article will carry its manifests and checks
once the new scheme is published. Until then, install the stack from the product
documentation and plan it from the reference design above:

- **Install** it per
  [Logging Installation](https://docs.alauda.io/logging-service/4.4/install/index.html):
  log storage on every storage cluster, the Log Collector on every collected
  cluster, and Log Essentials once on `global`. That path does not change the
  placement decisions this article already fixes — every cluster is its own log
  storage cluster, and no workload cluster writes its logs into either `global`
  side (see [Observability](#observability)).
- **Plan the storage** as [Local storage: TopoLVM](#local-storage-topolvm)
  describes. The log storage components are stateful and take their volumes from
  the local StorageClass (`LOCAL_STORAGE_CLASS`); because a node-local volume
  carries no persistence guarantee of its own, they are deployed with three
  replicas on three nodes of the logging pool. The node-level collector is
  different: it keeps its working data under `/var/cpaas/data/nevermore` on the
  persistent `/var/cpaas` disk, that path cannot be changed after installation,
  and the `/var/cpaas` sizing has to include it.
- **Plan the pool placement** as
  [Node pools, labels and taints](#node-pools-labels-and-taints) describes: the
  logging pool is `infra` in the consolidated layout and `log` in the dedicated
  layout. The logging components do not tolerate those taints by default — set
  the node selector and a `NoSchedule` toleration for the pool's taint key in
  each component's own installation parameters, never by patching the workloads
  it generates
  ([Planning Infra Nodes for Logging Storage](https://docs.alauda.io/logging-service/4.4/how_to/infra_nodes.html)).
- **Size the stack** from
  [Log Component Capacity Planning](https://docs.alauda.io/logging-service/4.4/architecture/capacity_planning.html)
  with the customer's peak log rate and retention, and add the result to
  [Size the clusters](#size-the-clusters).
- **Verify** with the product's
  [post-install verification](https://docs.alauda.io/logging-service/4.4/install/post-install-verification.html),
  which ends with a synthetic log queried back end to end, and archive its output
  with the other acceptance evidence.

The packages, the manifests, the generated credentials and the file numbers `70`
and above of the logging stack are deliberately absent here. Take them from the
new scheme when it is published, not from an earlier delivery.

#### DaemonSet coverage

After every pool is up and every plugin is installed, compare each DaemonSet with
the node count. A DaemonSet that misses a tainted pool fails silently — no error,
just no Pods, so those nodes have no log collection or node metrics.

```bash
# on the cluster
nodes=$(kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes --no-headers | wc -l)
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get ds -A --no-headers \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,DESIRED:.status.desiredNumberScheduled,READY:.status.numberReady | \
  awk -v n="$nodes" '$3 < n || $4 < $3'
```

Every line printed needs an explanation. Expected subsets are the MetalLB speaker
(ingress pool only) and DaemonSets that run on control-plane nodes only. The log
collector, node exporter, CNI and machine configuration daemon must cover every
node; report a gap to product support instead of adding tolerations by hand.

### Configure machines

Configure machines right after the Machine Configuration plugin on each cluster,
always in this order: the node disruption policy first, the `MachineConfig`
objects second. A systemd unit change without a policy falls back to the default
action, which drains and reboots every node of the pool, and a file change
without a policy is written to disk without restarting the service, so it does
not take effect
([Node Disruption Policies](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/node_disruption.html)).

The standard items are the time zone, NTP with the customer's internal source, and
the `boot` user's SSH key. Each `MachineConfig` exists twice, once per default
pool: the `worker` pool and the `master` pool (the control-plane nodes) each take
the objects labeled with their role, and the copies differ only in name and role
label. The `boot` key should be the same key that the provider manifests install
at node creation, so that the two never disagree.

On a DR pair, apply the machine configuration on **both** `global` sides, from the
same `site.env`: `MachineConfig` and `MachineConfigPool` objects are not
replicated by `etcd-sync` (see [Observability](#observability)), so a side that
was configured only once stays unconfigured.

#### Node disruption policy

`cluster` is a singleton created by the operator. `kubectl apply` replaces its
`files` and `units` lists as a whole: on a fresh cluster they are empty, but if
they already contain entries, add those entries to this file before applying.

`<cluster>/51-node-disruption-policy.yaml` — apply on the cluster:

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfiguration
metadata:
  name: cluster
spec:
  nodeDisruptionPolicy:
    files:
      - path: /etc/chrony.conf
        actions:
          - type: DaemonReload
          - type: Restart
            restart:
              serviceName: chronyd.service
    units:
      - name: set-timezone.service
        actions:
          - type: DaemonReload
          - type: Restart
            restart:
              serviceName: set-timezone.service
    sshkey:
      actions:
        - type: None
```

`chronyd` does not support a reload, so it is restarted.

```bash
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get machineconfiguration cluster -o jsonpath='{.spec.nodeDisruptionPolicy}'; echo
apply_rendered wl-prod.env wl-prod/51-node-disruption-policy.yaml "${CLUSTER_KUBECONFIG}"
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get machineconfiguration cluster \
  -o jsonpath='{.status.nodeDisruptionPolicyStatus}' | grep -o -e set-timezone.service -e /etc/chrony.conf
```

Continue only when both names are printed. Record the boot IDs now, to prove later
that no node rebooted:

```bash
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o custom-columns=NAME:.metadata.name,BOOT_ID:.status.nodeInfo.bootID > boot-ids-before.txt
```

#### Set the time zone

`/etc/localtime` is a symbolic link, which machine configuration cannot manage, so
a oneshot unit runs `timedatectl set-timezone`
([Setting the Node Time Zone](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/timezone.html)).

`<cluster>/52-timezone.yaml` — apply on the cluster:

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 99-worker-timezone
  labels:
    machineconfiguration.alauda.io/role: worker
spec:
  config:
    ignition:
      version: 3.4.0
    systemd:
      units:
        - name: set-timezone.service
          enabled: true
          contents: |
            [Unit]
            Description=Set node timezone
            After=multi-user.target

            [Service]
            Type=oneshot
            ExecStart=/usr/bin/timedatectl set-timezone ${TIMEZONE}
            RemainAfterExit=yes

            [Install]
            WantedBy=multi-user.target
---
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 99-master-timezone
  labels:
    machineconfiguration.alauda.io/role: master
spec:
  config:
    ignition:
      version: 3.4.0
    systemd:
      units:
        - name: set-timezone.service
          enabled: true
          contents: |
            [Unit]
            Description=Set node timezone
            After=multi-user.target

            [Service]
            Type=oneshot
            ExecStart=/usr/bin/timedatectl set-timezone ${TIMEZONE}
            RemainAfterExit=yes

            [Install]
            WantedBy=multi-user.target
```

#### Set NTP

The `chrony.conf` content is generated from `NTP_SERVERS` and stored base64-encoded
in `site.env`, so every cluster receives the identical file
([Configuring the Chrony Time Service](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/managing.html#configuring-the-chrony-time-service)).
Run this once per delivery, and again only when the NTP servers change:

```bash
# on the delivery host, in the delivery directory
. ./site.env
{
  for server in ${NTP_SERVERS}; do printf 'server %s iburst\n' "$server"; done
  printf 'makestep 1.0 3\nrtcsync\nlogdir /var/log/chrony\n'
} > chrony.conf
sed -i '/^CHRONY_CONF_B64=/d' site.env
printf "CHRONY_CONF_B64='%s'\n" "$(base64 -w0 chrony.conf)" >> site.env
```

`<cluster>/53-chrony.yaml` — apply on the cluster:

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 99-worker-chrony
  labels:
    machineconfiguration.alauda.io/role: worker
spec:
  config:
    ignition:
      version: 3.4.0
    storage:
      files:
        - path: /etc/chrony.conf
          mode: 0o644
          contents:
            source: 'data:text/plain;base64,${CHRONY_CONF_B64}'
---
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 99-master-chrony
  labels:
    machineconfiguration.alauda.io/role: master
spec:
  config:
    ignition:
      version: 3.4.0
    storage:
      files:
        - path: /etc/chrony.conf
          mode: 0o644
          contents:
            source: 'data:text/plain;base64,${CHRONY_CONF_B64}'
```

#### Set the boot user's SSH key

Machine configuration manages SSH keys for the `boot` user only and does not
create users; the provider manifests create the `boot` user at node creation
(their `KubeadmControlPlane` and `KubeadmConfigTemplate` user entries). SSH key
changes apply without disruption.

`<cluster>/54-boot-ssh-key.yaml` — apply on the cluster:

```yaml
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 99-worker-ssh
  labels:
    machineconfiguration.alauda.io/role: worker
spec:
  config:
    ignition:
      version: 3.4.0
    passwd:
      users:
        - user: boot
          sshAuthorizedKeys:
            - "${BOOT_SSH_PUBLIC_KEY}"
---
apiVersion: machineconfiguration.alauda.io/v1alpha1
kind: MachineConfig
metadata:
  name: 99-master-ssh
  labels:
    machineconfiguration.alauda.io/role: master
spec:
  config:
    ignition:
      version: 3.4.0
    passwd:
      users:
        - user: boot
          sshAuthorizedKeys:
            - "${BOOT_SSH_PUBLIC_KEY}"
```

#### Verify the machine configuration

```bash
# on the cluster
for f in 52-timezone 53-chrony 54-boot-ssh-key; do
  apply_rendered wl-prod.env "wl-prod/$f.yaml" "${CLUSTER_KUBECONFIG}" || break
done
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get machineconfigpool   # wait for UPDATED=True, DEGRADED=False
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get node -o custom-columns=NODE:.metadata.name,\
DESIRED:.metadata.annotations."machineconfiguration\.alauda\.io/desiredConfig",\
CURRENT:.metadata.annotations."machineconfiguration\.alauda\.io/currentConfig",\
STATE:.metadata.annotations."machineconfiguration\.alauda\.io/state"   # DESIRED = CURRENT, STATE Done
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o custom-columns=NAME:.metadata.name,BOOT_ID:.status.nodeInfo.bootID | diff boot-ids-before.txt - \
  && echo "no node rebooted"
```

Spot-check one node per pool as the `boot` user with the delivered key:

```bash
# on a node
timedatectl                              # Time zone = TIMEZONE, System clock synchronized: yes
chronyc sources -v                       # the customer's NTP servers, one selected (*)
systemctl status set-timezone.service    # active (exited)
```

A node whose files are changed by hand is marked `Degraded` and stops receiving
configuration; restore it as described in
[Managing Node Configuration](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/managing.html)
instead of editing more files.

### Size the clusters

Derive every size from the product capacity pages instead of copying numbers from
another delivery. Collect the inputs first: the number of managed clusters, the
worker node and Pod counts per cluster, the sustained log volume (logs per second
at peak) and its retention, and the metrics retention.

1. **`global` control plane** — choose the tier for the number of managed
   clusters in
   [Evaluating Resources for Global Cluster](https://docs.alauda.io/container_platform/4.4/configure/scalability/evaluating_global.html)
   and apply its vertical and horizontal scaling rules. Both sides of a DR pair
   are sized identically: after a failover the standby carries the full load.
2. **Workload control plane** — size by worker count and object density with
   [Evaluating Resources for Workload Cluster](https://docs.alauda.io/container_platform/4.4/configure/scalability/evaluating_workload.html),
   and keep the headroom it recommends for one control-plane node being offline.
3. **Monitoring** — pick the VictoriaMetrics scale whose worker-node and Pod
   counts cover the cluster in
   [Monitor Component Capacity Planning](https://docs.alauda.io/container_platform/4.4/observability/monitor/architecture/capacity_planning.html)
   (`MONITOR_SIZE`). The page's disk figures are for a 7-day retention; scale them
   proportionally to `MONITOR_RETENTION_DAYS` and add headroom
   (`MONITOR_STORAGE_GI`).
4. **Logging** — the sizes of the logging stack come with its new deployment
   scheme, together with the install; see [Logging](#logging). Collect the inputs
   now — the peak log rate, the retention and the resulting profile from
   [Log Component Capacity Planning](https://docs.alauda.io/logging-service/4.4/architecture/capacity_planning.html)
   — because they set the node count of the logging pool and the size of its
   local storage, and neither can be changed cheaply afterwards. Throughput above
   the largest documented profile is a design change, not a bigger number.
5. **Infra pool (or dedicated pools)** — add up the CPU and memory limits of every
   component placed on the pool (the plugin parameters of step 3, the ingress
   controllers, and the logging profile of step 4) and size the nodes so that the
   pool still fits with one node down, within the utilization ranges of the
   evaluation pages. Pods are scheduled by their requests, so check the free
   requests of each node, not only its totals. The three-node HA profiles set the
   minimum node count of the logging pool.
6. **Disks per node** — `/var/cpaas` carries platform state plus the data the node
   hosts: its vmstorage share, and the log collector's working data once logging
   is installed. The TopoLVM disk is separate and sized from the volumes the
   stateful components claim on that node
   ([Local storage: TopoLVM](#local-storage-topolvm)). Keep both on the baseline
   the capacity pages assume (SSD, about 6000 IOPS and 250 MB/s).
7. **Bootstrap node** — at least 4 cores, 8 GB memory and 300 GB disk on x86_64
   ([Bootstrap Node Requirements](https://docs.alauda.io/immutable-infra/1.0/global/install.html#bootstrap-host-requirements)).

The capacity tables are laboratory references: provision above them, and
recalculate and validate anything beyond the documented tiers rather than
extrapolating.

### Accept the delivery

Accept against evidence, not against "the installer finished". Run the checks on
every cluster (`load_env <cluster>.env` first) and archive their output.

**Nodes, pools and endpoint**

```bash
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -o wide        # all Ready, planned counts and IPs
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes \
  -o custom-columns=NAME:.metadata.name,VERSION:.status.nodeInfo.kubeletVersion,PROVIDER_ID:.spec.providerID,TAINTS:.spec.taints[*].key
echo "expected version: ${K8S_VERSION}"                                # every node reports it; no empty providerID
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get nodes -l node-role.kubernetes.io/infra
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" config view --minify -o jsonpath='{.clusters[0].cluster.server}'; echo
echo "expected endpoint: https://${CONTROL_PLANE_VIP}:6443"            # an IP address, never a domain
curl -kfsS "https://${CONTROL_PLANE_VIP}:6443/healthz"; echo           # ok
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" -n kube-system get cm kubeadm-config \
  -o jsonpath='{.data.ClusterConfiguration}' | grep -E 'podSubnet|serviceSubnet'
echo "expected: ${CLUSTER_CIDR} ${SERVICE_CIDR}"
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get subnet join -o jsonpath='{.spec.cidrBlock}'; echo
echo "expected: ${KUBE_OVN_JOIN_CIDR}"
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" -n cpaas-system get machines \
  -l cluster.x-k8s.io/cluster-name="${CLUSTER_NAME}"                   # every Machine Running
```

**Platform access, certificates and registry** (on the active `global`)

```bash
# on the delivery host
getent hosts "${PLATFORM_HOST}"                                        # the primary global VIP
echo | openssl s_client -connect "${PLATFORM_HOST}:443" -servername "${PLATFORM_HOST}" 2>/dev/null | \
  openssl x509 -noout -subject -enddate -ext subjectAltName            # SAN contains PLATFORM_HOST
curl -k -s -o /dev/null -w '%{http_code}\n' "https://${REGISTRY_DOMAIN}/v2/"   # 200 or 401: the registry answers
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get events -A | grep -E 'ErrImagePull|ImagePullBackOff'   # nothing
```

**Plugins and placement**

```bash
# on global
kubectl --kubeconfig "${GLOBAL_KUBECONFIG}" get moduleinfo -l cpaas.io/cluster-name="${CLUSTER_NAME}"   # all Running
# on the cluster
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get pods -A -o wide | \
  grep -E 'metallb|ingress-nginx|vmstorage|vminsert|vmselect|vmagent|vmalert|alertmanager'
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
kubectl --kubeconfig "${CLUSTER_KUBECONFIG}" get storageclass "${LOCAL_STORAGE_CLASS}" -o wide
```

Every listed Pod runs on a node of its planned pool (see the placement table in
[Node pools, labels and taints](#node-pools-labels-and-taints)), the DaemonSet
coverage check prints no unexplained line, the ingress VIP answers, and the local
StorageClass exists. When the logging stack has been installed from the product
documentation ([Logging](#logging)), add its Pods to the placement check and its
post-install verification to the evidence.

**Machine configuration** — every `MachineConfigPool` reports `UPDATED=True` and
`DEGRADED=False`, every node `STATE Done`, no unplanned reboot, and the node
spot-checks of [Configure machines](#configure-machines) pass.

**Disaster recovery** — both sides passed their installation verification, the
standby's plugins are `Running` on the standby, and synchronization reports zero
missed and zero surplus keys. Run the check on a control-plane node of the standby
(the Service address is cluster-internal):

```bash
# on a control-plane node of the standby global
mirror_host=$(sudo kubectl -n cpaas-system get svc etcd-sync-monitor -o jsonpath='{.spec.clusterIP}')
case "$mirror_host" in *:*) mirror_host="[$mirror_host]" ;; esac   # IPv6 Service address
curl -g "http://$mirror_host/check"
```

Run the failover drill per
[Failover](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html#failover-procedure)
with the customer, and after it confirm on the new active side that every workload
`Cluster` and `Machine` is intact and that the provider credential Secrets exist.
After a failover, `GLOBAL_KUBECONFIG` in every workload cluster file must point at
the new active side.

**Credentials and archive**

Render every manifest into `rendered/` for the archive, then scan the whole
delivery directory for credentials. The scan matches a value after `password:` or
`password=`, a `*_TOKEN=` assignment, an `aescbc` encryption key and a private
key block:

```bash
# on the delivery host, in the delivery directory
for d in global-primary global-standby wl-*/; do
  d=${d%/}; [ -d "$d" ] && [ -f "$d.env" ] || continue
  mkdir -p "rendered/$d"
  for m in "$d"/*.yaml; do render "$d.env" "$m" > "rendered/$m"; done
done
grep -rnIiE 'aescbc|password[[:space:]]*[:=][[:space:]]*[^[:space:]]|_TOKEN=|BEGIN [A-Z ]*PRIVATE KEY' .   # nothing
```

Archive the parameter files, the rendered manifests and the output of every check
above. Record Secret names and their custodians, never their values; kubeconfigs,
tokens and private keys stay out of the archive. If the delivery deviates from
this design, stop and resolve the deviation with the platform team before
continuing — a deviation that is cheap to fix at the design stage becomes a
re-installation later.

## Related Information

- [How to Deliver ACP on Huawei DCS with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_DCS_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on Huawei Cloud Stack with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Huawei_Cloud_Stack_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on Bare Metal with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_Bare_Metal_with_Immutable_Infrastructure.md)
- [How to Deliver ACP on VMware vSphere with Immutable Infrastructure](/solutions/acp/How_to_Deliver_ACP_on_VMware_vSphere_with_Immutable_Infrastructure.md)
- [Installing the global Cluster (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
- [Global Cluster Disaster Recovery (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html)
- [Creating Clusters](https://docs.alauda.io/immutable-infra/1.0/create-cluster/index.html)
- [Plan the Control Plane Endpoint](https://docs.alauda.io/immutable-infra/1.0/how-to/control-plane-endpoint.html)
- [Machine Configuration Overview](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/overview.html)
- [Cluster Plugin](https://docs.alauda.io/container_platform/4.4/extend/cluster_plugin.html#installing-via-yaml)
- [Monitoring Installation](https://docs.alauda.io/container_platform/4.4/observability/monitor/install_monitor.html)
- [Install Local Storage (TopoLVM)](https://docs.alauda.io/container_platform/4.4/storage/storagesystem_topolvm/installation.html)
- [Create TopoLVM Local Storage Class](https://docs.alauda.io/container_platform/4.4/configure/storage/functions/topolvm_storageclass.html)
- [Logging Installation](https://docs.alauda.io/logging-service/4.4/install/index.html)
