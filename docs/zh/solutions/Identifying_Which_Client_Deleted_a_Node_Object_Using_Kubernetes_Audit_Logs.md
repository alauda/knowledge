---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500003
sourceSHA: 9ca2effb954e5dfb0575bbe2116a3f8bc466d584e382334df801df0f808f62db
---

# 识别哪个客户端删除了节点对象使用 Kubernetes 审计日志

## 问题

一个工作节点在加入集群后不久消失，或者在稳定状态操作期间消失。`kubectl get nodes` 不再列出它，主机上的 kubelet 是健康的，并继续发送心跳调用（这现在会在同名下重新创建节点，循环重复），并且没有明显的控制器状态条件解释删除原因。

反复出现的问题是 *谁* 删除了节点对象。Kubernetes 审计日志记录了每个 API 写入，包括发出请求的客户端的身份。通过正确的查询，审计日志可以识别负责的服务账户、控制器或人工用户。

## 根本原因

节点删除是一个常规的 API 调用：`DELETE /api/v1/nodes/<name>`。任何对 `nodes` 拥有 `delete` 权限的实体都可以发出此请求。集群中通常的删除者有：

- 运行维护的集群操作员（通过 `kubectl` 的真实用户）。
- 集群自动扩缩器移除一个使用不足的节点。
- 来自多集群管理或治理平台的节点生命周期策略控制器。
- 团队自己安装的定制控制器。

确定是哪个发出了删除请求需要将删除事件与调用身份关联。该关联存在于 `kube-apiserver` 审计日志中，记录了每个跨越 API 服务器的请求的 `verb`、`objectRef`、`user.username` 和 `sourceIPs`。

## 解决方案

在每个控制平面节点上运行结构化的审计日志搜索，过滤出针对受影响节点资源的 `delete` 操作。以下查询返回每个匹配审计事件的一行，包含时间戳、动词、请求 URI、目标对象、调用身份和源 IP：

```bash
NODE=worker-01

kubectl get nodes -l node-role.kubernetes.io/control-plane \
  -o name \
  | while read -r master; do
      master_name=${master#node/}
      echo "===== $master_name ====="
      # 从此控制平面节点流式传输 apiserver 审计日志。
      # 路径是 kubeadm 默认值；如果您使用不同的接收器，请调整集群的审计
      # 策略。
      # ACP 集群 PSA 拒绝 `chroot /host`；通过调试 pod 的 /host 绑定挂载读取主机文件。镜像必须包含 `cat`。
      kubectl debug node/${master_name} \
        -it --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1 \
        -- cat /host/var/log/kube-apiserver/audit.log 2>/dev/null \
        | jq -cr --arg node "$NODE" '
            select(
              (.verb != "get") and (.verb != "watch") and
              (.objectRef.resource == "nodes") and
              (.objectRef.name == $node)
            )
            | "\(.stageTimestamp)|\(.verb)|\(.requestURI)|\(.user.username)|\(.sourceIPs[0])"
          ' \
        | column -t -s'|' \
        | sort -k1
  done
```

一个典型的命中：

```text
2026-04-23T00:45:25.943914Z  delete  /api/v1/nodes/worker-01  system:serviceaccount:cluster-policy:policy-controller-sa  10.0.5.42
```

`user.username` 字段准确告诉您是谁发出了删除请求：在此示例中，服务账户 `policy-controller-sa` 来自 `cluster-policy` 命名空间。根据该标识，您可以：

- 检查服务账户所在的命名空间，以发现哪个控制器拥有它。
- `kubectl auth can-i delete nodes --as=system:serviceaccount:cluster-policy:policy-controller-sa` 确认该身份确实拥有其使用的权限。
- 在相同时间窗口内读取控制器的日志，以查看 *为什么* 它决定删除节点。

如果用户名是一个真实的人（例如 `alice@example.com`），则删除是一个手动操作；调查触发它的人为运行手册。

如果用户名属于您不认识的系统控制器，则该控制器是禁用、通过 RBAC 限制或重新配置以停止删除您想保留的节点的候选者。

### 限制有问题的身份

一旦身份确定，最安全的战术修复是撤销其对 `nodes` 的 `delete` 权限，同时调查控制器的行为：

```bash
kubectl create clusterrole node-delete-block \
  --verb=delete --resource=nodes --dry-run=client -o yaml \
  > /tmp/blocker.yaml
# 编辑 /tmp/blocker.yaml — 添加一个具有相同形状但
# 移除绑定而不是授予它的规则；然后查看有问题的 SA 上的现有
# ClusterRoleBindings：

kubectl get clusterrolebinding -o json \
  | jq '.items[] | select(.subjects[]? | .name == "policy-controller-sa")'
```

移除授予 `nodes` 删除权限的绑定。控制器将开始记录权限错误，而不是静默删除节点 — 这是您需要的可见性，以便正确修复它。

## 诊断步骤

如果上述审计搜索返回没有行，则可能有两种故障模式：

1. **审计日志未启用。** 检查控制平面主机上的 apiserver 进程参数：

   ```bash
   # `ps -ef` 从具有 --profile=sysadmin 的调试 pod 中看到主机 PID
   # 命名空间；不需要 chroot（ACP 的 PSA 拒绝）。
   kubectl debug node/<master> -it \
     --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1 --profile=sysadmin \
     -- ps -ef | grep kube-apiserver | grep -oE '\-\-audit-(log-path|policy-file)=[^ ]+'
   ```

   `--audit-policy-file` 和 `--audit-log-path` 都应该被设置。如果没有，请配置审计策略（记录所有对 `nodes` 的 `verbs` 的宽松策略足以进行此调查）并重新启动 apiserver pods。

2. **审计策略过滤掉了 `nodes` 的 `delete` 动词。** 检查审计策略：

   ```bash
   kubectl debug node/<master> -it \
     --image=registry.alauda.cn:60070/acp/alb-nginx:v4.3.1 \
     -- cat /host<policy-file-path>
   ```

   为 `nodes` 资源添加一个规则，级别设置为 `Metadata`（或更高），以便今后记录删除事件。

在审计日志捕获到删除后，上述相同查询将显示负责的身份，调查可以继续进行具体证据。
