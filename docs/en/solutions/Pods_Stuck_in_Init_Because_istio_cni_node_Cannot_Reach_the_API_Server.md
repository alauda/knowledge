---
title: Pods stay in Init when the Istio CNI agent loses the API server
component: networking
scenario: troubleshooting
tags: [service-mesh, istio, cni, kube-apiserver, daemonset]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Pods stay in Init when the Istio CNI agent loses the API server

## Issue

On a cluster running Alauda Service Mesh v2 (servicemesh-operator2 OperatorBundle v2.1.2 on Alauda Container Platform 4.3.x), workload pods can stall in the Init phase indefinitely. The kubelet calls the configured CNI chain to set up the pod network sandbox before any container in the pod is started, so a CNI plugin that fails during sandbox setup keeps the pod from ever leaving Init [ev:c1]. With Alauda Service Mesh v2 installed, the istio-cni plugin runs as a node-level DaemonSet that is invoked synchronously by the host CNI chain during pod sandbox creation, so a fault inside that DaemonSet blocks every new pod scheduled on the affected node [ev:c2].

The kubelet surfaces the failure as a pod Event of type `Warning` with reason `FailedCreatePodSandBox`; the event message embeds the underlying CNI error verbatim, and when the istio-cni leg of the chain is the failing one its inner error fragment `dial tcp <api-vip>:443: connect: connection refused` is visible in the message text [ev:c5].

## Root Cause

During sandbox creation the istio-cni agent calls the Kubernetes API server to read the pod's metadata so it can decide whether and how to program traffic redirection for that pod [ev:c3]. In-cluster, the API server is reached through the `kubernetes` Service in the `default` namespace, ClusterIP `10.4.0.1:443/TCP`, using the auto-projected `kube-root-ca.crt` ConfigMap that every namespace receives for CA trust [ev:c3].

When the agent's client connection to the API server is wedged, the TCP dial against that VIP returns `connect: connection refused` — the same shape that appears inside the `FailedCreatePodSandBox` message. The CNI `CmdAdd` invocation returns that error to the kubelet, sandbox creation fails, and the pod stays in `Init` because no container can be started without a sandbox [ev:c4].

## Resolution

Recreate the affected DaemonSet pods by deleting them with their label selector. The DaemonSet controller reconciles the desired replica count against the per-node demand and recreates a fresh pod (with the same container image and configuration) on every node where one was removed, restoring `numberAvailable` to `desiredNumberScheduled` [ev:c6]. The new agent processes start with fresh API-server clients, and subsequent pod sandbox creations succeed.

Run the deletion against the istio-cni DaemonSet in its own namespace:

```bash
kubectl -n istio-cni delete pods -l k8s-app=istio-cni-node
```

After the pods come back Ready, scheduled workload pods that were blocked in `Init` proceed past sandbox creation on the next kubelet retry [ev:c6].

## Diagnostic Steps

Confirm the symptom from the pod's events. Filter the namespace's Events for the Warning reason emitted by kubelet when CNI fails; the `message` field embeds the chain error and the istio-cni connection-refused fragment [ev:c5]:

```bash
kubectl -n <workload-ns> get events --field-selector reason=FailedCreatePodSandBox -o json \
  | jq -r '.items[] | [.lastTimestamp, .type, .reason, .message] | @tsv'
```

Verify the istio-cni DaemonSet pods are healthy and reachable. The DaemonSet status fields show whether per-node coverage is intact; missing or NotReady pods are the agent processes whose API-server clients should be reset [ev:c6]:

```bash
kubectl -n istio-cni get ds istio-cni-node -o jsonpath='{.status.numberReady}/{.status.desiredNumberScheduled}{"\n"}'
kubectl -n istio-cni get pods -l k8s-app=istio-cni-node -o wide
```

Confirm in-cluster API-server reachability is normal otherwise (so the fault is local to the agent rather than a control-plane outage). The expected target is the `kubernetes` Service ClusterIP on port 443 [ev:c3]:

```bash
kubectl -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}:{.spec.ports[0].port}{"\n"}'
```

If the same `connect: connection refused` fragment is also visible from other in-cluster clients (not just istio-cni), the cause is a control-plane issue and the DaemonSet pod restart will not be sufficient [ev:c4].
