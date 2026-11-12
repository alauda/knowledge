---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# OperatorHub instances or pages fail from a broken 11780 VIP mapping or marketplace-apiserver restarts on ACP

## Issue

An instance of an Operator-based tool cannot be created on a workload cluster although the Operator looks healthy, or the OperatorHub page itself cannot be opened. Typical reports:

- GitLab (or Nexus, or another Operator on the same cluster) cannot create an instance. In OperatorHub the creation page shows `Resource is being initialized, please try again later` and stays there.
- The Operator Pods on the workload cluster (for example `gitlab-ce-operator`, `nexus-ce-operator-controller-manager`) are `Running`, the Operator log shows nothing wrong, and its CRDs and resources look normal.
- On the global cluster the OLM-related Pods are all `Running`, but their logs keep reporting that the `console-plugins` of that workload cluster cannot be retrieved, with `502 Bad Gateway`.
- OperatorHub, the cluster plugin pages and the Tekton pages cannot be opened at all, and the marketplace apiserver in the backend has an abnormal status.

## Root Cause

### Cause 1: marketplace-api on global gets 502 from one workload cluster because the 11780 VIP port mapping is broken

The instance form depends on the global cluster reaching the workload cluster. `marketplace-api` on the global cluster calls the workload cluster's VIP on port `11780`, which the workload cluster ALB serves. When the port mapping for `11780` on the workload cluster VIP (on a firewall NAT, load balancer or VIP gateway) is not connected, global cannot reach the workload cluster on that port, and `marketplace-api` logs:

```text
collect console-plugins in cluster <cluster> failed. err: invalid status code: 502. response status: 502 Bad Gateway, response body: X-Error: 502
```

OperatorHub resource initialization then fails, and no instance can be created for any Operator on that cluster. Restoring the `11780` VIP port mapping makes instance creation work again.

### Cause 2: marketplace-apiserver is killed by its liveness probe before its cache loads

Several console pages that depend on the marketplace fail together: OperatorHub, the cluster plugin list, Tekton and others. `marketplace-apiserver` loads a cache of the cluster's CRD and APIService resources at startup. In an environment with a large number of those resources, the load has not finished when the liveness probe starts to count failures, so the container is killed and started again before it can serve. Raising `livenessProbe.initialDelaySeconds` of `marketplace-apiserver` to `180` lets the cache finish loading, and the pages recover.

## Resolution

### Cause 1: marketplace-api on global gets 502 from one workload cluster because the 11780 VIP port mapping is broken

Only when `marketplace-api` (or the OLM Pods) on global log `502` for that one workload cluster, and a connection from the global nodes to the workload VIP on `11780` fails or does not reach the workload ALB.

1. Restore the port mapping of the workload cluster VIP for `11780` on the device that does the mapping, so that it forwards to the workload cluster ALB that serves `11780`. This is usually done by the network team.

   > **Warning:** Changing NAT or load-balancer mappings on a shared device can affect other services that use it. Confirm the backends are the workload cluster ALB nodes for that cluster, save the device configuration, and use a change window agreed with the network owner. To roll back, restore the saved mapping.

2. Verify from more than one global node. The first two commands should connect and get an HTTP response from the ALB instead of a timeout, and the `marketplace-api` log should stop reporting `502` for that cluster:

   ```bash
   nc -vz -w 3 <workload-vip> 11780
   curl -sv --max-time 5 http://<workload-vip>:11780/ -o /dev/null
   kubectl logs -n cpaas-system deploy/marketplace-api --since=10m | grep -E '502|console-plugins'
   ```

3. Create the instance again in OperatorHub.

### Cause 2: marketplace-apiserver is killed by its liveness probe before its cache loads

Only when the `marketplace-apiserver` Pod keeps being restarted by its liveness probe (or never becomes ready) and the cluster holds a large number of CRDs or APIServices. A `502` toward one workload cluster with a healthy `marketplace-apiserver` is Cause 1 instead.

1. Find the workload, save it, and read the current probe delay per container:

   ```bash
   kubectl get deploy -A | grep -i marketplace
   kubectl -n <namespace> get deploy <marketplace-apiserver-deployment> -o yaml > /tmp/marketplace-apiserver.before.yaml
   kubectl -n <namespace> get deploy <marketplace-apiserver-deployment> -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" "}{.livenessProbe.initialDelaySeconds}{"\n"}{end}'
   ```

2. Raise the initial delay to `180` seconds.

   > **Warning:** Changing the probe rolls the `marketplace-apiserver` Pod, so OperatorHub and cluster plugin pages stay unavailable until the new Pod is ready. A longer initial delay also means a hung container is detected later after each start. To roll back, patch `initialDelaySeconds` back to the saved value, or run `kubectl apply -f /tmp/marketplace-apiserver.before.yaml`.

   ```bash
   kubectl -n <namespace> patch deploy <marketplace-apiserver-deployment> -p '{"spec":{"template":{"spec":{"containers":[{"name":"<container>","livenessProbe":{"initialDelaySeconds":180}}]}}}}'
   kubectl -n <namespace> rollout status deploy/<marketplace-apiserver-deployment>
   ```

   If the patch is denied by `vsentry.kb.io` with a message that a `ResourcePatch` was created, the change is applied through the platform's `sentry` component; wait and check the Deployment again instead of patching a second time.

3. Reload OperatorHub, the cluster plugin page and the Tekton pages. This is a temporary change: note it and check the value again after a platform upgrade.

## Diagnostic Steps

1. On the workload cluster, rule out the Operator. Running Pods with a clean log mean the failure is earlier in the path:

   ```bash
   kubectl get pod -A | grep -E 'gitlab-ce-operator|nexus-ce-operator'
   kubectl -n <operator-namespace> logs <operator-pod> --tail=50
   ```

2. On the global cluster, check the marketplace and OLM Pods and look for `502` toward one cluster:

   ```bash
   kubectl get pod -A | grep -E 'market|olm'
   kubectl logs -n cpaas-system deploy/marketplace-api --tail=200 | grep -E '502|console-plugins'
   ```

3. From several global nodes, test the workload cluster VIP on `6443` and `11780`. `6443` answering while `11780` fails points at the `11780` mapping (Cause 1):

   ```bash
   for p in 6443 11780; do nc -vz -w 3 <workload-vip> $p; done
   ```

4. When whole pages fail rather than one instance form, check the `marketplace-apiserver` Pod for liveness-probe restarts and count the API resources it has to load. Restarts with `Liveness probe failed` events in a cluster with many CRDs or APIServices is Cause 2:

   ```bash
   kubectl get pod -A | grep -i marketplace
   kubectl -n <namespace> describe pod <marketplace-apiserver-pod> | grep -iE 'Liveness|Restart Count|Killing'
   kubectl -n <namespace> logs <marketplace-apiserver-pod> --previous --tail=50
   kubectl get crd --no-headers | wc -l
   kubectl get apiservice --no-headers | wc -l
   ```

5. Look-alikes:

   - `11780` accepts connections but the load balancer forwards it to the wrong backends: fix the load-balancer backends; the symptom is the same `502`.
   - `marketplace-api` gets `502` for a cluster whose ALB Pods are not Ready: fix the workload cluster ALB first.
   - Global cannot reach the workload VIP on `6443` either: see [Workload cluster abnormal or monitoring empty in the console because global cannot reach its ports on ACP](Workload_cluster_abnormal_or_monitoring_empty_in_the_console_because_global_cannot_reach_its_ports_on_ACP.md).
