---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.0'
  - '4.2'
  - '4.3'
  - '4.4'
  - '4.5'
id: KB261100029
sourceSHA: 607d7be788059efb781e43eb44c1b1f64471d60770189ad4cf8de6b626499cf0
---

# 如何从 MongoDB 迁移到 DocumentDB

## 介绍

本指南描述了如何将现有的 **MongoDB** 实例（每个实例数百 GB 到 **1 TB+**）迁移到 **DocumentDB**（`documentdb-operator` 包 `v1.2.2`，上游操作员 `1.2.1`，DocumentDB 引擎 `1.0.1`，捆绑的 CloudNativePG `1.29.1`），该服务运行在 **ACP `4.0`、`4.2`–`4.5`**（Kubernetes `1.30`–`1.36`）上。

本指南中报告的所有基准和兼容性结果均在 ACP `4.0.12` 测试环境中测量（`Kubernetes v1.30.14`，`containerd 1.7.23`，`amd64`，IPv4，TopoLVM 存储）。

### 范围和边界

**涵盖内容：**

- 迁移前 MongoDB 兼容性评估
- 迁移策略和维护窗口估算
- 存储和暂存容量规划
- 步骤详尽的离线迁移操作步骤
- 数据一致性验证和回滚计划

**不涵盖内容：**

- 重构使用不支持的 MongoDB 特性的应用查询或模式
- 针对特定业务应用的每实例切换执行

## 迁移前兼容性检查清单

在 DocumentDB `1.0.1` 上测量的目标引擎元数据：`hello.maxWireVersion = 21`，`buildInfo.version = 7.0.0`。

### 验证的能力

| 类别         | 测试的特性                                                                                               | 结果  |
| ------------ | ------------------------------------------------------------------------------------------------------- | ----- |
| 基本 CRUD    | `insert`，`find`，`update`，`delete`                                                                    | 通过  |
| 索引         | 单字段、复合、唯一（拒绝重复键）、TTL、`text`（`$text`）、`2dsphere`（`$near`）、部分索引               | 通过  |
| 聚合         | `$match`，`$group`，`$lookup`                                                                            | 通过  |
| 事务         | 多文档事务（`startSession` + `withTransaction`）                                                       | 通过  |
| GridFS       | `mongofiles` 进行 SHA-256 验证的上传/下载                                                                | 通过  |

### 高风险和不支持项（迁移前检查）

| 项目                                               | 风险/限制                                                                                                                               | 推荐行动                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **`collation`**                                    | **不支持。** 验证错误：`collation is not supported in the find command yet`。                                                         | 审计查询、索引和集合默认值中的 `collation`；受影响的工作负载在迁移前需要进行应用更改。                                          |
| 旧版驱动程序 / 传输协议                           | MongoDB 3.x / 4.0 时代的驱动程序可能无法与更新的传输协议进行协商。                                                                  | 清点所有客户端应用程序中的驱动程序版本，并针对 DocumentDB 测试每个版本。                                                  |
| 分片集群                                         | 目标 DocumentDB 实例为非分片。                                                                                                        | 从 `mongos` 导出并合并到单个 DocumentDB 实例；为合并的数据集大小进行容量规划。                                              |
| 变更流（在目标上）                               | 需要 `ChangeStreams` 特性门控（`wal_level=logical` 和单独的变更流镜像），在 `combined` 模式下**未验证**。                          | 将依赖于变更流的应用视为高风险，并单独评估。                                                                                  |
| 用户和角色                                       | SCRAM 用户和自定义角色不会随 BSON 转储迁移。                                                                                          | 在 DocumentDB 上手动重新创建用户和角色，并验证最小权限访问。                                                                |
| 视图、限量集合、验证器、`system.js`              | 可能不支持或行为不同。                                                                                                                 | 导出定义并验证每个项目与目标实例的兼容性。                                                                                  |
| 其他聚合阶段 / 操作符                             | 并非所有 MongoDB 操作符在基线验证中都被测试。                                                                                        | 在暂存 DocumentDB 实例上重放具有代表性的生产查询和聚合。                                                                    |

