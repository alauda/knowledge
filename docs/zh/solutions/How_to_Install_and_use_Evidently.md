---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1756692696-9DEE
sourceSHA: 3e18227164775491b35a6ecb665d625d2c9064c3ae2d93cfb97f17d5e5b0ee7c
---

# Evidently

## 概述

Evidently 是一个开源的 AI 系统评估和监控平台，旨在构建、测试和监控数据驱动的 AI 系统。

它包含两个主要组件：

- **开源 Python 库**：提供 70 多种评估指标、声明式测试 API 和轻量级可视化接口
- **本地化 UI 服务**：提供完整的本地部署监控仪表板，包括项目管理、数据集管理、评估结果可视化和实时监控接口

帮助团队构建和维护可靠的高性能 AI 产品：从预测机器学习模型到复杂的 LLM 驱动系统。

## 核心概念

### 数据集

数据集是 Evidently 中数据的基本表示，基于 pandas DataFrame 构建。数据集包含：

- **原始数据**：以 pandas DataFrame 格式输入的数据
- **数据定义**：列类型和用途的元数据定义
- **描述符结果**：通过描述符生成的派生列
- **统计信息**：关于数据集的基本统计信息

数据集支持多种数据源格式，包括 CSV、Parquet 和 Evidently 特定格式。

### 数据定义

数据定义是数据集的元数据描述，定义每列的数据类型和用途：

- **基本列类型**：数值列、分类列、文本列、日期时间列、列表列
- **特殊列**：ID 列、时间戳列
- **描述符列**：通过描述符生成的数值和分类列

数据定义还支持指定机器学习任务类型：

- **机器学习任务**：分类、回归、推荐系统、LLM 任务定义

数据定义支持自动类型推断，也可以显式指定列类型以获得更好的性能和功能。

### 描述符

描述符是用于分析和转换数据的工具，生成新列或提供数据洞察：

- **文本分析**：情感分析、文本长度、单词计数、句子计数、非字母字符百分比等
- **LLM 评估**：拒绝检测、偏见检测、有毒性检测、PII 检测、正确性、忠实性、完整性等
- **内容检测**：包含特定词汇、正则表达式匹配、链接检测、开始/结束匹配等
- **结构验证**：JSON、Python、SQL 格式验证

描述符在创建数据集时计算，结果作为新列添加到数据集中。

### 报告

报告是 Evidently 的核心组件，用于生成评估结果和可视化：

- **指标集合**：包含多个指标或指标容器的列表
- **元数据**：报告的基本信息和标签
- **快照生成**：通过 `run()` 方法生成包含结果的快照

报告支持各种预设配置，例如数据质量监控、模型性能评估、数据漂移检测等。

### 指标

指标是用于评估数据质量和模型性能的计算单元：

- **数据质量指标**：缺失值、重复值、数据分布等
- **模型性能指标**：准确率、精确率、召回率、F1 分数等
- **漂移检测指标**：统计测试、分布比较等

指标可以单独使用或组合成指标容器。

### 预设

预设是预定义的指标集合，简化了常见监控场景的配置：

- **文本评估预设**：`TextEvals` - 文本和 LLM 评估
- **数据漂移预设**：`DataDriftPreset` - 数据分布漂移检测
- **数据概览预设**：`DataSummaryPreset` - 数据集概览和统计
- **分类预设**：`ClassificationPreset` - 分类任务质量
- **回归预设**：`RegressionPreset` - 回归任务质量

预设提供开箱即用的监控解决方案，大大简化了配置复杂性。

## 核心概念关系

- **数据集**是数据的基本容器，包含原始数据和元数据
- **数据定义**描述数据集的列类型和用途
- **描述符**在数据集上计算，生成新的分析列
- **报告**使用指标和预设来评估数据集
- **指标**提供特定的评估计算逻辑
- **预设**将相关指标组合成完整的监控解决方案

## 本地 UI 服务

### 服务架构

