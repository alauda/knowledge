---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A repository entry in the Argo CD UI is stuck in `Failed` status because the URL was entered incorrectly — missing scheme, invalid port, malformed host, or some other syntactic problem that Argo CD cannot parse. Attempting to remove the repository through the UI has no effect: clicking **Delete** either returns an error or silently leaves the row in place.

## Root Cause

Argo CD stores every repository definition as a Kubernetes `Secret` in the Argo CD namespace, labelled `argocd.argoproj.io/secret-type=repository`. The UI delete path validates and re-parses the repository URL before it issues the actual delete against the API; when the stored URL is malformed it cannot parse, the validation step fails, and the subsequent delete never runs.

This is tracked as an upstream issue in the Argo CD project — see [argo-cd#8614](https://github.com/argoproj/argo-cd/issues/8614) for the bug and the workaround. The underlying object is a plain `Secret`, so deleting it through the Kubernetes API bypasses the broken UI path completely.

## Resolution

On ACP the GitOps capability is provided by the `gitops` component, which is itself based on Argo CD. The namespace hosting the Argo CD control plane is typically `cpaas-system` or whichever namespace your platform has configured for the GitOps instance; adjust the commands below to match.

1. List every repository secret in the Argo CD namespace. They all start with `repo-`:

   ```bash
   kubectl -n cpaas-system get secrets | grep '^repo-'
   ```

   Example output:

   ```text
   repo-3148156268   Opaque   3   19s
   ```

2. Decode the secret to confirm it is the one you want to remove. The repository URL is base64-encoded under `.data.url`:

   ```bash
   kubectl -n cpaas-system get secret repo-3148156268 -o jsonpath='{.data.url}' | base64 -d
   kubectl -n cpaas-system get secret repo-3148156268 -o jsonpath='{.data.type}' | base64 -d
   kubectl -n cpaas-system get secret repo-3148156268 -o jsonpath='{.data.project}' | base64 -d
   ```

3. Delete the secret. Argo CD watches the secrets in its namespace, so the repository disappears from the UI within a few seconds:

   ```bash
   kubectl -n cpaas-system delete secret repo-3148156268
   ```

4. Refresh the Argo CD repositories page in the UI and confirm the row is gone.

If the repository was referenced by an `Application`, that `Application` will move to `ComparisonError` after the delete. Either fix the URL and re-add the repository, or edit the `Application` to point at a valid source. The UI will now accept both operations because it no longer has to parse a malformed URL first.

## Diagnostic Steps

If the secret name is not obvious from the list, match on URL content. The `data.url` field is base64-encoded but `grep` will find the right one once you decode in a loop:

```bash
for SECRET in $(kubectl -n cpaas-system get secret -o name | grep '^secret/repo-'); do
  URL=$(kubectl -n cpaas-system get "$SECRET" -o jsonpath='{.data.url}' | base64 -d)
  echo "$SECRET -> $URL"
done
```

Inspect the argocd-repo-server logs for the original parse failure — it confirms the root cause and is useful evidence when filing a ticket with an operator:

```bash
kubectl -n cpaas-system logs -l app.kubernetes.io/name=argocd-repo-server --tail=100
```

After deletion, verify Argo CD has reconciled its in-memory cache by fetching the API directly through a port-forward to the argocd-server service — the REST response should no longer include the deleted repository:

```bash
kubectl -n cpaas-system port-forward svc/argocd-server 8080:443 &
curl -sk https://localhost:8080/api/v1/repositories \
  -H "Authorization: Bearer <argocd-token>" \
  | jq '.items[].repo'
```

An absence of the offending URL confirms the fix has propagated through the Argo CD control plane.
