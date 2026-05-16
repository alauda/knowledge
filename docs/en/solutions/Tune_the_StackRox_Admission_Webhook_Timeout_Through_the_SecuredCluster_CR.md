---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Tune the StackRox Admission Webhook Timeout Through the SecuredCluster CR
## Issue

A cluster-insights recommendation (or a direct inspection of the cluster's webhook configuration) flags the StackRox `ValidatingWebhookConfiguration` for having a `timeoutSeconds` that exceeds the platform's maximum admission timeout — typically 13 seconds. Hand-editing the `ValidatingWebhookConfiguration` object to lower the timeout appears to work for a few seconds, after which the StackRox operator reconciles the value back to whatever the operator-owned `SecuredCluster` custom resource says it should be.

The webhook is a managed resource; treating it as directly editable leads to a loop where every external edit is reverted on the operator's next reconcile.

## Root Cause

StackRox installs its admission webhook as part of the `SecuredCluster` deployment. The operator owns the `ValidatingWebhookConfiguration` and renders it from fields in the `SecuredCluster` spec — specifically `spec.admissionControl.timeoutSeconds`, plus a handful of other admission-control knobs (`bypass`, `listenOnCreates`, `listenOnEvents`, `replicas`).

The internal `timeoutSeconds` value in `SecuredCluster` does not map 1:1 to the external `ValidatingWebhookConfiguration.timeoutSeconds`. The operator adds a small headroom (on recent releases, the rendered webhook value is the internal value plus two seconds) so that the in-pod evaluation has time to return within the webhook's admission window. A `SecuredCluster` configured with `timeoutSeconds: 10` produces a `ValidatingWebhookConfiguration` with `timeoutSeconds: 12`, which stays inside typical platform admission caps.

A `ValidatingWebhookConfiguration` rendered at `timeoutSeconds: 22` means the internal value is around 20 — the shipped default on older releases. On a platform whose API server caps webhook timeouts (ACP's API server does, as does upstream Kubernetes for admission webhooks), the webhook effectively runs with the cap, and the excess configured timeout is unused — or worse, causes the platform's Insights check to flag it as misconfigured.

## Resolution

Edit the `SecuredCluster` custom resource, not the `ValidatingWebhookConfiguration`. The operator reconciles the webhook on the next pass and the external timeout lands at the value the platform accepts.

### Edit the SecuredCluster

```bash
kubectl -n stackrox edit securedcluster <name>
```

In the editor, locate `spec.admissionControl` and set `timeoutSeconds` to **10** (which produces a 12-second external timeout — safely inside the 13-second platform cap):

```yaml
spec:
  admissionControl:
    bypass: BreakGlassAnnotation
    contactImageScanners: DoNotScanInline
    listenOnCreates: true
    listenOnEvents: true
    listenOnUpdates: true
    replicas: 3
    timeoutSeconds: 10      # change from 20 (or whatever the current value is)
```

Save and exit the editor. The operator's controller reconciles the change within a few seconds.

### Verify the rendered webhook

Wait one reconcile cycle, then read the `ValidatingWebhookConfiguration` the operator owns:

```bash
kubectl get validatingwebhookconfiguration stackrox -o yaml | \
  grep -A1 timeoutSeconds
```

Expected:

```text
    timeoutSeconds: 12
    timeoutSeconds: 12
```

Two lines because the webhook configuration holds two webhook definitions (the admission hook and the admission-controller-readiness hook), both of which pick up the timeout. If either line still reports the old value, the operator has not yet reconciled — wait another 30 seconds and recheck. If the old value sticks, inspect the operator's logs for reconciliation errors:

```bash
kubectl -n stackrox logs deploy/central-services-operator --tail=200 \
  | grep -E 'SecuredCluster|ValidatingWebhookConfiguration|timeoutSeconds'
```

### When to raise rather than lower the timeout

The default is intentionally conservative to stay inside strict platform admission caps. If the cluster genuinely needs a higher timeout — a large-scale deployment where some admission evaluations legitimately take more than 10 seconds — check the platform's API-server configuration for its admission-timeout cap before raising the internal value. On many platforms the cap is a hard ceiling; raising the webhook timeout above it has no effect because the API server aborts the call at the cap anyway. If the platform does allow a higher cap, coordinate with the platform operators to raise it before raising the SecuredCluster's `timeoutSeconds`.

## Diagnostic Steps

Confirm the discrepancy between the desired (SecuredCluster) value and the actual (webhook) value:

```bash
# What the operator renders into the webhook.
kubectl get validatingwebhookconfiguration stackrox \
  -o jsonpath='{range .webhooks[*]}{.name}{"\t"}{.timeoutSeconds}{"\n"}{end}'

# What the operator thinks the desired shape is.
kubectl -n stackrox get securedcluster <name> \
  -o jsonpath='{.spec.admissionControl}{"\n"}' | jq '{timeoutSeconds, replicas, bypass}'
```

The webhook `timeoutSeconds` should equal the `SecuredCluster.spec.admissionControl.timeoutSeconds` plus the operator's fixed headroom. A large discrepancy (webhook reports 20, SecuredCluster says 10) indicates either the operator has not reconciled the last change or a second entity is also writing to the webhook — rule out the second entity by looking at `metadata.managedFields`:

```bash
kubectl get validatingwebhookconfiguration stackrox \
  -o jsonpath='{range .metadata.managedFields[*]}{.manager}{"\t"}{.operation}{"\n"}{end}'
```

Entries whose `manager` is anything other than the StackRox operator/controller suggest the webhook is being externally mutated — find and stop that actor, because it will keep fighting the operator's reconcile.

After the change reconciles, confirm the recommendation has cleared (re-run the insights scan or equivalent cluster-health check). The `ValidatingWebhookConfiguration`'s `timeoutSeconds` should now read 12 on every entry, and the Insights recommendation about admission-timeout misconfiguration disappears on the next evaluation cycle.
