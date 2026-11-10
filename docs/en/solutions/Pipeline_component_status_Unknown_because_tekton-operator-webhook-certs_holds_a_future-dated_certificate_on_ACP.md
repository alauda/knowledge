---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion: []
---

# Pipeline component status Unknown because tekton-operator-webhook-certs holds a future-dated certificate on ACP

## Issue

On a business cluster, the cluster component **Pipeline** (the Tekton operator) shows status Unknown, for example during a routine inspection of cluster components.

Decoding the certificates stored in the Secret `tekton-operator-webhook-certs` in the `tekton-operator` namespace shows a validity period that starts in the future:

```text
notBefore=Oct 29 19:00:14 2027 GMT
notAfter=Nov  5 19:00:14 2027 GMT
```

## Root Cause

### Cause 1: the webhook certificate was issued while the cluster clock was wrong

The Tekton operator keeps the serving certificate of its webhook in the Secret `tekton-operator-webhook-certs`. If the cluster clock was set ahead at some point when the certificate was generated, the certificate carries a `notBefore` date in the future.

A TLS client rejects a certificate whose `notBefore` date has not been reached yet. Even after the clock is correct again, the stored certificate stays not yet valid until that date, and the Pipeline component status is Unknown. Replacing the Secret with an empty one and restarting the operator makes the operator generate a new certificate with the current time.

## Resolution

### Cause 1

1. Check that the clock on every node of the cluster is correct before regenerating the certificate. A certificate regenerated on a wrong clock has the same problem.

   ```bash
   date -u
   chronyc tracking
   ```

   Run these on each node. If the time is wrong, fix time synchronization first (see `Configuring_chrony_NTP_on_Cluster_Nodes.md`).

2. Save the current Secret:

   ```bash
   kubectl -n tekton-operator get secret tekton-operator-webhook-certs -o yaml > tekton-operator-webhook-certs-backup.yaml
   ```

3. Replace the Secret with an empty Secret of the same name.

   > **Warning:** Until the operator writes a new certificate, the Tekton operator webhook cannot serve TLS, and changes to Tekton operator resources (such as `TektonConfig`) can fail admission. Do this only when the certificate in the Secret has a `notBefore` date in the future and the node clocks are correct. Roll back by applying `tekton-operator-webhook-certs-backup.yaml` (remove `metadata.resourceVersion` and `metadata.uid` first) and restarting the operator again.

   ```bash
   kubectl -n tekton-operator delete secret tekton-operator-webhook-certs
   kubectl -n tekton-operator create secret generic tekton-operator-webhook-certs
   ```

4. Restart the Tekton operator so that it generates a new certificate into the empty Secret:

   > **Warning:** The operator Pods restart. Pipelines that are already running are not stopped, but operator reconciliation pauses until the new Pods are Ready. Roll back as in step 3.

   ```bash
   kubectl -n tekton-operator get deployment
   kubectl -n tekton-operator rollout restart deployment <tekton-operator-deployment>
   kubectl -n tekton-operator rollout status deployment <tekton-operator-deployment>
   ```

5. Check the certificate dates again (see Diagnostic Steps) and confirm that the Pipeline component status returns to normal.

## Diagnostic Steps

1. List the keys of the Secret and print the validity of each certificate:

   ```bash
   kubectl -n tekton-operator get secret tekton-operator-webhook-certs -o jsonpath='{.data}' | jq -r 'keys[]'
   kubectl -n tekton-operator get secret tekton-operator-webhook-certs \
     -o jsonpath='{.data.<key>}' | base64 -d | openssl x509 -noout -dates
   ```

   Expected for this cause: `notBefore` is later than the current time (`date -u`). A key that holds a private key instead of a certificate fails with `unable to load certificate ... Expecting: TRUSTED CERTIFICATE`; that is expected for that key and is not the fault.

2. Compare with the current time on the nodes:

   ```bash
   date -u
   ```

   If `notBefore` is in the past and `notAfter` is in the future, the certificate is valid and the Unknown status has another cause. If `notAfter` is in the past, the certificate has expired, which is a different problem from a future-dated certificate.

3. Check the operator Pods and their logs for TLS errors:

   ```bash
   kubectl -n tekton-operator get pods
   kubectl -n tekton-operator logs deployment/<tekton-operator-deployment> --tail=200 | grep -iE 'x509|certificate|tls'
   ```
