---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.x'
---

# 使用 Kubernetes Certificates Rotator 恢复 ACP Kubernetes 证书

## 问题

Kubernetes Certificates Rotator 已经签发短有效期证书后，卸载插件不会自动恢复之前的长有效期证书。节点上已经写入的证书保持不变，插件移除后也不会再发生自动续期。

本文步骤只用于经过批准的紧急恢复。它使用集群当前的 CA 证书和私钥重新签发现有证书，不是日常维护操作，也不会延长 CA 自身的有效期。

## 环境

本文适用于使用 kubeadm 风格 `/etc/kubernetes` 文件布局，并且已经由 Kubernetes Certificates Rotator 交付 `cert-renew` 工具文件的 ACP 集群。插件命名空间通常是 `cpaas-system`；执行前先确认已安装插件的版本和镜像标签，不要直接使用其他版本的工具。

恢复操作必须在集群中的每个节点上分别执行，包括所有控制平面节点和工作节点。该脚本只修改当前节点的本地文件，在一台节点上执行不会更新其他节点。工作节点通常没有 CA 私钥；由于脚本需要 CA 私钥才能运行，获批的恢复方案必须明确规定如何临时提供、保护并清理工作节点上的 CA 私钥。

## 解决方案

### 1. 确认交付的工具

插件镜像提供 `cert-renew` 和 `renew-all.sh`。从 `frontend` Pod 或匹配的 OCI 镜像中获取这两个文件，再传到每个目标节点；不要在宿主机的 `/cluster-cert-rotator/download` 路径下查找。

先检查配置映射，然后从一个就绪的 `frontend` Pod 导出工具文件：

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

将这两个文件通过站点批准的文件传输方式传到每个目标节点，例如 `/var/tmp/cluster-cert-rotator/`，再以 root 用户身份在宿主机执行。不能假设宿主机上会自动出现文件。该镜像是 distroless、非 root 镜像，不是可以直接运行的容器化恢复作业：脚本需要宿主机的 Bash、证书路径和 `systemctl`。

#### 插件未安装时获取工具

如果插件未安装，应在有镜像仓库访问权限的管理工作站获取匹配的 `ait/cert-renew:<tag>` OCI 镜像，并从中提取 `cert-renew` 和 `renew-all.sh`：

例如，使用 `skopeo` 将镜像保存到临时目录，再从镜像层中提取工具文件：

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

目标节点为 arm64 时将 `--override-arch amd64` 改为 `--override-arch arm64`。核对镜像标签与已安装插件版本一致，再通过批准的路径将提取出的文件传到每个目标节点。

### 2. 检查 CA 有效期

由 CA 签发的证书不能在 CA 过期后继续使用。选择有效期前检查三套 CA 证书：

```bash
for ca in \
  /etc/kubernetes/pki/ca.crt \
  /etc/kubernetes/pki/etcd/ca.crt \
  /etc/kubernetes/pki/front-proxy-ca.crt; do
  echo "=== ${ca} ==="
  openssl x509 -in "${ca}" -noout -subject -dates
done
```

将 `SAFE_DAYS` 设为从当前时间到最早 CA `notAfter` 的完整天数，再减去一个运维安全余量。只有所有相关 CA 都至少剩余十年时，固定使用 `3650` 才成立；对于 kubeadm 集群通常不能这样假设。如果 CA 已经过期，或 CA 私钥不可用，应停止操作：该流程不能修复 CA，需要单独的 CA 轮换或集群恢复方案。

### 3. 备份节点资源

工具会原地改写文件。必须在每个节点修改前创建受保护的备份，并在该节点恢复验证通过前保留：

```bash
BACKUP_DIR=/var/backups/cluster-cert-rotator/$(date +%Y%m%d%H%M%S)
install -d -m 700 "${BACKUP_DIR}"
cp -a /etc/kubernetes "${BACKUP_DIR}/"
cp -a /var/lib/kubelet/pki "${BACKUP_DIR}/"
if [ -f /root/.kube/config ]; then
  install -D -m 600 /root/.kube/config "${BACKUP_DIR}/root/.kube/config"
fi
```

备份中包含 CA 私钥。必须按站点对敏感备份的保留规则限制访问，并在允许的清理时点处理。

### 4. 在每个节点执行恢复

先列出集群节点，建立逐节点执行清单：

```bash
kubectl get nodes -o wide
```

然后在清单中的每个节点上显式传入有效期和工具文件的绝对路径：

```bash
SAFE_DAYS=<CA-bounded-days>
TOOL_DIR=/cluster-cert-rotator/download

env CERT_DAYS="${SAFE_DAYS}" \
    CERT_RENEW_TOOL="${TOOL_DIR}/cert-renew" \
    bash "${TOOL_DIR}/renew-all.sh"
```

脚本使用主 CA 处理 API 服务器和 kubelet 文件，使用 etcd CA 处理 etcd 文件，使用 front-proxy CA 处理 `front-proxy-client.crt`。以下文件存在时会尝试更新：

- `apiserver.crt`、`apiserver-kubelet-client.crt`、`kubelet.crt`、`kubelet-client-current.pem`
- `admin.conf`、`super-admin.conf`、`controller-manager.conf`、`scheduler.conf`、`/root/.kube/config`
- `etcd/server.crt`、`etcd/peer.crt`、`apiserver-etcd-client.crt`
- `front-proxy-client.crt`

对于内嵌客户端证书的 kubeconfig，工具只替换证书数据，保留原有私钥。对于引用外部证书文件的 kubeconfig，工具会更新被引用的证书文件。

脚本会更新 `kube-apiserver`、`kube-controller-manager`、`kube-scheduler` 三个静态 Pod 清单，然后重启 kubelet。它不会显式更新 `etcd.yaml`；必须单独验证 etcd 健康状态，并确认是否需要重启 etcd 或重新加载证书。

脚本不会在每个文件出错时立即停止。不能把最后的 `Done` 消息当作成功证据，必须检查命令输出并完成下面的验证。

### 5. 验证结果

检查所有被修改的 PEM 证书和 kubeconfig 客户端证书的新有效期。每个新的 `notAfter` 都必须不晚于选定的 CA 截止日期：

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

每个节点完成恢复后，确认节点和控制平面健康状态：

```bash
systemctl is-active kubelet
kubectl get nodes
kubectl get pods -n kube-system -o wide
```

检查 kubelet 和控制平面日志中是否有重启失败，并单独确认 etcd 端点健康状态。对所有节点重复步骤 3 至步骤 5。在多控制平面集群中，按获批顺序逐个控制平面节点执行，每个节点完成后等待控制平面恢复健康再处理下一个节点；工作节点按站点批准的维护顺序逐个处理。

## 根本原因

Kubernetes Certificates Rotator 通过控制器配置改变签发有效期，但卸载插件不会改写它已经签发的证书。独立的 `cert-renew` 工具使用现有 CA 重新签发证书，并将 `NotAfter` 设置为 `now + days`；它不会检查或截断为 CA 到期时间。因此实际有效期同时受请求天数和 CA 剩余有效期约束，不能只看请求参数。

## 回滚

如果某个节点恢复后的检查失败，应停止修改其他节点并保留命令输出，从该节点的受保护备份恢复文件。恢复后重新执行相同的静态 Pod 和 kubelet 重启操作，再确认 API 服务器、kubelet 和 etcd 健康状态后，才能继续处理其他节点。
