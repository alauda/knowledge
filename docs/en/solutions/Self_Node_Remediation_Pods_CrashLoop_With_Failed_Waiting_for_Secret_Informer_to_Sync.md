---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Self Node Remediation Pods CrashLoop With "Failed Waiting for Secret Informer to Sync"
## Issue

After installing or upgrading the Self Node Remediation (SNR) operator on Alauda Container Platform, the per-node SNR agent pods enter `CrashLoopBackOff`. Their logs end with:

```text
ERROR peerhealth.server failed to get server credentials
  {"error": "Timeout: failed waiting for *v1.Secret Informer to sync"}
ERROR setup        problem running manager
  {"error": "Timeout: failed waiting for *v1.Secret Informer to sync"}
```

Other operators on the same cluster start cleanly. The cluster has tens of thousands of Secrets across all namespaces.

## Root Cause

SNR agents communicate with each other over mTLS to perform peer health checks. Each agent reads its TLS keypair from a Secret at startup. The agent uses a Kubernetes informer for that read and bounds the initial cache sync with a fixed 10-second timeout.

On a cluster with a very large total Secret population, the initial informer LIST/WATCH on `secrets` cannot complete within 10 seconds — the API server returns the page sequence slower than the timeout allows, especially while etcd is also serving the cluster's normal traffic. The agent gives up, the manager fails to start, and the pod is restarted. On the next restart the same race repeats.

The bound is hard-coded in the agent today; the upstream tracker has the issue logged for the timeout to be made configurable.

```bash
kubectl get secrets -A --no-headers | wc -l
# 8300   <-- "many" in the sense of this bug
```

## Resolution

Until the upstream agent makes the informer sync timeout configurable, two practical paths.

### Reduce Secret cardinality

Often the bulk of `secrets -A` count is auto-generated `kubernetes.io/service-account-token` Secrets created for every ServiceAccount. With modern bound-token projection, those legacy SA token Secrets are usually not needed. Confirm and prune:

```bash
# Count by type
kubectl get secret -A -o json | jq -r \
  '.items[] | .type' | sort | uniq -c | sort -rn

# Remove legacy SA-token secrets that are not referenced by any pod's
# spec.imagePullSecrets / spec.volumes[*].secret.secretName / sa.secrets[]
# (audit before mass-deletion!)
```

Avoid mass-deleting Secrets blindly — pods explicitly mounting one will fail. Pair the count reduction with `kubectl get pods -A -o json | jq` filtering to find truly unused entries.

### Stagger SNR rollout while debugging

Cordon a subset of nodes so the SNR DaemonSet only schedules a handful of agents at once. With fewer concurrent informer syncs in flight, the API server pressure drops and the 10-second window is more often met. This is a temporary band-aid:

```bash
kubectl cordon <node-X>   # take a few nodes out
# wait for remaining SNR pods to settle into Running
kubectl uncordon <node-X> # bring them back one at a time
```

### File or follow the upstream issue

The fix is to make the informer sync timeout configurable in the SNR agent. Until that lands and is picked up by the operator bundle running here, large clusters will continue to need the workaround above.

## Diagnostic Steps

1. Confirm the symptom and quantify the scale:

   ```bash
   kubectl -n <snr-ns> get pods -l app=self-node-remediation -o wide
   kubectl -n <snr-ns> logs <crashing-pod> --previous | tail
   kubectl get secrets -A --no-headers | wc -l
   ```

   A Secret count in the thousands plus the exact `Timeout: failed waiting for *v1.Secret Informer to sync` message is the matching signature.

2. Time the informer's API calls from one of the affected nodes:

   ```bash
   kubectl debug node/<node> -- chroot /host \
     curl -k --cacert /etc/kubernetes/pki/ca.crt \
       -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \
       -o /dev/null -w '%{time_total}\n' \
       https://kubernetes.default.svc/api/v1/secrets?limit=500
   ```

   If a single page takes more than ~2-3 seconds, the API server is the bottleneck — investigate etcd latency, kube-apiserver request quota, and watch cache size.

3. Also check the API server's audit logs for slow LIST `secrets` calls during SNR agent restarts:

   ```text
   "verb":"list","objectRef":{"resource":"secrets","apiGroup":""},
   "responseStatus":{"code":200},"stageTimestamp":"...","requestReceivedTimestamp":"..."
   ```

   The delta between `requestReceivedTimestamp` and `stageTimestamp` for those entries indicates how close to (or past) 10 seconds the cache sync is running.

4. After applying any of the workarounds, restart the failing pods and watch for `peerhealth.server` reporting a successful credential load and the manager moving past `setup`:

   ```bash
   kubectl -n <snr-ns> delete pod -l app=self-node-remediation
   kubectl -n <snr-ns> logs -f <new-pod> | head -50
   ```
