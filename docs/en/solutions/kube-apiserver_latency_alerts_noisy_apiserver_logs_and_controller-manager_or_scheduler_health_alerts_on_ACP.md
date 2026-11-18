---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
  - "4.3"
---

# kube-apiserver latency alerts, noisy apiserver logs, and controller-manager or scheduler health alerts on ACP

## Issue

- Alerts say kube-apiserver write latency is over 0.50 seconds, or the read success rate is under 0.80 or 0.90, while the static Pods are Running. `kubectl` is slow only for some calls, often Pod creates.
- An apiserver error-rate alert arrives, or the apiserver log is full of `invalid bearer token` and OpenAPI download errors such as `v1.enhancement.cluster.alauda.io ... resource not found`, and a control-plane restart is being considered.
- `cluster-enhancer-apiserver` uses a lot of memory and its resources need to change.
- The monitoring page shows kube-controller-manager as down, but `telnet 127.0.0.1 10257` on the node succeeds and the Pod is healthy. On a managed cluster the platform raises `集群内KubeScheduler的健康状态 != 1 且持续 1 分钟` and `集群内ControllerManager的健康状态 != 1 且持续 1 分钟` ("KubeScheduler / ControllerManager health status in the cluster != 1 for 1 minute", policy `cpaas-cluster-rules`), while both Pods are `1/1 Running` with no restarts.
- `kubectl get componentstatuses` shows `controller-manager` and `scheduler` as `Unhealthy`.
- An inspection reports apiserver errors tied to an already-compacted etcd revision and a connection reset.
- The apiserver error-rate alert rises and stays high after worker nodes were removed from the cluster, and the failed requests are mostly `404` on `nodes`.

Check admission webhooks before scaling kube-apiserver or compacting etcd.

## Root Cause

### Cause 1: An admission webhook has no backend (dial tcp <webhook-ip>:443: connect: connection refused)

kube-apiserver logs `dial tcp <webhook-ip>:443: connect: connection refused` while calling a mutating admission webhook (for example `chaosblade-operator-arm64.chaosblade.svc`), and `POST pods` p99 is about 1.25 seconds. The webhook Service still exists, but its Endpoints and EndpointSlice have no addresses: the operator Deployment is `READY 0/0`. The `MutatingWebhookConfiguration` still matches Pod creates with `failurePolicy: Ignore` and `timeoutSeconds: 10`, so each create waits on the dead backend and then continues. Deleting that MutatingWebhookConfiguration stops the alert. The same applies to any webhook configuration whose Service has no endpoints.

### Cause 2: invalid bearer token and v1.enhancement.cluster.alauda.io resource not found

The apiserver log contains, in volume:

- `Unable to authenticate the request` with `err="invalid bearer token"`
- `Unhandled Error` with `loading OpenAPI spec for "v1.enhancement.cluster.alauda.io" failed` and `failed to download v1.enhancement.cluster.alauda.io: resource not found`

The first line comes from the nevermore log agent; platform components call kube-apiserver with tokens and other methods, so these lines can appear while the platform works normally. The second comes from `cluster-enhancer-apiserver`. While kube-apiserver serves normally, these lines do not affect nevermore, `cluster-enhancer-apiserver`, or kube-apiserver and can be ignored. Expanding the audit policy to identify the client is not needed when node time is consistent across clusters and the platform works.

The ignore conclusion covers the OpenAPI line only while the aggregated API behind it is up: APIService `v1.enhancement.cluster.alauda.io` reports `Available=True` and its Service has Ready endpoints. When the APIService reports `Available=False` (for example `MissingEndpoints` or `FailedDiscoveryCheck`), requests to that API group fail, and the line is a symptom of the missing backend, for example because the backend Pods have no node left to run on.

### Cause 3: cluster-enhancer-apiserver memory is high and a resource change needs a restart

`cluster-enhancer-apiserver` serves the `EtcdBackupConfiguration` API, certificate monitoring, etcd backup storage, and Prometheus metrics for that API. `cluster-enhancer-controller` cleans expired cert-manager certificates, monitoring dashboard configuration, and event records. Restarting `cluster-enhancer-apiserver` for a resource change does not affect workloads that are already running.

