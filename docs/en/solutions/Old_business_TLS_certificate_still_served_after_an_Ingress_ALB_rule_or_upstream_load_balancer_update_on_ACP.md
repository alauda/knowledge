---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Old business TLS certificate still served after an Ingress, ALB rule, or upstream load balancer update on ACP

## Issue

A business certificate, a new wildcard certificate, or an Ingress TLS Secret was updated for a published service, and clients still receive the previous certificate. An incognito browser window, or `openssl s_client`, still shows the old `notBefore` / `notAfter` dates and issuer. A typical report is "the domain certificate replacement does not take effect".

This article covers the certificate that a published service presents through ALB (and, where present, an Ingress or an upstream load balancer). The platform access certificate (`dex.tls`) and platform component Secrets are covered elsewhere: see [Replace the platform access certificate in dex.tls on ACP](Replace_the_platform_access_certificate_in_dex.tls_on_ACP.md) and [Update a platform domain certificate stored in a cpaas-system Secret on ACP](Update_a_platform_domain_certificate_stored_in_a_cpaas-system_Secret_on_ACP.md). An ingress-nginx controller that serves a renewed certificate only after a restart is Cause 2 of [Business TLS certificate not renewed, not reloaded by ingress-nginx, or rejected with a format error on import on ACP](Business_TLS_certificate_not_renewed_not_reloaded_by_ingress-nginx_or_rejected_with_a_format_error_on_import_on_ACP.md).

Related articles: *HTTPS to a published service fails with plain HTTP sent to HTTPS port, ERR_SSL_PROTOCOL_ERROR, or TLS alert 80 on ACP* (handshake and protocol errors instead of an old certificate).

## Root Cause

Three places can each present a certificate for the same hostname: the ALB rule for that host and port, an Ingress for that host, and an upstream load balancer in front of the cluster. Clients see whichever certificate is presented by the hop that terminates TLS for them. Updating the certificate in one place does not update the others.

### Cause 1: the Ingress certificate changed and the ALB rule still selects the old one

The business certificate lives in a Secret (sometimes with a copy in a ConfigMap), and only the Ingress was updated. The certificate selected on the ALB rule for that host was not updated with it, so the ALB keeps serving the old leaf. An Ingress annotation of the form `alb.networking.cpaas.io/tls: <host>=<namespace>/<secret>` and the ALB rule select a Secret; replacing a ConfigMap that holds a copy, or creating a new Secret that the rule does not reference, does not change what the ALB serves.

A hostname that matches no rule certificate falls through to the default certificate of the HTTPS port. Such names keep the default certificate even after the rule for other hosts is updated; for them, the port default certificate is what has to change.

### Cause 2: the ALB serves the new certificate and the upstream load balancer still serves the old one

A new wildcard certificate was selected for the service, there is no second Ingress for that host, and `openssl s_client` against the ALB node shows the new leaf. Users who come through an upstream load balancer (for example an F5 appliance) still get the previous certificate, because that device terminates TLS and presents its own certificate configuration.

Two designs are valid, and they have different fixes:

- The upstream device should keep terminating TLS: its certificate has to be updated.
- Only the ALB certificate should be presented: the upstream device should stop terminating TLS and pass TCP through to ALB port 443.

Forwarding decrypted HTTP from the upstream device to the ALB HTTPS port meets neither goal (see the related article on `The plain HTTP request was sent to HTTPS port`).

### Cause 3: the certificate was replaced on the ALB and the Ingress certificate was left unchanged

The service is published with both an Ingress and an ALB rule. The certificate selected on the ALB was replaced, but the Ingress TLS Secret was not, so clients that reach the service through the Ingress keep receiving the previous leaf. Replacing the Ingress certificate as well makes the new domain certificate take effect.

If the direct ALB check still shows the old leaf, this is Cause 1, not Cause 3.

## Resolution

### Cause 1: the Ingress certificate changed and the ALB rule still selects the old one

