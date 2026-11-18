---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
---

# Node zombie process alert keeps switching between firing and resolved on ACP

## Issue

Notifications for the node zombie process alert keep arriving as firing (`告警中`) and then resolved (`已恢复`), again and again, although the zombie process count seems unchanged. The rule is in the `uni-node-rules` alert policy: `节点的僵尸进程数 > 10 且持续 1 分钟` (number of zombie processes on the node > 10 for 1 minute). The chart of the rule in the policy may show `无数据，请确认表达式涉及到的监控指标是否存在` (no data, check whether the metrics in the expression exist), which suggests a monitoring problem. Changing the alert sending interval does not stop the alternation.

Related article: [Alert repeat interval cannot be set to 4 hours, or the global sending interval does not take effect on ACP](Alert_repeat_interval_cannot_be_set_to_4_hours_or_the_global_sending_interval_does_not_take_effect_on_ACP.md).

## Root Cause

### Cause 1: the zombie process count on the node really crosses the threshold back and forth

The rule expression is `node_processes_state{state="Z"}>10`. Zombie processes on the node appear and disappear intermittently, so the count goes above 10 for more than a minute, falls below it, and rises again. Monitoring collects the metric normally, and each crossing correctly produces a firing and then a resolved notification. The "no data" message on the policy chart does not mean that the metric is missing: the same expression returns data in vmui.

## Resolution

### Cause 1: the zombie process count on the node really crosses the threshold back and forth

1. Confirm that the metric is collected and see how it moves. In vmui on that cluster, run the rule expression and the raw series over the last hours:

   ```promql
   node_processes_state{state="Z"} > 10
   node_processes_state{state="Z"}
   ```

   Values above 10 on the node named in the alert (for example 18 or 128), alternating with lower values, confirm this cause.

2. Confirm that the notifications match those crossings. The `courier-api` log in `cpaas-system` records each firing and resolved event of the alert:

   ```bash
   kubectl get pods -n cpaas-system | grep courier-api
   kubectl logs -n cpaas-system <courier-api-pod> --tail 10000 | grep '<node-exporter-pod-or-node-name>'
   ```

   Expected: entries for alert `节点的僵尸进程数` with `alert_resource: uni-node-rules`, `state: "Z"`, a current value such as `"11"`, and `status: "resolved"` alternating with firing entries at the times the notifications arrived.

3. Find out why zombie processes keep appearing on the node. A zombie is a child process that has exited but has not been reaped by its parent; on the node, list them with their parents:

   ```bash
   ps -eo pid,ppid,stat,comm | awk '$3 ~ /^Z/'
   ```

   The parent process (`ppid`) is the one that does not reap its children. Exec probes are a common source; see [Defunct Processes From Exec Probes Driving Worker Node Pressure](Defunct_Processes_From_Exec_Probes_Driving_Worker_Node_Pressure.md). Fix or restart the owning workload.

4. If the alternation is expected for that node and the alert should be quieter, change the rule's trigger condition (operator, value and duration) inside the alert policy, as described in [Create and manage alert policies and notification routing on ACP](Create_and_manage_alert_policies_and_notification_routing_on_ACP.md).

## Diagnostic Steps

1. Run `node_processes_state{state="Z"}` in vmui for the node in the alert. Data present and crossing 10 repeatedly: Cause 1. No data at all in vmui: a collection problem, not this article.

2. Compare the notification times with the `courier-api` log entries for the alert (Resolution step 2). Matching firing/resolved pairs show that the alerting chain works as designed.

3. On the node, count zombies a few times over several minutes:

   ```bash
   for i in 1 2 3 4 5; do ps -eo stat | grep -c '^Z'; sleep 60; done
   ```

   Expected for this cause: counts that move above and below 10.
