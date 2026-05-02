---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# GarbageCollectorSyncFailed Alert From kube-controller-manager
## Issue

The `GarbageCollectorSyncFailed` alert keeps firing on a cluster that is otherwise healthy. The control-plane components are `Running`, the API server responds, and most workloads are unaffected — but orphaned objects accumulate, finalizers do not run, and `kube-controller-manager` logs repeat the same `garbagecollector` synchronisation errors at a fixed interval.

The alert is surfaced by the platform's monitoring stack and indicates that the garbage-collector controller cannot complete its periodic resync of the dependency graph it uses to delete dependent objects when an owner is removed.

## Root Cause

The garbage collector inside `kube-controller-manager` discovers every API resource on the cluster and builds an informer per resource. If discovery fails for any registered resource, the controller cannot complete its sync and re-tries with backoff. The failure is almost always one of:

- **A broken CRD conversion webhook.** The CustomResourceDefinition declares `conversion.strategy: Webhook`, but the webhook service is unreachable, returning errors, or has an expired serving certificate. API discovery for that resource fails, the controller cannot reach the schema, and the whole resync attempt is abandoned.
- **API discovery flapping.** The aggregation layer cannot list one of its registered APIService backends, usually because an extension API server pod is `CrashLoopBackOff` or its service has no endpoints.
- **A genuine network partition** between the control plane and an aggregated API or webhook endpoint.

Typical log signature in the `kube-controller-manager` pod:

```text
shared_informer.go:258] unable to sync caches for garbage collector
garbagecollector.go:245] timed out waiting for dependency graph builder sync during GC sync (attempt 26)
garbagecollector.go:215] syncing garbage collector with updated resources from discovery
  (attempt 27): added: [example.com/v1, Resource=myresource], removed: []
```

The `added: [<group>/<version>, Resource=<name>]` line names the resource the discovery cycle just learned about — most of the time, the same resource is the one whose webhook or API server has gone away.

## Resolution

1. **Identify the failing resource.** Watch the controller logs for the `added`/`removed` lines that name the resource the controller is currently waiting on:

   ```bash
   kubectl -n kube-system logs deploy/kube-controller-manager --tail=200 | \
     grep -E "garbagecollector|graph_builder|sync caches"
   ```

   On clusters where `kube-controller-manager` runs as a static pod, list the static pod label and tail logs from each replica directly:

   ```bash
   kubectl -n kube-system get pods -l component=kube-controller-manager
   ```

2. **Raise log verbosity if the resource is not obvious.** A short window at higher verbosity exposes the controller's per-resource sync loop, including the resource that times out:

   ```bash
   kubectl patch kubecontrollermanager.operator/cluster --type=json \
     -p '[{"op":"replace","path":"/spec/logLevel","value":"Debug"}]'
   ```

   The platform rolls the controller-manager pods. Look for `graph_builder.go` lines naming an unsynced resource:

   ```text
   graph_builder.go:279] garbage controller monitor not yet synced:
     example.com/v1, Resource=myresource
   ```

   Revert the verbosity once the resource is known — debug-level logs are noisy and add CPU pressure on the apiserver:

   ```bash
   kubectl patch kubecontrollermanager.operator/cluster --type=json \
     -p '[{"op":"replace","path":"/spec/logLevel","value":"Normal"}]'
   ```

3. **Inspect the resource's discovery path.** For a CRD-backed resource, dump the CRD and check the conversion configuration and the served versions:

   ```bash
   kubectl get crd <name>.<group> -o yaml > /tmp/<name>.yaml
   kubectl get crd <name>.<group> -o jsonpath='{.spec.conversion}{"\n"}'
   kubectl get crd <name>.<group> -o jsonpath='{.spec.versions[*].served}{"\n"}'
   ```

   For an aggregated APIService, confirm it is `Available`:

   ```bash
   kubectl get apiservice | grep -v "True"
   ```

4. **Fix the failing component.**
   - **Webhook unreachable**: confirm the webhook Service has endpoints and the backing pod is healthy. If the webhook serving certificate is expired or signed by a CA the apiserver does not trust, rotate it and update `spec.conversion.webhook.clientConfig.caBundle` on the CRD.
   - **Webhook misbehaving**: temporarily switch the CRD to `spec.conversion.strategy: None` while the webhook is repaired (only safe if a single served version exists; otherwise data loss is possible).
   - **CRD genuinely abandoned**: back it up and delete it so discovery stops asking for it.

   Back up before deletion:

   ```bash
   kubectl get crd <name>.<group> -o yaml > /tmp/<name>.yaml
   kubectl delete crd <name>.<group>
   ```

5. **Watch the alert clear.** Once discovery for the resource succeeds (or the resource is gone), the controller's next sync cycle finishes and the alert resets within a few minutes. Re-check `kubectl -n kube-system logs deploy/kube-controller-manager` for clean `Successfully synced GC controller` messages.

## Diagnostic Steps

If the alert is firing but no resource name appears in the logs, walk the discovery surface from the API server's perspective:

```bash
kubectl get --raw /apis | jq '.groups[] | select(.preferredVersion.groupVersion) | .preferredVersion.groupVersion' | sort -u
kubectl api-resources --verbs=list --namespaced -o name 2>&1 | grep -E "error|warning"
```

A resource that errors during `kubectl api-resources` is almost certainly the same one stalling the garbage collector.

For webhook-backed CRDs, probe the webhook directly to rule out network issues:

```bash
WH_SVC=$(kubectl get crd <name>.<group> -o jsonpath='{.spec.conversion.webhook.clientConfig.service.name}')
WH_NS=$(kubectl get crd <name>.<group> -o jsonpath='{.spec.conversion.webhook.clientConfig.service.namespace}')
kubectl -n "$WH_NS" get svc "$WH_SVC"
kubectl -n "$WH_NS" get endpoints "$WH_SVC"
kubectl -n "$WH_NS" get pods -l <webhook-selector>
```

Empty endpoints, a `CrashLoopBackOff` backing pod, or a missing service are the usual culprits. Re-running the API discovery via `kubectl api-resources` after the webhook recovers should return without errors, and the garbage collector resync that follows clears the alert.
