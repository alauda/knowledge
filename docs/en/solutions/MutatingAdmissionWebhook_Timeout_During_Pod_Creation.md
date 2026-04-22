---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Kubernetes API server reports that a MutatingAdmissionWebhook fails to complete its mutation within the 13-second deadline:

```
Internal error occurred: admission plugin "MutatingAdmissionWebhook" failed to complete mutation in 13s
```

This error appears when creating pods, tasks, or other resources. The webhook pods themselves appear healthy and report no errors in their logs.

## Root Cause

The mutating admission webhook invokes an external service for every relevant API request. When the webhook backend takes too long to respond — typically because the etcd cluster is underperforming — the API server cancels the request after the 13-second timeout.

Potential causes, in order of likelihood:

1. **Slow etcd** — The webhook pods perform etcd lookups during mutation. A degraded etcd cluster slows these operations below the deadline.
2. **Webhook pod resource exhaustion** — Insufficient CPU or memory causes slow response times.
3. **Network partition** — Connectivity problems between the API server and webhook service.

## Resolution

### Step 1: Verify Webhook Pod Health

Confirm that the webhook pods are running and responsive:

```bash
kubectl get pods -n <webhook-namespace> -l app=<webhook-label>
kubectl logs -n <webhook-namespace> <webhook-pod> --tail=50
```

Check whether the webhook endpoint responds within a reasonable time:

```bash
kubectl run curl-test --image=curlimages/curl --rm -it --restart=Never -- \
  curl -sk https://<webhook-service>.<namespace>.svc:443/healthz
```

### Step 2: Check etcd Performance

If the webhook pods are healthy, investigate etcd latency. Refer to the etcd backend performance knowledge base article for detailed metrics and thresholds.

Key indicators:

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl endpoint health \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

If the response time exceeds 100 ms, the etcd cluster needs attention — check disk I/O, CPU load, and database size.

### Step 3: Check Network Connectivity

Verify that the API server can reach the webhook service:

```bash
kubectl get endpoints <webhook-service> -n <namespace>
```

Ensure the endpoints list contains valid pod IPs and that those IPs are reachable from the control-plane nodes.

### Step 4: Defragment etcd (If Needed)

If etcd database fragmentation is the root cause:

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl defrag \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

## Diagnostic Steps

Search API server logs for webhook timeout events:

```bash
kubectl logs -n kube-system kube-apiserver-<node-name> --tail=500 | \
  grep "admission plugin.*MutatingAdmissionWebhook.*failed to complete"
```

Identify which webhooks are registered and their failure policies:

```bash
kubectl get mutatingwebhookconfigurations -o wide
```

Review the timeout setting for each webhook configuration:

```bash
kubectl get mutatingwebhookconfiguration <name> -o jsonpath='{.webhooks[*].timeoutSeconds}'
```
