---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Loki compactor pod repeatedly crashes with a 403 against the cluster's S3-backed object store. The init sequence joins memberlist successfully and then fails on the first S3 request:

```text
caller=memberlist_client.go:633 phase=startup
  msg="joining memberlist cluster succeeded" reached_nodes=6

init compactor: failed to init delete store: failed to get s3 object:
  RequestError: send request failed
caused by: Get "https://s3.<region>.amazonaws.com/loki/index/delete_requests/delete_requests.gz":
  Forbidden
```

The compactor's other cluster communication (memberlist, internal gRPC) works. Only the outbound HTTPS call to the object-storage endpoint fails with `Forbidden`. Credentials are not the issue — manually running the same request with the compactor's credentials from a workstation succeeds. The failure is specifically what the `403` suggests *in the context of this deployment*: the cluster's HTTP proxy intercepted the outbound request, and the proxy's policy does not allow authenticated traffic toward that specific S3 endpoint.

## Root Cause

The cluster's `Proxy` object forces every outbound HTTPS call from pods through the configured HTTP proxy unless the destination domain is explicitly exempted via `noProxy`. The Loki compactor's S3 endpoint — `s3.<region>.amazonaws.com` or whatever the object-store provider's hostname is — is not in the default `noProxy` entries (`cluster.local`, service CIDR, API-internal DNS). As a result:

1. Compactor starts and reads `HTTPS_PROXY` from its pod environment.
2. The pod is configured by the Proxy object: all HTTPS goes through `proxy.example.com:8443`.
3. The compactor's S3 SDK picks up `HTTPS_PROXY` and routes its request through the proxy.
4. The corporate proxy's egress policy does not permit the S3 bucket's URL — typically because the object store is supposed to be reached directly, not tunnelled through the proxy. The proxy answers `403`.
5. Loki's compactor treats the 403 as an initialisation failure and aborts. kubelet restarts the pod; the next attempt hits the same 403.

Adding the object-store endpoint to the `Proxy` object's `noProxy` field lets the compactor connect to S3 directly instead of via the corporate proxy, which is what the design expected.

## Resolution

### Add the object-store endpoint to `noProxy`

Extract the S3 endpoint the compactor is using from the cluster's LokiStack object-storage secret:

```bash
NS=cpaas-logging
SECRET=<loki-object-storage-secret>

kubectl -n "$NS" get secret "$SECRET" -o jsonpath='{.data.endpoint}' | base64 -d
# e.g. https://s3.ap-south-1.amazonaws.com
```

Add the hostname (without scheme) to the cluster's `Proxy` CR's `noProxy`:

```bash
kubectl edit proxy cluster
```

```yaml
apiVersion: config.alauda.io/v1
kind: Proxy
metadata:
  name: cluster
spec:
  httpProxy:  http://proxy.example.com:8080
  httpsProxy: https://proxy.example.com:8443
  noProxy: ".cluster.local,.svc,10.128.0.0/14,172.30.0.0/16,api-int.example.com,s3.ap-south-1.amazonaws.com"
```

**Note**: updating the cluster-wide Proxy object triggers a controlled rollout of node configuration; nodes reboot (usually one at a time, drain-then-reboot sequence) so workloads experience the normal node-reboot behaviour. Schedule the change in a maintenance window.

After the rollout completes, Loki compactor pods restart as part of the node cycle (or can be deleted manually to pick up the new pod env). The next startup reads the updated `NO_PROXY` and the S3 request goes direct; compactor reaches `Ready`.

### Wildcard vs exact hostname

If multiple buckets / endpoints are used (staging, production, regional endpoints), consider a wildcard pattern:

```text
noProxy: "...,.amazonaws.com,.<internal-object-store-domain>"
```

A leading `.` makes the entry match any subdomain. This is less precise than listing each hostname, but reduces churn when a new bucket is added. Trade-off is that the proxy is now bypassed for every subdomain under the pattern, not just the specific bucket used by logging.

### Verify on one pod before fleet-wide

Before committing to the cluster-wide change, test the hypothesis by force-bypassing the proxy in the compactor's pod:

```yaml
# Temporary patch on the compactor's Deployment / StatefulSet
# via the LokiStack operator's config surface if exposed, otherwise
# through a one-off test pod.
env:
  - name: NO_PROXY
    value: "<existing-no-proxy>,s3.<region>.amazonaws.com"
  - name: no_proxy
    value: "<existing-no-proxy>,s3.<region>.amazonaws.com"
```

If the compactor's next start-up reaches `Ready` with the overridden env, the root cause is confirmed and the cluster-wide Proxy edit is the durable fix.

### What does not work

- **Raising the compactor's retry counts or delays.** The 403 is deterministic; retrying produces the same 403.
- **Changing the compactor's S3 credentials.** Credentials do not help when the proxy in between is returning the 403 before the S3 auth layer runs.
- **Installing the proxy's CA in the compactor's trust store.** The CA is not the issue; the proxy is authoritative about the 403 and will return it regardless of TLS trust.

## Diagnostic Steps

Confirm the exact URL the compactor is trying to reach:

```bash
kubectl -n "$NS" logs <compactor-pod> --tail=200 | \
  grep -iE 'Forbidden|send request failed|init compactor' | head -5
```

The URL in the error (`Get "https://<host>/..."`) is the one that must land in `noProxy`.

Read the current Proxy state:

```bash
kubectl get proxy cluster -o yaml | yq '.spec'
```

Compare `noProxy` contents against the URL from the error. The hostname should be present either by exact match or by a wildcard that covers it.

Inspect a sample pod's environment to see what the runtime actually received from the Proxy object:

```bash
kubectl -n "$NS" exec <running-pod> -- env | grep -iE 'proxy'
# HTTPS_PROXY=https://proxy.example.com:8443
# NO_PROXY=.cluster.local,.svc,...
```

If `NO_PROXY` has the expected entries but the compactor still fails, flush the pod so a fresh instance picks up the current env:

```bash
kubectl -n "$NS" delete pod <compactor-pod>
```

After the fix reconciles, the compactor should reach `Ready` and start draining its work queue. Monitor `logging-loki-compactor-0` for sustained `Ready=True` across several kubelet status intervals; a stable run confirms the S3 path works.
