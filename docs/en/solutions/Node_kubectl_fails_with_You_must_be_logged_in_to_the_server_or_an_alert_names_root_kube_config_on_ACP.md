---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# Node kubectl fails with You must be logged in to the server or an alert names root kube config on ACP

## Issue

One of the following happens on a control-plane node:

- `kubectl` fails, or only works when `--kubeconfig` points at `/etc/kubernetes/admin.conf`:

  ```text
  "Unhandled Error" err="couldn't get current server API group list: the server has asked for the client to provide credentials"
  error: You must be logged in to the server (the server has asked for the client to provide credentials)
  ```

- The platform raises `平台组件证书的到期时间即将到期(小于 30 天) <= 30d 且持续 1 分钟` (platform component certificate expires in less than 30 days), and the alert object is a file on a node rather than a Secret: `name: /root/.kube/config,node: <node>`. `kubectl` on that node still works. The questions are whether the file renews automatically, how to read its expiry date on the node, and how to back it up before changing it.
- Pod `node-local-certs-exporter` on the global cluster is in `Error`, and its log mentions `cert-tool export` and an invalid ConfigMap key.

Whether Kubernetes client certificates that are valid for one year renew automatically: the node file `/root/.kube/config` does not. The platform Secrets `global-kubeconfig` and `<cluster>-kubeconfig` are a different credential, covered in "Console returns HTTP 500 or clusters show abnormal because the global-kubeconfig or cluster kubeconfig Secret expired on ACP".

## Root Cause

### Cause 1: the client certificate in /root/.kube/config is past notAfter

Decoding `client-certificate-data` in `/root/.kube/config` shows `Issuer: CN = kubernetes`, `Subject: O = system:masters, CN = kubernetes-admin`, and a `notAfter` about one year after issue. That one-year client certificate is not renewed automatically, so `kubectl` with the default kubeconfig is rejected once it expires.

`/etc/kubernetes/admin.conf` on the same node holds a long-lived client certificate for the same identity. From ACP 4.4 its default validity is 10 years; older installations can have a longer one. Copying `admin.conf` over `/root/.kube/config` restores `kubectl`. The long lifetime holds only while `admin.conf` has not been re-issued by `kubeadm certs renew all`, which rewrites it with the kubeadm default one-year certificate, so always print its `notAfter` before relying on it.

### Cause 2: the one-year certificate in /root/.kube/config is inside the 30-day alert window

Certificate monitoring checks `/root/.kube/config` on each node, which is why the alert carries a `node` label, and it fires once fewer than 30 days remain. Because nothing renews the file, the alert stays until the file is replaced. Copying the still-valid `admin.conf` over it before the old certificate expires renews it, and the alert clears.

Other objects listed in the same alert follow their own renewal. For example, `asm-istio-cacerts-<cluster>` in `cpaas-system` on global is renewed automatically by cert-manager about 15 days before expiry and needs no action while that cluster exists.

### Cause 3: node-local-certs-exporter rejects /root/.kube/config and cert-tool export fails

`node-local-certs-exporter` checks Kubernetes certificate expiry on the node and writes the result to ConfigMap `node-local-certs-<node>`. It builds a data key from the kubeconfig path and the context name, such as `root_.kube_config:<context>`. A ConfigMap key must match `[-._a-zA-Z0-9]+`, so a context name with a colon makes `cert-tool export` fail, and the Pod goes to `Error`. This is a known defect fixed in ACP 4.4. Replacing `/root/.kube/config` with `/etc/kubernetes/admin.conf` restores the Pod.

## Resolution

### Cause 1: the client certificate in /root/.kube/config is past notAfter

