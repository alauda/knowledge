---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

A `TempoStack` configured with a Redis cache for query results needs the Redis password in its CR. The natural Kubernetes idiom is to reference a `Secret`:

```yaml
spec:
  template:
    queryFrontend:
      cache:
        redis:
          # What you'd expect — a secret reference.
          passwordSecretRef:
            name: redis-creds
            key:  password
```

That shape is rejected by the current TempoStack CRD — the only field accepted at that location is a plaintext password string:

```yaml
spec:
  template:
    queryFrontend:
      cache:
        redis:
          password: "plaintext-password-value"       # the only supported shape today
```

This note explains what the constraint is, how to minimise its impact, and where the improvement is being tracked.

## The Constraint

In current TempoStack operator builds, the `redis.password` field is a plain string. There is no `passwordSecretRef` variant that pulls from a `Secret`. Any change to the password has to go through editing the CR itself, which means:

- The password appears in the YAML that is version-controlled (Git) or applied via `kubectl apply -f`.
- Any dump of the CR (`kubectl get tempostack -o yaml`, `kubectl describe`) includes the plaintext.
- An operator running `kubectl edit tempostack` sees the password in the editor.
- `kubectl` auditlog records the value.

For environments with any secret-management posture (Vault, Sealed Secrets, External Secrets, SOPS), this is a gap — every other credential in those environments is Secret-backed.

## Workarounds

Until the CRD adds a Secret-reference variant, the practical options are all "keep the plaintext out of human-visible Git history" patterns:

### 1 — SOPS (or equivalent) on the Git source

Encrypt the CR in Git so Git history does not contain the plaintext, but the applied object still carries the plain string:

```bash
# One-time setup: configure SOPS with age / KMS / GPG.
sops --encrypt --in-place tempostack.yaml

# At deploy time, decrypt then apply.
sops --decrypt tempostack.yaml | kubectl apply -f -
```

Cluster-side, the CR still has the plaintext password in `spec.template.queryFrontend.cache.redis.password`, so `kubectl get ... -o yaml` still shows it. But Git never sees it clear.

### 2 — External Secrets Operator (ESO) writes the CR through templating

If the cluster runs ESO, keep the password in Vault / AWS Secrets Manager / Azure Key Vault and let ESO render the TempoStack CR through its templating:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: tempostack-redis-password-templater
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-cluster-store
    kind: ClusterSecretStore
  target:
    name: tempostack-redis-plaintext
    template:
      engineVersion: v2
      data:
        password: "{{ .password }}"
  dataFrom:
    - extract:
        key: tracing/tempo/redis
```

Then a small controller / job / Kustomize post-process step reads `tempostack-redis-plaintext` and generates the TempoStack CR with the password interpolated. Heavy — but avoids having plaintext in Git.

### 3 — Inline and rotate regularly

If the other workarounds are not feasible, accept the inline password and compensate with rotation discipline:

- Set a short TTL on the Redis user's password (weekly / monthly rotation).
- Automate the rotation so changing the password is one action (update Vault → update TempoStack CR → cycle the stack), not a multi-step human process.
- Audit `kubectl get tempostack` access tightly via RBAC so only a small group can read the password.

This is the weakest option; use only when the risk of plaintext in-cluster is acceptable for the deployment's security posture.

### What does not work today

- Putting a fake value in the CR and overriding at runtime via an environment variable — the Tempo Query process reads the password from the rendered config file the operator writes, not from its environment.
- Using a `Secret` projected as a file and telling the operator to read it — the CRD accepts only the inline string; it does not have a field for a file path.

## Tracking

A Request-for-Enhancement is tracked upstream to add `passwordSecretRef` (or an equivalent `Secret`-reference variant) to the TempoStack CRD. Follow the Tempo / tracing component's release notes for the fix. Once the field is exposed, the CR becomes:

```yaml
spec:
  template:
    queryFrontend:
      cache:
        redis:
          passwordSecretRef:
            name: redis-creds
            key:  password
```

— and the cluster's standard Secret-management tooling applies as it would for any other password-bearing component.

## Diagnostic Steps

Confirm the CRD's current schema does not accept a secret-reference field:

```bash
kubectl get crd tempostacks.tempo.grafana.com -o json | \
  jq '.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties.template.properties.queryFrontend.properties.cache.properties.redis.properties' 2>/dev/null | \
  jq 'keys'
# Likely output: [ "addr", "database", "db", "expiration", "masterName", "password", "tls", "username" ]
# (no "passwordSecretRef" or similar).
```

The absence of a secret-reference key is the confirmation.

Inspect an existing TempoStack to see how the current deployment handles the password:

```bash
kubectl -n <tempo-ns> get tempostack <name> -o yaml | \
  yq '.spec.template.queryFrontend.cache.redis'
# password: "<plain>"
```

If the plaintext is visible here, the workaround chosen should focus on keeping this value out of Git + rotation discipline, until the upstream RFE lands.

After the upstream fix reaches the cluster, migrate the CR to `passwordSecretRef`, remove the plaintext field, and drop the workaround. Re-run the schema query to confirm `passwordSecretRef` is now listed among the available fields.
