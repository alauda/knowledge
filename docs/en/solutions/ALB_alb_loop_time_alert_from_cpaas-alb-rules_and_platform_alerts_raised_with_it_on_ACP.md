---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.1.x
  - 4.3.x
---

# ALB alb_loop_time alert from cpaas-alb-rules and platform alerts raised with it on ACP

## Issue

The real-time alert page shows policy `cpaas-alb-rules` with `alb_loop_time` above 1000 ms (`alb_loop_time超过1000.00ms`), for example a trigger value of `5534.00`, often recovering by itself. A general request to troubleshoot the platform alerts (`告警问题排查处理`) frequently bundles it with other alerts from the same period: the ALB `error-rate` alert, compute component restarts, compute component CPU above 90%, Elasticsearch disk usage above 70%, and node disk usage. In one such set, Elasticsearch disk usage was above 70% on only one `global` node while the others stayed low.

Related article: [ALB error-rate alert on a route or Ingress from cpaas-alb-router-rules on ACP](ALB_error-rate_alert_on_a_route_or_Ingress_from_cpaas-alb-router-rules_on_ACP.md).

## Root Cause

### Cause 1: alb_loop_time is the duration of one ALB control-plane loop

`alb_loop_time` measures one loop of the ALB control plane, not business request latency. A loop fetches resources, generates the NGINX configuration, reloads it (including writing `nginx.conf` to disk) and updates rule status. A loop longer than 1 second is typically caused by a slow kube-apiserver request; slow disk on the node can also stretch the reload step. The alert is warning level (`alb_loop_time > 1000ms` for 30 seconds). A spike can occur on a node with very low CPU, memory and load, and the specific cause of a single spike is not always identifiable afterwards, especially when the ALB logs of that window were not kept.

A single alert row that recovered within about 30 seconds after it appeared, with users able to reach the service and no ALB Pod restart, can be recorded and ignored. A row that stays up for minutes is not covered by that rule.

### Cause 2: Elasticsearch disk usage above 70% on one global node because a disk is mounted on the wrong path

Only one `global` node reports high Elasticsearch disk usage, and the other Elasticsearch nodes are low. On that global master node a disk is mounted on the wrong path, which makes its usage uneven with the other nodes. This is not an ALB fault, and no ALB change fixes it.

## Resolution

### Cause 1: alb_loop_time is the duration of one ALB control-plane loop

1. Read the alert value and how long the row stayed, and check the ALB Pods and their node:

   ```bash
   kubectl get pods -n cpaas-system -o wide | grep -E 'alb2|alb'
   ```

2. If the row fired once, recovered within about 30 seconds, users were not blocked and the ALB Pods did not restart, record it and leave the policy. The "about 30 seconds" is how fast the row cleared, not the `for 30 seconds` clause of the rule.

3. If it repeats or stays up, save the `alb2` container log of every replica before the Pods roll, and check the API server latency and the disk latency of the node in the same window:

   ```bash
   kubectl logs -n cpaas-system <alb-pod> -c alb2 --since=1h > /tmp/<alb-pod>-alb2.log
   ```

Do not delete the ALB Pod to clear a single short spike.

### Cause 2: Elasticsearch disk usage above 70% on one global node because a disk is mounted on the wrong path

1. Locate the Elasticsearch Pods and their nodes, then compare the block devices and filesystems on each node:

   ```bash
   kubectl get pods -A -o wide | grep -i elas
   lsblk
   df -Th | less
   ```

   On the high node, `lsblk` and `df -Th` show the data disk mounted on a different path from the other nodes.

2. Migrate the data and remount the disk on the correct path in a maintenance window.

   > **Warning:** Data on that path is unavailable during the move, and a mistake in the copy or the mount can lose it. Precondition: one node is high, the others are low, `lsblk` and `df -Th` show the wrong mount, a verified copy of the data exists, and `/etc/fstab` is saved. Rollback: restore the saved `/etc/fstab` entry, remount, and copy the data back; data removed without a copy cannot be recovered.

3. Afterwards `df -Th` on that node shows the disk on the correct path, and Elasticsearch usage is in line with the other nodes.

## Diagnostic Steps

1. Read the policy name. `cpaas-alb-rules` and `alb_loop_time` are Cause 1. `cpaas-alb-router-rules` and `error-rate` are the related article.

2. One firing that recovered within about 30 seconds, no user-facing failure, ALB Pods with no new restarts: record and leave the warning.

3. When several platform alerts arrive together, handle each separately:
   - ALB `error-rate`: the 4xx/5xx ratio of ALB requests over the last 5 minutes passed the threshold, typically a backend that was stopped while its rule still received requests, or a backend that returns 4xx/5xx itself. Check the ALB and backend logs; see the related article.
   - `alb_loop_time > 1000ms`: Cause 1.
   - Compute component restarts: read the Pod events and the previous container log for the last restart reason, such as OOM:

     ```bash
     kubectl describe pod -n <namespace> <pod> | grep -A5 'Last State'
     kubectl logs -n <namespace> <pod> --previous --tail=100
     ```

     If both are normal, the alert can be ignored.
   - Compute component CPU above 90%: raise the CPU limit of that StatefulSet or Deployment, for example to double its current value. Changing the limit restarts its Pods; keep the previous value to roll back.
   - Elasticsearch disk above 70% on every node: check and expand the disks. On only one node: Cause 2.
   - Node disk usage: on the node, find the full filesystem with `df -Th`, and clean it up or expand it.
