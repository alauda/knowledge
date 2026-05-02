---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Import Every Key-Value Pair From an External Secret Path in a Single ExternalSecret
## Issue

An `ExternalSecret` backed by a cloud / vault secret store — HashiCorp Vault, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager, etc. — needs to mirror **all** the key-value pairs stored under a specific path into a cluster `Secret`. Using the standard `spec.data[]` field requires enumerating every key explicitly:

```yaml
spec:
  data:
    - secretKey: username
      remoteRef: { key: internal/myapp/secrets, property: username }
    - secretKey: password
      remoteRef: { key: internal/myapp/secrets, property: password }
    - secretKey: api_key
      remoteRef: { key: internal/myapp/secrets, property: api_key }
```

This becomes hard to maintain when the external store holds dozens of keys or when keys are added / removed over time (the `ExternalSecret` manifest would need to be updated in lockstep). The question is how to say "just mirror everything under this path" once and not maintain the enumeration.

## Resolution

The External Secrets Operator (`external-secrets.io`) exposes a `spec.dataFrom` field that performs exactly this operation — fetch every key-value under a referenced path and materialise them as keys of the resulting cluster `Secret`.

### Replace `data` with `dataFrom`

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: myapp-secret
  namespace: myapp
  labels:
    app: myapp
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-cluster-store
    kind: ClusterSecretStore
  target:
    name: myapp-secret
    creationPolicy: Owner
  dataFrom:
    - extract:
        key: internal/myapp/secrets
```

After applying, the operator fetches every key-value pair under `internal/myapp/secrets` on the external store and writes them all into a cluster `Secret` named `myapp-secret`:

```bash
kubectl -n myapp get secret myapp-secret -o jsonpath='{.data}' | jq 'keys'
# [ "api_key", "password", "username" ]
```

If the source gains a fourth key tomorrow, the next refresh (governed by `refreshInterval`, default 1h) picks it up automatically. No manifest change required.

### Useful variants of `dataFrom`

`dataFrom` accepts a few different selection modes, each matching a different lookup need:

**`extract` — one source path, all its keys** (the example above):

```yaml
dataFrom:
  - extract:
      key: internal/myapp/secrets
```

**`find` — match every secret path by name regex**. Useful when you want, say, every path under `internal/myapp/` to be mirrored:

```yaml
dataFrom:
  - find:
      name:
        regexp: "^internal/myapp/"
```

Each matching path contributes its keys. Collisions (two paths containing the same key name) are resolved by whichever path the operator fetched last — keep key names unique across matched paths to avoid ambiguity.

**`rewrite` — rename keys on the fly**. Useful when the source paths use snake-case but the application expects camelCase, or to scope keys with a prefix:

```yaml
dataFrom:
  - extract:
      key: internal/myapp/secrets
    rewrite:
      - regexp:
          source: "^(.*)$"
          target: "myapp_$1"
```

Every key gets prefixed with `myapp_` in the cluster `Secret`.

### Combining `data` and `dataFrom`

The two fields are compatible; use them together when you need a mix of "copy these two specific keys with renames" and "also mirror everything from this bulk path":

```yaml
spec:
  data:
    - secretKey: SPECIAL_KEY
      remoteRef: { key: internal/special, property: value }
  dataFrom:
    - extract:
        key: internal/myapp/secrets
```

Keys from the `data` section take precedence on name collisions.

### Target Secret type

Some callers require the rendered `Secret` to have a specific type (`kubernetes.io/dockerconfigjson`, `kubernetes.io/tls`, etc.). Set `spec.target.template` to control the rendered shape:

```yaml
spec:
  target:
    name: myapp-secret
    template:
      type: kubernetes.io/dockerconfigjson
      data:
        .dockerconfigjson: |
          {
            "auths": {
              "registry.example.com": {
                "username": "{{ .username }}",
                "password": "{{ .password }}"
              }
            }
          }
  dataFrom:
    - extract:
        key: internal/myapp/secrets
```

The template pulls from the fetched keys (`username`, `password` in this example) and produces a dockerconfigjson-formatted secret. This is the right shape for imagePullSecret use cases where the external store holds the credentials but the cluster needs them in dockerconfig format.

## Diagnostic Steps

Confirm the `ExternalSecret` is synchronising:

```bash
kubectl -n <ns> get externalsecret <name> -o \
  jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
# Ready=True SecretSynced
```

`Ready=True` means the operator has successfully fetched and materialised the keys. Any other state (`Ready=False`, `SecretSyncedError`) surfaces the specific error in `.status.conditions[].message`.

Confirm the target Secret carries the expected keys:

```bash
kubectl -n <ns> get secret <name> -o jsonpath='{.data}' | jq 'keys'
```

The listed keys should match what the source path contains. If some are missing, inspect the external store directly to confirm they actually exist at the path:

```bash
# For Vault:
vault kv get -format=json internal/myapp/secrets | jq '.data.data | keys'
```

Compare with the cluster Secret's keys. A mismatch indicates either a permission issue (the SecretStore's credentials cannot read all keys at that path) or a path mismatch (the `extract.key` does not point where you think). Check the SecretStore's credential / role:

```bash
kubectl -n <ns> get secretstore <name> -o yaml | \
  yq '.spec.provider'
```

Enable debug logging on the external-secrets controller briefly if the issue is not obvious — the log line for each fetch includes the exact path and the number of keys returned.

After a refresh interval (or an on-demand trigger via `kubectl annotate externalsecret <name> force-sync=$(date +%s)` if the operator supports the annotation), keys that were added to the external store since the last sync appear in the cluster Secret automatically. The whole point of `dataFrom` is that you do not have to edit the manifest when that happens.
