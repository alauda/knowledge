---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500598
sourceSHA: 95c998a0c39215e447f25038f2802caa7f06317cca8d027c5db8b66fa6521329
---

# 在 ACP 上配置 Alertmanager 通知接收器并从错误配置中恢复

## 问题

在 Alauda Container Platform 上，监控栈以普通 Pod 的形式在 `cpaas-system` 命名空间中运行 Alertmanager，属于 StatefulSet `alertmanager-kube-prometheus`，这些 Pod 带有标签 `app=alertmanager`。需要将警报路由到外部目的地的管理员需要清楚 Alertmanager 消耗的配置文档的结构、如何使更改生效以及如何识别二进制文件拒绝的配置。Alertmanager 配置文档的结构包括一个 `global` 部分、一个 `route` 树和一个 `receivers` 列表，每个路由的接收器必须引用在 `receivers` 中定义的名称。

## 解决方案

通过向 `receivers` 列表添加条目来配置外部通知目标——例如，在 `global` 中添加一个 `email_configs` 块以及 `smtp_*` 设置——然后通过 `route` 树将匹配的警报路由到该接收器。路由条目使用的接收器名称必须与 `receivers` 中声明的 `name` 匹配，因此新的目标被定义为一个 `receivers[]` 条目加上一个选择它的 `route.routes[]` 匹配。

遵循此结构的配置如下：

```yaml
global:
  smtp_smarthost: smtp.example.com:587
  smtp_from: alertmanager@example.com
route:
  receiver: default-receiver
  routes:
    - match:
        severity: High
      receiver: email-oncall
receivers:
  - name: default-receiver
  - name: email-oncall
    email_configs:
      - to: oncall@example.com
```

Alertmanager 消耗的配置文档存储在 `cpaas-system` Secret `alertmanager-kube-prometheus` 中，位于 `alertmanager.yaml` 数据键下。通过用编辑后的文档替换该 Secret 的 `alertmanager.yaml` 内容来应用新配置，然后重启 Pod 以便新进程加载它。通过删除在 `cpaas-system` 中匹配 `app=alertmanager` 的 Pod 来重启；拥有的 StatefulSet `alertmanager-kube-prometheus` 会重新创建被删除的 Pod，重新创建的 Pod 的进程会加载替换后的配置。Alertmanager 容器运行的镜像为 `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`，上游的 `prometheus/alertmanager` v0.32.1 二进制文件。

```bash
kubectl delete pod -n cpaas-system -l app=alertmanager
```

## 诊断步骤

如果替换后的配置包含错误，重启的 Pod 将无法启动并进入 `CrashLoopBackOff` 状态：`alertmanager` 容器在启动时因配置加载错误而退出，kubelet 会循环重启它，重启计数不断增加。配置加载失败会在 `alertmanager` 容器日志中以错误行的形式显示，命名有问题的字段——例如，引用未在 `receivers` 中定义的接收器名称的路由会产生命名该未定义接收器的加载失败行。

查看 `alertmanager` 容器日志以找到命名字段：

```bash
kubectl logs -n cpaas-system -l app=alertmanager -c alertmanager
```

加载失败行以 `level=ERROR` 的形式发出，消息为 `Loading configuration file failed`，并且有一个 `err=` 子句命名路由引用的未定义接收器。
