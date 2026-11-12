---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Platform component certificate not renewed: stale private key, issuerRef group, or alert name that differs from the Secret on ACP

## Issue

A platform component certificate has expired, or is close to expiry, and did not renew by itself. Typical reports:

- On a cluster with DevOps components, `devops-tool-operator-controller-manager-service-cert` is expired. An inspection can report it as `devops-tool-operator-controller-manager-service-cert 证书有效期还剩-61天` (remaining validity -61 days). After its Secret was rebuilt, the certificate page still shows it as expired, and the browser console shows `found duplicate series for the match group` and `many-to-many matching not allowed` on `/v2/metrics/global/query`.
- The alert says `katanomi-artifacts-serving-cert` in `operators` has less than `30.00d` left, but `kubectl get secrets -A | grep katanomi-artifacts-serving-cert` returns nothing, and rebuilding another katanomi Secret does not change the alert.
- `rds-operator-controller-manager-service-cert` is expired on global (the certificate page can truncate it to `rds-operator-controller-manager-service-cer`), or its Secret was deleted by hand and never reissued.
- An inspection names a certificate, and a search for it on the cluster you are logged in to finds no Secret.

## Root Cause

### Cause 1: the Certificate reports Existing private key is not up to date for spec: [spec.keyAlgorithm]

The cert-manager `Certificate` (for example `devops-tool-operator-controller-manager-service-cert` in `operators`, with `duration: 17520h0m0s`, `renewBefore: 720h0m0s`, issuer `ClusterIssuer` `cpaas-ca`) shows the condition `Existing private key is not up to date for spec: [spec.keyAlgorithm]` and, once the date passes, `Certificate expired`. The private key stored in the Secret does not match the key algorithm in the Certificate spec, and the certificate is not re-issued. This is a known issue with this credential: deleting the Secret once lets cert-manager write a new key and certificate, after which cert-manager manages it normally. The operator that serves the certificate must then be restarted to load it.

The issue is identified by the `spec.keyAlgorithm` condition, not by the certificate name. Read the conditions on your cluster before treating an alert for this name as this cause.

After the renewal, the certificate page can keep showing the old state. The monitoring data then holds two series for the same certificate, one with `phase="Expired"` and one with `phase="Normal"`, and the page query fails with `found duplicate series for the match group ... many-to-many matching not allowed: matching labels must be unique on one side`. Restarting `courier` on the global cluster clears the old series.

### Cause 2: the alert names a certificate, and no Secret with that name exists

The alert carries the certificate name, and the Secret that stores it can have a different name. The certificate name appears in the Secret's annotations, or in `spec.secretName` of its `Certificate`. For `katanomi-artifacts-serving-cert`, the Secret is `katanomi-artifacts-webhook-service-cert` in `operators`, alongside other katanomi Secrets such as `katanomi-operator-service-cert` and `katanomi-webhook-server-cert`. Deleting one of those other Secrets reissues a different certificate and leaves the alert unchanged.

Like most platform component certificates, this one normally renews automatically before it expires, so an alert that is only inside the 30-day window can be left alone. Delete-to-reissue does not work for every platform component certificate: it depends on the component and the platform version, because the management layer above the Secret differs.

### Cause 3: issuerRef has group ait.alauda.io, so cert-manager does not reissue rds-operator-controller-manager-service-cert

The `Certificate` `rds-operator-controller-manager-service-cert` (`duration: 17520h0m0s`, `renewBefore: 720h0m0s`) contains:

```yaml
issuerRef:
  group: ait.alauda.io
  kind: ClusterIssuer
  name: cpaas-ca
```

cert-manager's built-in issuers handle only `issuerRef` entries of group `cert-manager.io` (or no group). A Certificate that names another group is left to an external issuer, so cert-manager does not issue it from the `cpaas-ca` ClusterIssuer, and it is not reissued when it expires or when its Secret is deleted. Removing the `group` field from `issuerRef` lets cert-manager issue the certificate; the Secret is updated with a new certificate and the alert clears.

