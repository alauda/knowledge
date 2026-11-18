---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Application breaks after a NetworkPolicy change: Ingress, Pod-to-Pod ping, Redis Sentinel or Harbor on ACP

## Issue

An application that worked, or a new one, fails, and a network policy is involved:

- An Ingress created on the platform for a Service port (for example `8080`) cannot be reached.
- Two Pods in the same namespace cannot ping each other in either direction: `2 packets transmitted, 0 received, 100% packet loss`.
- A Redis instance in Sentinel mode does not start after it is created. The `rfr-<instance>` StatefulSet Pods are in `CrashLoopBackOff`, and their logs show every call to the Kubernetes API server timing out:
  - `Get ".../configmaps/rfr-acl-<instance>": context deadline exceeded`, `ERROR load acl failed`
  - `Get ".../pods/rfs-<instance>-0": dial tcp ...:443: i/o timeout`
  - `level=fatal msg="Error getting password from secret rfr-acl-<instance>-operator-secret ...: context deadline exceeded"`
  - `ERROR Access enable nodeport service access failed`, `ERROR Access load cached config failed`

  Events show `FailedPreStopHook`, `Back-off restarting failed container redis-exporter` and `Startup probe failed: dial tcp ...: connect: connection refused`.
- Harbor is inaccessible, and the `harbor-nginx` Pod stays `Running` with `0/1` Ready.

In each case a policy was the cause, and correcting or removing it restored service.

## Root Cause

### Cause 1: a NetworkPolicy blocks the ingress controller from the backend

A `NetworkPolicy` that selects the application Pods does not allow traffic from the ingress controller. Policies match what arrives at the Pod: the source is the ingress controller (a Pod, or the node when the controller runs on the host network), and the port is the container port behind the Service (`targetPort`), which can differ from the Service port.

### Cause 2: a policy with Egress blocks Pod-to-Pod traffic in the namespace

A network policy in the namespace selects the Pods with `Egress` in `policyTypes` and has no rule that allows traffic to the other Pods, so outbound traffic from those Pods is dropped.

### Cause 3: the Redis Sentinel Pods cannot reach the Kubernetes API server

At startup the Redis and Sentinel containers read their ACL ConfigMap, password Secret and Pod objects from the API server (Service port `443`). The required network path had not been opened, so every request timed out and the containers exited. Adjusting the Sentinel resource limits is not the fix. The block can be a Kubernetes `NetworkPolicy` or a rule on the network side, so check both.

### Cause 4: harbor-nginx is 0/1 Ready after the cluster network policies were modified

The cluster network policies were changed just before Harbor stopped serving, and restoring the previous policy configuration brought `harbor-nginx` back to Ready.

## Resolution

Save every policy before changing any of them, so each step can be undone:

```bash
kubectl get networkpolicy -A -o yaml > /tmp/all-netpol.before.yaml
kubectl get adminnetworkpolicy -o yaml > /tmp/all-anp.before.yaml
```

### Cause 1: a NetworkPolicy blocks the ingress controller from the backend

Find the container port and the controller's source, then add an ingress allow for that pair to the policy:

```bash
kubectl -n <namespace> get svc <service> -o jsonpath='{.spec.ports}{"\n"}'
kubectl get pod -A -o wide | grep -iE 'alb|ingress'
kubectl -n <namespace> get networkpolicy -o yaml
```

```yaml
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: <ingress-controller-namespace>
      ports:
        - protocol: TCP
          port: <target-port>
```

If the controller Pods use the host network, a namespace selector does not match them; allow the node addresses, or on Kube-OVN the join subnet, with `ipBlock`.

> **Warning:** Editing the policy changes who can reach every Pod it selects. Roll back with `kubectl apply -f /tmp/all-netpol.before.yaml`.

```bash
kubectl -n <namespace> edit networkpolicy <name>
curl -sv --max-time 5 http://<ingress-host>/<path> -o /dev/null
```

### Cause 2: a policy with Egress blocks Pod-to-Pod traffic in the namespace

Delete the policy, or keep it and add an egress rule `to: - podSelector: {}`, which allows traffic to every Pod in the same namespace.

> **Warning:** Deleting the policy removes all the isolation it gave to the Pods it selected. Get agreement from the namespace owner. Roll back with `kubectl apply -f /tmp/all-netpol.before.yaml`.

```bash
kubectl -n <namespace> delete networkpolicy <name>
kubectl -n <namespace> exec <pod-a> -- ping -c 3 <pod-b-ip>
```

### Cause 3: the Redis Sentinel Pods cannot reach the Kubernetes API server

Only when the Redis or Sentinel logs show `context deadline exceeded` or `dial tcp ...:443: i/o timeout` on API server requests. Open the path from the instance Pods to the API server:

- If a `NetworkPolicy` with `Egress` selects those Pods, add an egress allow to the API server. On Kube-OVN the rule has to name the backend endpoints of the `kubernetes` Service (the addresses in its EndpointSlice, port `6443`), not only the ClusterIP; the rule shape is in "Operator manager pod stuck in CrashLoopBackOff when a NetworkPolicy denies egress to the apiserver on ACP".
- If no policy selects the Pods, the block is on the network path from the Pod network to the control-plane nodes; have it opened there.

> **Warning:** An egress allow changes what the selected Pods can reach; limit it to the instance Pods and the API server endpoints. Roll back by deleting the allow policy you added.

```bash
kubectl -n <namespace> logs <rfr-pod> --all-containers --tail=50 | grep -E 'deadline|i/o timeout|failed'
kubectl -n <namespace> get networkpolicy
kubectl get endpointslice -n default -l kubernetes.io/service-name=kubernetes
kubectl -n <namespace> apply -f allow-apiserver-egress.yaml
kubectl -n <namespace> get pod -w | grep -E 'rfr-|rfs-'
```

### Cause 4: harbor-nginx is 0/1 Ready after the cluster network policies were modified

Put back the configuration from before the change, then reintroduce the intended change one rule at a time while watching `harbor-nginx` readiness.

> **Warning:** Restoring the old policies removes whatever the change was meant to add. You need a copy of the configuration from before the change (an export, Git, or the previous console values). Re-apply the current copy saved above to roll back.

```bash
kubectl apply -f <policies-before-the-change>.yaml
kubectl get pod -A | grep harbor-nginx
```

## Diagnostic Steps

1. List every policy that can select the failing Pod and its peer, cluster-scoped ones included:

   ```bash
   kubectl -n <namespace> get pod <pod> --show-labels
   kubectl -n <namespace> get networkpolicy
   kubectl get adminnetworkpolicy
   kubectl get baselineadminnetworkpolicy
   ```

2. Read why a Pod is not Ready; probe or upstream timeouts that began with a policy change point to that change:

   ```bash
   kubectl -n <namespace> describe pod <pod> | grep -A10 -iE 'Readiness|Events'
   ```

3. Test the exact path with the Pod IP and the container port:

   ```bash
   kubectl -n <namespace> exec <client-pod> -- sh -c 'nc -vz -w 3 <backend-pod-ip> <target-port>'
   ```

- Ingress to the Service fails and a policy selects the backend: Cause 1.
- Same-namespace Pods cannot ping and a policy has `Egress`: Cause 2.
- Redis Sentinel Pods crash-loop with API server calls on `443` timing out: Cause 3.
- `harbor-nginx` `0/1` right after cluster policy changes: Cause 4.

If LoadBalancer VIPs (not application Pods) fail after isolation between projects is enabled, see "LoadBalancer VIP unreachable after project isolation or with a MetalLB address outside the node segment on ACP".
