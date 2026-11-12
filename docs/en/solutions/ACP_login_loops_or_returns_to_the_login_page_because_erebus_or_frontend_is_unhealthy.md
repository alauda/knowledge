---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.2"
---

# ACP login loops or returns to the login page because erebus or frontend is unhealthy

## Issue

After the username and password are accepted, the browser returns to the login page, or it bounces between the platform and the SSO page until login fails. Every account is affected, local and LDAP alike, and the platform cannot be accessed at all. It often happens on the first morning of the work week. The frontend log names the global erebus API as abnormal, typically with:

```text
oidc verify token from acp ... "error": "failed to send request: Get \"https://erebus/kubernetes/global/api\": dial tcp <erebus-cluster-ip>:443: connect: cannot assign requested address"
http: superfluous response.WriteHeader call from .../alauda-backend/pkg/server/options.(*ResponseWriterDelegator).WriteHeader (metrics.go:319)
```

Related articles: "ACP login shows an internal error from a bad Dex cache, or the standby global cluster cannot log in" covers an internal error on the login page and standby clusters. An `invalid authorization code` or `Unregistered redirect_uri` page is a different failure.

## Root Cause

### Cause 1: erebus is unhealthy and the console cannot finish login

The erebus log reports that it cannot find cluster-related information, or the erebus Pod is otherwise abnormal, and the frontend log says the global erebus API is unhealthy. Restarting the erebus Pod restores login.

A variant: erebus keeps looking up a cluster that has already been deleted from the platform, and its log repeats `websocket.go:514] Websocket Ping failed: write tcp <archon-pod-ip>:<port>-><erebus-cluster-ip>:443: write: connection timed out` together with `handler.go:66] Handle request error: client rate limiter Wait returned an error: context canceled`. The source address belongs to the `archon` Pod in `cpaas-system`. Apollo looks healthy, and restarting Apollo does not help. erebus appears to hang while retrying the deleted cluster; the exact mechanism is not confirmed. Restarting erebus restores login for all users as a temporary workaround.

### Cause 2: local ports are exhausted for the connections to erebus

Login fails, and the erebus log says no port is available because short-lived TCP connections are exhausted. The frontend log shows the `connect: cannot assign requested address` line from the Issue section, and the erebus log is a continuous stream of `proxy.go:150] Generate new reverse proxy for: 600:https://<cluster-address>:6443` mixed with `log.go:245] http: proxy error: context canceled` and `timeout.go:142] post-timeout activity` for GET requests such as `/api/v1/namespaces/cpaas-system/configmaps`. Restarting both frontend and erebus restores login.

A related trace, before a restart, shows erebus logging `asyncopy.go:16] async copy data error: read tcp <erebus-pod>:9443-><archon-pod>:<port>: read: connection reset by peer`, and the `archon-api` container of the `archon` Pod logging `websocket.go:500] Websocket Ping failed: write tcp <archon-pod>:<port>-><erebus-service>:443: write: connection timed out`. The Service still lists the erebus Pod as an endpoint, but the Pod is not reading. Another Pod on the same node that leaks connections can exhaust the node's ephemeral ports. One candidate is courier-api: when Operations Center log queries fail with `dial tcp <es-address>:9200: connect: cannot assign requested address`, the courier-api network namespace can hold tens of thousands of established connections to the Elasticsearch endpoint on port 9200. This link was not proven, so collect evidence before restarting if it happens again.

Clusters removed only from the platform UI can keep printing errors such as `cluster.go:284] cluster: failed to get cluster "<name>" resource. err: clusters.clusterregistry.k8s.io "<name>" not found` and `proxy.go:128] Resolve cluster <name> error: ... not found`. Deleting a cluster in the UI drops platform management of that cluster and leaves its components in place.

### Cause 3: a frontend socket leak turns a CAS retry loop into a dead console

When the CAS session is not logged in, platform login retries on its own, over and over, and after enough retries the console stops accepting logins. ALB entries for console APIs point at frontend, and frontend logs that it cannot connect to erebus, with the `connect: cannot assign requested address` and `superfluous response.WriteHeader` lines. Yet the `erebus` Service in `cpaas-system` (ports `443/TCP,6060/TCP`) has both Pods `1/1 Running` with no restarts, and `curl` to erebus succeeds. The cause is a socket leak in frontend, seen on v3.18.2. Restarting frontend restores login. A product fix is expected in a version after 4.4.

## Resolution

### Cause 1: erebus is unhealthy and the console cannot finish login

