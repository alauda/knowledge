---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# tke-platform-api serves an expired certificate after running for a year on ACP

## Issue

On the global cluster, operations that go through the platform API stop working while the cluster itself looks healthy, and neither the platform access certificate nor the Kubernetes certificates have expired. Each case shows an x509, TLS handshake, or port 9443 error in the `tke-platform-api` log, in a caller's log, in the API response, or on the login page:

- A cluster plugin (for example NFS) deployed from the cluster plugin page stays in "Deploying" forever, although the plugin works on the nodes. On the business cluster the plugin AppRelease is `Synced` and `Ready`; on global, `kubectl get minfo -A | grep <plugin-name>` shows that cluster's minfo stuck at `Processing`.
- Adding a node is stuck at "check timeout" although the node's network and ports are reachable, and `tke-platform-api` logs `http: TLS handshake error from ...: remote error: tls: bad certificate`.
- Adding a node returns `检查超时，请重试` ("check timed out, please retry") at once, while the dialog still shows `节点可用性检查中...` ("node availability check in progress"). In the browser developer tools, `POST /apis/platform.tkestack.io/v1/clusters/<cluster>/exec?ignore_warning=true` returns `500 Internal Server Error`, and the `tke-platform-api` log shows x509 errors for calls to `https://localhost:9443/apis/platform.tkestack.io/v1/...`.
- Creating a business cluster fails with `error trying to reach service: stream error: stream ID <n>; INTERNAL_ERROR; received from peer`.
- Adding a node or evicting containers fails with `x509: certificate has expired or is not yet valid: current time <now> is after <date>`.
- Changing a cluster's display name fails. The `PATCH` to `/apis/platform.tkestack.io/v1/clusters/<cluster>` returns `422` (`reason: Invalid`) with `Internal error: get cluster's credential error: Get "https://localhost:9443/apis/platform.tkestack.io/v1/clustercredentials/<cc-name>": x509: certificate has expired or is not yet valid`.
- The login page reports an expired certificate and nobody can log in. It shows `ErrCreateAuthReq` with `Get ".../api/v1/namespaces/cpaas-system/resourcequotas": x509: certificate has expired or is not yet valid: current time <now> is after <notAfter>`.

`tke-platform-api` and `tke-platform-controller` run on the `global` cluster in `cpaas-system`. On some `global` clusters (for example on ACP 4.2) there is no `tke-platform-api` Pod, and `cluster-api-provider-alauda` manages node addition instead; check which one yours runs with `kubectl get deploy -A | grep -E 'tke-platform|cluster-api-provider-alauda'`.

## Root Cause

### Cause 1: the tke-platform-api Pod has been running for more than a year and its in-Pod certificate expired

The certificate used inside the `tke-platform-api` Pod is valid for one year. A Pod that has run longer than that serves an expired certificate, and callers of `tke-platform-api` on port 9443 fail. For a stuck plugin, `cluster-transformer` on global logs errors against port 9443 while the plugin's minfo stays `Processing`; forcing a reconcile of the ARS does not help, because the call to `tke-platform-api` is the part that fails. For a stuck node addition, `tke-platform-api` logs `tls: bad certificate` handshake errors from a local client, along with `http2: stream closed`.

The process uses that certificate for its own calls to `localhost:9443`, and neither of the following log lines names the certificate. The Pod age is a guide, not a threshold: a Pod that has run for about 300 days can already fail this way. When the add-node `exec` request returns 500, the log repeats for the cluster being added to:

```text
apiserver received an error that is not an metav1.Status: &url.Error{Op:"Get", URL:"https://localhost:9443/apis/platform.tkestack.io/v1/clusters/<cluster>", Err:x509.CertificateInvalidError{... Reason:1, Detail:"current time <now> is after <expiry>"}}
```

When a business cluster is created, the create path panics in `(*Strategy).PrepareForCreate` (`pkg/platform/registry/cluster/strategy.go`):

```text
apiserver panic'd on POST /apis/platform.tkestack.io/v1/clusters
get cluster's credential error: Get "https://localhost:9443/apis/platform.tkestack.io/v1/clustercredentials?fieldSelector=clusterName%3D...": x509: certificate has expired or is not yet valid: current time <now> is after <expiry>
```

Restarting `tke-platform-api` loads a valid certificate, after which the plugin deploys, the node is added, and the cluster is created.

### Cause 2: on 3.12, tke-platform-api logs x509: certificate has expired on node add or eviction

On ACP 3.12 (TKE-based), `tke-platform-api` reports `x509: certificate has expired or is not yet valid: current time ... is after ...` when nodes are added or containers are evicted. This is a known component bug of 3.12, fixed in later versions. Restarting `tke-platform-api` and `tke-platform-controller` restores the functions; the error line can still appear in the `tke-platform-controller` log afterwards. Log lines such as `attempting to acquire leader lease /tke-platform-controller` and `lock is held by tke-platform-controller-... and has not yet expired` are normal with two replicas, because the other Pod holds the leader lease.

### Cause 3: the login page shows an expired certificate managed by tke-platform-api and dex

The certificate behind the login page's `ErrCreateAuthReq` error is managed jointly by `tke-platform-api` and `dex`. When it has expired, users cannot log in. Restarting both components restores the login page.

### Cause 4: updating a cluster fails with get cluster's credential error and x509 against localhost:9443

The platform fetches the cluster credential (`clustercredentials`) from `https://localhost:9443`. `tke-platform-api` caches the certificate it uses there, so after that certificate expires it keeps using the expired one, and every cluster update that needs the credential fails with `422`. Restarting `tke-platform-api` restores the call.

