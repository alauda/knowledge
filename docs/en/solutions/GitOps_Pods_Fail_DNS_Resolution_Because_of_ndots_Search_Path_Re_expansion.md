---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# GitOps Pods Fail DNS Resolution Because of ndots Search Path Re-expansion
## Issue

The Argo CD console becomes unreachable from inside the cluster, and CoreDNS query logs (or the upstream resolver's logs) show a flood of `NXDOMAIN` answers for hostnames that look doubled up:

```text
[INFO] 172.22.4.14:41816 - 10265 "AAAA IN argocd-repo-server.argocd.svc.cluster.local.argocd.svc.cluster.local. udp 127 false 1232" NXDOMAIN qr,aa,rd 209 0.000090059s
```

The cluster service domain (here, `argocd.svc.cluster.local`) is appended a second time to a name that already carried it. Because the doubled name does not exist, every lookup eventually escapes to the configured upstream resolver — which then sees private cluster names it cannot resolve, generating noise and per-query latency on top of the actual failure.

## Root Cause

This is the standard "`ndots` search-path re-expansion" trap, made visible by an in-cluster client that happened to pass a fully qualified service name without a trailing dot.

The kubelet writes a `resolv.conf` into every pod that includes a `search` list of cluster suffixes (typically `<ns>.svc.cluster.local`, `svc.cluster.local`, `cluster.local`, plus any node-level domains) and `options ndots:5` (or similar). The resolver behaves as follows:

- Any hostname with **fewer than `ndots` dots** is considered "relative" and is tried first against every entry in the `search` list, in order, before being tried as an absolute name.
- A name like `argocd-repo-server.argocd.svc.cluster.local` has exactly four dots — one short of the `ndots:5` threshold — so the resolver re-applies the search list to it. The first try concatenates the namespace's own suffix, producing the double-suffix name in the log.

Because the doubled name does not exist, the resolver only succeeds when it falls back to trying the original name as absolute, after exhausting the search list. Each request therefore costs one or two extra round-trips to CoreDNS plus, in some configurations, an upstream lookup with the wrong domain.

The application code is not technically wrong — passing the full FQDN is a reasonable choice — but combined with the cluster's `ndots` policy it produces this pattern. Until the upstream Argo CD components either set `dnsConfig.options.ndots` lower or always append a trailing dot to internal hostnames, the search-path expansion will keep happening.

## Resolution

Several fixes are available; they are not mutually exclusive.

1. **Lower `ndots` for the affected workload.** This is the cleanest fix and avoids modifying the application. Set `dnsConfig.options.ndots` to `2` (or `1`) on the relevant Deployments — once the value is below the dot count of the FQDN, the resolver will treat the hostname as absolute on the first try:

   ```yaml
   spec:
     template:
       spec:
         dnsConfig:
           options:
             - name: ndots
               value: "2"
         dnsPolicy: ClusterFirst   # keep the default; just override ndots
   ```

   Apply to each Argo CD component that exhibits the symptom (`repo-server`, `application-controller`, `server`). The fix takes effect on the next pod restart.

2. **Make hostnames truly absolute by appending a trailing dot.** If the application is configurable, point it at `argocd-repo-server.argocd.svc.cluster.local.` (note trailing `.`). The libc resolver short-circuits the search-path expansion when it sees a name ending in `.`. This is preferable when the workload is third-party and the resolution behaviour must not be globally relaxed.

3. **Use a short, single-label form within the same namespace.** Inside the Argo CD namespace, the bare service name `argocd-repo-server` will resolve through the search path correctly on the first try. Long FQDNs are only needed when crossing namespaces.

After applying the fix, the doubled-suffix queries should disappear from the CoreDNS log and Argo CD should reach its repo server again.

## Diagnostic Steps

Confirm the cluster's `ndots` setting from inside an affected pod:

```bash
kubectl -n <ns> exec <pod> -- cat /etc/resolv.conf
# Look for: options ndots:5
# And:      search <ns>.svc.cluster.local svc.cluster.local cluster.local ...
```

Reproduce the doubled lookup deterministically to confirm the pattern is search-path expansion and not application logic.

The classical diagnostic is `kubectl debug -it <pod> --image=<image-with-dig> -- bash` followed by `dig +search +trace argocd-repo-server.argocd.svc.cluster.local`. This requires the debug image to (a) contain `dig` and (b) be pullable on the cluster — on isolated ACP clusters, public registries like `registry.k8s.io` may not be reachable. Use an image you already know is mirrored locally; the operations team can list what `bind-utils` / `dnsutils` images are available.

When no dnsutils image is available, observe the expansion from any in-cluster pod that ships `getent` (the glibc resolver follows the same `resolv.conf` rules):

```bash
# Pick any running pod in the affected namespace; exec into it and walk the
# resolution path with getent:
kubectl -n <ns> exec <pod> -- getent hosts argocd-repo-server.argocd.svc.cluster.local
kubectl -n <ns> exec <pod> -- cat /etc/resolv.conf
```

If `getent` is also missing, the third fallback is to read CoreDNS's query log directly. CoreDNS is deployed in `kube-system` on ACP; turn on the `log` plugin briefly and tail one of its pod logs while the application reproduces the failing request — the doubled-name `NXDOMAIN` lines will appear there.

If the trace shows the resolver attempting `<name>.<ns>.svc.cluster.local` first and getting `NXDOMAIN`, then attempting the original name and succeeding, the search-path expansion is confirmed.

Verify the fix took effect after redeploying:

```bash
kubectl -n <ns> exec <new-pod> -- cat /etc/resolv.conf | grep ndots
# Expect: options ndots:2
```

A drop in CoreDNS query rate against the affected service is the practical signal that the workload is no longer paying the search-path cost.
