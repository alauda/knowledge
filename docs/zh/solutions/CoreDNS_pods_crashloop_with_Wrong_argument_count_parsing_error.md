---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500017
sourceSHA: fa3e86cad0566c988da6f15a5ce832088920110dc591d1f092babe3f53de4404
---

# CoreDNS pods 崩溃循环，出现 "Wrong argument count" Corefile 解析错误

## 问题

集群 DNS 由 CoreDNS 提供服务，CoreDNS 作为 `coredns` 部署在 `kube-system` 命名空间中，并从 Corefile \ 中读取其配置。在 Alauda 容器平台 v4.3.4 中，Corefile 由 ConfigMap `kube-system/cpaas-coredns` 提供（数据键 `Corefile`），挂载到容器的 `/etc/coredns` 目录，并通过容器参数 `-conf /etc/coredns/Corefile` 加载 \。DNS pods 运行 CoreDNS 1.14.2（镜像 `registry.alauda.cn:60080/tkestack/coredns:1.14.2-v4.3.4`） \。

当 Corefile 包含一个 `forward` 插件块，而该区域后面没有至少一个上游时，CoreDNS 在启动时无法解析 Corefile \。然后 CoreDNS 进程退出，DNS pods 进入 `CrashLoopBackOff` 状态，容器因 `Error`（退出代码 1）而终止，始终未达到 `Ready` 状态，重启计数不断增加 \。

## 根本原因

`forward` 块声明一个 FROM 区域，后面跟随一个或多个 TO 上游。像 `forward .` 这样的块虽然命名了区域，但没有列出上游，因此是不完整的，CoreDNS 解析器会拒绝它 \。由于无法加载配置，进程在启动时中止，而不是提供 DNS 服务 \。

该故障在 CoreDNS 容器日志中以解析错误的形式显示，错误信息中包含 `forward` 插件、Corefile 路径和出错行号 \:

```text
plugin/forward: /etc/coredns/Corefile:3 - Error during parsing: Wrong argument count or unexpected line ending after '.'
```

## 解决方案

修正 Corefile，使每个 `forward` 块在其区域后列出至少一个上游 \。对于默认区域转发到节点解析器，格式正确的块为：

```text
.:1053 {
    errors
    forward . /etc/resolv.conf
}
```

一旦上游存在，CoreDNS 就能成功解析配置——重启的 pod 日志中显示 `CoreDNS-1.14.2` 启动横幅，没有 `Error during parsing` 行，并返回到运行状态（`Running`，就绪，重启计数 0） \。

## 诊断步骤

检查 `kube-system` 中的 CoreDNS 工作负载和 pods，以确认它们正在崩溃循环 \\：

```bash
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system get deploy coredns -o jsonpath='{.spec.template.spec.containers[0].image}'
```

读取 CoreDNS 容器日志以查找解析错误；它会命名 `forward` 插件和格式错误的 Corefile 行 \：

```bash
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=30
```

检查 Corefile 以找到在其区域后没有上游的 `forward` 块 \：

```bash
kubectl -n kube-system get configmap cpaas-coredns -o jsonpath='{.data.Corefile}'
```
