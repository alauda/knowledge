---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Console is slow or shows data loading errors because calls through erebus or the marketplace backends are slow on ACP

## Issue

The platform is slow and data on the pages takes more than a minute to appear, or a data loading error keeps appearing and clears when the user clicks **Reload**. Related reports:

- OperatorHub, the cluster plugin page (`集群插件`), and Tekton pages all fail to open at the same time.
- Every page is slow, with occasional no-permission errors and 502.
- The left navigation menu takes a long time to load.
- In the browser developer tools the `envs` API or other calls that go through `erebus` time out.

`erebus` is the console backend in `cpaas-system` on the `global` cluster that proxies calls toward a target cluster, so a slow path through it makes many pages slow at once.

Start by timing the slow request from a host inside the platform network, so that a slow client path, such as a VPN, is ruled out before any platform change.

## Root Cause

### Cause 1: the user's network path is slow while the platform is healthy

Every page takes more than a minute for the user, but the same requests answer quickly from inside the platform network. The delay is on the client path, for example the VPN the user goes through to reach the platform, and no platform component is at fault.

### Cause 2: the envs API to erebus times out and the erebus log has no error

Browser tools show the `envs` API to `erebus` timing out, and the `erebus` Pod log on the `global` cluster has no clear exception. Restarting the `erebus` Pod restores the connection; no more specific fault was identified.

### Cause 3: a data loading error clears on reload and erebus logs context canceled

`erebus` logs `context canceled`, and the path from the node that runs `erebus` to the platform VIP answers normally. The failed call is the client connection dropping; after the client connects again, loading succeeds. No change is needed.

### Cause 4: a Layer-4 load balancer with an X-Forwarded-For profile on port 6443 delays calls through erebus

Any page can be slow, intermittently but often; some show a no-permission error and some requests return 502 from `erebus`. No container is abnormal, and `kubectl` on a workload-cluster master answers quickly while the UI is slow. A normal request takes seconds instead of milliseconds during problem periods.

The path client > global VIP > `erebus` > workload-cluster VIP > API server reproduces the delay; the path client > workload-cluster VIP > API server does not, nor does a direct `curl` from the global nodes to the workload API server. Captures on the global nodes show many TCP retransmissions toward the workload-cluster VIP on 6443, and the load balancer capture shows retransmissions, port-reuse warnings, and duplicate ACKs ending in an RST from the client side. The F5 virtual server for API server port 6443 is a Performance (Layer 4) server with the `fastL4` profile, and its HTTP Client profile is set to `X-Forwarded-For`. After XFF was disabled on that virtual server, the problem no longer reproduced; the exact mechanism is not confirmed. Host and VM NIC queue tuning improves stability somewhat but does not remove the delay.

### Cause 5: a decommissioned cluster is still registered

The left navigation menu loads very slowly. A cluster that was decommissioned is still registered on the platform, and platform components keep trying to reach its VIP.

### Cause 6: marketplace-apiserver is killed before its cache finishes loading

OperatorHub, the cluster plugin page, and Tekton and other product pages fail at the same time, and `marketplace-apiserver` keeps restarting. On a cluster with a large number of CRDs or APIServices, `marketplace-apiserver` does not finish loading its cache before the liveness probe fails, so the Pod is restarted before it ever becomes healthy. Raising `livenessProbe.initialDelaySeconds` to `180` restores the service.

## Resolution

### Cause 1: the user's network path is slow while the platform is healthy

1. In the browser developer tools (**Network**), right-click the slow request and choose **Copy as cURL**.
2. Run it from the user's machine and from a host inside the platform network (for example a `global` control-plane node or a jump host), with timing output appended:

   ```bash
   curl -k -s -o /dev/null -w 'connect=%{time_connect}s first-byte=%{time_starttransfer}s total=%{time_total}s\n' https://<platform-address>/
   ```

3. A fast answer inside the network and tens of seconds from the user's machine places the delay on the client path. A long **Initial connection** or **Content download** phase in the browser **Timing** tab points the same way. Hand the path to the team that runs it; no platform change is needed.

### Cause 2: the envs API to erebus times out and the erebus log has no error

1. Read the `erebus` log before deleting the Pod:

   ```bash
   kubectl get pods -n cpaas-system --no-headers | awk '/^erebus-/ {print}'
   kubectl logs -n cpaas-system <erebus-pod> --tail=200
   ```

2. Restart `erebus`.

   > **Warning:** Console calls proxied by `erebus` fail until the new Pod is `Ready`. Do this only when the `envs` API to `erebus` times out and the log shows no separate fault such as clock skew, an expired platform credential, or a down business API server. The Pod is recreated from the same spec.

   ```bash
   kubectl delete pod -n cpaas-system <erebus-pod>
   ```

3. If the `envs` API still times out after the new Pod is `Running`, the fault is elsewhere.

### Cause 3: a data loading error clears on reload and erebus logs context canceled

Confirm the log and reload the page so that the client opens a new connection:

```bash
kubectl logs -n cpaas-system <erebus-pod> --tail=200 | grep -F 'context canceled'
```

If the platform VIP does not answer from the node that runs `erebus`, the problem is reachability, not this cause.

