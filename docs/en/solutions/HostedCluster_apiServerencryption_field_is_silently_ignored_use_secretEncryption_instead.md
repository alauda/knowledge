---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `HostedCluster` CR is updated to enable encryption at rest by setting `spec.configuration.apiServer.encryption.type=aescbc`. The CR accepts the change without complaint, the controller reconciles cleanly, and the operator reports the cluster as healthy. But on the hosted control plane itself, secrets remain stored unencrypted in etcd — the field had no functional effect.

Because the schema accepts the field and the controller raises no warning, the misconfiguration is easy to miss. Compliance scans that rely on "the CR has encryption=aescbc set" pass; the actual data plane is unprotected.

## Root Cause

The encryption configuration on a hosted cluster lives in two unrelated places in the CR. Only one of them is wired to the underlying control plane:

- `spec.configuration.apiServer.encryption.type` — present in the API schema for backward compatibility with the in-cluster `APIServer` CR shape, but the HCP controller does not project it into the rendered kube-apiserver `--encryption-provider-config`. Whatever value is set here is silently dropped.
- `spec.secretEncryption.aescbc.activeKey.name` — the field the HCP controller actually reads. When set, it materialises an EncryptionConfiguration on the hosted kube-apiserver pointing at the AES-CBC key in the named Secret.

The schema accepting both fields without complaint makes the misconfiguration easy to miss. A change request to either deprecate the inert field or surface a warning when only it is set is in progress; until then, treat `apiServer.encryption` as a no-op on hosted clusters and use `secretEncryption` exclusively.

Note that `secretEncryption` only covers Kubernetes Secrets. It does not encrypt arbitrary etcd content (Pods, ConfigMaps with sensitive data, etc.) — those are out of its scope.

## Resolution

Create the AES-CBC key Secret in the `HostedCluster`'s management namespace. The secret must contain a single key named `key` with a 32-byte random value, base64-encoded by `kubectl create secret`:

```bash
HCP_NAMESPACE=<hosted-cluster-management-ns>
HCP_NAME=<hosted-cluster-name>

kubectl -n "$HCP_NAMESPACE" create secret generic "${HCP_NAME}-aescbc-key" \
  --from-literal=key="$(head -c 32 /dev/urandom | base64)"
```

Edit the HostedCluster CR and point `spec.secretEncryption` at the new Secret. Remove the inert `apiServer.encryption` block at the same time so the configuration only documents one source of truth:

```yaml
spec:
  secretEncryption:
    type: aescbc
    aescbc:
      activeKey:
        name: <hosted-cluster-name>-aescbc-key
  # spec.configuration.apiServer.encryption removed — has no effect on HCP
```

Apply the change and wait for the HCP controller to roll the hosted kube-apiserver. The roll is rolling-update-style: each replica picks up the new EncryptionConfiguration, restarts, and the next replica follows when the previous is back to ready.

After the roll completes, existing Secrets in the hosted cluster's etcd are still stored in plaintext — encryption only applies to writes after the configuration is in effect. Trigger a one-time re-encryption pass by re-writing every Secret in the hosted cluster:

```bash
HOSTED_KUBECONFIG=<path-to-hosted-cluster-kubeconfig>

kubectl --kubeconfig "$HOSTED_KUBECONFIG" get secrets -A -o json \
  | kubectl --kubeconfig "$HOSTED_KUBECONFIG" replace -f -
```

This replays every Secret through the API server, which writes them back to etcd encrypted with the active key. From that point forward all reads decrypt transparently and all new writes go through the encryption pipeline.

For key rotation later, generate a second key, add it to `aescbc.keys` after the active key, promote it to `activeKey` once propagated, then re-write Secrets the same way to migrate ciphertext to the new key. The schema supports listing multiple keys for exactly this reason.

## Diagnostic Steps

Confirm the inert field is the only configuration in place. Inspect the HostedCluster CR:

```bash
kubectl -n "$HCP_NAMESPACE" get hostedcluster "$HCP_NAME" -o yaml \
  | yq '.spec.configuration.apiServer.encryption // "(unset)", .spec.secretEncryption // "(unset)"'
```

If only `apiServer.encryption` is populated and `secretEncryption` is `(unset)`, the cluster has no effective encryption — apply the resolution above.

Verify whether secrets are currently encrypted by reading one directly from the hosted etcd. From a debug pod on a hosted control plane node:

```bash
kubectl debug node/<hcp-etcd-node> -it --image=busybox -- \
  chroot /host etcdctl get \
  /kubernetes.io/secrets/<namespace>/<secret-name>
```

A plaintext value indicates encryption isn't applied; the value should start with `k8s:enc:aescbc:v1:` once the resolution is in effect.

After the migration pass, repeat the etcd read on a different Secret and confirm the prefix:

```text
k8s:enc:aescbc:v1:<key-name>:...binary blob...
```

This is the canonical sign that the EncryptionConfiguration is active and the Secret was rewritten through the new pipeline.

If the apiserver fails to start after the change, inspect the HCP-side kube-apiserver pod logs in the management namespace — the most common failure is a Secret reference with the wrong key name (the field expects `key`, not the cluster name).
