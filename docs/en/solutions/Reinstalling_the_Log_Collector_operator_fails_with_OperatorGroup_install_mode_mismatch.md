---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Reinstalling the platform's Log Collector operator (an OLM-packaged operator that follows the upstream cluster-logging install model — single deployment in a fixed namespace) fails from the operator catalog UI with:

```text
The OperatorGroup in the <logging-ns> Namespace does not support the global
installation mode. Select a different installation Namespace that supports this mode.
```

Symptoms appear when the previous installation was uninstalled by removing the Subscription and ClusterServiceVersion but **not** the OperatorGroup. The lingering OperatorGroup still pins a `targetNamespaces` list, while the catalog entry being installed declares only `AllNamespaces` (global) install mode. OLM rejects the new Subscription before it can write a CSV.

## Root Cause

OLM's install-mode contract requires the Subscription's CSV to declare an install mode that matches the OperatorGroup in the chosen namespace:

- `OwnNamespace` — OperatorGroup with `spec.targetNamespaces: [<install-ns>]`.
- `SingleNamespace` — OperatorGroup with one entry in `spec.targetNamespaces`.
- `MultiNamespace` — OperatorGroup with several entries.
- `AllNamespaces` (global) — OperatorGroup with `spec.targetNamespaces` empty / unset (the OperatorGroup must be `global` shape).

The Log Collector operator publishes only `AllNamespaces`. The leftover OperatorGroup from the previous install carries a `targetNamespaces` list that survived uninstall, so the OperatorGroup is no longer global-shaped, so the new install fails before it can write its CSV.

## Resolution

Delete the stale OperatorGroup in the operator's namespace, then run the install again — the catalog UI (or OLM itself, when reconciling a fresh Subscription) creates a fresh global-shape OperatorGroup automatically.

1. Identify the OperatorGroup in the logging namespace:

   ```bash
   LOG_NS=<logging-namespace>
   kubectl -n "$LOG_NS" get operatorgroup
   ```

   Expect one entry, name typically generated (e.g. `cluster-logging-<hash>`).

2. Inspect it to confirm it is the stale one — `spec.targetNamespaces` is the deciding field:

   ```bash
   kubectl -n "$LOG_NS" get operatorgroup -o yaml | yq '.items[].spec'
   ```

   A `targetNamespaces` list of one (the install namespace) is the leftover; an empty / absent `targetNamespaces` is already global and is not the cause of this error.

3. Delete the stale OperatorGroup:

   ```bash
   kubectl -n "$LOG_NS" delete operatorgroup <name>
   ```

4. Retry the install via the catalog UI, or apply a fresh Subscription. If you create the Subscription declaratively, also create a global OperatorGroup explicitly so OLM does not race the UI:

   ```yaml
   apiVersion: operators.coreos.com/v1
   kind: OperatorGroup
   metadata:
     name: cluster-logging
     namespace: <logging-namespace>
   spec: {}
   ```

   An empty `spec` is the global-mode signal.

5. Confirm the install:

   ```bash
   kubectl -n "$LOG_NS" get subscription,csv,operatorgroup
   ```

   `csv` Phase should reach `Succeeded`; the OperatorGroup should have no `targetNamespaces` field set.

## Diagnostic Steps

1. The error in the UI is mirrored in OLM events on the namespace — the canonical breadcrumb is on the Subscription:

   ```bash
   kubectl -n "$LOG_NS" describe subscription <name> | sed -n '/Events:/,$p'
   ```

2. The catalog operator logs the same rejection. From the OLM namespace:

   ```bash
   kubectl -n <olm-namespace> logs deploy/catalog-operator --tail=200 \
     | grep -E "InstallMode|OperatorGroup"
   ```

3. To see what install modes the catalog entry actually declares — useful when picking the right OperatorGroup shape:

   ```bash
   kubectl get packagemanifest <package-name> -o jsonpath='{.status.channels[*].currentCSVDesc.installModes}' | jq
   ```

   The `supported: true` entries are the legal OperatorGroup shapes; pick the one your namespace has, or rebuild the OperatorGroup to match `AllNamespaces`.
