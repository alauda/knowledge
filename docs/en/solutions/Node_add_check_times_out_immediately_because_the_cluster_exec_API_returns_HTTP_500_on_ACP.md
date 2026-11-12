---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Node add check times out immediately because the cluster exec API returns HTTP 500 on ACP

## Issue

Adding a node to a cluster fails at the availability check with no delay. The add-node dialog returns `检查超时，请重试` ("check timed out, please retry") at once, while it still shows `节点可用性检查中...` ("node availability check in progress"). The node is reachable, and the error does not match the network state.

In the browser developer tools, the request of the add-node dialog fails:

```text
POST /apis/platform.tkestack.io/v1/clusters/<cluster>/exec?ignore_warning=true
500 Internal Server Error
```

The `tke-platform-api` log on the `global` cluster has no x509 error for `https://localhost:9443/...`.

`tke-platform-api` and `tke-platform-controller` run on the `global` cluster in `cpaas-system`. On some `global` clusters (for example on ACP 4.2) there is no `tke-platform-api` Pod, and `cluster-api-provider-alauda` manages node addition instead; check which one yours runs with `kubectl get deploy -A | grep -E 'tke-platform|cluster-api-provider-alauda'`.

Related articles: [tke-platform-api serves an expired certificate after running for a year on ACP](tke-platform-api_serves_an_expired_certificate_after_running_for_a_year_on_ACP.md), for the same immediate check timeout when the `tke-platform-api` log shows x509 errors against `localhost:9443`.

## Root Cause

### Cause 1: the cluster exec API of tke-platform-api returns 500 with no log cause

The add-node dialog runs its availability check through the cluster `exec` API (`/apis/platform.tkestack.io/v1/clusters/<cluster>/exec`), which `tke-platform-api` serves. When that API returns HTTP 500, the dialog reports it as an immediate check timeout instead of a real one. No underlying cause has been identified for a 500 that comes without a `localhost:9443` x509 line in the log. Restarting `tke-platform-api` restores the `exec` API, and the node availability check recovers.

## Resolution

### Cause 1: the cluster exec API of tke-platform-api returns 500 with no log cause

1. Confirm the 500 in the browser developer tools: the `exec?ignore_warning=true` request of the add-node dialog.

2. Read the `tke-platform-api` log on `global`. If it shows x509 errors for `localhost:9443` (`CertificateInvalidError` or `certificate has expired`), follow the related article on the expired certificate instead.

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep tke-platform-api
   kubectl -n cpaas-system logs deploy/tke-platform-api --tail=300 | grep -i -E 'exec|error|panic'
   kubectl -n cpaas-system logs deploy/tke-platform-api --tail=500 | grep -E 'localhost:9443|CertificateInvalidError|certificate has expired'
   ```

3. Check that the clock is correct on `global` and on the node, and that the node is reachable over SSH from `global`:

   ```bash
   date -u
   ```

4. Restart `tke-platform-api`.

   > **Warning:** Restarting `tke-platform-api` briefly interrupts cluster and node management on `global` for every cluster; running workloads are not affected. Apply only when the `exec` request returns 500 and the clock and the network to the node have been checked. Rollback: none needed; the Deployment recreates the Pods.

   ```bash
   kubectl -n cpaas-system rollout restart deployment/tke-platform-api
   kubectl -n cpaas-system rollout status deployment/tke-platform-api
   ```

5. Retry the node addition. If the `exec` request still returns 500, collect the `tke-platform-api` log from the time of the request and contact support.

## Diagnostic Steps

```bash
# global cluster
kubectl get deploy -A | grep -E 'tke-platform|cluster-api-provider-alauda'
kubectl -n cpaas-system get pods -o wide | grep tke-platform-api
kubectl -n cpaas-system logs deploy/tke-platform-api --tail=500 | grep -E 'localhost:9443|CertificateInvalidError|certificate has expired|panic'
date -u
```

- The `exec` request returns 500 at once and the log has no `localhost:9443` x509 line: this article.
- The `exec` request returns 500 and the log shows `localhost:9443` with an x509 error: see [tke-platform-api serves an expired certificate after running for a year on ACP](tke-platform-api_serves_an_expired_certificate_after_running_for_a_year_on_ACP.md).
- `date -u` on `global` or on the node is wrong: fix the clock; this article does not apply.
- The `exec` request returns 200, or 504 after a long wait: a real check timeout; check SSH and network reachability to the node.
- There is no `tke-platform-api` Deployment and `cluster-api-provider-alauda` runs instead: this article does not apply; node addition is managed by `cluster-api-provider-alauda`.
