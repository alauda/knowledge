---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The control-plane etcd database keeps growing on disk and operators expect the automatic defragmentation loop to reclaim the slack. Instead, no defragmentation events are observed in the operator logs even though:

- the defragmentation feature has not been explicitly disabled,
- a manual `etcdctl defrag` against a single member visibly shrinks the on-disk size,
- the cluster is not under maintenance pause.

The question is therefore not "why does defragmentation fail" but "why does the controller decide there is nothing to do".

## Root Cause

The etcd controller's defragmentation loop is not driven by absolute size — it is driven by **two** thresholds that must both be satisfied before a member is considered a candidate:

| Threshold | Default | Meaning |
|---|---|---|
| Fragmentation ratio | 45 % | `(size_on_disk - size_in_use) / size_on_disk` must exceed this value |
| Minimum DB size | 100 MiB | absolute on-disk size must exceed this floor |

The ratio guards against churning members that already pack tightly; the floor guards against running expensive offline compaction on small databases that gain little from it. A cluster sitting at, say, **30 % fragmentation on a 4 GB store** clears the floor easily but is still well below the ratio threshold — so the controller logs the measurement and does nothing. From the operator's perspective the loop is "broken"; from the controller's perspective it is correctly waiting until a single defragmentation will reclaim a meaningful amount.

A useful way to think about it: a manual defrag will *always* shrink the file because BoltDB rewrites it in pack-tight order. The interesting question is whether the cost (a brief leader pause, stop-the-world compaction on the member) is worth it for the bytes returned. The 45 % default is the controller's answer.

## Resolution

### Step 1 — Confirm the controller is observing the cluster

Inspect the etcd operator's defrag controller log line on each member; it reports the live ratio and absolute size:

```bash
kubectl -n <etcd-operator-namespace> logs deploy/etcd-operator \
  | grep -i defrag | tail -n 20
```

A healthy line looks like:

```text
defragcontroller.go:... etcd member "node-1.example" backend store fragmented:
30.95 %, dbSize: 4238577664
```

If those lines are present and the ratio is below the threshold, the controller is doing its job — it is reporting "below threshold, no action".

### Step 2 — Decide whether the threshold should be lowered

For most clusters the defaults are correct. Consider lowering the ratio only when:

- the etcd disk is small enough that 45 % slack is operationally painful (e.g. a 200 MiB DB on a small lab),
- write amplification on the underlying storage makes free pages expensive,
- a downstream tool (backup, snapshot transfer) is sensitive to the on-disk file size, not the in-use size.

If the threshold needs to be relaxed, change it through the cluster's etcd configuration object rather than by patching the operator deployment — patches to the deployment are reverted on the next reconcile.

### Step 3 — When an immediate manual defrag is needed

For a one-off reclaim (for example before snapshotting or before increasing the DB size limit), defrag each member sequentially, **never in parallel**, and observe the leader after each pass. The exec is run inside the etcd container of each control-plane pod:

```bash
for pod in $(kubectl -n kube-system get pod -l component=etcd \
              -o jsonpath='{.items[*].metadata.name}'); do
  echo "===== $pod"
  kubectl -n kube-system exec "$pod" -c etcd -- sh -c "
    ETCDCTL_API=3 etcdctl \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      defrag
  "
  sleep 30
done
```

Defragmentation is a stop-the-world operation on the targeted member — clients pin to a different member while it runs. Pacing the loop avoids two members being unavailable at the same time and forcing a leader election under load.

## Diagnostic Steps

Watch the in-use vs. on-disk numbers per member:

```bash
for pod in $(kubectl -n kube-system get pod -l component=etcd \
              -o jsonpath='{.items[*].metadata.name}'); do
  echo "===== $pod"
  kubectl -n kube-system exec "$pod" -c etcd -- sh -c "
    ETCDCTL_API=3 etcdctl \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      endpoint status -w table
  "
done
```

The `DB SIZE` column is the on-disk file; cross-check it against `etcdctl endpoint status` `RAFT INDEX` and `RAFT TERM` to make sure the members agree on history before deciding whether the size delta is fragmentation or genuine growth.

If a single member is dramatically larger than the others, the cause is usually a stale alarm that pinned the database — clear it before defragmenting:

```bash
kubectl -n kube-system exec "<member-pod>" -c etcd -- sh -c "
  ETCDCTL_API=3 etcdctl alarm list
  ETCDCTL_API=3 etcdctl alarm disarm
"
```

If the database is still growing after a successful defrag, the cause is not fragmentation but live volume — look for a workload churning ConfigMaps, leases, or events. The store will not shrink while the producer keeps writing.
