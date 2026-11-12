---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - 3.12.x
  - 3.18.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Harbor notary-server fails with an expired x509 certificate on ACP

## Issue

A workload Pod reports an image pull failure from Harbor although nothing was changed, sometimes on a single Pod only. Or a Harbor Pod cannot start, or the Harbor registry is partly down. `kubectl -n <namespace> get pod` shows `<release>-harbor-notary-server-<hash>` at `0/1` and restarting while the other Harbor Pods are Running. Its events say `Container notary-server failed liveness probe, will be restarted` and `Readiness probe failed: HTTP probe failed with statuscode: 503`.

Seen from `harbor-core`, the Harbor login page or portal reports `核心服务不可用` ("core service unavailable"), or the web UI shows `internal server error`. Image pulls that used to work, including pulls from a public `library` project, start returning `unauthorized`. Harbor core, jobservice, and notary can all look failed at once. A restart of `harbor-core` brings the UI back for a while, then the outage returns.

The notary-server log reports an expired certificate while dialing the notary signer:

```text
Starting on :4443
Failed to dial <release>-harbor-notary-signer:7899: connection error: desc = "transport: x509: certificate has expired or is not yet valid: current time <now> is after <notAfter>"; please retry.
{"level":"error","msg":"Trust not fully operational: rpc error: code = 13 desc = connection error: desc = \"transport: x509: certificate has expired or is not yet valid: current time <now> is after <notAfter>\""}
```

The `Trust not fully operational` line repeats about every 10 seconds. The Harbor instance has been running for about a year without changes. The failure often appears right after the Harbor components were restarted. Waiting for cert-manager to reissue the certificate does not help, and editing a Harbor component workload or its resource limits does not clear the error.

## Root Cause

### Cause 1: the one-year notary TLS certificate issued by the Harbor operator expired

The notary TLS certificates (for notary-server and notary-signer) are created by the Harbor operator when it installs the component, with a lifetime of one year. It stays unchanged as long as the Harbor custom resource does not change. It is not controlled by cert-manager, so nothing renews it automatically. The `<notAfter>` time in the log is about one year after the Harbor instance was deployed or last changed.

A restart often exposes the problem: when the Harbor components restart, notary-server loads its TLS certificate again, and an already expired certificate prevents it from starting.

After `notAfter`, notary-server cannot complete TLS to notary-signer on port 7899, exits, and is restarted. Each restart opens another PostgreSQL session. The database Service and Pod look healthy while the connection limit is exhausted; `harbor-core` then loses its database sessions and the portal reports that the core service is unavailable. Restarting `harbor-core` frees its own sessions only until notary fills the pool again.

Any update of the Harbor instance that makes the operator reconcile the chart regenerates the certificate. Changing a component CPU or memory request on the Harbor resource is the usual edit. Every Harbor component restarts as part of that update. The same restart also clears a PostgreSQL connection left in recovery mode (`pq: cannot set transaction read-write mode during recovery` in the `harbor-core` log).

While image pull and push still work, the expired certificate does not affect them, and the update can wait for a quiet period. When the core service is already unavailable because notary is exhausting database sessions, it cannot wait. An expired notary certificate can also sit next to a separate push or pull failure; fix each by its own signature.

### Cause 2: the change was made on a component workload instead of the Harbor instance

The operator reissues the notary certificate when the Harbor instance (`kubectl get harbor -A`) changes. Adjusting the Deployment or StatefulSet of a Harbor component, for example its resource limits, does not trigger that, so notary-server keeps reporting the expired certificate.

### Cause 3: edits to the Harbor resource are reverted

An edit to the Harbor resource returns to its previous value shortly after saving, so the operator never reconciles a change. The Harbor custom resource carries the annotation `operator.devops.alauda.io/managed-by: harbor-operator` and the finalizer `finalizers.operator.devops.alauda.io`, so `harbor-operator` owns it. When the registry PVC was changed earlier and its size is not declared on the resource, the change is reverted. Declaring the registry PVC size under `spec.helmValues` lets the change stick:

```yaml
spec:
  helmValues:
    persistence:
      persistentVolumeClaim:
        registry:
          size: <current-registry-pvc-size>
```

## Resolution

### Cause 1: the one-year notary TLS certificate issued by the Harbor operator expired

1. Confirm that the notary-server log contains the expired-certificate dial error to port 7899 (Diagnostic Steps).

2. Back up the Harbor resource, write down the current request, and change one CPU or memory request on it, so that the operator regenerates the certificate. Any resource change that the operator reconciles is enough; the `patch` example changes only `core.resources.requests.cpu` to a value that differs from the current one, and `kubectl edit` on the same field is equivalent.

   > **Warning:** Saving the Harbor custom resource makes the operator restart all Harbor components of that instance; login, pushes, and pulls through this Harbor fail until those Pods are Ready. Do this in a maintenance window and only after the notary log shows `x509: certificate has expired or is not yet valid` (or `Failed to dial` the notary-signer Service on port 7899 with that error). Rollback of the request change is to put the previous CPU and memory requests back, which restarts the components again; the new certificate stays in place.

   ```bash
   kubectl get harbor -A
   kubectl get harbor -n <namespace> <harbor-name> -o yaml > "$HOME/harbor-before.yaml"
   kubectl get harbor -n <namespace> <harbor-name> -o jsonpath='{.spec.helmValues.core.resources.requests}{"\n"}'
   kubectl patch harbor -n <namespace> <harbor-name> --type=merge \
     -p '{"spec":{"helmValues":{"core":{"resources":{"requests":{"cpu":"<new-cpu-request>"}}}}}}'
   kubectl get pods -n <namespace> -o wide | grep -E 'harbor-core|harbor-notary|harbor-jobservice'
   ```