Evidently 的本地 UI 服务提供完整的本地部署解决方案，支持项目数据管理、安全认证、交互式监控界面和 API 接口。

### 核心功能

#### 项目管理

- **工作区管理**：创建和管理多个项目工作区
- **项目创建**：支持创建新的监控项目
- **项目配置**：灵活的项目设置和元数据管理

#### 报告管理

- **报告存储**：存储和管理评估结果报告
- **报告查看**：查看和下载评估报告
- **报告元数据**：管理报告的元数据和标签信息

#### 监控仪表板

- **指标可视化**：显示模型性能和数据质量指标
- **历史趋势**：查看指标随时间变化
- **报告查看**：查看和浏览评估报告

#### 可视化接口

- **报告显示**：查看和显示评估报告的可视化结果
- **图表显示**：显示各种指标和统计图表

## 主要特性

### 数据质量监控

- **基本统计**：行数、列数、缺失值、重复值统计
- **数据分布**：数值分布、分类分布、文本特征分析
- **数据完整性**：空值检测、格式验证、一致性检查

### 模型性能评估

- **分类模型**：准确率、精确率、召回率、F1 分数、ROC-AUC、混淆矩阵
- **回归模型**：MAE、MSE、RMSE、MAPE、R²、残差分析
- **推荐系统**：NDCG、MAP、MRR、HitRate、PrecisionTopK、RecallTopK 和其他排名质量指标

### 数据漂移检测

- **统计测试**：KS 测试、PSI、Wasserstein 距离等
- **分布比较**：数值、分类和文本数据的分布变化检测
- **嵌入漂移**：向量嵌入的漂移检测

### LLM 系统评估

- **内容质量**：正确性、忠实性、完整性评估
- **安全检测**：有毒性、偏见、PII 检测
- **行为分析**：拒绝检测、消极分析
- **一致性监控**：回答长度、情感基调一致性

### 支持的数据格式

- **输入格式**：pandas DataFrame、CSV、Parquet、Evidently 特定格式 (.evidently_dataset)
- **输出格式**：HTML 报告、JSON 结果、Evidently 数据集格式
- **可视化**：交互式 HTML 界面、图表和表格

## 用例

### 机器学习模型监控

- **模型性能跟踪**：实时监控生产环境中的模型性能
- **数据漂移检测**：及时检测输入数据分布的变化
- **模型退化告警**：根据性能指标设置告警阈值

### LLM 应用监控

- **内容质量保证**：监控 LLM 输出的质量和一致性
- **安全合规**：检测有害内容、偏见和隐私泄露
- **用户体验**：跟踪回答长度、情感基调和其他用户体验指标

### 数据质量保证

- **数据验证**：确保输入数据的完整性和正确性
- **异常检测**：识别数据中的异常值和模式
- **质量报告**：生成定期的数据质量报告

## 文档和参考

Evidently 提供全面的官方文档和 API 参考，帮助用户深入理解和使用平台功能：

### 官方文档

- **主文档**： <https://docs.evidentlyai.com/>
  - 详细介绍 Evidently 的核心概念和工作流程
  - 包括安装指南、快速入门和最佳实践
  - 提供常见用例、示例代码、教程和 API 参考

# Evidently UI 部署指南

本文档提供有关如何将 Evidently UI 部署到 Kubernetes 集群的详细说明，以及常见配置参数。

## 上传

下载 Evidently 安装文件： `evidently.ALL.v0.7.14-1.tgz`

