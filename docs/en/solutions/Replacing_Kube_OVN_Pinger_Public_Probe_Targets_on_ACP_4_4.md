---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# Replace Kube-OVN pinger public probe targets on ACP 4.4

## Issue

In an Alauda Container Platform cluster that uses Kube-OVN, CoreDNS can repeatedly report failed queries for a public domain even when applications do not query that domain. For an IPv4 cluster, the log commonly mentions `kube-ovn.io.`; IPv6 and dual-stack clusters can instead show `google.com.`. A representative CoreDNS error has the following form:

```text
[ERROR] plugin/errors: 2 kube-ovn.io. A: read udp ...: i/o timeout
```

The errors are especially common in air-gapped environments or private networks that cannot use an upstream public DNS server. They are probe failures and do not by themselves indicate a Pod-networking or application-DNS outage.

## Environment

- Alauda Container Platform 4.4.x
- **Alauda Container Platform Networking for Kube-OVN** as the cluster CNI plugin
- CoreDNS logs contain repeated failures for the Kube-OVN pinger's configured public domain

## Resolution

Replace the public probe targets with targets that are reachable from the cluster.

Before updating the plugin, choose the following values:

| Plugin field | Recommended value |
| --- | --- |
| **Pinger External Probe DNS** | A fully qualified domain name that CoreDNS can resolve without using a public upstream resolver. Include the trailing dot to prevent search-domain expansion. For example, use `kubernetes.default.svc.cluster.local.` when the cluster domain is `cluster.local`, or use an organization-owned internal FQDN. |
| **Pinger External Probe IP** | An IP address that accepts ICMP echo requests from the cluster nodes. For a dual-stack cluster, provide a comma-separated IPv4 and IPv6 pair if both address families must be monitored. |

:::note
Leaving either field empty in the ACP 4.4 plugin form preserves the Kube-OVN default for the active network stack. An empty **Pinger External Probe DNS** field therefore does not remove the default public-domain query. Enter an explicit reachable target.
:::

1. In the web console, navigate to **Administrator** > **Marketplace** > **Cluster Plugins** and select the affected cluster.

2. Search for `ovn` and locate **Alauda Container Platform Networking for Kube-OVN**.

3. In the plugin row, open the action menu (vertical ⋮) and select **Update**.

4. Set **Pinger External Probe DNS** to the internal FQDN selected above. If the default public probe IP is also unreachable, set **Pinger External Probe IP** to the selected internal IP address.

5. Submit the update and wait for the `kube-ovn-pinger` DaemonSet rollout to complete:

   ```bash
   kubectl -n kube-system rollout status daemonset/kube-ovn-pinger
   ```

6. Confirm that the DaemonSet contains the new targets:

   ```bash
   kubectl -n kube-system get daemonset kube-ovn-pinger \
     -o jsonpath='{.spec.template.spec.containers[?(@.name=="pinger")].args}'
   echo
   ```

   Verify that the output includes the expected `--external-dns=<internal-FQDN>` and, if changed, `--external-address=<internal-IP>` arguments.

7. After at least one probe interval, verify that CoreDNS no longer reports failures for the former public target:

   ```bash
   kubectl -n kube-system logs -l k8s-app=kube-dns \
     --since=10m --prefix \
     | grep -E 'kube-ovn\.io\.|google\.com\.'
   ```

   No new matching error should appear after the pinger rollout. If the command also returns older entries from before the rollout, repeat it with a shorter `--since` window.

The pinger continues to publish external-connectivity health metrics, but those metrics now describe connectivity to the configured internal targets rather than public Internet connectivity.

## Root Cause

Kube-OVN runs one `kube-ovn-pinger` Pod on each eligible node. The pinger periodically checks an external IP address and resolves an external DNS name so it can publish external-connectivity metrics.

The default target depends on the cluster network stack. IPv4 uses `kube-ovn.io.` for the DNS probe, while IPv6 and dual-stack use `google.com.`. When a private cluster cannot reach a public resolver, every pinger Pod continues to issue the configured query and CoreDNS records the upstream timeout or failure. The number of log entries therefore grows with both the node count and the probe frequency.

ACP 4.4 exposes the pinger IP and DNS targets in the Kube-OVN cluster-plugin configuration. Replacing the defaults through that configuration is persistent across plugin reconciliation and cluster-plugin updates.

## Diagnostic Steps

Inspect the currently rendered pinger arguments:

```bash
kubectl -n kube-system get daemonset kube-ovn-pinger \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="pinger")].args}'
echo
```

If the output contains `--external-dns=kube-ovn.io.` or `--external-dns=google.com.`, the Kube-OVN pinger is generating the corresponding DNS query.

List the pinger Pods and their node placement to estimate how many independent probes are running:

```bash
kubectl -n kube-system get pods -l app=kube-ovn-pinger -o wide
```

Check recent CoreDNS errors for the default public targets:

```bash
kubectl -n kube-system logs -l k8s-app=kube-dns \
  --since=10m --prefix \
  | grep -E '\[ERROR\].*(kube-ovn\.io\.|google\.com\.)'
```

Before attributing a broader DNS incident to this probe, also verify that application service names resolve normally. A failure limited to the pinger's public target affects its external-DNS health metric and produces log noise, but it does not by itself show that cluster-local DNS or Pod networking is unavailable.
