---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Suppressing NodeNetworkInterfaceDown Alert Noise for Unused Backup NICs
## Issue

On clusters that run ACP Virtualization on bare-metal nodes, the `NodeNetworkInterfaceDown` alert fires repeatedly against one or more nodes. The cluster is healthy, the workloads on those nodes are serving, and networking for the pods is working — but every node has one or more spare NICs that are physically present and have no cable plugged into them. The kernel reports those NICs with `operstate=down`, the node exporter picks that up and emits `node_network_flags`, and the virtualization operator's built-in Prometheus rule raises the alert.

The shipped alert is managed by the virtualization stack's operator. It is part of the operator's reconciled `PrometheusRule` objects; editing it in place is reverted on the next reconcile. The question is how to quiet the alert on NICs that are intentionally unused, without losing the signal on NICs that genuinely should be up.

## Root Cause

The node exporter publishes `node_network_flags` for every interface the kernel knows about — physical and virtual. The virtualization operator ships an alerting rule that flags any NIC whose `IFF_UP` bit is set without the `IFF_RUNNING` bit, which is the operating-system-level representation of "the interface is administratively up but no carrier is present".

That expression is correct for the general case: on a node with every NIC either wired or intentionally disabled, exactly the NICs with a real problem will flag. The failure mode is cosmetic: hardware often ships with more NICs than a deployment uses. Backup ports, out-of-band management ports, SR-IOV VFs that are provisioned but not yet attached — all of them legitimately show as "up but no running" and would all trigger the alert if left in the default expression's scope.

Because the operator owns the `PrometheusRule`, direct edits are reconciled away. The supported paths are to **silence** the alert for the affected instances (short-term) and to **shadow** it with a customer-defined rule that excludes the intentionally-unused devices (long-term).

## Resolution

Use both paths together: silence while the custom rule is being tuned, then let the custom rule be the durable filter once it is stable.

### Step 1 — Enumerate the intentionally-unused NICs per node

Connect to the node and list its network devices. The output identifies the NICs that should be excluded from alerting:

```bash
NODE=<node-name>
# busybox often isn't pullable on isolated ACP clusters; substitute with
# any image in your in-cluster registry that has /bin/sh + cat.
# chroot /host is rejected by ACP's PSA, so paths are read with /host/ prefix.
kubectl debug node/$NODE --image=<image-with-shell> -- sh -c '
  for d in /host/sys/class/net/*; do
    name=$(basename "$d")
    state=$(cat "$d/operstate" 2>/dev/null)
    carrier=$(cat "$d/carrier" 2>/dev/null)
    echo "$name  operstate=$state  carrier=$carrier"
  done
'
```

(`nmcli` and `ip` need their respective binaries inside the debug image and access to the host network namespace — `kubectl debug node` runs with `hostNetwork=true` so `ip -o link show` works as long as `iproute2` is in the image.)

The NICs that should be excluded are those where `carrier=0` is expected (nothing plugged in on purpose). Common exclusion candidates include secondary NICs named `eno2` / `eno3` / `ens…`, dedicated management NICs, and unused SR-IOV `ens<xx>f<y>` physical functions.

### Step 2 — Silence the alert for immediate quiet

While the custom rule is tuned, silence the alert in Alertmanager so the noise does not crowd out other signals. A silence narrowed to the alert name (and optionally an `instance` label) is the right scope:

```yaml
# matchers: point-in-time silence while the custom rule is being authored.
matchers:
  - name: alertname
    value: NodeNetworkInterfaceDown
    isRegex: false
startsAt:  "2026-02-18T00:00:00Z"
endsAt:    "2026-02-25T00:00:00Z"
createdBy: "ops-team"
comment:   "Silenced while shadow rule excluding unused NICs is authored."
```

Create the silence through the monitoring stack's Alertmanager API or its web UI. Keep the end time short and deliberately revisit — a permanent silence hides regressions.

