---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Container Security Collector Pods CrashLoopBackOff Due to Expired Scanner TLS
## Issue

Collector pods on a Container Security secured cluster enter `CrashLoopBackOff` with very high restart counts. The pod-readiness column shows `2/3` — one container of the three keeps failing to start. Scanner pods report `0/1` running. Sensor logs reveal the underlying chain failure with an expired-certificate error against the Central endpoint:

```text
grpc_connection.go:95: Error: checking central status over HTTP failed:
pinging Central: calling https://central-stackrox.apps.example.com:443/v1/ping:
Get "https://central-stackrox.apps.example.com:443/v1/ping":
remote error: tls: expired certificate
```

A typical pod listing in the install namespace looks like:

```text
collector-xxxx                  2/3  CrashLoopBackOff  1399  3d
collector-yyyy                  2/3  CrashLoopBackOff  1398  3d
scanner-aaaa-bbbb               0/1  Running           274   5d
scanner-db-cccc-dddd            1/1  Running           0     5d
sensor-eeee-ffff                1/1  Running           0     5d
```

## Root Cause

Container Security uses an internal mTLS chain to authenticate Scanner ↔ Scanner-DB ↔ Sensor ↔ Central. The leaf certificates in the secrets `scanner-tls` and `scanner-db-tls` are issued for a fixed validity (typically one year). When that validity window elapses without rotation, the TLS handshake from any component that consumes those secrets fails on the receiving side with `tls: expired certificate`. Collector containers cannot complete the handshake to Sensor (which itself cannot validate Scanner-DB), so the dependent container in each Collector pod restarts in a loop.

The operator that manages the platform regenerates these secrets when they are deleted, sourcing fresh material from the cluster init bundle held in Central. Manual rotation by editing the secret in place is not supported and will be reconciled away.

## Resolution

Delete the expired TLS secrets so the operator regenerates them, then restart the dependent pods.

### 1. Confirm the certificate expiration

```bash
kubectl -n stackrox get secret scanner-tls -o json \
  | jq -r '.data["cert.pem"]' | base64 -d \
  | openssl x509 -noout -subject -dates -issuer

echo "-----"

kubectl -n stackrox get secret scanner-db-tls -o json \
  | jq -r '.data["cert.pem"]' | base64 -d \
  | openssl x509 -noout -subject -dates -issuer
```

The `notAfter` date should be in the past for one or both certs. If both are still valid, the symptom is something other than expiry — investigate the Sensor↔Central network path or the cluster init bundle freshness instead.

### 2. Back up the existing secrets

If the regeneration produces an unexpected SAN or chain, the backup lets you roll back. Capture both before deleting either:

```bash
kubectl -n stackrox get secret scanner-tls    -o yaml > scanner-tls.bak.yaml
kubectl -n stackrox get secret scanner-db-tls -o yaml > scanner-db-tls.bak.yaml
```

Store the backups outside the cluster (object storage, internal secret manager, etc.).

### 3. Delete the expired secrets

```bash
kubectl -n stackrox delete secret scanner-tls scanner-db-tls
```

The operator's reconcile loop notices the missing secrets within a few seconds and creates new ones using the current root in the init bundle. Confirm:

```bash
kubectl -n stackrox get secret scanner-tls scanner-db-tls
```

The `AGE` column should be a few seconds for both. Re-run the `openssl` decode from step 1 against the new secrets — the `notAfter` date should now be far in the future.

### 4. Restart Sensor, Scanner, Scanner-DB, and Collector pods

The cached TLS material is held in memory; deleting the pods forces them to re-read the regenerated secrets:

```bash
kubectl -n stackrox delete pod -l app=sensor
kubectl -n stackrox delete pod -l app=scanner
kubectl -n stackrox delete pod -l app=scanner-db
kubectl -n stackrox delete pod -l app=collector
```

The Sensor and Scanner Deployments come back to `Running 1/1`. The Collector DaemonSet pods return to `Ready 3/3` once Sensor is healthy and the new chain validates against Central.

### 5. Verify

```bash
kubectl -n stackrox get pods
kubectl -n stackrox logs -l app=sensor --tail=20 | grep -E "Central status|tls"
```

A healthy Sensor reports `Check Central status: ok` periodically and no `tls: expired certificate` lines appear. Restart counts on Collector pods should stabilize at the same value across two consecutive `kubectl get pods` invocations spaced a minute apart.

## Diagnostic Steps

If the operator does **not** regenerate the deleted secrets, the platform-control plane is not running or has lost its connection to Central. Check the operator pod and CR status:

```bash
kubectl -n rhacs-operator get pods
kubectl -n stackrox get securedcluster -o yaml | grep -A5 conditions
```

If the operator is healthy but the secrets are still missing minutes after deletion, the cluster init bundle in Central has expired or been revoked. Generate a fresh init bundle from the Central console (**Platform Configuration → Integrations → Cluster Init Bundle**), download the secrets file, and apply it on the secured cluster:

```bash
kubectl apply -n stackrox -f /path/to/<bundle-name>-cluster-init-secrets.yaml
```

Then repeat steps 3 and 4 above.

> **Operational note**: stand up a recurring monitor for the `notAfter` date of internal TLS secrets in `stackrox`. A scheduled CronJob that compares `openssl x509 -enddate -noout` against `now + 30 days` and pages the owning team gives a 30-day warning before this exact failure mode repeats. The default issuance period is one year and the alert is straightforward to wire from existing platform monitoring.
