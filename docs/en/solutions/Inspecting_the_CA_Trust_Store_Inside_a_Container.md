---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A workload running inside a container needs to verify that its base image ships a specific root CA — for example, an external service it calls over HTTPS is signed under `DigiCert Global Root G2`, and the operator wants to confirm the container image already includes that root. The answer determines whether the workload "just works", or whether a custom CA bundle has to be mounted into the pod.

The question sounds trivial (`cat the trust store`) but the path to the trust store depends on the base image's distribution family, and some images ship multiple trust bundles that the workload's HTTP client picks between by language.

## Where to Look — By Base-Image Family

Different Linux distributions place their system-wide CA bundle at different paths. Identify the base image first, then look at the conventional location for that family:

| Base family | System CA bundle path |
|---|---|
| UBI 8/9, CentOS / Rocky / AlmaLinux, Fedora | `/etc/pki/tls/certs/ca-bundle.crt` (and a trust-database variant `ca-bundle.trust.crt`) |
| Debian / Ubuntu | `/etc/ssl/certs/ca-certificates.crt` (directory `/etc/ssl/certs/` holds per-CA symlinks) |
| Alpine | `/etc/ssl/certs/ca-certificates.crt` (plus a per-CA directory) |
| distroless static | No trust store by default — bundle must be mounted explicitly |
| Windows container | System trust store is in the registry, not the filesystem — different tooling |

The path drives everything downstream. Most Linux HTTP libraries honour the system path by default: OpenSSL, curl (`--ca-native`), Go's `crypto/tls` (on UBI reads `/etc/pki/tls/certs/ca-bundle.crt`), Python's `ssl` (follows OpenSSL), and so on. A few runtimes maintain their own trust store — Java (`cacerts` keystore), Node.js (can override via `NODE_EXTRA_CA_CERTS`). For those runtimes, the system path is informational but not definitive.

### Identify the base image

Inspect the pod's container image reference:

```bash
kubectl -n <ns> get pod <pod> -o jsonpath='{.spec.containers[*].image}{"\n"}'
```

The image's registry and tag usually reveal the family. If it's ambiguous, inspect the image's metadata:

```bash
# Inside the running pod:
kubectl exec -n <ns> <pod> -- cat /etc/os-release
# NAME="Fedora Linux"  (or "Ubuntu", "Alpine Linux", ...)
```

## Checking for a Specific CA

Once the trust-store path is known, grep for the root's name:

```bash
# UBI-family container:
kubectl exec -n <ns> <pod> -- \
  grep -l 'DigiCert Global Root G2' /etc/pki/tls/certs/*

# Expected matches:
# /etc/pki/tls/certs/ca-bundle.crt
# /etc/pki/tls/certs/ca-bundle.trust.crt
```

Each matched file indicates a place the trust appears — the PEM bundle `ca-bundle.crt` is what most libraries use, and a separate trust-DB `ca-bundle.trust.crt` is consumed by OpenSSL's legacy paths.

Find the exact certificate block to inspect its fingerprint and validity:

```bash
kubectl exec -n <ns> <pod> -- \
  awk '/-----BEGIN CERTIFICATE-----/{flag=1} flag; /-----END CERTIFICATE-----/{flag=0}' \
      /etc/pki/tls/certs/ca-bundle.crt | \
  openssl x509 -noout -subject -issuer -dates -fingerprint -sha256 2>/dev/null
```

Compare the fingerprint against the CA's published sha256 fingerprint to confirm the right certificate (not a different CA with a similar name).

## Adding a Missing CA

If the root is not in the image's trust store, there are two durable paths:

### Option A — mount a custom CA bundle as a ConfigMap / Secret

Keep the extra CA in cluster-managed storage and mount it into the pod alongside the system bundle. Most HTTP clients can be told to read an additional file:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-extra-ca
  namespace: my-app
data:
  extra-ca.pem: |
    -----BEGIN CERTIFICATE-----
    <additional CA in PEM>
    -----END CERTIFICATE-----
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: my-app
spec:
  template:
    spec:
      containers:
        - name: app
          image: registry.example.com/app:latest
          env:
            - name: SSL_CERT_FILE              # OpenSSL, Python
              value: /etc/pki/ca-trust/extracted/pem/extra-ca.pem
            - name: REQUESTS_CA_BUNDLE         # Python requests
              value: /etc/pki/ca-trust/extracted/pem/extra-ca.pem
            - name: NODE_EXTRA_CA_CERTS        # Node.js
              value: /etc/pki/ca-trust/extracted/pem/extra-ca.pem
          volumeMounts:
            - name: extra-ca
              mountPath: /etc/pki/ca-trust/extracted/pem/extra-ca.pem
              subPath: extra-ca.pem
              readOnly: true
      volumes:
        - name: extra-ca
          configMap:
            name: app-extra-ca
```

Tune the env vars to whatever the runtime expects. Some runtimes (Java, .NET) need their own mechanisms — Java uses `-Djavax.net.ssl.trustStore=...`, .NET uses `SslClientAuthenticationOptions.RemoteCertificateValidationCallback` or the system-wide store that has to be updated with `update-ca-trust extract` at image build time.

### Option B — rebuild the base image with the CA included

At image-build time, place the CA in the system trust directory and re-run the update command:

```dockerfile
# UBI-family Dockerfile fragment.
COPY extra-ca.pem /etc/pki/ca-trust/source/anchors/extra-ca.pem
RUN update-ca-trust extract
```

After `update-ca-trust extract`, the added CA is in `/etc/pki/tls/certs/ca-bundle.crt` automatically. All runtimes that read the system path pick it up with no pod-side configuration.

Prefer Option B for workloads where the trusted-CA set is part of the identity of the workload (belongs in the image). Use Option A when the set changes independently of the workload (rotations, per-environment overrides) and mounting from a ConfigMap is cleaner than re-publishing images.

## Diagnostic Steps

Verify the trust path the runtime actually uses. From inside the pod, the runtime's own diagnostic is the authoritative answer:

```bash
# curl — prints the configured CA file.
kubectl exec -n <ns> <pod> -- curl --version | head
kubectl exec -n <ns> <pod> -- curl-config --ca

# Python — exposes the OpenSSL defaults.
kubectl exec -n <ns> <pod> -- python3 -c "import ssl; print(ssl.get_default_verify_paths())"

# Java — prints the trust store path.
kubectl exec -n <ns> <pod> -- java -XshowSettings:properties 2>&1 | grep trustStore
```

Compare the runtime's reported path against what the `grep` query inspected — they should match. If the runtime reports a different path (e.g. a custom JVM truststore under the app's installation directory), update the trust there.

For HTTPS connectivity testing from inside the pod, curl's verbose output shows which CA bundle was used:

```bash
kubectl exec -n <ns> <pod> -- curl -v https://metrics-sink.example.com 2>&1 | \
  grep -E 'CAfile|CApath|SSL certificate|verify|error'
```

`CAfile: /etc/pki/tls/certs/ca-bundle.crt` plus `SSL certificate verify ok` confirms the runtime read the expected bundle and accepted the remote certificate. A `verify` failure indicates either the remote's chain is missing a root in the bundle (add it) or the remote sent a partial chain (the remote needs to send its intermediates).

After applying any fix (mount or rebuild), re-run the `curl` probe from the pod; `verify ok` is the end-state.
