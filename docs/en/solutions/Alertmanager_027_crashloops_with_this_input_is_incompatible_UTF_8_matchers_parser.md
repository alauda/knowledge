---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Alertmanager 0.27 crashloops with "this input is incompatible" — UTF-8 matchers parser
## Issue

After the cluster's monitoring stack rolls Alertmanager forward to the 0.27.x line, the Alertmanager pod (`alertmanager-kube-prometheus-0` or whatever the local naming convention is) goes into a crash loop. The startup log carries a parser error of the form:

```text
level=warn msg="Alertmanager is moving to a new parser for labels and matchers,
  and this input is incompatible. Alertmanager has instead parsed the input
  using the classic matchers parser as a fallback."
input="region=production EU"
err="18:20: unexpected EU: expected a comma or close brace"
suggestion="region=\"production EU\""
```

…sometimes followed by a hard validation failure such as `undefined receiver "frontend-team" used in route` that prevents Alertmanager from starting at all.

The same configuration ran fine on the previous Alertmanager line and was deployed unchanged.

## Root Cause

Alertmanager 0.27 introduces a new parser for label names and matcher values that follows the Prometheus UTF-8 spec — label and matcher tokens may now contain characters outside the classic `[a-zA-Z_][a-zA-Z0-9_]*` set, but only when properly quoted. The new parser is strict; older configurations that relied on the lenient pre-0.27 behaviour can fail to round-trip.

Two specific shapes are common:

- **Unquoted multi-word values**: a route `match` or a silence with `region=production EU` was accepted by the old parser; the new parser stops at the space and reports `unexpected EU: expected a comma or close brace`. The fix is to double-quote the value: `region="production EU"`.
- **Dotted label names**: labels like `host.name=value` or `kubernetes.pod.name=foo`. Under the new rules the dot is a UTF-8 special character and the *name* must be quoted: `"host.name"="value"`.

When the parser fails, Alertmanager falls back to the classic parser to keep the pod up — but if the same configuration also has a *separate* validation problem (an undefined receiver, a duplicated route, a malformed inhibit rule), that fallback path does not save it and the pod crashloops on the secondary error.

The crashloop is therefore the visible symptom of *two* compounded issues: a parser incompatibility that surfaces as warnings, and a pre-existing config error that the fallback parser cannot tolerate.

## Resolution

The fix is to make the configuration valid under the new UTF-8 matcher parser, then fix any unrelated validation errors. The quickest reliable way is to validate locally with `amtool` from the same Alertmanager version, *before* trying to deploy.

### 1. Export the running configuration

```bash
NS=<monitoring-namespace>
POD=alertmanager-kube-prometheus-0
kubectl exec -n "$NS" "$POD" -- \
  amtool config show --alertmanager.url http://localhost:9093 \
  > alertmanager-running.yml
```

### 2. Validate against the same Alertmanager version

Pull the Alertmanager 0.27.x image (whatever digest the cluster's monitoring stack ships) and run `amtool check-config` against the exported file. This is the same parser the live pod is running, so anything it complains about is what the live pod will complain about:

```bash
podman pull <alertmanager-0.27.x-image>
podman run -ti --rm \
  --entrypoint /usr/bin/amtool \
  -v "$(pwd)/alertmanager-running.yml:/tmp/running.yml:z" \
  <alertmanager-0.27.x-image> \
  check-config /tmp/running.yml
```

Read every warning. The "is moving to a new parser… input is incompatible" warning carries the exact suggestion to apply (`region="production EU"`, `"host.name"="value"`, etc.) — paste those suggestions back into the matcher.

### 3. Fix the unrelated errors `amtool` reports

`amtool` will also flag undefined receivers, duplicate route children, and malformed inhibit rules — the same errors that knock the pod out of fallback parsing. Resolve each one:

- `undefined receiver "frontend-team"` — define the receiver in the `receivers:` list, or rename the route's `receiver:` field to one that exists.
- Routes that no longer match anything → delete or merge with siblings.
- Inhibit rules with empty `equal:` lists → either populate or remove.

### 4. Re-apply through whatever shipped the configuration in the first place

If the configuration is owned by an `AlertmanagerConfig` CR (or the per-namespace equivalent), update the CR and let the operator render the merged config. If it is owned by a plain Secret named `kube-prometheus-alertmanager`, update the Secret and let the rollout pick it up:

```bash
kubectl create secret generic kube-prometheus-alertmanager \
  -n "$NS" \
  --from-file=alertmanager.yaml=alertmanager-running.yml \
  --dry-run=client -o yaml \
  | kubectl apply -f -
kubectl -n "$NS" rollout restart statefulset kube-prometheus-alertmanager
```

### 5. Watch the pod come up clean

```bash
kubectl logs -n "$NS" "$POD" --tail=100 -f \
  | grep -E 'matchers|parser|started|listen'
```

Healthy startup logs the listen address with no parser warnings.

## Diagnostic Steps

1. Confirm the failure is the matchers-parser one and not, e.g., a config-mounting problem. The fingerprint phrase is `Alertmanager is moving to a new parser for labels and matchers`. If that is in the logs, the parser is involved; if it is not, look elsewhere (image pull, volume mount, peer connectivity).

2. Walk every matcher in the configuration and count those that contain characters outside `[a-zA-Z_0-9-]` and are not double-quoted:

   ```bash
   grep -nE 'match(_re)?:' alertmanager-running.yml
   grep -nE 'matchers:' -A 10 alertmanager-running.yml
   ```

   Each match without quotes around values that contain spaces, dots, or other UTF-8 specials is a candidate for the warning.

3. Validate the corrected file *with the same image version* the cluster runs — there is no point validating against a different binary. The 0.27.x line is the strict one; older `amtool` will pass configs the live pod will reject.

4. If the cluster has a templating layer (Helm, Kustomize, CR-based Alertmanager configuration) producing the YAML, fix the **template**, not the rendered output. Otherwise the next reconcile will overwrite the manual fix and the pod will crash again. The amtool-validated YAML is your truth source for what the template needs to emit.
