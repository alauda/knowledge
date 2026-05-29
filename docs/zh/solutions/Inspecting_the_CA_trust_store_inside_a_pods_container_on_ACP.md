---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: 1b8fdc7e8315740cc63f62045474f7df8f42e9c9bfe017b8f4c8882f4b62a13c
---

# 在 ACP 中检查 pod 容器内的 CA 信任存储

## 问题

在 Alauda 容器平台集群（观察到在 `jingguo-7gm6m` 上运行 kubelet `v1.34.5`、containerd `2.2.1-5`，以及 ACP 基础安装包 `v4.3.5`）中，操作员需要确认给定的根 CA 是否存在于运行的 pod 容器的信任存储中——但单个集群上的工作负载镜像跨越多个基础镜像系列，因此在不同的文件系统路径下布局其信任存储。该集群上的实时 pod 至少使用了三种基础系列：UBI（例如 `ubi9/ubi`）、alpine（例如 `haproxy:2.0.34-alpine-2`、`redis:7.2-alpine.dfd3ac10`）和 ACP 平台镜像。对于基于 UBI 的 pod，`/etc/pki/tls/certs/` 下的路径在基于 alpine 或 Ubuntu 的 pod 中是缺失的，因此操作员必须首先识别 pod 的基础镜像，然后在该基础镜像提供的路径下查找信任存储。

## 根本原因

容器内的 CA 信任存储是容器镜像文件系统的一个属性，在镜像构建时由基础镜像的 `ca-certificates` 包填充，并不会被编排器注入或重写。该集群上的所有四个节点都运行 Ubuntu 22.04.1 LTS，但 pods 包含 UBI9 基础镜像，这些镜像在容器内提供 `/etc/pki/tls/certs/...`，而基于 alpine 的镜像则没有——这确认了信任存储路径是由镜像定义的，而不是由主机定义的。`containerd://2.2.1-5` CRI 运行时是通用的，不会重写容器内的 `/etc/pki/` 或 `/etc/ssl/`，因此操作员在 pod 内观察到的布局正是基础镜像提供的。ACP 不强制工作负载容器使用单一基础镜像，因此信任存储路径是所选基础镜像提供的：UBI 系列镜像在 `/etc/pki/tls/certs/` 下携带捆绑包，而 Ubuntu（以及其他 Debian/Alpine 风格）基础镜像则在 `/etc/ssl/` 下携带。

## 解决方案

首先识别 pod 的容器镜像，然后进入 pod 并在与基础镜像分发相匹配的路径下读取信任存储。由于路径依赖于基础镜像，操作员必须检查与 pod 的分发相对应的信任存储位置，而不是假设所有工作负载都有单一固定路径。

从 PodSpec 中读取容器镜像引用——标准的 `spec.containers[].image` 字段显示镜像（注册表、仓库、标签），从中可以识别基础镜像，因此可以确定预期的信任存储布局：

```bash
kubectl get pod <pod-name> -n <namespace> -o yaml
kubectl get pod <pod-name> -n <namespace> \
    -o jsonpath='{.spec.containers[*].image}'
```

对于一个容器是基于 UBI 系列基础镜像构建的 pod（例如 `ubi9/ubi`，在该集群上观察到为已完成的 pod），系统 CA 信任捆绑包由 `ca-certificates` RPM 在镜像构建时提供，位于 `/etc/pki/tls/certs/ca-bundle.crt`，而同一捆绑包的信任格式变体则位于 `/etc/pki/tls/certs/ca-bundle.trust.crt`。这两个文件是镜像在构建时提供的 CA 信任链的一部分，编排器不会对其进行更改。

对于一个容器是基于 Ubuntu 基础镜像构建的 pod，系统信任存储根本不在 `/etc/pki/tls/certs/` 下——Debian/Ubuntu 的信任链通常位于 `/etc/ssl/` 下（有关确切的捆绑文件名，请参见镜像的文档）。对基于 Ubuntu 的 pod 运行 UBI 风格的查找时，会看到路径缺失；这种缺失是预期的，并且本身就是切换到 `/etc/ssl/` 位置的信号。

要对容器的文件系统运行 shell 命令，请使用 `kubectl exec` 针对目标 pod，并在与基础镜像匹配的路径下检查信任存储。这是 Kubernetes 中相同操作的通用动词，并且在 ACP 上的所有工作负载 pod 中均可统一使用：

```bash
# UBI 系列容器 — 系统捆绑包和信任格式捆绑包
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.trust.crt

# Ubuntu / Debian / Alpine 容器 — 捆绑包位于 /etc/ssl/ 下
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/ssl/certs/ca-certificates.crt
```

## 诊断步骤

从 pod 的 PodSpec 开始，以确定适用的信任存储布局。`kubectl get pod -o yaml` 返回 ACP 上的标准 PodSpec，`spec.containers[].image` 字段携带每个容器的字面 `registry/repo:tag`——操作员检查该字段以查找基础镜像，从而确定预期的 PKI 路径。这是任何符合 Kubernetes 集群上的相同字段路径：

```bash
kubectl get pod <pod-name> -n <namespace> \
    -o jsonpath='{range .spec.containers[*]}{.name}{"\t"}{.image}{"\n"}{end}'
```

一旦知道基础镜像，进入容器并在匹配的路径下检查信任存储。对于 UBI 系列镜像，列出两个 `ca-bundle*.crt` 文件，并且如果容器有带有 `grep` 的 shell，则在捆绑包中搜索相关根 CA 的主题字符串：

```bash
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/pki/tls/certs/
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    sh -c "grep -i '<CA Subject CN>' /etc/pki/tls/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.trust.crt || true"
```

对于基于 Ubuntu 的镜像，在 Debian/Ubuntu 位置运行等效检查：

```bash
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    ls -l /etc/ssl/certs/
kubectl exec -n <namespace> <pod-name> -c <container-name> -- \
    sh -c "grep -i '<CA Subject CN>' /etc/ssl/certs/ca-certificates.crt || true"
```

如果所选路径在容器内不存在，则容器是从不同的基础系列构建的——返回 PodSpec，重新检查 `spec.containers[].image`，并切换到新基础镜像提供的信任存储路径。该路径是由镜像定义的；编排器并未提供统一的替代方案。
