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

Starting with Alauda Container Platform 4.4, the Kube-OVN pinger's external address and external DNS probes are disabled by default. Both plugin fields are empty unless an administrator explicitly configures probe targets.

An operator might nevertheless find one of the following during an upgrade investigation or traffic audit:

- CoreDNS queries for `kube-ovn.io.` or `google.com.`, sometimes accompanied by an error such as:

  ```text
  [ERROR] plugin/errors: 2 kube-ovn.io. A: read udp ...: i/o timeout
  ```

- ICMP traffic to `1.1.1.1`, `2606:4700:4700::1111`, or both.

These findings do not match the ACP 4.4 default. Check the rendered pinger arguments and the current plugin configuration to determine whether probes were explicitly enabled, an update has not finished rolling out, the audit event predates the update, or another workload generated the traffic.

## Environment

- Alauda Container Platform 4.4.x
- **Alauda Container Platform Networking for Kube-OVN** as the cluster CNI plugin
- The operator needs to verify, disable, or configure the pinger's optional external probes

## Resolution

Choose one of the following policies. The first row is the ACP 4.4 default.

| Policy | **Pinger External Probe DNS** | **Pinger External Probe IP** | Result |
| --- | --- | --- | --- |
| Keep external probes disabled (default) | Leave empty | Leave empty | The pinger skips both the DNS lookup and the ICMP probe. |
| Keep probes on approved internal targets | Enter an internal FQDN, such as `kubernetes.default.svc.cluster.local.` when the cluster domain is `cluster.local` | Enter an internal address that accepts ICMP echo requests | The pinger retains external-probe metrics without sending traffic to public targets. |

You can also disable only one probe by leaving its field empty. When configuring a DNS target, use a fully qualified domain name with a trailing dot to prevent search-domain expansion. For a dual-stack IP probe, provide a comma-separated IPv4 and IPv6 pair if both address families must be monitored.

1. In the web console, navigate to **Administrator** > **Marketplace** > **Cluster Plugins** and select the affected cluster.

2. Search for `ovn` and locate **Alauda Container Platform Networking for Kube-OVN**.

3. In the plugin row, open the action menu (vertical ⋮) and select **Update**.

4. Apply the selected policy:

   - To keep the ACP 4.4 default and stop external pinger traffic, clear both **Pinger External Probe DNS** and **Pinger External Probe IP**.
   - To enable the probes, enter an approved internal FQDN and IP address.

5. Submit the update and wait for the `kube-ovn-pinger` DaemonSet rollout to complete:

   ```bash
   kubectl -n kube-system rollout status daemonset/kube-ovn-pinger
   ```

6. Use the argument inspection under **Diagnostic Steps** to confirm that the DaemonSet matches the selected probe policy before checking logs or traffic-audit records.

7. If public-domain queries were previously observed, verify that CoreDNS no longer reports them after the rollout:

   ```bash
   kubectl -n kube-system logs -l k8s-app=kube-dns \
     --since=10m --prefix \
     | grep -E 'kube-ovn\.io\.|google\.com\.'
   ```

   No new matching entry should appear after the pinger rollout. If the command also returns older entries from before the rollout, repeat it with a shorter `--since` window.

8. Check the firewall, flow log, or traffic-audit system and confirm that no new traffic attributed to the pinger reaches `1.1.1.1` or `2606:4700:4700::1111` after the rollout.

When the fields are empty, the pinger stops updating the corresponding external-address and external-DNS health metrics but continues its other Kube-OVN health checks. When internal targets are configured, the metrics describe connectivity to those targets rather than public Internet connectivity.

## Root Cause

Kube-OVN runs one `kube-ovn-pinger` Pod on each eligible node. When configured, the pinger periodically sends ICMP echo requests to an external IP address and resolves an external DNS name so it can publish external-connectivity metrics. The pinger executes each probe only when the corresponding argument is non-empty.

ACP 4.4 renders both arguments with empty values by default:

```text
--external-address=
--external-dns=
```

Consequently, a default ACP 4.4 installation does not generate external address or external DNS probe traffic. When probes are enabled, one pinger Pod on each eligible node produces an independent stream, so node count and probe frequency multiply the observed traffic.

The following public targets can identify a historical or explicitly configured pinger probe:

| Network stack | Recognizable external address | Recognizable external DNS name |
| --- | --- | --- |
| IPv4 | `1.1.1.1` | `kube-ovn.io.` |
| IPv6 | `2606:4700:4700::1111` | `google.com.` |
| Dual stack | `1.1.1.1,2606:4700:4700::1111` | `google.com.` |

ACP 4.4 exposes both targets in the Kube-OVN cluster-plugin configuration. A non-empty field enables the corresponding probe. An empty field disables it. The configuration is persistent across plugin reconciliation and cluster-plugin updates.

## Diagnostic Steps

Inspect the currently rendered pinger arguments:

```bash
kubectl -n kube-system get daemonset kube-ovn-pinger \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="pinger")].args}'
echo
```

The ACP 4.4 default is `--external-dns=` and `--external-address=`. With those empty values, the current pinger does not generate either kind of external probe.

If the output instead contains one of the following non-empty arguments, the Kube-OVN pinger is configured to generate the corresponding traffic:

- `--external-dns=kube-ovn.io.` or `--external-dns=google.com.` generates DNS lookups.
- `--external-address=1.1.1.1`, `--external-address=2606:4700:4700::1111`, or a comma-separated pair generates ICMP probes.

List the pinger Pods and their node placement to estimate how many independent probes are running:

```bash
kubectl -n kube-system get pods -l app=kube-ovn-pinger -o wide
```

Check recent CoreDNS errors for recognizable public probe targets:

```bash
kubectl -n kube-system logs -l k8s-app=kube-dns \
  --since=10m --prefix \
  | grep -E '\[ERROR\].*(kube-ovn\.io\.|google\.com\.)'
```

In the traffic-audit system, filter for the recognizable external addresses and correlate the timestamps with the pinger Pods listed above. Depending on the egress path, the observed source can be a Pod address or a source-NAT address on the node. If the DaemonSet arguments are empty, check whether the event predates the latest pinger rollout and whether another process owns the traffic before attributing it to Kube-OVN.

Before attributing a broader network incident to these probes, verify that application service names resolve normally and that application traffic is healthy. A finding limited to the pinger's public targets affects its external-probe metrics or creates audit noise, but it does not by itself show that cluster-local DNS or Pod networking is unavailable.
