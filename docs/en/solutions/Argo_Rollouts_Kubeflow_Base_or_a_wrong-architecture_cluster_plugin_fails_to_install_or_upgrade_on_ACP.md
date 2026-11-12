---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Argo Rollouts, Kubeflow Base, or a wrong-architecture cluster plugin fails to install or upgrade on ACP

## Issue

A specific cluster plugin fails to install, upgrade, or uninstall:

- An x86 plugin was installed on an ARM cluster, its init container reports an architecture mismatch, and its deletion is stuck.
- Argo Rollouts fails to deploy on ACP 4.2.2 because the init container `copy-gwapi-plugin` cannot pull `rollouts-plugin-trafficrouter-gatewayapi:v1`.
- Kubeflow Base ends in Install Failed (`安装失败`) with `namespaces "kubeflow" not found` or `illegal base64 data`, or its web UI answers `RBAC denied`.
- A Kubeflow Base upgrade fails on a cluster whose Istio uses revision-based injection, and the `kubeflow-istio-ingressgateway` Pod was never injected.

Related articles: "Cluster plugin install or upgrade stuck in chart sync: sentry, StatefulSet Forbidden, hook Job, or missing ModuleConfig" covers failures that are not specific to one plugin.

## Root Cause

### Cause 1: An x86 plugin was installed on an ARM cluster, and its cleanup BroadcastJob fails too

On an ARM cluster (for example ACP 4.3.1 ARM), the multus plugin init container reports an architecture mismatch, and after the plugin is deleted from the console it stays deleting because the cleanup BroadcastJob fails on the same mismatch. An x86 build of the plugin was deployed; its cleanup job uses the same wrong-architecture image, so the uninstall cannot finish. The known recovery is to redeploy the cluster and then deploy the plugin build for the cluster's architecture.

### Cause 2: Argo Rollouts on 4.2.2 references the wrong init container image tag

The Pod `argo-rollouts-<hash>` in namespace `argo-rollouts` repeats a `Warning` event for its init container `copy-gwapi-plugin`:

```text
Failed to pull image "<registry>/acp/argoproj-labs/rollouts-plugin-trafficrouter-gatewayapi:v1": failed to pull and unpack image ... failed to resolve reference ... Head "https://<registry>/v2/acp/argoproj-labs/rollouts-plugin-trafficrouter-gatewayapi/manifests/v1": tls: failed to verify certificate: x509: certificate signed by unknown authority
```

This is a known issue in ACP 4.2.2: the init container of the argo-rollouts chart references the incorrect tag `v1`. The pull of that tag can surface as the `x509` error above; the cause is the tag. The workaround overrides the init container through `valuesOverride` on the argo-rollouts ModuleInfo of the affected cluster, pointing it to `rollouts-plugin-trafficrouter-gatewayapi:v0.6.0-6` in the cluster's registry.

### Cause 3: Kubeflow Base install prerequisites are not met

The Kubeflow Base cluster plugin (for example `v1.10.10`) ends in Install Failed with one of:

```text
failed to create NetworkPolicy "aml-api-deploy/kubeflow": namespaces "kubeflow" not found
failed to create Secret "cpaas-https-certs/istio-system": Secret in version "v1" cannot be handled as a Secret: illegal base64 data at input byte 2272
```

or the plugin installs and its web UI returns `RBAC denied`, also over NodePort and with `curl` without a token.

Kubeflow Base needs Alauda Service Mesh (ASM) deployed in the same cluster, and its install form needs the istio ingress gateway HTTPS NodePort. Installing without a service mesh, creating a gateway by hand, or pointing `oidcRedirectURL` to that gateway's load balancer IP leads to these errors; creating the `kubeflow` namespace by hand only moves the failure to the Secret error. Kubeflow Base creates its own Service `kubeflow-istio-ingressgateway`, a NodePort Service (`80:30080/TCP,443:30443/TCP` with the NodePorts chosen in the form), so no manual gateway is needed. Other form rules:

- `oidcRedirectURL` points to an existing cluster node or the cluster VIP.
- `pgStorageClass` must be a StorageClass in the same cluster.
- The form has no setting to keep components off GPU nodes; taint the GPU nodes instead.
- The plugin template supports only NodePort; LoadBalancer is not supported.
- The ASM console lists only `gatewaydeploys.asm.alauda.io` resources, so `kubeflow-istio-ingressgateway`, a plain Deployment created by the plugin, does not appear there.

