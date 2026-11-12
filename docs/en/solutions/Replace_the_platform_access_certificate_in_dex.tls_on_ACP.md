---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# Replace the platform access certificate in dex.tls on ACP

## Issue

One of the following concerns the certificate that the platform access address presents:

- The browser warns that the platform address is not private, the HTTPS certificate is about to expire, or the site still shows an openssl self-signed certificate after the platform certificate was deleted.
- A certificate added on an ACP page never appears when users open the platform.
- Nodes fail image pulls from the platform registry host with `x509: certificate has expired or is not yet valid`.
- An inspection reports `dex.tls` as expired, but the console still opens over HTTP, or the report appeared right after a virtual machine restart.
- In a disaster-recovery deployment, business clusters show the `base` component abnormal in minfo before an upgrade, and `cluster-transform` logs that the primary and standby global `tls.crt` are inconsistent. Or the standby global fails.
- During installation or later: "where do I add the ACP certificate?", "how do I replace the platform certificate with a trusted one?", "can the platform move from an IP address to a domain name?", or "which format of a wildcard certificate should be downloaded?".

This certificate is not the client certificate inside `admin.conf`, not Secret `global-kubeconfig`, and not an Ingress or ALB certificate of a business service. On ACP 3.12, where the certificate is held inline in the `prdb` resource, see "Replace the platform access HTTPS certificate in prdb with a PEM certificate and key on ACP 3.12".

## Root Cause

### Cause 1: cpaas-system/dex.tls is expired, self-signed, or not the certificate uploaded on a page

Secret `dex.tls` in `cpaas-system` on the global cluster holds the leaf certificate that the platform access address, and the platform registry, present. Certificate `dex-serving-cert` in the same namespace is the cert-manager object that owns a platform-issued copy. Uploading a certificate on an ACP page does not replace this Secret.

Whether `dex.tls` renews by itself depends on how the platform was deployed. When the platform generated its own certificate, `dex-serving-cert` manages it and it renews automatically. When the platform was deployed with an existing certificate supplied by its owner, `dex.tls` has to be replaced by hand when that certificate approaches its end date. The same replacement applies when the current material is the temporary openssl self-signed certificate left after a deletion. On ACP 4.0 disaster-recovery deployments, the standby global needs the same replacement.

After `dex.tls` is replaced, business clusters can keep listing it as about to expire on the previous date. Those business-cluster copies renew automatically.

### Cause 2: dex.tls is reported expired but its dates are valid, or users only use HTTP

An inspection run right after a virtual machine restart can report `dex.tls` as expired while its `notAfter` is still in the future; later inspection runs are clean. Separately, an expired `dex.tls` does not block users who reach the platform over HTTP only; it matters for HTTPS clients and for nodes that pull from the platform registry.

### Cause 3: the platform address cannot be changed, so a trusted certificate must match the existing name

Certificates are configured for the platform access address; they are not added to a business cluster's API server. The access address of an already deployed platform cannot currently be changed, so a trusted certificate can only be used if it is issued for the name the platform already uses. There is no established procedure to turn an IP platform address into a domain name. A DNS name added later for browser access to a platform deployed on a VIP shows "not secure", and no certificate configuration removes that warning.

### Cause 4: the primary and standby global clusters use different platform certificates

In a disaster-recovery deployment both global clusters must present the same platform access certificate. When their `tls.crt` differ, `cluster-transform` reports the inconsistency, the business clusters show `base` abnormal in minfo, the minfo version does not match the cluster version, and refreshing the minfo label does not help. Putting the same certificate on both globals is the fix. A failed standby global can likewise be recovered by updating `dex.tls` on the standby.

### Cause 5: deployment-time certificate choices

When no certificate issued by a public or enterprise CA is available for the platform domain at installation, a self-signed certificate can be used; browsers warn until a trusted certificate for the same domain replaces it. When a wildcard certificate is downloaded from a provider that offers nginx, apache, tomcat, IIS, and other server types, choose nginx: it delivers a PEM certificate and key.

## Resolution

### Cause 1: cpaas-system/dex.tls is expired, self-signed, or not the certificate uploaded on a page

