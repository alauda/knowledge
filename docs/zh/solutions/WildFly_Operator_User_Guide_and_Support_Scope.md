---
id: KB1756795269-F8EE
sourceSHA: 7b1ef4c51e9186f2b663c1cf00d56741708184075dcfeb850f649b2b926fbef9
---

# WildFly 概述

WildFly（前称 JBoss 应用服务器）是一个开源、轻量级且高性能的 Java EE / Jakarta EE 应用服务器，由 Red Hat 领导开发。\
它为企业 Java 应用提供运行时环境，支持完整的 Jakarta EE 规范，包括 EJB、JPA、JMS、JAX-RS、CDI 等。\
其核心设计理念强调模块化、高性能和云原生准备。

## 关键特性

- **架构**：模块化架构（JBoss Modules），具有类加载隔离以减少资源消耗。
- **性能**：快速启动（1–3 秒），低内存占用（约 80MB），以及字节码增强优化。
- **安全性**：支持 JAAS/JACC/JASPI、远程 TLS 配置和增强的分布式通信安全。
- **云原生支持**：与 Docker/Kubernetes 深度集成，支持容器化部署和自动化操作。
- **标准兼容性**：完全支持 Jakarta EE 完整配置，确保企业应用的可移植性。

## 典型用例

- **企业系统**：ERP、CRM、金融平台。支持分布式事务（JTA）、消息传递（JMS）、集群和容错，以满足业务一致性要求。
- **高性能 Web/API 服务**：电子商务平台、社交媒体后端、RESTful API 网关。集成 Undertow Web 服务器，支持 HTTP/2 和 WebSocket；JAX-RS 简化 API 开发。
- **云原生与微服务架构**：Kubernetes 微服务和混合云应用。容器友好，支持 Helm Charts 和 Operator；集成 MicroProfile（健康检查、指标、监控）。
- **遗留系统现代化**：迁移传统 Java EE 应用。与历史 Java EE 标准兼容，提供从 WebLogic/WebSphere 到 WildFly 的平滑迁移路径。

# WildFly 与 Red Hat JBoss EAP

| 类别                       | WildFly                                                         | JBoss EAP                                                                                                      |
| -------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **维护者**                 | Community（Red Hat 工程师 + 贡献者）                           | Red Hat 商业团队                                                                                              |
| **发布周期**               | 快速，频繁更新，快速采用新技术                                 | 较慢，经过严格测试，稳定性高                                                                                  |
| **支持生命周期**           | 短（通常每个版本 <1 年）                                       | 长达 7 年以上的商业支持（包括安全补丁）                                                                        |
| **稳定性**                 | 实验性特性，有时不够稳定                                       | 专注于稳定性和兼容性                                                                                          |
| **特性**                   | 可能包括实验性特性                                           | 精心挑选的稳定特性，不包括未完成的组件                                                                          |
| **文档与支持**             | 社区文档，无 SLA 保证                                          | Red Hat 官方文档，知识库，SLA 支持                                                                             |
| **许可证**                 | LGPL v2.1（免费）                                             | 需要商业订阅                                                                                                  |
| **参考**                   | [WildFly 文档](https://www.wildfly.org/documentation/)        | [JBoss EAP 文档](https://access.redhat.com/documentation/en-us/jboss_enterprise_application_platform) |

# WildFly Operator 与 JBoss EAP Operator

Alauda 平台提供 **WildFly Operator**，简化了在 Kubernetes 环境中 Java 应用的部署和操作。\
WildFly Operator 是一个社区项目，由 WildFly 社区维护，与 Red Hat 的 **JBoss EAP Operator** 不同。

| 类别                      | WildFly Operator                                                                                        | JBoss EAP Operator                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **基础软件**              | WildFly（开源）                                                                                         | JBoss EAP（企业版，Red Hat 支持）                                                |
| **镜像构建**              | 用户根据需要的依赖（JAR/WAR）构建自己的应用镜像                                                       | 官方 JBoss EAP 基础镜像，包含商业 JAR                                            |
| **许可证**                | Apache License 2.0                                                                                      | 商业许可证，需要 Red Hat 订阅                                                    |
| **Operator 功能**         | 管理 WildFly 应用的部署、扩展和配置；兼容 JBoss EAP 工作负载                                          | 管理 JBoss EAP 实例，提供企业级支持和附加功能                                    |
| **支持范围**              | 社区自我支持                                                                                          | Red Hat 官方支持：错误修复、补丁、安全更新                                        |
| **参考**                  | [WildFly Kubernetes 文档](https://docs.wildfly.org/)                                                  | [Red Hat JBoss EAP Operator 文档](https://access.redhat.com/documentation)      |

# Operator 使用指南

有关如何使用 WildFly Operator 管理应用的详细说明，请参考官方用户指南：\
👉 [WildFly Operator 用户指南](https://docs.wildfly.org/wildfly-operator/user-guide.html)

# 责任

## 平台责任

我们确保 WildFly Operator 在 Alauda 平台上的可用性，并提供：

- WildFly Operator 在平台上的可用性和集成
- 故障排除 Kubernetes 级别的问题（例如，网络、存储、资源调度）
- 正确使用 Operator CRs（自定义资源）的指导
- 与部署相关的配置指导（YAML/CR 示例、日志故障排除方法）

我们不提供：

- 官方 WildFly JAR 或中间件依赖（用户应依赖社区提供的 JAR/镜像）
- 构建/编译用户 Java 应用镜像
- 应用级代码问题解决（业务逻辑错误、依赖冲突、性能调优）

## 用户责任

使用 WildFly Operator 部署的用户负责：

- 准备和编译 Java 应用镜像（基于社区 WildFly 或自定义基础镜像）
- 确保应用代码和依赖的正确性
- 故障排除和修复业务逻辑问题
- 如果需要企业功能（例如，JBoss EAP 安全补丁），则需采购 Red Hat 订阅

# 总结

平台提供的 WildFly Operator 是 **社区开源版本**，旨在简化在 Kubernetes 中 Java 应用的部署和基本操作。\
与 Red Hat JBoss EAP Operator 相比，它不提供商业支持、官方镜像或商业 JAR 维护。\
责任边界明确：**平台处理 Kubernetes 操作和 Operator 可用性；用户处理应用开发、镜像构建和业务故障排除**。
