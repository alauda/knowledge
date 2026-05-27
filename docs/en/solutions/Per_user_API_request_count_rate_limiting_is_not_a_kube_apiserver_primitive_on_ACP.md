---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500203
---

# Per-user API request-count rate limiting is not a kube-apiserver primitive on ACP

## Issue

Cluster administrators on Alauda Container Platform (ACP install package v4.3.13, server `v1.34.5`, kube-apiserver image `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`) sometimes ask for a built-in way to cap "N requests per user per second/minute" at the API server — for example, to stop a runaway client from issuing `kubectl get pods` at high rate. The kube-apiserver ACP runs is the upstream Kubernetes API server, and that server does not expose a request-count-based throttle per authenticated user or client; there is no field, flag, or admission resource that implements such a quota. The same gap applies in any equivalent distribution because the apiserver inherits the upstream design.

## Root Cause

What the upstream kube-apiserver does ship is API Priority and Fairness (APF), served at GA at `flowcontrol.apiserver.k8s.io/v1` on this cluster, with `FlowSchema` and `PriorityLevelConfiguration` as built-in cluster-scoped kinds. APF is a concurrency-and-fairness mechanism: a `FlowSchema` selects which authenticated subjects a rule applies to and points the matching requests at a `PriorityLevelConfiguration`, whose tunables (`nominalConcurrencyShares`, `queues`, `handSize`, `queueLengthLimit`, plus `type: Limited|Exempt`) shape in-flight concurrency — not requests-per-time-window. The `FlowSchema.spec` exposes only `distinguisherMethod`, `matchingPrecedence`, `priorityLevelConfiguration`, and `rules`; there is no `maxRequestsPerSecond` or `requestsPerMinute` style field anywhere in the schema, and `distinguisherMethod` (e.g. `ByUser`, `ByNamespace`) merely groups requests into fair-share queues inside a priority level rather than imposing a per-subject rate cap.

The native Kubernetes APIs themselves carry no user-level request-count throttle. The `FlowSchema` subject selector is a *matching* construct, and no other built-in API group provides a per-user-per-time-window quota; the apiserver's own command-line surface confirms the same — no `--rate-limit`, no `--per-user-*`, no `--max-requests` flag is configured, and APF being GA upstream since Kubernetes 1.29 means it is unconditionally on without a feature-gate toggle.

## Resolution

Treat APF as the supported control-plane stability mechanism and configure it through the standard built-in objects. The cluster already ships the upstream default set of FlowSchemas — `exempt`, `probes`, `system-leader-election`, `system-node-high`, `system-nodes`, `kube-controller-manager`, `kube-scheduler`, `kube-system-service-accounts`, `service-accounts`, `global-default`, and `catch-all` — bound to the upstream default PriorityLevelConfigurations (`exempt`, `system`, `node-high`, `leader-election`, `workload-high`, `workload-low`, `global-default`, `catch-all`) with concurrency shapes such as `Limited` + `nominalConcurrencyShares` + `queues` + `handSize` + `queueLengthLimit`:

```bash
kubectl get flowschemas.flowcontrol.apiserver.k8s.io
kubectl get prioritylevelconfigurations.flowcontrol.apiserver.k8s.io
```

To carve out a separate concurrency lane for a specific authenticated subject, define a `FlowSchema` that selects that subject and routes it to a `PriorityLevelConfiguration` with the desired concurrency shape — this is the only in-cluster knob that targets a particular user, and it acts on parallel in-flight load, not requests-per-window:

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: noisy-client
spec:
  matchingPrecedence: 9000
  priorityLevelConfiguration:
    name: workload-low
  distinguisherMethod:
    type: ByUser
  rules:
    - subjects:
        - kind: User
          user:
            name: alice
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
```

If the requirement is genuinely a per-user request-count quota over a time window, place that policy *outside* the cluster — at the front-door load balancer or firewall that fronts the API server (HAProxy, F5, NGINX, etc.). That layer is customer-managed network infrastructure and is outside the cluster's API surface; the kube-apiserver itself will not implement the policy.

## Diagnostic Steps

Confirm that the admission machinery in the cluster does not implement a per-user throttle either. Listing the admission-registration kinds returns only the four upstream resources — `MutatingWebhookConfiguration`, `ValidatingWebhookConfiguration`, `ValidatingAdmissionPolicy`, and `ValidatingAdmissionPolicyBinding`, all under `admissionregistration.k8s.io/v1` — and none of them is a request-count throttle resource:

```bash
kubectl api-resources | grep -i admission
```

Inspect the kube-apiserver static-pod manifest to confirm the running flag set does not include a per-user or request-count rate limiter. On ACP the kube-apiserver runs as a static pod in the `kube-system` namespace; describe it and review the `Command:` section — the configured flags cover authentication mode (`Node,RBAC`), etcd endpoints and TLS, audit, admission plugins (such as `NodeRestriction`, `OwnerReferencesPermissionEnforcement`, `DenyServiceExternalIPs`), and token handling, with no `--rate-limit`, no `--per-user-*`, and no `--max-requests-inflight`-style per-subject quota flag present:

```bash
kubectl get pods -n kube-system -l component=kube-apiserver
kubectl describe pod -n kube-system kube-apiserver-<control-plane-node>
```

Confirm the APF API surface itself is live on the cluster — both kinds are served at GA `flowcontrol.apiserver.k8s.io/v1` and the default FlowSchemas and PriorityLevelConfigurations are present, which is the in-cluster surface to use when concurrency or fairness needs tuning:

```bash
kubectl api-resources --api-group=flowcontrol.apiserver.k8s.io
kubectl get flowschema catch-all -o yaml
kubectl get prioritylevelconfiguration global-default -o yaml
```
