---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A container-security workload scanner (for example, the StackRox-based Container Security service or any tool that derives image inventory from the desired state of a `Deployment`) reports `No Images` for a particular workload. The same scanner correctly enumerates images for other deployments in the same cluster. Inspecting the Deployment in question shows a fresh revision was rolled out recently, but no pods from that revision are running.

## Root Cause

A scanner that derives image inventory from the **latest desired** revision of a `Deployment` cannot map images for a revision whose `ReplicaSet` has produced zero pods. In Kubernetes, pod admission is rejected when the `Deployment` references a `ServiceAccount` that does not exist in the namespace. The new `ReplicaSet` therefore stays at zero ready pods, the Deployment eventually reports `ProgressDeadlineExceeded`, and the scanner has no live image references to attach to that revision — so the workload appears empty in inventory.

## Resolution

Restore the rollout by ensuring the referenced `ServiceAccount` exists; the scanner will refresh inventory automatically once pods from the new `ReplicaSet` reach `Ready`.

1. Inspect the Deployment to find the `ServiceAccount` it expects:

   ```bash
   kubectl get deployment <name> -n <ns> -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
   ```

2. If the name is non-empty and missing, create it:

   ```bash
   kubectl create serviceaccount <name> -n <ns>
   ```

   If the workload was supposed to use the namespace `default` ServiceAccount, remove the `serviceAccountName` field from the pod spec instead of creating a misnamed account.

3. Trigger a fresh rollout so the existing `ReplicaSet` is retried with the new admission outcome:

   ```bash
   kubectl rollout restart deployment/<name> -n <ns>
   ```

4. Confirm the new pods reach `Running` and that the `ReplicaSet` `availableReplicas` matches the desired count:

   ```bash
   kubectl rollout status deployment/<name> -n <ns>
   kubectl get replicaset -n <ns> -l app=<label> -o wide
   ```

After pods are healthy the scanner re-evaluates the deployment on its next reconciliation cycle and the missing image inventory disappears.

## Diagnostic Steps

1. List recent `Warning` events in the namespace; the admission rejection is reported by the ReplicaSet controller:

   ```bash
   kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -n 20
   ```

   A typical event reads `Error creating: pods "..." is forbidden: error looking up service account <ns>/<name>: ServiceAccount "<name>" not found.`

2. Read the Deployment status conditions to confirm the rollout has stalled rather than the workload simply being scaled to zero:

   ```bash
   kubectl get deployment <name> -n <ns> -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
   ```

   `Available=False` together with `Progressing=False` and reason `ProgressDeadlineExceeded` confirms the new revision never produced live pods.

3. List `ReplicaSets` for the deployment and confirm the latest one has `currentReplicas: 0`:

   ```bash
   kubectl get replicaset -n <ns> -l app=<label> -o wide
   ```