### 源发现脚本（`mongosh`）

在承诺迁移窗口之前，针对源 MongoDB 实例运行以下检查：

```javascript
// 1) 服务器版本和拓扑
db.version();
db.adminCommand({ hello: 1 });

// 2) 每个数据库的集合元数据：视图、限量、验证器、默认排序
db.adminCommand({ listDatabases: 1 }).databases.forEach(d => {
  const x = db.getSiblingDB(d.name);
  x.getCollectionInfos().forEach(c => {
    const o = c.options || {};
    if (c.type === "view" || o.capped || o.validator || o.collation) {
      print(
        d.name + "." + c.name,
        JSON.stringify({
          type: c.type,
          capped: !!o.capped,
          validator: !!o.validator,
          collation: o.collation
        })
      );
    }
  });
});

// 3) 带有排序的索引
db.adminCommand({ listDatabases: 1 }).databases.forEach(d => {
  const x = db.getSiblingDB(d.name);
  x.getCollectionNames().forEach(n =>
    x[n].getIndexes().forEach(i => {
      if (i.collation) print(d.name + "." + n, i.name, JSON.stringify(i.collation));
    })
  );
});

// 4) 存储在 system.js 中的 JavaScript 函数
db.adminCommand({ listDatabases: 1 }).databases.forEach(d => {
  const n = db.getSiblingDB(d.name).getCollection("system.js").countDocuments({});
  if (n > 0) print(d.name, "system.js:", n);
});

// 5) 用户和自定义角色（每个数据库运行）
db.getUsers();
db.getRoles({ showBuiltinRoles: false });

// 6) 使用排序的实时查询（需要在代表性工作负载窗口内启用分析器）
db.system.profile.find({ "command.collation": { $exists: true } }).limit(20);

// 7) 连接的客户端驱动程序版本
db.currentOp(true)
  .inprog.filter(o => o.clientMetadata)
  .map(o => o.clientMetadata.driver);
```

## 迁移策略

### 基线路径（推荐，已验证）：离线 `mongodump` / `mongorestore`

```text
冻结写入 → mongodump --gzip（从从节点） → mongorestore --noIndexRestore → 重建从索引 → 验证 → 切换
```

#### 测量基线（ACP `4.0.12`，3 实例 DocumentDB，TopoLVM）

| 指标                                                       | 测量值                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 测试数据集                                                 | `2.03 GB` 原始 BSON，2,000,000 文档，4 个集合（平均文档约 1 KB）                                                           |
| 数据加载（`mongorestore --noIndexRestore`，4x4 并发）    | **51 s（约 143 GB/h）**，2,000,000 成功，0 失败                                                                          |
| 从索引构建（8 个索引）                                    | **63 s**                                                                                                                |
| 合并加载 + 索引吞吐量                                     | **约 64 GB/h**                                                                                                         |
| PostgreSQL 存储放大                                       | **1.33x**（`2,565 MiB` 数据库大小 / `1,934 MiB` 原始 BSON，包括 `_id` 和 8 个从索引）                                   |
| WAL 磁盘占用                                             | 在默认情况下限制为 **约 2.5–3 GB**（`max_wal_size=2GB`，`wal_keep_size=512MB`）；不会随着数据集大小线性增长             |

> **注意：** 基线数据集是合成的，主要适合内存。仅将这些数字用于数量级规划。**通过运行代表性的 10–50 GB 真实生产数据样本来确定实际维护窗口**（下面的步骤 3）。

#### 1 TB 数据集的线性估算

| 阶段                                   | 基线的线性投影                        |
| --------------------------------------- | -------------------------------------- |
| 数据加载（约 143 GB/h）                | 约 7 小时                              |
| 从索引重建                             | 约 9 小时（高度依赖于索引数量和类型） |
| 源转储、传输和验证                     | 根据源 I/O 和网络单独考虑             |
| **最低计划维护窗口**                  | **约 16 小时+**                        |