### Cause 4: kube-controller-manager or kube-scheduler listens only on 127.0.0.1

Monitoring probes kube-controller-manager on `<node-ip>:10257` (and kube-scheduler on `<node-ip>:10259`), but the process listens only on `127.0.0.1`, or a firewall change blocks the node address:

- Firewall: `telnet 127.0.0.1 10257` connects and `telnet <node-ip> 10257` is refused because the planned iptables forwarding rules were applied incorrectly. The fix restores the rules as planned and aligns the Prometheus Service, ServiceMonitor, and target port with the port that answers.
- Bind address: `netstat -lntp` shows kube-controller-manager on `127.0.0.1:10257` and kube-scheduler on `127.0.0.1:10259`. Forwarding cannot make `<node-ip>:10257` connect until the bind address changes. A burst of `pods is forbidden: User "system:kube-scheduler" cannot list resource "pods"` lines before `successfully acquired lease kube-system/kube-scheduler` in the scheduler log is not the cause. Scheduling and control are not affected.

### Cause 5: kubectl get componentstatuses shows controller-manager and scheduler Unhealthy

`kubectl get componentstatuses` prints `controller-manager` and `scheduler` as `Unhealthy` with `dial tcp 127.0.0.1:10257: connect: connection refused` (and the same for `127.0.0.1:10259`), warns that `v1 ComponentStatus` is deprecated in v1.19+, and shows `etcd-0` `Healthy`. This deprecated probe output has no impact on the service and needs no remediation.

### Cause 6: apiserver errors from an already-compacted revision, with no leader change

The requested historical revision was already removed by etcd auto-compaction, and the connection was reset. etcd has not restarted and is not changing leader. These errors have no impact and can be ignored. A cluster that also logs `leader changed` is not covered by this conclusion.

### Cause 7: removed worker machines are still running and keep requesting their deleted Node objects

Worker nodes were removed from the cluster, so their Node objects no longer exist, but the machines themselves were left running. Each of them keeps sending `GET` requests to kube-apiserver for its own Node object, and every such request returns `404`. The constant 404 stream raises the apiserver error rate even though the cluster itself is healthy. The 404 rate jumps when the nodes are removed and then stays flat; nearly all of it is `verb=GET` on resource `nodes`, while `PATCH` on `nodes/status` stays at zero and other resources show almost no errors. Shutting down the removed machines brings the error rate back to normal.

## Resolution

### Cause 1: An admission webhook has no backend

Apply only when the apiserver log names this webhook, its Service has empty endpoints, and the operator has no ready Pods:

```bash
kubectl get mutatingwebhookconfiguration <webhook-name> -o yaml > /tmp/<webhook-name>.yaml
kubectl get endpoints,endpointslice -n <webhook-namespace>
kubectl get deploy,pods -n <webhook-namespace>
```

> **Warning:** Deleting a MutatingWebhookConfiguration stops that mutation for every matched resource. Do it only when the log shows `connection refused` to that webhook and its Service has no endpoints; never for a webhook that still has ready Pods. With `failurePolicy: Ignore`, creates were already allowed after the timeout, so the delete removes the wait rather than changing allow versus deny. Rollback: `kubectl apply -f /tmp/<webhook-name>.yaml`.

```bash
kubectl delete mutatingwebhookconfiguration <webhook-name>
```

Watch `POST pods` latency afterwards, and repeat the endpoint check for every other webhook before changing etcd.

### Cause 2: invalid bearer token and v1.enhancement.cluster.alauda.io resource not found

Check the APIService first; `readyz` reports kube-apiserver itself and does not show whether an aggregated API has a backend:

```bash
kubectl get apiservice v1.enhancement.cluster.alauda.io
kubectl get apiservice v1.enhancement.cluster.alauda.io -o jsonpath='{.spec.service.namespace}/{.spec.service.name}{"\n"}{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
kubectl get endpoints -n <service-namespace> <service-name>
kubectl get --raw='/readyz?verbose'
```

