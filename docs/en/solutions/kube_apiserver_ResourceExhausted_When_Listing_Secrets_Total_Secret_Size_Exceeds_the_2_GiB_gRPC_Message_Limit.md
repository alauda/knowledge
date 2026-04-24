---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Every `kube-apiserver` pod emits the following error on a loop, and API requests that list secrets start failing or becoming extremely slow:

```text
E1222 23:12:34.079327      16 cacher.go:476] cacher (secrets): unexpected ListAndWatch error:
  failed to list *core.Secret: rpc error: code = ResourceExhausted
  desc = grpc: trying to send message larger than max (2167485068 vs. 2147483647);
  reinitializing...
```

The controllers that run a list-and-watch on secrets (notably the kubelet token controller and the service-account controller) cannot rebuild their cache. Secondary symptoms:

- Pods that rely on a projected `ServiceAccountToken` fail to start — the kubelet cannot resolve the token volume.
- `kubectl get secrets -A` hangs or returns a partial list.
- Admission controllers that read from the informer cache (image pull secret resolution, webhook TLS lookup) misbehave.

## Root Cause

The number in the error — 2,147,483,647 bytes — is the gRPC **max receive message size** of `2^31 − 1` (just under 2 GiB). `kube-apiserver` watches etcd through its own in-process cacher; when it primes that cache with a `ListAndWatch` on secrets, etcd streams back every secret, each framed as a gRPC message on the watch channel. If the serialised size of **all secrets combined** exceeds the 2 GiB frame limit, etcd can no longer send the payload and aborts the stream with `ResourceExhausted`.

The cacher interprets this as a transient error and reinitialises — which of course replays the same oversized list and fails again, producing the looped log.

How a cluster reaches 2 GiB of secret storage:

1. Large numbers of ServiceAccounts (older clusters created token secrets per SA; even after token-request migration the old secrets may linger).
2. Large `type: kubernetes.io/dockerconfigjson` image pull secrets duplicated into every namespace.
3. Helm chart release data stored as secrets — especially large charts with big values files, stored with each revision retained.
4. Operator-generated state secrets (TLS cert bundles, controller leader-election) that accumulate without a cleanup path.

The fix has two parts: reduce the total secret footprint below the 2 GiB limit so the cacher can recover, and identify the source so the cluster does not drift back across the line.

## Resolution

> **Warning:** you are about to delete secrets that contain real credential material. Get a definitive list of "safe to delete" candidates from their owning controller before deleting. Deleting an in-use secret will break the workload that consumes it.

### Step 1 — size the secrets via etcd

The apiserver does not expose per-secret on-disk size. The authoritative source is etcd itself, where each secret is stored under `/registry/secrets/<ns>/<name>` serialised as protobuf. Exec into the etcd pod on a control-plane node and enumerate:

```bash
# Identify one running etcd pod on a master node.
ETCD_POD=$(kubectl get pod -n kube-system -l component=etcd \
             -o jsonpath='{.items[0].metadata.name}')

kubectl -n kube-system exec -it "$ETCD_POD" -- sh -c '
  for k in $(etcdctl get --prefix --keys-only /registry/secrets); do
    s=$(etcdctl get "$k" -w protobuf | wc -c)
    printf "%10d %s\n" "$s" "$k"
  done | sort -rn | head -50
'
```

Typical output on a cluster that has hit the limit — note both the absolute size of individual records and the long tail:

```text
    459953 /registry/secrets/app-auth/v4-0-config-system-branding-template
    269142 /registry/secrets/cluster-operators/etc-pki-entitlement
     43856 /registry/secrets/kube-system/node-kubeconfigs
     42874 /registry/secrets/etcd/etcd-all-certs-8
```

Two patterns to look for in the output:

- **Individual secret size > ~500 KiB** — almost always a TLS bundle or a Helm release payload that has ballooned.
- **A repeated basename across many namespaces** — for example `pull-secret` replicated into every user namespace. Count duplicates separately (`awk '{print $2}' | sed 's@/[^/]*$@@' | sort | uniq -c | sort -rn`).

Sum the total:

```bash
kubectl -n kube-system exec "$ETCD_POD" -- sh -c '
  total=0
  for k in $(etcdctl get --prefix --keys-only /registry/secrets); do
    s=$(etcdctl get "$k" -w protobuf | wc -c)
    total=$((total + s))
  done
  echo "total secret bytes: $total"
'
```