1. Print both client certificates on the node:

   ```bash
   awk '/client-certificate-data/ {print $2}' /root/.kube/config | base64 -d | openssl x509 -noout -dates -subject -issuer
   awk '/client-certificate-data/ {print $2}' /etc/kubernetes/admin.conf | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

   Continue when `/root/.kube/config` is expired or unreadable and `admin.conf` still has a future `notAfter`.

2. Back up the file and copy `admin.conf` over it.

   > **Warning:** The copy overwrites `/root/.kube/config` for root on this node; contexts and users that existed only in the old file are gone from the active file. Do this only when the `admin.conf` certificate printed in step 1 is in date, on the node whose `kubectl` or exporter is failing. Rollback is `cp -a /root/.kube/config.bak /root/.kube/config`. This does not rotate the API server or etcd serving certificates.

   ```bash
   cp -a /root/.kube/config /root/.kube/config.bak
   cp /etc/kubernetes/admin.conf /root/.kube/config
   kubectl get nodes
   ```

   `kubectl get nodes` should list the cluster. Repeat on every control-plane node, not only the one in the open shell.

3. If the console also returns an internal error, check the platform kubeconfig Secrets as described in "Console returns HTTP 500 or clusters show abnormal because the global-kubeconfig or cluster kubeconfig Secret expired on ACP".

### Cause 2: the one-year certificate in /root/.kube/config is inside the 30-day alert window

1. Log in to the node the alert names and print both certificates with step 1 of Cause 1. Continue when `/root/.kube/config` shows about one year of validity with fewer than 30 days left, and `admin.conf` shows a `notAfter` well beyond it. If `admin.conf` also shows only about one year, it may have been re-issued by `kubeadm certs renew all`; do not copy it.

2. Back up the file and copy `admin.conf` over it, with the Warning and commands of step 2 of Cause 1. Then confirm the new end date:

   ```bash
   awk '/client-certificate-data/ {print $2}' /root/.kube/config | base64 -d | openssl x509 -noout -enddate
   ```

   It now prints the `admin.conf` end date. Repeat on every node the alert names; each node has its own copy of the file. The alert clears after the next check.

3. For Secret-type objects in the same alert, check the Certificate on global instead of changing anything:

   ```bash
   kubectl get certificate -n cpaas-system asm-istio-cacerts-<cluster> -o custom-columns='NAME:.metadata.name,READY:.status.conditions[?(@.type=="Ready")].status,RENEW:.status.renewalTime,SECRET:.spec.secretName'
   ```

### Cause 3: node-local-certs-exporter rejects /root/.kube/config and cert-tool export fails

1. Confirm the signature in the Pod log: `cert-tool export` and an invalid ConfigMap key with a colon (`root_.kube_config:<context>`), or a format error while reading `/root/.kube/config`.

   ```bash
   kubectl get pods -A | grep node-local-certs-exporter
   kubectl logs -n <namespace> <node-local-certs-exporter-pod> --tail=40
   ```

2. On the node the Pod runs on, replace the file with step 2 of Cause 1, including the backup and its Warning. The exporter Pod then leaves `Error`. Clusters that run the exporter of a release before 4.4 need this workaround; upgrading to 4.4 fixes the key generation.

## Diagnostic Steps

1. On a control-plane node, separate an expired client file from an expired serving certificate:

   ```bash
   awk '/client-certificate-data/ {print $2}' /root/.kube/config | base64 -d | openssl x509 -noout -dates -subject -issuer
   awk '/client-certificate-data/ {print $2}' /etc/kubernetes/admin.conf | base64 -d | openssl x509 -noout -dates -subject -issuer
   openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates -subject -issuer
   openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates -subject -issuer
   ```

   Copying `admin.conf` fixes only the client file. If `apiserver.crt` or another serving file is the expired object, it needs its own renewal.

2. Read every object in a certificate alert. A `name:` that is a path plus a `node:` label is a node file; a `name:` with `secret_namespace:` is a Secret.

3. Branch:

   - `kubectl` fails with `You must be logged in to the server` and `/root/.kube/config` is past `notAfter`: Cause 1.
   - The alert names `/root/.kube/config` and the file still has fewer than 30 days left: Cause 2.
   - `node-local-certs-exporter` is `Error` with a `cert-tool export` key error: Cause 3.
