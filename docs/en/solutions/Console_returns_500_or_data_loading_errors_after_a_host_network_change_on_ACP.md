---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Console returns 500 or data loading errors after a host network change on ACP

## Issue

One of the following starts right after a change on the cluster hosts, not on ACP objects:

- The management console returns `x-error 500` after node DNS was changed and NetworkManager was restarted.
- Switching between platform sub-pages sometimes returns a 500 internal server error, more often in an incognito window.
- The native application page keeps showing `数据加载错误` (data loading error), the external address pool page shows `数据加载错误 重试` (data loading error, retry), the cluster shows no subnet information, and later the whole platform is unusable.

Platform Pods can all be `Running` while their network path is broken. The common check is to compare what works from the node with what works from inside a Pod on that node, and then to find the host change.

If nothing changed on the hosts, and pages are slow or fail together, see [Console is slow or shows data loading errors because calls through erebus or the marketplace backends are slow on ACP](Console_is_slow_or_shows_data_loading_errors_because_calls_through_erebus_or_the_marketplace_backends_are_slow_on_ACP.md).

## Root Cause

### Cause 1: NetworkManager was restarted after a DNS change and Pods time out to the API Service

Node DNS was changed with `nmcli conn mod "<connection>" ipv4.dns "<dns-server>"` and NetworkManager was restarted. Afterwards a platform component logs:

```text
Error: Get "https://<cluster-ip>:443/version": dial tcp <cluster-ip>:443: i/o timeout
```

The same request succeeds from the node and fails from inside the Pod. From inside the Pod public name servers cannot be reached either, which first looks like a CoreDNS problem. The fault is NetworkManager running and being restarted on the node; stopping the NetworkManager service returns the environment to normal. How the restart breaks Pod traffic is not established.

### Cause 2: a Multus CNI configuration breaks the frontend Pod's network to dex

Inside the `frontend` container, a request to the dex Service on port 5556 times out:

```text
curl: (28) Failed to connect to <dex-service-ip> port 5556: Connection timed out
```

On the host, `/etc/cni/net.d` contains a Multus configuration that broke the container networking of the `frontend` Pod, so it cannot reach dex and pages return 500. Inside the container the network looks normally configured: `ip a` shows `eth0@if<index>` with a Pod-network address and `route -n` shows the default route through `eth0`. Removing Multus and restarting the affected Pods restores the connection.

### Cause 3: the host IPv6 kernel parameters were changed

When the IPv6 kernel parameters on the hosts are modified, many pages show `数据加载错误` (data loading error) and the platform degrades until it is unusable. Developer tools on the native application page can look clean, with only a `heartbeat?action=false` request returning 200. Restoring the previous IPv6 parameters returns the pages to normal.

## Resolution

### Cause 1: NetworkManager was restarted after a DNS change and Pods time out to the API Service

1. List what is not `Running`, and compare the node with the Pod:

   ```bash
   kubectl get pod -A -o wide | grep -vi running
   kubectl logs -n <namespace> <failing-pod> --tail=100 | grep -E 'i/o timeout|/version'
   curl -k --max-time 5 https://<cluster-ip>:443/version
   systemctl is-active NetworkManager
   systemctl is-enabled NetworkManager
   ```

   Run the `curl` on the node, then the same request from inside the failing Pod with `kubectl exec` if its image has `curl`. Success on the node and a timeout in the Pod, right after a NetworkManager restart, matches this cause.

2. Stop NetworkManager on the affected nodes.

   > **Warning:** With NetworkManager stopped, nothing reapplies the host's connection profiles until it is started again; addresses already configured stay in place. Do this only on nodes where the 500 followed a NetworkManager restart and Pods time out to the API Service while the node reaches it. Keep out-of-band console access to the node. To roll back, run `systemctl start NetworkManager`, which brings the fault back.

   ```bash
   systemctl stop NetworkManager
   kubectl get pod -A -o wide | grep -vi running
   ```

3. Decide whether NetworkManager should also stay disabled at boot according to how the hosts' networking is managed. Keep the intended DNS server in the node configuration.

### Cause 2: a Multus CNI configuration breaks the frontend Pod's network to dex

1. From the `frontend` Pod, test dex and read the paired host interface:

   ```bash
   kubectl get pod -A -o wide | grep -E 'frontend|dex'
   kubectl get svc -A | grep dex
   kubectl exec -n cpaas-system <frontend-pod> -- curl -k -I --max-time 5 https://<dex-service-ip>:5556/
   kubectl exec -n cpaas-system <frontend-pod> -- cat /sys/class/net/eth0/iflink
   ```

2. On the node that runs the Pod, list the CNI configuration and look up the interface index printed by `iflink`:

   ```bash
   ls -l /etc/cni/net.d/
   ip -o link | awk -F': ' '{print $1": "$2}' | grep '^<iflink>:'
   ```

   A Multus file in `/etc/cni/net.d` together with a dex timeout from `frontend` matches this cause.

3. Uninstall Multus the way it was installed, make sure its configuration file is gone from `/etc/cni/net.d` on every node, and restart the affected Pods.

   > **Warning:** Uninstalling Multus removes the secondary networks it provides; every Pod attached to a `NetworkAttachmentDefinition` loses those interfaces when it is recreated. Do this only when no workload on the cluster needs Multus, in a maintenance window. To roll back, install Multus again the same way.

   ```bash
   kubectl delete pod -n cpaas-system <frontend-pod>
   kubectl exec -n cpaas-system <new-frontend-pod> -- curl -k -I --max-time 5 https://<dex-service-ip>:5556/
   ```

### Cause 3: the host IPv6 kernel parameters were changed

1. Compare the IPv6 parameters on an affected node with a node that was not changed, and look for recent edits:

   ```bash
   sysctl -a 2>/dev/null | grep -E '^net\.ipv6\.conf\.(all|default)\.'
   ls -lt /etc/sysctl.conf /etc/sysctl.d/
   grep -rn ipv6 /etc/sysctl.conf /etc/sysctl.d/
   ```

2. Set the changed parameters back to their previous values, and restore them in the file that was edited so that they survive a reboot.

   > **Warning:** IPv6 kernel parameters affect host and Pod networking on that node immediately. Do this only for values that differ from the healthy nodes or from the values before the change, and record the current values first. To roll back, set the recorded values again.

   ```bash
   sysctl -w <ipv6-parameter>=<previous-value>
   ```

## Diagnostic Steps

1. Find out what changed on the hosts just before the errors started: DNS, NetworkManager, CNI files, or kernel parameters.

   ```bash
   journalctl -u NetworkManager --since "-24h" --no-pager | tail -50
   ls -lt /etc/cni/net.d/
   ls -lt /etc/sysctl.conf /etc/sysctl.d/
   ```

2. Test the same target from the node and from inside a platform Pod on that node. Expected for this article: the node works and the Pod fails.

3. Match the signature:

   ```text
   x-error 500 after an nmcli DNS change and a NetworkManager restart, Pod i/o timeout to <cluster-ip>:443 -> Cause 1
   intermittent 500 on sub-page switch, frontend cannot reach dex :5556, Multus in /etc/cni/net.d     -> Cause 2
   数据加载错误 on many pages, no subnet information, host IPv6 parameters changed                    -> Cause 3
   ```
