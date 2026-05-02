---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500004
---

# Exposing cert-manager Metrics to Namespace-Scoped Users via User Workload Monitoring
## Issue

A namespace-scoped user, granted access only to a single project, cannot view the `certmanager_certificate_expiration_timestamp_seconds` metric (or any other cert-manager metric) even though User Workload Monitoring is enabled on the cluster. The same query works for a cluster-monitoring user.

## Root Cause

cert-manager is typically installed in its own namespace and exposes its metrics through a Service that the platform's cluster-level Prometheus scrapes. That Prometheus instance enforces cluster-scoped read access — a namespace-scoped user cannot query it without elevated permissions.

User Workload Monitoring (UWM) runs an independent Prometheus that scrapes targets selected by `ServiceMonitor` and `PodMonitor` resources. Metrics scraped by UWM are visible to users with `monitoring-rules-view` (or equivalent) on the namespace where the monitor lives. To get cert-manager metrics into UWM and reachable by a namespace-scoped user, two things must be true:

1. A `ServiceMonitor` selecting the cert-manager metrics Service exists somewhere UWM is allowed to read.
2. The user has at least `monitoring-rules-view` on that namespace.

Without those, the metric is collected only by the cluster Prometheus and remains inaccessible from a namespace-scoped session.

## Resolution

The recommended path is to teach UWM to scrape cert-manager directly, so that namespace users can query the metric without granting cluster-wide read.

### Step 1: Locate the cert-manager Metrics Service

Identify the Service that exposes the metrics endpoint:

```bash
kubectl -n cert-manager get svc
kubectl -n cert-manager get svc -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.ports[*].name}{"\n"}{end}'
```

The default cert-manager chart ships a Service named `cert-manager` with a port called `tcp-prometheus-servicemonitor` (port 9402). Confirm the names against your install — older charts may use `metrics` instead.

### Step 2: Create a ServiceMonitor for UWM

Apply a `ServiceMonitor` in the same namespace as the metrics Service. Place the ServiceMonitor where User Workload Monitoring is configured to discover monitors (the platform-level configuration controls which namespaces are scanned).

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: cert-manager
  namespace: cert-manager
  labels:
    release: user-workload-monitoring
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: cert-manager
      app.kubernetes.io/component: controller
  namespaceSelector:
    matchNames:
      - cert-manager
  endpoints:
    - port: tcp-prometheus-servicemonitor
      interval: 30s
      scrapeTimeout: 10s
```

Apply it:

```bash
kubectl apply -f cert-manager-servicemonitor.yaml
```

If the `release` label is not the convention on your cluster, consult the User Workload Monitoring configuration to find the discovery selector and adjust the label accordingly.

### Step 3: Grant the Namespace User Read Access on the Monitor

The user must be able to read the `monitoring-rules-view` role on the namespace where the ServiceMonitor lives. Bind it once per user (or to a group):

```bash
NAMESPACE=cert-manager
USER=<namespace-user>

kubectl -n ${NAMESPACE} create rolebinding ${USER}-monitoring-view \
  --clusterrole=monitoring-rules-view \
  --user=${USER}
```

If the user already holds a project-edit or project-admin role on the namespace, the platform usually includes monitoring read in that bundle and no extra binding is needed; verify with `kubectl auth can-i`.

### Step 4: Verify the Metric Appears

After the User Workload Prometheus picks up the new ServiceMonitor (typically within a minute), the metric should be queryable from a workload running in the namespace. Spot-check from inside the cluster:

```bash
kubectl -n cert-manager run curl --image=curlimages/curl --rm -it --restart=Never -- \
  -sk -G "https://kube-prometheus-thanos-query.<monitoring-ns>.svc:9091/api/v1/query" \
  --data-urlencode 'query=certmanager_certificate_expiration_timestamp_seconds' \
  -H "Authorization: Bearer $(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
```

A 200 response with a non-empty `result` array confirms the path. If the response is empty, validate that the User Workload Prometheus is actually scraping the target — see Diagnostic Steps below.

### Alternative: Cluster-Wide Read Grant (Not Recommended)

When namespace-scoped exposure is not viable, granting `cluster-monitoring-view` to the user gives access to *every* metric the cluster Prometheus collects:

```bash
kubectl create clusterrolebinding ${USER}-cluster-monitoring \
  --clusterrole=cluster-monitoring-view \
  --user=${USER}
```

This violates least-privilege — the user can now read CPU, memory, and arbitrary application metrics from every other namespace on the cluster — and should be reserved for platform operators.

## Diagnostic Steps

Confirm the ServiceMonitor was created and labeled correctly:

```bash
kubectl -n cert-manager get servicemonitor
kubectl -n cert-manager get servicemonitor cert-manager -o yaml | grep -A3 selector
```

Confirm User Workload Monitoring picked up the target:

```bash
# Replace <uwm-ns> with the namespace where the User Workload Prometheus runs.
kubectl -n <uwm-ns> get pods -l app.kubernetes.io/name=prometheus
kubectl -n <uwm-ns> exec prometheus-user-workload-0 -- \
  wget -qO- http://localhost:9090/api/v1/targets \
  | python3 -c 'import json,sys; t=json.load(sys.stdin); print([x["labels"] for x in t["data"]["activeTargets"] if "cert-manager" in x["labels"].get("namespace","")])'
```

A target in `state: up` confirms the scrape works. A target in `state: down` exposes the underlying error in `lastError` — usually a TLS or selector mismatch.

Verify the user's effective permissions:

```bash
kubectl auth can-i get prometheuses.monitoring.coreos.com -n cert-manager --as=${USER}
kubectl auth can-i get servicemonitors -n cert-manager --as=${USER}
```

Both must return `yes` for the namespace-scoped path to work.
