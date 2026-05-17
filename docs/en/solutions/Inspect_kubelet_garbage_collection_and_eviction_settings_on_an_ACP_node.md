---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Inspect kubelet garbage-collection and eviction settings on an ACP node

## Issue

Operators need to confirm which image garbage-collection and eviction thresholds the kubelet is currently using on a given ACP node — for example to debug pods being evicted under disk or memory pressure, or to verify that a change to the on-disk kubelet config has actually taken effect. The relevant settings live in the kubelet `KubeletConfiguration` object and cover a fixed set of fields: `imageGCHighThresholdPercent`, `imageGCLowThresholdPercent`, `imageMinimumGCAge`, `evictionHard`, `evictionSoft`, `evictionSoftGracePeriod`, and `evictionPressureTransitionPeriod`.

These names and semantics come from upstream kubelet; ACP ships the kubelet unmodified, so the field shape is identical to what is documented for Kubernetes itself rather than something ACP-specific.

## Root Cause

On ACP the kubelet has no cluster-wide configuration CRD: there is no apiserver-managed custom resource that wraps the per-node kubelet config and reconciles it onto disk. Each kubelet reads its config directly from the on-disk file on its node, and any change to GC or eviction settings has to be made by editing that file on the node itself — there is no cluster-scoped object to `kubectl edit`.

On the Ubuntu-based ACP node the kubelet's main configuration file lives at `/var/lib/kubelet/config.yaml`. GC and eviction values appear inline in that YAML; fields whose on-disk value is the sentinel zero (`0s`) or `null` are replaced at runtime with the kubelet's built-in defaults and only the substituted values become visible through the live kubelet.

## Resolution

On ACP install package v4.3.0-online (Ubuntu 22.04 nodes, Kubernetes v1.34.5, kubelet `cgroupDriver=systemd`), the supported way to read the in-effect kubelet GC and eviction values is the standard upstream apiserver-to-kubelet `configz` proxy, which still works unchanged on ACP. A request against `/api/v1/nodes/<NODE>/proxy/configz` returns a JSON body whose `.kubeletconfig` object carries the same GC and eviction fields listed above.

A typical query for one node, filtered down to the GC and eviction fields, follows the standard upstream form:

```bash
NODE=<node-name>
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" \
 | jq '.kubeletconfig | {
 evictionHard,
 evictionSoft,
 evictionSoftGracePeriod,
 evictionPressureTransitionPeriod,
 imageMinimumGCAge,
 imageGCHighThresholdPercent,
 imageGCLowThresholdPercent
 }'
```

When the on-disk values (rather than the live, in-effect values) are needed — for instance to confirm which fields a node operator has explicitly overridden versus which are still defaults — the second supported probe is to read `/var/lib/kubelet/config.yaml` directly on the node.

On a freshly installed v4.3.0-online cluster with Kubernetes v1.34.5 on Ubuntu 22.04, `configz` reports the following baseline values, which match the stock upstream kubelet defaults rather than an ACP-specific override:

| Field | Default value |
| --- | --- |
| `evictionHard.memory.available` | `100Mi` |
| `evictionHard.nodefs.available` | `10%` |
| `evictionHard.nodefs.inodesFree` | `5%` |
| `evictionHard.imagefs.available` | `15%` |
| `evictionHard.imagefs.inodesFree` | `5%` |
| `evictionHard.pid.available` | `10%` |
| `imageMinimumGCAge` | `2m0s` |
| `imageGCHighThresholdPercent` | `85` |
| `imageGCLowThresholdPercent` | `80` |
| `evictionPressureTransitionPeriod` | `5m0s` |

Because the kubelet on ACP is configured by the on-disk YAML file directly, the supported probes for the in-effect values are limited to the live `configz` proxy view and the per-node file at `/var/lib/kubelet/config.yaml`; there is no cluster-scoped resource to query for a rendered view.

## Diagnostic Steps

To establish a baseline before changing anything, capture the live configuration from the apiserver `configz` proxy for the node in question; the JSON returned is the authoritative view of what the kubelet is using at that moment:

```bash
NODE=<node-name>
kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" \
 | jq '.kubeletconfig'
```

If a value reported by `configz` does not match what an operator expects to see, compare against the on-disk file. The on-disk YAML and the live `configz` view will agree on any field that carries an explicit non-sentinel value; fields whose on-disk value is `0s` or `null` are replaced at runtime with the kubelet's built-in defaults, so `configz` will show the substituted value rather than the literal `0s` / `null` recorded on disk.

If a step in an unrelated workflow expects a cluster-scoped kubelet-config object to query, no such object exists on ACP; the two probes above (`configz` for live values, `/var/lib/kubelet/config.yaml` for on-disk values) are the only supported surfaces for inspecting GC and eviction settings on a node.
