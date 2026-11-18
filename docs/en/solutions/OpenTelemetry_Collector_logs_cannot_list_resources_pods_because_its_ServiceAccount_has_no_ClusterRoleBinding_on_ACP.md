---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# OpenTelemetry Collector logs cannot list resources pods because its ServiceAccount has no ClusterRoleBinding on ACP

## Issue

The OpenTelemetry Collector log repeats an RBAC error that engineers usually quote as `cannot list resources "pod" in API group`. The full Kubernetes form is:

```text
pods is forbidden: User "system:serviceaccount:<collector-namespace>:otel-collector" cannot list resource "pods" in API group "" at the cluster scope
```

The Collector Pod is Running, but processors that look up Kubernetes metadata (for example Pod attributes on spans) fail. The Collector was deployed by following a tracing deployment document, often into an application namespace instead of the namespace that document uses.

Related articles: "asm-otel collectors keep restarting, Service Mesh JVM monitoring has no data, or an otel instance cannot be deleted" covers the Service Mesh collectors and a Java agent that cannot reach the Collector.

## Root Cause

The Collector runs as a ServiceAccount that the operator creates in the namespace of the `OpenTelemetryCollector` resource, for example `system:serviceaccount:<collector-namespace>:otel-collector`. A Kubernetes ClusterRoleBinding names one ServiceAccount in one namespace. The deprecated deployment document grants cluster-wide read access only to `system:serviceaccount:cpaas-system:otel-collector` (ClusterRoleBinding `otel-collector:cpaas-system:cluster-admin`). When the Collector is deployed in any other namespace, the ServiceAccount actually in use has no binding and cannot list Pods across the cluster.

The old tracing deployment documents are deprecated: the old Distributed Tracing pages are removed in ACP 4.4, and ACP 4.3 is the last version that contains them. Current deployments follow the Alauda Distributed Tracing documentation.

## Resolution

1. Redeploy the tracing stack by following the current Alauda Distributed Tracing documentation, for example "Installing Alauda Distributed Tracing (OpenSearch)" for distributed-tracing 2.1, instead of the deprecated document. This is the confirmed fix: the current procedure creates the Collector together with the permissions it needs.

   > **Warning:** Removing the old Collector stops trace and metric collection until the new Collector is Running; spans sent in that window are lost. Back up the old resource first with `kubectl -n <collector-namespace> get opentelemetrycollector <name> -o yaml > /tmp/otel-collector.bak.yaml`. Rollback: apply the backup.

2. If the existing Collector has to stay where it is until the redeployment, the binding can be pointed at the ServiceAccount that is really used. Grant only what the Collector needs; the example ClusterRole below allows reading Pods, Namespaces, and ReplicaSets, which is what Kubernetes attribute lookups usually need:

   ```bash
   kubectl create clusterrole otel-collector-read --verb=get,list,watch --resource=pods,namespaces,replicasets.apps
   kubectl create clusterrolebinding otel-collector-read:<collector-namespace> \
     --clusterrole=otel-collector-read --serviceaccount=<collector-namespace>:otel-collector
   ```

   Rollback: `kubectl delete clusterrolebinding otel-collector-read:<collector-namespace>` and `kubectl delete clusterrole otel-collector-read`.

3. After the change the Collector log should no longer show the `cannot list resource "pods"` error.

## Diagnostic Steps

1. Read the full error and the ServiceAccount the Collector Pod runs as:

   ```bash
   kubectl logs -n <collector-namespace> <otel-collector-pod> --tail=80
   kubectl get pod -n <collector-namespace> <otel-collector-pod> -o jsonpath='{.spec.serviceAccountName}{"\n"}'
   kubectl get sa -n <collector-namespace> otel-collector -o jsonpath='{.metadata.ownerReferences}{"\n"}'
   ```

   The ServiceAccount is typically `otel-collector`, owned by the `OpenTelemetryCollector` resource.

2. Test the permission of exactly that ServiceAccount:

   ```bash
   kubectl auth can-i list pods -A --as=system:serviceaccount:<collector-namespace>:otel-collector
   ```

   `no` confirms the missing permission.

3. Find which subject the existing binding names:

   ```bash
   kubectl get clusterrolebinding -o yaml | grep -B 8 -A 12 'name: otel-collector'
   ```

   A binding whose subject is ServiceAccount `otel-collector` in namespace `cpaas-system`, while the Collector runs in another namespace, matches this article.
