---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Create PrometheusRule Alerts for etcd Defragmentation
## Issue

When etcd auto-defragmentation is disabled, the database accumulates unused space over time. Without proactive monitoring, the etcd data file can grow to the point where cluster performance degrades. A mechanism is needed to alert operators when manual defragmentation becomes necessary.

## Resolution

Create a custom `PrometheusRule` resource that triggers alerts based on the ratio of unused space within the etcd database.

### Prerequisites

Ensure the Prometheus Operator is deployed and the `PrometheusRule` CRD is available in the cluster:

```bash
kubectl get crd prometheusrules.monitoring.coreos.com
```

### Create the Alert Rules

Apply the following `PrometheusRule` manifest. Adjust the namespace to match the monitoring stack configuration (commonly `monitoring` or `kube-system`):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-defragmentation-alerts
  namespace: monitoring
spec:
  groups:
    - name: etcd-defragmentation.rules
      rules:
        - alert: EtcdDefragIsAdvised
          annotations:
            summary: >-
              Etcd database unused space exceeds 35%.
              Consider running defragmentation.
            description: >-
              The etcd database has more than 35% unused space
              and the total size exceeds 400 MB. Schedule a
              defragmentation during a maintenance window.
          expr: >-
            avg(etcd_db_total_size_in_bytes) > 419430400
            and
            (
              (avg(etcd_mvcc_db_total_size_in_bytes)
               - avg(etcd_mvcc_db_total_size_in_use_in_bytes))
              * 100
              / avg(etcd_mvcc_db_total_size_in_bytes)
            ) > 35
          labels:
            severity: warning

        - alert: EtcdDefragIsNeeded
          annotations:
            summary: >-
              Etcd database unused space exceeds 40%.
              Defragmentation is strongly recommended.
            description: >-
              The etcd database has more than 40% unused space
              and the total size exceeds 600 MB. Perform
              defragmentation as soon as possible to avoid
              performance degradation.
          expr: >-
            avg(etcd_db_total_size_in_bytes) > 629145600
            and
            (
              (avg(etcd_mvcc_db_total_size_in_bytes)
               - avg(etcd_mvcc_db_total_size_in_use_in_bytes))
              * 100
              / avg(etcd_mvcc_db_total_size_in_bytes)
            ) > 40
          labels:
            severity: critical
```

### Verify the Rules Are Loaded

```bash
kubectl get prometheusrule -n monitoring
kubectl describe prometheusrule etcd-defragmentation-alerts -n monitoring
```

### Perform Defragmentation When Alerted

When the alert fires, run defragmentation on each etcd member:

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl defrag \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

Process one member at a time to maintain quorum throughout the operation.

## Diagnostic Steps

Check current etcd database size and usage. The etcd container image typically ships without an HTTP client, so `kubectl exec … -- wget/curl` does not work; port-forward the metrics port to your workstation instead:

```bash
# Terminal 1
kubectl port-forward -n kube-system pod/etcd-<node-name> 12381:2381

# Terminal 2
curl -s http://127.0.0.1:12381/metrics \
  | grep -E "^etcd_(mvcc_db_total_size_in_bytes|mvcc_db_total_size_in_use_in_bytes|db_total_size_in_bytes) "
```

Verify the PrometheusRule is being evaluated. The Prometheus namespace and Service vary by deployment — locate them first, then forward to the pod's raw port (many clusters front the Prometheus Service with an auth proxy that rejects unauthenticated `/api/v1/rules` requests):

```bash
# Namespace + pod name for the running Prometheus
ns=$(kubectl get prometheus -A -o jsonpath='{.items[0].metadata.namespace}')
pod=$(kubectl get pod -n "$ns" -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}')

kubectl port-forward -n "$ns" "pod/$pod" 9090:9090 &
curl -s http://127.0.0.1:9090/api/v1/rules \
  | python3 -m json.tool | grep -iE "defrag"
```
