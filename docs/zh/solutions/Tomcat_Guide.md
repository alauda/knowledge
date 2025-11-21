---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB251100006
sourceSHA: 99aab1bacbaa45610b4b5268f0dc109b00d78371762573d1fef6d33d5b7f757e
---

# 如何在 ACP 平台上使用 Tomcat

## 概述

**Apache Tomcat** 是一个由 **Apache 软件基金会 (ASF)** 维护的开源 Java Web 容器。
它广泛用于运行基于 Servlet、JSP 和 WebSocket 的 Jakarta EE 应用程序。
凭借其轻量、高效和可扩展的架构，Tomcat 已成为企业 Java Web 应用程序最流行的运行时环境之一。

**Alauda** 已验证官方社区 Tomcat 镜像（来自 Docker Hub）的兼容性、安全性和性能，
确保在 **ACP** 和 **Kubernetes** 平台上稳定和安全地运行。

---

## 支持政策

Alauda 默认支持所有官方 **Apache Tomcat 社区版本**，并对代表性版本进行了功能、性能和安全性的验证。
支持生命周期与 **Apache 社区生命周期** 完全一致。
用户可以直接从 Docker Hub 下载并在 ACP 平台上使用官方 Tomcat 镜像。

### 验证版本列表

| Tomcat 版本 | JDK 版本                     | 镜像                               | 支持的 ACP 版本         | 验证       | 架构            | 发布年份 | 维护至         | 阶段       |
| ----------- | ---------------------------- | ---------------------------------- | ----------------------- | ---------- | ---------------- | -------- | ---------------- | ---------- |
| 10.1        | OpenJDK 17 (Eclipse Temurin) | `tomcat:10.1-jre17-temurin-jammy` | 所有                    | ✅ Certified | x86_64, aarch64 | 2022     | \~2027          | 维护中     |
| 11.0        | OpenJDK 17 (Eclipse Temurin) | `tomcat:11.0-jre17-temurin-jammy` | 所有                    | ✅ Certified | x86_64, aarch64 | 2024     | \~2029          | 活跃       |

---

## 快速开始

本指南演示如何使用 **Alauda 认证的 Apache Tomcat 镜像** 构建和部署一个简单的 Java Web 应用程序。

### 1. 准备 WAR 包

假设您已经构建了一个 WAR 文件，例如：

```text
target/myapp.war
```

### 2. 创建 `Dockerfile`

```dockerfile
# 使用 Alauda 验证的 Tomcat 基础镜像
FROM tomcat:11.0-jre17-temurin-jammy

# 可选：删除默认的 webapps
RUN rm -rf /usr/local/tomcat/webapps/*

# 将您的 WAR 文件复制到部署目录
COPY target/myapp.war /usr/local/tomcat/webapps/ROOT.war

# 暴露默认端口
EXPOSE 8080

# 启动 Tomcat
CMD ["catalina.sh", "run"]
```

### 3. 构建镜像

```bash
nerdctl build -t myapp:latest .
```

### 4. 本地运行

```bash
nerdctl run -p 8080:8080 myapp:latest
```

在浏览器中访问 <http://localhost:8080>。\
如果主页加载成功，则部署成功。

---

### 5. 部署到 ACP / Kubernetes

**示例部署和服务：**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: myapp
          image: myrepo/myapp:latest
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  type: NodePort
  selector:
    app: myapp
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30080
```

然后访问: `http://<NodeIP>:30080`

---

## 最佳实践

- 使用官方的社区维护镜像，以确保 CVE 补丁更新。
- 如有需要，通过 ConfigMap 自定义 `server.xml` 和 `context.xml`。
- 使用 `Eclipse Temurin JRE 17` 作为长期支持的基础 JDK。
- 根据应用程序大小调整 JVM 选项（例如，`-Xms512m -Xmx1024m`）。
- 在构建自定义镜像时，优先使用多阶段构建以减少镜像大小。
