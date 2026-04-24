---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A compliance scan run by the platform's compliance scanner (the Compliance Service extension on ACP, built on the open-source OpenSCAP / Compliance Operator stack) returns `INCONSISTENT` for one or more node-level scans, even though every node in the pool is the same image and reports the same version. A typical result table:

```text
NAME                       PHASE   RESULT
cis-baseline               DONE    NON-COMPLIANT
cis-baseline-node-master   DONE    NON-COMPLIANT
cis-baseline-node-worker   DONE    INCONSISTENT
```

The cluster in question is one of:

- a single-node cluster, where one node carries both `master` and `worker` roles;
- a three-node compact cluster, where each node carries both roles;
- a larger cluster where `mastersSchedulable: true` was set so the control-plane nodes also accept regular workload pods.

The `INCONSISTENT` verdict is not a real compliance finding; it is the scanner saying it cannot agree with itself on what a "worker" node looks like, because some of the nodes it scanned as workers are also masters and were scanned a second time under that role.

## Root Cause

The compliance scanner groups its findings by **node role label** and expects the per-role scan to converge to a single result. Each node carrying a given role is scanned once for that role, and the per-role result is the merge of all individual node outcomes.

When a node carries *both* `node-role.kubernetes.io/master` *and* `node-role.kubernetes.io/worker`, it is scanned twice — once as a master, once as a worker — against rule sets that have intentionally different expectations:

- the `master` profile checks settings on control-plane components (kube-apiserver flags, etcd permissions, scheduler configuration);
- the `worker` profile checks the kubelet-side surface and is expected to *not* find control-plane processes.

A node where the apiserver runs is therefore *both* compliant against the master profile and "non-compliant" against the worker profile (because there is a control-plane process where there should not be one). Two simultaneous, contradictory verdicts on the same node produces `INCONSISTENT` at the per-role rollup.

For SNO and three-node compact clusters this has been smoothed over in newer scanner releases (the compact-cluster topology is recognised and a single role is selected). It is *not* fixed for the general case where masters are made schedulable on a larger cluster, where the scanner cannot infer intent from the topology alone.

## Resolution

Use a **role alias** for the worker pool that is distinct from the actual `worker` label, and bind the scan to the alias. Nodes that should be scanned as workers carry the alias; control-plane nodes continue to carry only `master`. The scanner then groups nodes correctly and the inconsistent verdict goes away.

The change is purely scanner-side; nothing about scheduling, taints, or workload placement changes.

### 1. Decide the alias and label the worker pool

Pick a label that is unambiguously a scan grouping label, not a scheduling label. `compliance-worker` is a good choice — it does not collide with any standard role and it is obvious to a future operator what it is for.

```bash
# Apply to every node that should be scanned as a worker.
# Control-plane nodes get NO alias.
for n in <worker-1> <worker-2> <worker-3>; do
  kubectl label node "$n" node-role.kubernetes.io/compliance-worker=
done

kubectl get nodes \
  -L node-role.kubernetes.io/master \
  -L node-role.kubernetes.io/worker \
  -L node-role.kubernetes.io/compliance-worker
```

The expected result on a cluster with schedulable masters:

```text
NAME       STATUS   ROLES                                        ...
cp-1       Ready    control-plane,master,worker                  ...
cp-2       Ready    control-plane,master,worker                  ...
cp-3       Ready    control-plane,master,worker                  ...
w-1        Ready    compliance-worker,worker                     ...
w-2        Ready    compliance-worker,worker                     ...
w-3        Ready    compliance-worker,worker                     ...
```

### 2. Create a ScanSetting that targets the alias instead of `worker`

The `ScanSetting` is the scheduler / tolerations / role list for a recurring scan. Replace `worker` with the alias `compliance-worker`. Keep `master` so the control-plane scan still runs.

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSetting
metadata:
  name: schedulable-masters
  namespace: compliance
roles:
  - master
  - compliance-worker
scanTolerations:
  - operator: Exists
schedule: "0 1 * * *"
showNotApplicable: false
strictNodeScan: true
```

Apply it:

```bash
kubectl apply -f scansetting-schedulable-masters.yaml
```

### 3. Bind the CIS (or other) profile to the new ScanSetting

`ScanSettingBinding` ties a profile (CIS, NIST, custom) to the ScanSetting that runs it. Point the binding at the new `schedulable-masters` ScanSetting:

```yaml
apiVersion: compliance.alauda.io/v1alpha1
kind: ScanSettingBinding
metadata:
  name: cis
  namespace: compliance
profiles:
  - name: cis
    kind: Profile
    apiGroup: compliance.alauda.io/v1alpha1
  - name: cis-node
    kind: Profile
    apiGroup: compliance.alauda.io/v1alpha1
settingsRef:
  name: schedulable-masters
  kind: ScanSetting
  apiGroup: compliance.alauda.io/v1alpha1
```

Apply it and let the scanner reconcile. The next scheduled scan (or a manual rerun) produces three converging per-role results, no `INCONSISTENT`:

```text
NAME                                 PHASE   RESULT
cis                                  DONE    NON-COMPLIANT
cis-node-master                      DONE    NON-COMPLIANT
cis-node-compliance-worker           DONE    NON-COMPLIANT
```

### 4. Keep the alias scoped to the scanner

Two follow-ups to keep this clean:

- the alias label should not be referenced by any workload `nodeSelector` — it exists only for the scanner;
- when adding new worker nodes, label them at the same time as `worker` so the alias and the role stay in sync. A worker without the alias will simply not be scanned.

Master scheduling itself is unaffected — `mastersSchedulable: true` continues to do what it did, and pods that previously landed on control-plane nodes still land there.

## Diagnostic Steps

Confirm the inconsistency is the schedulable-master root cause and not a real finding mismatch:

```bash
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.labels}{"\n"}{end}' \
  | grep -E 'master.*worker|worker.*master'
```

If this returns any nodes, the topology *is* scanning each node twice and the workaround applies. If the list is empty, the `INCONSISTENT` verdict is something else (a real result divergence between two genuine workers — investigate the per-node scan logs).

Look at the per-node result objects to see *which* nodes disagreed:

```bash
kubectl -n compliance get compliancecheckresult \
  -l compliance.alauda.io/scan-name=cis-node-worker \
  -o custom-columns='RESULT:.status,RULE:.metadata.labels."compliance.alauda.io/check-id",NODE:.metadata.labels."compliance.alauda.io/host"'
```

Also useful: confirm `mastersSchedulable` is in fact set, since this is often the trigger for the issue showing up after a previously well-behaved cluster is reconfigured:

```bash
kubectl get scheduler cluster -o yaml | grep mastersSchedulable
```

Re-run the scan after the alias is in place and confirm the scan name resolves to the alias instead of `worker`:

```bash
kubectl -n compliance get compliancescan
```

A name like `cis-node-compliance-worker` (instead of `cis-node-worker`) confirms the binding is using the new ScanSetting.
