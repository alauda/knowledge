---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500003
---

# Identifying Which Client Deleted a Node Object Using Kubernetes Audit Logs
## Issue

A worker node disappears from the cluster shortly after it joined, or vanishes during steady-state operation. `kubectl get nodes` no longer lists it, the kubelet on the host is healthy and continues to make heartbeat calls (which now create the node again under the same name and the cycle repeats), and there is no obvious controller status condition that explains the deletion.

The recurring question is *who* deleted the Node object. The Kubernetes audit log records every API write, including the identity of the client that issued it. With the right query, the audit log identifies the responsible service account, controller, or human user.

## Root Cause

Node deletion is a routine API call: `DELETE /api/v1/nodes/<name>`. Anything with `delete` permission on `nodes` can issue it. The usual deleters in a cluster are:

- A cluster operator running maintenance (a real human via `kubectl`).
- The cluster autoscaler removing an underused node.
- A node-lifecycle policy controller from a multi-cluster management or governance platform.
- A bespoke controller a team installed themselves.

Determining which one issued the deletion requires correlating the deletion event with the calling identity. That correlation lives in the `kube-apiserver` audit log, which records `verb`, `objectRef`, `user.username`, and `sourceIPs` for every request that crosses the API server.

## Resolution

Run a structured search of the apiserver audit log on each control-plane node, filtered to `delete` operations against the affected node's resource. The query below returns one line per matching audit event with the timestamp, verb, request URI, target object, calling identity, and source IP:

```bash
NODE=worker-01

kubectl get nodes -l node-role.kubernetes.io/control-plane \
  -o name \
  | while read -r master; do
      master_name=${master#node/}
      echo "===== $master_name ====="
      # Stream the apiserver audit log off this control-plane node.
      # Path is the kubeadm default; adjust to your cluster's audit
      # policy if you use a different sink.
      # ACP cluster PSA rejects `chroot /host`; read host files via the
      # debug pod's /host bind-mount. The image must contain `cat`.
      kubectl debug node/${master_name} \
        -it --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1 \
        -- cat /host/var/log/kube-apiserver/audit.log 2>/dev/null \
        | jq -cr --arg node "$NODE" '
            select(
              (.verb != "get") and (.verb != "watch") and
              (.objectRef.resource == "nodes") and
              (.objectRef.name == $node)
            )
            | "\(.stageTimestamp)|\(.verb)|\(.requestURI)|\(.user.username)|\(.sourceIPs[0])"
          ' \
        | column -t -s'|' \
        | sort -k1
  done
```

A typical hit:

```text
2026-04-23T00:45:25.943914Z  delete  /api/v1/nodes/worker-01  system:serviceaccount:cluster-policy:policy-controller-sa  10.0.5.42
```

The `user.username` field tells you exactly who issued the deletion: in this example the service account `policy-controller-sa` from the `cluster-policy` namespace. From that identifier you can:

- Inspect the namespace where the service account lives to discover which controller owns it.
- `kubectl auth can-i delete nodes --as=system:serviceaccount:cluster-policy:policy-controller-sa` to confirm the identity actually has the permission it used.
- Read the controller's logs over the same time window to see *why* it decided to delete the node.

If the username is a real human (e.g. `alice@example.com`), the deletion was a hands-on operation; investigate the human-side runbook that triggered it.

If the username belongs to a system controller you do not recognise, the controller is a candidate to disable, scope down via RBAC, or reconfigure so it stops removing nodes you want to keep.

### Scoping Down the Offending Identity

Once the identity is known, the safest tactical fix is to revoke its `delete` permission on `nodes` while you investigate the controller's behaviour:

```bash
kubectl create clusterrole node-delete-block \
  --verb=delete --resource=nodes --dry-run=client -o yaml \
  > /tmp/blocker.yaml
# Edit /tmp/blocker.yaml — add a rule that has the same shape but
# removes the binding instead of granting it; then look at existing
# ClusterRoleBindings on the offending SA:

kubectl get clusterrolebinding -o json \
  | jq '.items[] | select(.subjects[]? | .name == "policy-controller-sa")'
```

Remove the binding that grants `delete` on `nodes`. The controller will start logging permission errors instead of silently deleting nodes — which is the visibility you need to fix it properly.

## Diagnostic Steps

If the audit search above returns no rows, two failure modes are likely:

1. **Audit logging is not enabled.** Check the apiserver process arguments on a control-plane host:

   ```bash
   # `ps -ef` from a debug pod with --profile=sysadmin sees the host PID
   # namespace; chroot is not needed (and is rejected by ACP's PSA).
   kubectl debug node/<master> -it \
     --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1 --profile=sysadmin \
     -- ps -ef | grep kube-apiserver | grep -oE '\-\-audit-(log-path|policy-file)=[^ ]+'
   ```

   Both `--audit-policy-file` and `--audit-log-path` should be set. If they are not, configure an audit policy (a permissive policy that records all `verbs` against `nodes` is enough for this investigation) and roll the apiserver pods.

2. **The audit policy filters out the `delete` verb on `nodes`.** Inspect the audit policy:

   ```bash
   kubectl debug node/<master> -it \
     --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1 \
     -- cat /host<policy-file-path>
   ```

   Add a rule for the `nodes` resource at `level: Metadata` (or higher) so the deletion is recorded going forward.

After audit logging captures a deletion, the same query above will surface the responsible identity and the investigation can proceed with concrete evidence.
</content>
