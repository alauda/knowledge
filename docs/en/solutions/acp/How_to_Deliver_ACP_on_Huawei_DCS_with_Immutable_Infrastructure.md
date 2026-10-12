---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.3.x
---

# How to Deliver ACP on Huawei DCS with Immutable Infrastructure

## Purpose

This guide describes the standard delivery of Alauda Container Platform (ACP) 4.3
on Huawei Datacenter Virtualization Solution (DCS) using Immutable Infrastructure
(Alauda OS) nodes: the reference design — topology, component selection, node
pools, disks, observability — and the end-to-end delivery flow from bootstrap to
acceptance. It encodes decisions verified in real deliveries so that a delivery
does not have to re-make them on site.

Scope and assumptions:

- **Two supported topologies.** A dedicated `global` cluster managing N workload
  clusters (with disaster recovery for `global`), or a single cluster where
  `global` doubles as the workload cluster for customers that do not need
  cross-cluster management. Both are supported deployment forms of the product.
- **No commercial load balancer is assumed.** Platform and cluster API VIPs use
  the platform's own mechanisms. If the customer does own a commercial load
  balancer, it serves application ingress only — never the platform VIPs.
- **Worker nodes are out of scope.** Workers follow the customer's actual
  machines; this guide covers creating the clusters and the platform node pools.
