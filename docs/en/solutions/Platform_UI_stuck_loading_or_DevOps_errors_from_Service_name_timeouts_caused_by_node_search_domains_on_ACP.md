---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
  - Alauda DevOps
ProductsVersion:
  - 4.3.x
---

# Platform UI stuck loading or DevOps errors from Service name timeouts caused by node search domains on ACP

## Issue

The platform opens slowly or not at all, while the platform Pods all look `Running`. Typical reports:

- After login, the page keeps loading and never enters the platform. In browser developer tools, `GET /console/api/v1/envs` returns `500 Internal Server Error` with:

  ```text
  {"status": "Failure", "message": "failed to reach validation endpoint: Get \"https://erebus.cpaas-system.svc.cluster.local/kubernetes/global/api\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)", "reason": "InternalError", "code": 500}
  ```

  The `erebus` Pod is `Running` and its log shows only `Starting https proxy server on: :9443` and repeated `Generate new reverse proxy for: ...` lines.
- The platform cannot be opened right after a 4.3 deployment. Requests to `erebus` time out, and the `apollo` log shows connection timeouts to `erebus` or failures resolving a Service.
- The global `apollo` log repeats `List clusters error, sleep 15s`, `Get cluster resource error`, `List log-agent feature error` or `Use global as log-center cluster is empty`, with requests to `https://kubernetes.default.svc.cluster.local/...` or `https://erebus.cpaas-system.svc.cluster.local/...` failing with `net/http: request canceled while waiting for connection (Client.Timeout exceeded while awaiting headers)` or `context deadline exceeded`.
- Platform access is very slow, and the image selection list loads for a long time or shows nothing when creating a Deployment.
- The DevOps UI shows an error, or GitLab or Harbor integration fails, with `dial tcp: lookup katanomi-plugin.cpaas-system.svc.cluster.local: i/o timeout` (or the same for `katanomi-plugin.katanomi-operator.svc.cluster.local`) in a `500` `InternalError` response. When integrating an external GitLab, the name that fails is the in-cluster `katanomi-plugin` Service, not the GitLab host.
- The image repository dropdown keeps loading for one project; the request `repositories?itemsPerPage=100&page=1` returns `500`.
- On a business cluster, `alertmanager` fails to start and nothing listens on `9093`.
- Every page takes more than a minute to display data, with no specific error.

Restarting `erebus`, `apollo` or every Pod in `cpaas-system` alone changes nothing.

## Root Cause

### Cause 1: extra search domains in the node /etc/resolv.conf

For Pods with `dnsPolicy: ClusterFirst`, the kubelet appends the node `search` domains to the Pod search list after the cluster suffixes, with `options ndots:5`. A name such as `erebus.cpaas-system.svc.cluster.local` has four dots, so the resolver tries it with every search suffix before the absolute name. Site suffixes (for example `localdomain` or `novalocal`, often written by NetworkManager) are not cluster zones, so CoreDNS forwards those tries to the upstream resolver. When that resolver is slow or drops them, each try waits for its timeout, the calling component's own deadline expires first, and the error looks like an `erebus` or Service failure. The CoreDNS log shows it directly:

```text
[ERROR] plugin/errors: 2 erebus.cpaas-system.svc.cluster.local.localdomain. A: read udp <coredns-pod-ip>:<port>-><upstream>:53: i/o timeout
```

A container's `/etc/resolv.conf` is written when the Pod is created. Fixing or rebooting the node does not change running Pods; they keep the old search list until they are recreated. That is why restarting containers or the host alone does not help.

This cause covers the login page that keeps loading, the 4.3 platform that does not open, the slow image selection page, the DevOps UI error, the `katanomi-plugin` timeouts during GitLab integration, and the `alertmanager` that does not start. For comparison, a healthy node has no `search` line, for example a single nameserver with `options timeout:1` and `options single-request-reopen`.

### Cause 2: an in-cluster name is still forwarded upstream after the node fix

After the node `search` conflict is fixed and the Pods are recreated, component logs can still report resolution timeouts for `katanomi-plugin.cpaas-system`. The Pods use `ClusterFirst` and no host network, and manual lookups from the container succeed, but the CoreDNS log shows the name being forwarded to the external upstream and timing out, so the `kubernetes` plugin is not answering it. Why it is forwarded was not determined. A static CoreDNS hosts record that maps `katanomi-plugin.cpaas-system` to its Service ClusterIP stops the timeouts, the external forwarding and the UI errors.

