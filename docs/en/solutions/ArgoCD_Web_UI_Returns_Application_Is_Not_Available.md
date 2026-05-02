---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# ArgoCD Web UI Returns Application Is Not Available
## Issue

The ArgoCD web console refuses to load with an `Application is not available` error before the login screen renders, blocking every user from signing in. The ingress / load-balancer in front of ArgoCD returns a 503 (or the platform's standard "no upstream" page), even though the ArgoCD server pod itself appears to be healthy in `kubectl get pod`.

The pattern is consistent: server pods are `Running` and `Ready`, the Service exists, but the Service has no Endpoints, so traffic routed to it has nowhere to go.

## Root Cause

In Kubernetes, the chain from ingress to a backend pod has three independent links: a `Service` (the stable virtual address and selector), an `Endpoints` / `EndpointSlice` object (the realized list of matching pod IPs), and the pod itself (selected by the Service's label selector). The endpoints controller in the kube-controller-manager keeps the Endpoints object in sync with the set of `Ready` pods that match the Service's selector.

When the Endpoints object becomes empty or stale despite a healthy backing pod, the chain breaks at the middle link. The two ways this happens in practice:

1. **The Endpoints object was deleted** (manually, or as collateral damage from a migration / restore operation) and the controller's reconciliation has not yet repopulated it. The controller is supposed to recreate it within seconds, but if the controller cannot — because the corresponding Service spec or selector is in a state it cannot reconcile from, or because of an in-flight resource conflict — the empty state can persist indefinitely.
2. **The Service's selector no longer matches the pod's labels** because either the Service was patched with the wrong selector or the pod template was changed without the Service following. The endpoints controller dutifully reports zero matching pods.

Either way, the operator sees `kubectl get pod -l <app>` returning the running pod, `kubectl get svc <argocd-server>` showing the Service, and `kubectl get endpoints <argocd-server>` showing an empty `ENDPOINTS` field. The ingress in front sees an empty backend and serves the "not available" page.

The fastest reliable recovery is to delete the Service. The GitOps operator that owns the ArgoCD installation reconciles the Service from its declarative state on the next pass, recreates a Service with the correct selector, and the endpoints controller immediately populates the Endpoints object from the still-running pod. No data is lost: ArgoCD's state lives in its repo-server, application controller, and Redis, none of which are touched.

## Resolution

### Preferred: ACP GitOps (`gitops`) — let the operator reconcile the Service back

The ACP GitOps area is built on Argo CD; the Service in front of the `argocd-server` deployment is created and owned by the operator that manages the ArgoCD instance. Deleting the Service triggers the operator to recreate it with the correct selector, and the endpoints controller follows automatically.

1. **Confirm the Endpoints object is empty even though the pod is healthy.**

   ```bash
   NS=<argocd-namespace>          # the namespace where the ArgoCD instance lives
   SERVER=<argocd-server-svc>     # typically <argocd-instance-name>-server

   kubectl -n "$NS" get pod -l app.kubernetes.io/name=argocd-server -o wide
   kubectl -n "$NS" get svc "$SERVER"
   kubectl -n "$NS" get endpoints "$SERVER"
   ```

   The pod should be `Running 1/1`. The Service should exist. The `ENDPOINTS` column from the third command should show pod IPs; an empty `<none>` confirms the broken chain.

2. **Delete the broken Service.** The operator's reconcile loop will recreate it within a few seconds:

   ```bash
   kubectl -n "$NS" delete svc "$SERVER"
   ```

   For default-instance installations, `<argocd-server-svc>` is conventionally `argocd-server` (or the instance-prefixed equivalent). For a custom ArgoCD instance, substitute the actual Service name from step 1.

3. **Verify the Service and Endpoints come back populated.**

   ```bash
   kubectl -n "$NS" get svc "$SERVER" -w
   # Ctrl-C once the Service reappears, then:
   kubectl -n "$NS" get endpoints "$SERVER"
   ```

   `ENDPOINTS` should now list one or more pod IPs (one per `argocd-server` replica). The web UI returns to the login page.

4. **Confirm the front-door route / ingress still points at the right Service.** If the ingress was configured before the recreation, it is generally unchanged — the Service's name and namespace are preserved. If the operator's reconcile recreated the Service with a different name, update the ingress accordingly.

### OSS fallback: self-managed Argo CD (helm chart or upstream manifests)

The behavior is identical when Argo CD is installed directly from the upstream chart or manifests rather than through the ACP GitOps operator. The Service is owned by the chart / manifest, so deleting it triggers the next reconcile of whatever deploys the chart (Argo CD self-managing, Helmfile, or `kubectl apply -k`) to recreate it. If no controller owns the Service object — for example, a one-shot manifest applied with `kubectl apply` and never re-applied — the operator must re-apply the Service definition manually:

```bash
kubectl apply -f argocd-server-service.yaml
```

Either way, the empty-Endpoints state resolves once the Service is in place and its selector once again matches the running pods.

## Diagnostic Steps

Before deleting anything, walk the chain top-to-bottom to be sure the Endpoints gap is the actual cause and not a symptom of something larger.

1. **Verify the pod's labels match the Service's selector.** A common drift is that someone edited one but not the other.

   ```bash
   NS=<argocd-namespace>
   SERVER=<argocd-server-svc>

   echo "Service selector:"
   kubectl -n "$NS" get svc "$SERVER" -o jsonpath='{.spec.selector}{"\n"}'

   echo "Pod labels:"
   kubectl -n "$NS" get pod -l app.kubernetes.io/name=argocd-server \
     -o jsonpath='{range .items[*]}{.metadata.name}: {.metadata.labels}{"\n"}{end}'
   ```

   If the selector looks like `{"app.kubernetes.io/name":"argocd-server","app.kubernetes.io/instance":"<other>"}` and no pod carries that `instance` label, the operator has been reconfigured against a different ArgoCD instance and the broken Service was orphaned. Delete it and let the active operator recreate the right one.

2. **Confirm the pod is `Ready`, not just `Running`.** Endpoints controller only adds pods whose readiness probes pass.

   ```bash
   kubectl -n "$NS" get pod -l app.kubernetes.io/name=argocd-server \
     -o jsonpath='{range .items[*]}{.metadata.name}  ready={.status.containerStatuses[0].ready}{"\n"}{end}'
   ```

   `ready=false` means the readiness probe is failing — fix that first; the empty Endpoints is then a symptom, not the disease.

3. **Look at the GitOps operator's recent log lines for reconciliation errors** if the Service does not come back after deletion.

   ```bash
   OPNS=<gitops-operator-namespace>
   kubectl -n "$OPNS" logs deploy/gitops-operator --tail=200 \
     | grep -iE 'argocd|reconcile|error'
   ```

   A reconcile that fails to recreate the Service usually points to a malformed `ArgoCD` CR field or an admission webhook rejecting the recreation; the log message identifies which.

4. **If the underlying cause was a manual delete on the Endpoints object alone** (without removing the Service), the kube-controller-manager normally recreates Endpoints within a single reconcile cycle. A persistently empty Endpoints with a healthy Service and a matching pod points to controller-manager unhappiness; check `kubectl get componentstatus` and the controller-manager logs for that.
