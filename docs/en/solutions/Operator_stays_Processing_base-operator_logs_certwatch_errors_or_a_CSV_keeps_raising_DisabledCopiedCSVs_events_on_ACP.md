---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Operator stays Processing, base-operator logs certwatch errors, or a CSV keeps raising DisabledCopiedCSVs events on ACP

## Issue

One of the following is seen on a cluster whose operators otherwise run normally:

- The cluster functional-component page shows `redis-operator` as Processing, and it stays there. The operator Pod is not crash-looping. A managed instance under that operator is paused, and the ModuleInfo (`minfo`) of the component reports Processing.
- `base-operator` logs keep printing certificate reread errors such as `error re-reading certificate` with `tls: private key does not match public key`, and reconciliation reports `ProductBase Reconcile error: ProductBase need retry`. `base-operator` is otherwise healthy.
- A ClusterServiceVersion (CSV) keeps raising the same warning event, for example `DisabledCopiedCSVs: CSV copying disabled for operators/katanomi-operator.v3.20.36` hundreds of times over a few weeks, and the question is whether it is a fault.

`redis-operator` that stays Processing during a platform upgrade because its Subscription waits for manual approval is a different cause; see "ACP upgrade stuck on an operator, OLM catalog, or operator-managed component".

## Root Cause

### Cause 1: redis-operator stays Processing because a managed instance is paused

When an instance managed by an operator is paused, the platform's operator component logic reports the cluster functional component as Processing on its `minfo`. This is the expected display for a paused instance, not an operator failure. While the instance stays paused, the component stays Processing; when the instance is resumed, `minfo` and the functional-component page follow.

### Cause 2: error re-reading certificate, tls: private key does not match public key

`base-operator` watches its certificate files with certwatch, which relies on file system notifications. During certificate rotation `tls.crt` is updated first and `tls.key` after it. A reread that runs in this gap sees a certificate and key that do not belong together, or a file that is not fully written yet, and logs one of:

```text
error re-reading certificate ... tls: private key does not match public key
error re-reading certificate ... tls: failed to find any PEM data in key input
error re-reading certificate ... tls: failed to find any PEM data in certificate input
```

When `tls.key` has finished updating, the pair matches again. `base-operator` and `prdb` stay healthy through these lines, the errors do not affect use of the product, and a `ProductBase need retry` from the same gap clears with the file update.

### Cause 3: repeated DisabledCopiedCSVs warning events on katanomi or Knative operator CSVs

The event list of the `operators` namespace shows, for example:

```text
DisabledCopiedCSVs: CSV copying disabled for operators/knative-operator.v3.20.10
DisabledCopiedCSVs: CSV copying disabled for operators/katanomi-operator.v3.20.36
```

with counts in the hundreds over about two weeks. OLM has CSV copying turned off (`spec.features.disableCopiedCSVs: true` on the `OLMConfig` named `cluster`), and the event reports that state for each cluster-wide operator CSV. It is informational and not an error; the operators work normally and the event count simply grows.

## Resolution

### Cause 1: redis-operator stays Processing because a managed instance is paused

1. List ModuleInfo and the instances the operator manages, and match a Processing `minfo` to a paused instance:

   ```bash
   kubectl get moduleinfo -A
   kubectl get pods -A | grep redis-operator
   kubectl api-resources | grep -i redis
   kubectl get <redis-instance-kind> -A
   ```

2. If the instance is meant to stay paused, no action is needed; Processing stays with it.
3. If the instance should run again, resume it through the same control that paused it (for example in the instance's page in the console). After the instance is no longer paused, `minfo` leaves Processing and the functional-component page follows.

If every managed instance is running and `minfo` is still Processing, this cause does not apply; check the CSV phase (`kubectl get csv -A | grep -i redis`) and the operator Pod status.

### Cause 2: error re-reading certificate, tls: private key does not match public key

1. Confirm the log lines and that the components are otherwise Ready:

   ```bash
   kubectl get deploy,pods -A | grep -E 'base-operator|prdb'
   kubectl logs -n <namespace> deploy/base-operator --tail=200
   ```

2. If the lines match this cause and `base-operator` and `prdb` are healthy, leave them alone. They stop after `tls.key` is written; no recovery operation is required.

A certificate error that continues after rotation has finished, or a `base-operator` Pod that is not Ready, is not this gap. Collect the steady-state log before changing any certificate files.

### Cause 3: repeated DisabledCopiedCSVs warning events on katanomi or Knative operator CSVs

1. Read the events and the OLM setting that produces them:

   ```bash
   kubectl -n operators get events --field-selector reason=DisabledCopiedCSVs
   kubectl get events -A --field-selector involvedObject.kind=ClusterServiceVersion | grep -iE 'katanomi|knative'
   kubectl get olmconfig cluster -o jsonpath='{.spec.features.disableCopiedCSVs}{"\n"}'
   ```

2. An event that says CSV copying is disabled for that CSV, with `disableCopiedCSVs` set to `true`, is expected. No action is required.

For what the setting controls and how to change it, see "Controlling Copied CSVs on ACP with the OLMConfig disableCopiedCSVs feature".

## Diagnostic Steps

```bash
kubectl get moduleinfo -A
kubectl get csv -A | grep -iE 'redis|katanomi|knative'
kubectl get pods -A | grep -E 'redis-operator|base-operator|prdb'
kubectl get olmconfig cluster -o jsonpath='{.spec.features.disableCopiedCSVs}{"\n"}'
```

- Processing `minfo`, a paused managed instance, and the operator Pod `Running`: Cause 1.
- `error re-reading certificate` naming a key/certificate mismatch or missing PEM data, while `base-operator` and `prdb` are healthy and the lines stop after rotation: Cause 2.
- A recurring `DisabledCopiedCSVs` warning on katanomi or Knative operator CSVs with `disableCopiedCSVs` printed as `true`: Cause 3.
