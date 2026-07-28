---
title: Alert on etcd Defragmentation Need with a Custom PrometheusRule
component: observability
scenario: how-to
tags: [etcd, prometheus, alertmanager, prometheusrule, monitoring]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Alert on etcd Defragmentation Need with a Custom PrometheusRule

## Issue

An administrator has disabled etcd auto-defragmentation on an Alauda Container Platform cluster and needs an Alertmanager-delivered signal when manual defragmentation is required. On ACP the etcd process is the upstream kubeadm-style static pod `etcd-<control-plane-IP>` in `kube-system`, started by the kubelet with `--auto-compaction-retention=24h --auto-compaction-mode=periodic`; that flag controls keyspace compaction, not boltdb defragmentation, and no in-cluster controller runs `etcdctl defrag` on the administrator's behalf [ev:c8]. A custom rule must therefore fire from the metrics the etcd pod already publishes, evaluated by the cluster's Prometheus stack and delivered through Alertmanager.

The `PrometheusRule` custom resource (`monitoring.coreos.com/v1`, CRD annotation `operator.prometheus.io/version: 0.91.0`) is the supported way to add an alerting rule on ACP; the apiserver accepts a `PrometheusRule` manifest in any namespace as long as the rule's PromQL expression resolves against series the cluster's Prometheus actually scrapes [ev:c1].

## Root Cause

The etcd boltdb file grows when entries are written and revisions are compacted but the freelist space is not yet reclaimed. The metrics endpoint of the etcd static pod exposes the mvcc-store sizes used to compute the reclaimable share: `etcd_mvcc_db_total_size_in_bytes` is the size the mvcc store occupies on disk and `etcd_mvcc_db_total_size_in_use_in_bytes` is the actual live portion, both scraped from `http://127.0.0.1:2381/metrics` (the endpoint declared on the etcd container's `--listen-metrics-urls`) [ev:c7]. The difference between the two represents space that defragmentation would reclaim. Because nothing on ACP defrags etcd automatically, a custom rule has to watch that difference and notify the administrator when it crosses an operational threshold [ev:c8].

## Resolution

Create a `PrometheusRule` carrying two alerts that use the mvcc-store size metric: a `warning` when the database has grown above a moderate threshold AND the reclaimable share exceeds a moderate percentage, and a `critical` when both bounds are higher. The thresholds below are operator-tunable; the manifest shape — a `PrometheusRule` whose group contains an alert with `expr`, `labels`, and `annotations` — is the standard form the CRD accepts (rules require `expr`, the IntOrString-typed PromQL field; `alert`, `labels`, and `annotations` are optional companions) [ev:c1].

The `warning` alert combines an absolute mvcc-store size threshold of about 400 MiB with a reclaimable-share threshold of 35%, joined by `and`, and carries `severity: warning` [ev:c4_a]. The `critical` alert raises both bounds — about 600 MiB and 40% — and carries `severity: critical` [ev:c5_a]. Both expressions are built from the same scraped mvcc-store metric pair: `etcd_mvcc_db_total_size_in_bytes` as the absolute-size term, and `(etcd_mvcc_db_total_size_in_bytes - etcd_mvcc_db_total_size_in_use_in_bytes) * 100 / etcd_mvcc_db_total_size_in_bytes` as the reclaimable percent [ev:c7].

Apply the following manifest. On ACP the single `Prometheus` CR that the Monitoring for Prometheus ModulePlugin installs into `cpaas-system` selects rules cluster-wide, so the namespace is the administrator's choice — `kube-system` (next to the etcd pod) or a dedicated operations namespace are both fine [ev:c1]:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: etcd-custom-defragmentation-alert
  namespace: kube-system
spec:
  groups:
    - name: etcd-custom-defragmentation-alert
      rules:
        - alert: etcdDefragIsAdvised
          annotations:
            description: 'etcd mvcc store reclaimable share is above 35%; manual defragmentation is advised.'
            summary: etcd mvcc store > 400 MiB with > 35% reclaimable; defragmentation is advised.
          expr: |
            avg(etcd_mvcc_db_total_size_in_bytes) > 419430400
            and
            ((avg(etcd_mvcc_db_total_size_in_bytes) - avg(etcd_mvcc_db_total_size_in_use_in_bytes)) * 100
              / avg(etcd_mvcc_db_total_size_in_bytes)) > 35
          labels:
            severity: warning
        - alert: etcdDefragIsNeeded
          annotations:
            description: 'etcd mvcc store reclaimable share is above 40%; manual defragmentation is strongly advised.'
            summary: etcd mvcc store > 600 MiB with > 40% reclaimable; defragmentation is strongly advised.
          expr: |
            avg(etcd_mvcc_db_total_size_in_bytes) > 629145600
            and
            ((avg(etcd_mvcc_db_total_size_in_bytes) - avg(etcd_mvcc_db_total_size_in_use_in_bytes)) * 100
              / avg(etcd_mvcc_db_total_size_in_bytes)) > 40
          labels:
            severity: critical
```

Apply it:

```bash
kubectl apply -f etcd-defrag-prometheusrule.yaml
kubectl -n kube-system get prometheusrule etcd-custom-defragmentation-alert
```

Once the alert is firing, run defragmentation against the live etcd member using the `etcdctl` binary that ships in the etcd static pod's image (upstream etcd v3.5.x, packaged as `registry.alauda.cn:60080/tkestack/etcd:v3.5.28-260421`) [ev:c8]:

```bash
kubectl -n kube-system exec -it etcd-<control-plane-IP> -- sh -c '
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  defrag --cluster'
```

## Diagnostic Steps

Before applying the rule, confirm that the mvcc-store metric pair is actually being scraped on the cluster. The metrics are served by the etcd static pod over the loopback endpoint declared on its `--listen-metrics-urls` flag, so a pod with host networking on the control-plane node can read them directly [ev:c7]:

```bash
kubectl -n kube-system exec etcd-<control-plane-IP> -- sh -c \
  'curl -s http://127.0.0.1:2381/metrics' | \
  grep -E '^etcd_mvcc_db_total_size'
```

The expected output is two single-sample series, for example:

```text
etcd_mvcc_db_total_size_in_bytes 9.9078144e+07
etcd_mvcc_db_total_size_in_use_in_bytes 6.8694016e+07
```

In this sample the mvcc store occupies about 94 MiB on disk with about 65 MiB in use, so roughly 30% is reclaimable — below the 35% warning threshold. Computing this share on a sustained basis is exactly what the rule above does; until the share crosses the configured threshold for the rule's evaluation cycle, the alert stays silent and no manual defragmentation is needed [ev:c7].

A quick way to confirm that the rule itself was admitted by the apiserver (and therefore that the `PrometheusRule` CRD shape and PromQL parse are accepted) is a server-side dry run before committing the manifest [ev:c1]:

```bash
kubectl apply --dry-run=server -f etcd-defrag-prometheusrule.yaml
```

The expected result is `prometheusrule.monitoring.coreos.com/etcd-custom-defragmentation-alert created (server dry run)`, after which the manifest can be applied for real [ev:c1].
