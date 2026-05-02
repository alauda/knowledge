---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Per-User API Rate Limiting Is Not a Supported Capability
## Issue

A common operational question: can the platform enforce a fixed quota of API calls per authenticated user or per client over a time window — for example, "no more than N `kubectl get pods` calls per minute per service account"? The expectation usually comes from external API gateway experience, where per-key rate limits are a standard primitive.

ACP inherits the upstream Kubernetes API server model, and that model does not expose a per-user request-count throttle. Operators reaching for this capability should understand what the API server *does* offer, what it does not, and why bolting on external rate limiting in front of the API is strongly discouraged.

## Root Cause

The Kubernetes API server handles overload through two mechanisms, neither of which is a per-user counter:

- **Priority and Fairness (APF)** — classifies incoming requests into FlowSchemas and queues them across PriorityLevels so that a noisy client cannot starve a well-behaved one. APF shapes concurrency and queueing, not request-per-second quotas.
- **max-in-flight limits** — protect the API server against total concurrent load; again, not per-identity.

There is no control loop that counts requests per user identity over a rolling window and rejects the N+1 call. This is a deliberate design choice: the control-plane API is meant to be available to every authenticated controller, operator, and human operator in the cluster, and a per-user quota would interact badly with bursty reconcile loops that are normal and expected.

## Resolution

Per-user, request-count API rate limiting is not available and is not on the supported configuration surface. Treat this as a settled fact of the platform and redirect effort into the mechanisms that *are* available:

1. **Lean on API Priority and Fairness.** If the problem is that one workload is crowding out the rest, define a dedicated FlowSchema that maps that workload's ServiceAccount (or a label) into a lower PriorityLevel with limited concurrency share. Fairness, not throttling, is the native tool.

   ```yaml
   apiVersion: flowcontrol.apiserver.k8s.io/v1
   kind: FlowSchema
   metadata:
     name: noisy-workload
   spec:
     priorityLevelConfiguration:
       name: workload-low
     matchingPrecedence: 1000
     rules:
       - subjects:
           - kind: ServiceAccount
             serviceAccount:
               name: noisy-operator
               namespace: team-x
         resourceRules:
           - verbs: ["list", "watch", "get"]
             apiGroups: ["*"]
             resources: ["*"]
   ```

2. **Constrain clients, not the server.** If a specific controller is the source of the pressure, fix it on the client side: raise `--burst` and `--qps` only where justified, fix tight reconcile loops, and adopt informers + caches instead of polling. The kube-apiserver client defaults (`QPS=5, Burst=10`) exist for a reason.

3. **Scope permissions, not quotas.** If the concern is abusive use by a specific identity, RBAC is the correct answer: grant only the verbs and resources that identity needs. A client that cannot `list pods` cluster-wide cannot flood the API server with `list pods` calls.

4. **Do not insert an API gateway in front of the cluster API.** Products aimed at business-facing APIs (3scale-class proxies, external gateways) are the wrong shape for control-plane traffic. They do not understand client-go discovery, watch semantics, `Accept` negotiation, or APF headers, and they will break controllers in subtle ways. Rate limiting implemented at the L4/L7 edge (HAProxy, NGINX, F5) is technically possible but is outside any sane operational envelope — it will drop watch connections, stall leader elections, and turn transient request storms into sustained outages.

5. **Audit instead.** When the goal is accountability (who is making these calls), turn on audit logging and consume it into the platform log pipeline. Audit answers the actual question most of these requests boil down to, which is forensic, not enforcement.

## Diagnostic Steps

Confirm which mechanisms are active and what they are doing:

```bash
# See APF configuration currently in effect
kubectl get flowschemas.flowcontrol.apiserver.k8s.io
kubectl get prioritylevelconfigurations.flowcontrol.apiserver.k8s.io

# Identify which FlowSchema a given request is being classified into
# (API server exposes this via response headers)
kubectl get --raw=/apis/flowcontrol.apiserver.k8s.io/v1/flowschemas \
  -v=8 2>&1 | grep -i 'x-kubernetes-pf-'
```

Look for which identities are actually heavy on the API server — this is usually more useful than guessing:

```bash
# apiserver_request_total broken down by user-agent
kubectl get --raw '/metrics' 2>/dev/null \
  | grep '^apiserver_request_total' \
  | sort -t'"' -k2 \
  | head -n 40
```

If the output shows a specific controller dominating, the fix is on that controller (cache / informer / backoff), not on an imagined per-user throttle that the API server does not implement.
