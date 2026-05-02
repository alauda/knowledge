---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Whereabouts reconciler DaemonSet missing after manual NetworkAttachmentDefinition install
## Issue

After bringing up secondary networks with the Multus-based stack, no `whereabouts-reconciler` DaemonSet is present. New pods that request a `NetworkAttachmentDefinition` (NAD) using the Whereabouts IPAM plugin get an IP assignment, but stale `IPPool` allocations from deleted pods are never reclaimed and the pool eventually exhausts. This often surfaces after a cluster upgrade where existing NADs created from raw YAML continued to work but the reconciler that backs the IPAM plugin was never deployed.

## Root Cause

Whereabouts is the IPAM plugin commonly used with Multus secondary networks; it stores allocations in `IPPool` objects. To free allocations belonging to pods that no longer exist (crashed without cleanup, force-deleted nodes, eviction edge cases), Whereabouts ships a reconciler that runs as a `DaemonSet` and periodically reconciles `IPPool` against the live pods.

The cluster's network operator only deploys this reconciler when it can detect a Whereabouts-backed secondary network through its own custom resource — typically a high-level `NetworkAttachmentDefinition` API exposed by the operator. If the secondary network is created **directly** by applying a raw `NetworkAttachmentDefinition` YAML, the operator does not see it as part of its managed inventory and therefore does not roll out the reconciler. The Whereabouts CNI binary on the node still works for assignment, but no garbage collection runs.

## Resolution

There are two supported paths.

### Option 1 — Let the operator manage the secondary network

Migrate the secondary-network definition from a hand-crafted `NetworkAttachmentDefinition` to the operator's higher-level CR for additional networks. The operator will then render both the NAD **and** the Whereabouts reconciler DaemonSet automatically. Verify by listing the DaemonSet after the change:

```bash
kubectl get daemonset -A | grep -i whereabouts
```

### Option 2 — Manually deploy the reconciler

If the secondary network must remain a hand-applied NAD, install the Whereabouts reconciler manifest from the upstream project so that garbage collection runs. The reconciler manifest (DaemonSet, RBAC, and a CronJob trigger) is published in the Whereabouts repository under `doc/crds/`. Apply it into the namespace where the Multus addon is installed and verify the pods come up:

```bash
kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/whereabouts/master/doc/crds/daemonset-install.yaml
kubectl get pods -A -l app=whereabouts -o wide
```

Tune the reconciler frequency through its `--reconciler-period` argument or via the `IPPool` `controlplane.kubevirt.io/reconciler-cron-expression` annotation that maps to the in-cluster cron trigger.

### Verifying garbage collection

After the reconciler is running, force a stale allocation to be reclaimed by deleting an `IPPool` entry for a pod that no longer exists, or wait one reconcile cycle and watch the pool size shrink:

```bash
kubectl get ippool -A
kubectl get ippool/<pool> -o jsonpath='{.spec.allocations}{"\n"}' | jq 'keys | length'
```

## Diagnostic Steps

1. Confirm the reconciler DaemonSet is missing:

   ```bash
   kubectl get daemonset -A | grep -i whereabouts
   ```

2. List the secondary networks present on the cluster — operator-managed and raw NADs:

   ```bash
   kubectl get network-attachment-definitions -A
   ```

3. Inspect a Whereabouts-backed `IPPool` and check whether any allocation references a non-existent pod:

   ```bash
   kubectl get ippool -A
   kubectl get ippool/<name> -o yaml
   ```

   Cross-reference the listed pod UIDs with `kubectl get pod -A -o jsonpath='{.items[*].metadata.uid}'` to spot orphans.

4. After deploying the reconciler, watch for log lines confirming periodic reconciliation:

   ```bash
   kubectl logs -n <whereabouts-ns> daemonset/whereabouts-reconciler --tail=100
   ```
