---
kind:
  - Troubleshooting
products:
  - Alauda Service Mesh
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# asm-otel collectors keep restarting, Service Mesh JVM monitoring has no data, or an otel instance cannot be deleted

## Issue

One of the following is seen:

- The platform components `asm-otel-backend-collector` and `asm-otel-collector` keep restarting and cannot be restarted cleanly. The image field shown for them in the console keeps changing.
- Service Mesh JVM monitoring, or the `OpenTelemetry Java JVM` dashboard, shows no data for a Java application.
- While OpenTelemetry is being uninstalled so that OpenTelemetry v2 can be installed, the otel instance is deleted but stays in place, and the OpenTelemetry v2 installation is blocked.

Related articles: "OpenTelemetry Collector logs cannot list resources pods because its ServiceAccount has no ClusterRoleBinding on ACP" covers a Collector that cannot list Pods. "Java auto-instrumentation init container is missing or the Java agent lands next to istio-proxy on Service Mesh v2" covers a pod where the Java agent was never injected.

## Root Cause

### Cause 1: a leftover 3.x `opentelemetry-operator` in `cpaas-system` fights the asm-otel collectors

A Deployment named `opentelemetry-operator` runs in `cpaas-system`. That Deployment belongs only to 3.x environments. It conflicts with the current `asm-otel-*` components and keeps changing them, so both collectors restart. The Mesh v2 OpenTelemetry operator that serves tracing (for example `opentelemetry-operator-controller-manager` in `istio-system`) is not this leftover. Removing the old Deployment returns the collectors to normal; other objects left by that old operator should be cleaned up so they do not cause a later fault.

### Cause 2: `asm-otel` was OOMKilled

JVM metrics are not collected because the `asm-otel` collection component was OOMKilled. Raising its CPU and memory allocation lets it run and collect again.

### Cause 3: the otel instance still carries a finalizer

The OpenTelemetry Operator was uninstalled before the otel instance was removed, so nothing clears the instance's `finalizers` and the delete never completes. Removing the finalizer lets the delete finish, and the OpenTelemetry v2 installation is no longer blocked.

### Cause 4: the Java agent cannot resolve the exporter endpoint in the `Instrumentation`

The Java agent is injected (the auto-instrumentation init container ran and is `terminated`), but the exporter endpoint in the `Instrumentation` resource uses a full service name that does not resolve from the application Pod, for example a mistyped or wrong cluster domain in `http://otel-collector.<collector-namespace>.svc.cluster.local:4318`. The agent's metric export times out, so no JVM series reach the Collector. The application container log shows:

```text
ERROR io.opentelemetry.exporter.internal.http.HttpExporter - Failed to export metrics. The request could not be executed. Full error message: timeout
java.io.InterruptedIOException: timeout
```

The documented endpoint form `http://<collector-service>.<collector-namespace>:4318` resolves through the Pod's DNS search path.

## Resolution

### Cause 1: a leftover 3.x `opentelemetry-operator` in `cpaas-system` fights the asm-otel collectors

1. Confirm that both collectors restart and that an `opentelemetry-operator` Deployment runs in `cpaas-system`:

   ```bash
   kubectl get pod -A | grep -i opentelemetry-operator
   kubectl get deploy,pods -n cpaas-system | grep -E 'opentelemetry-operator|asm-otel'
   ```

   Two operators, an old `opentelemetry-operator-<hash>` in `cpaas-system` (typically more than a year old) and `opentelemetry-operator-controller-manager-<hash>` in `istio-system`, match this cause.

2. Back up and delete the old Deployment.

   > **Warning:** This stops the 3.x operator in `cpaas-system`. Only when both `asm-otel-backend-collector` and `asm-otel-collector` restart, the image field keeps changing, and this Deployment is in `cpaas-system`. Rollback: `kubectl apply -f /tmp/opentelemetry-operator-deploy.bak.yaml`.

   ```bash
   kubectl get deploy -n cpaas-system opentelemetry-operator -o yaml > /tmp/opentelemetry-operator-deploy.bak.yaml
   kubectl delete deploy -n cpaas-system opentelemetry-operator
   kubectl get pods -A | grep -E 'asm-otel|opentelemetry-operator'
   ```

   The collectors should stay Running and the image field should stop changing.

3. Clean up the other objects of the old operator that still exist. List them first:

   ```bash
   kubectl get mutatingwebhookconfiguration,validatingwebhookconfiguration | grep opentelemetry-operator
   kubectl get certificate,issuer,svc,role,rolebinding,sa,servicemonitor -n cpaas-system | grep opentelemetry-operator
   kubectl get clusterrole,clusterrolebinding | grep opentelemetry-operator
   ```

   > **Warning:** These webhook, RBAC, certificate, and Service objects are the old operator's admission and identity; cluster-scoped deletes affect every namespace. Only after the Deployment in step 2 is gone, and only for objects with these exact names. Back up each object with `kubectl get <kind> <name> [-n cpaas-system] -o yaml > /tmp/<name>.bak.yaml` first. Rollback: `kubectl apply` of the backup (remove `resourceVersion`, `uid`, and `managedFields` from a webhook backup if apply complains).

   ```bash
   kubectl delete mutatingwebhookconfiguration opentelemetry-operator-mutation
   kubectl delete validatingwebhookconfiguration opentelemetry-operator-validation
   kubectl delete certificate opentelemetry-operator-serving-cert -n cpaas-system
   kubectl delete issuer opentelemetry-operator-selfsigned-issuer -n cpaas-system
   kubectl delete svc opentelemetry-operator-webhook opentelemetry-operator -n cpaas-system
   kubectl delete role,rolebinding opentelemetry-operator-leader-election -n cpaas-system
   kubectl delete clusterrole,clusterrolebinding opentelemetry-operator-manager
   kubectl delete sa opentelemetry-operator -n cpaas-system
   kubectl delete servicemonitor opentelemetry-operator -n cpaas-system
   ```

   Run a line only for an object the listing showed.

