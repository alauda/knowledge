---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500728
---

# ArgoCD repo-server DNS lookups leak upstream because of pod ndots:5 search expansion

## Issue

The Alauda Build of Argo CD `argocd-gitops-repo-server` pods in the `argocd` namespace fail to resolve names that should be served by the in-cluster DNS, and the upstream resolver behind CoreDNS starts receiving cluster-internal-looking queries. The repo-server then surfaces repository-fetch or webhook-target lookup failures, and the Argo CD UI may become unreachable.

On a representative cluster (`v1.34.5`), every pod in the `argocd` namespace runs with `dnsPolicy=ClusterFirst` and no `dnsConfig` override, so they all inherit the kubelet-generated `/etc/resolv.conf` defaults. Reading the configuration that drives that file confirms the standard cluster service search list — `<namespace>.svc.cluster.local`, `svc.cluster.local`, `cluster.local` — is appended to every short name.

The diagnostic signature in the CoreDNS query log is a lookup whose name has the cluster domain glued on twice, for example an `AAAA` query for `argocd-gitops-repo-server.argocd.svc.cluster.local.argocd.svc.cluster.local` that returns `NXDOMAIN`.

## Root Cause

A pod whose `dnsPolicy` is `ClusterFirst` and which does not override `spec.dnsConfig.options` receives `options ndots:5` in `/etc/resolv.conf`, alongside the cluster service search list and the in-cluster DNS server address. The same file lists the namespace-scoped, service-wide, and cluster-wide search domains so the libc resolver knows how to expand short service names.

Under `ndots:5`, the libc resolver looks at the input name: when it contains fewer than five dots, the resolver appends each search domain in turn and queries the resulting names BEFORE it attempts the original name as an absolute query. Each search-domain attempt produces a concatenated query name — the input glued onto a cluster suffix — for example `svc.cluster.local.<namespace>.svc.cluster.local` or `svc.cluster.local.svc.cluster.local`.

CoreDNS is authoritative only for the `cluster.local` zone, so a search-expanded name that does not match a real Service or Pod record is returned as `NXDOMAIN`; the same configuration forwards non-`cluster.local` names upstream. The combined effect is that any name in the GitOps pod with fewer than five dots — including names that already end in `.cluster.local` but happen to have only two or three dots in their input form — fans out into several search-domain-appended lookups first, each of which is answered authoritatively as `NXDOMAIN` by CoreDNS and at least one of which can be forwarded upstream, which is the article's reported symptom of internal lookups landing on the external DNS server.

## Resolution

The fix is to lower the `ndots` threshold on the affected pod template so the resolver treats short names as absolute first and only falls back to search expansion when the absolute lookup itself fails. The `spec.dnsConfig.options` field is a generic pod-spec field that takes a list of `name`/`value` pairs and merges into the `dnsPolicy`-generated base.

Patch the repo-server pod template — for the Alauda Build of Argo CD this is the `argocd-gitops-repo-server` Deployment in the `argocd` namespace — to set `ndots:1`:

```yaml
spec:
  template:
    spec:
      dnsConfig:
        options:
        - name: ndots
          value: "1"
```

Apply the patch with `kubectl`:

```bash
kubectl -n argocd patch deployment argocd-gitops-repo-server \
  --type=strategic \
  -p '{"spec":{"template":{"spec":{"dnsConfig":{"options":[{"name":"ndots","value":"1"}]}}}}}'
```

After the rollout, every new repo-server pod receives `options ndots:1` in `/etc/resolv.conf` instead of the default `ndots:5`, while the search list and nameserver remain the cluster defaults. With `ndots:1`, any name with at least one dot is queried as absolute first, so the doubled-suffix expansion path stops firing on the workload.

For one-off scripts and external hostnames it is also valid to append a trailing dot to the name. A trailing dot marks the name as fully-qualified, and the resolver skips search-domain expansion and queries the name directly even when `ndots:5` is still in effect.

## Diagnostic Steps

Confirm the pod template still uses the cluster default DNS settings — `dnsPolicy=ClusterFirst` with an empty `dnsConfig` block means the kubelet-default `options ndots:5` and the cluster search list will be written into every new pod:

```bash
kubectl -n argocd get deployment argocd-gitops-repo-server \
  -o jsonpath='dnsPolicy={.spec.template.spec.dnsPolicy} dnsConfig={.spec.template.spec.dnsConfig}{"\n"}'
```

Read the actual file from inside a running repo-server pod to confirm the on-pod resolver configuration — expected default content is `search <namespace>.svc.cluster.local svc.cluster.local cluster.local`, the in-cluster DNS server address on the `nameserver` line, and `options ndots:5`:

```bash
kubectl -n argocd exec deployment/argocd-gitops-repo-server -- cat /etc/resolv.conf
```

To observe the search-domain re-expansion the issue describes, trigger a lookup of a short name from inside the pod — for example `kubectl -n argocd exec deployment/argocd-gitops-repo-server -- nslookup <short-name>` — and inspect the cluster DNS query log. With CoreDNS query logging enabled, an input name with fewer than five dots produces a series of search-domain-appended queries before any absolute query, and the doubled-suffix variants return `NXDOMAIN`; this is the same diagnostic signature reported in the issue and is the wire-level evidence that the workload is hitting the `ndots:5` path.

After applying the `ndots:1` patch, the same probe from a new repo-server pod issues a single absolute query for the same input name and no longer generates the doubled-suffix `NXDOMAIN` lookups, which is the expected post-fix behavior.
