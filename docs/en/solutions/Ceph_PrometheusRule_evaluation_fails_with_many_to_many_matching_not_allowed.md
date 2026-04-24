---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a cluster running the ACP Ceph storage system, the Prometheus instance responsible for platform monitoring begins logging rule-evaluation failures for the `ceph.rules` rule group, and the `PrometheusRuleFailures` alert fires. The Prometheus log entry includes the PromQL expression for a recording rule that joins `ceph_disk_occupation` against node-level disk metrics, and fails with:

```text
level=warn group=ceph.rules msg="Evaluating rule failed"
rule="record: cluster:ceph_disk_latency:join_ceph_node_disk_irate1m
expr: avg by (namespace) (topk by (ceph_daemon, namespace) (1,
   label_replace(label_replace(ceph_disk_occupation{job=\"rook-ceph-mgr\"}, ...
err="found duplicate series for the match group {device=\"sdb\"} on the
left hand-side of the operation:
 [{__name__=\"ceph_disk_occupation\", ceph_daemon=\"osd.2\", device=\"sdb\", ...},
  {__name__=\"ceph_disk_occupation\", ceph_daemon=\"osd.0\", device=\"sdb\", ...}];
many-to-many matching not allowed: matching labels must be unique on one side"
```

Because the rule never successfully evaluates, any Ceph alert or dashboard that depends on the `cluster:ceph_disk_latency:…` recording series is unavailable, and the platform-level `PrometheusRuleFailures` alert stays triggered.

## Root Cause

Two distinct bugs in the Ceph PrometheusRule shipped by older releases can each produce the same `many-to-many matching not allowed` symptom:

1. **Erroneous query in `ceph_disk_occupation`.** The recording rule joins `ceph_disk_occupation` to node disk metrics using `group_right` vector matching. If the underlying metric emits more than one series that shares the matcher labels (for example, multiple OSDs advertising the same `device=sdb` because the label set is not unique per OSD), PromQL cannot pick a single left-hand series and refuses the evaluation.

2. **Missing `managedBy` label.** The original `ceph.rules` definition relied on the `managedBy` label being present on every `ceph_disk_occupation` sample to disambiguate multiple Ceph clusters / mgr instances inside the same namespace. When that label is not emitted, `ceph_disk_occupation` samples from two OSDs collapse onto the same match group and trigger the same duplicate-series error.

Both faults live in the PrometheusRule definition that the Rook / Ceph operator installs — not in Prometheus itself and not in the Ceph cluster health. Patched revisions of the rule set that correct the query and/or add the `managedBy` join key eliminate the evaluation failure.

## Resolution

Upgrade the ACP Ceph storage system to a release that ships the corrected `ceph.rules` PrometheusRule. There is no runtime workaround for the bad rule: Prometheus stores what the rule file defines, so until the rule text itself is replaced the evaluation will keep failing. Concretely:

1. Check which revision of the PrometheusRule is currently installed and whether it contains the fixed query. Look at the `ceph.rules` group inside the installed `PrometheusRule` object in the Ceph storage namespace:

   ```bash
   kubectl -n <ceph-namespace> get prometheusrule \
     -l 'app.kubernetes.io/name=rook-ceph' -o yaml \
     | grep -A5 "name: ceph.rules"
   ```

   If the recording expression still joins without the `managedBy` label, the cluster is on an affected revision.

2. Upgrade the ACP Ceph storage components via the supplied operator — the patched PrometheusRule is part of the operator's bundle and is reconciled into the namespace as soon as the operator rolls out the new version. After upgrade, verify the rule text contains the disambiguating label:

   ```bash
   kubectl -n <ceph-namespace> get prometheusrule \
     -l 'app.kubernetes.io/name=rook-ceph' -o yaml \
     | grep -A10 "record: cluster:ceph_disk_latency"
   ```

3. Force a reload of the Prometheus configuration so the corrected rule is picked up without waiting for the next auto-reload interval. On the ACP monitor stack, deleting the Prometheus pod is safe — the StatefulSet recreates it with the new rule files mounted:

   ```bash
   kubectl -n <monitor-namespace> delete pod -l app.kubernetes.io/name=prometheus
   ```

4. If the evaluation failure persists after the upgrade with the same duplicate-series error, the underlying Ceph mgr is emitting a label set that actually collides (for example, identical `device` labels on two different hosts). Inspect the raw metric to confirm:

   ```bash
   kubectl -n <monitor-namespace> exec -it <prometheus-pod> -- \
     wget -qO- 'http://localhost:9090/api/v1/query?query=ceph_disk_occupation' \
     | head -n 200
   ```

   Duplicate label sets that survive the fixed rule indicate a collector-level problem in the Rook / Ceph mgr configuration rather than a PrometheusRule bug; check the Ceph mgr module and any custom label relabelling in the `ServiceMonitor` pointing at `rook-ceph-mgr`.

There is no safe "edit the rule in place" mitigation, because the operator reconciles the `PrometheusRule` back to its bundled definition on every cycle — manual edits to the rule YAML will revert. Upgrading the operator is the only durable fix.

## Diagnostic Steps

1. Confirm the alert and identify the failing rule group:

   ```bash
   kubectl -n <monitor-namespace> logs <prometheus-pod> \
     | grep -E "group=ceph.rules|many-to-many"
   ```

2. Inspect the `PrometheusRule` that the rule evaluator is reading from, and the associated `ServiceMonitor` that feeds `ceph_disk_occupation`:

   ```bash
   kubectl -n <ceph-namespace> get prometheusrule
   kubectl -n <ceph-namespace> get servicemonitor
   ```

3. Reproduce the failure manually against the Prometheus query API to narrow down whether the duplicate series is in `ceph_disk_occupation` itself or in the join target (`node_disk_*` series):

   ```bash
   kubectl -n <monitor-namespace> port-forward svc/prometheus 9090:9090
   # In another shell:
   curl -sG 'http://localhost:9090/api/v1/query' \
     --data-urlencode 'query=count by (ceph_daemon, device, namespace) (ceph_disk_occupation{job="rook-ceph-mgr"})' \
     | head -n 50
   ```

   A count greater than one for any `(ceph_daemon, device, namespace)` tuple confirms the label set is not unique enough for the unpatched rule.

4. After upgrading the operator, verify that the rule evaluation errors have stopped by querying the `prometheus_rule_evaluation_failures_total` counter:

   ```bash
   curl -sG 'http://localhost:9090/api/v1/query' \
     --data-urlencode 'query=increase(prometheus_rule_evaluation_failures_total{rule_group=~".*ceph.*"}[10m])'
   ```

   A stable zero confirms the fix. The `PrometheusRuleFailures` alert should self-clear after its evaluation interval.
</content>
</invoke>