### Cause 4: the alerting certificate is on another cluster

The alert or inspection row names a certificate that belongs to another cluster of the same platform, for example a business cluster while the search was run on global. Searching on the wrong cluster finds nothing. On the right cluster the Secret exists and can be renewed with the method that matches its name.

## Resolution

### Cause 1: the Certificate reports Existing private key is not up to date for spec: [spec.keyAlgorithm]

1. Read the Certificate and its conditions, and print the certificate dates:

   ```bash
   kubectl get cert -A | grep devops-tool
   kubectl get cert -n operators devops-tool-operator-controller-manager-service-cert -o yaml
   kubectl get secret -n operators devops-tool-operator-controller-manager-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   Continue only when the condition text is `Existing private key is not up to date for spec: [spec.keyAlgorithm]`, or the certificate is expired or near expiry and has not renewed. If `kubectl get cert -A` printed another namespace, use it.

2. Back up and delete the Secret, then check that it was reissued.

   > **Warning:** Deleting the Secret removes the certificate the devops-tool operator serves until cert-manager writes a new one; clients of that service fail TLS in the gap. Do this only when step 1 confirmed the condition or the expiry. Rollback is `kubectl apply -f` of the backup, which restores the old certificate.

   ```bash
   umask 077
   kubectl get secret -n operators devops-tool-operator-controller-manager-service-cert -o yaml > "$HOME/devops-tool-operator-controller-manager-service-cert.yaml"
   kubectl delete secret -n operators devops-tool-operator-controller-manager-service-cert
   kubectl get secret -n operators devops-tool-operator-controller-manager-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   kubectl get cert -n operators devops-tool-operator-controller-manager-service-cert
   ```

   The new `notAfter` must be later than before, and the Certificate must be Ready.

3. Restart the operator Pod so that it loads the new certificate.

   > **Warning:** Deleting the `devops-tools-operator` Pod stops that operator's reconciliation until the Deployment starts a new Pod. Do this only after the new Secret shows a future `notAfter`. The Deployment recreates the Pod.

   ```bash
   kubectl get pods -A | grep devops-tools-operator
   kubectl delete pod -n <namespace> <devops-tools-operator-pod>
   ```

4. If the certificate page still lists the certificate as expired, and the browser console shows `found duplicate series` with `phase="Expired"` and `phase="Normal"` for the same name, restart `courier` on the global cluster.

   > **Warning:** Restarting the global `courier` Pods interrupts alert delivery and the console certificate status until they are Running again. Do this only after the new Secret's `notAfter` is in the future and the page still shows the old state. The Deployment recreates the Pods.

   ```bash
   kubectl get pods -A | grep courier
   kubectl delete pod -n <courier-namespace> <courier-pod>
   ```

### Cause 2: the alert names a certificate, and no Secret with that name exists

1. Map the certificate name to its Secret before deleting anything:

   ```bash
   kubectl get certificate -A -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,SECRET:.spec.secretName' \
     | grep <certificate-name>
   kubectl get secret -A \
     -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.metadata.annotations}{"\n"}{end}' \
     | grep <certificate-name>
   ```

2. Print the `tls.crt` dates of the Secret found. If they are only inside the 30-day window, leaving it for automatic renewal is the default answer.

3. To renew now, back up and delete that Secret (for `katanomi-artifacts-serving-cert`: `katanomi-artifacts-webhook-service-cert` in `operators`).

   > **Warning:** Deleting `katanomi-artifacts-webhook-service-cert` removes the webhook certificate of the katanomi artifacts component until it is reissued; calls to that webhook fail in the gap. Do this only when the lookup in step 1 has tied this Secret to the alerting certificate name. Rollback is `kubectl apply -f` of the backup. This method is not confirmed for every platform component, so do not apply it to another Secret by analogy.

   ```bash
   umask 077
   kubectl get secret -n operators katanomi-artifacts-webhook-service-cert -o yaml > "$HOME/katanomi-artifacts-webhook-service-cert.yaml"
   kubectl delete secret -n operators katanomi-artifacts-webhook-service-cert
   kubectl get secret -n operators katanomi-artifacts-webhook-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