当数据超过可用 RAM、文档更大或集合有很多索引时，实际吞吐量将低于线性预测。预留额外的缓冲时间。

### 增量 / 在线同步（例如，MongoShake）— 未验证

在线同步工具读取源副本集的 oplog，并将批量写入和 DDL 重放到目标，以缩短切换停机时间。

- **当前状态：** 批量 upserts、`applyOps` 风格的批处理和索引 DDL 与 DocumentDB 的兼容性**尚未验证**。
- **入口门槛：** 在 **1–10 GB 代表性试点** 完成全量同步 + 增量追赶 + 零差异一致性验证无错误之前，请勿承诺在线同步。
- 在该试点成功之前，**仅围绕离线维护窗口基线进行规划**。

## 容量规划

| 资源                      | 推荐                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| 每个 DocumentDB 实例的 PVC | **>= 1.6x–2x 源原始数据大小**（`1.33x` 观察到的放大 + WAL + 增长余量）                       |
| 集群总存储               | 每个副本持有完整副本：对于 3 实例集群，总存储 = `3 x 单实例 PVC`                             |
| 转储暂存磁盘             | **0.4x–0.6x 源原始数据大小**（gzip 压缩比变化；在样本上验证）                               |

对于 **1 TB** 的原始源数据：为每个实例分配 **1.6–2 TB PVC**（**总共 4.8–6 TB**，跨 3 个实例）和 **400–600 GB** 用于暂存转储。

## 标准迁移操作步骤

1. **预检查**
   - 完成兼容性检查清单和上述 `mongosh` 发现脚本。
   - 确认所有不兼容特性已解决或明确接受。
   - 确认维护窗口和回滚负责人。
2. **准备目标**
   - 部署根据容量规划大小设置的目标 `DocumentDB` 集群（明确设置 `spec.exposeViaService.serviceType`）。
   - 重新创建应用用户和角色。
   - 准备暂存存储和 MongoDB 数据库工具（`mongosh`，`mongodump`，`mongorestore`；对于隔离环境，预同步一个工具镜像，如 `mongo:7.0`，约 290 MiB）。
3. **样本排练和大小估算**
   - 在代表性的 **10–50 GB** 切片（或最大集合）上运行完整的导出 → 加载 → 索引重建 → 验证工作流。
   - 测量实际吞吐量和存储放大，以最终确定生产窗口。
4. **冻结写入**
   - 停止应用写入并确认源写入计数器平稳（`db.serverStatus().opcounters`）。
   - 可选地将源实例置于只读模式。
5. **从从节点导出**
   ```bash
   mongodump \
     --uri="mongodb://<user>:<password>@<source-secondary>/?authSource=admin&readPreference=secondary" \
     --gzip --numParallelCollections=4 --out=/backup/dump
   ```
   仅导出应用数据库；**不要** 恢复 `admin`、`config` 或 `local`。
6. **无索引加载数据**
   ```bash
   mongorestore \
     --uri="mongodb://<user>:<password>@documentdb-service-<instance-name>.<namespace>.svc:10260/?tls=true&directConnection=true" \
     --tlsInsecure --gzip --numParallelCollections=4 --numInsertionWorkersPerCollection=4 \
     --noIndexRestore --nsExclude='admin.*' --nsExclude='config.*' --nsExclude='local.*' \
     /backup/dump
   ```
   - 仅在自签名测试证书中使用 `--tlsInsecure`；在生产中传递 `--tlsCAFile`。
   - 从输出日志中记录总恢复和失败的文档计数。
7. **显式重建索引**
   - 使用从源 `getIndexes()` 导出的定义通过 `createIndex` 重新创建从索引。
   - 跳过或调整任何指定了 `collation` 的索引。
   - 记录每个索引的构建持续时间。
8. **验证一致性**
   - 在切换之前完成下面数据一致性验证部分中的所有检查。
