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
---

# HAMi GPU Pods stay Pending while GPUs are free: expired certificate or default-scheduler on ACP

## Issue

The HAMi management page still shows free GPU, `nvidia-smi` on the node shows free memory, and a new, scaled, or restarted GPU Pod stays `Pending`. Events say that no resources are available, that no node meets the request, or name `Insufficient nvidia.com/gpucores`, `Insufficient nvidia.com/gpumem`, or `Insufficient nvidia.com/gpualloc`. A typical event:

```text
0/18 nodes are available: 1 Insufficient nvidia.com/gpucores, 1 Insufficient nvidia.com/gpumem, 17 node(s) didn't match Pod's node affinity/selector. preemption: 0/18 nodes are available: 1 No preemption victims found for incoming pod, 17 Preemption is not helpful for scheduling.
```

The same failure can hit a workload that was healthy earlier the same day. After one GPU allocation, the console keeps saying there are no available GPU resources, and even shrinking the GPU request of another application gives the same event. The `hami-scheduler` log can show `http: TLS handshake error from <client>: remote error: tls: bad certificate`. In another form, the Pod is created and keeps `schedulerName: default-scheduler`, often after a Pod that used to run restarts, and an inference service stays in `Processing` because its predictor Pod cannot be scheduled.

The documented install places `hami-scheduler` and `hami-device-plugin` in `kube-system` and `hami-webui` in `cpaas-system`; use the namespace printed by the Pod list if a site changed it.

Related articles: *HAMi GPU Pods Pending on a locked GPU node or on a cluster without HAMi installed on ACP* (a `locked` node or a missing HAMi install), *HAMi NVIDIA GPU Pod Pending with CardInsufficientMemory because gpumem was set as the total across cards*, and *HAMi workload requests the wrong GPU resource name on ACP* (`Insufficient nvidia.com/gpu` or `Insufficient limits.nvidia.com/gpualloc`).

## Root Cause

### Cause 1: HAMi components serve an expired or not-yet-reloaded certificate

HAMi 2.7.x (2.7 and 2.7.1) can leave the webhook, `hami-scheduler`, and the device plugin serving on a certificate that is no longer valid. Two shapes exist:

- **Expiry:** the certificate `hami-scheduler-serving-cert` in `kube-system` has expired on the default validity and rotation settings. For example, a Pod pinned to a node with 8 `NVIDIA A100-SXM4-80GB` cards and requesting 1 GPU at compute 100 stays `Pending` with the event shown in Issue, while `nvidia-smi` shows every card at `11MiB / 81920MiB` and 0% utilization. `kubectl describe node` lists under Allocated resources only `nvidia.com/gpualloc` and `nvidia.com/busid-*` / `nvidia.com/nic*` entries at 0.
- **Rotation:** the certificate has been rotated, and the running components have not loaded the new one. The `hami-scheduler` log shows quota lines such as `quota.go:234] after val= nvidia.com/gpumem : &{20480 0}` next to `http: TLS handshake error from <client>: remote error: tls: bad certificate`.

From that point, Kubernetes no longer sees the GPU usage on the node and new GPU Pods stay `Pending`. In a further form, every component is `Running`, the scheduler and device-plugin logs show no obvious error, the node still has `gpu=on` and `nvidia.com/gpualloc`, but it no longer advertises `nvidia.com/gpumem` and `nvidia.com/gpucores`.

Restarting the scheduler and device-plugin Pods makes them load a valid certificate and restores scheduling. The lasting fix is HAMi 2.8.0 or later; on ACP 3.18.2, 2.8.3 is a confirmed usable build.

### Cause 2: spec.schedulerName stays default-scheduler on a Pod that requests HAMi resources

HAMi 2.7.1 does not always rewrite `spec.schedulerName` to `hami-scheduler`. `default-scheduler` cannot place HAMi extended resources, so the Pod fails scheduling. A production GPU Pod can lose its GPU after a restart this way, because the HAMi webhook was not working when the Pod was recreated; on such clusters `kubectl describe node | grep -A 5 "nvidia.com/gpucores"` can print nothing on any node. An inference service predictor Pod (`<service>-predictor`) with `schedulerName: default-scheduler` reports:

```text
FailedScheduling: 0/3 nodes are available: 1 Insufficient nvidia.com/gpualloc, 1 node(s) were unschedulable, 2 Insufficient nvidia.com/gpucores, 2 Insufficient nvidia.com/gpumem. preemption: 0/3 nodes are available: 1 Preemption is not helpful for scheduling, 2 No preemption victims found for incoming pod.
```

Its HPA can report `FailedGetResourceMetric ... no metrics returned from resource metrics API` at the same time; that clears with the same fix. Restarting `hami-scheduler`, then the business Pod, gives the Pod `hami-scheduler` and it runs. The defect is fixed in HAMi 2.8 and later. Use this cause when the certificate is still inside its validity; if it has expired, use Cause 1.

