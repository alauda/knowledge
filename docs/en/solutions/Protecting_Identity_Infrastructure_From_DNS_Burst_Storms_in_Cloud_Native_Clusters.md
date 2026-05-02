---
kind:
   - BestPractices
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500006
---

# Protecting Identity Infrastructure From DNS Burst Storms in Cloud-Native Clusters
## Overview

Migrating workloads from a small fleet of virtual machines to a high-density Kubernetes cluster changes the shape of the DNS traffic an upstream identity / DNS service has to absorb. A steady, low-rate stream of recursive queries is replaced by parallel bursts: a single Deployment that scales out by a few hundred pods, or a node that drains and reschedules its workload, can issue thousands of resolution requests within milliseconds.

When the upstream resolver is a BIND-backed Identity Management (IdM) service tuned for general-purpose use, the recursive-clients limit is usually the first ceiling that hits. Crossing it does not produce an obvious error: BIND silently drops the oldest waiting query to protect its own memory, the application sees a timeout, the IdM host shows low CPU and RAM, and the operator team is left chasing a phantom network problem.

This article describes a defense-in-depth strategy with two complementary changes:

- raise the recursive-client ceiling on the upstream BIND so that a burst does not trip a hard limit;
- enable caching on the in-cluster CoreDNS so that the burst never reaches the upstream in the first place.

## Root Cause

Each query that reaches the recursive resolver occupies a *recursive client slot* — a memory reservation that persists for the full round-trip through the DNS hierarchy. Under VM workloads the slot count rarely matters; under Kubernetes parallelism it becomes a hard ceiling.

The amplifier that makes it worse on a cluster is **search-domain expansion**. When a pod resolves a short name, the cluster resolver walks the search path before returning a positive answer:

```text
# Pod requests:  myapi
# Resolver expands through search domains:
1.  myapi.<namespace>.svc.cluster.local   -> NXDOMAIN  (upstream hit)
2.  myapi.svc.cluster.local                -> NXDOMAIN  (upstream hit)
3.  myapi.cluster.local                    -> NXDOMAIN  (upstream hit)
4.  myapi.example.com                      -> resolved (positive answer)
```

If the cluster-side cache is disabled, every pod restart, scale-out, or batch job re-runs that NXDOMAIN sequence and pushes the upstream toward its limit:

```text
# negativeTTL = 0:    100 pods x 3 NXDOMAIN x 5 services = 1,500 upstream queries
# negativeTTL = 10s:                              3 x 5  =    15 upstream queries
```

A 99% reduction in upstream pressure comes from a single cache-side change.

## Resolution

### Step 1: Lift the BIND Recursive-Client Ceiling

On the upstream IdM / BIND server, raise `recursive-clients` from the conservative default to a value that matches the cluster's parallelism:

```text
# /etc/named.conf  (or /etc/named/options.conf on IdM)
options {
    recursive-clients 10000;
};
```

A jump from 900 to 10,000 concurrent recursive clients costs roughly 50 MB of additional RAM on a modern resolver — under 1% of a 6 GB host. Reload `named` after the change and confirm the new limit took effect by inspecting the server's runtime statistics.

This step protects the upstream from being knocked over while the cluster-side cache is being rolled out. It is not a substitute for caching.

### Step 2: Enable Caching on the In-Cluster CoreDNS

The cluster runs CoreDNS as a DaemonSet — one resolver pod per worker node, handling all DNS for pods on that node. The `cache` plugin is loaded but, by default, both positive and negative TTLs are 0, which makes the local resolver behave as a pure pass-through.

The two parameters that matter:

- **positiveTTL** — how long a successful answer (a domain that resolves to an IP) is cached. The default of 0 defers to the TTL on the record itself, which for short-TTL internal services offers little protection during bursts.
- **negativeTTL** — how long an NXDOMAIN response is cached. This is the higher-leverage parameter, because the search-domain expansion above turns every short-name lookup into several NXDOMAIN queries.

A typical starting point is a 30–60 second positive TTL and a 10–30 second negative TTL. Tighten the positive TTL if your applications expect rapid record changes; loosen the negative TTL for read-heavy workloads.

Edit the CoreDNS Corefile via its ConfigMap and reload:

```yaml
# kubectl -n kube-system edit configmap coredns
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health { lameduck 5s }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
            max_concurrent 1000
        }
        cache {
            success 9984 30
            denial 9984 15
        }
        loop
        reload
        loadbalance
    }
```

After saving, restart the CoreDNS pods so they pick up the new Corefile:

```bash
kubectl -n kube-system rollout restart deployment coredns
kubectl -n kube-system rollout status deployment coredns --timeout=2m
```

Allow a few minutes for the cache to warm; the upstream should see traffic decline immediately and asymptote toward a small steady-state.

### Step 3: Validate End-to-End

Confirm caching is active by issuing two consecutive lookups from a test pod and comparing the latencies. The image must contain `dig`; public images such as `registry.k8s.io/e2e-test-images/jessie-dnsutils:1.7` may not be reachable from isolated clusters — substitute with any in-cluster mirror image that ships `bind-utils` / `dnsutils`:

```bash
kubectl run dns-probe --image=<image-with-dig> \
  --restart=Never --rm -it -- /bin/sh -c \
  'time dig +short kubernetes.default.svc.cluster.local; time dig +short kubernetes.default.svc.cluster.local'
```

The second query should complete in under a millisecond — proof the local cache served it. On the upstream side, BIND's `rndc stats` (or equivalent metrics) should show recursive client high-water mark well below the new ceiling.

## Diagnostic Steps

Inspect the live Corefile to confirm caching directives are present:

```bash
kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}' | grep -A2 cache
```

Watch CoreDNS metrics for cache hit ratio:

```bash
kubectl -n kube-system port-forward svc/kube-dns 9153:9153 &
curl -s http://localhost:9153/metrics | grep coredns_cache
```

A healthy deployment will show `coredns_cache_hits_total` increasing significantly faster than `coredns_cache_misses_total`. If the cache is cold (just deployed, or restarted) the ratio improves over the first several minutes; if it stays low, confirm that the `cache` block is loaded and that CoreDNS pods picked up the ConfigMap change.

When the upstream resolver still trips its client ceiling despite caching being enabled, profile a representative pod's `/etc/resolv.conf` for an unusually large `search` list — every additional search-domain entry multiplies the NXDOMAIN amplifier by another factor.