Anything above roughly 1.7 GiB is close to the limit; above 2 GiB the cacher error will keep firing.

### Step 2 — classify the top offenders

Common sources and their owners — consult the owner before deletion:

| Pattern | Owner | Safe action |
|---|---|---|
| Helm release secrets `sh.helm.release.v1.<chart>.v<N>` | Helm | Purge old revisions with `helm history` + `helm rollback-cleanup`, or reduce `--history-max` |
| Operator-generated webhook certificates (names end in `-tls`, `-cert`, `-webhook-cert`) | the operator | Delete; the operator will regenerate on next reconcile |
| Per-namespace `pull-secret` copies duplicating the global one | `operator.alauda.io/ResourceSyncer` or equivalent | Fix the syncer config, then delete the duplicates |
| Legacy `type: kubernetes.io/service-account-token` (one per SA, from pre-TokenRequest clusters) | kubelet / SA controller | Safe to delete in current clusters; TokenRequest replaced it |
| Huge TLS bundles pasted from a CA chain | the admin who created them | Compress, replace, or remove unused bundles |

### Step 3 — delete the identified surplus

Work one category at a time and re-check the total after each batch:

```bash
# Example: delete Helm release history older than the 5 most recent revisions
# per release. Run once per release.
kubectl -n <rel-ns> get secret -l owner=helm -o name | \
  sort | head -n -5 | xargs -r kubectl -n <rel-ns> delete

# Example: remove duplicated per-namespace pull secrets once the syncer is fixed
for ns in $(kubectl get ns -o name | cut -d/ -f2); do
  kubectl -n "$ns" delete secret duplicated-pull-secret --ignore-not-found
done
```

After each batch, re-run the total from Step 1. Once the total drops below ~1.8 GiB the cacher reinitialises successfully and the `ResourceExhausted` log stops.

### Step 4 — confirm the cacher recovers

The apiserver reinitialises the secrets cacher automatically — you do not need to restart any pod. Watch the error log tail off:

```bash
kubectl logs -n kube-system -l component=kube-apiserver --tail=200 -f | \
  grep -E 'cacher \(secrets\)|ResourceExhausted'
```

A healthy state is silence on this filter for at least one minute.

### Step 5 — confirm a functional list

Once the cacher is warm, listing secrets should respond in well under a second per namespace:

```bash
time kubectl get secrets -A --chunk-size=500 > /dev/null
```

### Step 6 — address the growth source

Deleting alone is a one-time fix; without addressing what produced the surplus the total will climb back to 2 GiB. Pick the right lever based on Step 2:

- Enforce `--history-max` on every Helm install / `helm upgrade` that your tooling runs.
- Audit the namespace sync / pull-secret replication controller; if the admin intent is one secret per namespace and you have 5 000 namespaces, that alone is multiple GiB. Switch to a pull-through registry credential or to a projected volume.
- Turn on an etcd-size monitor alert on `etcd_mvcc_db_total_size_in_bytes` so the next drift is caught before it reaches the cacher.

## Diagnostic Steps

Confirm the error signature precisely — the message must contain both `cacher (secrets)` and `ResourceExhausted` for this runbook to apply:

```bash
kubectl logs -n kube-system -l component=kube-apiserver --tail=500 | \
  grep -c 'cacher (secrets):.*ResourceExhausted'
```

Check the total etcd database size (a proxy for the secret total — secrets are usually the dominant contributor):

```bash
ETCD_POD=$(kubectl get pod -n kube-system -l component=etcd \
             -o jsonpath='{.items[0].metadata.name}')
kubectl -n kube-system exec "$ETCD_POD" -- \
  etcdctl endpoint status --write-out=table
```

The `DB SIZE` column on a cluster headed for the gRPC limit is typically in the 2–4 GiB range. If it is higher than 4 GiB you should also run `etcdctl defrag` after cleanup to reclaim free pages; the logical size drops but the on-disk file does not, until defrag runs.

Look at controllers that depend on the secrets informer:

```bash
kubectl logs -n kube-system -l app=service-account-controller --tail=200 | \
  grep -E 'informer|list-watch'
```

Failing lines here are the secondary confirmation — once Step 4 passes, these informer errors also stop.

If secrets never grow large but the error still appears, the cacher may be hitting the limit on a different resource type — re-read the error substring: `cacher (secrets)` vs `cacher (configmaps)` vs `cacher (events)`. The same 2 GiB frame limit applies to every cacher; the resource name in the message tells you which one to clean up.
