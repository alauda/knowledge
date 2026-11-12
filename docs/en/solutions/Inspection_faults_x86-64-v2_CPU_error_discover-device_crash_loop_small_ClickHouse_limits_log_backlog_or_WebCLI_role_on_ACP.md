---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
  - 4.2.x
  - 4.3.x
---

# Inspection faults: x86-64-v2 CPU error, discover-device crash loop, small ClickHouse limits, log backlog, or WebCLI role on ACP

## Issue

A cluster inspection (for example the inspection taken before an upgrade) reports a component as abnormal, and the finding is a real fault rather than a false positive. One of these is on the report or in the pod log:

- `olm-registry-platform` crashes with `Fatal glibc error: CPU does not support x86-64-v2`.
- Pods named `discover-device` in `nativestor-system` are in `CrashLoopBackOff` with very high restart counts.
- ClickHouse CPU on the global or a region cluster is above the 80% inspection threshold, and the log storage plugin is abnormal.
- Log search in the console returns nothing, while many business clusters write their logs into the global log storage.
- A custom platform-inspector role can do anything in WebCLI, including node login, after an upgrade from 3.16.

For monitoring rows (a second Prometheus, a missing `vmagent-agent`, an OOMKilled `vmalert`, or a Prometheus stuck in `Init`), see [Monitoring faults: a second Prometheus, missing vmagent-agent, vmalert OOMKilled, or Prometheus stuck in Init on ACP](./Monitoring_faults_a_second_Prometheus_missing_vmagent-agent_vmalert_OOMKilled_or_Prometheus_stuck_in_Init_on_ACP.md).

## Root Cause

### Cause 1: Fatal glibc error: CPU does not support x86-64-v2

`olm-registry-platform` exits as soon as it starts, with `Fatal glibc error: CPU does not support x86-64-v2`. `/proc/cpuinfo` on that virtual machine has `sse4_2` but not `popcnt`. The image requires the x86-64-v2 instruction set level, so the guest CPU model must expose `popcnt` inside the VM. This appeared in a 4.2 inspection taken before a move to 4.3.

### Cause 2: discover-device in nativestor-system is in CrashLoopBackOff and TopoLVM is not in use

`discover-device` pods in `nativestor-system` are `CrashLoopBackOff` with restart counts in the tens of thousands. The workload is the device discovery used by TopoLVM local storage. On a cluster that does not use local storage, the DaemonSet has nothing to do and can be deleted. When TopoLVM volumes are in use, keep it; the crash then needs a storage investigation, not a delete.

### Cause 3: ClickHouse is still at 2 CPU and 4Gi while the log storage plugin is abnormal

The inspection says ClickHouse CPU on the global cluster and on a region cluster is above 80%, and the log storage plugin Alauda Container Platform Log Storage for ClickHouse is abnormal. The live limits of that ClickHouse are 2 CPU and 4Gi, which is too small for its load. The fix that matches this saturation is 4 CPU and 8Gi for both requests and limits.

When `chi-cpaas-clickhouse` is close to 100% CPU and memory and several pods on that cluster are failing, adding resources to the cluster hosts resolves the pod errors. etcd leader changes and controller restarts flagged in the same report can be ignored once a current check shows that etcd no longer changes leader.

### Cause 4: The platform cannot query logs because the global log Kafka is behind the business clusters

Log search in the console returns nothing. Many business clusters write their logs into the global log storage at the same time. The global log storage consumes more slowly than the writers produce, so records pile up in the global log Kafka. After the backlog drains, log search works again. Kafka pod memory above 80% also appears on inspections by itself. The user-visible fault here is the lag, not the memory.

### Cause 5: A custom platform-inspector role can operate WebCLI because its YAML contains acp-podsexec and acp-rootexec

A role cloned from the platform auditor before an upgrade from 3.16 can suddenly use WebCLI for full operations, including node login. On 4.2, the built-in platform auditor has query-only WebCLI: no create, no delete, and no direct node login. The custom role YAML contains `acp-podsexec` and `acp-rootexec`. Removing those two entries, and leaving `get`, `list` and `watch`, restores query-only access.

