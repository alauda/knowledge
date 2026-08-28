---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.x'
---

# Recovering ACP Kubernetes Certificates with Kubernetes Certificates Rotator

## Issue

After Kubernetes Certificates Rotator issues short-lived certificates, uninstalling the plugin does not restore the previous long-lived certificates. Certificates already written to a node remain unchanged, and automatic renewal stops when the plugin is removed.

This procedure is for an approved emergency recovery. It re-signs existing certificates with the cluster's current CA certificates and private keys. It is not a standard maintenance operation and does not extend the CA itself.

## Environment

This procedure applies to an ACP cluster that uses kubeadm-style files under `/etc/kubernetes` and has the `cert-renew` tool files delivered by Kubernetes Certificates Rotator. The plugin namespace is normally `cpaas-system`; confirm the installed release and image tag before using a tool from a different release.

Run the recovery separately on every node in the cluster, including all control-plane and worker nodes. The script changes only the local files on the node where it runs; running it on one node does not update any other node. Worker nodes normally do not have the CA private key. Because the script requires a CA private key, the approved recovery plan must define how to provide, protect, and remove the key on each worker node.

## Resolution

### 1. Verify the delivered tools

The plugin image provides `cert-renew` and `renew-all.sh`. Obtain both files from a frontend Pod or the matching OCI image, then copy them to every target node. Do not look for them at `/cluster-cert-rotator/download` on the host.

Inspect the ConfigMap, then use a ready frontend Pod to export the tool files:

```bash
PLUGIN_NAMESPACE=${PLUGIN_NAMESPACE:-cpaas-system}
kubectl -n "${PLUGIN_NAMESPACE}" get configmap cert-renew-download \
  -o jsonpath='{.data.images}'

FRONTEND_POD=$(kubectl -n "${PLUGIN_NAMESPACE}" get pod \
  -l 'app.cpaas.io/name=frontend' \
  -o jsonpath='{.items[0].metadata.name}')
POD_TOOL_DIR=/static/store/target/cluster-cert-rotator/download
kubectl -n "${PLUGIN_NAMESPACE}" exec "${FRONTEND_POD}" -c alauda-console -- \
  ls -l "${POD_TOOL_DIR}/cert-renew" "${POD_TOOL_DIR}/renew-all.sh"
mkdir -p ./cert-renew-files
kubectl -n "${PLUGIN_NAMESPACE}" cp -c alauda-console \
  "${FRONTEND_POD}:${POD_TOOL_DIR}/cert-renew" ./cert-renew-files/cert-renew
kubectl -n "${PLUGIN_NAMESPACE}" cp -c alauda-console \
  "${FRONTEND_POD}:${POD_TOOL_DIR}/renew-all.sh" ./cert-renew-files/renew-all.sh
chmod 755 ./cert-renew-files/cert-renew ./cert-renew-files/renew-all.sh
```

Transfer the two files to every target node through the site's approved file-transfer path, for example to `/var/tmp/cluster-cert-rotator/`. Run the files from the host as root. Do not expect these files to appear on the host automatically. The image is distroless and non-root. It is not a containerized recovery job because the script requires the host's Bash, certificate paths, and `systemctl`.

#### Obtain the tools when the plugin is not installed

If the plugin is not installed, obtain the matching `ait/cert-renew:<tag>` OCI image on an administrative workstation with registry access, then extract `cert-renew` and `renew-all.sh`:

For example, use `skopeo` to copy the image to a temporary directory, then extract the tool files from the image layers:

```bash
IMAGE=build-harbor.alauda.cn/ait/cert-renew:<installed-tag>
IMAGE_DIR=$(mktemp -d)
mkdir -p ./cert-renew-files
skopeo copy --override-os linux --override-arch amd64 \
  "docker://${IMAGE}" "dir:${IMAGE_DIR}"

extract_from_image() {
  name="$1"
  output="$2"
  for digest in $(jq -r '.layers[].digest | sub("^sha256:"; "")' "${IMAGE_DIR}/manifest.json"); do
    if tar -tzf "${IMAGE_DIR}/${digest}" | grep -qx "${name}"; then
      tar -xOzf "${IMAGE_DIR}/${digest}" "${name}" > "${output}"
      return 0
    fi
  done
  echo "${name} was not found in ${IMAGE}" >&2
  return 1
}

extract_from_image cert-renew ./cert-renew-files/cert-renew
extract_from_image renew-all.sh ./cert-renew-files/renew-all.sh
chmod 755 ./cert-renew-files/cert-renew ./cert-renew-files/renew-all.sh
```

For an arm64 target, change `--override-arch amd64` to `--override-arch arm64`. Verify the image tag against the installed plugin release, then transfer the extracted files to every target node through the approved path.

### 2. Check CA validity

A certificate signed by a CA cannot remain valid after that CA expires. Check all three CA certificates before choosing a duration:

