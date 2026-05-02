---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Loki ingester pod restarts and never reaches the `1/1` ready state. Its log shows a heartbeat-timeout failure pointing at an IP that no longer exists in the cluster:

```text
msg="found an existing instance(s) with a problem in the ring,
  this instance cannot become ready until this problem is resolved.
  The /ring http endpoint on the distributor (or single binary)
  provides visibility into the ring."
ring=ingester err="instance 10.x.x.x:9095 past heartbeat timeout"
```

Companion symptoms:

- The gossip ring's gossip port log says `WriteTo failed addr=:7946 err="dial tcp:7946: i/o timeout"` for one or more old IPs.
- The `<lokistack>-gossip-ring` Endpoints object only lists the live pod IPs; the addresses the ingester is trying to reach are nowhere in the namespace.
- The `/ring` endpoint on a distributor pod lists the affected ingester(s) as `UNHEALTHY`.

The Loki object store is healthy and the storage-side troubleshooting (S3 reachability, prefix permissions, retention sizing) all checks out — the failure is internal to the gossip ring's view of cluster membership.

## Root Cause

Loki components (ingesters, distributors, queriers) discover one another through a gossip ring. Each member registers its pod IP in the shared ring data and renews a heartbeat at a fixed interval. When a pod is deleted, the new pod re-registers under a new IP but the old IP's entry stays in the ring until either the new instance explicitly forgets it or the gossip eviction sweep runs.

A network blip during a reconcile (a brief partition, a node drain that took longer than the heartbeat budget, a slow CNI rebind after pod IP rotation) can leave an ingester transitioning to `UNHEALTHY` in the ring without ever rejoining as `ACTIVE`. The Loki ingester startup logic refuses to mark itself ready while the ring contains an instance that is past its heartbeat — it needs an operator to either revive that instance or remove it from the ring.

Because the offending IP no longer corresponds to a real pod, simply waiting won't fix it: nothing will ever heartbeat from that IP, and the gossip eviction window can be longer than the operator can tolerate downtime for.

The clean recovery is to call the ring's `forget` endpoint to remove the dead instance, then restart the stuck ingester so it re-registers cleanly.

## Resolution

Identify the unhealthy member ID by querying the ring through a distributor pod. The TLS material lives on the distributor's filesystem — start a debug pod on the distributor deployment so the certificates are available:

```bash
NS=<lokistack-namespace>
LOKI=<lokistack-cr-name>

kubectl -n "$NS" debug --image=busybox \
  deployment/${LOKI}-distributor
```

From the debug pod, query the `/ring` endpoint and pick out members that are not `ACTIVE`:

```bash
DISTR=$(printenv | grep _DISTRIBUTOR_HTTP_PORT_3100_TCP_ADDR | cut -d= -f2)

curl -k \
  --cert /var/run/tls/http/server/tls.crt \
  --key  /var/run/tls/http/server/tls.key \
  -H "Accept: application/json" \
  "https://${DISTR}:3100/ring"
```

The response is JSON; each `shards[]` entry has `id` and `state`. Note the `id` of every member with `state` other than `ACTIVE`.

Forget each unhealthy member from the ring:

```bash
for member in <id-1> <id-2>; do
  curl -k -X POST \
    --cert /var/run/tls/http/server/tls.crt \
    --key  /var/run/tls/http/server/tls.key \
    --data-raw "forget=${member}" \
    "https://${DISTR}:3100/ring"
done
```

The ring drops those IDs immediately. The remaining ingesters revisit the membership list and the stuck pod's startup loop no longer sees a peer past its heartbeat.

Restart the stuck ingester pods so they re-register clean:

```bash
kubectl -n "$NS" delete pod \
  -l app.kubernetes.io/component=ingester
```

After the new pods land they appear in `/ring` as `ACTIVE` and ready turns to `1/1` within a few seconds.

If the cluster routes egress through a cluster-wide proxy, the curl invocations need `--noproxy` to keep the in-cluster DNS resolution out of the proxy's scope:

```bash
curl -k --noproxy "${DISTR}" \
  --cert /var/run/tls/http/server/tls.crt \
  --key  /var/run/tls/http/server/tls.key \
  -H "Accept: application/json" \
  "https://${DISTR}:3100/ring"
```

For long-term hygiene, audit the gossip ring after large cluster-level operations (node drain, CNI redeploy, control-plane rotation) — that's when stale members are most likely to pile up. A short script that calls `/ring`, filters for non-ACTIVE state, and either forgets the entries or alerts is a low-cost addition to the platform's reconciliation loop.

## Diagnostic Steps

Confirm the symptom by listing the ingester pods and their ready status:

```bash
kubectl -n "$NS" get pods -l app.kubernetes.io/component=ingester
# expected: a row showing 0/1 with the same pod uptime as the symptom window
```

Cross-check the gossip-ring Endpoints object — the addresses the unhealthy member is trying to reach should not appear:

```bash
kubectl -n "$NS" describe endpoints ${LOKI}-gossip-ring
```

If the missing IPs are the same as the ones in the heartbeat-timeout error, the ring view and the actual pod IPs have diverged.

After running the forget calls, re-query `/ring` and confirm only `ACTIVE` members remain:

```bash
curl -k \
  --cert /var/run/tls/http/server/tls.crt \
  --key  /var/run/tls/http/server/tls.key \
  -H "Accept: application/json" \
  "https://${DISTR}:3100/ring" \
  | jq -r '.shards[] | "\(.id)\t\(.state)"' \
  | grep -v ACTIVE
```

Empty output means the ring is clean. The stuck ingesters should move from `0/1` to `1/1` within their next reconcile cycle; if they don't, restart them with the delete command above.

If the same staleness recurs after the recovery, look for a network event timeline correlated with the heartbeat window. Frequent recurrences usually point at an underlying CNI or node-stability issue rather than at Loki.
