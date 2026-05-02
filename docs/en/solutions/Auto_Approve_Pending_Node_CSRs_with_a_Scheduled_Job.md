---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500023
---

# Auto-Approve Pending Node CSRs with a Scheduled Job

## Issue

Node kubelets periodically submit CertificateSigningRequests (CSRs) to renew their client and serving certificates. When the controller responsible for approving them is not running, or when CSRs arrive from workloads faster than an operator can process manually, new nodes stall in `NotReady` and existing nodes fail `kubectl logs`, `kubectl exec`, and `kubectl port-forward` with TLS errors. Manual approval through `kubectl certificate approve` does not scale and is error-prone during incidents.

## Root Cause

Kubernetes does not auto-approve arbitrary CSRs by design — unrestricted approval is a cluster-admin-equivalent privilege. For kubelet CSRs the default controller-manager approves new node CSRs that match strict criteria (correct `system:nodes` signer, recognised node identity, permitted key usage). Anything outside that narrow set is left pending, including:

- Kubelet serving CSRs (`kubernetes.io/kubelet-serving`), which are intentionally **not** auto-approved by default.
- CSRs submitted by custom operators that issue their own client certificates.
- Bulk CSR bursts during a node fleet reboot, which can momentarily exceed the controller's rate budget.

A narrow, scoped Job or CronJob that approves CSRs matching a clear predicate is a pragmatic way to keep the cluster healthy without handing broad signing power to everyone.

## Resolution

Run a least-privilege CronJob that approves pending CSRs with a predictable cadence. Scope the RBAC so the Job can only approve CSRs, not sign them or mint arbitrary certificates.

1. **Create a dedicated namespace and ServiceAccount.**

   ```bash
   kubectl create namespace csr-approver
   kubectl -n csr-approver create serviceaccount csr-approver
   ```

2. **Grant only the verbs needed.** The `approve`/`deny` verbs on `certificatesigningrequests` are the minimum required; do not grant `cluster-admin`.

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRole
   metadata:
     name: csr-approver
   rules:
     - apiGroups: ["certificates.k8s.io"]
       resources: ["certificatesigningrequests"]
       verbs: ["get", "list", "watch"]
     - apiGroups: ["certificates.k8s.io"]
       resources: ["certificatesigningrequests/approval"]
       verbs: ["update"]
     - apiGroups: ["certificates.k8s.io"]
       resources: ["signers"]
       resourceNames:
         - "kubernetes.io/kubelet-serving"
         - "kubernetes.io/kube-apiserver-client-kubelet"
       verbs: ["approve"]
   ---
   apiVersion: rbac.authorization.k8s.io/v1
   kind: ClusterRoleBinding
   metadata:
     name: csr-approver
   subjects:
     - kind: ServiceAccount
       name: csr-approver
       namespace: csr-approver
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: csr-approver
   ```

3. **Schedule the approver.** A 5-minute cadence catches serving CSRs quickly without busy-looping. Filter by `.spec.signerName` so the Job never touches user or third-party CSRs.

   ```yaml
   apiVersion: batch/v1
   kind: CronJob
   metadata:
     name: csr-approver
     namespace: csr-approver
   spec:
     schedule: "*/5 * * * *"
     successfulJobsHistoryLimit: 1
     failedJobsHistoryLimit: 3
     concurrencyPolicy: Forbid
     jobTemplate:
       spec:
         backoffLimit: 0
         ttlSecondsAfterFinished: 300
         template:
           spec:
             serviceAccountName: csr-approver
             restartPolicy: Never
             containers:
               - name: approver
                 image: bitnami/kubectl:1.33
                 command:
                   - /bin/sh
                   - -ec
                   - |
                     for name in $(kubectl get csr \
                         -o jsonpath='{range .items[?(@.status.conditions==null)]}{.metadata.name}{"\n"}{end}'); do
                       signer=$(kubectl get csr "$name" -o jsonpath='{.spec.signerName}')
                       case "$signer" in
                         kubernetes.io/kubelet-serving|kubernetes.io/kube-apiserver-client-kubelet)
                           echo "approving $name ($signer)"
                           kubectl certificate approve "$name"
                           ;;
                         *)
                           echo "skipping $name ($signer)"
                           ;;
                       esac
                     done
   ```

4. **Bound the blast radius.** A blanket "approve every CSR" script is effectively `cluster-admin`, because a malicious pod can submit a CSR that grants itself arbitrary identities. Always filter by signer, and ideally also by the CSR's requester (`.spec.username`) so only known-good accounts are served.

5. **Audit.** Turn on CSR audit events and confirm every approval the Job performs corresponds to a real node. The `ttlSecondsAfterFinished` above ensures old Job pods are cleaned up; a separate `Succeeded`-phase reaper is unnecessary.

## Diagnostic Steps

List pending CSRs and their signers:

```bash
kubectl get csr \
  -o custom-columns='NAME:.metadata.name,SIGNER:.spec.signerName,REQUESTOR:.spec.username,AGE:.metadata.creationTimestamp' \
  | sort -k4
```

Only pending entries:

```bash
kubectl get csr -o json \
  | jq -r '.items[] | select(.status.conditions == null)
           | "\(.metadata.name)\t\(.spec.signerName)\t\(.spec.username)"'
```

After applying the CronJob, watch the first run and confirm only the expected signers are approved:

```bash
kubectl -n csr-approver get jobs --watch
kubectl -n csr-approver logs job/$(kubectl -n csr-approver get jobs -o jsonpath='{.items[-1].metadata.name}')
```

Inspect audit logs to verify the ServiceAccount used the `approval` subresource and nothing else. If the Job starts approving CSRs it should not, remove the `signers` resourceNames entries and narrow the in-Job `case` filter — both checks must pass before the approval goes through.
