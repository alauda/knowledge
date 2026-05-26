---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500006
---

# Reducing upstream DNS query load with the CoreDNS cache directive on ACP

## Issue

On Alauda Container Platform the cluster DNS is provided by CoreDNS, and the built-in CoreDNS `cache` plug-in is the only in-cluster DNS caching layer; the Kubernetes community NodeLocal DNSCache add-on is not present as a separate caching mechanism on this platform [ev:c10]. On install package v4.3.4 the cluster DNS runs from container image `registry.alauda.cn:60080/tkestack/coredns:1.14.2-v4.3.4` in the `kube-system` namespace, with its `cache` behavior defined in the `cpaas-coredns` Corefile [ev:c10]. When caching is tuned conservatively, identical and repeatedly-failing lookups from pods are forwarded to the upstream resolver more often than necessary, raising the query load that the cluster pushes to the external recursive resolver [ev:c9].

## Root Cause

The CoreDNS `cache` plug-in shapes how long responses are held before a fresh upstream query is issued, and the cache lifetime determines how aggressively repeated lookups are collapsed [ev:c9]. With local caching in effect, identical DNS lookups originating from many pods on the same node are answered from the local cache for the cache lifetime rather than each producing its own upstream query, which reduces the load forwarded to the upstream resolver [ev:c9]. Negative responses are governed separately: when negative caching is disabled, every failed (NXDOMAIN) lookup produces a fresh query to the upstream resolver instead of being served locally [ev:c5].

## Resolution

On ACP the cache behavior is controlled through the `cache` directive in the `cpaas-coredns` Corefile rather than through named positive/negative TTL fields [ev:c4]. The directive carries a single positional TTL value and uses `disable` sub-directives to turn caching off per response class and per zone; the standard form caches for the positional TTL while disabling both success and denial caching for the in-cluster zone [ev:c4]. The Corefile fragment follows this shape [ev:c4]:

```text
cache 30 {
    disable success cluster.local
    disable denial cluster.local
}
```

Caching of negative (NXDOMAIN) responses is controlled by the `disable denial` sub-directive on a per-zone basis [ev:c4]. In the shipped Corefile the only zone listed is `cluster.local`, so negative caching is turned off for the in-cluster zone and each failed lookup for `cluster.local` produces a fresh upstream query rather than being served from the local cache [ev:c5]. For a zone that is left out of `disable denial`, negative responses would instead be held by the `cache` plug-in for the positional cache lifetime; the general CoreDNS rationale for keeping negative caching on is that repeated failed lookups within the cache window can be answered locally instead of going upstream, but note that the running configuration does not exercise this for `cluster.local` — it disables it [ev:c5].

## Diagnostic Steps

Confirm which caching layer is in effect: CoreDNS is the cluster DNS and the built-in `cache` plug-in is the only caching layer, with no separate node-local DNS cache DaemonSet present cluster-wide [ev:c10]. Inspect the running CoreDNS configuration to read the active `cache` directive [ev:c10]:

```bash
kubectl get configmap cpaas-coredns -n kube-system \
  -o jsonpath='{.data.Corefile}'
```

Read the cluster DNS image tag to confirm the running version [ev:c10]:

```bash
kubectl get deploy coredns -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

The running configuration sets the positional TTL to `30` on the `cache` directive, so positive responses are held for that lifetime; the live Corefile shows `cache 30`, not `cache 0`, so behavior under a `0` TTL is not exercised here and is not asserted for this cluster [ev:c4]. Inspect whether negative responses are being cached by checking the zones listed under `disable denial`: a zone present there is not negatively cached, so failed lookups for it reach the upstream resolver on every attempt [ev:c5].
