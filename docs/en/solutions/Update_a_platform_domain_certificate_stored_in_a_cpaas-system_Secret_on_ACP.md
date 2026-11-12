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

# Update a platform domain certificate stored in a cpaas-system Secret on ACP

## Issue

One of the following applies to a certificate bound to a domain under **Platform Management > Network Management**:

- A certificate under **Network Management > Certificates** shows a warning icon with the tooltip `证书不在有效期内` (certificate not within its validity period), and a new certificate for the same domain is at hand.
- A certificate management system has to update domain certificates automatically. The questions are where the certificates bound to domains under **Network Management > Domains** are stored, whether they are ConfigMaps, and whether the public key and private key shown in the **Update Domain** dialog can be changed through an API.
- On ACP 3.18.1 the GitLab, Harbor, Nexus, or Jenkins certificate was replaced in the Secret that the toolchain instance names, and after some time the Secret is back to the old certificate.
- The platform domain certificate is held in Secret `cpaas-system/legal-domain.tls` and has to be renewed.

This article covers domain certificates. The certificate of the platform access address itself (`dex.tls`) is covered in "Replace the platform access certificate in dex.tls on ACP". Business certificates in project Secrets are covered in "Business TLS certificate not renewed, not reloaded by ingress-nginx, or rejected with a format error on import on ACP".

## Root Cause

### Cause 1: domain certificates are Secrets in cpaas-system, updated through the Kubernetes Secret API

All platform domain certificates are stored as Secrets in namespace `cpaas-system` with label `global-secret=true`, not in ConfigMaps. A certificate imported when a domain is created carries the annotation `cpaas.io/domain-name-ref` with the domain name. A certificate assigned to all projects also carries the label `project.cpaas.io/ALL_ALL: "true"`. The certificate data is in `data.tls.crt` and `data.tls.key`.

The platform has no separate API for modifying a domain certificate. The console itself updates it with a `PATCH` to `/api/v1/namespaces/cpaas-system/secrets/<secret-name>`. An external certificate management system does the same through the native Kubernetes Secret API, patching `tls.crt` and `tls.key` (base64) of that Secret. Editing those two fields with `kubectl edit` or `kubectl apply` also updates the certificate: the Certificates page then shows the new validity on the same Secret, still associated with the same domain, and the warning icon disappears. Certificates are changed one Secret at a time; there is no batch replacement.

A platform API token for automation is created in the console: open the avatar menu in the top-right corner, select **Personal Info**, open the **API Token** tab, and use **Add API Token**.

### Cause 2: on ACP 3.18.1 a toolchain TLS Secret edit is reverted because the domain is managed on the Domains page

On ACP 3.18.1 the access domains of the DevOps v3 toolchains (GitLab, Harbor, Nexus, Jenkins) are exposed through the platform ALB, and each toolchain instance names its TLS Secret in a `secretName` field. That Secret, of type `kubernetes.io/tls` in `cpaas-system`, carries the labels `global-secret: "true"` and `project.cpaas.io/ALL_ALL: "true"`. These labels mark it as a certificate managed by the platform's domain management (**Network Management > Domains**). The platform therefore writes the domain's certificate back over a direct edit of the Secret, and after a while every toolchain Secret shows the old certificate again. Changing the certificate on the **Domains** page makes the change stick.

### Cause 3: the domain certificate in cpaas-system/legal-domain.tls is renewed by recreating the Secret and restarting global-alb2

On some installations, for example trial or demo environments, the platform domain certificate is stored in Secret `legal-domain.tls` in `cpaas-system`. It is renewed by backing up that Secret, deleting it, recreating it from the new certificate and key with `kubectl create secret tls`, and restarting the `global-alb2` component so that it serves the new certificate.

## Resolution

Before any change, verify the new pair: the two commands below must print the same hash, `notAfter` must be in the future, and the certificate must name the domain.

```bash
openssl x509 -in tls.crt -noout -pubkey | openssl md5
openssl pkey -in tls.key -pubout | openssl md5
openssl x509 -in tls.crt -noout -dates -subject -ext subjectAltName
```

### Cause 1: domain certificates are Secrets in cpaas-system, updated through the Kubernetes Secret API

1. On the global cluster, list the domain certificate Secrets and find the one for a domain:

   ```bash
   kubectl get secrets -n cpaas-system -l global-secret=true
   kubectl get secrets -n cpaas-system -l global-secret=true \
     -o go-template='{{range .items}}{{if eq (index .metadata.annotations "cpaas.io/domain-name-ref") "<domain>"}}{{.metadata.name}}{{"\n"}}{{end}}{{end}}'
   ```