1. Confirm that local and LDAP logins fail the same way and that erebus is the abnormal component:

   ```bash
   kubectl get deploy,po -n cpaas-system | grep -i erebus
   kubectl logs -n cpaas-system <erebus-pod> --tail=200 | grep -E 'Websocket Ping failed|rate limiter|not found'
   kubectl get pods -A -o wide | grep <source-ip-from-erebus-log>
   kubectl get svc -A | grep <target-ip-from-erebus-log>
   ```

2. Restart erebus.

   > **Warning:** Restarting erebus drops console calls that go through that API until the new Pod is Ready. Precondition: only when this cause is confirmed. The restart does not change configuration. Rollback: wait for the new Pod; there is no object to restore.

   ```bash
   kubectl -n cpaas-system rollout restart deploy/<erebus-deploy>
   kubectl -n cpaas-system rollout status deploy/<erebus-deploy>
   ```

3. Retry a local user and an LDAP user. When erebus was retrying a deleted cluster, also remove the leftover components of that cluster (see Cause 2), because the restart is only a temporary workaround.

### Cause 2: local ports are exhausted for the connections to erebus

1. Confirm the port or timeout signature. If the outage is still in progress, collect the logs before restarting anything:

   ```bash
   kubectl get deploy,po -A | grep -Ei 'erebus|archon|courier-api'
   kubectl logs -n cpaas-system <erebus-pod> --tail=200 | grep -E 'connection reset by peer|no port|Generate new reverse proxy|post-timeout'
   kubectl logs -n cpaas-system <archon-pod> -c archon-api --tail=200 | grep -F 'connection timed out'
   ```

2. To see which Pod is exhausting ports, count its connections inside its network namespace on the node where it runs (the example uses courier-api; the same commands work for frontend or erebus):

   ```bash
   crictl ps -a | grep courier
   crictl inspect <container-id> | grep -m1 '"pid"'
   nsenter -n -t <pid> ss -s
   nsenter -n -t <pid> ss -ant | grep '<es-address>:9200' | grep -c ESTAB
   cat /proc/sys/net/ipv4/ip_local_port_range
   ```

   Tens of thousands of `ESTAB` connections to one endpoint, close to the size of `ip_local_port_range`, mean that Pod has used up the ephemeral ports.

3. Restart erebus, and frontend when the log says no port is available.

   > **Warning:** Restarting erebus and frontend interrupts login for the length of the rollout. Precondition: only when the port-exhaustion or erebus/archon timeout lines above are present. Rollback: none beyond the new Pods becoming Ready.

   ```bash
   kubectl -n cpaas-system rollout restart deploy/<erebus-deploy>
   kubectl -n cpaas-system rollout restart deploy/frontend
   ```

4. When clusters deleted in the UI are still emitting `clusters.clusterregistry.k8s.io "<name>" not found` errors, remove the platform components that remain on the deleted cluster by following the product procedure for removing a cluster, then restart courier-api on the global cluster. Restarting courier-api drops notification and related API calls until the new Pod is Ready.

### Cause 3: a frontend socket leak turns a CAS retry loop into a dead console

1. Confirm that frontend cannot reach erebus while erebus itself is healthy:

   ```bash
   kubectl logs -n cpaas-system deploy/frontend --tail=200 | grep -E 'cannot assign requested address|superfluous'
   kubectl get pods -n cpaas-system | grep erebus
   curl -k -sS -o /dev/null -w '%{http_code}\n' https://<erebus-cluster-ip>/
   ```

2. Restart frontend, not erebus.

   > **Warning:** Restarting `cpaas-system/frontend` makes the console unavailable until the rollout finishes; business workloads are not restarted. Precondition: only when this cause is confirmed. Rollback: wait for the rollout. The leak can return until the product fix is installed.

   ```bash
   kubectl -n cpaas-system rollout restart deploy/frontend
   kubectl -n cpaas-system rollout status deploy/frontend
   ```

## Diagnostic Steps

```bash
kubectl get deploy,po -n cpaas-system | grep -Ei 'erebus|frontend|apollo|archon|courier'
kubectl logs -n cpaas-system deploy/frontend --tail=80
```

- Redirect loop or return to the login page for both local and LDAP users; erebus cannot find cluster information, retries a deleted cluster with `Websocket Ping failed ... connection timed out`, or its Pod is abnormal: Cause 1.
- erebus says no port is available or streams `Generate new reverse proxy for`, or erebus and archon log connection resets and write timeouts: Cause 2. Collect logs and `ss -s` output before restarting if the fault is still happening.
- CAS retries for a long time, frontend logs `cannot assign requested address` toward erebus, the erebus Pods are healthy, and `curl` to erebus works: Cause 3. Restart frontend.
- `kubectl get cls` on the global cluster shows a cluster abnormal: check whether the cluster kubeconfig Secrets have expired before restarting erebus or frontend.
