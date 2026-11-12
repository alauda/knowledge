---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Business TLS certificate not renewed, not reloaded by ingress-nginx, or rejected with a format error on import on ACP

## Issue

One of the following happens with a business (application) TLS certificate:

- A certificate expiry alert names a business certificate that the platform does not renew.
- The ingress-nginx gateway serves a renewed certificate only after it is restarted by hand, and a script that restarts it automatically after each certificate update is requested.
- A wildcard certificate has to be configured as a Secret in every project, and the question is whether it can be managed once for the whole platform.
- **Create Certificate** under **Network Management > Certificates** rejects a certificate that includes the intermediate chain: the public key field shows `格式错误` (format error). The question is which certificate format network management expects.

Related articles: "Update a platform domain certificate stored in a cpaas-system Secret on ACP" covers platform domain certificates in `cpaas-system`; "Replace the platform access certificate in dex.tls on ACP" covers the platform access address.

## Root Cause

### Cause 1: the alerting certificate is a business certificate

The certificate that did not renew is not a platform component certificate. Neither the platform cert-manager nor any platform operator renews it; the team that owns the business renews and reloads it. An ALB rule and the `alb.networking.cpaas.io/tls` annotation select a Secret, so replacing only a ConfigMap copy of a certificate does not change what the ALB serves.

### Cause 2: ingress-nginx needs a restart to use a renewed certificate because its image is not the platform one

When a certificate is replaced under **Platform Management > Network Management > Domain**, the Secret in `cpaas-system` is updated and the platform-provided ingress-nginx reloads it without a restart. An ingress-nginx image that is not provided by the platform may not hot-reload certificates, so it keeps serving the old certificate until it restarts. Custom ingress-nginx images are not supported, and no automatic restart script is provided.

### Cause 3: ACP 4.3 has no platform-wide management of one wildcard certificate across projects

ACP 4.3 has no feature that manages one certificate centrally for every project. Certificates are configured as Secrets in each project that needs them. The platform domain Secrets in `cpaas-system` are one per platform-managed domain; they are not a way to share a wildcard certificate with every project.

### Cause 4: Create Certificate reports a format error because the imported file has Windows (\r\n) line endings

Certificates under network management use the PEM x509 format. A chain with several `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----` blocks (leaf plus intermediates) is valid input. On ACP 4.1.0, importing such a file with the `导入` (Import) button of the public key field fails the front-end format check when the file uses Windows `\r\n` line endings, because the import function of that version does not support them. Pasting the same content into the field works.

## Resolution

### Cause 1: the alerting certificate is a business certificate

1. Confirm that the name is not a platform component or operator certificate (see "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP"), and print the business certificate:

   ```bash
   kubectl get secret -n <namespace> <business-tls-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. Hand the renewal to the business owner. A business certificate is updated under **Platform Management > Network Management > Certificates**. On a 3.x TKE-based platform the page is **Platform Management > Network Management > Domain Certificates**: select the certificate, open the three-dot menu on the right, and choose **Update**.
3. After the Secret is replaced, check that the ALB rule or Ingress references that Secret, and check the certificate served on the business hostname:

   ```bash
   echo | openssl s_client -connect <business-host>:443 -servername <business-host> 2>/dev/null \
     | openssl x509 -noout -dates -subject
   ```

### Cause 2: ingress-nginx needs a restart to use a renewed certificate because its image is not the platform one

1. Check which image the gateway runs and compare it with the image the platform ships:

   ```bash
   kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.spec.containers[*].image}{"\n"}{end}' | grep -i ingress-nginx
   ```

2. If the image is not the platform-provided one, switch to the platform ingress-nginx, so that certificate updates are reloaded automatically.
3. Until then, restart the gateway after each certificate change.

   > **Warning:** Restarting ingress-nginx interrupts the connections it is serving while its Pods are replaced. Do this only after the certificate Secret was updated and only for a gateway that runs a non-platform image. A rolling restart has nothing to roll back.

   ```bash
   kubectl rollout restart deployment -n <namespace> <ingress-nginx-deployment>
   kubectl rollout status deployment -n <namespace> <ingress-nginx-deployment>
   ```

### Cause 3: ACP 4.3 has no platform-wide management of one wildcard certificate across projects

Configure the wildcard certificate as a Secret in each project that needs it, and reference that Secret from the ALB rule or Ingress of the project. There is no central, platform-wide alternative in 4.3.

### Cause 4: Create Certificate reports a format error because the imported file has Windows (\r\n) line endings

1. Check the file for carriage returns and confirm that each block parses as PEM x509:

   ```bash
   grep -c $'\r' <cert-file>.pem
   openssl crl2pkcs7 -nocrl -certfile <cert-file>.pem | openssl pkcs7 -print_certs -noout
   ```

   A non-zero count means Windows line endings.

2. Use one of these workarounds:

   - Paste the certificate content into the public key field instead of using `导入` (Import).
   - After importing, make a small edit in the field (for example delete one `-` and type it back) so that the front-end validation runs again.
   - Convert the file to Unix line endings before importing:

     ```bash
     tr -d '\r' < <cert-file>.pem > <cert-file>-unix.pem
     grep -c $'\r' <cert-file>-unix.pem
     ```

     The second command prints `0`.

## Diagnostic Steps

1. Identify the Secret and its owner:

   ```bash
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.metadata.labels}{"\n"}{.metadata.annotations}{"\n"}{.metadata.ownerReferences}{"\n"}'
   ```

   A Secret in a business namespace without platform labels or an owning platform operator is a business certificate.

2. Branch:

   - The alert names a business certificate: Cause 1.
   - ingress-nginx serves the new certificate only after a restart: Cause 2.
   - One wildcard certificate for every project is requested: Cause 3.
   - Create Certificate shows `格式错误` for a chain, or the question is which format is accepted (PEM x509): Cause 4.
