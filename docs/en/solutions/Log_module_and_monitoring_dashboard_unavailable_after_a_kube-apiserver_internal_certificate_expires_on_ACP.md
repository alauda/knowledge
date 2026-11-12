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

# Log module and monitoring dashboard unavailable after a kube-apiserver internal certificate expires on ACP

## Issue

One of the following happens on a cluster that has been running for a long time, while the nodes can still be Ready:

- The log module and the monitoring dashboard can no longer be opened. The kube-apiserver process on a control-plane node has been running for more than one year.
- An inspection says the `apiserver-loopback-client` certificate expires in a few days.
- The console shows `服务器内部错误` (server internal error), and platform Pods such as `dex` and `tke-platform` went down and cannot start again.
- After the kube-apiserver, kube-controller-manager, and kube-scheduler certificates were renewed, Pods are no longer scheduled and started automatically.
- A Deployment stays in Progressing while its Pods are Running, and restarting or deleting the Pods does not help. The Kubernetes Certificates Rotator plugin was uninstalled earlier.

## Root Cause

Kubernetes control-plane processes load some certificates only at startup. A process that keeps running holds what it loaded, so a certificate can be expired in memory while the files on disk are valid, and a renewed file on disk has no effect until the process restarts.

### Cause 1: kube-apiserver has been running for more than one year and an internal certificate it holds has expired

`kube-apiserver` stayed up for more than one year, and an internal certificate held by that process reached `notAfter` while the process kept running. The log module and the monitoring dashboard both fail until the kube-apiserver container is restarted. A restart does not rewrite any file on disk: it regenerates the in-memory loopback certificate (Cause 2) and reloads the files under `/etc/kubernetes/pki/`. If a file on disk is itself past `notAfter`, the new process loads the same expired file, so that file has to be renewed first (Cause 4).

On ACP, kube-apiserver runs as a static Pod. etcd is a different static Pod (`etcd-<node>`, label `component=etcd`, in `kube-system`), and restarting kube-apiserver does not touch it.

### Cause 2: the apiserver-loopback-client certificate is about to expire or has expired

`apiserver-loopback-client` is a self-signed certificate that kube-apiserver generates in memory at startup, valid for one year, and uses only to call itself. It has no file on disk and cannot be rotated externally, so it expires one year after the process started. Restarting kube-apiserver is the only fix, because the new process generates a new pair.

When the loopback certificate has already expired, the effect can be a full platform outage: the console shows an internal error, and platform Pods such as `dex` and `tke-platform` cannot start again. Restarting kube-apiserver, and then the affected Pods, restores the platform.

### Cause 3: control-plane certificates were renewed on disk but the components were not restarted

The certificates of kube-apiserver, kube-controller-manager, and kube-scheduler were renewed on disk, but the running components still hold the old certificates because they were not restarted, and Pods stop being scheduled. Restarting the static Pods makes them load the new files.

### Cause 4: the Certificates Rotator plugin was uninstalled and the Kubernetes component certificates expired

The Kubernetes Certificates Rotator plugin issues short-lived certificates (365 days for control-plane certificates). When the plugin is uninstalled, the certificates it already wrote stay short-lived and are no longer rotated, so they expire. Workloads then show symptoms such as a Deployment stuck in Progressing. Regenerating the Kubernetes component certificates returns the cluster to normal.

## Resolution

### Cause 1: kube-apiserver has been running for more than one year and an internal certificate it holds has expired

1. On the control-plane node, print when kube-apiserver started, the certificate the running process serves on the loopback name, and the certificate files on disk:

   ```bash
   ps -eo lstart,cmd | grep kube-apiserver | grep -v grep
   openssl s_client -connect 127.0.0.1:6443 -servername apiserver-loopback-client </dev/null 2>/dev/null | openssl x509 -noout -subject -dates
   openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates -subject -issuer
   openssl x509 -in /etc/kubernetes/pki/apiserver-kubelet-client.crt -noout -dates -subject -issuer
   openssl x509 -in /etc/kubernetes/pki/apiserver-etcd-client.crt -noout -dates -subject -issuer
   openssl x509 -in /etc/kubernetes/pki/front-proxy-client.crt -noout -dates -subject -issuer
   ```

   Continue when the process started more than one year ago, the certificate it holds is past `notAfter`, and the files on disk are in date. If a file on disk is past `notAfter`, renew it first with Cause 4.

2. Restart the kube-apiserver container by stopping it; kubelet starts a new one from the static Pod manifest.

   > **Warning:** Restarting kube-apiserver on this node drops the API requests this instance is handling; on a single control-plane cluster the API is unavailable until the new container is Ready. Use a maintenance window and restart one control-plane node at a time. Do this only after step 1 confirmed the signature. Certificate files are not modified, and there is no rollback to the previous process. If the new container does not become Ready, read the kubelet logs on that node and confirm that `/etc/kubernetes/manifests/kube-apiserver.yaml` is in place.

   ```bash
   crictl ps --name kube-apiserver
   crictl stop <container-id>
   crictl ps --name kube-apiserver
   ```

   `kubectl delete pod -n kube-system kube-apiserver-<node>` does not restart it: that object is only the mirror of the static Pod, and kubelet recreates the mirror while the container keeps running. The same applies to the other static Pods.

3. When the CREATED time of the new container is current, open the log module and the monitoring dashboard again.

### Cause 2: the apiserver-loopback-client certificate is about to expire or has expired