使用 violet 命令发布到平台仓库：

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password evidently.ALL.v0.7.14-1.tgz
```

## 部署

### 存储准备

Evidently UI 将数据存储在文件系统中，需要持久存储。集群需要预先安装 CSI 或准备好 `PersistentVolume`。

### 创建应用程序

1. 转到 `Alauda Container Platform` 视图，选择将要部署 Evidently UI 的命名空间。

2. 在左侧导航中选择 `Applications` / `Applications`，然后单击打开页面右侧的 `Create` 按钮。

3. 在弹出对话框中选择 `Create from Catalog`，然后页面将跳转到 `Catalog` 视图。

4. 找到 `3rdparty/chart-evidently-ui`，然后单击 `Create` 创建此应用程序。

5. 在 `Catalog` / `Create evidently` 表单中，填写 `Name`（建议填写为 `evidently`）和 `Custom` 配置在 `Values` 中，然后单击 `Create` 按钮完成创建。`Custom` 的内容将在下面描述。创建后也可以通过 `Update` 应用程序方法修改配置。

## 配置

用户可以修改 `Application` 的 `Custom Values` 以调整配置。关键配置如下：

### 1. 存储配置

#### 1.1 存储类配置

通过添加以下配置指定存储类：

```yaml
statefulset:
  storage:
    storageClass: storage-class-name
```

### 2. 演示项目配置

Evidently 支持启动演示项目：

```yaml
# 启动所有可用的演示项目
demoProjects:
- all

# 或启动特定的演示项目
demoProjects:
- bikes

# 或禁用演示项目
demoProjects: []
```

可用的演示项目：

- `bikes` - 自行车租赁数据监控项目

### 3. 认证配置

#### 3.1 启用认证

```yaml
secret:
  value: "your-secret-key"
```

配置认证密钥后，Evidently 将启用访问控制：

- **Web UI 访问**：UI 界面将变为只读模式，无法执行创建、修改、删除等操作
- **API 访问**：所有 API 操作都需要在请求头中提供正确的密钥
  ```bash
  # 请求头格式
  evidently-secret: your-secret-key
  ```
- **SDK 使用**：在 SDK 中也需要配置相同的密钥以正常使用

**注意**：

- 当未配置密钥时，Evidently 将允许匿名访问，这在生产环境中存在安全风险
- Web UI 不支持令牌认证。配置密钥后，UI 将自动变为只读模式

## 访问地址

### 1. 外部访问地址

`Evidently UI` 通过 `Service` 提供外部访问。检查其 `Service` 以获取访问地址。

`Service` 名称与应用程序名称相同。

此 `Service` 类型为 `LoadBalancer`。如果环境中没有 `LoadBalancer` 控制器提供外部 IP，可以通过 `node IP` 及其 `NodePort` 进行访问。

### 2. 内部访问地址

要在集群内访问 Evidently UI，可以通过服务的 `ClusterIP`（与应用程序同名）及端口 8000 进行访问。

# Evidently 快速入门

本快速入门演示将引导您完成以下两个主要步骤：

1. **LLM 评估** - 使用 LLM 评估文本响应的质量和特征

2. **数据漂移检测** - 使用 Evidently 检测数据漂移和模型性能监控

通过本演示，您将学习如何使用 Evidently 进行机器学习模型监控、数据质量检查和 LLM 评估。

## 文件描述

- [setup-env.sh](/evidently/quickstart/setup-env.sh) - 设置演示中使用的环境变量
- [llm_evaluation.py](/evidently/quickstart/llm_evaluation.py) - LLM 评估演示脚本
- [data_and_ml_checks.py](/evidently/quickstart/data_and_ml_checks.py) - 数据漂移检测和 ML 模型监控演示脚本
- [requirements.txt](/evidently/quickstart/requirements.txt) - Python 依赖包

## 使用步骤

### 1. 准备 Evidently UI 服务

请参考 [部署文档](#evidently-ui-deployment-guide) 了解如何在 Kubernetes 环境中部署 Evidently UI。

### 2. 安装依赖

**Python 版本要求：**

- 支持 Python 3.10

```bash
pip install -r requirements.txt
```

### 3. 配置环境变量

编辑 `setup-env.sh` 文件以设置相关信息，然后使用以下命令导出环境变量：

```bash
source setup-env.sh
```

#### setup-env.sh 文件内容描述

`setup-env.sh` 文件包含演示所需的所有环境变量配置：

```bash
#!/bin/bash

# Evidently 配置
export EVIDENTLY_URL="http://localhost:8000"
export EVIDENTLY_SECRET="your-secret"
export DEBUG="false"