9. **切换应用**
   - 更新应用连接字符串（主机、端口 `10260`、TLS 设置）或 DNS，并逐步恢复写入。
10. **观察期**
    - 监控错误日志、慢查询和存储利用率。在观察期内保持源 MongoDB 完好且只读。

## 数据一致性验证

| 检查             | 方法                                                                                                           | 通过标准                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 文档计数         | 在源和目标上对每个集合执行 `countDocuments({})`                                                              | 精确匹配                                        |
| 索引元数据       | 比较每个集合的 `getIndexes()`（`name`、`key`、`unique`、`expireAfterSeconds`、`partialFilterExpression`） | 精确匹配，排除文档中不支持的选项                |
| 内容抽样         | 随机抽样源中的 `0.1%–1%` `_id` 值，计算两边的标准 SHA-256                                                  | `0` 不匹配                                       |
| 边界记录         | 按 `_id` 对每个集合的第一个和最后一个文档进行比较                                                              | 精确匹配                                        |
| 应用烟雾测试     | 运行核心读/写业务流程                                                                                         | 通过                                            |

### 参考规范哈希抽样脚本（`mongosh`）

在源数据库上**一次**生成抽样的 `_id` 列表，保存并在源和目标上查询完全相同的 `_id` 列表以比较哈希：

```javascript
// 递归排序对象键，以便字段顺序差异不会导致假阳性
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object" && !(v instanceof Date) && v.constructor === Object) {
    return Object.keys(v).sort().reduce((o, k) => ((o[k] = canon(v[k])), o), {});
  }
  return v;
}

const crypto = require("crypto");
const coll = db.getSiblingDB("<db-name>").getCollection("<collection-name>");

// 步骤 A（仅源）：抽样 N 个 _ids 并保存列表
const ids = coll
  .aggregate([{ $sample: { size: 1000 } }, { $project: { _id: 1 } }])
  .toArray()
  .map(d => d._id);

// 步骤 B（在源和目标上使用相同的保存的 `ids` 列表运行）
ids.forEach(id => {
  const d = coll.findOne({ _id: id });
  print(
    EJSON.stringify(id),
    crypto.createHash("sha256").update(EJSON.stringify(canon(d))).digest("hex")
  );
});
```

## 回滚计划

- **在维护窗口期间：** 源 MongoDB 保持只读且未修改。如果任何验证步骤失败，请将应用连接字符串或 DNS 切换回源 MongoDB，并重新启用写入。
- **切换后：** 提交到 DocumentDB 的新写入**不会自动复制回** MongoDB。
  - 在初始接受窗口期间限制或严格控制关键写入。
  - 如果在切换后需要回滚，请手动评估和调和切换后的写入。
  - 在正式接受完成之前**不要** 停用或删除源 MongoDB。

## 风险总结

1. **`collation` 不受支持**，是最常见的迁移障碍——首先审计它。
2. 从 **真实的 10–50 GB 样本排练** 中确定维护窗口；将约 16 小时用于 1 TB 视为下限。
3. 在 1–10 GB 试点通过端到端之前，不要承诺在线/增量同步（MongoShake）。
4. 为每个 PVC 提供 `>= 1.6x–2x` 原始数据大小（3 实例 HA 总共 `3x`）。
5. 确保客户端驱动程序处理约 8 秒的主故障转移窗口的自动重连。

## 参考文献

- [DocumentDB Kubernetes Operator](https://github.com/documentdb/documentdb-kubernetes-operator)
- [DocumentDB Kubernetes Operator 文档](https://documentdb.io/documentdb-kubernetes-operator/)
- [DocumentDB 引擎](https://github.com/documentdb/documentdb)
- [CloudNativePG 文档](https://cloudnative-pg.io/documentation/)
- [cert-manager 文档](https://cert-manager.io/docs/)
- [MongoDB 数据库工具（`mongodump` / `mongorestore` / `mongofiles`）](https://www.mongodb.com/docs/database-tools/)
- [MongoShake](https://github.com/alibaba/MongoShake)