### Cause 3: katanomi-controller CPU saturation makes the image dropdown time out

The image dropdown fails for one project only, with `dial tcp: lookup katanomi-plugin.cpaas-system.svc.cluster.local: i/o timeout`, while `katanomi-api`, `katanomi-controller`, `katanomi-plugin` and `katanomi-operator` are all `1/1 Running` and the Harbor instance is associated with the project. Along the path:

- the `nginx` container log of the `global-alb2` Pod shows `repositories?itemsPerPage=100&page=N` requests to `katanomi-api` returning `500` after about 10 to 16 seconds, and one `499`, while other pages return `200` in 1 to 2 seconds;
- the `katanomi-api` log shows `"list integrationclass error"` when calling `erebus`.

A large number of concurrent repository requests drives `katanomi-controller` to its CPU limit, and the UI requests behind the dropdown time out under that load. Raising the controller CPU to 2 cores makes the service stable.

### Cause 4: the image list is empty when creating a Deployment and a CoreDNS restart restores it

The image list is not displayed when creating a Deployment, and nothing else is found. Restarting CoreDNS on the cluster brings the list back; the reason was not identified.

### Cause 5: the whole platform is slow because of the users' VPN path

Every page loads slowly and data takes more than a minute to show, with no failing request. When the delay follows the users' VPN path, the platform is not at fault, and the fix belongs to whoever runs the VPN.

## Resolution

### Cause 1: extra search domains in the node /etc/resolv.conf

Only when the node `/etc/resolv.conf` has a `search` (or `domain`) line with site suffixes and the platform errors are Service-name timeouts.

1. Comment out the extra `search` entries on every node of the affected cluster (global and workload clusters, if both have them). Keep the `nameserver` lines. If NetworkManager or DHCP writes the file, remove the search domains at that source as well, or the next restart puts them back.

   > **Warning:** Removing the node search domains changes how host processes resolve short names; anything on the host that relied on a site suffix must use full names afterwards. Back up the file on each node. To roll back, restore the backup and recreate the Pods again.

   ```bash
   cp -a /etc/resolv.conf /root/resolv.conf.before
   grep -nE '^(search|domain)' /etc/resolv.conf
   sed -i -E 's/^(search|domain)([[:space:]])/# \1\2/' /etc/resolv.conf
   cat /etc/resolv.conf
   ```

2. Recreate the Pods so that the kubelet writes a new Pod `/etc/resolv.conf`. The smallest set that recovers the platform is CoreDNS plus `apollo`, `erebus`, the frontend and the katanomi Pods; recreating every Pod in `cpaas-system` also works.

   > **Warning:** Deleting these Pods makes the console and DevOps functions unavailable until the replacements are Ready, and a CoreDNS restart briefly delays lookups. Fix the node files first. No rollback is needed; the controllers recreate the Pods.

   ```bash
   kubectl -n kube-system rollout restart deploy/coredns
   kubectl -n cpaas-system get pod -o name | grep -E 'apollo|erebus|frontend|katanomi' | xargs kubectl -n cpaas-system delete
   ```

3. Recreate business Pods that show the same timeouts (for example a business-cluster `alertmanager`) the same way. Then confirm a platform Pod has no site suffix:

   ```bash
   kubectl -n cpaas-system exec deploy/apollo -- cat /etc/resolv.conf
   ```

### Cause 2: an in-cluster name is still forwarded upstream after the node fix

Only when the CoreDNS log shows `katanomi-plugin.cpaas-system` (or another platform Service name) being forwarded to the upstream after Cause 1 is fixed.

1. Read the Service ClusterIP:

   ```bash
   kubectl -n cpaas-system get svc katanomi-plugin -o jsonpath='{.spec.clusterIP}{"\n"}'
   ```

2. Add a static record `<cluster-ip> katanomi-plugin.cpaas-system` under **Host Alias** in the cluster plugin **Alauda Container Platform Cluster DNS** (**Administrator > Marketplace > Cluster Plugins**), then restart CoreDNS and watch its log. See [CoreDNS Host Alias records do not take effect because a ResourcePatch removes data hosts from cpaas-coredns on ACP](CoreDNS_Host_Alias_records_do_not_take_effect_because_a_ResourcePatch_removes_data_hosts_from_cpaas-coredns_on_ACP.md) if the record does not take effect.

   > **Warning:** A hosts record pins the ClusterIP. If the Service is deleted and recreated with a new ClusterIP, the record keeps answering the old address and the component breaks again. Note that the entry exists so it can be removed later. To roll back, delete the record and restart CoreDNS.

   ```bash
   kubectl -n kube-system rollout restart deploy/coredns
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100 | grep katanomi-plugin
   ```