# LLM 配置（用于 LLM 评估）
export LLM_PROVIDER="deepseek"
export LLM_API_KEY="your-api-key"
export LLM_API_URL=""
export LLM_MODEL="deepseek-chat"
```

**重要说明：**

- **EVIDENTLY_URL**：Evidently UI 服务地址，请根据您的环境进行配置
- **EVIDENTLY_SECRET**：Evidently UI 认证的密钥
- **DEBUG**：设置为 `true` 以启用详细日志输出
- **LLM_xx**：LLM 评估的配置，支持多个 LLM 提供商

### 4. 运行 LLM 评估演示

```bash
python llm_evaluation.py
```

此脚本演示如何使用 Evidently 评估通过 LLM 的响应。让我们看看它的主要组件：

#### 4.1 准备测试数据

```python
def prepare_data():
    """准备测试数据并返回 DataFrame"""
    data = [
        ["金的化学符号是什么？", "金的化学符号是 Au。"],
        ["日本的首都是什么？", "日本的首都东京。"],
        ["告诉我一个笑话。", "程序员为什么不喜欢大自然？太多虫子！"],
        # ... 更多测试数据
    ]

    columns = ["问题", "回答"]
    eval_df = pd.DataFrame(data, columns=columns)
    return eval_df
```

**数据格式描述：**

- 使用 **pandas DataFrame** 作为标准数据格式
- DataFrame 包含两列：`问题`（问题）和 `回答`（回答）
- 这种格式便于使用 Evidently 进行数据分析和监控

#### 4.2 创建 LLM 评估数据集

```python
def create_dataset(eval_df):
    """创建带有 LLM 评估描述符的数据集"""
    eval_dataset = Dataset.from_pandas(
        eval_df,
        data_definition=DataDefinition(),
        descriptors=[
            Sentiment("回答", alias="情感"),
            TextLength("回答", alias="长度"),
            DeclineLLMEval("回答", alias="拒绝", provider=llm_provider, model=llm_model),
        ],
        options=options
    )

    return eval_dataset
```

**描述符描述：**

1. **Sentiment** - 情感分析描述符
   - 分析回答文本的情感倾向（积极、消极、中立）
   - 帮助监控回答的情感一致性
   - 检测回答是否过于消极或积极

2. **TextLength** - 文本长度描述符
   - 计算回答文本中的字符和单词数量
   - 监控回答长度的分布和变化
   - 检测回答是否过短或过长

3. **DeclineLLMEval** - LLM 拒绝检测描述符
   - **使用 LLM 判断回答是否包含拒绝语言**
   - LLM 分析回答内容，以识别其是否表达拒绝或无法回答
   - 评估回答的拒绝率和拒绝模式，提供更智能的文本理解

**更多描述符选项：**
Evidently 提供丰富的描述符用于文本和 LLM 评估。

有关详细列表，请参考：[Evidently AI - 所有描述符](https://docs.evidentlyai.com/metrics/all_descriptors)

#### 4.3 生成评估报告

```python
def generate_report(eval_dataset):
    """生成评估报告"""
    report = Report([
        TextEvals()
    ])
    my_eval = report.run(eval_dataset, None)
    return my_eval