### Cause 2: `asm-otel` was OOMKilled

1. Confirm the last state is OOMKilled:

   ```bash
   kubectl get pods -A | grep asm-otel
   kubectl describe pod -n <namespace> <asm-otel-pod> | grep -A8 'Last State'
   ```

2. Raise CPU and memory. On a ServiceMesh install, component sizes are set under `spec.componentConfig` of the ServiceMesh resource (entries `asmOtelCollector` and `asmOtelCollectorLB` for `asm-otel-collector` and `asm-otel-backend-collector`). Change them there so the next reconcile does not restore the old limits.

   > **Warning:** A higher request can leave the Pod Pending until a node has the capacity; a limit that is still too low leaves it OOMKilled. Only when JVM monitoring is empty and the Pod's last state is OOMKilled. Rollback: apply the backup.

   ```bash
   kubectl get servicemesh -A -o yaml | grep -n -i -E 'asmOtel'
   kubectl get servicemesh -n <servicemesh-namespace> <servicemesh-name> -o yaml > /tmp/servicemesh-otel.bak.yaml
   kubectl edit servicemesh -n <servicemesh-namespace> <servicemesh-name>
   ```

3. The new Pod should not be OOMKilled and its log should progress; JVM series are then collected again.

### Cause 3: the otel instance still carries a finalizer

1. Confirm the instance has a `deletionTimestamp` and a finalizer, and that the old operator is already gone:

   ```bash
   kubectl get opentelemetrycollector,instrumentation -A
   kubectl get <otel-kind> -n <namespace> <otel-instance> -o jsonpath='{.metadata.deletionTimestamp}{" "}{.metadata.finalizers}{"\n"}'
   kubectl get csv -A | grep -i opentelemetry
   ```

2. Remove the finalizer.

   > **Warning:** The instance is deleted without the operator's cleanup; objects it created that are not garbage-collected through owner references stay and must be removed by hand. Only when the instance has a `deletionTimestamp`, a finalizer is set, and the old OpenTelemetry Operator is uninstalled. Rollback: the delete is irreversible; recreate the instance from the backup after removing `metadata.finalizers`, `deletionTimestamp`, `resourceVersion`, and `uid`.

   ```bash
   kubectl get <otel-kind> -n <namespace> <otel-instance> -o yaml > /tmp/otel-instance.bak.yaml
   kubectl patch <otel-kind> -n <namespace> <otel-instance> --type=merge -p '{"metadata":{"finalizers":null}}'
   ```

   `<otel-kind>` is the kind of the stuck instance, for example `opentelemetrycollector`. Then continue with the OpenTelemetry v2 installation.

### Cause 4: the Java agent cannot resolve the exporter endpoint in the `Instrumentation`

1. Read the endpoint and test it from the application Pod (or any Pod in the same namespace that has `curl`):

   ```bash
   kubectl get instrumentation -n <app-namespace> -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.exporter.endpoint}{"\n"}{end}'
   kubectl -n <app-namespace> logs <app-pod> -c <app-container> --tail=200 | grep -i 'Failed to export'
   kubectl -n <app-namespace> exec <pod> -- curl -s -o /dev/null -w '%{http_code}\n' http://<collector-service>.<collector-namespace>:4318
   ```

   `could not resolve` for the configured name and an HTTP code (for example `404`) for the short name means the Collector port is reachable and only the name is wrong.

2. Change the endpoint to `http://<collector-service>.<collector-namespace>:4318`.

   > **Warning:** The new endpoint applies to Pods injected after the change; restart the instrumented workloads so they pick it up, which recreates their Pods. Rollback: restore the previous endpoint value and restart again.

   ```bash
   kubectl -n <app-namespace> patch instrumentation <instrumentation-name> --type=merge \
     -p '{"spec":{"exporter":{"endpoint":"http://<collector-service>.<collector-namespace>:4318"}}}'
   kubectl -n <app-namespace> rollout restart deployment <deployment-name>
   ```

3. Also check that the workload uses an `Instrumentation` it can find: declare one in each application namespace, or reference one in another namespace with the annotation value `<namespace>/<instrumentation-name>`, for example `instrumentation.opentelemetry.io/inject-java: "<namespace>/<instrumentation-name>"`. If the Collector has no logs pipeline, setting the environment variable `OTEL_LOGS_EXPORTER=none` in the `Instrumentation` (`spec.env`) stops the agent from exporting logs to it.

4. After the restart, the `Failed to export metrics` errors should stop and the JVM dashboard should start receiving series.

## Diagnostic Steps

```bash
kubectl get pods -A | grep -E 'asm-otel|opentelemetry-operator'
kubectl get deploy -n cpaas-system | grep opentelemetry-operator
kubectl get instrumentation -A
```

| What you see | Cause |
| --- | --- |
| Both asm-otel collectors restart, image field keeps changing, `opentelemetry-operator` Deployment in `cpaas-system` next to the one in `istio-system` | 1 |
| JVM monitoring empty, `asm-otel` last state OOMKilled | 2 |
| otel instance stays after delete, `finalizers` set, operator already uninstalled | 3 |
| JVM dashboard empty, agent injected, application log shows `Failed to export metrics ... timeout`, configured endpoint does not resolve | 4 |
