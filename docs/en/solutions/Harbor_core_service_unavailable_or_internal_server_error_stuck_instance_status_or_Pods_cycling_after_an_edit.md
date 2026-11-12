---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.12"
  - "4.2"
  - "4.3"
---

# Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit

## Issue

The Harbor login page or portal reports that the core service is unavailable (`核心服务不可用`, "core service unavailable"), or the web UI shows `internal server error`. Image pulls that used to work, including pulls from a public `library` project, start returning `unauthorized`. Harbor core, jobservice, and Notary can all look failed at once. Related signs:

- `harbor-notary-server` restarts and logs `transport: x509: certificate has expired or is not yet valid`.
- A restart of `harbor-core` brings the UI back for a while, then the outage returns.
- The instance page stays on `Please wait for several minutes for Harbor deployment to complete` although the Pods are Running.
- After the Harbor resource is edited, every Harbor Pod is deleted and recreated again and again.

Related articles: [harbor-nginx or portal does not start or keeps restarting: IP address family unsupported or OOMKilled](harbor-nginx_or_portal_does_not_start_or_keeps_restarting_IP_address_family_unsupported_or_OOMKilled.md).

## Root Cause

### Cause 1: the Notary TLS certificates expired

`harbor-notary-server` logs `transport: x509: certificate has expired or is not yet valid`, usually with `Failed to dial <release>-harbor-notary-signer:7899` and `Trust not fully operational`. This cause, including why it makes the core service unavailable, is covered in [Harbor notary-server fails with an expired x509 certificate on ACP](Harbor_notary-server_fails_with_an_expired_x509_certificate_on_ACP.md).

### Cause 2: harbor-core needs a restart (internal server error, no other signature)

The UI shows `internal server error` or `core service unavailable`, pulls fail with `unauthorized`, Notary does not log an expired certificate, and PostgreSQL has free sessions. A restart of `harbor-core` clears the error and restores pulls. The underlying fault has not been identified. The same restart also recovers a portal that shows `核心服务不可用` right after a container-platform expansion. If the outage returns within hours, the cause is Cause 1, not this one.

### Cause 3: the instance status stays on "Please wait for several minutes for Harbor deployment to complete"

The Harbor Pods are Running and the portal answers, but the instance status text stays on the starting message. Restarting the Harbor core process resumes status synchronization. The underlying cause has not been identified. Resetting unrelated instance fields (for example an OIDC job field) does not clear the message.

### Cause 4: every Harbor Pod cycles after the Harbor resource was edited, and the registry PVC is larger than the declared size

After an edit of the Harbor resource (such as the Cause 1 update), all Harbor Pods are deleted and restarted repeatedly instead of rolling once. This happens when the registry PVC was expanded beyond the size declared in the Harbor resource, for example a `<release>-harbor-registry` PVC of `500Gi` while the resource still declares `200Gi`. Kubernetes does not allow a PVC request to be reduced, so the reconcile cannot apply the declared size. The size in `helmValues` must be set to the PVC's actual size.

## Resolution

### Cause 1

When `harbor-notary-server` logs `transport: x509: certificate has expired or is not yet valid`, follow the Resolution of [Harbor notary-server fails with an expired x509 certificate on ACP](Harbor_notary-server_fails_with_an_expired_x509_certificate_on_ACP.md).

### Cause 2

Restart only the core Deployment.

> **Warning:** Only when the UI shows `internal server error` or `core service unavailable`, the Notary log has no `certificate has expired`, and PostgreSQL has free sessions (see Diagnostic Steps). Impact: in-flight API calls, logins, and pushes fail until the new Pod is Ready. The Deployment recreates the Pod; nothing needs to be rolled back. If the same error returns within hours, stop restarting core and apply Cause 1.

```bash
NS=<harbor-namespace>
CORE=$(kubectl -n "$NS" get deploy -o name | grep harbor-core | head -1)
kubectl -n "$NS" rollout restart "$CORE"
kubectl -n "$NS" rollout status "$CORE"
```

### Cause 3

Restart the core Deployment and check the instance status.

> **Warning:** Only when the Harbor Pods are Running and the status is still `Please wait for several minutes for Harbor deployment to complete`, and no operator upgrade is in progress. Impact: the Harbor API is interrupted for one rollout. The Deployment recreates the Pod; nothing needs to be rolled back.