1. Read the annotation, the leaf the ALB serves, and the certificate in the Secret:

   ```bash
   kubectl get ingress -n <namespace> <ingress-name> -o yaml
   echo | openssl s_client -connect <alb-node>:443 -servername <host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   kubectl get secret -n <namespace> <tls-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. When the Secret holds the new certificate and the ALB still serves the old leaf, open the ALB rule for that host and port and select the same Secret that the Ingress annotation names. This is a normal rule update; it does not need an ALB restart.

3. If the hostname does not match a rule certificate and the HTTPS port default is the old leaf, update the default certificate of that port instead.

4. Repeat the `openssl s_client` check against the ALB node and in an incognito browser window. Both should show the new leaf.

### Cause 2: the ALB serves the new certificate and the upstream load balancer still serves the old one

1. Compare the ALB node with the public name users type:

   ```bash
   echo | openssl s_client -connect <alb-node>:443 -servername <host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   echo | openssl s_client -connect <public-name>:443 -servername <public-name> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   kubectl get ingress -A -o yaml | grep -F '<host>'
   ```

2. If the ALB node shows the new certificate, the public name shows the old one, and no other Ingress serves the host:
   - When the upstream device should remain the TLS terminator, replace the certificate on the upstream device.
   - When only the ALB certificate should be presented, remove the certificate from the upstream device and configure it to pass TCP through to ALB port 443, instead of updating its certificate in place.

3. If the ALB node itself is still old, go back to Cause 1. If clients reach an Ingress whose Secret was not replaced, use Cause 3.

### Cause 3: the certificate was replaced on the ALB and the Ingress certificate was left unchanged

1. Compare the Ingress TLS Secret with the leaf the ALB already serves:

   ```bash
   kubectl get ingress -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.spec.tls}{"\n"}{end}'
   kubectl get secret -n <namespace> <ingress-tls-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. Replace the Ingress TLS Secret with the new certificate and key.

   > **Warning:** Applying a new TLS Secret changes the certificate that the Ingress presents for this host. A mismatched key or a not-yet-valid certificate breaks HTTPS for the host until the previous Secret is restored. Do this only when the service has both an Ingress and an ALB rule, the ALB certificate was already replaced, and this Ingress Secret still holds the old leaf. Back up the Secret first; roll back with `kubectl apply -f` of the backup.

   ```bash
   umask 077
   kubectl get secret -n <namespace> <ingress-tls-secret> -o yaml > "$HOME/<ingress-tls-secret>.yaml"
   openssl x509 -noout -modulus -in tls.crt | openssl md5
   openssl rsa -noout -modulus -in tls.key | openssl md5
   kubectl create secret tls <ingress-tls-secret> --cert=tls.crt --key=tls.key -n <namespace> \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

   The two `md5` values must match before you apply (for an RSA key; for an EC key compare `openssl x509 -noout -pubkey` with `openssl pkey -pubout`).

3. Check the public name again:

   ```bash
   echo | openssl s_client -connect <public-name>:443 -servername <host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   ```

   If the Ingress Secret is already new and the ALB leaf is old, use Cause 1 instead.

## Diagnostic Steps

Collect three leaves before changing a rule or an upstream device: the Secret the Ingress names, the ALB node, and the public name.

```bash
kubectl get ingress -n <namespace> <ingress-name> -o yaml
kubectl get secret -n <namespace> <tls-secret> -o jsonpath='{.data.tls\.crt}' \
  | base64 -d | openssl x509 -noout -dates -subject -issuer
echo | openssl s_client -connect <alb-node>:443 -servername <host> 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer
echo | openssl s_client -connect <public-name>:443 -servername <public-name> 2>/dev/null \
  | openssl x509 -noout -dates -subject -issuer
```

| Secret | ALB node | Public name | Cause |
| --- | --- | --- | --- |
| new | old | old | 1 (rule certificate, or the HTTPS port default for an unmatched name) |
| new | new | old, no other Ingress for the host | 2 |
| Ingress Secret old, ALB rule certificate already replaced | new | old | 3 |

If the client gets no certificate at all, a handshake alert, or an HTTP error instead of an old leaf, see the related article named under Issue.
