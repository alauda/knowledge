---
products:
  - Alauda Application Services
kind:
  - How To
ProductsVersion:
  - 4.3
---

# Deploy Kafka on Node-Local Disks with Pre-Bound PersistentVolumes

:::info Applicable Versions
Alauda Streaming Service for Kafka 4.3 — KRaft mode.

For the legacy Kafka 2.x / ZooKeeper line the resource shape differs; see
[Limitations and Open Items](#limitations-and-open-items).
:::

## Purpose

Kafka is sometimes deployed onto node-local disks — bare disks, LVM volumes, or plain
directories on the host — instead of a network storage class, for throughput or because the
cluster has no CSI storage at all.

Node-local storage removes the property every other Kubernetes workload relies on: the volume
can no longer follow the pod. Left unmanaged that produces two failures, both seen in the field:

1. A broker pod is rescheduled and comes up with an empty or foreign log directory.
2. After an instance is deleted and recreated, brokers bind to each other's disks.

This document gives a deployment procedure that makes the broker-to-disk mapping deterministic,
then explains why each part is necessary in [Why This Design](#why-this-design).

**The short version:** use `local` volumes, and reserve every PersistentVolume for a specific
PersistentVolumeClaim with `spec.claimRef` before the claim exists.

## Prerequisites

- Alauda Streaming Service for Kafka installed and running.
- Three worker nodes for a highly available instance, each with a dedicated disk or directory.
- Cluster-admin rights. `PersistentVolume` and `StorageClass` are cluster-scoped and must be
  created by an administrator, not the namespace owner.
- The ability to label the StorageClass for the target project — see Step 2. Without it, every
  PersistentVolumeClaim is rejected by an admission webhook.
- Node labels or a taint scheme to keep other workloads off the Kafka nodes. See
  [Schedule Kafka on Dedicated Middleware Nodes with Affinity, Taints, and Tolerations](./Kafka_Node_Placement_Affinity_Taints_Guide.md).

## Procedure

A highly available instance has **three brokers and three controllers**, each with its own
volume — **six PersistentVolumes in total**, two per node.

Because the generated volume claim names contain a per-instance value that cannot be known in
advance (see [How the names are derived](#how-the-names-are-derived)), the procedure has two
phases: create the instance, read the claim names it generates, then create volumes reserved for
exactly those names. The claims wait, `Pending`, until their volumes appear.

The example uses instance `rklocal` in namespace `demo-space`, on nodes `192.168.131.66`,
`192.168.136.224` and `192.168.138.211`.

### Step 1 — Prepare the disks

On each node, mount the dedicated disk and create one directory for the broker and one for the
controller. Do not put Kafka data on the root filesystem in production: a runaway log directory
takes the node down with it.

```bash
# On each Kafka node
mkdir -p /cpaas/rk-broker /cpaas/rk-controller
```

Ownership does not need adjusting. Kafka runs as UID 1001, and for `local` volumes kubelet
applies the pod's `fsGroup` to the mount, turning a `root:root 0755` directory into
`drwxrwsr-x` automatically.

:::warning Capacity is advisory
`capacity.storage` on a `local` volume is matching metadata, not a quota. Nothing stops Kafka
from filling the underlying disk past it. Set it to the real usable size and enforce retention
with `log.retention.bytes` / `log.retention.hours`.
:::

### Step 2 — Create the StorageClass and grant it to the project

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: kafka-local
  labels:
    # REQUIRED. Without a project grant, every PVC using this class is rejected.
    project.cpaas.io/ALL_ALL: "true"
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: false
```

:::danger The project label is not optional
A StorageClass is only usable inside a project that has been granted it. Without the grant, the
`pvc-validator.cpaas.io` admission webhook denies every claim, and the failure is indirect — no
pods appear and the instance sits idle. The rejection is visible only in the Kafka resource's
conditions:

```
admission webhook "pvc-validator.cpaas.io" denied the request:
StorageClass "kafka-local" is not allowed in project "demo"
```

`project.cpaas.io/ALL_ALL: "true"` grants it to every project, matching how the platform's own
storage classes are labelled. To restrict it instead, grant only the projects that need it.
:::

`no-provisioner` means nothing is created dynamically — the class exists only to group the
volumes you create by hand. `allowVolumeExpansion: false` is honest: local volumes cannot be
resized by the operator.

### Step 3 — Create the Kafka instance

Set both storage classes to `kafka-local`: `spec.storage` is the **broker** storage,
`spec.controller.storage` is the **controller** storage. They are separate node pools with
separate volumes.

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafka
metadata:
  name: rklocal
  namespace: demo-space
spec:
  mode: KRaft
  version: "4.2"
  replicas: 3
  storage:
    class: kafka-local
    size: 5Gi
    deleteClaim: false
  resources:
    limits:
      cpu: "1"
      memory: 2Gi
    requests:
      cpu: 200m
      memory: 512Mi
  controller:
    replicas: 3
    roles:
      - controller
    storage:
      class: kafka-local
      size: 5Gi
      deleteClaim: false
    resources:
      limits:
        cpu: 500m
        memory: 500Mi
      requests:
        cpu: 500m
        memory: 500Mi
  config:
    # Replication is the only fault tolerance here — the pods cannot move.
    default.replication.factor: "3"
    min.insync.replicas: "2"
    offsets.topic.replication.factor: "3"
    transaction.state.log.replication.factor: "3"
    transaction.state.log.min.isr: "2"
```

`deleteClaim: false` keeps the claims when the instance is removed, so a reinstall reuses the
existing bindings instead of creating new ones.

### Step 4 — Read the generated claim names

The instance creates its claims immediately; they stay `Pending` because no volume matches yet.

```bash
kubectl -n demo-space get pvc \
  -o custom-columns='PVC:.metadata.name,STATUS:.status.phase,CLASS:.spec.storageClassName'
```

```
data-rklocal-broker-a28da4-0       Pending   kafka-local
data-rklocal-broker-a28da4-1       Pending   kafka-local
data-rklocal-broker-a28da4-2       Pending   kafka-local
data-rklocal-controller-a28da4-3   Pending   kafka-local
data-rklocal-controller-a28da4-4   Pending   kafka-local
data-rklocal-controller-a28da4-5   Pending   kafka-local
```

Note the shape: brokers take node IDs 0–2, controllers 3–5, and `a28da4` is generated per
instance. **Copy these names exactly** — they are the input to the next step.

### Step 5 — Create the pre-bound PersistentVolumes

One volume per claim, each pinned to its node and reserved for exactly one claim. Generate them
rather than typing them; this is where mistakes happen.

```bash
#!/usr/bin/env bash
set -euo pipefail

NAMESPACE=demo-space
INSTANCE=rklocal
HASH=a28da4          # from Step 4
SC=kafka-local
SIZE=5Gi
NODES=(192.168.131.66 192.168.136.224 192.168.138.211)

emit() {   # $1=pv name  $2=host path  $3=claim name  $4=node
  cat <<YAML
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: $1
spec:
  capacity:
    storage: ${SIZE}
  volumeMode: Filesystem
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ${SC}
  claimRef:                 # the reservation — no uid, the control plane fills it in
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: ${NAMESPACE}
    name: $3
  local:
    path: $2
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: ["$4"]
YAML
}

for i in 0 1 2; do
  emit "rk-broker-$i" /cpaas/rk-broker \
       "data-${INSTANCE}-broker-${HASH}-${i}" "${NODES[$i]}"
done
for i in 0 1 2; do
  emit "rk-controller-$((i+3))" /cpaas/rk-controller \
       "data-${INSTANCE}-controller-${HASH}-$((i+3))" "${NODES[$i]}"
done
```

:::warning Array indexing differs between shells
`bash` indexes arrays from 0, `zsh` from 1. Run the script with `bash`, and check the generated
output before applying — an off-by-one here silently pins the wrong broker to the wrong node.
:::

Review the output, then apply it. Keep the script in version control alongside the instance
manifest — it is the authoritative record of which broker owns which disk.

### Step 6 — Verify

The claims bind as soon as the volumes appear, and the pods start.

```bash
kubectl -n demo-space get pvc \
  -o custom-columns='PVC:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName'
kubectl -n demo-space get pod -l strimzi.io/cluster=rklocal \
  -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName'
```

Each claim must be `Bound` to the volume you reserved for it, and each pod must be on that
volume's node:

```
data-rklocal-broker-a28da4-0       Bound   rk-broker-0
data-rklocal-broker-a28da4-1       Bound   rk-broker-1
data-rklocal-broker-a28da4-2       Bound   rk-broker-2
data-rklocal-controller-a28da4-3   Bound   rk-controller-3
data-rklocal-controller-a28da4-4   Bound   rk-controller-4
data-rklocal-controller-a28da4-5   Bound   rk-controller-5

rklocal-broker-a28da4-0       192.168.131.66
rklocal-broker-a28da4-1       192.168.136.224
rklocal-broker-a28da4-2       192.168.138.211
rklocal-controller-a28da4-3   192.168.131.66
rklocal-controller-a28da4-4   192.168.136.224
rklocal-controller-a28da4-5   192.168.138.211
```

**Then check that each disk holds exactly one log directory.** This is the check that detects a
wrong binding, and the only one that does — see
[Why the node.id check does not work](#why-the-nodeid-check-does-not-work).

```bash
# On each Kafka node
ls -1 /cpaas/rk-broker/ /cpaas/rk-controller/
du -sh /cpaas/rk-broker/kafka-log*/ /cpaas/rk-controller/kafka-log*/
```

One directory per disk, named for the node ID that owns it, is healthy. **Two directories on one
disk** means a broker formatted a fresh log next to someone else's data — go to
[Recovering a wrong binding](#recovering-a-wrong-binding).

## Cleaning Up

`Retain` is deliberate: it is what stops a deleted claim from destroying data. The cost is that
**nothing is reclaimed automatically**, and cleanup is a manual, two-part job.

Deleting the instance leaves behind:

| What | Where | Reclaimed automatically? |
| --- | --- | --- |
| PersistentVolumeClaims | namespace | No — `deleteClaim: false` keeps them |
| PersistentVolumes | cluster-scoped | No — `Retain` keeps them, in `Released` |
| Kafka data | the directories on each node | **No — never touched by Kubernetes** |

To decommission an instance completely, after confirming the data is no longer needed:

```bash
# 1. Remove the instance
kubectl -n demo-space delete rdskafka rklocal

# 2. Remove the claims it left behind
kubectl -n demo-space delete pvc -l strimzi.io/cluster=rklocal

# 3. Remove the volumes
kubectl delete pv rk-broker-0 rk-broker-1 rk-broker-2 \
                  rk-controller-3 rk-controller-4 rk-controller-5

# 4. Remove the data on each node — this is the step people forget
#    Run on every Kafka node:
rm -rf /cpaas/rk-broker /cpaas/rk-controller
```

Step 4 is the one that matters. The disks are not freed by deleting Kubernetes objects, and a
later instance pointed at the same paths will find another cluster's log directories waiting for
it. If you intend to **reuse** the same disks for a new instance, clearing them first is not
optional.

To keep the data and only rebuild the instance, stop after step 1 and follow
[Deleting and recreating an instance](#deleting-and-recreating-an-instance) instead.

## Single-Replica (Non-HA) Deployments

A one-broker instance is reasonable for a development environment, or a log queue where the
producer can buffer and brief downtime is acceptable. It is not a smaller version of the
three-node design — the trade-off is categorical.

:::danger A single-replica instance has no fault tolerance of any kind
Replication factor 1 means every partition has exactly one copy, on one disk, on one node. If
that node reboots, is drained, or loses its disk, the instance is **down** and its data
**unreachable** for the duration. If the disk is lost, the data is gone. Kafka's replication is
the only fault tolerance in a local-disk deployment, and at RF=1 there is none.

Decide this deliberately. Do not run a single replica because three nodes looked like more work.
:::

Set `replicas: 1` and `controller.replicas: 1`, and every replication factor to 1 — a topic that
asks for more replicas than there are brokers cannot be created:

```yaml
spec:
  mode: KRaft
  version: "4.2"
  replicas: 1
  storage:
    class: kafka-local
    size: 5Gi
    deleteClaim: false
  controller:
    replicas: 1
    roles:
      - controller
    storage:
      class: kafka-local
      size: 5Gi
      deleteClaim: false
  config:
    default.replication.factor: "1"
    min.insync.replicas: "1"
    offsets.topic.replication.factor: "1"
    transaction.state.log.replication.factor: "1"
    transaction.state.log.min.isr: "1"
```

Everything else is unchanged — the two-phase procedure, `claimRef` reservation, `Retain`.

### The cross-binding risk moves between instances

A single-replica instance has one broker claim and one volume, so it cannot swap disks with
itself. The risk does not disappear — **it moves to the boundary between instances**. Several
single-replica instances sharing one `no-provisioner` StorageClass all draw from the same pool
of unreserved volumes, and a claim carries no notion of which instance a volume belongs to.

This is the common multi-tenant shape: a small instance per team or per namespace, each on its
own node's disk, all on `kafka-local`.

Tested with two single-replica clusters holding different data. With no `claimRef` on either
volume, and one cluster's pod scheduled onto the other's node — the situation you get when the
usual node is cordoned, full, or under maintenance — the first cluster's claim bound the
**second** cluster's volume. Nothing prevents one tenant's claim from taking another's disk.

### Here the failure is loud, not silent

This is the one place single-replica behaves *better* than the multi-broker case.

Every single-replica broker is node ID 0, so its log directory is always `kafka-log0`. A broker
landing on another instance's disk therefore *does* find a `kafka-log0` — the other instance's —
reads its `meta.properties`, sees a foreign cluster ID, and refuses to start:

```
Invalid cluster.id in /var/lib/kafka/data/kafka-log0/meta.properties.
Expected SrBFclR9RLSygr8RwS0G1g, but read TfB1UUCaQb-a6Y-IuwQtOw
```

It crash-loops instead of formatting, and the victim's data is untouched — confirmed afterwards:
still one `kafka-log0`, still its original size.

Contrast the multi-broker case, where brokers have *different* node IDs, so a displaced broker
never finds its own directory, silently formats a new one, and joins empty. **Multi-broker
cross-binding loses data quietly; single-replica cross-instance theft causes an outage but
preserves data.**

An outage is still an outage. Reserve every volume with `claimRef` — in a multi-tenant estate it
matters more than anywhere else, because the volumes are interchangeable by construction and the
tenants cannot see each other.

## Day-2 Operations

### Deleting and recreating an instance

With `deleteClaim: false`, deleting the instance leaves the claims behind, and recreating it
reuses them with no rebinding. **Do not delete the claims during cleanup** unless you also intend
to discard the data — that is the step that produces cross-binding.

:::danger Deleting the instance destroys the KRaft cluster ID
Preserving the claims is **not sufficient**. The KRaft cluster ID lives in the Kafka resource's
`status.clusterId`, with each pool's `status.clusterId` as a fallback — deleting those resources
deletes it. A brand-new random ID is generated, and every broker then refuses to start against
its retained disk:

```
Invalid cluster.id in /var/lib/kafka/data/kafka-log0/meta.properties.
Expected 5jdttJxLSUOG-QJ7r__PYA, but read zUekwp_oQdSh47pToRAmcQ
```

The data is intact; the cluster simply cannot be reassembled without the original ID.
:::

**Before deleting, record the cluster ID:**

```bash
kubectl -n demo-space get kafka rklocal -o jsonpath='{.status.clusterId}'
```

**To restore it afterwards**, patch the status *and* trigger a reconciliation. The patch alone is
not enough: the operator overwrites `status` at the end of each reconcile loop and only reads the
cluster ID at the *start* of one. This is a race, so verify and repeat until it takes:

```bash
CID=<the recorded cluster ID>
until [ "$(kubectl -n demo-space get cm rklocal-broker-a28da4-0 -o jsonpath='{.data.cluster\.id}')" = "$CID" ]; do
  kubectl -n demo-space patch kafka rklocal --subresource=status --type=merge \
    -p "{\"status\":{\"clusterId\":\"$CID\"}}"
  kubectl -n demo-space annotate kafka rklocal recovery-trigger="$(date +%s%N)" --overwrite
  sleep 10
done
kubectl -n demo-space delete pod -l strimzi.io/cluster=rklocal
```

If you no longer have the ID, read it from any retained `kafka-log*/meta.properties` on the
nodes — it also appears in the broker's own `Invalid cluster.id … but read <ID>` error.

### Replacing a failed node

The broker's identity is its node ID and its data is on the failed node's disk.

- **Disk survived**: move it to the replacement node, mount it at the same path, and edit the
  volume's `nodeAffinity` to the new hostname. The broker restarts with its data and rejoins
  without replication traffic.
- **Disk lost**: delete the claim and the volume, recreate both with the same names and the same
  `claimRef`, and let the broker re-replicate from its peers. Safe **only** while the other
  brokers hold in-sync replicas of every partition — check `--under-replicated-partitions` first,
  and do one broker at a time.

### Growing a disk

Local volumes cannot be expanded by the operator. Grow the filesystem on the host, then update
`capacity.storage` on the volume.

Increasing `spec.storage.size` is an accepted change, so a resize is attempted; with
`allowVolumeExpansion: false` it stops immediately and records a `PvcResizingWarning`. Harmless,
but it leaves a standing warning. Do not *decrease* the size — shrinking is rejected and causes
the whole storage block to be ignored.

Either way the claim's `status.capacity` keeps reporting the original size. There is no CSI
driver behind a `no-provisioner` class, so nothing updates it. Use `df` on the node.

## Troubleshooting

### Nothing happens after creating the instance

No pods, no claims, no error on the instance itself. Check the Kafka resource's conditions for an
admission rejection:

```bash
kubectl -n demo-space get kafka rklocal -o jsonpath='{.status.conditions[0].message}'
```

`StorageClass "…" is not allowed in project "…"` means the StorageClass has not been granted to
the project — see Step 2.

### A claim stays `Pending`

Compare it against the volume it should bind to. Four fields must agree: `storageClassName`,
`accessModes`, `volumeMode`, and capacity (volume ≥ claim request). Also confirm the reserved
name matches exactly — a typo in `claimRef.name` leaves both sides waiting forever, with no other
symptom.

```bash
kubectl -n demo-space describe pvc data-rklocal-broker-a28da4-0
kubectl describe pv rk-broker-0
```

### A pod stays `Pending` with a volume node affinity conflict

The scheduler cannot find a node satisfying both the pod's constraints and the volume's
`nodeAffinity`. Usually the hostname in the volume does not match the node's actual
`kubernetes.io/hostname`.

```bash
kubectl get node --show-labels | grep hostname
```

### Recovering a Released volume

A volume goes `Released` when its claim is deleted. With `Retain` the data is intact, but it will
not bind again, because its `claimRef` now carries the deleted claim's UID.

Remove **only the UID and resourceVersion**, keeping namespace and name. That returns it to
`Available` while preserving the reservation:

```bash
kubectl patch pv rk-broker-0 --type=json -p='[
  {"op": "remove", "path": "/spec/claimRef/uid"},
  {"op": "remove", "path": "/spec/claimRef/resourceVersion"}
]'
```

Do **not** clear the whole `claimRef`. That makes the volume a free agent again and reintroduces
exactly the race this design exists to prevent.

### Recovering a wrong binding

Symptom: a disk holds more than one `kafka-log*` directory, a topic has lost messages, or a
broker crash-loops with `Invalid cluster.id`. The instance may report healthy with brokers
`1/1 Running` — see [What the broker does on the wrong disk](#what-the-broker-does-on-the-wrong-disk).

1. **Stop.** Do not delete any log directory, and do not delete a claim to "reset" a broker.
   Every byte is still on the disks; deleting is the only way to actually lose it.
2. **Identify the true owner of each disk by directory size, not `meta.properties`.** The
   freshly formatted directory also carries a valid-looking `node.id`, so that file cannot tell
   you who owns the disk. The directory holding the real data can:

   ```bash
   # On each Kafka node
   du -sh /cpaas/rk-broker/kafka-log*/
   grep -H "" /cpaas/rk-broker/kafka-log*/meta.properties
   ```

   The large directory is the real data and its `<N>` is the disk's true owner; the small one
   (tens of KB) is the empty log a mis-bound broker created. The orphaned directory also carries
   the *original* cluster ID.
3. Record that original cluster ID — you need it in step 6.
4. Delete the instance, then the claims. The data is on `Retain`ed volumes and is not touched.
5. Set each volume's `claimRef` to the claim of the broker that truly owns that disk, then clear
   the stale UID as above. Verify all report `Available` with the intended claim.
6. Recreate the instance and restore the cluster ID, per
   [Deleting and recreating an instance](#deleting-and-recreating-an-instance).
7. Re-verify: exactly one `kafka-log*` directory per disk.

Once each broker is back on its own disk, the empty directories left behind are inert — a broker
only ever reads its own `kafka-log<N>`. Remove them at step 5, once you have written down which
is which, to restore the "one directory per disk" invariant.

This procedure was exercised on a live cluster: a topic that had dropped from 1000 messages to 0
was restored to all 1000 messages.

## Why This Design

Everything above rests on four choices. This section explains each.

### Use `local` volumes, not `hostPath`

Both point at a path on the host, but they differ where it matters:

| | `hostPath` | `local` |
| --- | --- | --- |
| `spec.nodeAffinity` | Optional — accepted without it | **Required** — the API server rejects a volume without it |
| Scheduler awareness | Does not constrain the pod to the node holding the data | Filters candidate nodes by the volume's `nodeAffinity` |
| If the pod moves | kubelet resolves the same path on whatever node it landed on, creating it when `type` is `DirectoryOrCreate` or unset | The pod cannot be scheduled anywhere but the node that owns the volume |
| `fsGroup` ownership | **Not applied** — kubelet does not chown host paths | Applied — kubelet adjusts group ownership to the pod's `fsGroup` |

A `hostPath` volume without `nodeAffinity` is the direct cause of failure mode 1: the pod is
rescheduled, kubelet resolves the same path on the *new* node, and Kafka starts against a
directory that is empty or belongs to someone else.

Both differences were confirmed on ACP v4.3. The API server refuses a `local` volume that omits
`nodeAffinity`, so the misconfiguration is not even expressible:

```
The PersistentVolume "…" is invalid: spec.nodeAffinity:
  Required value: Local volume requires node affinity
```

The `fsGroup` row bites first. Kafka runs as UID 1001 and a `hostPath` directory is
`root:root 0755`; because kubelet does not apply `fsGroup` to host paths, the broker cannot write
and crash-loops:

```
Error while writing meta.properties file /var/lib/kafka/data/kafka-log0:
  java.nio.file.AccessDeniedException: /var/lib/kafka/data/kafka-log0
```

With `local` volumes this does not happen. From the same `root:root 0755` directory, kubelet
adjusted it to `drwxrwsr-x` on mount and the instance came up first time at default privileges.

If you must keep `hostPath`, set `nodeAffinity` explicitly — it is honored when present — and
either make the directory group-writable or run the pods as root, following
[Run Kafka Pods as the Root User](./How_to_Run_Kafka_as_Root_User.md).

### How the names are derived

Volume claim names are built from the instance name, the generated pool name, and the node ID:

| Object | Name |
| --- | --- |
| Broker pod | `<instance>-broker-<hash>-<nodeId>` |
| Controller pod | `<instance>-controller-<hash>-<nodeId>` |
| Claim | `data-<podName>` |

Brokers take node IDs 0–2 and controllers 3–5. The `<hash>` is generated **per instance** — two
instances observed on the same cluster carried `cb42e1` and `a28da4` — so it cannot be predicted
before the instance exists. That is the whole reason the procedure is two-phase.

Every claim is fixed at `accessModes: [ReadWriteOnce]` and `volumeMode: Filesystem`, taking its
class and size from the storage block.

### Why the fix has to be on the volume side

Two options look like they would solve per-broker placement, and neither is available:

- **`storage.selector` does not exist.** The instance's storage block accepts only `class`,
  `size` and `deleteClaim`. Even on the underlying resources, a selector applies the *same* label
  selector to every claim in a pool, so it can narrow the candidate set but cannot say "broker 0
  gets this one."
- **Per-broker storage class overrides are ignored.** The field is deprecated and not read.

That leaves the volume side, where `spec.claimRef` reserves a volume for one specific claim.

### How pre-binding works

`claimRef` is the reservation mechanism. Set to a `{namespace, name}` that does not exist yet,
the volume stays `Available` and the control plane will only ever bind it to that claim. When the
claim appears, the pre-bound volume is matched before the ordinary "find any matching volume"
search runs, so it takes precedence — and it works with `WaitForFirstConsumer`, which is what
makes the two-phase procedure possible.

Omit `uid`. A `claimRef` with only namespace and name is a reservation; the control plane fills
in the UID on bind. A `claimRef` carrying a *stale* UID — what is left after a claim is deleted —
matches nothing and leaves the volume stuck in `Released`.

### Root cause of the cross-binding failure

The report is that restarting all broker pods at once shuffles the bindings. The mechanism is
close, but the trigger is different, and the difference determines the fix.

**A bound claim never changes its volume.** `spec.volumeName` is immutable once set, and claims
are not deleted when pods restart, are rescheduled, or are rolled. This was verified directly:
all broker pods deleted simultaneously, every pod returned to its original node with its claim
bound to the same volume, and the test topic still held all 1000 messages with full ISR.

**Binding is decided once, when the claim is created, and it is first-come-first-serve.**
Kubernetes matches on storage class, capacity, access mode and volume mode. There is no identity
concept: any volume that satisfies the request is a candidate, and identical volumes satisfy all
claims equally. Initial binding was never name-ordered in testing — one run bound brokers 0/1/2
to volumes c/b/a, another to c/a/b.

So cross-binding happens whenever **claims are created**, not when pods restart:

- The instance is deleted and recreated with the claims removed.
- The namespace is deleted and recreated.
- A claim is deleted by hand to "reset" a broker.
- Pod names change: the instance is renamed, or node IDs are reassigned after a scale cycle.

In all of those, fresh claims race retained volumes that still hold data, and the mapping that
comes out has no relationship to the one that went in.

### What the broker does on the wrong disk

This is what makes the failure dangerous, and it is not what most people expect.

Kafka's log directory is named after the broker's **own** node ID: `<mountPath>/kafka-log<nodeId>`.
A broker that lands on a foreign disk does not read the other broker's `meta.properties` at all —
it looks for its own `kafka-log<N>`, does not find one, and concludes the disk is fresh.

**The common outcome is silent.** It formats a new, empty `kafka-log<N>` *beside* the orphaned
directory holding the real data, starts up reporting `1/1 Running`, and joins as an empty
replica. Nothing logs an error.

**The loud outcome is the exception.** A broker only crashes if it keeps a disk that already
contains *its own* `kafka-log<N>` and the cluster ID has since changed.

Measured with three brokers, after a claim recreation that swapped brokers 1 and 2:

| Broker | Landed on | Result |
| --- | --- | --- |
| 0 | its own disk | `CrashLoopBackOff` — `Invalid cluster.id` |
| 1 | broker 2's disk | `Running 1/1` — empty `kafka-log1` formatted beside broker 2's 904K `kafka-log2` |
| 2 | broker 1's disk | `Running 1/1` — empty `kafka-log2` beside broker 1's 904K `kafka-log1` |

Two of three reported healthy. The topic went from 1000 messages to **0**, while every byte of
the original data was still on the disks in orphaned directories.

#### Why the node.id check does not work

Reading `meta.properties` from inside a broker pod does **not** find a wrong binding. Broker 1
reads `kafka-log1/meta.properties`, which says `node.id=1` — it matches, because the broker wrote
that file itself moments earlier. The reliable signal is **more than one `kafka-log*` directory
on a single disk**, which is why Step 6 checks for that.

## Limitations and Open Items

- **A pinned broker cannot fail over.** This is the design, not a defect. If a node is down, that
  broker is down until it returns. Availability comes from replication factor 3 with
  `min.insync.replicas: 2`; with those, one node down is a healthy cluster. Two nodes down is an
  outage, and no storage configuration changes that.
- **Cluster-scoped objects.** Volumes and StorageClasses cannot be created by a namespace-scoped
  tenant, and granting a StorageClass to a project is a platform-administrator action. Both must
  happen before the tenant creates the instance.
- **What was tested.** On ACP v4.3 with three worker nodes: the full procedure through the
  instance API, including the two-phase binding with claims created before their volumes, and
  simultaneous deletion of all pods. The failure and recovery scenarios — cross-binding,
  cluster-ID loss, wrong-binding recovery, and the single-replica cases — were exercised on the
  underlying Kafka resources with both `hostPath` and `local` volumes; the volume-side mechanics
  they cover are identical. Node failure and disk replacement were **not** tested.
- **Kafka 2.x / ZooKeeper line.** The legacy ZooKeeper-based line has no separate controller
  pool: storage lives under the broker and ZooKeeper sections, claim names are
  `data-<cluster>-kafka-<n>` and `data-<cluster>-zookeeper-<n>`, and ZooKeeper needs its own three
  volumes. The volume-side design — `claimRef` pre-binding plus `nodeAffinity` — is unchanged and
  is the part that matters.
