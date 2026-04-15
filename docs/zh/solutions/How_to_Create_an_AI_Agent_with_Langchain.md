---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB260400006
sourceSHA: 7bd96939203c13e73ccfddd3da66cbf6696d03bb4226d51aa3679cf813e289e8
---

# 如何使用 Langchain 创建智能体

## 概述

Langchain 是一个用于开发由语言模型驱动的应用程序的框架。它提供了构建能够与用户互动、访问外部工具并执行复杂推理任务的智能体的工具和抽象。本指南提供了一个使用 Langchain 创建智能体的快速入门示例。

## 先决条件

- 一个 Notebook 环境（例如，Jupyter Notebook、JupyterLab 或类似工具）
- 安装了 Langchain 和其他依赖项的 Python 3 及 pip

## 快速入门

创建智能体的简单示例可以在这里找到：[langchain_quickstart.ipynb](/langchain/langchain_quickstart.ipynb)。下载并上传到 Notebook 环境中以运行。

该笔记本演示了：

- 环境设置和依赖项安装
- 工具定义（选择一种）：使用 `@tool` 装饰器的内置工具，或通过 MCP 使用来自 `langchain-mcp-adapters` 的 `MultiServerMCPClient` 的外部工具（天气示例适用于两者）
- LLM 模型初始化和配置
- 使用工具和系统提示创建智能体
- 智能体执行和结果处理
- 用于生产使用的 FastAPI 服务部署

## 其他资源

有关使用 Langchain 开发智能体的更多资源，请参见：

- [Langchain 文档](https://docs.langchain.com/oss/python/langchain/overview) - 官方 Langchain 文档，所有使用相关文档均可在此找到。
- [Langchain 学院](https://academy.langchain.com/) - 官方 Langchain 学院提供丰富的教育资源。课程 [基础介绍 Langchain Python](https://academy.langchain.com/courses/foundation-introduction-to-langchain-python) 介绍了使用 Langchain 开发智能体的基本知识。
