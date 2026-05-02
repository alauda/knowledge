---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Operator Manager Pod CrashLoopBackOff Because the Namespace NetworkPolicy Blocks API-Server Egress
## Issue

After a default-deny `NetworkPolicy` is applied to a workload namespace, the controller-manager pod for an Operator deployed into that namespace enters `CrashLoopBackOff`. Container logs from the manager pod show a clean startup attempt that times out before the controller can list its watched resources:

```text
{"level":"error","ts":"...","logger":"cmd",
 "msg":"Failed to create a new manager.",
 "Namespace":"<ns>",
 "error":"Get \"https://172.30.0.1:443/api?timeout=32s\": dial tcp 172.30.0.1:443: i/o timeout"}
```

The error is always against the cluster's in-cluster API server VIP (the `kubernetes` Service ClusterIP, typically `10.96.0.1` or `172.30.0.1` depending on the install). Other pods in the same namespace that do not need to talk to the API server (a static frontend, a database, a worker that only listens) appear healthy — only the controller-manager pod, which uses the Kubernetes Go client, fails.

## Root Cause

A `NetworkPolicy` resource scopes egress (and ingress) traffic for any pod whose labels match the policy selector. By default, when a namespace has *any* policy that selects a pod, that pod's allowed ingress and egress are restricted to whatever those policies explicitly permit — everything else is denied.

A controller-manager built with the upstream Operator SDK / controller-runtime stack does the following at start-up:

1. Open a TCP connection to the `kubernetes` Service ClusterIP on port 443.
2. Establish TLS using the in-cluster CA bundle.
3. List the cluster's APIs and the resources the manager intends to watch.
4. Start the leader election lease, then begin reconciling.

If step 1 hits an `i/o timeout`, the manager treats the cluster as unreachable and exits, the kubelet restarts the pod, and the loop repeats. The error message is generic — it does not say "blocked by NetworkPolicy" — which is why the failure is often misdiagnosed as an etcd or API-server outage rather than a namespace policy.

The block is almost always one of:

- The namespace has a default-deny egress policy and **does not explicitly allow** egress to the `kubernetes` Service / its endpoints.
- The policy that scopes the operator pod allows egress to specific pods (e.g. application backends) but the manager's required egress to the API server was forgotten.
- The cluster CNI (Kube-OVN, Cilium, OVN-Kubernetes) enforces policies in a slightly different way than expected and the egress to the API server VIP requires either a `to:` block keyed on the cluster's API-server endpoints namespace **or** an explicit egress entry to port 443 with no `to:` restriction.

## Resolution

Allow egress from the operator manager pod to the cluster API server, scoped as tightly as the cluster's policy posture allows. Two patterns are common:

1. **Allow egress to the API-server endpoints by namespace + port** — the most surgical option, only opens 443 toward the actual control-plane endpoints:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-operator-to-apiserver
     namespace: <operator-ns>
   spec:
     podSelector:
       matchLabels:
         control-plane: controller-manager
     policyTypes:
       - Egress
     egress:
       - to:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: default
             podSelector:
               matchLabels:
                 component: apiserver
                 provider: kubernetes
         ports:
           - protocol: TCP
             port: 6443
       - to:
           - ipBlock:
               cidr: <api-server-svc-clusterip>/32
         ports:
           - protocol: TCP
             port: 443
   ```

   Two `to:` blocks are present because some CNIs evaluate policies against the resolved endpoint pods (the kube-apiserver pods in the `default` namespace, or wherever the cluster places them) while others see the traffic as targeting the Service ClusterIP. Including both forms covers either evaluation path. Replace `<api-server-svc-clusterip>` with the value reported by `kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}'`.

2. **Allow all egress on port 443 from the operator pod** — looser but trivially correct, useful while ramping up policy coverage:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-operator-egress-https
     namespace: <operator-ns>
   spec:
     podSelector:
       matchLabels:
         control-plane: controller-manager
     policyTypes:
       - Egress
     egress:
       - ports:
           - protocol: TCP
             port: 443
       - ports:
           - protocol: UDP
             port: 53
       - ports:
           - protocol: TCP
             port: 53
   ```

   The DNS allowance (`UDP/TCP 53`) is also required if the manager resolves the API server through CoreDNS rather than via the Service ClusterIP directly. Most controller-runtime managers use the in-cluster `KUBERNETES_SERVICE_HOST` env, which is the ClusterIP — but health probes, webhooks, and additional services typically need DNS too.

After applying either policy, restart the manager pod (or wait for the next CrashLoopBackOff retry). The pod should reach `Running` state within one or two reconcile cycles.

## Diagnostic Steps

Confirm the failing pod is the controller-manager and not a different container in the same Deployment:

```bash
kubectl logs -n <ns> <operator-controller-manager-pod> \
  -c manager --tail=100 \
  | grep -E 'Failed to create|i/o timeout|172\.30|10\.96'
```

The signature is `dial tcp <api-server-svc-ip>:443: i/o timeout` from the controller-runtime / Operator SDK code path.

Verify that an unblocked pod in the same namespace can reach the API server, while the operator pod cannot:

```bash
kubectl run -n <ns> probe --image=curlimages/curl --restart=Never --rm -it -- \
  curl -k -m 5 https://kubernetes.default.svc/healthz
```

If the temporary `probe` pod can reach `200 ok` but the operator manager keeps timing out, the difference is exactly the `NetworkPolicy` selector: the policy applies to the operator pod's labels but not to the `probe` pod (which has no matching labels).

List the policies that select the operator pod and inspect their egress rules:

```bash
kubectl get networkpolicy -n <ns> -o json \
  | jq '.items[] | select(.spec.podSelector.matchLabels."control-plane"=="controller-manager")'
```

Any policy that selects the operator pod must either allow egress to the API server explicitly or be paired with a second policy that does. If no policy in the namespace selects the operator pod and connectivity still fails, the issue is not a namespace `NetworkPolicy` — investigate cluster-wide egress firewall or AdminNetworkPolicy CRs (Kube-OVN supports both).

After applying the fix, confirm the manager makes it past start-up and into the leader election lease:

```bash
kubectl get lease -n <ns> | grep <operator-name>
kubectl get pod -n <ns> -l control-plane=controller-manager -o wide
```

A healthy operator owns its leader-election Lease and the pod stays Ready for several reconcile cycles in a row.
