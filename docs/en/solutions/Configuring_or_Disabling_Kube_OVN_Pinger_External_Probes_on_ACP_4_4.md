---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.4.x
---

# Configure or disable Kube-OVN pinger external probes on ACP 4.4

## Issue

In an Alauda Container Platform cluster that uses Kube-OVN, the following unexpected public traffic can appear even when applications do not generate it:

- CoreDNS repeatedly queries `kube-ovn.io.` in an IPv4 cluster or `google.com.` in an IPv6 or dual-stack cluster. A representative CoreDNS error has the following form:

  ```text
  [ERROR] plugin/errors: 2 kube-ovn.io. A: read udp ...: i/o timeout
  ```

- A firewall, flow log, or traffic-audit system records ICMP traffic to `1.1.1.1`, `2606:4700:4700::1111`, or both. The traffic recurs from nodes that run `kube-ovn-pinger`.

These probes are especially visible in air-gapped environments and private networks that prohibit unapproved public egress. Probe failures or audit records do not by themselves indicate a Pod-networking or application-DNS outage, but an operator might want to redirect the probes to approved internal targets or disable them completely.

## Environment

- Alauda Container Platform 4.4.x
- **Alauda Container Platform Networking for Kube-OVN** as the cluster CNI plugin
- CoreDNS logs or network audits contain repeated traffic to the Kube-OVN pinger's default public targets

## Resolution

Choose one of the following policies:

| Policy | **Pinger External Probe DNS** | **Pinger External Probe IP** | Result |
| --- | --- | --- | --- |
| Disable public probes | Leave empty | Leave empty | The pinger skips both the DNS lookup and the ICMP probe. |
| Keep probes on approved internal targets | Enter an internal FQDN, such as `kubernetes.default.svc.cluster.local.` when the cluster domain is `cluster.local` | Enter an internal address that accepts ICMP echo requests | The pinger retains external-probe metrics without sending traffic to the default public targets. |

You can also disable only one probe by leaving its field empty. When configuring a DNS target, use a fully qualified domain name with a trailing dot to prevent search-domain expansion. For a dual-stack IP probe, provide a comma-separated IPv4 and IPv6 pair if both address families must be monitored.

1. In the web console, navigate to **Administrator** > **Marketplace** > **Cluster Plugins** and select the affected cluster.

2. Search for `ovn` and locate **Alauda Container Platform Networking for Kube-OVN**.

3. In the plugin row, open the action menu (vertical ⋮) and select **Update**.

4. Apply the selected policy:

   - To stop all public pinger traffic, clear both **Pinger External Probe DNS** and **Pinger External Probe IP**.
   - To retain the probes, replace the defaults with the approved internal FQDN and IP address.

5. Submit the update and wait for the `kube-ovn-pinger` DaemonSet rollout to complete:

   ```bash
   kubectl -n kube-system rollout status daemonset/kube-ovn-pinger
   ```

6. Confirm that the DaemonSet contains the expected arguments:

   ```bash
   kubectl -n kube-system get daemonset kube-ovn-pinger \
     -o jsonpath='{.spec.template.spec.containers[?(@.name=="pinger")].args}'
   echo
   ```

   If the probes are disabled, the output must include `--external-dns=` and `--external-address=` with empty values. If the probes are redirected, verify the expected `--external-dns=<internal-FQDN>` and `--external-address=<internal-IP>` values.

7. After at least one probe interval, verify that CoreDNS no longer reports queries for the former public target:

   ```bash
   kubectl -n kube-system logs -l k8s-app=kube-dns \
     --since=10m --prefix \
     | grep -E 'kube-ovn\.io\.|google\.com\.'
   ```

   No new matching entry should appear after the pinger rollout. If the command also returns older entries from before the rollout, repeat it with a shorter `--since` window.

8. Check the firewall, flow log, or traffic-audit system and confirm that no new pinger traffic reaches `1.1.1.1` or `2606:4700:4700::1111` after the rollout.

When the fields are empty, the pinger stops updating the corresponding external-address and external-DNS health metrics but continues its other Kube-OVN health checks. When internal targets are configured, the metrics describe connectivity to those targets rather than public Internet connectivity.

## Root Cause

Kube-OVN runs one `kube-ovn-pinger` Pod on each eligible node. The pinger periodically sends ICMP echo requests to an external IP address and resolves an external DNS name so it can publish external-connectivity metrics.

The default targets depend on the cluster network stack:

| Network stack | External address | External DNS name |
| --- | --- | --- |
| IPv4 | `1.1.1.1` | `kube-ovn.io.` |
| IPv6 | `2606:4700:4700::1111` | `google.com.` |
| Dual stack | `1.1.1.1,2606:4700:4700::1111` | `google.com.` |

Every pinger Pod produces an independent stream. Node count and probe frequency therefore multiply both the DNS queries and ICMP traffic. Public DNS failures surface in CoreDNS logs, while successful or failed ICMP probes can still be visible to egress firewalls and traffic-audit systems.

ACP 4.4 exposes both targets in the Kube-OVN cluster-plugin configuration. A non-empty field replaces the corresponding target. An empty field renders an empty pinger argument, and the pinger skips that probe. The configuration is persistent across plugin reconciliation and cluster-plugin updates.

## Diagnostic Steps

Inspect the currently rendered pinger arguments:

```bash
kubectl -n kube-system get daemonset kube-ovn-pinger \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="pinger")].args}'
echo
```

If the output contains one of the following default arguments, the Kube-OVN pinger is generating the corresponding traffic:

- `--external-dns=kube-ovn.io.` or `--external-dns=google.com.` generates DNS lookups.
- `--external-address=1.1.1.1`, `--external-address=2606:4700:4700::1111`, or a comma-separated pair generates ICMP probes.

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

In the traffic-audit system, filter for the default external addresses and correlate the timestamps with the pinger Pods listed above. Depending on the egress path, the observed source can be a Pod address or a source-NAT address on the node.

Before attributing a broader network incident to these probes, verify that application service names resolve normally and that application traffic is healthy. A finding limited to the pinger's public targets affects its external-probe metrics or creates audit noise, but it does not by itself show that cluster-local DNS or Pod networking is unavailable.