### Cause 4: a Layer-4 load balancer with an X-Forwarded-For profile on port 6443 delays calls through erebus

1. From each `global` node, time the workload API server through its VIP, then reproduce the slow page and compare:

   ```bash
   time curl -k -s -o /dev/null -w '%{http_code}\n' https://<workload-vip>:6443/readyz
   kubectl get pods -n cpaas-system -o wide | grep erebus
   ```

2. On the `global` node that runs `erebus`, capture traffic toward the workload-cluster VIP while the problem reproduces:

   ```bash
   tcpdump -i any -nn host <workload-vip> and port 6443 -w /tmp/erebus-6443.pcap
   ```

   Retransmissions, port-reuse warnings, and duplicate ACKs that end in a client-side RST, only on the path through the load balancer, match this cause.

3. On the load balancer, open the virtual server that publishes 6443 and disable the `X-Forwarded-For` HTTP Client profile.

   > **Warning:** Changing the virtual server profile affects every connection through it, not only ACP. Do this only when the virtual server is Layer 4 (`fastL4`) for API server port 6443, its HTTP Client profile is `X-Forwarded-For`, and the captures show the retransmissions above. Use a change window with the network team. To roll back, set the profile back.

4. Watch whether the slow requests, no-permission errors, and 502 return.

### Cause 5: a decommissioned cluster is still registered

1. List the clusters the platform knows about and test each VIP from a `global` node:

   ```bash
   kubectl get cls -A
   curl -k --max-time 5 https://<cluster-vip>:6443/readyz
   ```

2. Delete the decommissioned cluster from the platform cluster list.

   > **Warning:** Removing a cluster from the platform ends its management from the console, and it cannot be undone from the cluster list; to manage it again it must be added back. Do this only for a cluster that is decommissioned and whose VIP no longer answers.

3. The left navigation loads normally once components stop retrying that VIP.

### Cause 6: marketplace-apiserver is killed before its cache finishes loading

1. Check whether the Pod is restarted by its liveness probe:

   ```bash
   kubectl get deploy -A | grep marketplace-apiserver
   kubectl describe pod -n <namespace> <marketplace-apiserver-pod> | grep -E 'Restart Count|Last State|Liveness|Unhealthy|Killing'
   kubectl logs -n <namespace> <marketplace-apiserver-pod> --previous --tail=200
   kubectl get crd --no-headers | wc -l
   kubectl get apiservice --no-headers | wc -l
   kubectl get deploy -n <namespace> marketplace-apiserver -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.livenessProbe}{"\n"}{end}'
   ```

   The signature is a growing restart count with `Liveness probe failed` events while the previous log shows the server still starting, on a cluster with many CRDs or APIServices. A Pod that crashes on its own error before the probe fires is not this cause.

2. Export the Deployment and raise the initial delay of the liveness probe.

   > **Warning:** The patch rolls the Pod, so OperatorHub, cluster plugin, and Tekton pages stay unavailable until it is `Ready`. A longer initial delay also means a process that really hangs at startup is restarted later. To roll back, patch `initialDelaySeconds` back to the value in the export. This change can be reverted by a platform or plugin upgrade; check it again afterwards.

   ```bash
   kubectl get deploy -n <namespace> marketplace-apiserver -o yaml > /tmp/marketplace-apiserver.bak.yaml
   kubectl patch deploy -n <namespace> marketplace-apiserver --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/livenessProbe/initialDelaySeconds","value":180}]'
   kubectl rollout status deploy -n <namespace> marketplace-apiserver
   ```

   The path uses container index `0`; if the `jsonpath` output lists the probe on another container, use that index.

3. Once the Pod stays `Running` without liveness restarts, open OperatorHub, the cluster plugin page, and a Tekton page again.

## Diagnostic Steps

1. In the browser **Network** panel, note whether the failing call is the `envs` API or another call proxied by `erebus`, and whether it times out or returns 500. Time the same call from inside the platform network (Cause 1); if only the user's side is slow, stop there.

2. Read the `erebus` and `apollo` logs on the `global` cluster:

   ```bash
   kubectl get pods -n cpaas-system -o wide | grep -E 'erebus|apollo'
   kubectl logs -n cpaas-system <erebus-pod> --since=30m --tail=200
   kubectl logs -n cpaas-system <apollo-pod> --since=30m --tail=200 | grep -i erebus
   ```

3. Match the result:

   ```text
   every page over a minute from the user's side, same call fast inside the network -> Cause 1
   envs API timeout, erebus log has no error                                       -> Cause 2
   data loading error, reload works, erebus logs context canceled                  -> Cause 3
   all pages slow, 502 from erebus, retransmissions through the load balancer on 6443 -> Cause 4
   left menu slow, a decommissioned cluster still listed                           -> Cause 5
   OperatorHub, cluster plugins and Tekton fail together, marketplace-apiserver liveness restarts -> Cause 6
   ```

4. If the problem started right after a change on the hosts (DNS, NetworkManager, CNI, kernel parameters), see [Console returns 500 or data loading errors after a host network change on ACP](Console_returns_500_or_data_loading_errors_after_a_host_network_change_on_ACP.md).
