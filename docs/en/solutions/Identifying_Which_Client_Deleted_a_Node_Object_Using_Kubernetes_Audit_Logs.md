---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500003
---

# Identifying Which Client Deleted a Node Object Using Kubernetes Audit Logs

## Issue

A Node object disappears from the cluster unexpectedly — for example a worker is removed shortly after it joins. Because Kubernetes Events do not record the identity of the requester that performed an operation, the cluster's own event stream cannot say which client deleted the Node. The authoritative record for attributing the deletion to a specific client is the kube-apiserver audit log, which captures the request verb, the target object, the requesting identity and the source IP for every API request [ev:c1].

## Root Cause

A Node object can be deleted by any authenticated subject — a human user or a ServiceAccount — that is bound to a role granting the `delete` verb on the `nodes` resource. On Alauda Container Platform a broad set of ClusterRoles carry node-delete permission, including ServiceAccount-bindable platform roles, so a controller running under a ServiceAccount is fully capable of removing a Node object [ev:c5]. When a Node vanishes, the question is therefore not whether a client could delete it but which client did — and that is answered from the audit log [ev:c1].

## Resolution

Confirm that audit logging is active on the kube-apiserver, then read the requesting identity out of the audit records [ev:c2].

On Alauda Container Platform the kube-apiserver runs as a static Pod `kube-apiserver-<node-ip>` in the `kube-system` namespace (image `kube-apiserver:v1.34.5`). Audit logging is enabled through the apiserver flags, and the records are written as JSON [ev:c2]:

```text
--audit-policy-file=/etc/kubernetes/audit/policy.yaml
--audit-log-path=/etc/kubernetes/audit/audit.log
--audit-log-format=json
--audit-log-mode=batch
```

Inspect the running apiserver Pod to confirm these flags are present before relying on the log [ev:c2]:

```bash
kubectl -n kube-system get pod kube-apiserver-<node-ip> \
  -o jsonpath='{.spec.containers[0].command}' | tr ',' '\n' | grep audit
```

The audit records follow the standard `audit.k8s.io/v1` Event shape. Each record for a Node deletion exposes `stageTimestamp`, `verb`, `requestURI`, `objectRef.resource`, `objectRef.name`, `user.username` and `sourceIPs` [ev:c3_a]. The audit log file is written on the control-plane node at the configured `--audit-log-path` and is read there [ev:c2].

## Diagnostic Steps

Filter the audit log for delete requests against the `nodes` resource that target the missing node; the matching record's `user.username` and `sourceIPs` identify the deleting client [ev:c3_b]. With the JSON-format log lines collected into a file, the following selects the relevant rows [ev:c3_a]:

```bash
NODE=<node-name>
jq -cr --arg node "$NODE" '
  select((.verb != "get") and (.verb != "watch")
    and (.objectRef.resource == "nodes")
    and (.objectRef.name == $node))
  | "\(.stageTimestamp)|\(.verb)|\(.requestURI)|\(.objectRef.resource)/\(.objectRef.name)|\(.user.username)|\(.sourceIPs)"
' audit.log | sort
```

A matching line such as a `delete` on `nodes/<node-name>` whose `user.username` is a ServiceAccount name confirms that a non-human client removed the Node [ev:c3_b]. Cross-reference that identity against the ClusterRoles that grant `delete` on `nodes` to determine which workload or controller holds the permission [ev:c5]:

```bash
kubectl get clusterrole -o json | jq -r '
  .items[] | select(any(.rules[]?;
    (.resources[]? == "nodes" or .resources[]? == "*")
    and (.verbs[]? == "delete" or .verbs[]? == "*")))
  | .metadata.name'
```