## Resolution

### Cause 1: the tke-platform-api Pod has been running for more than a year and its in-Pod certificate expired

1. Check the Pod age and the logs, and confirm that the platform access certificate is valid and the clock on `global` is correct:

   ```bash
   kubectl get pods -A -o wide | grep tke-platform-api
   kubectl logs -n <namespace> <tke-platform-api-pod> --tail=200 | grep -i -E 'tls|x509|handshake'
   kubectl -n cpaas-system logs deploy/tke-platform-api --tail=500 | grep -E 'localhost:9443|CertificateInvalidError|certificate has expired|panic'
   echo | openssl s_client -connect <global-vip>:443 2>/dev/null | openssl x509 -noout -dates
   date -u
   kubectl get pods -A | grep cluster-transformer
   kubectl logs -n <namespace> <cluster-transformer-pod> --tail=200 | grep 9443
   kubectl get minfo -A | grep <plugin-name>
   ```

   Continue when the `tke-platform-api` Pod has run for a long time (about a year, sometimes less) and the logs show port 9443 or `localhost:9443` x509 errors or `tls: bad certificate` handshake errors, while the platform access certificate's `notAfter` is still in the future and `date -u` is correct.

2. Restart `tke-platform-api`.

   > **Warning:** Deleting the `tke-platform-api` Pod interrupts the platform API calls that Pod handles until its replacement is Running; plugin deployment, cluster and node management for every cluster, and console actions that use it fail in the gap. Running workloads are not affected. Do this only when step 1 confirmed the signature and the clock on `global` is correct (an x509 time error can also come from a wrong clock). With several replicas, delete one Pod at a time and wait for it to be `Running` before the next. The workload recreates the Pod; there is nothing else to roll back.

   ```bash
   kubectl delete pod -n <namespace> <tke-platform-api-pod>
   kubectl get pods -n <namespace> | grep tke-platform-api
   ```

   A rolling restart of the Deployment is equivalent:

   ```bash
   kubectl -n cpaas-system rollout restart deployment/tke-platform-api
   kubectl -n cpaas-system rollout status deployment/tke-platform-api
   ```

3. Retry the operation (plugin deployment, node addition, or cluster creation). For a plugin, watch its ARS and the Pods:

   ```bash
   kubectl get ars -A | grep <plugin-name>
   kubectl get pods -A | grep -vi running
   ```

### Cause 2: on 3.12, tke-platform-api logs x509: certificate has expired on node add or eviction

