---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

After rotating internal certificates from the Container Security web console — typically by clicking the certificate-renewal banner — Sensor pods on the secured cluster start crashing and Collector pods cannot connect to them. Logs from the Sensor container contain a TLS handshake failure pointing back at Central:

```text
common/centralclient: Check Central status failed: receiving Central metadata:
calling https://central.stackrox.svc:443/v1/metadata:
Get "https://central.stackrox.svc:443/v1/metadata":
remote error: tls: bad certificate. Retrying after 693ms...
```

In parallel, Collector pods log:

```text
[FATAL] Unable to connect to Sensor at 'sensor.stackrox.svc:443'.
```

The pods are typically in `CrashLoopBackOff` after the first few retries.

## Root Cause

The Container Security platform is composed of Central (the management plane) and the Secured Cluster components — Sensor, Collector, Admission Controller, Scanner. They authenticate to each other with mTLS using a chain rooted in Central. When the certificates are renewed in-place from the console banner, Central regenerates the leaf certificates but the Secured Cluster keeps the *previous* CA bundle baked into its existing init bundle and Sensor secrets. The new leaf no longer chains back to the bundle the Sensor trusts, so the TLS handshake to Central fails. Collector then cannot reach Sensor, and the cascade fails the whole Secured Cluster.

A second variant of the same root cause appears on Scanner: if the `scanner-db-tls` Secret was issued with a SAN for the wrong namespace (a known issue when the Secured Cluster was reinstalled into a non-default namespace), the database client refuses the certificate and the Scanner cannot start. The Scanner log then contains:

```text
{"Event":"Failed to open database.","Level":"error",
 "error":"pgsql: could not open database: x509: certificate is valid for
   scanner-db.stackrox, scanner-db.stackrox.svc,
   not scanner-db.<other-ns>.svc"}
```

## Resolution

The supported recovery is to regenerate the Secured Cluster's init bundle from Central, apply it on the cluster, and let the operator regenerate the Sensor / Scanner / Scanner-DB certificates from the new chain.

### 1. Generate a fresh Cluster Init Bundle

In the Central console: **Platform Configuration → Integrations → Cluster Init Bundle → Generate Bundle**. Pick a name (the existing bundle is replaced; older bundles for the same cluster can stay until rotation is confirmed). Download the generated *Kubernetes secrets* file — this is a multi-document YAML containing `*-tls` Secrets for the Sensor, Collector, and Admission Controller.

### 2. Apply the new bundle on the secured cluster

```bash
kubectl apply -n stackrox -f /path/to/<bundle-name>-cluster-init-secrets.yaml
```

Apply against the namespace that hosts Sensor (commonly `stackrox`). The Secrets carry `metadata.namespace` already; if you renamed the install namespace, edit the YAML accordingly before applying.

### 3. Inspect the Scanner DB certificate SAN

If the symptom is the second variant (Scanner failing with `pgsql: could not open database: x509`), check the existing Scanner-DB cert before regenerating it:

```bash
kubectl -n stackrox get secret scanner-db-tls -o json \
  | jq -r '.data["cert.pem"]' | base64 -d \
  | openssl x509 -noout -text \
  | grep -A1 "Subject Alternative Name"
```

If the SANs do not list the install namespace (for example, `scanner-db.<your-ns>.svc`), the cert is mis-issued. Continue to step 4.

### 4. Back up and delete the broken Sensor / Scanner Secrets

The operator regenerates these from the init bundle when they are missing. Back them up first in case rollback is needed:

```bash
kubectl -n stackrox get secret scanner-db-tls -o yaml > scanner-db-tls.bak.yaml
kubectl -n stackrox get secret scanner-tls    -o yaml > scanner-tls.bak.yaml
kubectl -n stackrox get secret sensor-tls     -o yaml > sensor-tls.bak.yaml

kubectl -n stackrox delete secret scanner-db-tls scanner-tls sensor-tls
```

Confirm the operator has recreated each one with a fresh `creationTimestamp`:

```bash
kubectl -n stackrox get secret scanner-db-tls scanner-tls sensor-tls
```

### 5. Restart the dependent pods

The cached TLS material is held in memory; bouncing the pods picks up the new Secrets:

```bash
kubectl -n stackrox delete pod -l app=sensor
kubectl -n stackrox delete pod -l app=scanner
kubectl -n stackrox delete pod -l app=scanner-db
kubectl -n stackrox delete pod -l app=collector
```

The Collector pods will return to `Ready 3/3` once Sensor is back in `Running` and the new CA chain validates against Central.

### 6. Verify end-to-end

```bash
kubectl -n stackrox get pods
kubectl -n stackrox logs -l app=sensor --tail=20 | grep -E "Central status|tls"
```

A healthy Sensor reports `Check Central status: ok` periodically and no `tls:` errors.

## Diagnostic Steps

Before regenerating the bundle, confirm the failure is TLS chain mismatch and not a network or RBAC issue. Inspect the Sensor leaf certificate and the CA bundle it trusts:

```bash
# What the Sensor presents to Central
kubectl -n stackrox get secret sensor-tls -o json \
  | jq -r '.data["sensor-cert.pem"]' | base64 -d \
  | openssl x509 -noout -issuer -subject -dates

# What the Sensor trusts when calling Central
kubectl -n stackrox get secret sensor-tls -o json \
  | jq -r '.data["ca.pem"]' | base64 -d \
  | openssl x509 -noout -issuer -subject -dates
```

If the `Issuer` of the Sensor leaf does not match the `Subject` of the trusted CA bundle, the handshake will fail with `tls: bad certificate`, which is the symptom this article addresses. Equally, if the trusted CA in the Secret is **before** the rotation date but the leaf was reissued **after**, the bundle is stale and step 1 above is the correct fix.

If the Sensor logs do not contain `tls: bad certificate` but instead show `connection refused` or `i/o timeout` against `central.stackrox.svc`, the issue is networking (NetworkPolicy, DNS, missing Service) rather than certificate rotation. The bundle regeneration will not help in that case.
