---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Expired Node Certificates Cause CSR Backlog and CNI Pod Crashes
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

Recover each affected node by restoring a bootstrap path so kubelet can request a fresh client certificate, then approving the CSR it emits.

> **Important on modern kubeadm clusters:** `/etc/kubernetes/kubelet.conf` references `/var/lib/kubelet/pki/kubelet-client-current.pem` as a **file** — not an inline-embedded cert. When that file is missing and `/etc/kubernetes/bootstrap-kubelet.conf` has already been removed (the standard post-join state), kubelet has no valid identity, cannot submit a CSR, and will crash-loop with `failed to run Kubelet: unable to load bootstrap kubeconfig`. Simply `rm`-ing the PKI dir and restarting kubelet is **not enough** — you must also hand kubelet a fresh bootstrap kubeconfig first.

### Step 1: Create a Bootstrap Token

On a control-plane node (or anywhere with cluster-admin kubectl), mint a bootstrap token the affected node can use to authenticate:

```bash
kubeadm token create --print-join-command
```

If `kubeadm` is not on the workstation, create the token Secret directly:

```bash
TOKEN_ID=$(head -c 3 /dev/urandom | xxd -p)
TOKEN_SECRET=$(head -c 8 /dev/urandom | xxd -p)
EXP=$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: bootstrap-token-${TOKEN_ID}
  namespace: kube-system
type: bootstrap.kubernetes.io/token
stringData:
  token-id: ${TOKEN_ID}
  token-secret: ${TOKEN_SECRET}
  usage-bootstrap-authentication: "true"
  usage-bootstrap-signing: "true"
  auth-extra-groups: system:bootstrappers:kubeadm:default-node-token
  expiration: "${EXP}"
EOF
echo "token: ${TOKEN_ID}.${TOKEN_SECRET}"
```

### Step 2: Write Bootstrap Kubeconfig on the Node

On the affected node, rebuild `/etc/kubernetes/bootstrap-kubelet.conf`. Reuse the CA data that's already embedded in `/etc/kubernetes/kubelet.conf`:

```bash
ssh <node-address>
CA_DATA=$(sudo grep certificate-authority-data /etc/kubernetes/kubelet.conf | awk '{print $2}')
API_SERVER=$(sudo grep "server:" /etc/kubernetes/kubelet.conf | awk '{print $2}')
sudo tee /etc/kubernetes/bootstrap-kubelet.conf >/dev/null <<EOF
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${CA_DATA}
    server: ${API_SERVER}
  name: default-cluster
contexts:
- context:
    cluster: default-cluster
    user: kubelet-bootstrap
  name: default-context
current-context: default-context
kind: Config
users:
- name: kubelet-bootstrap
  user:
    token: <TOKEN_FROM_STEP_1>
EOF
sudo chmod 600 /etc/kubernetes/bootstrap-kubelet.conf
```

### Step 3: Remove Stale PKI and Restart Kubelet

With the bootstrap kubeconfig in place, kubelet has a way to authenticate when the file-backed client cert is missing:

```bash
sudo rm -rf /var/lib/kubelet/pki
sudo systemctl restart kubelet
```

Kubelet now boots in bootstrap mode, generates a fresh private key, and submits a CSR signed with the bootstrap token.

### Step 4: Approve the Pending CSR

From the workstation with cluster-admin access:

```bash
kubectl get csr
kubectl certificate approve <csr-name>
```

For multiple affected nodes at once:

```bash
kubectl get csr -o name | xargs -I{} kubectl certificate approve {}
```

The built-in CSR approver may also approve it automatically (via group `system:bootstrappers:kubeadm:default-node-token`), so this step is sometimes a no-op.

### Step 5: Verify Recovery

Confirm the node returns to `Ready` and the CNI pods there are running:

```bash
kubectl get nodes
kubectl get pods -n kube-system --field-selector spec.nodeName=<node-name>
```

After the node stabilizes, `/etc/kubernetes/bootstrap-kubelet.conf` is no longer needed — you can delete it to prevent a stale token from lingering on disk.

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
