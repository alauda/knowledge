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

# Console returns 502 or does not open after installation or a VIP change on ACP

## Issue

The console host does not answer, the browser receives HTTP 502 from ALB, or the installation wizard never leaves its first step. Typical situations:

- After a new ACP 4.4 installation, the platform opens with an nginx `502`, although every Pod is `Running`.
- A new `global` installation stays on the repository initialization step (`初始化仓库配置`).
- An EIP is bound to the cluster, but the management page does not load through it.
- A business cluster reports an `alive` error, and the console cannot operate it.
- Web CLI drops a few seconds after it opens, and real-time log follow does the same.

In the browser developer tools there is no HTTP response, a 502, or a long pending request: a reachability problem. An HTTP 500 with a JSON body from `apollo` is a different problem; see [Console returns HTTP 500 or a blank page because apollo or courier on the global cluster fails on ACP](Console_returns_HTTP_500_or_a_blank_page_because_apollo_or_courier_on_the_global_cluster_fails_on_ACP.md).

Related article: [Console is inaccessible or a business cluster shows 0 nodes because global cannot reach an API server on ACP](Console_is_inaccessible_or_a_business_cluster_shows_0_nodes_because_global_cannot_reach_an_API_server_on_ACP.md).

## Root Cause

### Cause 1: ACP 4.4 was installed without all Required Aligned Extensions

From ACP 4.4 the web console is not part of the Core Package. The Required Aligned Extensions must be copied into the `plugins/` directory of the extracted Core Package before the installer runs:

- Alauda Container Platform Web Console
- Alauda Container Platform Web Console Central
- Alauda Container Platform Marketplace Web Console
- Alauda Container Platform Helm Application Catalog
- Alauda Container Platform Observability Essentials
- Alauda Container Platform Essentials
- Alauda Container Platform Cluster Essentials
- Alauda Container Platform GatewayAPI Plugin

If they are missing, the console Pods, Services, and Endpoints are never created and ALB returns 502. Leaving out a single one gives the same 502: every Pod is `Running` and the `alb2-controller` log can even show 200 responses from the login chain. Copying additional marketplace packages beyond this set into `plugins/` makes `setup.sh` fail.

### Cause 2: kubelet does not start because required kernel parameters are missing

A new `global` installation stays on the repository initialization step. The `cpaas-install` logs are quiet, the `cls` object reports errors, `kubelet` is not active, and its journal says required kernel parameters are missing. No container can start until `kubelet` runs.

### Cause 3: the alive VIP mode is not arp

`alive` holds the cluster VIP. When the VIP mode file `/etc/kubernetes/alive/vipmode` on the nodes is not `arp`, an EIP bound to the cluster does not reach the management page.

### Cause 4: alive crash-loops because alive.yaml names a NIC that no longer exists

The business cluster's nodes are `Ready`, but `kubectl describe cls` shows that port 6443 on the business cluster fails, `cluster-api-provider-alauda-manager` logs an error loading the cluster, and the `alive` Pod is `CrashLoopBackOff` with a log of mostly `logrotate.state` and VIP or IPVS state. The network interface name changed (for example from `ens192` to `eth0`), but `alive.yaml` still names the old one, so `alive` cannot attach the VIP and the `global` cluster cannot reach the business API.

### Cause 5: an external stream proxy closes long-lived connections after 5 seconds

Web CLI opens (status 101) and dies a few seconds later. The ALB rule `cpaas-system/web-cli` logs `/auth/v1/pod/shell` with a `request_time` of a few seconds, and `web-terminal` logs `EOF`. Bypassing the external nginx makes the session stable. On that nginx, the `stream` listener that forwards 6443 has `proxy_timeout 5s`, while 443 uses `3m`.

## Resolution

### Cause 1: ACP 4.4 was installed without all Required Aligned Extensions

1. Check whether the console has Pods, Services, and Endpoints. Empty results on a new 4.4 installation match this cause:

   ```bash
   kubectl get pods,svc,endpoints -A | grep -Ei 'frontend|console|alb'
   ```

2. Compare the packages that were copied into the Core Package `plugins/` directory with the eight Required Aligned Extensions:

   ```bash
   ls <core-package>/plugins/
   ```

3. To rule out a self-built VIP, test it from each control-plane node and compare: TLS handshake, status code, and agreement between nodes. A TLS handshake EOF points at the VIP (loopback access, ARP, routing, or the load balancer health checks), not at the ALB certificates:

   ```bash
   curl -vk --connect-timeout 5 --resolve <platform-domain>:443:<vip> https://<platform-domain>/
   ```

4. Install again with the complete set.

   > **Warning:** The recovery runs `cleanup.sh` on every node and installs again, which tears down the failed installation. Never run it against a cluster that already serves workloads, and copy off any data you need first. A wiped installation can only be restored from backup.

   Copy exactly the eight Required Aligned Extensions (and no other marketplace packages) into `plugins/`, run `cleanup.sh` on each node, then run `setup.sh` as documented. ALB stops returning 502 once the console Service has Endpoints.

