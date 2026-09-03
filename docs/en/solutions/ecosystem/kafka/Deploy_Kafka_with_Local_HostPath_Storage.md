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
ACP 4.3 / Alauda Kafka Operator (Strimzi 0.48 line), Kafka 4.2.0, KRaft mode with `KafkaNodePool`.
For the ZooKeeper-era 2.x operator line the CR shape differs; see the notes at the end.
:::

## Purpose

Kafka is sometimes deployed onto node-local disks — bare disks, LVM volumes, or plain
directories on the host — instead of a network storage class. This is done for throughput
(no network hop, no replication under Kafka's own replication) and for clusters that have no
CSI storage at all.

Node-local storage removes the property that every other Kubernetes workload relies on: the
volume can no longer follow the pod. Two failures come out of that, and both have been hit in
the field:

1. A broker pod is rescheduled and comes up with an empty or foreign log directory.
2. After the Kafka cluster is deleted and recreated, brokers bind to each other's disks —
   `broker-0` ends up on the disk that holds `broker-1`'s data.

This document explains why each happens, and gives a deployment procedure that makes the
broker-to-disk mapping deterministic and repeatable.

## Prerequisites

- Alauda Kafka Operator installed and running in the target namespace.
- At least three worker nodes reserved for Kafka, each with a dedicated disk or directory.
- Cluster-admin rights: `PersistentVolume` and `StorageClass` are cluster-scoped objects and
  must be created by an administrator, not by the namespace owner.
- Node labels or a taint scheme to keep other workloads off the Kafka nodes. See
  [Schedule Kafka on Dedicated Middleware Nodes with Affinity, Taints, and Tolerations](./Kafka_Node_Placement_Affinity_Taints_Guide.md).

## Use `local` Volumes, Not `hostPath`

Both PV types point at a path on the host, but they behave differently in the one place that
matters here:

| | `hostPath` | `local` |
| --- | --- | --- |
| `spec.nodeAffinity` | Optional — the API server accepts a PV without it | **Required** — the API server rejects a PV without it |
| Scheduler awareness | The scheduler does not constrain the pod to the node holding the data | The scheduler filters candidate nodes by the PV's `nodeAffinity` |
| Result if the pod moves | kubelet resolves the same path on whatever node the pod landed on — creating it if `hostPath.type` is `DirectoryOrCreate` or unset, failing to mount if it is `Directory` and the path is absent | The pod cannot be scheduled anywhere but the node that owns the volume |

A `hostPath` PV without `nodeAffinity` is the direct cause of failure mode 1. The pod is
rescheduled to another node, kubelet resolves the same path on the *new* node, and Kafka
starts against a directory that is empty (or that belongs to a different broker). Nothing in
Kubernetes prevents this, because a `hostPath` PV makes no claim about which node it lives on.

**Use `type: local` for every Kafka data volume.** The rest of this document does. Where you
must keep `hostPath` for an existing deployment, set `spec.nodeAffinity` on those PVs
explicitly — it is optional for `hostPath` but honored by the scheduler when present.

## How the Operator Maps Brokers to Volumes

The operator derives the PVC name from the pod name, and the pod name from the cluster and
pool names plus the node ID. The names are fully deterministic, which is what makes
pre-binding possible.

| Object | Name | Source |
| --- | --- | --- |
| Pod | `<cluster>-<pool>-<nodeId>` | `KafkaPool.componentName()` |
| PVC (single volume) | `data-<cluster>-<pool>-<nodeId>` | `VolumeUtils.createVolumePrefix()` |
| PVC (JBOD volume) | `data-<volumeId>-<cluster>-<pool>-<nodeId>` | same, with the JBOD volume id |

For a cluster `my-cluster`, a pool `kafka`, node IDs 0–2, and JBOD volume id 0, the PVCs are:

```
data-0-my-cluster-kafka-0
data-0-my-cluster-kafka-1
data-0-my-cluster-kafka-2
```

Every PVC the operator generates is fixed at `accessModes: [ReadWriteOnce]` and
`volumeMode: Filesystem`. It takes `storageClassName` from `spec.storage.class`, its size
request from `spec.storage.size`, and an optional `matchLabels` selector from
`spec.storage.selector`.

### What you cannot use

Two options that look like they would solve per-broker volume placement do not work on this
operator line:

- **`Kafka.spec.kafka.storage` is ignored.** Storage is configured in `KafkaNodePool.spec.storage`.
  The field still exists on the `Kafka` CRD for backward compatibility; setting it has no effect
  and produces a deprecation warning in `status.conditions`.
- **`storage.overrides` (per-broker `class`) is ignored since Strimzi 0.46.0.** The field is
  deprecated in the CRD and the operator does not read it. Any existing configuration that
  relies on per-broker storage class overrides stopped taking effect on upgrade — check
  `status.conditions` on clusters carried over from an earlier release.

`spec.storage.selector` does still work, but it applies the *same* label selector to every PVC
in the pool, so it can narrow the pool of eligible PVs — it cannot say "broker 0 gets this
one." Per-broker placement has to be solved on the PV side.

## Root Cause of the Cross-Binding Failure

The report is that restarting all broker pods at once shuffles the PV bindings. The mechanism
is close to that, but the trigger is different, and the difference determines the fix.

**A bound PVC never changes its PV.** `PersistentVolumeClaim.spec.volumeName` is immutable
once set, and the operator does not delete PVCs when pods restart, are rescheduled, or are
rolled. Restarting all three brokers simultaneously cannot re-shuffle anything.

**Binding is decided once, when the PVC is created, and it is first-come-first-serve.**
Kubernetes matches a PVC to a PV on storage class, requested capacity, access mode, and volume
mode. There is no pool or identity concept: any PV that satisfies the request is a candidate,
and the three identical Kafka PVs satisfy all three PVCs equally. Which PVC wins which PV is
whatever order the controller happens to process them in.

So the cross-binding is real, but it happens whenever **PVCs are created**, not when pods
restart:

- The Kafka cluster is deleted and recreated (the common case — `deleteClaim: true`, or the
  PVCs were removed manually during cleanup).
- The namespace is deleted and recreated.
- A PVC is deleted by hand to "reset" a broker.
- Pod names change, so the operator creates PVCs under new names: the node pool is renamed,
  the cluster is renamed, or node IDs are reassigned after a scale-down/scale-up cycle.

In all of those, three fresh PVCs race for three Retained PVs that still hold data, and the
mapping that comes out has no relationship to the one that went in.

### What the broker does when it lands on the wrong disk

Two outcomes, both worth recognizing:

- **Mismatched data directory.** Kafka reads `meta.properties` from the log directory, finds a
  `node.id` that does not match its configured ID, and refuses to start. The pod crash-loops
  with an inconsistent-node-ID error. This is loud, and it is the *safe* outcome — nothing is
  overwritten.
- **Empty data directory.** If the broker binds to a PV whose disk is empty, KRaft storage
  formatting initializes it and the broker joins the cluster as an empty replica. It then
  replicates partitions back from its peers. The cluster looks healthy while the original data
  sits orphaned on a PV nobody is using. If this happens on more than one broker at a time, or
  on a partition whose other replicas are already under-replicated, it is data loss.

In either case the recovery is to correct the bindings and restart, **never** to wipe a data
directory to "clear the error." See [Recovering a Wrong Binding](#recovering-a-wrong-binding).

## Design Rules

The deployment below rests on five rules. Applying them individually helps; applying all five
makes the mapping deterministic.

1. **Pre-bind each PV to a named PVC** via `spec.claimRef`. This removes the race entirely: a
   PV carrying a `claimRef` is only ever offered to that exact namespace/name.
2. **Pin each PV to its node** via `spec.nodeAffinity`. The scheduler then places the pod on
   the node that holds the data.
3. **`volumeBindingMode: WaitForFirstConsumer`** on the storage class, so binding and
   scheduling are decided together.
4. **`persistentVolumeReclaimPolicy: Retain`** so deleting a PVC never deletes the data.
5. **`deleteClaim: false`** on the node pool storage so removing the Kafka CR leaves the PVCs
   in place — the reinstall then reuses the existing bindings instead of creating new ones.

Rule 1 is the one that fixes the reported bug. Rules 4 and 5 are belt and braces: with both
set, the common uninstall/reinstall path never destroys a binding in the first place.

### How pre-binding works

`spec.claimRef` on a PV is Kubernetes' reservation mechanism. When you set it to a
`{namespace, name}` that does not exist yet, the PV enters `Available` and the control plane
will only bind it to that specific claim. When the claim appears, the binder matches it
immediately — the pre-bound PV is checked before the ordinary "find any matching volume"
search runs, so it takes precedence and works with `WaitForFirstConsumer`.

For this to bind, the PV and the PVC the operator generates must agree:

| Field | PV | PVC (generated) |
| --- | --- | --- |
| `storageClassName` | must match | from `spec.storage.class` |
| `accessModes` | must include `ReadWriteOnce` | always `ReadWriteOnce` |
| `volumeMode` | must be `Filesystem` | always `Filesystem` |
| `capacity.storage` | must be ≥ the request | from `spec.storage.size` |

Omit `uid` from `claimRef`. A `claimRef` with only `namespace` and `name` is a reservation;
the control plane fills in the UID when it binds. A `claimRef` that carries a *stale* UID —
which is what is left behind after the PVC is deleted — matches nothing and leaves the PV
stuck in `Released` forever.

## Procedure

The example builds a three-node cluster: cluster `my-cluster`, pool `kafka` in namespace
`kafka-system`, on nodes `node-1`, `node-2`, `node-3`, each with a disk mounted at
`/mnt/kafka-data`. Nodes carry the label `middleware.alauda.io/dedicated=true`.

### Step 1 — Prepare the disks

On each Kafka node, mount the dedicated disk and create the directory the PV will point at.
Do not put Kafka data on the root filesystem: a runaway log directory will take the node down
with it.

```bash
# On each of node-1, node-2, node-3
mkfs.xfs /dev/sdb
mkdir -p /mnt/kafka-data
echo '/dev/sdb /mnt/kafka-data xfs defaults,noatime 0 0' >> /etc/fstab
mount /mnt/kafka-data
```

The Kafka container runs as UID 1001. The operator sets `fsGroup: 0` on the pod by default, so
kubelet adjusts group ownership of the mounted volume on first use and no manual `chown` is
needed. If you have overridden the pod security context (for example following
[Run Kafka Pods as the Root User](./How_to_Run_Kafka_as_Root_User.md)), make the host
directory writable by the UID/GID you configured.

:::warning Capacity is advisory for local volumes
`capacity.storage` on a `local` PV is metadata used for matching. It is not a quota, and
nothing stops Kafka from filling the underlying disk past it. Set it to the real usable size of
the disk and enforce retention with `log.retention.bytes` / `log.retention.hours`.
:::

### Step 2 — Create the StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: kafka-local
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
allowVolumeExpansion: false
```

`no-provisioner` means nothing is created dynamically — the class exists only to group the PVs
you create by hand. `allowVolumeExpansion: false` is honest: local volumes cannot be resized by
the operator, and setting it true would make the operator attempt a resize that never
completes. Growing a broker's disk is an offline operation on the host.

### Step 3 — Create the pre-bound PersistentVolumes

One PV per broker, each pinned to its node and reserved for the PVC the operator will create.
Note the PVC names follow the JBOD form `data-<volumeId>-<cluster>-<pool>-<nodeId>` used by
the node pool in Step 4.

```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: kafka-local-node-1
  labels:
    kafka.alauda.io/pool: my-cluster-kafka
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: kafka-local
  # Reservation: only this PVC may ever bind to this volume.
  # Do not set uid — the control plane fills it in on bind.
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: kafka-system
    name: data-0-my-cluster-kafka-0
  local:
    path: /mnt/kafka-data
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node-1
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: kafka-local-node-2
  labels:
    kafka.alauda.io/pool: my-cluster-kafka
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: kafka-local
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: kafka-system
    name: data-0-my-cluster-kafka-1
  local:
    path: /mnt/kafka-data
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node-2
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: kafka-local-node-3
  labels:
    kafka.alauda.io/pool: my-cluster-kafka
spec:
  capacity:
    storage: 500Gi
  volumeMode: Filesystem
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: kafka-local
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: kafka-system
    name: data-0-my-cluster-kafka-2
  local:
    path: /mnt/kafka-data
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node-3
```

Writing these by hand is where mistakes get made. Generate them instead:

```bash
#!/usr/bin/env bash
set -euo pipefail

CLUSTER=my-cluster
POOL=kafka
NAMESPACE=kafka-system
SC=kafka-local
VOLUME_ID=0
SIZE=500Gi
PATH_ON_HOST=/mnt/kafka-data

# node ID -> hostname. The index is the Kafka node ID; edit this list only.
NODES=(node-1 node-2 node-3)

for id in "${!NODES[@]}"; do
  host="${NODES[$id]}"
  cat <<YAML
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${CLUSTER}-${POOL}-${id}-local
  labels:
    kafka.alauda.io/pool: ${CLUSTER}-${POOL}
spec:
  capacity:
    storage: ${SIZE}
  volumeMode: Filesystem
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ${SC}
  claimRef:
    apiVersion: v1
    kind: PersistentVolumeClaim
    namespace: ${NAMESPACE}
    name: data-${VOLUME_ID}-${CLUSTER}-${POOL}-${id}
  local:
    path: ${PATH_ON_HOST}
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values: ["${host}"]
YAML
done
```

Review the output, then apply it. Keep the script in version control alongside the Kafka
manifests — it is the authoritative record of which broker owns which node.

### Step 4 — Create the KafkaNodePool and Kafka resources

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: kafka
  namespace: kafka-system
  labels:
    strimzi.io/cluster: my-cluster
  annotations:
    # Pin the node IDs so PVC names stay stable across scale-down/scale-up.
    strimzi.io/next-node-ids: "[0-2]"
spec:
  replicas: 3
  roles:
    - controller
    - broker
  storage:
    type: jbod
    volumes:
      - id: 0
        type: persistent-claim
        size: 500Gi
        class: kafka-local
        kraftMetadata: shared
        deleteClaim: false
        # Optional second line of defence: only PVs carrying this label are
        # eligible at all. Pre-binding already guarantees the mapping; this
        # prevents an unrelated PV in the same class from being considered.
        selector:
          kafka.alauda.io/pool: my-cluster-kafka
  template:
    pod:
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: middleware.alauda.io/dedicated
                    operator: In
                    values: ["true"]
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            # strimzi.io/name is always "<cluster>-kafka" — it is derived from the
            # cluster name, not the pool name. It happens to read the same here
            # because this pool is called "kafka".
            - labelSelector:
                matchExpressions:
                  - key: strimzi.io/name
                    operator: In
                    values: ["my-cluster-kafka"]
              topologyKey: kubernetes.io/hostname
      tolerations:
        - key: middleware.alauda.io/dedicated
          operator: Equal
          value: "true"
          effect: NoSchedule
---
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: my-cluster
  namespace: kafka-system
spec:
  kafka:
    version: 4.2.0
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: tls
        port: 9093
        type: internal
        tls: true
    config:
      # Replication is the fault tolerance model here — the pods cannot move,
      # so a lost node must be survivable by the other two.
      default.replication.factor: 3
      min.insync.replicas: 2
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      transaction.state.log.min.isr: 2
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

Notes on this manifest:

- **`metadataVersion` is omitted** so it defaults to the metadata version matching
  `spec.kafka.version`. Set it explicitly only when performing a staged version upgrade.
- **Replication factor 3 with `min.insync.replicas: 2` is not optional here.** The pods are
  pinned to their nodes; a node outage takes a broker out until that node returns. Kafka's own
  replication is the only fault tolerance in this design. A topic created with RF=1 on this
  cluster is unavailable for the entire duration of a node outage.
- **`podAntiAffinity` is `required`, not `preferred`.** Two brokers on one node would contend
  for that node's single PV, and the second would stay `Pending` — but making it explicit turns
  a confusing scheduling failure into an obvious one.
- **`kraftMetadata: shared`** puts the KRaft metadata log on the same volume. With a single
  JBOD volume this is the only sensible setting.
- **`class` and `selector` are effectively fixed at creation time.** Editing them later does not
  fail loudly — the operator detects a disallowed storage change, **ignores every storage change
  in the pool**, keeps the previous configuration, and records a `KafkaStorage` warning on the
  Kafka resource. Plan the storage block before the first apply, and check
  `status.conditions` after any edit to it. Increasing `size`, and changing `deleteClaim` or
  `kraftMetadata`, are the changes that *are* accepted.

:::info Existing PVCs are never re-pointed by the operator
Before patching a PVC, the operator restores `volumeName`, `storageClassName`, `accessModes`,
and `selector` from the live object. Even a mistaken edit to the node pool cannot move a bound
PVC to a different PV — the binding can only change if the PVC itself is deleted and recreated.
:::

### Step 5 — Apply in order

Ordering matters only in that the PVs should exist before the operator creates the PVCs. If
you apply the Kafka CR first, the PVCs are created and stay `Pending` until the PVs appear;
they will then bind correctly, because a pending PVC still binds to its reserved PV. Applying
the PVs first is cleaner:

```bash
kubectl apply -f storageclass.yaml
kubectl apply -f kafka-local-pvs.yaml
kubectl apply -f kafka-cluster.yaml
```

## Verification

Run these after the cluster reports ready. The checks below have not been executed against a
live cluster in preparing this document — treat the expected output as the shape to look for,
not a literal transcript.

**1. Every PV is bound to the PVC it was reserved for.**

```bash
kubectl get pv -o custom-columns=\
'PV:.metadata.name,STATUS:.status.phase,CLAIM:.spec.claimRef.name,'\
'NODE:.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0],'\
'PATH:.spec.local.path'
```

Confirm each row pairs the node hostname with the broker index you intended. A PV in
`Available` while a PVC is `Pending` means the two do not agree on class, size, access mode, or
volume mode.

**2. Every PVC is bound.**

```bash
kubectl -n kafka-system get pvc -o custom-columns=\
'PVC:.metadata.name,STATUS:.status.phase,VOLUME:.spec.volumeName,CLASS:.spec.storageClassName'
```

**3. Each broker pod is running on the node that owns its data.**

```bash
kubectl -n kafka-system get pod -l strimzi.io/cluster=my-cluster \
  -o custom-columns='POD:.metadata.name,NODE:.spec.nodeName,STATUS:.status.phase'
```

Cross-check `my-cluster-kafka-0` against `node-1`, and so on. This is the check that catches a
mistake in the PV generation script.

**4. The broker's stored node ID matches its identity.**

```bash
kubectl -n kafka-system exec my-cluster-kafka-0 -c kafka -- \
  cat /var/lib/kafka/data-0/kafka-log0/meta.properties
```

`node.id` must equal the number at the end of the pod name. This is the single most direct
confirmation that a broker is on the right disk.

:::warning This check needs a Running pod
`kubectl exec` requires the container to be up — and the wrong-binding case this check exists to
catch is precisely the one where the broker is crash-looping. When the pod is not `Running`, read
the same file from the host instead: see step 2 of
[Recovering a Wrong Binding](#recovering-a-wrong-binding).
:::

**5. The cluster is healthy.**

```bash
kubectl -n kafka-system get kafka my-cluster -o jsonpath='{.status.conditions}' | jq
kubectl -n kafka-system exec my-cluster-kafka-0 -c kafka -- \
  bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --under-replicated-partitions
```

The second command should print nothing.

## Day-2 Operations

### Deleting and recreating the cluster

With `deleteClaim: false`, deleting the `Kafka` and `KafkaNodePool` resources leaves the PVCs
behind. Recreating the cluster with the same cluster name, pool name, and node IDs reuses those
PVCs unchanged, and no rebinding occurs. **Do not delete the PVCs during cleanup** — that is
the step that used to produce the cross-binding.

If the PVCs were deleted, the PVs go to `Released` and the pre-binding still holds the
reservation. Follow [Recovering a Released PV](#recovering-a-released-pv) before recreating.

### Adding a broker

1. Prepare the disk on the new node.
2. Create a PV pre-bound to `data-0-my-cluster-kafka-3` with `nodeAffinity` for the new node.
3. Set `strimzi.io/next-node-ids: "[3]"` on the node pool.
4. Increase `spec.replicas` to 4.
5. Rebalance partitions onto the new broker with Cruise Control or
   `kafka-reassign-partitions.sh` — a new broker is empty and takes no traffic until you do.

### Replacing a failed node

The broker's identity is the node ID, and its data is on the failed node's disk. Two paths:

- **Disk survived** (node hardware failure, disk intact): move the disk to the replacement
  node, mount it at the same path, and edit the PV's `nodeAffinity` to the new hostname. The
  broker restarts with its data and rejoins without replication traffic.
- **Disk lost**: delete the PVC and the PV, recreate both with the same names and the same
  `claimRef`, and let the broker re-replicate from its peers. This is safe *only* while the
  other two brokers hold in-sync replicas of every partition — check
  `--under-replicated-partitions` first, and do one broker at a time.

### Growing a broker's disk

Local volumes cannot be expanded by the operator. Grow the filesystem on the host, then update
`capacity.storage` on the PV to match.

Increasing `spec.storage.size` on the node pool *is* an accepted change, so the operator will
attempt a PVC resize. With `allowVolumeExpansion: false` on the class it stops immediately,
records a `PvcResizingWarning` on the Kafka resource, and continues reconciling — harmless, but
it leaves a standing warning. Either accept the warning to keep the declared size honest, or
leave `size` alone and treat the PV's `capacity` as the record of the real disk size. Do not
*decrease* `size`: shrinking is a disallowed change and causes the operator to ignore the whole
storage block.

Either way, the PVC's `status.capacity` will keep reporting the original size. There is no CSI
driver and no resize path behind a `no-provisioner` class, so nothing updates it after you grow
the host filesystem. Use `df` on the node, not `kubectl get pvc`, to read real capacity.

## Troubleshooting

### PVC stays `Pending`

Compare the PVC against the PV it should bind to. The four fields that must agree are
`storageClassName`, `accessModes`, `volumeMode`, and capacity (PV ≥ PVC request). Also check
that the `selector` on the node pool matches labels actually present on the PV — a selector
that matches nothing produces a permanently pending PVC with no other symptom.

```bash
kubectl -n kafka-system describe pvc data-0-my-cluster-kafka-0
kubectl describe pv kafka-local-node-1
```

### Pod stays `Pending` with a volume node affinity conflict

The scheduler cannot find a node satisfying both the pod's affinity/tolerations and the PV's
`nodeAffinity`. Usually the node label in the PV does not match the actual
`kubernetes.io/hostname`, or the node is missing the `middleware.alauda.io/dedicated` label
while the pod requires it.

```bash
kubectl get node --show-labels | grep -E 'hostname|dedicated'
```

### Recovering a Released PV

A PV goes `Released` when its PVC is deleted. With `Retain` the data is intact, but the PV
will not bind again, because its `claimRef` now carries the deleted PVC's UID.

Remove **only the UID and resourceVersion**, keeping the `namespace` and `name`. That returns
the PV to `Available` while preserving the reservation:

```bash
kubectl patch pv kafka-local-node-1 --type=json -p='[
  {"op": "remove", "path": "/spec/claimRef/uid"},
  {"op": "remove", "path": "/spec/claimRef/resourceVersion"}
]'
```

Do **not** clear the whole `claimRef` (`--type=merge -p '{"spec":{"claimRef":null}}'`). That
makes the PV a free agent again and reintroduces exactly the first-come-first-serve race this
design exists to prevent.

Verify all three are `Available` and still reserved before recreating the cluster:

```bash
kubectl get pv -o custom-columns='PV:.metadata.name,STATUS:.status.phase,CLAIM:.spec.claimRef.name'
```

### Recovering a Wrong Binding

Symptom: a broker crash-loops with an inconsistent node ID, or a broker is healthy but a peer's
data is missing.

1. **Stop.** Do not delete the log directory, and do not delete the PVC of the crash-looping
   broker. The crash loop is Kafka protecting the data.
2. Determine the true owner of each disk. On each node, read the `meta.properties` under the
   host path:

   ```bash
   # On each Kafka node
   find /mnt/kafka-data -name meta.properties -exec sh -c 'echo "== $1"; cat "$1"' _ {} \;
   ```

   The `node.id` in each file is the broker that owns that node's disk.
3. Scale the node pool to 0 replicas so no broker is running.
4. Delete the PVCs (the data is on `Retain`ed PVs and is not touched), then repair each PV's
   `claimRef` to point at the PVC name matching the `node.id` you found in step 2, clearing the
   stale UID as above.
5. Scale the pool back up and re-verify with check 4 in [Verification](#verification).

If a broker has already formatted an empty disk and joined the cluster, its original data is
still on whichever PV it was displaced from. Recover by correcting the bindings as above; the
re-replication that already happened is discarded when the broker comes back on its own disk.

## Limitations and Open Items

- **A pinned broker cannot fail over.** This is the design, not a defect. If a node is down,
  that broker is down until the node returns. Availability comes from replication factor 3 and
  `min.insync.replicas: 2`; with those, one node down is a healthy cluster. Two nodes down is an
  outage, and no storage configuration changes that.
- **Cluster-scoped objects.** PVs and StorageClasses cannot be created by a namespace-scoped
  tenant. On a multi-tenant ACP cluster, provisioning is a platform-administrator task that has
  to happen before the tenant creates the Kafka instance.
- **The ACP Kafka instance form may not expose `class` and `selector` on the node pool.** This
  has not been verified for ACP 4.3. If the form does not offer them, switch to the YAML view
  when creating the instance, or apply the `KafkaNodePool` manifest directly.
- **Kafka 2.x / ZooKeeper operator line.** The sibling `-2x` operator (Strimzi 0.25) has no
  `KafkaNodePool`: storage lives under `Kafka.spec.kafka.storage` and
  `Kafka.spec.zookeeper.storage`, PVC names are `data-<cluster>-kafka-<n>` and
  `data-<cluster>-zookeeper-<n>`, and ZooKeeper needs its own three PVs. The PV-side design —
  `claimRef` pre-binding plus `nodeAffinity` — is unchanged and is the part that matters.