- `AVAILABLE True`, endpoints present, and `readyz` succeeds: no change. Do not restart the control plane, rotate tokens, or delete `cluster-enhancer-apiserver` because of these lines.
- `AVAILABLE False`, or a Service without endpoint addresses: find out why the backend Pods are missing or not Ready (for example after worker nodes were removed), and fix that:

  ```bash
  kubectl get nodes -o wide
  kubectl get pods -A -o wide | grep cluster-enhancer-apiserver
  kubectl describe pod -n <namespace> <pending-pod>
  ```

For `invalid bearer token`, compare the clock on every node of every cluster before closing:

```bash
date -u '+%F %T'
timedatectl | grep -E 'synchronized|NTP'
```

### Cause 3: cluster-enhancer-apiserver memory is high and a resource change needs a restart

Change the resources where the platform owns that Deployment; a hand edit of the Pod template is reverted when a controller reconciles it. The restart does not disturb running workloads.

```bash
kubectl get pods -A -o wide | grep cluster-enhancer-apiserver
```

### Cause 4: kube-controller-manager or kube-scheduler listens only on 127.0.0.1

Confirm the split between localhost and the node IP, and save iptables before editing:

```bash
sudo ss -lntp | grep -E ':10257|:10259'
sudo iptables-save > /tmp/iptables-before-kcm.rules
kubectl get svc,servicemonitor -A | grep -i -E 'controller-manager|scheduler'
```

**Firewall:** restore the forwarding rules from the approved firewall plan (the exact rules are site-specific), then point the Service and ServiceMonitor at the port that answers.

> **Warning:** Changing filter or nat rules can black-hole node traffic unrelated to port 10257. Edit only the rules the firewall plan uses for these ports, and only after localhost works while the node IP does not. Rollback: `sudo iptables-restore < /tmp/iptables-before-kcm.rules`.

**Bind address on a cluster reconciled from `kubeadmConfigSpec`:** set the listen address there:

```yaml
kubeadmConfigSpec:
  clusterConfiguration:
    controllerManager:
      extraArgs:
        bind-address: "::"
    scheduler:
      extraArgs:
        bind-address: "::"
```

**Bind address on a cluster whose control plane runs from static manifests:** change `--bind-address` from `127.0.0.1` to the node IP that monitoring scrapes.

> **Warning:** Changing `bind-address` restarts kube-controller-manager and kube-scheduler on each control-plane node; edit one master at a time, in a maintenance window, and only when `ss` shows the ports bound to `127.0.0.1`. The metrics and health ports then answer on the node address, so keep the firewall plan in front of them. Keep backups outside `/etc/kubernetes/manifests/`; a copy left in that directory is started as a second static Pod. Rollback: restore the backups (or set `bind-address` back to `127.0.0.1`) and the previous ServiceMonitor.

```bash
sudo cp /etc/kubernetes/manifests/kube-controller-manager.yaml /var/tmp/kube-controller-manager.yaml.before
sudo cp /etc/kubernetes/manifests/kube-scheduler.yaml /var/tmp/kube-scheduler.yaml.before
sudo sed -i 's/--bind-address=127.0.0.1/--bind-address=<node-ip>/' /etc/kubernetes/manifests/kube-controller-manager.yaml
sudo sed -i 's/--bind-address=127.0.0.1/--bind-address=<node-ip>/' /etc/kubernetes/manifests/kube-scheduler.yaml
kubectl get pods -n kube-system -l 'component in (kube-controller-manager,kube-scheduler)' -o wide
```

After the Pods are Ready, `telnet <node-ip> 10257` from the Prometheus node should connect and the health alerts should clear.

### Cause 5: kubectl get componentstatuses shows controller-manager and scheduler Unhealthy

When that output is the only complaint and the Pods are Running, no change is needed: no firewall edit, no bind-address change, and no restart. If the monitoring page is also red, use Cause 4.

