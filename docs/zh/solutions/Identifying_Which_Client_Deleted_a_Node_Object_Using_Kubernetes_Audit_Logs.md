---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500003
sourceSHA: 7ac9e8c31582ff886e84007223a350a7ccde6e7c7adabfc62d24b2e22da75510
---

# 使用 Kubernetes 审计日志识别删除节点对象的客户端

## 问题

节点对象意外地从集群中消失——例如，一个工作节点在加入后不久被移除。由于 Kubernetes 事件并不记录执行操作的请求者的身份，因此集群自身的事件流无法说明是哪个客户端删除了该节点。归因于特定客户端的删除的权威记录是 kube-apiserver 审计日志，它捕获每个 API 请求的请求动词、目标对象、请求身份和源 IP \[ev:c1]。

## 根本原因

任何经过身份验证的主体——无论是人类用户还是绑定到授予 `delete` 动词的 `nodes` 资源的角色的 ServiceAccount——都可以删除节点对象。在 Alauda 容器平台上，一组广泛的 ClusterRoles 具有节点删除权限，包括可绑定 ServiceAccount 的平台角色，因此在 ServiceAccount 下运行的控制器完全能够移除节点对象 \[ev:c5]。因此，当节点消失时，问题不在于客户端是否可以删除它，而在于哪个客户端确实删除了它——这个问题可以通过审计日志来解答 \[ev:c1]。

## 解决方案

确认 kube-apiserver 上的审计日志记录处于活动状态，然后从审计记录中读取请求身份 \[ev:c2]。

在 Alauda 容器平台上，kube-apiserver 作为静态 Pod `kube-apiserver-<node-ip>` 在 `kube-system` 命名空间中运行（镜像 `kube-apiserver:v1.34.5`）。通过 apiserver 标志启用审计日志记录，记录以 JSON 格式写入 \[ev:c2]：

```text
--audit-policy-file=/etc/kubernetes/audit/policy.yaml
--audit-log-path=/etc/kubernetes/audit/audit.log
--audit-log-format=json
--audit-log-mode=batch
```

检查正在运行的 apiserver Pod，以确认这些标志在依赖日志之前存在 \[ev:c2]：

```bash
kubectl -n kube-system get pod kube-apiserver-<node-ip> \
  -o jsonpath='{.spec.containers[0].command}' | tr ',' '\n' | grep audit
```

审计记录遵循标准的 `audit.k8s.io/v1` 事件格式。每条节点删除的记录都暴露 `stageTimestamp`、`verb`、`requestURI`、`objectRef.resource`、`objectRef.name`、`user.username` 和 `sourceIPs` \[ev:c3_a]。审计日志文件在控制平面节点的配置 `--audit-log-path` 上写入，并在该处读取 \[ev:c2]。

## 诊断步骤

过滤审计日志以查找针对缺失节点的 `nodes` 资源的删除请求；匹配记录的 `user.username` 和 `sourceIPs` 确定删除客户端 \[ev:c3_b]。将 JSON 格式的日志行收集到文件中，以下命令选择相关行 \[ev:c3_a]：

```bash
NODE=<node-name>
jq -cr --arg node "$NODE" '
  select((.verb != "get") and (.verb != "watch")
    and (.objectRef.resource == "nodes")
    and (.objectRef.name == $node))
  | "\(.stageTimestamp)|\(.verb)|\(.requestURI)|\(.objectRef.resource)/\(.objectRef.name)|\(.user.username)|\(.sourceIPs)"
' audit.log | sort
```

如 `delete` 在 `nodes/<node-name>` 上的匹配行，其 `user.username` 是 ServiceAccount 名称，确认了非人类客户端移除了节点 \[ev:c3_b]。将该身份与授予 `nodes` 上 `delete` 权限的 ClusterRoles 进行交叉引用，以确定哪个工作负载或控制器持有该权限 \[ev:c5]：

```bash
kubectl get clusterrole -o json | jq -r '
  .items[] | select(any(.rules[]?;
    (.resources[]? == "nodes" or .resources[]? == "*")
    and (.verbs[]? == "delete" or .verbs[]? == "*")))
  | .metadata.name'
```