1. Restart kube-apiserver on each control-plane node in turn, during an off-peak window, by moving its static Pod manifest out of the manifests directory and back. Use a directory outside `/etc/kubernetes/manifests` for the temporary copy, because kubelet reads every manifest file in that directory. Wait until each node's kube-apiserver is Running before moving to the next node.

   > **Warning:** While the manifest is out, kube-apiserver on this node is stopped and requests to it fail; on a single control-plane cluster the whole API is down until the Pod is back. Do this one node at a time. Rollback is to move the manifest back, which is also the second half of the procedure; never leave it in the backup directory.

   ```bash
   mkdir -p /etc/kubernetes/manifests-backup
   mv /etc/kubernetes/manifests/kube-apiserver.yaml /etc/kubernetes/manifests-backup/
   # wait until the container is gone
   crictl ps | grep kube-apiserver
   mv /etc/kubernetes/manifests-backup/kube-apiserver.yaml /etc/kubernetes/manifests/
   crictl ps | grep kube-apiserver
   kubectl get pod kube-apiserver-<node> -n kube-system
   ```

   Moving the file back before kubelet has stopped the old container can leave the old process running. The `crictl stop` method of Cause 1 is equivalent.

2. If platform Pods such as `dex` or `tke-platform` stayed down while the loopback certificate was expired, restart them after every kube-apiserver has been restarted.

   > **Warning:** Deleting these Pods interrupts login (`dex`) and the platform API (`tke-platform`) until the replacements are Running. Do this only after the kube-apiserver restarts, and only for Pods that are not Running. Their workloads recreate them.

   ```bash
   kubectl get pods -A | grep -v -E 'Running|Completed'
   kubectl delete pod -n <namespace> <failed-pod>
   ```

### Cause 3: control-plane certificates were renewed on disk but the components were not restarted

1. Confirm that the files on disk are newer than the running processes:

   ```bash
   ls -l --time-style=full-iso /etc/kubernetes/pki/*.crt
   ps -eo lstart,cmd | grep -E 'kube-apiserver|kube-controller-manager|kube-scheduler' | grep -v grep
   ```

2. Restart the three components one node at a time with the manifest move of Cause 2 (its Warning applies). kube-controller-manager and kube-scheduler are leader-elected, so another control-plane node takes over while one is stopped.

   ```bash
   mkdir -p /etc/kubernetes/manifests-backup
   for c in kube-apiserver kube-controller-manager kube-scheduler; do
     mv /etc/kubernetes/manifests/$c.yaml /etc/kubernetes/manifests-backup/
     sleep 20
     mv /etc/kubernetes/manifests-backup/$c.yaml /etc/kubernetes/manifests/
     sleep 30
     crictl ps | grep $c
   done
   ```

3. Check that new Pods are scheduled.

### Cause 4: the Certificates Rotator plugin was uninstalled and the Kubernetes component certificates expired

1. Print the component certificates on each control-plane node:

   ```bash
   kubeadm certs check-expiration 2>/dev/null
   for f in /etc/kubernetes/pki/*.crt; do echo "$f"; openssl x509 -in "$f" -noout -enddate; done
   ```

2. Regenerate the expired certificates with the `cert-renew` tooling, following "Recovering ACP Kubernetes Certificates with Kubernetes Certificates Rotator". That procedure backs up `/etc/kubernetes`, re-signs the files with the cluster CA on every node, and restarts the components.

   On a control plane that has the `kubeadm` binary, `kubeadm certs renew all` is the standard kubeadm alternative.

   > **Warning:** Renewing control-plane certificates rewrites the files under `/etc/kubernetes/pki` and the kubeconfig files kubeadm manages on this node, and the components must be restarted afterwards (Cause 3). Do this only when step 1 shows files past `notAfter`. Back up `/etc/kubernetes` first; rollback is to restore that copy and restart the static Pods. Repeat on each control-plane node.

   ```bash
   cp -a /etc/kubernetes /etc/kubernetes.bak-$(date +%Y%m%d)
   kubeadm certs renew all
   ```

   `kubeadm certs renew all` issues the kubeadm default one-year lifetime and also rewrites the client certificate in `/etc/kubernetes/admin.conf`, which is then no longer a long-lived credential. Print its `notAfter` before relying on it.

3. Restart the control-plane components with Cause 3 and confirm that the Deployment leaves Progressing.

## Diagnostic Steps

1. Separate a long-running kube-apiserver from expired files and from an expired platform credential:

   ```bash
   ps -eo lstart,cmd | grep kube-apiserver | grep -v grep
   openssl x509 -in /etc/kubernetes/pki/apiserver-kubelet-client.crt -noout -enddate
   openssl s_client -connect 127.0.0.1:6443 -servername apiserver-loopback-client </dev/null 2>/dev/null | openssl x509 -noout -enddate
   ```

2. Branch:

   - Log module and monitoring dashboard unavailable, kube-apiserver up for more than one year, the held certificate past `notAfter`, files on disk in date: Cause 1.
   - Inspection names `apiserver-loopback-client`, or the console shows an internal error and `dex` or `tke-platform` cannot start while the loopback certificate is expired: Cause 2.
   - Certificate files on disk are newer than the process start, and Pods stopped scheduling: Cause 3.
   - A client outside the node, such as a pipeline `kubectl`, fails with `x509: certificate has expired or is not yet valid` against `https://<address>:6443`, and the log module and monitoring dashboard are not the symptom: first identify the certificate that address serves and compare it with `apiserver.crt` on each control-plane node. A load balancer or VIP in front of port 6443 can present its own certificate.

     ```bash
     echo | openssl s_client -connect <address>:6443 2>/dev/null | openssl x509 -noout -subject -issuer -dates
     openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -subject -issuer -dates
     ```
   - Deployment stuck in Progressing, Certificates Rotator uninstalled, component certificate files expired: Cause 4.
   - The console returns HTTP 500 and the platform `global-kubeconfig` Secret is expired: not this article. See "Console returns HTTP 500 or clusters show abnormal because the global-kubeconfig or cluster kubeconfig Secret expired on ACP".