```bash
kubectl get componentstatuses
kubectl -n kube-system get pods -l 'component in (kube-controller-manager,kube-scheduler,etcd)' -o wide
```

### Cause 6: apiserver errors from an already-compacted revision, with no leader change

```bash
kubectl -n kube-system get pods -l component=etcd
kubectl -n kube-system logs etcd-<node-name> --tail=200 | grep -F 'leader changed' || true
```

With a compacted-revision error plus a connection reset, no etcd restart, and no leader changes, ignore the lines. A `NOSPACE` alarm or leader changes need the etcd quota or disk investigation instead.

### Cause 7: removed worker machines are still running and keep requesting their deleted Node objects

1. Break the error rate down by code, then by resource, in the monitoring UI:

   ```text
   sum by (code) (apiserver_request_count_rate_5m_sum_by_instance_and_code)
   topk(20, sum by (resource, code) (apiserver_request_count_rate_5m_sum_by_resource_and_code{code=~"(4|5)..",code!="429"}))
   sum by (verb, subresource) (rate(apiserver_request_total{job="apiserver",resource="nodes",code="404"}[5m]))
   ```

   This cause matches when `code="404", resource="nodes"` dominates, almost all of it is `verb="GET"`, and the rise started when the nodes were removed.

2. Confirm the machines that send these requests are no longer cluster members: their names are absent from `kubectl get nodes`, and the machines are still powered on.

3. Shut down the removed machines.

   > **Warning:** Shutting a machine down stops everything still running on it. Do this only for machines whose Node objects were deliberately removed from the cluster and that carry nothing else in use. Roll back by powering the machine on again; it will resume the 404 requests until it is shut down or rejoined.

   If a machine has to stay powered on for another purpose, stop and disable the kubelet on it instead, so that it no longer contacts the cluster:

   ```bash
   systemctl disable --now kubelet
   ```

4. Re-run the queries in step 1 after a few minutes. The `404` rate on `nodes` should drop to near zero and the error-rate alert should clear.

## Diagnostic Steps

Webhooks first, then the log signatures, then the controller-manager port:

```bash
kubectl get mutatingwebhookconfiguration -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.webhooks[*].clientConfig.service.namespace}{"/"}{.webhooks[*].clientConfig.service.name}{"\tfail="}{.webhooks[*].failurePolicy}{"\ttimeout="}{.webhooks[*].timeoutSeconds}{"\n"}{end}'
kubectl get validatingwebhookconfiguration -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}'
kubectl -n kube-system logs kube-apiserver-<node-name> --tail=200 | grep -E 'connection refused|invalid bearer token|enhancement.cluster.alauda.io' || true
kubectl get apiservice | grep -v 'True' || true
```

For each webhook Service namespace printed above:

```bash
kubectl get endpoints,pods,deploy -n <webhook-namespace>
```

- Empty endpoints plus `connection refused`: Cause 1.
- The two log lines with a healthy `readyz` and APIService `v1.enhancement.cluster.alauda.io` `AVAILABLE True`: Cause 2. The same OpenAPI line with that APIService `False`: start from the missing backend Pods.
- High memory on `cluster-enhancer-apiserver`: Cause 3.
- `10257` open on `127.0.0.1` and refused on the node IP, or the KubeScheduler / ControllerManager health alerts with ports bound to `127.0.0.1`: Cause 4.
- `kubectl get componentstatuses` Unhealthy with the Pods Running and no monitoring failure: Cause 5.
- Compacted-revision errors with a quiet etcd: Cause 6.
- The error rate is mostly `404` from `GET` on `nodes`, starting when worker nodes were removed: Cause 7.

Read-success alerts that are mostly HTTP 403 are authorization failures, not a webhook timeout. Capture one request's user and verb before deleting any webhook. When the 403s come with cert-manager webhook denials for `{cpaas-ca ClusterIssuer ait.alauda.io}` in the kube-apiserver log, they are expected; see *Certificate alerts from a custom VMRule, ait.alauda.io webhook denials, or by-design short-lived certificates on ACP* (Cause 2).
