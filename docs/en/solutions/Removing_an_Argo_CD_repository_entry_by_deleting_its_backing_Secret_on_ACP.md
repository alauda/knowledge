---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Removing an Argo CD repository entry by deleting its backing Secret on ACP

## Issue

On Alauda Container Platform, Argo CD is delivered through the `argocd-operator` bundle (argo-cd image v3.x) and the installer chart deploys an `ArgoCD` CR (`argoproj.io/v1beta1`) into the `argocd` namespace; the same upstream argo-cd binary backs the UI, so the standard Repository CR contract carries over unchanged. Because each UI-added repository is materialised as a Kubernetes Secret in that namespace, the platform-level lifecycle of a repository entry is the lifecycle of its Secret — an administrator who needs to remove a stuck or unwanted repository entry must operate on the Secret directly when the Argo CD UI is not a viable path.

## Resolution

Delete the underlying repository Secret in the `argocd` namespace; the entry disappears from the Argo CD UI because the UI's repository list is derived from the standard secret-based mechanism that ACP inherits from upstream argo-cd via the `argocd-operator` bundle. The Secret follows the standard upstream shape — labelled `argocd.argoproj.io/secret-type: repository` and conventionally named `repo-<hash>` — so a plain `kubectl delete secret` is sufficient and no Argo CD API call is required:

```bash
kubectl delete secret -n argocd repo-<hash>
```

Substitute `repo-<hash>` with the actual Secret name discovered via the diagnostic step below. Because the same secret-based mechanism applies on ACP as upstream, no operator-side reconciliation re-creates the entry from a separate source of truth once the Secret is gone.

## Diagnostic Steps

Identify the Secret that backs the target repository by listing every Secret whose name starts with `repo-` in the `argocd` namespace and decoding the `.data.url` field (base64) on each candidate to find the entry whose URL matches the offending repository. The Secret carries the standard upstream `.data` shape, so a one-shot jsonpath query plus `base64 -d` returns the URL set at repository-creation time:

```bash
kubectl get secret -n argocd \
 -l argocd.argoproj.io/secret-type=repository \
 -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.data.url}{"\n"}{end}' \
 | while IFS=$'\t' read name url; do
 echo "$name -> $(echo "$url" | base64 -d)"
 done
```

Match the decoded URL against the repository the UI shows as stuck, note the corresponding Secret name (the `repo-<hash>` value), and feed it into the deletion command in the Resolution section. The same lookup-by-label approach works for every repository entry on ACP because the Repository CR contract is unchanged from upstream argo-cd as packaged by `argocd-operator`.