```

**TextEvals 描述：**

- **TextEvals** 是 Evidently 的文本评估预设，专门用于文本和 LLM 评估
- 它会自动运行所有配置的描述符并生成全面的评估报告
- 报告包含详细的分析结果和每个描述符的可视化图表

**更多预设选项：**
Evidently 提供各种预设模板，包括：

- **文本评估**：文本和 LLM 评估
- **数据漂移**：数据分布漂移检测
- **数据摘要**：数据集概览和统计
- **分类**：分类任务质量评估
- **回归**：回归任务质量评估

有关详细信息，请参考：[Evidently AI - 所有预设](https://docs.evidentlyai.com/metrics/all_presets)

#### 4.4 查看报告

运行脚本后，您可以通过以下方式查看报告：

1. **访问 Evidently UI**：打开浏览器并访问环境变量中配置的 `EVIDENTLY_URL` 地址
2. **查找项目**：在 UI 中查找名为 "llm_evaluation" 的项目
3. **查看报告**：单击项目以查看详细的评估报告和可视化图表

### 5. 运行数据漂移检测演示

```bash
python data_and_ml_checks.py
```

此脚本演示如何使用 Evidently 进行数据漂移检测。让我们看看它的主要组件：

#### 5.1 数据准备

```python
def prepare_data():
    """准备参考数据集和生产数据集"""
    logger.info("加载成人数据集...")
    adult_data = datasets.fetch_openml(name="adult", version=2, as_frame="auto")
    adult = adult_data.frame
    adult_ref = adult[~adult.education.isin(["Some-college", "HS-grad", "Bachelors"])]
    adult_prod = adult[adult.education.isin(["Some-college", "HS-grad", "Bachelors"])]

    return adult_ref, adult_prod
```

**数据格式描述：**

- 使用 **pandas DataFrame** 作为标准数据格式
- 从 OpenML 数据集中加载数据
- 将数据分为参考数据集（`adult_ref`）和生产数据集（`adult_prod`）
- 这种格式便于使用 Evidently 进行数据漂移检测和比较分析

#### 5.2 数据集创建

```python
def create_datasets(adult_ref, adult_prod):
    """创建参考数据集和生产数据集"""
    schema = DataDefinition(
        numerical_columns=["education-num", "age", "capital-gain", "hours-per-week", "capital-loss", "fnlwgt"],
        categorical_columns=["education", "occupation", "native-country", "workclass", "marital-status", "relationship", "race", "sex", "class"],
    )

    ref_dataset = Dataset.from_pandas(
        pd.DataFrame(adult_ref),
        data_definition=schema
    )

    prod_dataset = Dataset.from_pandas(
        pd.DataFrame(adult_prod),
        data_definition=schema
    )

    return ref_dataset, prod_dataset
```

#### 5.3 生成报告

```python
def generate_report(ref_dataset, prod_dataset):
    """生成数据漂移报告"""
    report = Report([
        DataDriftPreset()
    ])
    my_eval = report.run(ref_dataset, prod_dataset)
    return my_eval
```

**DataDriftPreset 描述：**

- **DataDriftPreset** 是 Evidently 的数据漂移检测预设，专门用于检测数据分布变化
- 它会自动运行各种统计测试，以检测数值和分类特征的漂移
- 报告包括每列的漂移检测结果、统计显著性测试和可视化图表

#### 5.4 查看报告

运行数据漂移检测脚本后，您可以通过以下方式查看报告：

1. **访问 Evidently UI**：打开浏览器并访问环境变量中配置的 `EVIDENTLY_URL` 地址
2. **查找项目**：在 UI 中查找名为 "data_and_ml_checks" 的项目
3. **查看报告**：单击项目以查看详细的数据漂移检测报告和可视化图表

## 其他示例

除了上述快速入门演示外，Evidently 还提供更多高级功能和示例：

### 跟踪功能

- **跟踪快速入门**：用于捕获 LLM 应用程序的输入和输出并进行评估
- 注意：跟踪功能仅适用于 Evidently Cloud，不适用于自托管环境
- 有关详细描述，请参考：[Evidently AI - 跟踪快速入门](https://docs.evidentlyai.com/quickstart_tracing)

### 高级 LLM 评估功能

根据 [Evidently AI 示例文档](https://docs.evidentlyai.com/examples/introduction)，Evidently 还提供以下高级功能：

- **LLM 评估**：涵盖各种 LLM 评估方法的综合教程
- **RAG 评估**：针对增强检索生成（RAG）系统的专门评估方法
- **LLM 作为评估者**：使用 LLM 作为评估者来创建和评估 LLM 评估者
- **LLM 作为陪审团**：使用多个 LLM 评估相同的输出
