---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB260800061
sourceSHA: a2033d53d40cfea2cec2b03770770d6f1b648791f794b41a3f3b4d6158cb433c
---

# 使用 Kubernetes 证书轮换器恢复 ACP Kubernetes 证书

## 问题

在 Kubernetes 证书轮换器发放短期证书后，卸载插件不会恢复之前的长期证书。已写入节点的证书保持不变，并且在移除插件后自动续订停止。

此操作步骤用于经过批准的紧急恢复。它使用集群当前的 CA 证书和私钥重新签署现有证书。这不是标准的维护操作，也不会扩展 CA 本身。

## 环境

此操作步骤适用于使用 kubeadm 风格文件的 ACP 集群，文件位于 `/etc/kubernetes` 下，并且具有由 Kubernetes 证书轮换器提供的 `cert-renew` 工具文件。插件命名空间通常为 `cpaas-system`；在使用不同版本的工具之前，请确认已安装的版本和镜像标签。

在集群中的每个节点上单独运行恢复，包括所有控制平面和工作节点。该脚本仅更改运行它的节点上的本地文件；在一个节点上运行不会更新其他节点。工作节点通常没有 CA 私钥。由于脚本需要 CA 私钥，批准的恢复计划必须定义如何在每个工作节点上提供、保护和移除该密钥。

## 解决方案

### 1. 验证交付的工具

插件镜像提供 `cert-renew` 和 `renew-all.sh`。从前端 Pod 或匹配的 OCI 镜像中获取这两个文件，然后将它们复制到每个目标节点。不要在主机的 `/cluster-cert-rotator/download` 中查找它们。

检查 ConfigMap，然后使用准备好的前端 Pod 导出工具文件：

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

通过站点批准的文件传输路径将这两个文件传输到每个目标节点，例如传输到 `/var/tmp/cluster-cert-rotator/`。以 root 身份从主机运行这些文件。不要期望这些文件会自动出现在主机上。该镜像是无发行版的且非 root。它不是一个容器化的恢复作业，因为脚本需要主机的 Bash、证书路径和 `systemctl`。

#### 在未安装插件时获取工具

如果未安装插件，请在具有注册表访问权限的管理工作站上获取匹配的 `ait/cert-renew:<tag>` OCI 镜像，然后提取 `cert-renew` 和 `renew-all.sh`：

例如，使用 `skopeo` 将镜像复制到临时目录，然后从镜像层中提取工具文件：

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
  echo "${name} 在 ${IMAGE} 中未找到" >&2
  return 1
}

extract_from_image cert-renew ./cert-renew-files/cert-renew
extract_from_image renew-all.sh ./cert-renew-files/renew-all.sh
chmod 755 ./cert-renew-files/cert-renew ./cert-renew-files/renew-all.sh
```

对于 arm64 目标，将 `--override-arch amd64` 更改为 `--override-arch arm64`。验证镜像标签与已安装的插件版本，然后通过批准的路径将提取的文件传输到每个目标节点。

### 2. 检查 CA 有效性

由 CA 签署的证书在该 CA 过期后不能保持有效。在选择持续时间之前检查所有三个 CA 证书：

```bash
for ca in \
  /etc/kubernetes/pki/ca.crt \
  /etc/kubernetes/pki/etcd/ca.crt \
  /etc/kubernetes/pki/front-proxy-ca.crt; do
  echo "=== ${ca} ==="
  openssl x509 -in "${ca}" -noout -subject -dates