### Step 3 — Author a customer-defined PrometheusRule that excludes known-unused NICs

Create a `PrometheusRule` in a user namespace (the monitoring stack's user-workload Prometheus will pick it up if configured) that reproduces the alert's intent minus the known-unused interfaces:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: node-interface-down-customer
  namespace: ops-monitoring
  labels:
    role: alert-rules
spec:
  groups:
    - name: network-interface-down
      rules:
        - alert: NodeInterfaceDownCustomer
          expr: |-
            count by (instance) (
              (
                (node_network_flags % 2) >= 1
                and (node_network_flags % 128) < 64
                and on (device) (
                  node_network_flags
                  unless node_network_flags{device=~"lo|tunbr|veth.+|ovs-system|genev_sys.+|br-int|eno2|eno3|ens2f1"}
                )
              ) > 0
            )
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: >-
              Node {{ $labels.instance }} has a network interface marked
              up but without carrier, excluding the list of NICs known to
              be intentionally unused on this cluster.
            runbook_url: https://ops.example.com/runbooks/node-interface-down
```

Two things to tune:

- The `device=~"…"` regex is the exclusion list. Every intentionally-unused NIC identified in step 1 goes here. Include the standard virtual devices (`lo`, `veth.+`, `ovs-system`, `br-int`, `genev_sys.+`) so containerd/OVN interfaces do not trip the rule.
- The bit masks on `node_network_flags` encode `IFF_UP` and `IFF_RUNNING` from Linux. Leave them as-is unless the platform documentation recommends otherwise.

Once this rule has fired (or cleanly stayed silent) for a full business cycle, the silence from step 2 can expire without reintroducing noise.

### Step 4 — Keep the exclusion list maintained

The exclusion list is not write-once. Every time a node's NIC inventory changes — hardware refresh, SR-IOV reconfiguration, adding a new bonded interface — revisit the regex. A stale exclusion that now masks a real problem is the failure mode the silence-and-shadow approach is most vulnerable to.

Store the `PrometheusRule` alongside other cluster configuration so the exclusion list is visible in code review. Record the rationale (which NICs are excluded and why) directly in the `annotations.summary` or in the commit that introduced each entry.

## Diagnostic Steps

Confirm the alert's source — the operator-shipped rule, not a local one — by listing `PrometheusRule` objects and grepping for the alertname:

```bash
kubectl get prometheusrule -A -o json | \
  jq -r '.items[] | select(.spec.groups[].rules[]?.alert == "NodeNetworkInterfaceDown")
         | "\(.metadata.namespace)/\(.metadata.name)"'
```

The rule lives in a namespace owned by the virtualization operator; those rules should be left intact.

Verify which NICs the alert is currently counting. Use the Prometheus query endpoint or the `kubectl get --raw` path into the platform monitoring stack:

```bash
kubectl debug node/<node-name> --image=<image-with-shell> -- sh -c '
  for n in /host/sys/class/net/*; do
    name=$(basename "$n")
    flags=$(cat "$n/flags" 2>/dev/null)
    echo "$name  flags=$flags"
  done
'
```

The kernel `flags` hex value maps onto the `node_network_flags` metric. An interface that would trigger the alert has `IFF_UP` set (`& 0x1`) and `IFF_RUNNING` cleared (`& 0x40`). Confirming by hand which devices match the rule's logic guards against an exclusion regex that accidentally excludes a NIC that legitimately should be up.

Finally, after the custom rule lands, watch for the alert to clear and the customer-defined rule to evaluate cleanly:

```bash
kubectl get prometheusrule -n ops-monitoring node-interface-down-customer -o yaml
# In the platform's Prometheus UI, confirm NodeInterfaceDownCustomer
# appears with `Inactive` state on the affected nodes.
```

If the customer rule fires on nodes where no NIC actually has an issue, extend the `device=~` regex. If it stays silent on a node with a genuinely broken NIC, tighten the regex so that NIC is no longer excluded.