```bash
NS=<harbor-namespace>
NAME=<harbor-name>
CORE=$(kubectl -n "$NS" get deploy -o name | grep harbor-core | head -1)
kubectl -n "$NS" rollout restart "$CORE"
kubectl -n "$NS" rollout status "$CORE"
kubectl -n "$NS" get harbor "$NAME" -o jsonpath='{.status.conditions}{"\n"}'
```

### Cause 4

1. Compare the registry PVC with the size the Harbor resource declares:

   ```bash
   NS=<harbor-namespace>
   NAME=<harbor-name>
   kubectl -n "$NS" get pvc | grep registry
   kubectl -n "$NS" get pvc <registry-pvc> -o jsonpath='{.spec.resources.requests.storage}{" "}{.status.capacity.storage}{"\n"}'
   kubectl -n "$NS" get harbor "$NAME" -o yaml | grep -n -i -E 'registryStorageSize|persistentVolumeClaim|size:'
   ```

2. Set the declared registry size to the PVC's actual size. Component volumes are under `spec.helmValues.persistence.persistentVolumeClaim`, where the registry entry is `registry.size`; confirm that key on the live object before patching.

   > **Warning:** Only when the registry PVC is larger than the declared size and the Pods cycle after an edit of the Harbor resource. Impact: the operator reconciles again and Harbor components restart once more. Precondition: save the resource with the first command below, and use the PVC capacity exactly as printed (for example `500Gi`), never a smaller value. Rollback: apply the saved file, which returns the size mismatch.

   ```bash
   kubectl -n "$NS" get harbor "$NAME" -o yaml > "$HOME/harbor-$NAME-before-size.yaml"
   kubectl -n "$NS" patch harbor "$NAME" --type=merge -p \
     '{"spec":{"helmValues":{"persistence":{"persistentVolumeClaim":{"registry":{"size":"<actual-pvc-size>"}}}}}}'
   kubectl -n "$NS" get pods -w
   ```

3. If the Pods still cycle with matching sizes, read the log of the operator that manages the instance:

   ```bash
   kubectl get deploy -A | grep -E 'harbor-operator|devops-tools-operator'
   kubectl -n <operator-namespace> logs deploy/<operator-deployment> --tail=200
   ```

## Diagnostic Steps

A core restart fixes Cause 2 and Cause 3 only. When Cause 1 is active it is a temporary pause.

```bash
NS=<harbor-namespace>
kubectl get harbor -A
kubectl -n "$NS" get pods -o wide
kubectl -n "$NS" get events --sort-by=.lastTimestamp | tail -30
```

1. Read the Notary log first:

   ```bash
   NOTARY=$(kubectl -n "$NS" get pods -o name | grep harbor-notary-server | head -1)
   kubectl -n "$NS" logs "$NOTARY" --tail=80
   ```

   Cause 1 is confirmed when the log contains `transport: x509: certificate has expired or is not yet valid`, or `Failed to dial` a Service ending in `harbor-notary-signer:7899` with the same text. Optionally decode the certificate the Notary Pod mounts and read `notAfter`; do not patch the Harbor resource for a certificate that is still valid:

   ```bash
   kubectl -n "$NS" get secret -o name | grep -i notary
   kubectl -n "$NS" get secret <notary-tls-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject
   ```

2. Check the PostgreSQL sessions against the limit:

   ```bash
   kubectl -n <postgresql-namespace> exec <postgresql-pod> -- psql -U postgres -c "SHOW max_connections;"
   kubectl -n <postgresql-namespace> exec <postgresql-pod> -- psql -U postgres -c \
     "SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;"
   ```

   Sessions at the limit while Notary restarts on the x509 error: Cause 1. Sessions well below the limit and no `idle in transaction` pile-up, with no Notary error: Cause 2. Sessions at the limit without a Notary error: see [Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)](Harbor_PostgreSQL_rejects_sessions_with_too_many_clients_already_SQLSTATE_53300.md). If the database Pod is Pending or not Running, see [Harbor PostgreSQL database Pod never starts after an operator upgrade, with transparent huge pages, low CPU, or on NFS](Harbor_PostgreSQL_database_Pod_never_starts_after_an_operator_upgrade_with_transparent_huge_pages_low_CPU_or_on_NFS.md).

3. Cause 3 is the starting message on the instance while all Pods are Running. Ignore it when Notary or nginx is in `CrashLoopBackOff`.

4. Cause 4 is all Harbor Pods cycling after an edit of the Harbor resource, with a registry PVC larger than the declared size (step 1 of Cause 4).