The `RBAC denied` web UI is a product limitation, not a fault: Kubeflow Base depends on both ASM and AML (Alauda AI). Deploying Kubeflow Base standalone, without AML, is not supported.

### Cause 4: kubeflow-istio-ingressgateway has no istio.io/rev label in its Pod template

The gateway Pod is not injected, so its image address is not rewritten, and the Kubeflow Base upgrade fails. The `kubeflow-istio-ingressgateway` Deployment is created by the Kubeflow chart (`helm.sh/chart-name: kfbase`, release `kfbase` in `cpaas-system`) and carries `istio.io/rev: <revision>` (for example `1-22`) on the Deployment metadata. Its Pod template has `inject.istio.io/templates: gateway`, `sidecar.istio.io/inject: "true"`, and `app` / `istio` labels, but no `istio.io/rev` label. Service Mesh v1 Istio uses revision-based injection, so the Pod template needs `istio.io/rev: <revision>` together with `sidecar.istio.io/inject: "true"`. Injection is what rewrites the gateway image address; adding the label to the Pod template is the fix.

## Resolution

### Cause 1: An x86 plugin was installed on an ARM cluster, and its cleanup BroadcastJob fails too

Confirm the mismatch:

```bash
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
kubectl get broadcastjob -A | grep -i <plugin-name>
kubectl -n <namespace> logs <failing-pod> --all-containers --tail=50
```

> **Warning:** Redeploying the cluster destroys every workload and all data on it. This cannot be undone. Precondition: only when an x86 build of the plugin was installed on an ARM cluster, the plugin is stuck deleting because its cleanup BroadcastJob fails on architecture, and the cluster's workloads and data are backed up or disposable. Rollback: none; restore workloads from backup after the redeploy.

Redeploy the cluster, then deploy the plugin from a package built for the cluster's architecture. Before installing any plugin on an ARM or hybrid cluster, check that the package you push is the ARM or hybrid build.

### Cause 2: Argo Rollouts on 4.2.2 references the wrong init container image tag

Confirm the tag in the event, then, on `global`, find and save the argo-rollouts ModuleInfo of the affected cluster:

```bash
kubectl -n argo-rollouts get pods
kubectl -n argo-rollouts describe pod <argo-rollouts-pod> | grep -E 'copy-gwapi-plugin|rollouts-plugin-trafficrouter-gatewayapi'
kubectl get moduleinfo | grep <cluster-name> | grep argo-rollouts
kubectl get moduleinfo <moduleinfo-name> -o yaml > "$HOME/<moduleinfo-name>.before.yaml"
```

> **Warning:** `valuesOverride` changes the rendered argo-rollouts chart; the controller Pod is recreated with the overridden init container, and a wrong image or mount keeps it from starting. Precondition: only on ACP 4.2.2 when the argo-rollouts Pod fails to pull `rollouts-plugin-trafficrouter-gatewayapi:v1` for `copy-gwapi-plugin`. Rollback: remove the `valuesOverride` block again.

```bash
kubectl edit moduleinfo <moduleinfo-name>
```

Add the override under `spec`, replacing `<registry-address>` with the image registry address of that cluster:

```yaml
spec:
  config: {}
  valuesOverride:
    acp/argoproj/chart/argo-rollouts:
      controller:
        initContainers:
        - args:
            - cp /bin/rollouts-plugin-trafficrouter-gatewayapi /plugins
          command:
            - /bin/sh
            - -c
          image: <registry-address>/acp/argoproj-labs/rollouts-plugin-trafficrouter-gatewayapi:v0.6.0-6
          name: copy-gwapi-plugin
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
              ephemeral-storage: 500Mi
          volumeMounts:
            - mountPath: /plugins
              name: gwapi-plugin
```

Check that the controller Pod starts:

```bash
kubectl get pods -A | grep argo-rollouts
```

### Cause 3: Kubeflow Base install prerequisites are not met

Check the prerequisites on the target cluster before reinstalling:

