---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Shape of per-namespace default tolerations via the PodTolerationRestriction admission plugin on ACP

## Overview

A common scheduling pattern on upstream Kubernetes is to pin every pod created in a given namespace onto a dedicated pool of tainted nodes by attaching a default toleration set at the namespace level, rather than editing every workload's PodSpec. The mechanism is owned by an admission plugin — `PodTolerationRestriction` — that reads two annotations on the pod's `Namespace` and either merges default tolerations into incoming pods or rejects pods whose tolerations fall outside a per-namespace whitelist. The plugin lives in the kube-apiserver admission chain, not in the scheduler, so its effect is gated by what the apiserver is configured to load.

On an Alauda Container Platform cluster running kube-apiserver image `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5` (Kubernetes v1.34.5), the apiserver's loaded mutating and validating admission chains do not include `PodTolerationRestriction`. The `DefaultTolerationSeconds` plugin that appears in the chain is a different upstream plugin — it sets a `tolerationSeconds` default on `NoExecute` tolerations and does not perform per-namespace default injection or whitelist enforcement. As a result, the namespace-annotation mechanism described here is a **shape-of-solution** reference on ACP rather than an out-of-the-box recipe: setting the annotations on a `Namespace` is harmless and accepted by the API, but no admission plugin in the default ACP apiserver chain will act on them.

## Resolution

Treat this article as describing the shape of the upstream mechanism. To make the annotations active on an ACP cluster, the kube-apiserver static-pod manifest would have to be edited to add `PodTolerationRestriction` to `--enable-admission-plugins`; that change is outside the scope of normal cluster operations and is not covered here. The remainder of this section documents the annotation and node-side primitives so that, if and when the plugin is enabled, the supporting node configuration is already in place.

The two annotations sit on a `Namespace` object. `Namespace.metadata.annotations` is a `map[string]string`, so it accepts arbitrary keys; the value of the default-tolerations annotation must be a JSON-encoded array of toleration objects whose entries carry the standard fields: `key`, `operator` (`Equal` or `Exists`), `value`, `effect` (`NoSchedule`, `PreferNoSchedule`, or `NoExecute`), and `tolerationSeconds`. When `key` is empty, `operator` must be `Exists`; that combination matches every key and every value (the tolerate-all idiom).

Apply the annotation with `kubectl annotate`. The value is a single quoted JSON string:

```bash
kubectl annotate namespace <namespace> \
  scheduler.alpha.kubernetes.io/defaultTolerations='[{"key":"role","operator":"Equal","value":"infra","effect":"NoSchedule"}]'
```

The companion whitelist annotation has the same JSON shape:

```bash
kubectl annotate namespace <namespace> \
  scheduler.alpha.kubernetes.io/tolerationsWhitelist='[{"key":"role","operator":"Equal","value":"infra","effect":"NoSchedule"}]'
```

On the node side, the targeted node pool is prepared with a label and a matching taint using native `kubectl` verbs. A role label marks the node as belonging to the dedicated pool:

```bash
kubectl label node <node> node-role.kubernetes.io/infra=
```

The taint that the default toleration is designed to tolerate uses the standard `Node.spec.taints` shape — a list of entries with a required `key`, an optional `value`, and a required `effect` chosen from `NoSchedule`, `PreferNoSchedule`, or `NoExecute`:

```bash
kubectl taint nodes <node> role=infra:NoSchedule
```

With both sides in place, only pods whose `tolerations` match the taint can land on the labeled nodes; on a cluster where the admission plugin is also loaded, pods created in the annotated namespace would receive the matching toleration through the admission chain rather than through per-pod manifest edits.

## Diagnostic Steps

Confirm whether the admission plugin is active before relying on the namespace-annotation behavior. The apiserver's loaded plugin chains can be read out of its `--enable-admission-plugins` flag in the static-pod manifest; the ACP control-plane in the verified environment loads 14 mutating and 15 validating plugins and `PodTolerationRestriction` is in neither list — so on that apiserver, the annotations are inert and the default-injection / whitelist behavior described above will not be observed.

Once the prerequisites are met (apiserver enables the plugin, namespace carries the annotation, target nodes carry the matching label and taint), verify pod placement by creating a workload in the annotated namespace and inspecting the resulting node assignment with native `kubectl`. The `-o wide` column set includes the `NODE` field, which is the most direct read on where the scheduler placed each pod:

```bash
kubectl get pods -n <namespace> -o wide
```

A pod that lands on a node from the prepared pool confirms the toleration chain end-to-end; a pod that fails to schedule (`FailedScheduling` event citing `untolerated taint`) indicates either that the admission plugin did not inject the default toleration (most likely the plugin is not enabled) or that the pod's effective tolerations do not match the node's taint. Cross-check the pod's `spec.tolerations` against the node's `spec.taints` to localize the mismatch.
