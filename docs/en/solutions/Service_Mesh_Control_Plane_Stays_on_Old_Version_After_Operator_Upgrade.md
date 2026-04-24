---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The Service Mesh operator is upgraded to a newer minor (for example, the operator CSV moves from 2.6.1 to 2.6.4), but the cluster's Service Mesh Control Plane (SMCP) keeps reporting an older version on its `Ready` condition:

```text
$ kubectl get csv -n istio-system | grep servicemesh
NAME                          DISPLAY                       VERSION   REPLACES                      PHASE
servicemeshoperator.v2.6.4    ACP Service Mesh              2.6.4-0   servicemeshoperator.v2.6.1    Succeeded

$ kubectl get smcp -n istio-system
NAME    READY   STATUS            PROFILES    VERSION   AGE
basic   9/9     ComponentsReady   ["default"] 2.4.13    127d
```

New mesh features (the ones the upgrade was performed for) do not appear; existing workloads continue to work, but with the previously injected sidecar configuration. Operators reasonably assume the operator upgrade should have rolled the data plane forward — it did not.

The platform-preferred path on ACP is the `service_mesh` (Istio v1/v2) capability, which manages the SMCP CRD as the contract between the operator and the mesh. The behaviour described here is intrinsic to the SMCP shape and applies regardless of which operator channel ran the upgrade.

## Root Cause

The SMCP-based control plane does **not** automatically advance its `spec.version` when the operator that reconciles it is upgraded. Two design points explain this:

- The Istio upstream project recommends a canary upgrade (run the new control-plane revision alongside the old, migrate workloads, retire the old). The SMCP controller historically supports only an in-place upgrade and so makes the version bump an explicit operator decision rather than a side-effect of installing a new operator binary.
- The supported upgrade path is sequential through minor versions; jumping multiple minors in a single edit is not supported. Forcing the operator to roll the SMCP forward on every operator install would conflate "I want the latest binary" with "I want to enter an upgrade".

The result is that the operator binary moves forward, the SMCP `spec.version` stays where it was, and the running pods continue to render the old version's manifests. The workload sidecars injected before the bump also carry the old configuration — re-injection only happens when the pod is recreated.

## Resolution

Take the upgrade in two explicit steps: edit the SMCP, then recycle the workloads. Walk one minor at a time.

1. **Confirm the operator and the running SMCP versions before changing anything.** The pair of values frames the gap.

   ```bash
   kubectl get csv -n istio-system | grep servicemesh
   kubectl get smcp -n istio-system
   ```

2. **Edit the SMCP and bump `spec.version` by exactly one minor.** Skipping minors is unsupported.

   ```bash
   kubectl edit smcp basic -n istio-system
   ```

   ```yaml
   spec:
     # ...
     version: "2.5"   # was "2.4"; bump one minor at a time
   ```

3. **Watch the rollout.** The SMCP enters `PausingUpdate` while the operator drains and recreates the control-plane components, then returns to `ComponentsReady` once Istiod, the ingress gateway and any addons have re-rolled.

   ```bash
   kubectl get smcp basic -n istio-system -w
   kubectl get pods -n istio-system
   ```

4. **Restart the workloads in every namespace that is part of the mesh.** This is the step that is most often skipped, and it is the one that makes the new version visible to the data plane. The control-plane upgrade re-registers the CRDs and the new injection template, but **already-running** application pods still carry the previous sidecar. A rollout restart on each affected `Deployment`/`StatefulSet` triggers fresh sidecar injection.

   ```bash
   for NS in $(kubectl get namespaces \
       -l istio-injection=enabled -o jsonpath='{.items[*].metadata.name}'); do
     kubectl -n "$NS" rollout restart deployment
     kubectl -n "$NS" rollout restart statefulset
   done
   ```

5. **Verify the sidecars are now on the new revision.** The `istio.io/rev` (or equivalent) label on each pod and the running Istio proxy version should match the SMCP's new `spec.version`.

   ```bash
   kubectl -n <app-ns> get pod -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.istio\.io/rev}{"\n"}{end}'
   kubectl -n <app-ns> exec <pod> -c istio-proxy -- pilot-agent request GET server_info | grep version
   ```

6. **Repeat the bump-edit-restart loop for each subsequent minor** until the SMCP matches the operator. Skipping minors will leave the SMCP refusing to reconcile against an operator that no longer ships the older version's templates.

## Diagnostic Steps

Confirm whether the gap is a missed SMCP edit (this article's case) or a stuck reconcile (a different problem).

```bash
kubectl describe smcp basic -n istio-system | sed -n '/Status:/,/Events:/p'
kubectl logs -n istio-system -l name=istio-operator --tail=200
```

A `Status` block that lists the new operator version under `OperatorVersion` while the spec still names the old version is the textbook signature for the missed-edit case. Reconcile errors (mis-typed `version`, unsupported jump) appear in the operator's log as `unsupported version` or `cannot upgrade from X to Y, intermediate Z required`.

After the SMCP is on the new version, scan for stale sidecars that did not get a restart:

```bash
kubectl get pods --all-namespaces \
  -l istio.io/rev \
  -o custom-columns='NS:.metadata.namespace,POD:.metadata.name,REV:.metadata.labels.istio\.io/rev'
```

Pods whose `REV` does not match the new SMCP version need a `kubectl rollout restart` on their owning controller. The control plane will not retro-fit them — sidecars only update when the pod is recreated.
