---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Node certificates expire and the automatic renewal process stalls, causing a cascade of failures:

- The API server rejects kubelet requests with x509 certificate errors:

```
Unable to authenticate the request" err="[x509: certificate has expired or is not yet valid:
current time xxxx-xx-xxxx is after xxxx-xx-xxxx
```

- CNI agent pods on affected nodes enter `CrashLoopBackOff`:

```
certificate signing request csr-xxxxx is approved, waiting to be issued
failed to start the node certificate manager: certificate was not signed: context deadline exceeded
```

- Multiple Certificate Signing Requests (CSRs) remain in `Approved` state but are never issued.

## Root Cause

The kube-controller-manager's certificate signing controller stops issuing certificates even though CSRs have been approved. This creates a backlog of pending CSRs. Without valid certificates, the kubelet on affected nodes cannot authenticate to the API server, and CNI components that depend on node certificates fail to initialize.

## Resolution

Recover each affected node by removing the stale kubelet PKI and forcing certificate reissuance.

### Step 1: Delete Stale Kubelet PKI

SSH into the affected node and remove the PKI directory:

```bash
ssh <node-address>
sudo rm -rf /var/lib/kubelet/pki
```

### Step 2: Restart the Kubelet

```bash
sudo systemctl restart kubelet
```

The kubelet generates a new private key and submits a fresh CSR to the API server upon startup.

### Step 3: Approve Pending CSRs

From a control-plane node or workstation with cluster admin access, approve the new CSR:

```bash
kubectl get csr
kubectl certificate approve <csr-name>
```

If multiple nodes are affected, approve all pending CSRs at once:

```bash
kubectl get csr -o name | xargs -I{} kubectl certificate approve {}
```

### Step 4: Verify Recovery

Confirm the node returns to `Ready` status:

```bash
kubectl get nodes
```

Check that CNI pods on the recovered node are running:

```bash
kubectl get pods -n kube-system --field-selector spec.nodeName=<node-name>
```

## Diagnostic Steps

### Inspect API Server Certificate Errors

```bash
kubectl logs -n kube-system kube-apiserver-<node-name> --tail=200 | \
  grep "certificate has expired"
```

### List CSRs and Their Status

```bash
kubectl get csr
```

Look for CSRs stuck in `Approved` without progressing to `Issued`.

### Verify kube-controller-manager Health

```bash
kubectl get pods -n kube-system | grep kube-controller-manager
kubectl logs -n kube-system kube-controller-manager-<node-name> --tail=100
```

If the kube-controller-manager is unhealthy or showing certificate-related errors itself, troubleshoot the control-plane certificates first.

### Check CNI Pod Logs

```bash
kubectl logs -n kube-system <cni-pod-name> --tail=50 | grep -i "certificate\|csr\|x509"
```
