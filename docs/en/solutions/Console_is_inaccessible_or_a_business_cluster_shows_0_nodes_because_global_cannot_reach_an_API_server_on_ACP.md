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

# Console is inaccessible or a business cluster shows 0 nodes because global cannot reach an API server on ACP

## Issue

The console worked before, and now one of the following happens:

- A business cluster row shows 0 nodes, 0 containers, and 0 storage (for example after a `global` migration), while `kubectl get nodes` inside the business cluster shows `Ready`.
- The page says the system cannot be accessed (`系统无法访问`), and platform component logs time out against the in-cluster API Service.
- The console is slow, one `apollo` replica is unhealthy, and renewing credentials or restarting `apollo` does not help.
- Login fails while a burst of alerts fires and the control-plane nodes run at 100% CPU.

Related article: [Console returns 502 or does not open after installation or a VIP change on ACP](Console_returns_502_or_does_not_open_after_installation_or_a_VIP_change_on_ACP.md). If only monitoring pages time out on port 11780, see [Monitoring pages return 502 or context deadline exceeded because port 11780 on the cluster VIP is blocked on ACP](Monitoring_pages_return_502_or_context_deadline_exceeded_because_port_11780_on_the_cluster_VIP_is_blocked_on_ACP.md).

## Root Cause

### Cause 1: the global cluster cannot open the business API server on 6443

The cluster's `CheckStatus` is `Failed` with a message such as `Get "https://<business-apiserver>:6443/api/v1/nodes?labelSelector=kubernetes.io%2Fos%3Dlinux&timeout=2m0s": context deadline exceeded`. From the `global` side, TCP to the business VIP on 6443 fails or times out, for example because a switch no longer forwards from `global` to that VIP. The business nodes and containers are not at fault. If the path was restored but the cluster sync controllers were not restarted, the 0 counts can remain.

A failed `global` control-plane node looks similar from the browser: the whole platform is down and `apollo` cannot list API groups for the cluster `global`, because the `global` API endpoint does not answer.

### Cause 2: one control-plane host is abnormal and components lose their API watches

Abnormal platform components repeat client-go errors such as:

```text
watch of *v1.Pod ended with: an error on the server ("unable to decode an event from the watch stream: http2: client connection lost") has prevented the request from succeeding
"Objects listed" error:Get "https://<service-ip>:443/api/v1/pods?resourceVersion=...": dial tcp <service-ip>:443: i/o timeout
```

Restarting the API server does not help. One master host is abnormal, and restarting that host restores the platform. The exact host fault was not identified.

### Cause 3: a global node is NotReady

The UI loads slowly and one `apollo` replica is unhealthy. Regenerating credentials and restarting that Pod do not help, because the node it runs on is `NotReady` or broken (for example after another container runtime was installed on it). Repairing the node restores platform access.

### Cause 4: control-plane nodes run at 100% CPU

The console cannot be logged into, a large set of alerts fires, and two or more control-plane nodes are at 100% CPU, shared between host agent processes and containers. A batch restart of the Pods that burn CPU brings it down, and restarting `apollo` then restores login.

## Resolution

### Cause 1: the global cluster cannot open the business API server on 6443

1. From a `global` node:

   ```bash
   curl -k --max-time 5 https://<business-apiserver>:6443/readyz
   kubectl get cls -A
   kubectl describe cls <cluster-name>
   ```

   `readyz` must succeed before any controller restart helps. Fix the network path, the VIP, or the failed control-plane node first.

2. Once 6443 answers and the console still shows 0 nodes, restart the `global` cluster components whose logs show the `context deadline exceeded` timeouts to that business cluster (the cluster synchronization components). Restarting `cluster-api-provider-alauda-manager` alone may not be enough.

   > **Warning:** Restarting these controllers pauses cluster synchronization; it does not delete clusters. Do not restart them while 6443 is still closed; the new Pods only repeat the timeout.

   ```bash
   for p in $(kubectl get pods -n cpaas-system -o name); do kubectl logs -n cpaas-system "$p" --all-containers --tail=200 2>/dev/null | grep -q "<business-apiserver>:6443.*context deadline exceeded" && echo "$p"; done
   kubectl delete pod -n cpaas-system <pod>
   ```

### Cause 2: one control-plane host is abnormal and components lose their API watches

1. Find the master that is not healthy:

   ```bash
   kubectl get po -A | grep -vi run
   kubectl get nodes -o wide
   kubectl get pods -n kube-system -l component=kube-apiserver -o wide
   kubectl get pods -n kube-system -l component=etcd -o wide
   ```

   On each master:

   ```bash
   uptime
   dmesg -T | tail -50
   crictl ps | grep -E 'kube-apiserver|etcd'
   ```

2. Restart the abnormal master host.

   > **Warning:** The API server and etcd member on that host stop until it boots. Do this only when the component logs show `http2: client connection lost` or `dial tcp <service-ip>:443: i/o timeout` and this master is the abnormal one. Confirm the other masters are healthy so that etcd keeps quorum, and keep console access to the host. A reboot cannot be rolled back.

3. Platform pages load once the node is `Ready` and the reflector errors stop.

### Cause 3: a global node is NotReady

```bash
kubectl get nodes
kubectl describe node <global-node> | sed -n '/Conditions/,$p'
```

Repair or remove the bad node. Do not keep rotating credentials once the certificate is known to be valid and only the `apollo` replica on that node is stuck. Console latency drops when every `global` node used by platform Pods is `Ready`.

### Cause 4: control-plane nodes run at 100% CPU

1. Confirm the saturation:

   ```bash
   kubectl top nodes
   ps aux --sort=-%cpu | head
   ```

2. Restart the Pods that burn CPU on the saturated nodes, then `apollo` if login still fails.

   > **Warning:** Restarting Pods interrupts the workloads they serve, including platform components. Do this only when the masters are at 100% CPU and the login failure matches that window, preferably in a maintenance window. The Pods return from the same specs.

   ```bash
   kubectl get pods -A --field-selector spec.nodeName=<master-node> --no-headers
   kubectl delete pod -n <namespace> <pod>
   kubectl delete pod -n cpaas-system <apollo-pod>
   ```

3. Login succeeds once CPU is no longer pinned and `apollo` is `Running`.

## Diagnostic Steps

```bash
curl -k --max-time 5 https://<vip>:6443/readyz
kubectl get nodes
kubectl top nodes
kubectl get po -A | grep -vi run
```

```text
business kubectl works, global curl to :6443 fails, CheckStatus Failed     -> Cause 1
http2: client connection lost, dial tcp <service-ip>:443 i/o timeout, one master abnormal -> Cause 2
slow UI, one global node NotReady, credentials already valid               -> Cause 3
login fails, master CPU at 100%                                            -> Cause 4
```
