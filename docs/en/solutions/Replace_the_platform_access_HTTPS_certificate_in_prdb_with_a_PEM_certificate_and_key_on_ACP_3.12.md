---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
---

# Replace the platform access HTTPS certificate in prdb with a PEM certificate and key on ACP 3.12

## Issue

On ACP 3.12, the HTTPS certificate of the platform access address (the domain users open the console with) has to be replaced, for example because it is about to expire. The product documentation pages about certificates cover Ingress and load balancer certificates, not the certificate of the platform itself.

The new certificate is often delivered as two files, such as `<domain>.key` and `<domain>.pem`, and there is no file named `.crt` or `.cert`, which makes it unclear which file goes where.

## Root Cause

On ACP 3.12 the platform access certificate is held in the `prdb` resource on the `global` cluster, in `spec.http.tls.cert` (certificate) and `spec.http.tls.key` (private key), both base64-encoded. Changing these fields is how the certificate is replaced.

This procedure is for ACP 3.12. On ACP 4.x the platform access certificate is the `dex.tls` Secret in `cpaas-system`; follow "Rotate TLS Certs of Platform Access Addresses" in the product documentation instead.

A `.pem` file is just a PEM-encoded file. When it starts with `-----BEGIN CERTIFICATE-----`, it is the certificate and is used in place of a `.cert`/`.crt` file. The `.key` file is the private key.

## Resolution

Run the steps on the first control plane node of the `global` cluster.

1. Prepare the files. Copy the certificate (`.pem`) to `custom.cert` and the key to `custom.key`, then check that they belong together and cover the platform domain:

   ```bash
   cp <domain>.pem custom.cert
   cp <domain>.key custom.key
   openssl x509 -in custom.cert -noout -subject -enddate -ext subjectAltName
   openssl x509 -in custom.cert -noout -pubkey | openssl md5
   openssl pkey -in custom.key -pubout | openssl md5
   ```

   Continue only if the two hashes are identical, `notAfter` is in the future, and the subject or subject alternative names include the platform access domain. If the issuer supplied intermediate certificates, append them to `custom.cert` after the server certificate.

2. Back up the current resource:

   ```bash
   kubectl get prdb -o yaml > /backup-prdb.yaml
   ```

3. Generate the base64 values:

   ```bash
   cat custom.cert | base64 -w 0; echo
   cat custom.key | base64 -w 0; echo
   ```

4. Write them into `prdb`.

   > **Warning:** Saving this change redeploys the platform access components with the new certificate. HTTPS access and logins can be interrupted until the rollout completes, and a wrong certificate or key makes the console unreachable over HTTPS. Do this in a maintenance window and only after step 1 succeeded. To roll back, edit `prdb` again and put back the `spec.http.tls.cert` and `spec.http.tls.key` values saved in `/backup-prdb.yaml`.

   ```bash
   kubectl edit prdb
   ```

   Set `spec.http.tls.cert` to the first value and `spec.http.tls.key` to the second. Add either key if it is missing.

5. Wait until the platform releases in `cpaas-system` are ready again (note the namespace spelling; a typo such as `cpass-system` returns `No resources found`):

   ```bash
   kubectl get appreleases -n cpaas-system
   ```

6. Check that the `dex` pod was recreated after the change. If its age shows it was not, delete it so that it restarts with the new certificate.

   > **Warning:** Users cannot log in while the `dex` pod restarts, usually for less than a minute. Delete it only if it was not recreated automatically. The Deployment recreates it, so no rollback is needed.

   ```bash
   kubectl get po -A | grep dex
   kubectl -n cpaas-system delete pod <dex-pod-name>
   ```

7. Log in to the platform and check the certificate the browser receives.

## Diagnostic Steps

1. Check the certificate currently served on the platform address:

   ```bash
   echo | openssl s_client -connect <platform-domain>:443 -servername <platform-domain> 2>/dev/null \
     | openssl x509 -noout -subject -issuer -dates
   ```

2. Check what `prdb` holds and compare it with the served certificate:

   ```bash
   kubectl get prdb -o jsonpath='{.items[0].spec.http.tls.cert}' | base64 -d | openssl x509 -noout -subject -dates
   ```

   After the replacement both commands show the new subject and dates.

3. Identify an unlabeled file by its first line: `-----BEGIN CERTIFICATE-----` is a certificate, `-----BEGIN PRIVATE KEY-----` or `-----BEGIN RSA PRIVATE KEY-----` is a key:

   ```bash
   head -1 <domain>.pem <domain>.key
   ```

4. If the platform releases do not become ready after the edit, inspect the one that is not ready:

   ```bash
   kubectl get appreleases -n cpaas-system
   kubectl describe apprelease -n cpaas-system <name>
   ```
