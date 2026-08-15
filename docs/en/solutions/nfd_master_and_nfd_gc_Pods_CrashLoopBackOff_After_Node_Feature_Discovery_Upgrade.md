---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# nfd-master and nfd-gc Pods CrashLoopBackOff After Node Feature Discovery Upgrade
## Issue

After upgrading both the cluster and the Node Feature Discovery operator, the operator-managed pods in the NFD namespace fail to stabilise. The garbage-collector pod loops in `CrashLoopBackOff` and the master pod stays in `Running` but its readiness probe keeps failing:

```text
$ kubectl -n cpaas-system get pods | egrep "nfd-master|nfd-gc"
nfd-gc-68fd949d8f-krsrw      0/1   CrashLoopBackOff   11   23m
nfd-master-5bd5f86f69-w65cb  0/1   Running            10   50m
```

The pod events show liveness or startup probes timing out against the in-pod health endpoint:

```text
Warning  ProbeError  pod/nfd-gc-68fd949d8f-89t8l
  Liveness probe error: Get "http://10.x.x.x:8080/healthz":
  dial tcp 10.x.x.x:8080: connect: connection refused

Warning  Unhealthy   pod/nfd-master-5bd5f86f69-qvrvl
  Startup probe failed: Get "http://10.x.x.x:8080/healthz":
  dial tcp 10.x.x.x:8080: connect: connection refused
```

## Root Cause

The Node Feature Discovery operator does not select a default operand image at every reconcile. The `NodeFeatureDiscovery` custom resource carries an explicit `spec.operand.image` reference, and the operator obeys that field literally — it does not silently bump it forward when the cluster or the operator itself is upgraded.

When the platform is upgraded but `spec.operand.image` is left pointing at the previous y-stream, the controller deploys a pod whose binary expects an older API surface than the operator now serves. The Deployment is admitted (the image still pulls), the pod starts (the binary still launches), but health endpoints either bind to the wrong port or expose schemas the new operator does not accept, so the probes fail and the pods loop.

A symptomatic check is to compare the image tag inside the CR against the current platform y-stream:

```bash
kubectl get clusterversion
kubectl -n cpaas-system get nodefeaturediscovery nfd-instance \
  -o jsonpath='{.spec.operand.image}'
```

If the image tag carries an older version suffix than the platform y-stream, the deployment is on stale operand images.

## Resolution

Pin `spec.operand.image` to the y-stream the operator now serves. The image used by the daemons must come from the same operator distribution that owns the `NodeFeatureDiscovery` CRD; do not point it at an arbitrary upstream tag.

1. Identify the platform y-stream:

   ```bash
   kubectl get clusterversion -o jsonpath='{.items[0].status.desired.version}'
   ```

2. Edit the `NodeFeatureDiscovery` CR and overwrite `spec.operand.image` with the corresponding tag from the same operator catalog:

   ```bash
   kubectl -n cpaas-system edit nodefeaturediscovery nfd-instance
   ```

   The relevant block:

   ```yaml
   spec:
     operand:
       image: <operator-registry>/<nfd-image>:v<major>.<minor>
       imagePullPolicy: IfNotPresent
       servicePort: 12000
   ```

   Use the image reference documented for the operator version that is currently installed; the operator subscription page lists the matching operand tag.

3. Watch the pods cycle:

   ```bash
   kubectl -n cpaas-system rollout status deploy/nfd-master --timeout=5m
   kubectl -n cpaas-system get pods -l app=nfd
   ```

After the new operand image lands, the readiness and liveness endpoints respond, `nfd-gc` exits `CrashLoopBackOff`, and `nfd-master` reaches `1/1 Ready`.

For a cluster managed by GitOps, store the image reference together with the operator subscription so the two move forward in lockstep at every upgrade — drift between operator and operand is the single most common cause of this fault pattern.

## Diagnostic Steps

Confirm the operator pod itself is healthy before investigating the operand:

```bash
kubectl -n cpaas-system get deploy nfd-controller-manager -o wide
kubectl -n cpaas-system logs deploy/nfd-controller-manager --tail=100
```

If the operator is healthy but the operand is failing, dump the rendered Deployment to see the image actually scheduled:

```bash
kubectl -n cpaas-system get deploy nfd-master -o yaml | grep -A2 image:
kubectl -n cpaas-system get ds nfd-worker -o yaml | grep -A2 image:
```

The image used by these workloads must match the tag in `NodeFeatureDiscovery.spec.operand.image`. If it does not, the controller failed to roll out the new spec — check the operator logs for permission or admission errors.

To validate end-to-end functionality after recovery, verify that node labels are being published:

```bash
kubectl get nodes -o json \
  | jq '.items[].metadata.labels | with_entries(select(.key | startswith("feature.node.kubernetes.io")))'
```

A node with no `feature.node.kubernetes.io/*` labels indicates that even after the pods recover the worker DaemonSet is not communicating with the master — confirm by inspecting `kubectl -n cpaas-system logs ds/nfd-worker` for connection errors back to the master service.