done
```

将 `SAFE_DAYS` 设置为从当前时间到最早 CA `notAfter` 的完整天数，减去操作安全边际。仅在每个相关 CA 至少还有十年时使用固定值 `3650`；这在 kubeadm 集群中并不常见。如果 CA 已过期或其私钥不可用，请停止。此操作步骤无法修复 CA。请使用单独的 CA 轮换或集群恢复计划。

### 3. 备份节点文件

该工具会就地重写文件。在每个节点上，在进行更改之前创建受保护的备份。直到该节点通过恢复后检查之前，请保留备份：

```bash
BACKUP_DIR=/var/backups/cluster-cert-rotator/$(date +%Y%m%d%H%M%S)
install -d -m 700 "${BACKUP_DIR}"
cp -a /etc/kubernetes "${BACKUP_DIR}/"
cp -a /var/lib/kubelet/pki "${BACKUP_DIR}/"
if [ -f /root/.kube/config ]; then
  install -D -m 600 /root/.kube/config "${BACKUP_DIR}/root/.kube/config"
fi
```

备份包含 CA 私钥。限制对备份的访问。仅根据站点批准的敏感备份保留程序删除它。

### 4. 在每个节点上运行恢复

首先列出集群节点并创建逐节点执行检查表：

```bash
kubectl get nodes -o wide
```

然后，在检查表中的每个节点上，使用显式持续时间和交付工具的绝对路径运行脚本：

```bash
SAFE_DAYS=<CA-限制的天数>
TOOL_DIR=/cluster-cert-rotator/download

env CERT_DAYS="${SAFE_DAYS}" \
    CERT_RENEW_TOOL="${TOOL_DIR}/cert-renew" \
    bash "${TOOL_DIR}/renew-all.sh"
```

该脚本使用主 CA 更新 API 服务器和 kubelet 文件，使用 etcd CA 更新 etcd 文件，使用前端代理 CA 更新 `front-proxy-client.crt`。当存在时，它会更新以下文件：

- `apiserver.crt`、`apiserver-kubelet-client.crt`、`kubelet.crt` 和 `kubelet-client-current.pem`
- `admin.conf`、`super-admin.conf`、`controller-manager.conf`、`scheduler.conf` 和 `/root/.kube/config`
- `etcd/server.crt`、`etcd/peer.crt` 和 `apiserver-etcd-client.crt`
- `front-proxy-client.crt`

对于嵌入客户端证书的 kubeconfig，该工具会替换证书数据并保留现有私钥。对于引用证书文件的 kubeconfig，该工具会更新引用的文件。

该脚本会触及 `kube-apiserver`、`kube-controller-manager` 和 `kube-scheduler` 静态 Pod 清单，然后重启 kubelet。它不会显式触及 `etcd.yaml`。验证 etcd 健康状况，并单独确定是否需要重启 etcd 或重新加载证书。

当单个文件更新失败时，脚本不会立即停止。不要将最终的 `完成` 消息视为成功的证明。检查命令输出并完成以下验证步骤。

### 5. 验证结果

检查每个更改的 PEM 证书和每个 kubeconfig 客户端证书的新有效期。每个新的 `notAfter` 值必须在所选 CA 边界日期之前或等于该日期：

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

在恢复每个节点后，验证节点和控制平面的健康状况：

```bash
systemctl is-active kubelet
kubectl get nodes
kubectl get pods -n kube-system -o wide
```

检查 kubelet 和控制平面日志以查找重启失败。单独确认 etcd 端点健康。对每个节点重复步骤 3 到 5。在多控制平面集群中，逐个处理经过批准的控制平面节点，并在继续之前等待控制平面变为健康。根据站点批准的维护顺序逐个处理工作节点。

## 根本原因

Kubernetes 证书轮换器通过其控制器配置更改请求的持续时间，但移除插件不会重写它已发放的证书。独立的 `cert-renew` 工具使用现有 CA 签署替换证书，并将 `NotAfter` 设置为 `now + days`；它不会检查或限制该值到 CA 过期。有效的生命周期由请求的持续时间或 CA 过期中最早的一个限制。

## 回滚

如果任何节点的恢复后检查失败，请停止更改其他节点并保留命令输出。从受保护的备份中恢复该节点的文件。恢复文件后，重复静态 Pod 和 kubelet 重启操作，然后在继续到另一个节点之前验证 API 服务器、kubelet 和 etcd 的健康状况。
