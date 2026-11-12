---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Console menu bar or Data Services navigation does not load because of a workload cluster ALB or a credential on ACP

## Issue

The console opens, but part of it does not load:

- The left menu bar of platform management stays on a loading placeholder. In the browser developer tools (**Network**), only the `global-info` request stays pending.
- After middleware operators were installed, the **Data Services** left navigation shows no middleware, and the `console-plugins` response contains only `global` data.
- Platform pages freeze and only part of the interface loads.

Related article: [Console menu or feature is missing because a feature gate, plugin, or product entry is off on ACP](Console_menu_or_feature_is_missing_because_a_feature_gate_plugin_or_product_entry_is_off_on_ACP.md).

## Root Cause

### Cause 1: the menu bar waits on a workload cluster whose ALB failed because a node disk is full

`marketplace-api` on the `global` cluster collects console plugins from every cluster through that cluster's ALB, and repeats for the affected workload clusters:

```text
consoleplugins.go:64] collect console-plugins in cluster <cluster> failed. err: invalid status code: 502. response status: 502 Bad Gateway, response body: X-Error: 502
```

The global `apollo` log shows cluster cache errors such as `List log-agent feature error(... Client.Timeout exceeded while awaiting headers)` and `Get monitoring feature error(... context deadline exceeded)`. On the affected workload cluster, the `cpaas-system-*` ALB Pods are `0/2` in `Error` or `Pending`, because node storage ran out. The frontend Pods there are `Running`, and restarting `apollo` and `marketplace-api` does not help.

### Cause 2: the workload cluster ALB runs in container mode and its LoadBalancer Service stays pending

The same `collect console-plugins ... 502` line appears, but the ALB Pods on the workload cluster are `Running`. `kubectl get alb2 -A` shows `cpaas-system` with STATE `Progressing`, REASON `wait lb svc ready`, MODE `container`, and the `LoadBalancer` Service `cpaas-system-lb-<suffix>` (ports `11782` and `11780`) has EXTERNAL-IP `<pending>`. This was seen on 4.2.1 on a workload cluster deployed with the cluster-api-provider-hcs procedure, which has no ALB option: the ALB chart set container network mode, which gets no external address there.

### Cause 3: an expired GitLab model repository token freezes the pages

Platform pages freeze and only part of the UI loads when the token for the GitLab model repository has expired. The token is stored in the Secret `aml-image-builder-secret` in the namespace `kubeflow-admin-cpaas-io`.

## Resolution

### Cause 1: the menu bar waits on a workload cluster whose ALB failed because a node disk is full

1. Find the workload cluster and its ALB state:

   ```bash
   # global cluster
   kubectl logs -n cpaas-system deploy/marketplace-api --tail=200 | grep 'collect console-plugins'
   # affected workload cluster
   kubectl get po -n cpaas-system -o wide | grep cpaas-system-
   kubectl describe pod -n cpaas-system <alb-pod> | sed -n '/Events/,$p'
   ```

2. On the node where the ALB Pods are `Error` or `Pending`, check the disk and free space:

   ```bash
   df -h
   ```

   > **Warning:** Deleting files is irreversible; copy anything you still need first, and leave live etcd data and container runtime storage in place. Do this only when `global-info` stays pending, `marketplace-api` logs 502 toward that cluster, and the node filesystem is full.

3. Once the ALB Pods are `2/2 Running`, reload the console. The menu bar loads when `global-info` completes and `marketplace-api` stops logging 502 for that cluster.

### Cause 2: the workload cluster ALB runs in container mode and its LoadBalancer Service stays pending

1. On the workload cluster:

   ```bash
   kubectl get alb2 -A
   kubectl get svc -n cpaas-system | grep LoadBalancer
   kubectl get nodes -l cpaas-system-alb
   ```

2. Switch the ALB to host network mode.

   > **Warning:** In host network mode the ALB Pods run on the host network of the nodes labelled `cpaas-system-alb`, and their ports must be free there. Traffic through this ALB is interrupted while the Pods roll. Do this only when the ALB2 is `Progressing` with `wait lb svc ready`, mode `container`, and the LoadBalancer Service has no external IP. Export the object first; applying the export is the rollback.

   ```bash
   kubectl get alb2 -n cpaas-system cpaas-system -o yaml > "$HOME/alb2-cpaas-system.yaml"
   kubectl explain alb2.spec --recursive | grep -iE 'networkMode|nodeSelector'
   kubectl edit alb2 -n cpaas-system cpaas-system
   ```

   Set `networkMode: host` and the node selector `cpaas-system-alb: ""` at the paths that `kubectl explain` shows.

3. Make it permanent: on the `global` cluster, add an override to the workload cluster's ALB `minfo`:

   ```bash
   kubectl get minfo | grep -i alb | grep <workload-cluster>
   kubectl edit minfo <alb-minfo-of-workload-cluster>
   ```

   ```yaml
   spec:
     valuesOverride:
       _global:
         global:
           cluster:
             type: DCS
   ```

4. The ALB2 reaches a ready state, `marketplace-api` stops logging 502 for that cluster, and **Data Services** lists the middleware.

### Cause 3: an expired GitLab model repository token freezes the pages

1. Back up the Secret:

   ```bash
   kubectl get secret -n kubeflow-admin-cpaas-io aml-image-builder-secret -o yaml > "$HOME/aml-image-builder-secret.yaml"
   chmod 600 "$HOME/aml-image-builder-secret.yaml"
   ```

2. Replace the token value with a current GitLab model repository token. Change only the key that stores the token.

   > **Warning:** The Secret holds a repository credential; keep the backup private. To roll back, apply the backup.

   ```bash
   kubectl edit secret -n kubeflow-admin-cpaas-io aml-image-builder-secret
   ```

3. Reload the platform pages.

## Diagnostic Steps

1. In the browser **Network** panel, check whether `global-info` stays pending (Cause 1) or the `console-plugins` response holds only `global` (Cause 2).

2. On the `global` cluster, read `marketplace-api`. Expected for Causes 1 and 2: `collect console-plugins in cluster <cluster> failed ... 502`.

3. On that workload cluster:

   ```text
   cpaas-system-* ALB Pods 0/2 Error or Pending, node disk full                  -> Cause 1
   alb2 Progressing, wait lb svc ready, MODE container, LB Service EXTERNAL-IP <pending> -> Cause 2
   ```

4. Pages freeze with an incomplete UI and the model repository token has expired: Cause 3.