## Resolution

### Cause 1: Fatal glibc error: CPU does not support x86-64-v2

1. Confirm the error:

   ```bash
   kubectl get pods -A -o wide | grep olm-registry-platform
   kubectl logs -n <namespace> <olm-registry-platform-pod> --tail=30 | grep x86-64-v2
   ```

2. On the virtual machine that runs the pod (a host shell, or `kubectl debug` on that node), check the CPU flags:

   ```bash
   grep -m1 -o -w -E 'popcnt|sse4_2' /proc/cpuinfo || true
   grep -c popcnt /proc/cpuinfo
   ```

   `sse4_2` without `popcnt` matches this cause.

3. Change the guest CPU model.

   > **Warning:** Changing the guest CPU model usually needs a VM power cycle, which stops every pod on that node. Precondition: the node is cordoned and drained (`kubectl cordon <node>` and `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`). Rollback: set the previous CPU model and power-cycle again.

   In the hypervisor, set a guest CPU model that exposes x86-64-v2, including `popcnt`. Power the VM off and on if the hypervisor applies the model only at boot. No image tag or Kubernetes flag bypasses this check.

4. After boot, run `kubectl uncordon <node>`. `grep popcnt /proc/cpuinfo` should print a match, and `olm-registry-platform` should stay up.

### Cause 2: discover-device in nativestor-system is in CrashLoopBackOff and TopoLVM is not in use

1. Confirm that the cluster has no TopoLVM volumes:

   ```bash
   kubectl -n nativestor-system get ds,pods | grep discover-device
   kubectl get sc
   kubectl get pvc -A | grep -i topolvm || true
   ```

2. Delete the DaemonSet.

   > **Warning:** Deleting the `discover-device` DaemonSet stops TopoLVM device discovery on every node. Precondition: the checks above show no TopoLVM volumes, nobody expects `nativestor` devices, and the DaemonSet YAML is saved. Skip this step when any PVC is TopoLVM-backed. Rollback: `kubectl apply -f /tmp/discover-device.before.yaml`, or reinstall the TopoLVM plugin if that YAML is incomplete.

   ```bash
   kubectl -n nativestor-system get ds discover-device -o yaml > /tmp/discover-device.before.yaml
   kubectl -n nativestor-system delete ds discover-device
   ```

### Cause 3: ClickHouse is still at 2 CPU and 4Gi while the log storage plugin is abnormal

1. Read the live requests and limits:

   ```bash
   kubectl -n cpaas-system get pods | grep -i clickhouse
   kubectl -n cpaas-system get pod <ck-pod> -o jsonpath='{range .spec.containers[*]}{.name}{" req="}{.resources.requests.cpu}{"/"}{.resources.requests.memory}{" lim="}{.resources.limits.cpu}{"/"}{.resources.limits.memory}{"\n"}{end}'
   ```

2. Raise the resources on the plugin.

   > **Warning:** Raising the limits restarts the ClickHouse pods, and log search and ingestion pause until they are Ready. Precondition: the live limits are 2 CPU and 4Gi, the log storage plugin is the abnormal one, and the nodes have the extra CPU and memory. Rollback: set the requests and limits back to 2 CPU and 4Gi on the plugin.

   In the console, open Alauda Container Platform Log Storage for ClickHouse, set CPU to 4 and memory to 8Gi for both requests and limits, and save.

3. After the pods are Ready, watch the utilization and the plugin status. If the pods keep the old values, see [nevermore and ClickHouse log components alert on CPU or memory, restart, or ignore new resource values on ACP](./nevermore_and_ClickHouse_log_components_alert_on_CPU_or_memory_restart_or_ignore_new_resource_values_on_ACP.md).

### Cause 4: The platform cannot query logs because the global log Kafka is behind the business clusters

