---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500015
sourceSHA: 788382c0b865ce866f735a0cafd1b471c0306eb18a3f3a7d430964cb1e563854
---

# Pod 创建期间的 MutatingAdmissionWebhook 超时

## 问题

Kubernetes API 服务器报告 MutatingAdmissionWebhook 未能在 13 秒的截止时间内完成其变更：

```
发生内部错误：admission 插件 "MutatingAdmissionWebhook" 未能在 13 秒内完成变更
```

在创建 pods、任务或其他资源时会出现此错误。Webhook pods 本身看起来健康，并且在其日志中没有报告错误。

## 根本原因

Mutating admission webhook 在每个相关的 API 请求中调用外部服务。当 webhook 后端响应时间过长时——通常是因为 etcd 集群性能不佳——API 服务器会在 13 秒超时后取消请求。

潜在原因，按可能性排序：

1. **慢速 etcd** — Webhook pods 在变更期间执行 etcd 查找。性能下降的 etcd 集群使这些操作的速度低于截止时间。
2. **Webhook pod 资源耗尽** — CPU 或内存不足导致响应时间缓慢。
3. **网络分区** — API 服务器与 webhook 服务之间的连接问题。

## 解决方案

### 步骤 1：验证 Webhook Pod 健康状况

确认 webhook pods 正在运行并且响应正常：

```bash
kubectl get pods -n <webhook-namespace> -l app=<webhook-label>
kubectl logs -n <webhook-namespace> <webhook-pod> --tail=50
```

检查 webhook 端点是否在合理时间内响应：

```bash
kubectl run curl-test --image=curlimages/curl --rm -it --restart=Never -- \
  curl -sk https://<webhook-service>.<namespace>.svc:443/healthz
```

### 步骤 2：检查 etcd 性能

如果 webhook pods 健康，调查 etcd 延迟。请参考 etcd 后端性能知识库文章以获取详细指标和阈值。

关键指标：

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl endpoint health \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

如果响应时间超过 100 毫秒，则 etcd 集群需要关注——检查磁盘 I/O、CPU 负载和数据库大小。

### 步骤 3：检查网络连接

验证 API 服务器是否可以访问 webhook 服务：

```bash
kubectl get endpoints <webhook-service> -n <namespace>
```

确保端点列表包含有效的 pod IP，并且这些 IP 可以从控制平面节点访问。

### 步骤 4：碎片整理 etcd（如有必要）

如果 etcd 数据库碎片化是根本原因：

```bash
kubectl exec -n kube-system etcd-<node-name> -- etcdctl defrag \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

## 诊断步骤

搜索 API 服务器日志以查找 webhook 超时事件：

```bash
kubectl logs -n kube-system kube-apiserver-<node-name> --tail=500 | \
  grep "admission plugin.*MutatingAdmissionWebhook.*failed to complete"
```

识别已注册的 webhook 及其失败策略：

```bash
kubectl get mutatingwebhookconfigurations -o wide
```

查看每个 webhook 配置的超时设置：

```bash
kubectl get mutatingwebhookconfiguration <name> -o jsonpath='{.webhooks[*].timeoutSeconds}'
```
