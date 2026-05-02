---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500002
sourceSHA: ebf49486dd909fe76d94ac807623a6b3c893df5b77756f343297a455c0d14749
---

## 问题

当单个命名空间中的工作负载出现异常时，支持工程师通常需要该命名空间中每个资源的快照以及所有容器日志，并将其打包成一个文件。集群范围的诊断包（`inspection` 收集器，`kubectl cluster-info dump`）过于粗糙——它使响应者被平台内部信息淹没——而 `kubectl get -A` 又过于狭窄，因为它丢失了非命名空间上下文（事件、RBAC 绑定、存储）。需要的是一个每个命名空间的转储，能够捕获资源清单、最近的事件以及之前和当前的容器日志，全部打包成一个可转移的归档文件。

## 解决方案

对于应用命名空间的故障排除，运行一个便携式的 shell 循环，遍历每个命名空间的 API 资源和每个 pod 的容器日志，然后压缩结果。该循环仅依赖于 `kubectl` 和集群的发现 API，因此它适用于任何符合标准的集群：

```bash
#!/bin/bash
# kubectl-nsdump <namespace>
# 收集一个命名空间的清单、事件和容器日志。
set -eu
NS=${1:?用法: $0 <namespace>}
KCTL="kubectl -n $NS"

if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
  echo "命名空间 $NS 不存在" >&2
  exit 1
fi

if [ "$($KCTL auth can-i get pods)" != "yes" ]; then
  echo "当前用户无法读取 $NS 中的 pods" >&2
  exit 1
fi

DEST="${NS}-$(date +%Y%m%d-%H%M%S).txt.gz"
echo "正在收集 $NS 的转储到 $DEST"

{
  set -x
  date
  kubectl version --short
  kubectl whoami 2>/dev/null || $KCTL auth whoami -o yaml
  $KCTL get all -o wide
  kubectl get namespace "$NS" -o yaml

  # 遍历发现 API 暴露的每种命名空间资源类型，
  # 将名称用逗号连接，以便 API 每个动词接收一个请求。
  RESOURCES=$(kubectl api-resources --namespaced --verbs=list -o name | paste -sd,)
  $KCTL get --ignore-not-found "$RESOURCES" -o wide
  $KCTL get --ignore-not-found "$RESOURCES" -o yaml

  # 事件，按绝对时间戳排序，而不是“5分钟前”的相对形式。
  $KCTL get events -o custom-columns=\
'LAST:.lastTimestamp,FIRST:.firstTimestamp,COUNT:.count,'\
'NAME:.metadata.name,KIND:.involvedObject.kind,'\
'SUBOBJECT:.involvedObject.fieldPath,TYPE:.type,REASON:.reason,'\
'SOURCE:.source.component,MESSAGE:.message'

  # 每个 pod、每个容器的日志（当前 + 之前的实例，如果有）。
  for pod in $($KCTL get pod -o name); do
    for c in $($KCTL get "$pod" \
      --template='{{range .spec.containers}}{{.name}} {{end}}'); do
      $KCTL logs "$pod" -c "$c" --timestamps || true
      $KCTL logs "$pod" -c "$c" --timestamps --previous || true
    done
  done

  # 如果调用者具有集群读取权限，还要捕获影响调度和存储的拓扑上下文。
  if [ "$(kubectl auth can-i get nodes)" = "yes" ]; then
    kubectl get node -o wide
    kubectl get node -o yaml
    kubectl describe node
    kubectl get clusterrolebinding -o yaml
    kubectl get storageclass -o wide
    kubectl get storageclass -o yaml
    kubectl get pv -o wide
    kubectl get pv -o yaml
    kubectl get csr -o wide || true
    kubectl get pods -A -o wide
  fi
  date
} 2>&1 | gzip > "$DEST"

echo "转储已写入 $DEST"
```

以重现问题的相同用户身份运行该脚本，以便 RBAC 错误反映原始失败模式。输出归档是纯文本；`zless`、`zgrep` 和 `zcat` 可以直接在其上工作，而无需扩展到磁盘。

该脚本故意将资源列表批量处理为每个动词一个逗号连接的 `kubectl get`——对每种资源类型发出一个请求将消耗数十个 API 调用，并可能触发 apiserver 的速率限制响应。使用 `zgrep '^secret|^kind: Secret'` 搜索压缩输出，而不是用不同的过滤器重新运行脚本。

对于集群范围的问题（apiserver、调度器、入口控制器、CNI），每个命名空间的转储不是合适的工具。使用平台内置的 `inspection` 收集器或其等效的诊断包 CR——这些包在一次操作中捆绑节点、etcd、控制平面和 operator 状态。

## 诊断步骤

如果脚本在特定资源类型上中止，请识别哪个类型触发了失败：

```bash
kubectl api-resources --namespaced --verbs=list -o name | while read r; do
  echo "--- $r ---"
  kubectl -n "$NS" get --ignore-not-found "$r" -o name | head -3
done
```

在特定类型上出现 405 或 403 指向具有受限访问的 CRD；要么授予执行服务帐户 `get`/`list` 权限，要么将该资源从循环中移除。

如果生成的归档对于一个长期存在的命名空间意外地小，容器日志可能在最近的 pod 重启时被截断。请在重现问题后立即重新运行转储，并在需要更长的收集窗口时使用 `kubectl debug` 固定相关的 pods。

如果客户无法通过正常渠道发送归档，请将其附加到 `ConfigMap` 中，并让支持通过平台现有的日志导出管道提取它：

```bash
kubectl -n "$NS" create configmap nsdump-$(date +%s) \
  --from-file="$DEST"
```

这避免了带外文件传输，并通过集群的审计日志保留审计轨迹。