1. Confirm that the global log Kafka is lagging. Read the consumer group lag on the Grafana Kafka dashboards, or describe the groups inside `cpaas-kafka-0` with the listener and client properties that this cluster's brokers expose:

   ```bash
   kubectl -n cpaas-system exec cpaas-kafka-0 -- \
     kafka-consumer-groups.sh --bootstrap-server <bootstrap> \
     --command-config <client-properties> --describe --all-groups
   ```

2. Let the backlog drain, and check that log search returns current entries once the lag is low. If the lag keeps growing, the consumer side is too slow for the writers. See [Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP](./Log_Kafka_lag_from_Elasticsearch_write_hot_spots_breaker_trips_IK_analyzer_errors_or_too_few_partitions_on_ACP.md). To reduce the load on the global cluster for good, store the business clusters' logs in log storage on those clusters.

### Cause 5: A custom platform-inspector role can operate WebCLI because its YAML contains acp-podsexec and acp-rootexec

1. Export the role and look for the two entries:

   ```bash
   kubectl get <role-kind> <inspector-role> -o yaml > <inspector-role>.yaml
   cp <inspector-role>.yaml <inspector-role>.before.yaml
   grep -n -e acp-podsexec -e acp-rootexec <inspector-role>.yaml
   ```

   Use the object kind that `kubectl get` shows for that role name.

2. Remove the rules or resource names `acp-podsexec` and `acp-rootexec` from `<inspector-role>.yaml`, and keep `get`, `list` and `watch`. The 4.2 platform auditor, which has query verbs only, is the reference.

3. Apply the trimmed role.

   > **Warning:** Applying the trimmed role removes pod exec and node login from everyone bound to it, including any emergency use of that role. Precondition: you saved the previous YAML, and the extra verbs are the WebCLI access you want to remove. Rollback: `kubectl apply -f <inspector-role>.before.yaml`.

   ```bash
   kubectl apply -f <inspector-role>.yaml
   ```

## Diagnostic Steps

1. Check the CPU flags, only on the node that runs `olm-registry-platform`:

   ```bash
   kubectl logs -n <namespace> <olm-registry-platform-pod> --tail=50 | grep x86-64-v2
   grep -c popcnt /proc/cpuinfo
   ```

   The glibc line and a count of 0 are Cause 1.

2. Check `nativestor-system` and the ClickHouse limits:

   ```bash
   kubectl -n nativestor-system get pods
   kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{.metadata.name}{" "}{range .spec.containers[*]}{.name}{"="}{.resources.limits.cpu}{"/"}{.resources.limits.memory}{" "}{end}{"\n"}{end}' | grep -i clickhouse
   ```

   A crash-looping `discover-device` with no TopoLVM volumes is Cause 2. Limits of `2` and `4Gi` with an abnormal log storage plugin are Cause 3.

3. For empty log search, check the global Kafka lag before you treat it as a collector problem (Cause 4). Also check whether `nevermore` is `OOMKilled` (`kubectl get pods -A | grep nevermore`, then `kubectl describe pod` for `Reason: OOMKilled`). That is a collection problem: see [nevermore OOMKilled, cache written to /var/cpaas, or callback-secret mount failure on ACP](./nevermore_OOMKilled_cache_written_to_var_cpaas_or_callback-secret_mount_failure_on_ACP.md).

4. For WebCLI access on a custom inspector, open the role YAML and search for `acp-podsexec` (Cause 5).

## Related Information

- Related articles: [Monitoring faults: a second Prometheus, missing vmagent-agent, vmalert OOMKilled, or Prometheus stuck in Init on ACP](./Monitoring_faults_a_second_Prometheus_missing_vmagent-agent_vmalert_OOMKilled_or_Prometheus_stuck_in_Init_on_ACP.md) covers the monitoring rows of the same inspection.
- [Logging ClickHouse runs out of disk, CPU or memory, or is OOMKilled on ACP](./Logging_ClickHouse_runs_out_of_disk_CPU_or_memory_or_is_OOMKilled_on_ACP.md)
