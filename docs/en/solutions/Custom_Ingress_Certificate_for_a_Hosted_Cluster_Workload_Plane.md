---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A hosted cluster fronted by an externally signed wildcard certificate needs the workload plane's default ingress controller to serve the new chain, and the same custom CA must be trusted by every NodePool member. Editing the workload plane's `Proxy/cluster` directly is rejected by an admission policy:

```text
The proxies "cluster" is invalid: ValidatingAdmissionPolicy 'config' with
binding 'config-binding' denied request: This resource cannot be created,
updated, or deleted. Please ask your administrator to modify the resource
in the HostedCluster object.
```

The expected workflow is therefore not to patch resources inside the workload plane that the parent control plane manages, but to drive the change from the management cluster's `HostedCluster` object so the configuration is rolled into every payload generated for the NodePools.

## Root Cause

In a Hosted Control Plane topology the workload plane's configuration is owned by the `HostedCluster` custom resource on the management cluster. A validating admission policy on the workload plane blocks direct edits to selected platform configs (Proxy, Authentication, etc.) precisely so the hosted-control-plane controller stays the single source of truth — otherwise the next reconcile would silently revert anything the workload-plane administrator changed.

`HostedCluster.spec.additionalTrustBundle` is the supported way to inject extra CA material; it points at a ConfigMap (key `ca-bundle.crt`) in the **same namespace as the HostedCluster**, and the controller propagates the bundle to the hosted control plane and to every node payload. Default ingress certificate replacement is performed inside the workload plane against the `IngressController` resource, using the workload-plane kubeconfig.

## Resolution

The procedure is in two parts: first push the custom CA through the management plane so the new chain becomes trusted; then replace the default ingress certificate inside the workload plane.

### Preferred: ACP Hosted Control Plane Surface

The ACP **Hosted Control Plane** extension exposes the `HostedCluster` lifecycle as a managed surface — operators are encouraged to drive `additionalTrustBundle` and the workload-plane ingress certificate through that page so the rollout (control-plane Pod restart + NodePool payload refresh) is sequenced correctly. The steps below are the underlying KubeVirt/HyperShift mechanics for environments not yet onboarded onto that surface, or for ad-hoc verification.

### Step 1 — Generate the certificate request

Use the existing CN and subject alternative names of the workload plane (when external tooling rotates a certificate, only the secret content changes — the `CN`/`subjectAltName` must match what the workload plane already advertises):

```bash
export CERTIFICATE_NAME=apps.<cluster>.<base-domain>
openssl req -newkey rsa:4096 -nodes \
  -subj "/CN=*.${CERTIFICATE_NAME}" \
  -addext "subjectAltName = DNS:*.${CERTIFICATE_NAME}" \
  -keyout ${CERTIFICATE_NAME}.key \
  -out ${CERTIFICATE_NAME}.csr
```

Submit the CSR to the corporate CA. Confirm that the returned certificate **actually contains** the SAN — some CAs strip alternative names unless explicitly preserved.

### Step 2 — Trust the CA from the management plane

On the management cluster, in the namespace that owns the `HostedCluster` resource:

```bash
kubectl -n <hcp-namespace> create configmap custom-ca \
  --from-file=ca-bundle.crt=<path-to-ca-bundle.pem>
```

Patch the `HostedCluster` so the controller folds the bundle into every NodePool payload:

```yaml
apiVersion: hypershift.<group>/v1beta1
kind: HostedCluster
metadata:
  name: <hosted-cluster>
  namespace: <hcp-namespace>
spec:
  additionalTrustBundle:
    name: custom-ca
```

Changing `additionalTrustBundle` triggers a rollout for every existing NodePool. Confirm the rollout is healthy before moving on so nodes are not bouncing in parallel with the next change.

### Step 3 — Install the certificate inside the workload plane

The remaining steps target the workload plane, so use the workload-plane kubeconfig (often exported as `hcp.kubeconfig` from a HostedCluster secret):

```bash
KUBECONFIG=./hcp.kubeconfig kubectl -n <ingress-namespace> create secret tls custom-ingress \
  --cert=<signed-certificate.pem> \
  --key=<private-key.pem>

KUBECONFIG=./hcp.kubeconfig kubectl -n <ingress-operator-namespace> patch \
  ingresscontroller.operator/default \
  --type=merge \
  -p '{"spec":{"defaultCertificate":{"name":"custom-ingress"}}}'
```

The ingress controller hot-reloads the chain; established TLS sessions terminate normally, new sessions present the custom certificate.

## Diagnostic Steps

Inspect what the management plane considers trusted:

```bash
kubectl explain HostedCluster.spec.additionalTrustBundle
kubectl -n <hcp-namespace> get hostedcluster <hosted-cluster> \
  -o jsonpath='{.spec.additionalTrustBundle.name}{"\n"}'
```

A `degraded` HostedCluster status with a complaint about the trust bundle usually means the ConfigMap is missing the `ca-bundle.crt` key, the namespace is wrong, or the PEM is malformed.

Verify the workload-plane ingress is presenting the new chain:

```bash
KUBECONFIG=./hcp.kubeconfig kubectl -n <ingress-operator-namespace> get ingresscontroller default \
  -o jsonpath='{.spec.defaultCertificate.name}{"\n"}'

echo | openssl s_client -connect apps.<cluster>.<base-domain>:443 -servername apps.<cluster>.<base-domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

If the served certificate is still the previous self-signed one, the IngressController patch was applied against the management cluster instead of the workload plane — re-run the patch with the correct `KUBECONFIG`.