If DNS problems stopped Kubernetes from coming up during the same installation, fix DNS and finish the cluster installation first; that is a separate, earlier fault.

### Cause 2: kubelet does not start because required kernel parameters are missing

1. On the node, check `kubelet` and the kernel parameters:

   ```bash
   systemctl status kubelet --no-pager
   journalctl -u kubelet -n 100 --no-pager
   sysctl vm.overcommit_memory vm.panic_on_oom kernel.panic kernel.panic_on_oops kernel.keys.root_maxkeys kernel.keys.root_maxbytes
   ```

2. Apply the parameters and restart `kubelet`.

   > **Warning:** `kernel.panic=10` and `kernel.panic_on_oops=1` make the node reboot itself after a kernel panic. Apply them only on nodes that will run ACP, and keep console access in case a key is rejected. To roll back, remove `/etc/sysctl.d/acp.conf`, restore the previous values, and run `sysctl` again.

   ```bash
   cat >/etc/sysctl.d/acp.conf <<'EOF'
   vm.overcommit_memory = 1
   vm.panic_on_oom = 0
   kernel.panic = 10
   kernel.panic_on_oops = 1
   kernel.keys.root_maxkeys = 1000000
   kernel.keys.root_maxbytes = 25000000
   EOF
   sysctl -p /etc/sysctl.d/acp.conf
   systemctl restart kubelet
   systemctl is-active kubelet
   ```

3. Once `kubelet` stays active, the wizard can continue. If `kubelet` is active and the wizard is still stuck, go back to the `cls` error.

### Cause 3: the alive VIP mode is not arp

On each node where `alive` runs:

> **Warning:** Changing the VIP mode and restarting keepalived moves or drops the management VIP for a few seconds, and open console sessions break. Do this in a maintenance window. To roll back, write the previous mode back to the file and restart keepalived again.

```bash
cat /etc/kubernetes/alive/vipmode
echo arp > /etc/kubernetes/alive/vipmode
kubectl get pods -n kube-system --no-headers | awk '/alive/ {print $1}'
kubectl exec -n kube-system <alive-pod> -- pkill keepalived
```

The management page answers on the EIP once `alive` is `Running` again.

### Cause 4: alive crash-loops because alive.yaml names a NIC that no longer exists

1. Compare the live interfaces with the one in the `alive` configuration:

   ```bash
   ip -br link
   kubectl logs -n kube-system <alive-pod> --tail=100
   ls /etc/kubernetes/alive
   ```

2. Back up `alive.yaml` and change the interface to the one that `ip -br link` shows as `UP`.

   > **Warning:** A wrong interface name leaves the VIP unbound and the business cluster unreachable from `global`. Restoring the backup is the rollback.

   ```bash
   cp -a /etc/kubernetes/alive/alive.yaml /root/alive.yaml.bak
   vi /etc/kubernetes/alive/alive.yaml
   ```

3. Restart `cluster-api-provider-alauda-manager` on the `global` cluster so that it reloads cluster access.

   > **Warning:** The restart briefly pauses cluster reconciliation on the `global` cluster.

   ```bash
   kubectl get deploy -A | grep cluster-api-provider-alauda
   kubectl rollout restart deployment -n <namespace> cluster-api-provider-alauda-manager
   kubectl get pods -n kube-system | grep alive
   ```

   `alive` leaves `CrashLoopBackOff`, and `kubectl describe cls` stops reporting 6443 failures.

### Cause 5: an external stream proxy closes long-lived connections after 5 seconds

On the external nginx that publishes the VIP, set the `stream` server that listens on 6443 to the same order of timeout as 443, then reload nginx:

> **Warning:** A longer `proxy_timeout` keeps idle TCP connections open longer on that proxy; it does not change ACP. To roll back, restore the previous value, which brings the disconnects back.

```nginx
# stream server that listens on 6443
proxy_timeout 3m;
```

Confirm that `/auth/v1/pod/shell` stays on 101 with a growing `request_time`, and that `web-terminal` no longer logs an immediate `EOF`.

## Diagnostic Steps

```bash
curl -k --max-time 5 https://<vip>:6443/readyz
kubectl get pods -n kube-system | grep -E 'alive|kube-apiserver'
kubectl get pods -n cpaas-system | grep -E 'alb|frontend|apollo'
kubectl get pods,svc,endpoints -A | grep -Ei 'frontend|console'
```

```text
ALB 502, no console Endpoints on a new 4.4 installation, or one extension missing -> Cause 1
kubelet inactive, installation stuck on repository initialization              -> Cause 2
EIP silent, vipmode is not arp                                                  -> Cause 3
alive CrashLoopBackOff, alive.yaml names a NIC that does not exist             -> Cause 4
Web CLI status 101 then EOF, only through the external nginx                   -> Cause 5
```
