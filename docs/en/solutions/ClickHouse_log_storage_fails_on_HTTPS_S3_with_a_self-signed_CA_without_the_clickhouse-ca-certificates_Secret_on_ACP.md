---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.3.x
---

# ClickHouse log storage fails on HTTPS S3 with a self-signed CA without the clickhouse-ca-certificates Secret on ACP

## Issue

The ClickHouse log storage plugin is installed (from the console or from YAML) with S3 object storage, and the S3 endpoint is served over HTTPS with a certificate signed by a private or self-signed CA. The installation does not complete because ClickHouse in the ClickHouseInstallation (CHI) `cpaas-clickhouse` in `cpaas-system` cannot start. The container stdout may not show the reason. The certificate verification error for the S3 endpoint is written to `clickhouse-server.err.log` inside the ClickHouse container.

## Root Cause

ClickHouse verifies the TLS certificate of the S3 endpoint against the CA bundle at `/etc/ssl/certs/ca-certificates.crt` in its container. The default bundle contains only public CAs, so a certificate from a private or self-signed CA fails verification and ClickHouse cannot use the S3 disk.

The plugin chart supports a custom CA bundle. During rendering it looks for the Secret `clickhouse-ca-certificates` (key `ca-certificates.crt`) in `cpaas-system`:

- If the Secret exists, the chart mounts it into the ClickHouse container at `/etc/ssl/certs/ca-certificates.crt`.
- If the Secret does not exist, nothing is mounted, and the S3 certificate verification fails.

This lookup is part of the plugin starting with ACP 4.3.2. The Secret is not created automatically and must be created by hand. The mounted file **replaces** the whole system CA bundle of the container, so it must hold the public CAs as well as the S3 CA.

## Resolution

1. Build a complete CA bundle: the system CA bundle followed by the CA certificate(s) of the S3 endpoint. For example, on a Linux host that has a current system bundle at the same path:

   ```bash
   cat /etc/ssl/certs/ca-certificates.crt s3-ca.crt > ca-certificates.crt
   ```

   Append each additional CA certificate in PEM format, one after another.

2. Create the Secret in `cpaas-system`:

   ```bash
   kubectl -n cpaas-system create secret generic clickhouse-ca-certificates \
     --from-file=ca-certificates.crt=./ca-certificates.crt
   ```

   The same Secret as YAML:

   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: clickhouse-ca-certificates
     namespace: cpaas-system
   type: Opaque
   stringData:
     ca-certificates.crt: |
       -----BEGIN CERTIFICATE-----
       <system CA certificates, followed by the S3 CA certificate(s)>
       -----END CERTIFICATE-----
   ```

3. Redeploy the ClickHouse log storage plugin so that the chart renders again and picks up the Secret. Creating the Secret alone does not change a CHI that has already been rendered.

   > **Warning:** Redeploying the log storage plugin restarts ClickHouse, and log, event and audit writes and queries are interrupted until it is running again. Do this only after the diagnostic steps show the S3 certificate error and a CHI without the CA mount. Rollback: delete the Secret and redeploy the plugin again, which brings back the previous rendering.

4. Check that the ClickHouse Pods become `Running` and that the plugin finishes installing:

   ```bash
   kubectl -n cpaas-system get pods | grep -i clickhouse
   ```

## Diagnostic Steps

1. Find the ClickHouse Pods and read the server error log inside the container, not only stdout:

   ```bash
   kubectl -n cpaas-system get pods | grep -i clickhouse
   kubectl -n cpaas-system exec <clickhouse-pod> -c clickhouse -- \
     sh -c 'tail -n 200 /var/log/clickhouse-server/clickhouse-server.err.log'
   ```

   Expected for this issue: TLS or certificate verification errors for the S3 endpoint. If the log path differs, look for `clickhouse-server.err.log` under the log directory configured for the container.

2. Check whether the CA bundle is mounted:

   ```bash
   kubectl -n cpaas-system get secret clickhouse-ca-certificates
   kubectl -n cpaas-system get chi cpaas-clickhouse -o yaml | grep -n -B2 -A4 clickhouse-ca-certificates
   ```

   Expected for this issue: the Secret is `NotFound` and the CHI has no volume or mount for `clickhouse-ca-certificates`. After the fix, both exist and the container has the bundle at `/etc/ssl/certs/ca-certificates.crt`.

3. Check that the S3 endpoint certificate chains to the CA you put in the bundle:

   ```bash
   openssl s_client -connect <s3-host>:<s3-port> -servername <s3-host> -CAfile ca-certificates.crt </dev/null 2>/dev/null | grep -E 'Verify return code'
   ```

   Expected after the bundle is correct: `Verify return code: 0 (ok)`.

4. Rule out look-alikes. When ClickHouse logs that it cannot resolve the Keeper host, or the S3 endpoint is plain HTTP, or the endpoint uses a certificate from a public CA, the CA bundle is not the cause.