## Resolution

### Cause 1: HAMi components serve an expired or not-yet-reloaded certificate

Use this only when HAMi is 2.7.x and one of these holds: the webhook or component certificate `notAfter` is in the past; the certificate was renewed after the scheduler Pod started; the `hami-scheduler` log shows `remote error: tls: bad certificate`; or the node lists `nvidia.com/gpualloc` but not `nvidia.com/gpumem` and `nvidia.com/gpucores` while the Pending Pod requests them.

> **Warning:** Deleting the `hami-scheduler` Pod stops HAMi placement until its controller recreates it. Deleting a `hami-device-plugin` Pod unregisters that node's HAMi GPU resources for the restart window. New GPU Pods stay Pending during the gap; running GPU containers are not deleted. Do this in a maintenance window if production GPU scheduling must continue. Rollback is the automatic recreation by the owning Deployment or DaemonSet. The restart does not stop 2.7.x from hitting the same expiry again; the lasting fix is the upgrade below.

```bash
kubectl get pod -n kube-system <hami-scheduler-pod> -o jsonpath='{.metadata.ownerReferences[0].kind}{" "}{.metadata.ownerReferences[0].name}{"\n"}'
kubectl get pod -n kube-system <hami-device-plugin-pod> -o jsonpath='{.metadata.ownerReferences[0].kind}{" "}{.metadata.ownerReferences[0].name}{"\n"}'
kubectl delete pod -n kube-system <hami-scheduler-pod> <hami-device-plugin-pod>
```

After the new Pods are `Running`, confirm the node advertises `nvidia.com/gpumem` and `nvidia.com/gpucores` again. If the business Pod is still `Pending`, delete only that Pod so admission runs again.

> **Warning:** Deleting the Pending business Pod recreates it from its controller and restarts that workload's startup. Delete only a Pod whose phase is still `Pending`; Running GPU Pods stay. If `ownerReferences` is empty, save the Pod YAML first and re-apply it to roll back.

```bash
kubectl get pod -n <namespace> <pending-pod> -o jsonpath='{.status.phase}{"\n"}{.spec.schedulerName}{"\n"}'
kubectl delete pod -n <namespace> <pending-pod>
```

Upgrade the Alauda Build of HAMi cluster plugin to 2.8.0 or later.

Until the upgrade, the certificate validity can be lengthened on `hami-scheduler-serving-cert`. In a cert-manager `Certificate`, validity is `spec.duration` and the renewal lead time is `spec.renewBefore`; for example `720h` and `240h`. `renewBefore` must stay shorter than `duration`.

> **Warning:** Changing the `spec` of `hami-scheduler-serving-cert` makes cert-manager issue a new certificate into the same Secret. The running `hami-scheduler` and device plugin keep the certificate they loaded at start (the rotation shape of this cause), so restart them with the commands above afterwards. Save the object first; rollback is `kubectl apply -f` of the saved file, followed by the same restart.

```bash
kubectl get certificate -n kube-system hami-scheduler-serving-cert -o yaml > "$HOME/hami-scheduler-serving-cert.yaml"
kubectl patch certificate -n kube-system hami-scheduler-serving-cert --type=merge -p '{"spec":{"duration":"720h","renewBefore":"240h"}}'
kubectl get certificate -n kube-system hami-scheduler-serving-cert -o jsonpath='{.spec.duration}{" "}{.spec.renewBefore}{" "}{.status.notAfter}{"\n"}'
```

Read the values back after any HAMi upgrade.

### Cause 2: spec.schedulerName stays default-scheduler on a Pod that requests HAMi resources

Use this only when the certificate `notAfter` is still in the future and the Pod that requests HAMi resources has `schedulerName: default-scheduler`.

> **Warning:** Restarting `hami-scheduler` pauses HAMi scheduling until the controller recreates the Pod. Running GPU containers keep running; new HAMi Pods wait. Take a maintenance window on a production GPU cluster. Rollback is the controller recreating the Pod. The restart is a workaround; HAMi 2.8 and later contain the fix.

```bash
kubectl delete pod -n kube-system <hami-scheduler-pod>
# equivalent:
kubectl rollout restart -n kube-system deploy/hami-scheduler
```

If the node still lacks `nvidia.com/gpumem` and `nvidia.com/gpucores` after the scheduler restart, also restart the device-plugin Pods as in Cause 1. If the Pending Pod still shows `default-scheduler` after the new scheduler is Ready, delete only that Pending Pod so admission runs again.

> **Warning:** Deleting this Pending Pod restarts that one workload. Leave every Running GPU Pod in place. Only when the phase is `Pending` and `schedulerName` is still `default-scheduler` after the scheduler Pod is Ready. A controller-owned Pod is recreated by its controller; save the YAML first when there is no ownerReference.