```bash
kubectl get pods -A | grep -i istio
kubectl get gatewaydeploys.asm.alauda.io -A
kubectl get sc
kubectl get svc -A | grep -E '30443|30080'
kubectl get minfo | grep <cluster-name> | grep -iE 'aml|asm|kubeflow'
```

Deploy Alauda Service Mesh in the same cluster first if it is missing. Pick two free NodePorts (no output from the `grep` above means 30080 and 30443 are free), choose a `pgStorageClass` from `kubectl get sc` on that cluster, and set `oidcRedirectURL` to an existing cluster node IP or the cluster VIP, not to a load balancer IP.

> **Warning:** Deleting a gateway created by hand for Kubeflow removes any traffic routed through it. Uninstalling a failed Kubeflow Base removes what it partly deployed. Precondition: only when Kubeflow Base failed with the errors above and the gateway was created only for Kubeflow. Export it first with `kubectl -n <namespace> get gatewaydeploys.asm.alauda.io <gateway-name> -o yaml > "$HOME/<gateway-name>.yaml"`. Rollback: `kubectl apply -f` the export.

```bash
kubectl -n <namespace> delete gatewaydeploys.asm.alauda.io <gateway-name>
```

Uninstall the failed Kubeflow Base from Cluster Plugins, install it again with the values above, and check:

```bash
kubectl get svc -A | grep kubeflow-istio-ingressgateway
kubectl -n kubeflow get deploy,pods
kubectl -n kubeflow-oauth2-proxy get deploy,pods
curl -k -s -o /dev/null -w '%{http_code}\n' https://<node-ip>:30443
```

All `kubeflow` and `kubeflow-oauth2-proxy` Pods should reach `Running`. The UI is reached at `https://<node-ip>:<https-nodeport>`; keep the Service as NodePort. If the UI answers `RBAC denied` and AML is not installed on the cluster, install Kubeflow Base together with ASM and AML; standalone use is a product requirement, not a configuration change.

### Cause 4: kubeflow-istio-ingressgateway has no istio.io/rev label in its Pod template

```bash
kubectl get deploy -A | grep kubeflow-istio-ingressgateway
kubectl -n <namespace> get deploy kubeflow-istio-ingressgateway -o jsonpath='{.metadata.labels.istio\.io/rev}{"\n"}{.spec.template.metadata.labels}{"\n"}'
kubectl -n <namespace> get deploy kubeflow-istio-ingressgateway -o yaml > "$HOME/kubeflow-istio-ingressgateway.before.yaml"
```

A revision on the Deployment metadata and no `istio.io/rev` in the Pod template labels is this cause.

> **Warning:** Changing the Pod template rolls the Kubeflow ingress gateway; Kubeflow UI traffic is interrupted until the injected Pod is Ready. Precondition: only when the mesh uses revision-based injection, the gateway Pod is not injected, and the Pod template lacks `istio.io/rev`; use the revision shown on the Deployment metadata. Rollback: `kubectl apply -f "$HOME/kubeflow-istio-ingressgateway.before.yaml"`.

```bash
kubectl -n <namespace> patch deploy kubeflow-istio-ingressgateway --type=merge -p '{"spec":{"template":{"metadata":{"labels":{"istio.io/rev":"<revision>","sidecar.istio.io/inject":"true"}}}}}'
kubectl -n <namespace> get pods | grep kubeflow-istio-ingressgateway
```

Check that the new Pod runs the rewritten image, then retry the Kubeflow Base upgrade.

## Diagnostic Steps

```bash
kubectl get ars -A
kubectl get minfo | grep <cluster-name>
kubectl get broadcastjob -A
kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
```

- An architecture mismatch in both the plugin and its cleanup BroadcastJob: Cause 1.
- A pull failure for `rollouts-plugin-trafficrouter-gatewayapi:v1` on the `copy-gwapi-plugin` init container of Argo Rollouts on 4.2.2: Cause 2.
- Kubeflow Base failing on `namespaces "kubeflow" not found` or `illegal base64 data`, or answering `RBAC denied` without AML: Cause 3.
- A failed Kubeflow Base upgrade with an uninjected `kubeflow-istio-ingressgateway` whose Pod template has no `istio.io/rev`: Cause 4.

A cluster plugin pushed with `violet push` is registered on `global` and offered to clusters by its affinity; look for it under the target cluster's Cluster Plugins rather than pushing it to each cluster.
