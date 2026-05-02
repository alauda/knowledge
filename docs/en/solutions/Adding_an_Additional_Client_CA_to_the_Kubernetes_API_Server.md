---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500037
---

# Adding an Additional Client CA to the Kubernetes API Server

## Issue

An additional trusted Certificate Authority must be added to the cluster's API server so that clients presenting x.509 certificates signed by that CA can authenticate. Typical scenarios:

- An internal corporate PKI is rolling a new issuing CA and clients are being re-issued with certificates chained to the new root, which the API server does not yet trust.
- A secondary CA is introduced for a specific class of workload (service-to-apiserver, operator automation) in parallel with the existing human-admin CA.
- A staged rotation where both the old and new CA must be accepted for the overlap window before the old one is retired.

Without the new CA in the API server's client-CA bundle, every request that presents a certificate from the new chain is rejected at the TLS layer and the client never reaches any authenticator.

## Root Cause

The Kubernetes API server authenticates x.509 client certificates by validating the presented cert against the list of CAs configured in `--client-ca-file`. If the presented cert's signing chain does not terminate at one of those CAs, the TLS handshake completes but the `User` becomes unauthenticated and the request fails with a `401`. The bundle is file-based: the API server needs every CA it should accept to be present in the same PEM bundle.

On ACP the set of accepted client CAs is surfaced as a platform-level object instead of a raw file. The platform-level object references a ConfigMap that holds the CA bundle; the controller that reconciles the API server picks up the ConfigMap reference and lays the bundle into the file path the API server reads. Adding a CA is therefore a two-step operation: create the ConfigMap, then point the platform object at it.

## Resolution

Step 1 — package the new CA (and any CAs that should continue to be trusted) in PEM format and store them in a ConfigMap in the platform-reserved configuration namespace. The key name `ca-bundle.crt` is the conventional choice; pick whatever key name the platform-level API expects on your cluster:

```bash
kubectl create configmap client-ca-custom \
  -n <platform-config-namespace> \
  --from-file=ca-bundle.crt=ca.crt
```

Provide the full bundle, not just the new CA: the file contents replace the set of trusted client CAs when the controller renders it, so anything omitted stops being trusted. Concatenate the new CA onto the existing bundle if the old CAs should continue to be accepted during a rotation:

```bash
cat existing-ca-bundle.crt new-ca.crt > ca-bundle.crt
kubectl create configmap client-ca-custom \
  -n <platform-config-namespace> \
  --from-file=ca-bundle.crt=ca-bundle.crt \
  --dry-run=client -o yaml | kubectl apply -f -
```

Step 2 — reference the ConfigMap from the platform-level API server object:

```bash
kubectl patch apiserver cluster \
  --type=merge \
  -p '{"spec":{"clientCA":{"name":"client-ca-custom"}}}'
```

Once the controller reconciles, the API server's `--client-ca-file` is regenerated with the new bundle. Any client whose certificate chain validates against one of the CAs in the bundle and whose identity (Common Name / Organization for groups) maps to a real subject will authenticate.

Certificate-based authentication only handles the identity projection: the resulting user still needs RBAC to do anything. After the CA is in place, create RoleBindings / ClusterRoleBindings that reference the `CommonName` or `Organization` the certificate carries, or bind to a Group inherited through the x.509 `O=` field.

### Rollover pattern

When replacing a CA rather than adding one:

1. Build a combined bundle containing both the old and the new CA. Apply it. The API server now accepts certificates from either chain.
2. Re-issue client certificates from the new CA and distribute them.
3. Once every consumer is switched over and confirmed working, rebuild the bundle to contain only the new CA and reapply. The old CA is dropped from `--client-ca-file` at the next controller reconcile.

Never swap the CA in a single step on a live cluster — every in-flight client still holding a certificate from the old CA is locked out for the duration of the reconcile.

## Diagnostic Steps

Verify the ConfigMap is present and carries what you expect:

```bash
kubectl -n <platform-config-namespace> get configmap client-ca-custom -o yaml
kubectl -n <platform-config-namespace> get configmap client-ca-custom \
  -o jsonpath='{.data.ca-bundle\.crt}' \
  | openssl crl2pkcs7 -nocrl -certfile /dev/stdin \
  | openssl pkcs7 -print_certs -noout \
  | grep -E 'subject=|issuer='
```

Verify the platform-level API server object references it:

```bash
kubectl get apiserver cluster -o jsonpath='{.spec.clientCA}{"\n"}'
```

Confirm the controller has reconciled the change — the API server pods should have restarted (or picked up the new bundle via in-place reload, depending on distribution) since the patch. Rolling restart status is typically surfaced on a companion status object; in lieu of that, inspect the API server pod age:

```bash
kubectl -n <apiserver-namespace> get pod -l <apiserver-label> \
  -o custom-columns=NAME:.metadata.name,AGE:.status.startTime,READY:.status.containerStatuses[0].ready
```

Test an actual authentication with a client certificate signed by the new CA. A successful authn surfaces as the expected `User` in the audit log entry; a failure produces `x509: certificate signed by unknown authority` on the client:

```bash
kubectl --server=https://<api-endpoint> \
  --certificate-authority=server-ca.crt \
  --client-certificate=user.crt \
  --client-key=user.key \
  auth whoami
```

Expected output: a `UserInfo` object naming the Common Name from the certificate. A `401 Unauthorized` here with a well-formed cert means the bundle was not updated correctly — re-check steps 1 and 2, and in particular that `ca-bundle.crt` contained the signing chain all the way to the root that is present in the ConfigMap.

For x.509 concepts (how `CommonName` maps to `User`, how `Organization` maps to `Group`, how certificate groups interact with RBAC), the upstream Kubernetes documentation on authenticating strategies covers the mapping in detail.