```bash
for ca in \
  /etc/kubernetes/pki/ca.crt \
  /etc/kubernetes/pki/etcd/ca.crt \
  /etc/kubernetes/pki/front-proxy-ca.crt; do
  echo "=== ${ca} ==="
  openssl x509 -in "${ca}" -noout -subject -dates
done
```

Set `SAFE_DAYS` to the number of whole days from the current time to the earliest CA `notAfter`, minus an operational safety margin. Use a fixed value of `3650` only when every relevant CA has at least ten years remaining; this is uncommon for a kubeadm cluster. If a CA is already expired or its private key is unavailable, stop. This procedure cannot repair the CA. Use a separate CA rotation or cluster recovery plan.

### 3. Back up node files

The tool rewrites files in place. On each node, create a protected backup before making changes. Keep the backup until that node passes the post-recovery checks:

```bash
BACKUP_DIR=/var/backups/cluster-cert-rotator/$(date +%Y%m%d%H%M%S)
install -d -m 700 "${BACKUP_DIR}"
cp -a /etc/kubernetes "${BACKUP_DIR}/"
cp -a /var/lib/kubelet/pki "${BACKUP_DIR}/"
if [ -f /root/.kube/config ]; then
  install -D -m 600 /root/.kube/config "${BACKUP_DIR}/root/.kube/config"
fi
```

The backup contains CA private keys. Restrict access to the backup. Remove it only according to the site's approved retention procedure for sensitive backups.

### 4. Run the recovery on every node

First list the cluster nodes and create a node-by-node execution checklist:

```bash
kubectl get nodes -o wide
```

Then, on each node in the checklist, run the script with an explicit duration and the absolute path to the delivered tool:

```bash
SAFE_DAYS=<CA-bounded-days>
TOOL_DIR=/cluster-cert-rotator/download

env CERT_DAYS="${SAFE_DAYS}" \
    CERT_RENEW_TOOL="${TOOL_DIR}/cert-renew" \
    bash "${TOOL_DIR}/renew-all.sh"
```

The script uses the main CA for API server and kubelet files, the etcd CA for etcd files, and the front-proxy CA for `front-proxy-client.crt`. It updates the following files when they exist:

- `apiserver.crt`, `apiserver-kubelet-client.crt`, `kubelet.crt`, and `kubelet-client-current.pem`
- `admin.conf`, `super-admin.conf`, `controller-manager.conf`, `scheduler.conf`, and `/root/.kube/config`
- `etcd/server.crt`, `etcd/peer.crt`, and `apiserver-etcd-client.crt`
- `front-proxy-client.crt`

For kubeconfigs that embed a client certificate, the tool replaces the certificate data and keeps the existing private key. For kubeconfigs that reference a certificate file, the tool updates the referenced file.

The script touches the `kube-apiserver`, `kube-controller-manager`, and `kube-scheduler` static Pod manifests, then restarts kubelet. It does not explicitly touch `etcd.yaml`. Verify etcd health and determine separately whether etcd must be restarted or certificates reloaded.

The script does not stop immediately when an individual file update fails. Do not treat the final `Done` message as proof of success. Inspect the command output and complete the verification steps below.

### 5. Verify the results

Check the new validity windows for every changed PEM certificate and every kubeconfig client certificate. Each new `notAfter` value must be on or before the selected CA boundary date:

```bash
for cert in \
  /etc/kubernetes/pki/apiserver.crt \
  /etc/kubernetes/pki/apiserver-kubelet-client.crt \
  /etc/kubernetes/pki/kubelet.crt \
  /var/lib/kubelet/pki/kubelet-client-current.pem \
  /etc/kubernetes/pki/etcd/server.crt \
  /etc/kubernetes/pki/etcd/peer.crt \
  /etc/kubernetes/pki/apiserver-etcd-client.crt \
  /etc/kubernetes/pki/front-proxy-client.crt; do
  if [ -f "${cert}" ]; then
    echo "=== ${cert} ==="
    openssl x509 -in "${cert}" -noout -subject -dates
  fi
done
```

After recovering each node, verify node and control-plane health:

```bash
systemctl is-active kubelet
kubectl get nodes
kubectl get pods -n kube-system -o wide
```

Check the kubelet and control-plane logs for restart failures. Confirm etcd endpoint health separately. Repeat steps 3 through 5 on every node. On a multi-control-plane cluster, process one approved control-plane node at a time and wait for the control plane to become healthy before proceeding. Process worker nodes one at a time according to the site's approved maintenance order.

## Root Cause

Kubernetes Certificates Rotator changes the requested duration through its controller configuration, but removing the plugin does not rewrite certificates that it already issued. The standalone `cert-renew` utility signs replacement certificates with the existing CA and sets `NotAfter` to `now + days`; it does not inspect or clamp that value to the CA expiry. The effective lifetime is bounded by whichever comes first: the requested duration or the CA expiry.

## Rollback

If a post-recovery check fails on any node, stop changing additional nodes and preserve the command output. Restore that node's files from the protected backup. After restoring the files, repeat the static Pod and kubelet restart actions, then verify API server, kubelet, and etcd health before proceeding to another node.