1. Restart `tke-platform-api` with step 2 of Cause 1 and its Warning.
2. Restart `tke-platform-controller` the same way, one Pod at a time.

   > **Warning:** Deleting a `tke-platform-controller` Pod pauses the reconciliation that Pod leads until the other replica takes the lease or the new Pod starts. The workload recreates the Pod.

   ```bash
   kubectl get pods -A | grep tke-platform-controller
   kubectl delete pod -n <namespace> <tke-platform-controller-pod>
   kubectl logs -n <namespace> <tke-platform-controller-pod> --tail=50
   ```

3. Check that adding a node or evicting a container works. Upgrade to a later version to remove the bug.

### Cause 3: the login page shows an expired certificate managed by tke-platform-api and dex

1. Restart `tke-platform-api` with step 2 of Cause 1.
2. Restart `dex`.

   > **Warning:** Deleting the `dex` Pod interrupts login to the platform until the new Pod is Running. Do this only when the login page reports the expired certificate. The workload recreates the Pod.

   ```bash
   kubectl get pods -A | grep dex
   kubectl delete pod -n <namespace> <dex-pod>
   ```

3. If the login page still shows an expired certificate, compare the served certificate with the platform access certificate, as described in "Replace the platform access certificate in dex.tls on ACP".

### Cause 4: updating a cluster fails with get cluster's credential error and x509 against localhost:9443

1. Confirm that the error names `localhost:9443` and `clustercredentials`:

   ```bash
   kubectl get pods -A | grep tke-platform-api
   kubectl logs -n <namespace> <tke-platform-api-pod> --tail=200 | grep -i -E 'x509|clustercredentials'
   ```

2. Restart `tke-platform-api` with step 2 of Cause 1, one Pod at a time. For this cause the precondition is the error above, not the Pod age.
3. Retry the cluster edit.

## Diagnostic Steps

1. Note the Pod age of the platform API components, search the `tke-platform-api` log for the `localhost:9443` signature, and check the clock:

   ```bash
   kubectl get pods -A | grep -E 'tke-platform-api|tke-platform-controller|dex'
   kubectl -n cpaas-system logs deploy/tke-platform-api --tail=500 | grep -E 'localhost:9443|CertificateInvalidError|certificate has expired|panic'
   date -u
   ```

2. Find who is failing and against which port: a stuck plugin's ARS and the `cluster-transformer` log, or the `tke-platform-api` log when node addition times out.

   ```bash
   kubectl get ars -A
   kubectl describe ars -n <namespace> <ars-name>
   ```

3. Branch:

   - Pod older than a year, errors to port 9443, `tls: bad certificate` handshake failures, or a plugin minfo stuck at `Processing` while its AppRelease is `Ready`: Cause 1.
   - The add-node `exec` request returns 500 at once in the browser developer tools and the log shows `localhost:9443` with an x509 error, or a cluster create fails with `INTERNAL_ERROR` and the `PrepareForCreate` panic: Cause 1.
   - `date -u` on `global` or on the node is wrong: fix the clock; this article does not apply.
   - The add-node `exec` request returns 500 and the log has no `localhost:9443` x509 line: see "Node add check times out immediately because the cluster exec API returns HTTP 500 on ACP".
   - The `exec` request returns 200, or 504 after a long wait: a real check timeout; check SSH and network reachability to the node.
   - ACP 3.12 and `current time ... is after ...` on node add or eviction: Cause 2.
   - Login page shows `ErrCreateAuthReq` with `x509: certificate has expired or is not yet valid`: Cause 3.
   - A cluster update returns `422` with `get cluster's credential error` and x509 against `https://localhost:9443/.../clustercredentials/...`: Cause 4.
   - The same `get cluster's credential error ... localhost:9443 ... x509: certificate has expired` text after a finalizer was removed from a cluster stuck in `Terminating` whose `ClusterCredential` is missing: not this article; recreate the credential.
   - The platform cannot be opened at all, every component is Running, and no log or page shows an x509, handshake, or port 9443 error: not this article. When the cluster VIP is a domain name, see "Platform console does not open because the cluster VIP domain name cannot be resolved inside the cluster on ACP".
