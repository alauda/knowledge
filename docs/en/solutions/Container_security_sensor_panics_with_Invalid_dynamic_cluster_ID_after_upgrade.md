---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Container security sensor panics with "Invalid dynamic cluster ID" after upgrade
## Issue

After upgrading the StackRox-based Container Security product on ACP (sensor/collector/admission-controller on a secured cluster, central on the management cluster), the sensor pod enters `CrashLoopBackOff`. Its logs show a panic similar to:

```text
central_communication_impl.go:192: Warn: Central is running a legacy version that might not support all current features
cluster_id.go:51: Panic: Invalid dynamic cluster ID value "":
  no concrete cluster ID was specified in conjunction with wildcard ID
  "00000000-0000-0000-0000-000000000000"
panic: Invalid dynamic cluster ID value "":
  no concrete cluster ID was specified in conjunction with wildcard ID
  "00000000-0000-0000-0000-000000000000"
```

Inspecting the logs of the `central` pod on the management cluster shows a matching pair of messages — either an explicit init-bundle revocation, or nothing at all but TLS errors from the sensor:

```text
backend_impl.go:187: Error: init bundle cert is revoked: ["9639bd44-05ea-440d-8984-5784a4df35dd"]
interceptor.go:28: Warn: Cannot extract identity: init bundle verification failed
  "9639bd44-05ea-440d-8984-5784a4df35dd": init bundle is revoked
```

## Root Cause

A StackRox sensor is bound to its central via an **init bundle** — a pair of mTLS secrets the sensor uses to authenticate itself the first time it talks to central. Once authenticated, the sensor requests a per-cluster TLS identity, at which point the cluster is assigned a concrete cluster ID and the init bundle is no longer the identity-bearing credential.

There are two distinct ways this panic arises:

- **Init bundle revoked.** An administrator revoked the init bundle on central (or the bundle was replaced before the sensor successfully completed its first identity issue). Central rejects the mTLS, so the sensor never transitions from the wildcard cluster ID (`00000000-0000-0000-0000-000000000000`) to a real one, and then panics when it tries to act on the empty value.

- **Sensor→central mTLS is terminated by an intermediary.** When the connection between sensor and central runs through an ingress that terminates TLS and re-encrypts (re-encrypt route or a reverse proxy that does not forward the client certificate), the client certificate never reaches central. Central sees an unauthenticated sensor, fails the identity handshake, and the sensor never gets past the wildcard ID. Central logs show TLS / identity errors but not necessarily an explicit revocation message.

## Resolution

The resolution depends on which of the two causes the log evidence points at.

**Case 1 — init bundle revoked.** Create a new init bundle on central, deploy it to the secured cluster, and then let the sensor re-authenticate.

1. In the central UI, navigate to **Platform Configuration → Integrations → Authentication Tokens** and use **Create Cluster Init Bundle** to mint a fresh bundle. Download the Kubernetes secret file.

2. On the secured cluster, apply the new init bundle into the namespace where the sensor is running. The file is a standard Kubernetes manifest with two `Secret` objects — `admission-control-tls` and `collector-tls` (and `sensor-tls` for older bundles):

   ```bash
   kubectl -n <sensor-namespace> apply -f <downloaded-bundle>.yaml
   ```

   `kubectl create -f` also works for the initial apply, but `apply` is idempotent and will reconcile the replacement cleanly if an older secret was left behind.

3. Delete the running sensor pod so that it picks up the new secrets:

   ```bash
   kubectl -n <sensor-namespace> rollout restart deployment sensor
   ```

4. Watch the sensor logs until it reports a successful handshake and the cluster returns to **Healthy** status in the central UI.

**Case 2 — re-encrypt route in front of central.** Replace the sensor-facing path with a connection method that preserves the client certificate end-to-end. On ACP this usually means exposing central through an `Ingress` / `ALB` rule in **passthrough** mode (SSL passthrough), or through a dedicated `Service` of type `LoadBalancer` that does not terminate TLS. Keep the re-encrypt path for human browser access to the central UI — it is fine for that — but never route sensor traffic through it. Once the sensor is reconnected via a passthrough path, delete the sensor pod and confirm the handshake succeeds with the existing (non-revoked) init bundle.

## Diagnostic Steps

Verify which failure mode you are in by correlating sensor and central logs. Collect them from the two clusters in parallel:

```bash
# secured cluster
kubectl -n <sensor-namespace> logs -l app=sensor --tail=200 \
  | grep -E 'cluster_id|Invalid dynamic cluster ID|init bundle'

# management cluster
kubectl -n <central-namespace> logs -l app=central --tail=200 \
  | grep -E 'init bundle|Cannot extract identity|backend_impl'
```

An `init bundle cert is revoked` message on central nails down Case 1. An absence of revocation messages but presence of `Cannot extract identity` or TLS handshake failures points at Case 2.

Confirm the ingress path between sensor and central:

```bash
# From the sensor cluster, follow the CA chain that reaches central.
kubectl -n <sensor-namespace> get deployment sensor -o yaml \
  | grep -E 'ROX_CENTRAL_ENDPOINT|endpoint'

# Identify which Ingress/ALB rule fronts central and inspect its TLS mode.
kubectl -n <central-namespace> get ingress,svc
```

Check the existing TLS secrets on both sides are intact — a corrupted `sensor-tls` secret looks superficially like a revoked bundle:

```bash
kubectl -n <sensor-namespace> get secret sensor-tls collector-tls admission-control-tls -o yaml
kubectl -n <central-namespace> get secret central-tls -o yaml
```

If those secrets are present and well-formed but the sensor still fails, capture a full diagnostic bundle via the central UI (**Platform Configuration → System Health → Diagnostic Bundle**) plus the `stackrox` / sensor namespace object dump from the secured cluster:

```bash
kubectl -n <sensor-namespace> get all,events
kubectl cluster-info dump --namespaces=<sensor-namespace> --output-directory=/tmp/stackrox-dump
```

That bundle plus the sensor-side logs is enough evidence to separate the revocation case from the TLS-intermediary case conclusively.
