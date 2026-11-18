---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# calico-node fails to start or Pods hang in ContainerCreating: dummy module, corrupted image, clock skew or x509 on ACP

## Issue

On a Calico cluster, `calico-node` does not start on a node, or Pods on a node stay in `ContainerCreating` with Calico errors. Typical reports:

- `calico-node` fails with `failed to connect kubernetes svc:443`.
- `calico-node` does not start on a node right after a VM live migration, and container DNS and logins fail.
- Pods stay in `ContainerCreating`, the kubelet log shows Calico errors while setting up the Pod network, and after a restart `calico-node` fails with `x509: certificate has expired or is not yet valid: current time ... is before ...`.
- After every node of the cluster was restarted, the Pods on one node stay in `ContainerCreating` with `plugin type="calico" failed (add): error getting ClusterInformation: ... x509: certificate signed by unknown authority`.

Each cause is a property of the node (kernel modules, local image store, clock), not of the Calico configuration.

Related articles: "Pod or Service traffic fails on some nodes because of the node kernel, OS, hypervisor or network path on ACP".

## Root Cause

### Cause 1: calico-node: failed to connect kubernetes svc:443, and the dummy kernel module is missing

`calico-node` fails to start with `failed to connect kubernetes svc:443`. The node has no dummy interface, and `lsmod` shows no `dummy` module because the module file is missing from `/lib/modules/$(uname -r)`.

### Cause 2: calico-node image layers are corrupted after a VM live migration

After the node VM was live-migrated, the local image layers of the `calico-node` image were corrupted, so the container could not start and Pod networking on the node failed.

### Cause 3: node clock out of sync, install-cni fails x509 verification

Pods stay in `ContainerCreating`, and restarting Calico makes it worse: `calico-node` no longer starts. Its `install-cni` container keeps exiting `1`, and its log shows the CNI binaries written to `/host/opt/cni/bin` followed by:

```text
[ERROR] cni-installer/token_watch.go 108: Unable to create token for CNI kubeconfig error=Post ".../api/v1/namespaces/kube-system/serviceaccounts/calico-cni-plugin/token": tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time <node-time> is before <certificate-not-before>
[FATAL] cni-installer/install.go 499: ...
```

The node clock was behind the start of the certificate's validity, so `install-cni` failed TLS verification when requesting the `calico-cni-plugin` token, and the Pod network could not be set up.

### Cause 4: x509: certificate signed by unknown authority from the Calico plugin after a full cluster restart

After every node was restarted, the Pods on one node stayed in `ContainerCreating` with:

```text
Failed to create pod sandbox: rpc error: code = Unknown desc = failed to setup network for sandbox "<id>": plugin type="calico" failed (add): error getting ClusterInformation: Get "https://<kubernetes-service-ip>:443/apis/crd.projectcalico.org/v1/clusterinformations/default": tls: failed to verify certificate: x509: certificate signed by unknown authority
```

followed by `Pod sandbox changed, it will be killed and re-created.` Every `calico-node` Pod was `1/1 Running` with routine logs, restarting `calico-node` did not help, and the node clock was correct. The Calico CNI plugin on that node could not verify the API server certificate; the exact mechanism was not determined. Restarting the node restored its Pods. This differs from Cause 3, where the message says the certificate `is not yet valid`.

## Resolution

### Cause 1: calico-node: failed to connect kubernetes svc:443, and the dummy kernel module is missing

Copy the `dummy` module from a node that runs exactly the same kernel version, rebuild the module index, load it, and recreate `calico-node`.

> **Warning:** A module built for another kernel can fail to load or destabilize the host. Compare `uname -r` on both nodes first. Roll back by removing the copied file and running `depmod -a` again.

```bash
uname -r
lsmod | grep dummy || modinfo dummy
# on a healthy node with the same kernel:
find /lib/modules/$(uname -r) -name 'dummy.ko*'
# copy that file to the same path on the affected node, then on the affected node:
depmod -a
modprobe dummy
kubectl -n kube-system delete pod <calico-node-pod-on-this-node>
```

### Cause 2: calico-node image layers are corrupted after a VM live migration

Stop kubelet, delete the local `calico-node` image, and start kubelet so a clean copy is pulled.

> **Warning:** With kubelet stopped, the node does not manage Pods. The pull after the delete fails if the node cannot reach the registry, so check registry access first. The delete cannot be undone; the pull replaces the image.

```bash
systemctl stop kubelet
crictl images | grep calico/node
crictl rmi <calico-node-image-id>
systemctl start kubelet
```

On a Docker node use `docker images` and `docker rmi -f` instead of `crictl`.

### Cause 3: node clock out of sync, install-cni fails x509 verification

Compare the clock with a healthy node and synchronize it from the site time source; restarting Calico before that does not help. Then retry the Pods.

```bash
date -u; timedatectl
chronyc tracking || true
chronyc makestep
```

### Cause 4: x509: certificate signed by unknown authority from the Calico plugin after a full cluster restart

Rule out the clock first (Cause 3), then restart the affected node.

> **Warning:** Restarting the node stops every Pod on it. Drain it first and restart one node at a time; uncordon it when it is back. Nothing needs to be rolled back.

```bash
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
# on the node:
systemctl reboot
# from a master, once the node is Ready:
kubectl uncordon <node-name>
```

## Diagnostic Steps

1. Read the Pod events and the kubelet log on the affected node:

   ```bash
   kubectl describe pod <pod> -n <namespace> | grep -A3 FailedCreatePodSandBox
   journalctl -u kubelet --since '-30m' | grep -i calico | tail -n 20
   kubectl get pods -A -o wide | grep -E 'calico|ContainerCreating'
   ```

2. Read the `install-cni` log when `calico-node` is not starting:

   ```bash
   kubectl -n kube-system logs <calico-node-pod> -c install-cni --previous | grep -E 'x509|is before|token'
   ```

3. Check the node properties:

   ```bash
   lsmod | grep dummy
   date -u; timedatectl
   ```

- `failed to connect kubernetes svc:443` with no `dummy` module: Cause 1.
- A failure that starts right after a VM live migration: Cause 2.
- `x509: certificate has expired or is not yet valid: current time ... is before ...` from `install-cni`, with a node clock behind the other nodes: Cause 3.
- `x509: certificate signed by unknown authority` from the Calico plugin after a full cluster restart, with a correct clock: Cause 4.