### Cause 3: katanomi-controller CPU saturation makes the image dropdown time out

Only when `katanomi-controller` CPU sits at its limit while the dropdown fails. Raise the controller CPU to 2 cores in the katanomi instance resource (`katanomi-global`, under **Operators > katanomi-operator** in the console), under `helmValues` `controller.resources`.

> **Warning:** Changing the resources rolls `katanomi-controller`, and DevOps operations pause until it is Ready. Make sure the node has 2 free cores, and save the instance YAML. To roll back, apply the saved YAML.

```bash
kubectl -n cpaas-system top pod | grep katanomi
kubectl api-resources | grep -i katanomi
kubectl get <katanomi-instance-kind> -A | grep katanomi-global
kubectl get <katanomi-instance-kind> <name> -n <namespace> -o yaml > /tmp/katanomi.before.yaml
kubectl edit <katanomi-instance-kind> <name> -n <namespace>
```

```yaml
helmValues:
  controller:
    resources:
      limits:
        cpu: "2"
```

### Cause 4: the image list is empty when creating a Deployment and a CoreDNS restart restores it

Only after the checks for Causes 1 to 3 found nothing. Restart CoreDNS and reload the Deployment creation page.

> **Warning:** A rollout restart replaces the CoreDNS Pods one at a time, so cluster lookups can stall for a moment. Make sure at least two CoreDNS replicas are Ready. No rollback is needed.

```bash
kubectl -n kube-system rollout restart deploy/coredns
kubectl -n kube-system rollout status deploy/coredns
```

### Cause 5: the whole platform is slow because of the users' VPN path

Do not change nodes or Pods for this signature. Time the platform once from a client that goes through the VPN and once from a host that reaches the platform without it (for example a global cluster node), and hand the comparison to the VPN owner:

```bash
curl -sk -o /dev/null -w 'connect=%{time_connect}s tls=%{time_appconnect}s first_byte=%{time_starttransfer}s total=%{time_total}s\n' https://<platform-address>/
```

A large gap in `connect` or `first_byte` between the two, with fast times from the host, places the delay on the VPN path.

## Diagnostic Steps

1. In the browser developer tools, find the request that hangs. A `500` with `failed to reach validation endpoint` on `erebus`, or a timeout on an `erebus` URL, points to name resolution inside the platform Pods. If no request fails and every request is uniformly slow, time the platform from a host that does not use the users' VPN first (Cause 5).

2. Read the node and Pod resolver files. A site suffix in either is Cause 1:

   ```bash
   cat /etc/resolv.conf
   kubectl -n cpaas-system exec deploy/apollo -- cat /etc/resolv.conf
   kubectl -n cpaas-system logs deploy/apollo --tail=100 | grep -iE 'erebus|timeout|resolve'
   ```

3. Time a lookup of the platform Service from inside a platform Pod whose image has `sh` and `nslookup`. Seconds for the name without a trailing dot and milliseconds for the absolute name confirm the search expansion cost:

   ```bash
   kubectl -n cpaas-system exec deploy/apollo -- sh -c 'time nslookup erebus.cpaas-system.svc.cluster.local'
   kubectl -n cpaas-system exec deploy/apollo -- sh -c 'time nslookup erebus.cpaas-system.svc.cluster.local.'
   ```

4. For DevOps errors, check katanomi and its endpoints, then CoreDNS for forwarded platform names (Cause 2) and controller CPU (Cause 3):

   ```bash
   kubectl get pod -A | grep katanomi
   kubectl get ep -A | grep katanomi
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=200 | grep -iE 'cpaas-system|i/o timeout'
   kubectl -n cpaas-system top pod | grep katanomi
   kubectl -n cpaas-system logs <global-alb2-pod> -c nginx | grep 'repositories?itemsPerPage'
   kubectl -n cpaas-system logs deploy/katanomi-api --tail=200 | grep 'list integrationclass error'
   ```

   A CoreDNS log line whose name ends in a site suffix (for example `.localdomain.`) with `i/o timeout` is Cause 1. A platform Service name forwarded upstream with no suffix after the node fix is Cause 2. Slow `500` or `499` answers from `katanomi-api` in the ALB log, with `katanomi-controller` at its CPU limit, is Cause 3.
