---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500003
sourceSHA: a211a40f121afaf92f63de534b318278fb6efaa837292524881f4c865ccb3289
---

# 使用 Kubernetes 审计日志识别删除节点对象的客户端

## 问题

节点对象意外地从集群中消失——例如，一个工作节点在加入后不久被移除。由于 Kubernetes 事件并不记录执行操作的请求者身份，因此集群自身的事件流无法说明是哪个客户端删除了该节点。归因于特定客户端的删除的权威记录是 kube-apiserver 审计日志，它捕获每个 API 请求的请求动词、目标对象、请求身份和源 IP。

## 根本原因

节点对象可以被任何经过身份验证的主体删除——无论是人类用户还是绑定到授予 `delete` 动词的 `nodes` 资源的角色的 ServiceAccount。在 Alauda 容器平台上，一组广泛的 ClusterRoles 拥有节点删除权限，包括可绑定 ServiceAccount 的平台角色，因此在 ServiceAccount 下运行的控制器完全有能力移除节点对象。当节点消失时，问题不在于客户端是否可以删除它，而在于哪个客户端确实删除了它——这个问题可以通过审计日志得到解答。

## 解决方案

确认 kube-apiserver 上的审计日志记录已启用，然后从审计记录中读取请求身份。

在 Alauda 容器平台上，kube-apiserver 作为静态 Pod `kube-apiserver-<node-ip>` 运行在 `kube-system` 命名空间中（镜像 `kube-apiserver:v1.34.5`）。通过 apiserver 标志启用审计日志记录，记录以 JSON 格式写入：

```text
--audit-policy-file=/etc/kubernetes/audit/policy.yaml
--audit-log-path=/etc/kubernetes/audit/audit.log
--audit-log-format=json
--audit-log-mode=batch
```

检查正在运行的 apiserver Pod，以确认这些标志存在，然后再依赖日志：

```bash
kubectl -n kube-system get pod kube-apiserver-<node-ip> \
  -o jsonpath='{.spec.containers[0].command}' | tr ',' '\n' | grep audit
```

审计记录遵循标准的 `audit.k8s.io/v1` 事件形状。每条节点删除记录都暴露 `stageTimestamp`、`verb`、`requestURI`、`objectRef.resource`、`objectRef.name`、`user.username` 和 `sourceIPs`。审计日志文件写入控制平面节点的配置 `--audit-log-path` 中，并在那里读取。

## 诊断步骤

过滤审计日志以查找针对缺失节点的 `nodes` 资源的删除请求；匹配记录的 `user.username` 和 `sourceIPs` 确定删除客户端。将 JSON 格式的日志行收集到文件中，以下命令选择相关行：

```bash
NODE=<node-name>
jq -cr --arg node "$NODE" '
  select((.verb != "get") and (.verb != "watch")
    and (.objectRef.resource == "nodes")
    and (.objectRef.name == $node))
  | "\(.stageTimestamp)|\(.verb)|\(.requestURI)|\(.objectRef.resource)/\(.objectRef.name)|\(.user.username)|\(.sourceIPs)"
' audit.log | sort
```

一条匹配的行，例如 `nodes/<node-name>` 上的 `delete`，其 `user.username` 是一个 ServiceAccount 名称，确认了一个非人类客户端移除了该节点。将该身份与授予 `nodes` 上 `delete` 权限的 ClusterRoles 进行交叉引用，以确定哪个工作负载或控制器持有该权限：

```bash
kubectl get clusterrole -o json | jq -r '
  .items[] | select(any(.rules[]?;
    (.resources[]? == "nodes" or .resources[]? == "*")
    and (.verbs[]? == "delete" or .verbs[]? == "*")))
  | .metadata.name'
```
