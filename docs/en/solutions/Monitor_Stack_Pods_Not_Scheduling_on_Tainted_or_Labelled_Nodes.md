---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Pods in the cluster monitor stack (Prometheus, Alertmanager, Thanos Querier, Prometheus Operator, and so on) remain in `Pending`. The scheduler events report node-affinity or untolerated-taint failures that look like:

```text
Warning FailedScheduling pod/thanos-querier-xxxxxxxx-xxxxx
  0/X nodes are available: Y node(s) didn't match Pod's node affinity/selector,
  3 node(s) had untolerated taint {node-role.kubernetes.io/master:},
  Z node(s) had untolerated taint {node.storage.example.com/storage: true}.
  preemption: 0/X nodes are available: X Preemption is not helpful for scheduling.
```

```text
Warning FailedScheduling pod/prometheus-operator-xxxxxxxx-xxxxx
  0/X nodes are available: Y node(s) didn't match Pod's node affinity/selector,
  3 node(s) had untolerated taint {node-role.kubernetes.io/master:}.
  preemption: 0/X nodes are available: X Preemption is not helpful for scheduling.
```

Listing the namespace confirms the stuck pods:

```bash
kubectl -n cpaas-system get pods -o wide | grep Pending
```

## Root Cause

The monitor stack is trying to land on a dedicated pool of nodes (typically an "infra" role), but the `nodeSelector` or `tolerations` configured for its pods do not line up with what is actually on the nodes. Two flavours of mismatch show up:

- The `nodeSelector` value in the monitor configuration points at a label that no node actually carries (or whose key/value differs — `my-prom-node=yes` vs `my-prom-node: "true"`).
- The `tolerations` block leaves out one of the fields of the node taint. Taints match on `key + value + effect`; a toleration that only sets `key` and `effect` will **not** tolerate a taint that also carries `value: "true"`.

## Resolution

Adjust the monitor-stack configuration so `nodeSelector` matches a label that the target nodes carry, and `tolerations` match every field of every taint on those nodes. Exact entry points depend on how the monitor stack is configured in the platform — typically a ConfigMap such as `cluster-monitoring-config` in the monitor namespace, which is consumed by the Prometheus Operator and fans out to the child CRs.

Example configuration fragment that moves core monitor workloads onto infra-labelled nodes that also carry an infra taint:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: cluster-monitoring-config
  namespace: cpaas-system
data:
  config.yaml: |
    prometheusK8s:
      nodeSelector:
        node-role.kubernetes.io/infra: ""
      tolerations:
        - key: node-role.kubernetes.io/infra
          operator: Equal
          value: "true"
          effect: NoSchedule
    alertmanagerMain:
      nodeSelector:
        node-role.kubernetes.io/infra: ""
      tolerations:
        - key: node-role.kubernetes.io/infra
          operator: Equal
          value: "true"
          effect: NoSchedule
    thanosQuerier:
      nodeSelector:
        node-role.kubernetes.io/infra: ""
      tolerations:
        - key: node-role.kubernetes.io/infra
          operator: Equal
          value: "true"
          effect: NoSchedule
```

The key rules:

1. **Label a sufficient number of nodes.** A single labelled node is rarely enough — Prometheus alone runs two replicas with anti-affinity and cannot co-locate them. Label at least as many nodes as the component has replicas.

   ```bash
   kubectl label node <node-name> node-role.kubernetes.io/infra=""
   ```

2. **Match taints exactly.** If the node carries a taint with `value: "true"`, the toleration must include `operator: Equal` and `value: "true"` — or `operator: Exists`, which ignores value. Missing `value` is the single most common failure and matches the symptom in the events above.

3. **Check every taint the nodes actually have.** Nodes can (and often do) have multiple taints — the control-plane role, a storage-node taint, a dedicated-workload taint. The pod needs a toleration for *each* one unless it is supposed to stay off those nodes.

Save the config and let the Prometheus Operator reconcile it. The `Pending` pods should be evicted and rescheduled onto the newly matching nodes within a minute or two.

## Diagnostic Steps

Verify the labels actually present on the candidate nodes and that the selector points at the same key/value:

```bash
kubectl get nodes --show-labels | grep infra
kubectl get configmap cluster-monitoring-config -n cpaas-system -o yaml \
  | grep -A2 nodeSelector
```

Verify the taints on those nodes:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.taints}{"\n"}{end}'
```

Compare each taint triple (`key`, `value`, `effect`) against the tolerations in the monitor config. Any field present on the taint but absent on the toleration is a mismatch.

If the pod stays `Pending` after the config is applied, describe the pod to see which of the three conditions still fails:

```bash
kubectl -n cpaas-system describe pod <pending-pod>
```

The `Events` section reports precisely which taints went untolerated or which node-affinity predicates failed. Use that text to drive the next edit — for example, a `NoExecute` taint the config only tolerates for `NoSchedule`, or a typo in the selector key.
