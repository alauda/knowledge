---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A guest workload cluster is running on a hosted control plane managed by a separate management cluster. One worker has gone bad — flapping kubelet, hardware degradation, or a stuck container runtime — and the operator wants the next NodePool scale-down to *specifically* remove that worker rather than picking an arbitrary replica.

The default behaviour does not honour intent. Cordoning the unhealthy node from the guest cluster and then decreasing the NodePool replica count from the management cluster typically results in the controller deleting a *different*, healthy node, leaving the bad one in place.

## Root Cause

The NodePool controller and the underlying Cluster API (CAPI) reconciler that owns Machines live on the management cluster. They reason over the Machine objects there, not over the Node objects inside the guest cluster. The two state spaces are deliberately decoupled — the management cluster does not gossip the guest's runtime conditions back into Machine status.

So when a NodePool replica count is reduced by N, CAPI picks N Machines to delete using its own ordering heuristics (creation timestamp, machine deployment strategy, random within-set). A `kubectl cordon` on the guest-side Node is invisible to CAPI; the corresponding Machine is just one candidate among equals.

The contract that bridges the two is an *opt-in deletion priority* annotation on the Machine itself. Until the upstream proposal that lets guest-side signals (Node annotations, `Ready` status) flow back into selection lands in the platform, this annotation is the only supported lever.

## Resolution

ACP exposes hosted control planes through the `configure/clusters` capability area; the underlying mechanics are CAPI-based and identical to upstream. Follow the platform-preferred path before resorting to manual annotation:

1. **Use the platform's NodePool surface to evict by name when available.** The hosted-control-plane page on the management cluster lists each Machine alongside its guest-side Node. If the surface offers a *Delete this node* action on the row, use it — the action attaches the deletion-priority annotation, drains the workload, and decrements the NodePool atomically. This avoids the race window in steps 2–4 below.

2. **Drain the guest-side Node from inside the guest cluster.** This protects workloads regardless of which path triggers the eventual removal. Use the guest cluster's kubeconfig:

   ```bash
   kubectl --kubeconfig=<guest> drain <node> \
     --ignore-daemonsets \
     --delete-emptydir-data \
     --grace-period=120 \
     --timeout=10m
   ```

3. **Annotate the corresponding Machine on the management cluster.** This is the deterministic hook into CAPI's selection: a Machine carrying the deletion-priority annotation is picked first when CAPI needs to remove a replica.

   ```bash
   kubectl --kubeconfig=<mgmt> -n <hcp-ns> annotate machine <machine-name> \
     cluster.x-k8s.io/delete-machine=""
   ```

   Find the Machine that maps to the bad Node by looking at the providerID or the node-name reference on the Machine object:

   ```bash
   kubectl --kubeconfig=<mgmt> -n <hcp-ns> get machines \
     -o custom-columns=NAME:.metadata.name,NODE:.status.nodeRef.name,STATUS:.status.phase
   ```

4. **Scale the NodePool down on the management cluster.** With the annotation in place, CAPI now selects the marked Machine first.

   ```bash
   kubectl --kubeconfig=<mgmt> -n <hcp-ns> scale nodepool/<np> --replicas=<N-1>
   ```

5. **Verify the right Machine went away.** The Machine object should disappear, the corresponding Node should leave the guest cluster, and the NodePool `status.replicas` should match the new desired count. If a *different* Node disappeared, the annotation was placed on the wrong Machine — re-attach the annotation to the correct Machine, scale the NodePool back up if needed, and try again.

6. **Watch for the upstream selection-priority improvement.** Future revisions of the controller may consume guest-side signals (a Node annotation such as a "prefer-delete" hint, or the Node's `Ready` condition) directly, removing the need for manual Machine annotation. Until that lands in the platform's hosted control plane, step 3 above is the only reliable mechanism.

## Diagnostic Steps

Confirm that CAPI sees the annotation on the right Machine:

```bash
kubectl --kubeconfig=<mgmt> -n <hcp-ns> get machine <machine-name> \
  -o jsonpath='{.metadata.annotations}{"\n"}'
```

The output must include the deletion-priority annotation key. If it is missing, re-apply step 3.

If a scale-down has already removed the wrong Node, recover by scaling the NodePool back up first — CAPI will provision a new replacement, *not* the original Machine — and then repeat the annotate-and-scale sequence on the genuinely faulty Node.

To audit the selection that CAPI actually made, look at the deletion timestamp on the Machine that disappeared (visible in the management-cluster events for the namespace):

```bash
kubectl --kubeconfig=<mgmt> -n <hcp-ns> get events \
  --field-selector reason=SuccessfulDeleteMachine \
  --sort-by=.lastTimestamp | tail -10
```

If the deleted Machine's name does not match the one that was annotated, either the annotation was not yet observed by the controller cache when scale-down ran (rare race; re-annotate and retry) or the annotation was applied to a Machine in a different NodePool than the one that was scaled.
