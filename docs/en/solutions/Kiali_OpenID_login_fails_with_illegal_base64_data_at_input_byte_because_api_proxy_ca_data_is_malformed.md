---
kind:
  - Troubleshooting
products:
  - Alauda Service Mesh
ProductsVersion: []
---

# Kiali OpenID login fails with illegal base64 data at input byte because api_proxy_ca_data is malformed

## Issue

Opening Kiali for a workload cluster through the platform (`https://<platform-address>/clusters/<cluster-name>/kiali`) redirects to the ACP login page. After a successful platform login, Kiali reports that the OpenID login failed. The browser console shows:

```text
Authentication openid_error: Unable to create a Kubernetes client from the auth token: illegal base64 data at input byte <n>
```

The Kiali CR uses `spec.auth.strategy: openid`, and the Kiali pod itself is running.

## Root Cause

With the `openid` strategy on ACP, Kiali sends the user's token to the platform's Kubernetes API proxy (`spec.auth.openid.api_proxy`) and trusts that proxy with the CA given in `spec.auth.openid.api_proxy_ca_data`. That field must hold the platform CA certificate **base64-encoded**, exactly as it is stored in the `dex.tls` Secret on the `global` cluster.

During installation the value is normally filled in with `export PLATFORM_CA=<platform-ca>` and `envsubst < kiali.yaml | kubectl apply -f -`, which writes `api_proxy_ca_data: ${PLATFORM_CA}` into the Kiali CR. If the CA is not copied correctly at that point (truncated, extra or missing characters, line breaks, or the decoded PEM text instead of the base64 string), the field is not valid base64. The login through Dex succeeds, but Kiali fails when it decodes the CA to build the Kubernetes client, and reports `illegal base64 data at input byte <n>`, where `<n>` is the position of the first invalid character.

## Resolution

1. On the `global` cluster, save the platform CA as a single base64 line:

   ```bash
   kubectl -n cpaas-system get secret dex.tls -o jsonpath='{.data.ca\.crt}' > platform-ca.b64
   ```

   If `platform-ca.b64` is empty, use the `tls.crt` key instead:

   ```bash
   kubectl -n cpaas-system get secret dex.tls -o jsonpath='{.data.tls\.crt}' > platform-ca.b64
   ```

   Check that the file decodes to a certificate:

   ```bash
   base64 -d platform-ca.b64 | openssl x509 -noout -subject -enddate
   ```

2. Copy `platform-ca.b64` to a host with `kubectl` access to the workload cluster where Kiali runs, without opening and re-pasting it in an editor.

3. Find the Kiali CR and write the correct value into `api_proxy_ca_data`:

   ```bash
   kubectl get kiali -A
   kubectl -n <kiali-namespace> patch kiali <kiali-name> --type merge \
     -p "{\"spec\":{\"auth\":{\"openid\":{\"api_proxy_ca_data\":\"$(tr -d '\n' < platform-ca.b64)\"}}}}"
   ```

   Editing the field directly with `kubectl edit kiali` works too, as long as the value is pasted as one unbroken line.

4. Wait for the Kiali operator to roll out the new configuration, then open Kiali through the platform again and log in. Kiali is briefly unavailable while its pod is replaced.

   ```bash
   kubectl -n <kiali-namespace> get pods -w | grep kiali
   ```

## Diagnostic Steps

1. Check that the value in the CR decodes to a certificate. A `base64: invalid input` error, or an `openssl` error, confirms this issue:

   ```bash
   kubectl -n <kiali-namespace> get kiali <kiali-name> \
     -o jsonpath='{.spec.auth.openid.api_proxy_ca_data}' | base64 -d | openssl x509 -noout -subject
   ```

2. Compare the CR value with the `global` cluster's `dex.tls` value character by character, for example by comparing their checksums:

   ```bash
   kubectl -n <kiali-namespace> get kiali <kiali-name> -o jsonpath='{.spec.auth.openid.api_proxy_ca_data}' | md5sum
   kubectl -n cpaas-system get secret dex.tls -o jsonpath='{.data.ca\.crt}' | md5sum    # on global; use tls.crt if ca.crt is empty
   ```

3. Check the other OpenID settings while you are there. `api_proxy` should be `<platform-address>/kubernetes/<cluster-name>`, and `issuer_uri` should point to the platform Dex (`<platform-address>/dex`):

   ```bash
   kubectl -n <kiali-namespace> get kiali <kiali-name> -o jsonpath='{.spec.auth.openid}{"\n"}'
   ```

4. Look for the same error in the Kiali log to confirm that the failure happens when the Kubernetes client is created, not earlier at the Dex redirect:

   ```bash
   kubectl -n <kiali-namespace> logs deploy/kiali --tail=300 | grep -iE 'openid|base64|token'
   ```