- **Storage selection is out of scope** and is planned separately.
- Traditional-OS deliveries are not covered here; see the
  [standard installation path](https://docs.alauda.io/container_platform/4.3/install/)
  for those.

## Resolution

### 1. Reference design

#### Component selection

Only choices with a real alternative are listed; everything else follows the
product defaults.

| Area | Selected | Alternative | Why |
| --- | --- | --- | --- |
| Monitoring engine | **Monitoring for VictoriaMetrics** | Monitoring for Prometheus | Lower resource usage; the recommended path |
| Log storage | **ClickHouse** (`Alauda support for ClickHouse`) | OpenSearch | The capacity planning, disk paths and retention arithmetic in this design are built on the ClickHouse figures; switching backends means re-deriving them, not editing a parameter |
| Application ingress | **Alauda Build of Ingress NGINX Controller** | Envoy Gateway, ALB | Current standard path |
| Application ingress VIP | **MetalLB** | Customer's commercial LB | Mutually exclusive — the same VIP cannot be announced by MetalLB (ARP) and forwarded by an LB device at the same time. With a commercial LB, set `IngressNginx.spec.controller.hostNetwork: true`, otherwise the controller's Service is ClusterIP and the LB has nothing to forward to |
| Cluster API / platform VIP | External load balancer (ACP 4.3) | Self-built VIP | Self-built VIP for this path starts with ACP 4.4 (on DCS it additionally requires DCS Provider v1.0.22+) |

The **cluster endpoint is always an IP address (a VIP), never a domain name** —
the API server certificate can only be issued by the cluster's own CA, so a
customer-issued certificate cannot be served on the endpoint. Only the platform
access address uses a domain name, and only that domain participates in a
disaster-recovery switch. Plan every VIP as a stable address: it is written into
the API server certificate and every kubeconfig.

#### Topologies

**Multi-cluster** — one `global` pair (primary + standby, DR by default) plus N
workload clusters:

```
global primary (6 nodes)  ←— etcd synchronization —  global standby (6 nodes)
        │ manages
        ▼
workload cluster × N
```

- Each side of the `global` pair is a complete installation; each observes only
  itself.
- Every workload cluster carries its own complete monitoring and logging stack —
  nothing aggregates into `global`.

**Single cluster** — `global` doubles as the workload cluster. One bootstrap
host, no DR, no cross-cluster management. A customer may run several such
clusters that are deliberately independent of each other.

#### Node pools, labels and taints

Two pool layouts, by cluster size:

| Layout | Pools | When |
| --- | --- | --- |
| Consolidated | `control-plane` + one `infra` pool carrying ingress, monitoring and logging | Up to roughly 20 workers |
| Dedicated | `control-plane` + `ingress` + `monitor` + `log` | Larger clusters (recalculate sizing against the product capacity pages) |

Rules that make the layout work:

- Labels and taints are **declared on the pool resources**, never applied by
  hand on nodes. See
  [Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)
  for how pool-declared labels reach the nodes.
- **Each dedicated pool gets its own taint key**
  (`node-role.kubernetes.io/<pool>=reserved:NoSchedule`). A shared key plus the
  common `tolerations: [{operator: Exists}]` pattern would silently open every
  dedicated pool to every plugin; distinct keys make a misplaced plugin `Pending`
  immediately, which is the failure you want.
- Every dedicated pool also carries `node-role.kubernetes.io/worker` — the
  default worker MachineConfigPool selects on it, and without it the nodes
  silently miss machine configuration (time zone, chrony).
- Use `NoSchedule`, not `NoExecute`: a mislabeled pool during delivery should
  block scheduling, not evict running Pods.

#### Disks

**One persistent `/var/cpaas` disk per node**; monitoring and logging write to
sub-directories under it (on Alauda OS nodes the plugin defaults move from
`/cpaas/...` to `/var/cpaas/...` — the install pages note this). Capacity is the
sum of its uses, for example a consolidated `infra` pool node carries platform
state + log storage + monitoring data on one disk.

The trade-off is isolation: with one disk, logs filling up can take the platform
state directory with them. Compensate with log retention limits and capacity
alerts — not only with a bigger disk. Several storage paths **cannot be changed
after installation**; verify them against the design before installing plugins.

#### Observability

Every cluster observes itself. In the multi-cluster topology, each side of the
`global` pair runs its own monitoring and logging; workload clusters do not
forward to `global`. On the 4.3 line the ClickHouse log path is direct-write —
**no Kafka**; Kafka becomes a prerequisite only with the 4.4 log stack.

Size monitoring and logging from the product capacity pages —
[monitoring](https://docs.alauda.io/container_platform/4.4/observability/monitor/architecture/capacity_planning.html)
and
[logging (ClickHouse)](https://docs.alauda.io/logging-service/4.3/architecture/capacity_planning.html#clickhouse)
— rather than from fixed numbers in this guide; the capacity pages are the
authority and this guide only shows worked examples.

### 2. Delivery flow

The flow below is the multi-cluster topology with DR. For a single-cluster
delivery: one bootstrap host, skip the standby and etcd-sync stages, and skip
workload-cluster creation.

| Stage | Action | Pass criteria |
| ---: | --- | --- |
| 1 | Freeze the machine inventory | Counts and specs signed off |
| 2 | Freeze networks, VIPs, DNS, certificates, port policy | CIDRs do not overlap; LB backends and port matrix confirmed and tested |
| 3 | Collect DCS facts (site, templates, API user, folders, storage, port groups) | Recorded in the value sheet |
| 4 | Download materials with `violet` | Core package and plugin packages verified — see [Download Packages](https://docs.alauda.io/container_platform/4.3/extend/download_package.html) |
| 5 | Provision **two** bootstrap hosts (primary + standby) | Reachable; CPU meets `x86-64-v2` |
| 6 | Point the platform domain at the primary VIP, install the primary `global` | Six-node verification passes |
| 7 | Switch the platform domain to the standby VIP, install the standby `global` | Six-node verification passes |
| 8 | Switch the platform domain back to the primary VIP, install `etcd-sync` | Zero-difference check passes; failover drill passes |
| 9 | Create workload clusters from `global` | Pools match the plan |
| 10 | Install platform plugins | Each plugin verified on its intended pool |
| 11 | Machine configuration, acceptance, archive | Checklist passes |

Stages 6→7→8 must run in that order, and what switches is the **platform
domain** — each cluster is always reached by its own VIP. The product
installation guide carries the full procedure, including why the domain must
point at the side being installed and the complete DR configuration:
[Global Cluster Installation](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
and
[Global Cluster Disaster Recovery](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html).

Never reuse one bootstrap host for both sides, and never render the DCS
credential Secret into a manifest that is applied with `kubectl apply` — create
it separately with `kubectl create` and reference it by name.

### 3. Rendering the cluster resources

The delivery charts that accompany this article render the Cluster API
resources for both sides, packaged as **`acp-delivery-charts`** (available from
Alauda Cloud): `charts/global-dcs` for the `global` cluster and
`charts/workload-dcs` for each workload cluster. Each side is rendered
separately with its own values file:

```bash
helm template global charts/global-dcs   -f global-values.yaml   > global.yaml
helm template wl-1   charts/workload-dcs -f wl-1-values.yaml     > wl-1.yaml
```

Properties worth relying on:

- **Credentials never pass through the charts.** The DCS API credential Secret
  is created once with `kubectl create`; both charts reference it by name, and
  workload clusters reuse the Secret created for the `global` install.
- **Fail-fast validation.** Unknown pool names, a control plane that is not 3
  nodes, a workload cluster named `global` or prefixed `global-`, empty required
  values, non-CIDR networks, or a domain name in the endpoint are rejected at
  render time instead of surfacing as half-provisioned machines.
- **The DR block renders the disaster-recovery increments** (the shared
  encryption provider reference and the etcd server certificate SANs); with DR
  disabled the output is byte-identical to a non-DR render.
- Workload clusters are managed on `global`: Kubernetes version, image tags, VM
  template and credentials are read from what the `global` install already
  created; a new cluster only needs its own name, endpoint VIP, CIDRs, node IPs
  and keys.

Review the rendered output, then apply the control plane first and each node
pool separately after checking it — not the whole directory at once.

### 4. Plugin installation and placement

Install plugins only after the target pool's nodes are `Ready` and labeled.
Placement by layout:

| Cluster · layout | Ingress | Monitoring | Logging |
| --- | --- | --- | --- |
| `global` (multi-cluster) | — | `infra` | `infra` |
| `global` (single cluster) | `infra` | `infra` | `infra` |
| Workload · consolidated | `infra` | `infra` | `infra` |
| Workload · dedicated pools | `ingress` | `monitor` | `log` |

Notes that save a site visit:

- **Ingress NGINX and MetalLB tolerate no taints by default** — to land them on
  a tainted dedicated pool, set their `nodeSelector` and `tolerations` install
  parameters explicitly (see the
  [MetalLB](https://docs.alauda.io/container_platform/4.3/networking/operators/metallb_operator.html)
  and
  [Ingress NGINX](https://docs.alauda.io/container_platform/4.3/networking/operators/ingress_nginx_operator.html)
  pages). The MetalLB parameters apply to both its controller and its speaker —
  without the toleration the speaker cannot reach the pool and the VIP is never
  announced.
- Do not patch plugin-generated Deployments to fix placement; use the plugins'
  own parameters.
- DaemonSets that must cover every node (log collector, node exporter, CNI, CSI)
  ship with blanket tolerations. Verify their coverage against the node count
  after the pools are up — a DaemonSet that misses a dedicated pool fails
  silently: no error, just no Pods there.
- ClickHouse and (from 4.4) Kafka are placed with the logging stack — they are
  its storage engine and hard dependency.

### 5. Machine configuration

Install the Machine Configuration plugin on **every** cluster before applying
any machine configuration — the `MachineConfig` APIs do not exist until it is
installed. Then configure, in this order: the node disruption policy first,
the `MachineConfig` second — a systemd unit change without a policy falls back
to the default action, which reboots the pool. The product documentation
covers the standard items: time zone
([Setting the Node Time Zone](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/timezone.html)),
NTP with the customer's internal source, and the `boot` user SSH key
([Managing Node Configuration](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/managing.html)).

### 6. Sizing

Derive sizes from the product capacity pages instead of copying numbers:

1. Control planes come from the
   [global](https://docs.alauda.io/container_platform/4.4/configure/scalability/evaluating_global.html)
   and
   [workload](https://docs.alauda.io/container_platform/4.4/configure/scalability/evaluating_workload.html)
   evaluation pages for your managed-cluster count and workload scale.
2. Monitoring tier from the monitoring capacity page, against the cluster's
   node and Pod counts.
3. Log storage from the logging capacity page, against log volume and retention.
4. `/var/cpaas` per pool = platform state + the data the pool hosts
   (for a consolidated `infra` pool: platform state + log storage + monitoring
   data, summed).

A worked example for a small workload cluster (~20 workers) is what the default
`values.yaml` of the delivery charts encodes; anything beyond the documented
capacity tiers must be recalculated and validated, not extrapolated.

### 7. Acceptance

Accept against evidence, not against "the installer finished":

- Every pool's node count, labels and taints match the plan; `providerID` and IP
  pools consumed correctly.
- API VIPs answer on their ports; the platform domain resolves to the primary
  `global` VIP; certificates carry the right SANs.
- Each plugin's Pods run on the intended pool; DaemonSet coverage equals the
  node count.
- Machine configuration pools report `UPDATED=True`, `DEGRADED=False`; time zone
  and NTP verified on nodes.
- With DR: both sides pass their six-node verification, the synchronization
  monitor reports zero differences, and a failover drill has actually been run —
  see the
  [failover procedure](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html).
- Nothing in the archive contains plaintext credentials; rendered manifests are
  archived in redacted form only.

If the delivery deviates from this design, stop and resolve the deviation with
the platform team before continuing — a deviation that is cheap to fix at the
design stage becomes a re-installation later.

## Related Information

- [Global Cluster Installation (Immutable Infrastructure)](https://docs.alauda.io/immutable-infra/1.0/global/install.html)
- [Global Cluster Disaster Recovery](https://docs.alauda.io/immutable-infra/1.0/global/disaster_recovery.html)
- [Creating Clusters on Huawei DCS](https://docs.alauda.io/immutable-infra/1.0/create-cluster/huawei-dcs.html)
- [Configure Annotations, Labels, and Taints on Nodes](https://docs.alauda.io/immutable-infra/1.0/how-to/node-configuration.html)
- [Machine Configuration](https://docs.alauda.io/immutable-infra/1.0/machine-configuration/overview.html)
- [Full-Stack Automation with ACP](../Full-Stack_Automation_with_ACP.markdown) — declarative cluster creation on DCS as a development/automation walkthrough; this article is the production delivery counterpart
