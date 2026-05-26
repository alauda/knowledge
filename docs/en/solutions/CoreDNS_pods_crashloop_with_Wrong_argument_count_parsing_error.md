---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500017
---

# CoreDNS pods crash-loop with a "Wrong argument count" Corefile parse error

## Issue

The cluster DNS is served by CoreDNS, which runs as the `coredns` Deployment in the `kube-system` namespace and reads its configuration from a Corefile [ev:c1]. On Alauda Container Platform v4.3.4 the Corefile is supplied by the ConfigMap `kube-system/cpaas-coredns` (data key `Corefile`), mounted into the container at `/etc/coredns` and loaded through the container argument `-conf /etc/coredns/Corefile` [ev:c1]. The DNS pods run CoreDNS 1.14.2 (image `registry.alauda.cn:60080/tkestack/coredns:1.14.2-v4.3.4`) [ev:c1].

When the Corefile contains a `forward` plugin block whose zone is not followed by at least one upstream, CoreDNS fails to parse the Corefile at startup [ev:c3]. The CoreDNS process then exits and the DNS pods enter `CrashLoopBackOff`, with the container terminating with reason `Error` (exit code 1), never reaching `Ready`, and the restart count climbing [ev:c5].

## Root Cause

A `forward` block declares a FROM zone followed by one or more TO upstreams. A block such as `forward .` that names the zone but lists no upstream is incomplete, and the CoreDNS parser rejects it [ev:c3]. Because the configuration cannot be loaded, the process aborts at startup rather than serving DNS [ev:c5].

The failure is surfaced in the CoreDNS container log as a parse error that names the `forward` plugin together with the Corefile path and the offending line number [ev:c4]:

```text
plugin/forward: /etc/coredns/Corefile:3 - Error during parsing: Wrong argument count or unexpected line ending after '.'
```

## Resolution

Correct the Corefile so that every `forward` block lists at least one upstream after its zone [ev:c8]. For the default zone forwarding to the node resolver, the well-formed block is:

```text
.:1053 {
    errors
    forward . /etc/resolv.conf
}
```

Once the upstream is present, CoreDNS parses the configuration successfully — the restarted pod logs the `CoreDNS-1.14.2` startup banner with no `Error during parsing` line and returns to a running state (`Running`, ready, restart count 0) [ev:c8].

## Diagnostic Steps

Inspect the CoreDNS workload and pods in `kube-system` to confirm they are crash-looping [ev:c1][ev:c5]:

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get deploy coredns -o jsonpath='{.spec.template.spec.containers[0].image}'
```

Read the CoreDNS container log to find the parse error; it names the `forward` plugin and the Corefile line that is malformed [ev:c4]:

```bash
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=30
```

Examine the Corefile to locate the `forward` block that has no upstream after its zone [ev:c3]:

```bash
kubectl -n kube-system get configmap cpaas-coredns -o jsonpath='{.data.Corefile}'
```