3. After `harbor-notary-server` and `harbor-notary-signer` are Running, confirm that the notary-server log no longer reports the x509 error and retry the image pull:

   ```bash
   kubectl get pods -n <namespace> | grep notary
   kubectl logs -n <namespace> <notary-server-pod> --tail=80
   ```

   If the Pods keep being deleted and recreated instead of rolling once, check whether the registry PVC is larger than the size the Harbor resource declares before editing again; see Cause 4 of [Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit](Harbor_core_service_unavailable_or_internal_server_error_stuck_instance_status_or_Pods_cycling_after_an_edit.md).

### Cause 2: the change was made on a component workload instead of the Harbor instance

1. Make the CPU or memory change on the Harbor instance instead, with the Warning and commands of Cause 1.
2. Check that the Harbor instance has a new `metadata.generation` and that the notary Pods were recreated:

   ```bash
   kubectl get harbor -n <namespace> <harbor-name> -o jsonpath='{.metadata.generation}{"\n"}'
   kubectl get pods -n <namespace> -o wide | grep notary
   ```

### Cause 3: edits to the Harbor resource are reverted

1. Confirm who owns and writes the Harbor resource:

   ```bash
   kubectl get harbor -n <namespace> <harbor-name> -o jsonpath='{.metadata.ownerReferences}{"\n"}{.metadata.annotations}{"\n"}'
   kubectl get harbor -n <namespace> <harbor-name> --show-managed-fields -o yaml | grep -E 'manager:|operation:|time:'
   ```

   The annotation `operator.devops.alauda.io/managed-by: harbor-operator` confirms that the operator owns it.

2. Read the current registry PVC size and the current `helmValues`:

   ```bash
   kubectl get harbor -n <namespace> <harbor-name> -o jsonpath='{.spec.helmValues}{"\n"}'
   kubectl get pvc -n <namespace> | grep -i registry
   ```

3. Add `spec.helmValues.persistence.persistentVolumeClaim.registry.size` with the registry PVC's current capacity, together with the CPU or memory change of Cause 1.

   > **Warning:** Saving the Harbor resource makes `harbor-operator` update the release and restart the Harbor components; pushes and pulls stop until the Pods are Ready. Do this only when the notary certificate is expired and earlier edits were reverted. Set `size` to the current capacity printed in step 2, never a smaller value. Back up the YAML first; rollback is `kubectl apply -f` of the backup.

   ```bash
   kubectl get harbor -n <namespace> <harbor-name> -o yaml > "$HOME/harbor-before.yaml"
   kubectl edit harbor -n <namespace> <harbor-name>
   ```

4. Check that the field stays, that the notary Pods are recreated, and that the notary log no longer shows the x509 error (step 3 of Cause 1). If the edit is still reverted, contact support with the Harbor resource YAML and the `managedFields` output.

## Diagnostic Steps

1. Read the notary-server log and confirm the error is an expired certificate on the dial to the signer, not an unknown authority:

   ```bash
   kubectl get pods -A | grep -i notary
   kubectl logs -n <namespace> <notary-server-pod> --tail=80 | grep -i x509
   ```

   Expected for this article: `x509: certificate has expired or is not yet valid` while dialing `<release>-harbor-notary-signer:7899`.

2. Confirm that cert-manager does not own the notary certificate:

   ```bash
   kubectl get certificate -n <namespace> | grep -i notary || echo "no cert-manager Certificate for notary"
   ```

   No `Certificate` object is expected; the operator writes the certificate. Optionally decode the certificate the notary Pod mounts and read `notAfter`; do not change the Harbor resource for a certificate that is still valid:

   ```bash
   kubectl -n <namespace> get secret -o name | grep -i notary
   kubectl -n <namespace> get secret <notary-tls-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject
   ```

3. When the portal reports that the core service is unavailable, check the PostgreSQL sessions against the limit:

   ```bash
   kubectl -n <postgresql-namespace> exec <postgresql-pod> -- psql -U postgres -c "SHOW max_connections;"
   kubectl -n <postgresql-namespace> exec <postgresql-pod> -- psql -U postgres -c \
     "SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;"
   ```

   Sessions at the limit while notary-server restarts on the x509 error: the core outage comes from Cause 1, and restarting `harbor-core` only helps until notary fills the pool again. No notary x509 error: see [{G3T}]({G3}).

4. Branch:

   - Image pull failure, core service unavailable, or `0/1` notary-server with the expired dial error, and no recent change to the Harbor instance: Cause 1.
   - The error remained after a resource change made on a component workload: Cause 2.
   - The Harbor resource returns to its previous content after an edit: Cause 3.
