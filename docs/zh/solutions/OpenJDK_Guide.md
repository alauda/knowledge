---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB251100005
sourceSHA: a964041b2c5df12a50021baa4b07fa0f0eb049fda47d7fa9645f9f8965ed9867
---

# 如何在 ACP 平台上使用 OpenJDK

## 概述

**OpenJDK (开放 Java 开发工具包)** 是 Java 平台标准版 (Java SE) 的官方开源实现，由包括 Oracle、Red Hat、IBM 和 Microsoft 在内的多个供应商维护。\
它包括完整的 **Java 编译器 (javac)**、**运行时环境 (JRE)**、**虚拟机 (JVM)** 和 **核心库**，并作为 Java 应用程序开发和运行的事实标准。

### Red Hat Build of OpenJDK

Red Hat 是 OpenJDK 长期支持 (LTS) 版本的主要维护者之一。它提供了一种企业级构建，称为 **Red Hat Build of OpenJDK**，其特点包括：

- 与 OpenJDK 社区主线的同步；
- 长期维护 (LTS) 和安全补丁；
- 针对 RHEL / UBI 环境的优化；
- 在 GPLv2 + Classpath Exception 下的免费商业使用。

Alauda 已验证基于 Red Hat Build of OpenJDK 的企业级容器镜像的兼容性，并确保在 **Kubernetes** 和 **Alauda ACP** 平台上安全稳定地运行。

---

## 支持政策

Alauda 默认支持 **所有社区发布的 OpenJDK 版本**，并对代表性版本进行了 ACP 平台兼容性和运行时性能的验证。\
支持期限遵循 **Red Hat / OpenJDK 社区生命周期**。\
用户可以直接从社区注册表中拉取官方 Red Hat OpenJDK 镜像，并在 ACP 上无修改地部署。

### 验证版本列表

| 版本       | 基础镜像                       | 镜像仓库                                     | 支持的 ACP 版本 | 认证        | 架构            | 维护至         |
| ---------- | ------------------------------ | -------------------------------------------- | ---------------- | ----------- | ---------------- | ----------------- |
| OpenJDK 8  | RHEL 8 UBI                     | `registry.access.redhat.com/ubi8/openjdk-8`  | 所有             | ✅ 认证     | x86_64, aarch64 | 2026              |
| OpenJDK 17 | RHEL 9 UBI                     | `registry.access.redhat.com/ubi9/openjdk-17` | 所有             | ✅ 认证     | x86_64, aarch64 | 2027              |
| OpenJDK 21 | RHEL 9 UBI                     | `registry.access.redhat.com/ubi9/openjdk-21` | 所有             | ✅ 认证     | x86_64, aarch64 | 2029              |

---

## 快速开始

本节演示如何使用 Alauda 验证的 OpenJDK 基础镜像构建和部署 Java 应用程序。

### 1. 创建 `Dockerfile`

```dockerfile
# 使用 Alauda 认证的 Red Hat OpenJDK 17 基础镜像
FROM registry.access.redhat.com/ubi9/openjdk-17

# 将应用程序复制到容器中
COPY target/app.jar /opt/app/app.jar

# 设置工作目录
WORKDIR /opt/app

# 启动命令
CMD ["java", "-jar", "app.jar"]
```

> 如果需要，您可以用其他经过验证的版本替换该镜像。

---

### 2. 构建镜像

```bash
nerdctl build -t my-java-app .
```

### 3. 本地运行

```bash
nerdctl run -p 8080:8080 my-java-app
```

---

### 4. 部署到 Kubernetes / Alauda ACP

**示例部署：**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-java-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-java-app
  template:
    metadata:
      labels:
        app: my-java-app
    spec:
      containers:
        - name: my-java-app
          image: my-java-app:latest
          ports:
            - containerPort: 8080
```

**示例服务 (NodePort)：**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-java-app
spec:
  type: NodePort
  selector:
    app: my-java-app
  ports:
    - port: 8080
      targetPort: 8080
```

然后通过以下地址访问您的应用程序：

```bash
http://<NodeIP>:30080
```

---

## 最佳实践

- **使用 LTS 版本** (OpenJDK 17 或 21) 进行企业部署。
- **依赖社区维护的 Red Hat OpenJDK 镜像** 以确保及时的 CVE 补丁。
- **根据工作负载大小调整 JVM 参数**，如 `-Xms512m -Xmx1024m`。
- **利用多阶段 Docker 构建** 在构建自定义 JAR 时减少镜像大小。
- **使用 ACP 指标监控内存使用情况** 以进行容器级优化。