4. Restart `courier` on the global cluster (step 4 of Cause 1, with its Warning) so that the page shows the new date. Without the restart the page can lag for a while.

### Cause 3: issuerRef has group ait.alauda.io, so cert-manager does not reissue rds-operator-controller-manager-service-cert

1. Confirm the signature: the certificate is expired or its Secret is missing after a delete, and `issuerRef` contains `group: ait.alauda.io`.

   ```bash
   kubectl get certificate -A | grep rds-operator-controller-manager-service-cert
   kubectl get certificate -n operators rds-operator-controller-manager-service-cert -o jsonpath='{.spec.issuerRef}{"\n"}{.spec.secretName}{"\n"}'
   kubectl get secret -n operators rds-operator-controller-manager-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

   If the Certificate is in another namespace, use that namespace.

2. Remove `issuerRef.group`.

   > **Warning:** Removing `issuerRef.group` hands issuance of this certificate to cert-manager and the `cpaas-ca` ClusterIssuer; cert-manager rewrites the Secret with a new key and certificate, and the rds-operator serves it from then on. Do this only for `rds-operator-controller-manager-service-cert` when step 1 confirmed the signature; do not apply it to other certificates. Back up the Certificate and the Secret first. Rollback is `kubectl apply -f` of the Certificate backup, which puts the group back; the reissued certificate stays until the Secret backup is also applied.

   ```bash
   umask 077
   kubectl get certificate -n operators rds-operator-controller-manager-service-cert -o yaml > "$HOME/rds-operator-certificate.yaml"
   kubectl get secret -n operators rds-operator-controller-manager-service-cert -o yaml > "$HOME/rds-operator-secret.yaml" 2>/dev/null
   kubectl patch certificate -n operators rds-operator-controller-manager-service-cert --type=json \
     -p '[{"op": "remove", "path": "/spec/issuerRef/group"}]'
   kubectl get certificate -n operators rds-operator-controller-manager-service-cert
   kubectl get secret -n operators rds-operator-controller-manager-service-cert -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

   `kubectl edit` of the Certificate, deleting the `group` line, has the same effect. The new `notAfter` should be about two years ahead. Check the alert again the next day.

### Cause 4: the alerting certificate is on another cluster

1. Read the cluster name from the alert or inspection row, switch to that cluster's kubeconfig (or the console terminal of that cluster), and search there:

   ```bash
   kubectl get secret -A | grep <certificate-name>
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates
   ```

2. Renew it with the method that matches the name on that cluster: Cause 1 for `devops-tool-operator-controller-manager-service-cert`, or "Operator service certificates such as packageserver-service-cert about to expire or not renewed on ACP" for operator service certificates. The same Warning and backup apply. Do not delete a different Secret on the current cluster in its place.

## Diagnostic Steps

1. Print the Certificate status and the Secret it names:

   ```bash
   kubectl get certificate -A | grep -v True
   kubectl get certificate -n <namespace> <certificate-name> \
     -o jsonpath='{.spec.secretName}{"\n"}{.spec.issuerRef}{"\n"}{range .status.conditions[*]}{.type}{"="}{.status}{" "}{.message}{"\n"}{end}'
   ```

2. Branch:

   - A condition reads `Existing private key is not up to date for spec: [spec.keyAlgorithm]`: Cause 1.
   - The page still shows a renewed certificate as expired and the browser console reports `duplicate series` with `phase="Expired"` and `phase="Normal"`: step 4 of Cause 1.
   - The alert name matches no Secret on the alert's cluster: Cause 2. No Secret on the cluster you searched, and the alert names a different cluster: Cause 4.
   - `issuerRef.group: ait.alauda.io` on `rds-operator-controller-manager-service-cert`, and the certificate expired or was not reissued after a delete: Cause 3.
   - The Certificate is Ready, `notAfter` is in the future, and only the 30-day alert fired: "Platform certificate expiry alert for a cert-manager serving certificate that renews by itself on ACP".