1. Confirm that the leaf clients receive is `dex.tls`:

   ```bash
   echo | openssl s_client -connect <platform-host>:443 -servername <platform-host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   kubectl get secret dex.tls -n cpaas-system -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   Stop if the two differ: an upstream load balancer may present its own certificate, or the certificate may be held in `prdb`. If a node reports `x509: certificate has expired or is not yet valid` and its clock is wrong, fix the clock instead.

2. Put the replacement PEM files on the global control-plane node you run `kubectl` from: `tls.crt` (the certificate, followed by any intermediates from the issuer) and `tls.key` (the private key). Check them:

   ```bash
   openssl x509 -in tls.crt -noout -pubkey | openssl md5
   openssl pkey -in tls.key -pubout | openssl md5
   openssl x509 -in tls.crt -noout -dates -subject -issuer -ext subjectAltName
   ```

   Continue only when the two hashes match, the new `notAfter` is in the future, and the certificate names the current platform host.

3. Back up, delete, and recreate the certificate.

   > **Warning:** These commands delete Certificate `dex-serving-cert` and Secret `dex.tls` in `cpaas-system`; HTTPS to the platform address fails until `kubectl create secret tls` completes. Use a maintenance window and run the commands only when step 1 showed that the served leaf is `dex.tls` and step 2 verified the new pair. Rollback is `kubectl apply -f` of the two backup files, which restores the previous certificate. On an ACP 4.0 disaster-recovery pair, repeat the same steps on the standby global.

   ```bash
   umask 077
   kubectl get certificate -n cpaas-system dex-serving-cert --ignore-not-found=true -o yaml > "$HOME/dex-serving-cert.yaml"
   kubectl get secret -n cpaas-system dex.tls -o yaml > "$HOME/dex.tls.yaml"
   kubectl delete certificate -n cpaas-system dex-serving-cert --ignore-not-found=true
   kubectl delete secret -n cpaas-system dex.tls
   kubectl create secret tls dex.tls --cert=tls.crt --key=tls.key -n cpaas-system
   ```

4. Verify the Secret and the served leaf, then retry any failed image pull:

   ```bash
   kubectl get secret dex.tls -n cpaas-system -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   echo | openssl s_client -connect <platform-host>:443 -servername <platform-host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   ```

   Both show the new subject and dates. The backup `dex.tls.yaml` contains a private key; remove it once the new certificate is confirmed. If business clusters still report the previous `dex.tls` expiry, wait for their automatic renewal and check that their `notAfter` moves forward.

### Cause 2: dex.tls is reported expired but its dates are valid, or users only use HTTP

1. Print the dates before any change (step 1 of Cause 1). If `notAfter` is still in the future, leave `dex.tls` in place; the report clears on a later inspection run.
2. If the dates are really past, replace the certificate with Cause 1 when HTTPS clients or the platform registry must trust it. An environment that is reached only over HTTP keeps working without the replacement.

### Cause 3: the platform address cannot be changed, so a trusted certificate must match the existing name

1. Read the name the platform uses today from the certificate it serves:

   ```bash
   echo | openssl s_client -connect <platform-host>:443 -servername <platform-host> 2>/dev/null \
     | openssl x509 -noout -subject -ext subjectAltName -dates
   ```

2. Obtain a trusted certificate issued for that name, and replace it with Cause 1 in a maintenance window.
3. A move from an IP address to a domain name has no established procedure; raise it as a separate request with support.

### Cause 4: the primary and standby global clusters use different platform certificates

1. On the primary global and on the standby global, compare the certificate and read the `cluster-transform` log:

   ```bash
   kubectl get secret dex.tls -n cpaas-system -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -fingerprint -sha256 -subject -dates
   kubectl get pods -A | grep cluster-transform
   kubectl logs -n <namespace> <cluster-transform-pod> --tail=200 | grep -i tls
   ```

2. If the fingerprints differ, replace the certificate with the same `tls.crt` and `tls.key` on both globals using Cause 1, including its Warning.
3. Check the business clusters' `base` status in minfo again.

### Cause 5: deployment-time certificate choices

1. Without a CA-issued certificate, install with a self-signed certificate. Replacing it later with a trusted certificate for the same domain is a separate maintenance-window change (Cause 1).
2. For a wildcard certificate download, choose the nginx type and check the pair before installation:

   ```bash
   openssl x509 -in tls.crt -noout -subject -ext subjectAltName -dates
   openssl x509 -in tls.crt -noout -pubkey | openssl md5
   openssl pkey -in tls.key -pubout | openssl md5
   ```

## Diagnostic Steps

1. Print what port 443 on the platform host actually sends, `dex.tls`, and `prdb` `base` if it holds an inline certificate:

   ```bash
   echo | openssl s_client -connect <platform-host>:443 -servername <platform-host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   kubectl get secret dex.tls -n cpaas-system -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   kubectl get prdb base -o jsonpath='{.spec.http.tls.cert}' 2>/dev/null \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   The object whose subject and dates match the client error is the one to replace. If `dex.tls` already holds the new certificate but the browser does not, check a load balancer in front of the platform.

2. Branch:

   - Browser or registry leaf equals `dex.tls` and is expired, self-signed, or untrusted: Cause 1.
   - Inspection says expired but `notAfter` is in the future, or only HTTP is used: Cause 2.
   - A question about replacing the certificate with a trusted one, or moving from IP to a domain name: Cause 3.
   - Disaster-recovery pair with business-cluster `base` abnormal and `cluster-transform` reporting inconsistent `tls.crt`: Cause 4.
   - Questions during installation: Cause 5.
   - A platform component certificate in `cpaas-system` with about 30 days left: a different object, see "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP".
