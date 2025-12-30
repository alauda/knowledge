---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251200011
sourceSHA: 8065d6d32c02330194819661941bfaf40c1601e2d927d573a258431872713e92
---

# 在 ACP 中使用 Red Hat UBI 镜像

**注意**

ACP (Alauda Container Platform) 与 OpenShift 高度兼容，我们推荐并全力支持使用 Red Hat UBI (Universal Base Image) 系列镜像。UBI 完全开源，并定期接收安全补丁，这可以显著增强业务安全性。所有 UBI 镜像可以无缝构建和运行在 ACP 上，允许您直接使用现有的基于 UBI 的镜像和流程，而无需任何修改。

---

## UBI 概述

Red Hat Universal Base Image (UBI) 是由 Red Hat 提供的容器基础镜像，基于 Red Hat Enterprise Linux (RHEL) 的一个子集构建，并支持 OCI 标准。\
它允许开发人员自由构建和运行容器化应用程序，而无需 Red Hat 订阅。

### UBI 镜像类型

- **基础镜像**: ubi (标准), ubi-minimal, ubi-micro, ubi-init
- **语言运行时和框架**: Go, Node.js, Ruby, Python, PHP, Perl 等
- **Web 服务器**: Apache httpd
- 其他

## UBI 镜像使用

1. 在官方 [Red Hat Ecosystem Catalog](https://catalog.redhat.com/en) 页面，选择“Containers”类别并输入您想要搜索的镜像名称。
2. 在搜索结果中点击所需镜像后，点击详细页面上的“Get this image”标签，选择“Unauthenticated”，并获取镜像地址。
3. 复制镜像地址，可以使用标签或 sha。镜像地址示例：
   - registry.access.redhat.com/ubi9/ubi-minimal:9.7-1764578379
   - registry.access.redhat.com/ubi9/ubi-minimal\@sha256:161a4e29ea482bab6048c2b36031b4f302ae81e4ff18b83e61785f40dc576f5d

**注意**: 在“Unauthenticated”标签下的镜像可以匿名拉取，其仓库地址为 *registry.access.redhat.com*。然而，一些镜像位于 *registry.redhat.io*（在“Using registry tokens”或“Using Red Hat login”标签下），需要通过 Red Hat 账户进行拉取。有关详细信息，请参阅: [Red Hat Container Registry Authentication](https://access.redhat.com/articles/RegistryAuthentication)。

## 重要说明

Red Hat Universal Base Image 可以在 Red Hat 或非 Red Hat 平台上免费部署，并可自由再分发。构建在 UBI 上的软件供应商和社区项目可能会有适用于其分层软件的额外最终用户许可协议 (EULA)。有关 Red Hat Universal Base Image 及相关软件和源代码使用的信息，请参阅 [Red Hat Universal Base Image 的最终用户许可协议](https://www.redhat.com/licenses/EULA_Red_Hat_Universal_Base_Image_English_20190422.pdf)。