```bash
kubectl get pod -n <namespace> <pending-pod> -o jsonpath='{.status.phase}{"\n"}{.spec.schedulerName}{"\n"}'
kubectl delete pod -n <namespace> <pending-pod>
```

If the Pod gets `hami-scheduler` after the restart and still fails because it requests native `nvidia.com/gpu`, see *HAMi workload requests the wrong GPU resource name on ACP*. Upgrade Alauda Build of HAMi to 2.8 or later so the webhook sets `schedulerName` itself.

## Diagnostic Steps

1. List the HAMi workloads with namespace, node, Ready state, and image. All of them can be `Running` while Cause 1 is active.

```bash
kubectl get pods -A -o wide | grep -E 'hami-scheduler|hami-device-plugin|hami-webui|hamiwebui'
kubectl get ds,deploy -A | grep -i hami
kubectl get pod -n kube-system <hami-scheduler-pod> -o jsonpath='{.spec.containers[*].image}{"\n"}'
```

2. Read the Pending Pod's scheduler, runtime class, and GPU requests. HAMi on ACP uses `nvidia.com/gpualloc` together with `nvidia.com/gpucores` and `nvidia.com/gpumem`; `nvidia.com/gpu` is the physical-GPU plugin resource.

```bash
kubectl get pod -n <namespace> <pod> -o jsonpath='scheduler={.spec.schedulerName}{"\n"}runtime={.spec.runtimeClassName}{"\n"}'
kubectl get pod -n <namespace> <pod> -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.resources.limits}{"\n"}{end}'
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod> --sort-by=.lastTimestamp
```

`scheduler=default-scheduler` with a valid certificate is Cause 2.

3. Compare node allocatable with the request. Cause 1 often has `gpualloc` present and `gpumem` or `gpucores` absent. Also compare the Pod's per-card `nvidia.com/gpumem` with one card's `memory.total` from `nvidia-smi`; a larger value is the `CardInsufficientMemory` case in the related articles, not Cause 1.

```bash
kubectl get node -o custom-columns='NAME:.metadata.name,GPUALLOC:.status.allocatable.nvidia\.com/gpualloc,GPUMEM:.status.allocatable.nvidia\.com/gpumem,GPUCORES:.status.allocatable.nvidia\.com/gpucores,GPU:.status.allocatable.nvidia\.com/gpu'
kubectl describe node <node> | grep -A20 'Allocated resources'
```

4. Search the HAMi logs for TLS failures. `remote error: tls: bad certificate` or `TLS handshake error` in the `hami-scheduler` log is the rotation shape of Cause 1.

```bash
kubectl logs -n kube-system deploy/hami-scheduler --all-containers --since=1h | grep -E 'bad certificate|TLS handshake error'
kubectl logs -n kube-system <hami-device-plugin-pod> --all-containers --since=1h | grep -i -E 'certificate|tls'
```

5. Read certificate dates before any restart. A past `notAfter`, or a certificate issued after the scheduler Pod started, is Cause 1.

```bash
kubectl get certificate -n kube-system hami-scheduler-serving-cert -o jsonpath='secret={.spec.secretName}{"\n"}notAfter={.status.notAfter}{"\n"}renewalTime={.status.renewalTime}{"\n"}'
kubectl get pod -n kube-system <hami-scheduler-pod> -o jsonpath='{.status.startTime}{"\n"}'
kubectl get mutatingwebhookconfiguration -o custom-columns='NAME:.metadata.name,SVC:.webhooks[0].clientConfig.service.name,NS:.webhooks[0].clientConfig.service.namespace,PORT:.webhooks[0].clientConfig.service.port'
kubectl get mutatingwebhookconfiguration <hami-webhook> -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | base64 -d | openssl x509 -noout -enddate -subject
kubectl get pod -n kube-system <hami-scheduler-pod> -o jsonpath='{range .spec.volumes[*]}{.name}{"\t"}{.secret.secretName}{"\n"}{end}'
kubectl get secret -n kube-system <tls-secret> -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -startdate -enddate -subject
```

If the serving certificate is not in a Secret, port-forward the webhook Service and read the peer certificate (`127.0.0.1` is the local forward):

```bash
kubectl port-forward -n kube-system svc/<webhook-service> 8443:<port>
echo | openssl s_client -connect 127.0.0.1:8443 -servername <webhook-service>.kube-system.svc 2>/dev/null | openssl x509 -noout -enddate
```

6. If the HAMi Pod list on this cluster is empty, or the node shows `locked`, see *HAMi GPU Pods Pending on a locked GPU node or on a cluster without HAMi installed on ACP*. A Pod rejected with `RuntimeClass "nvidia" not found`, or a scheduled GPU Pod that crashes with `libcuda.so.1: file too short`, is a different problem and not covered here.