2. Back up the Secret and patch `tls.crt` and `tls.key`.

   > **Warning:** Patching the Secret changes the certificate served for that domain at once; a key that does not match the certificate, or a certificate for another name, breaks HTTPS for every service that uses it. Do this only after the pair check above succeeded. Rollback is `kubectl apply -f` of the backup.

   ```bash
   umask 077
   kubectl get secret -n cpaas-system <secret-name> -o yaml > "$HOME/<secret-name>.yaml"
   kubectl patch secret -n cpaas-system <secret-name> --type merge \
     -p "{\"data\":{\"tls.crt\":\"$(base64 -w 0 tls.crt)\",\"tls.key\":\"$(base64 -w 0 tls.key)\"}}"
   kubectl get secret -n cpaas-system <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject
   ```

   From an automation system, send the same change as an HTTP `PATCH` to the Secret, with the API token from Cause 1. `${APISERVER}` is the Kubernetes API endpoint of the global cluster. The values must be base64-encoded on a single line, which `base64 -w 0` produces.

   ```bash
   curl -X PATCH -H "Content-Type: application/strategic-merge-patch+json" \
     -H "Authorization: Bearer ${TOKEN}" --cacert /etc/kubernetes/pki/ca.crt \
     "${APISERVER}/api/v1/namespaces/cpaas-system/secrets/<secret-name>" \
     -d "{\"data\": {\"tls.crt\": \"$(base64 -w 0 tls.crt)\", \"tls.key\": \"$(base64 -w 0 tls.key)\"}}"
   ```

3. Check the **Certificates** page: the validity is the new one and the `证书不在有效期内` icon is gone. If the Secret returns to the old certificate after a while, use Cause 2.

### Cause 2: on ACP 3.18.1 a toolchain TLS Secret edit is reverted because the domain is managed on the Domains page

1. Read the `secretName` field from the toolchain instance, then check the labels of that Secret and the certificate it holds:

   ```bash
   kubectl get secret -n cpaas-system <toolchain-secret> -o jsonpath='{.type}{"\n"}{.metadata.labels}{"\n"}'
   kubectl get secret -n cpaas-system <toolchain-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -ext subjectAltName
   ```

   The labels `global-secret: "true"` and `project.cpaas.io/ALL_ALL: "true"` mean that the certificate is managed through **Network Management > Domains**.

2. Update the certificate on the Domains page.

   > **Warning:** Updating the domain certificate changes the certificate every toolchain and service on that domain presents, at once. A certificate that does not cover the domain (for example the wildcard `*.<domain>`) or a key that does not match breaks HTTPS for all of them. Do this only after the pair check above. Keep the old certificate and key files; rollback is to update the domain again with them.

   1. Open **Platform Management > Network Management > Domains** and choose the update action for the domain (for example `*.<domain>`).
   2. Keep the certificate toggle enabled.
   3. Paste or import the new public key (certificate) and private key.
   4. Click **Update**.

3. Check the toolchain Secret again with step 1, and check the certificate served on each toolchain hostname:

   ```bash
   echo | openssl s_client -connect <toolchain-host>:443 -servername <toolchain-host> 2>/dev/null \
     | openssl x509 -noout -dates -subject
   ```

### Cause 3: the domain certificate in cpaas-system/legal-domain.tls is renewed by recreating the Secret and restarting global-alb2

1. Print the current certificate and the new one:

   ```bash
   kubectl get secret -n cpaas-system legal-domain.tls -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -ext subjectAltName
   kubectl get secret -n cpaas-system legal-domain.tls -o jsonpath='{.metadata.labels}{"\n"}{.metadata.annotations}{"\n"}'
   openssl x509 -in <new-cert>.pem -noout -dates -subject -ext subjectAltName
   ```

2. Recreate the Secret and restart `global-alb2`.

   > **Warning:** Between the delete and the create, the platform domain has no certificate in this Secret, and restarting `global-alb2` briefly interrupts traffic through the global ALB. Do this in a maintenance window and only when the domain certificate is in `cpaas-system/legal-domain.tls` and a verified new pair for the same domain is on this node. Rollback is `kubectl apply -f` of the backup, followed by the same restart.

   ```bash
   umask 077
   kubectl get secret -n cpaas-system legal-domain.tls -o yaml > "$HOME/legal-domain.tls.yaml"
   kubectl delete secret -n cpaas-system legal-domain.tls
   kubectl create secret tls legal-domain.tls --cert=<new-cert>.pem --key=<new-cert>.key -n cpaas-system
   kubectl get deploy -n cpaas-system | grep global-alb2
   kubectl rollout restart deployment -n cpaas-system global-alb2
   kubectl rollout status deployment -n cpaas-system global-alb2
   echo | openssl s_client -connect <platform-domain>:443 -servername <platform-domain> 2>/dev/null \
     | openssl x509 -noout -dates -subject
   ```

   `kubectl create secret tls` does not copy labels or annotations from the old Secret. If the domain does not pick up the new Secret, compare its labels and annotations with the backup and add the missing ones with `kubectl label` and `kubectl annotate`. If `kubectl get deploy` does not list `global-alb2`, restart the workload kind that `kubectl get pods -n cpaas-system | grep global-alb2` shows.

## Diagnostic Steps

1. Find the Secret behind the certificate and read its labels, annotations, and dates:

   ```bash
   kubectl get secrets -n cpaas-system -l global-secret=true --show-labels
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.metadata.labels}{"\n"}{.metadata.annotations}{"\n"}'
   kubectl get secret -n <namespace> <secret-name> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. Branch:

   - Where a domain certificate is stored, how to update it from automation or `kubectl`, or the Certificates page shows `证书不在有效期内`: Cause 1.
   - A toolchain TLS Secret with `global-secret: "true"` returns to the old certificate after a direct edit: Cause 2.
   - The domain certificate is Secret `cpaas-system/legal-domain.tls`: Cause 3.
   - The Secret already holds the new certificate but clients still receive the old one: check the ALB rule or an upstream load balancer in front of the platform, which can serve its own copy.
