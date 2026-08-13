---
kind:
  - Solution
products:
  - Alauda Application Services
ProductsVersion:
  - 4.x
id: KB260721001
sourceSHA: d5795429a47684484aa3cc43c172104eb2a020f9822515ebdb4e7a9635f1ed7d
---

# 如何在网络隔离的集群之间迁移 PostgreSQL 实例

## 背景

### 挑战

在 [PostgreSQL 实例跨集群迁移指南](./How_to_Migrate_a_PostgreSQL_Instance_Across_Clusters.md) 中描述的流复制迁移要求目标集群能够访问源集群的网络。在许多实际部署中，集群是网络隔离的——独立的平台、防火墙保护的站点、断开的安全区域——并且不存在这样的路径或无法打开。

### 解决方案

当管理员工作站能够同时访问 **两个** Kubernetes API 服务器时，迁移可以通过工作站中继：`pg_dump` 在源 pod 中运行，`pg_restore` 在目标 pod 中运行，数据通过两个 `kubectl exec` 通道在工作站中连接。集群之间从不交换数据包。

该操作步骤包括四个人工操作：创建目标实例（步骤 1）、停止应用写入（步骤 2）、运行迁移脚本（步骤 3）和切换（步骤 4-5）。该脚本迁移实例的 **每个** 应用数据库并验证每一个。

由于传输是逻辑上的（SQL 级别），此方法没有相同版本的要求：它可以跨不同的 operator 版本、跨 CPU 架构，并且可以从较旧的 PostgreSQL 主版本迁移到目标上的相同或更新的主版本。不支持迁移到 **较旧** 的 PostgreSQL 主版本（降级）。

**权衡：** 与流复制不同，这是一个时间点的复制。在转储开始后在源上进行的写入不会被转移——在整个转储+恢复窗口期间必须停止应用写入，因此停机时间等于完整复制的持续时间。

### 迁移的内容和不迁移的内容

逻辑迁移携带的内容少于字节级复制。在依赖它之前要了解边界：

| 本过程携带的内容                                                      | 不携带的内容 — 需谨慎处理                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 表、数据、索引、视图、函数、序列（包括位置）                          | `GRANT`（`-x` 在恢复时跳过 ACL；它们仍然保留在转储文件中——见步骤 4）                                                                                                                                                                                                     |
| 角色及其属性（在步骤 1 中生成到目标 CR 中）                          | `COMMENT ON` 元数据（`--no-comments`；为了可验证的退出代码而故意损失）                                                                                                                                                                                            |
| 数据库编码和区域设置（由脚本强制执行）                                | CR 规范超出 `users`/`databases`/`volume`：`resources`、`postgresql.parameters`、`patroni.pg_hba`、`connectionPooler`、pod 安全设置（`restrictedPsaEnabled`、`spiloPrivileged`、`spiloRunAsUser` 等）、sidecars、负载均衡器标志——在目标 CR 中自行迁移 |
| 数据库和角色级别的设置（`ALTER DATABASE/ROLE ... SET`）             | 需要超级用户的对象：事件触发器、发布/订阅、FDW 服务器和用户映射                                                                                                                                                                                   |
| 扩展（保留模式和版本）                                              | 表空间布局（`--no-tablespaces` 将所有内容映射到默认值）                                                                                                                                                                                                                    |
| 规划器统计（在窗口中通过 `ANALYZE` 重新生成）                          | 使用 `preparedDatabases` 的实例（其 `<db>_owner/_reader/_writer` 角色模型和 `user_management` 模式超出本指南的范围）                                                                                                                                           |

通过源侧 `connectionPooler` 服务连接的应用需要在目标 CR 中声明池化器，否则它们的连接端点在切换时会发生变化。

## 环境信息

- PostgreSQL Operator：每侧任意 4.x 版本（版本不需要匹配）
- PostgreSQL：目标主版本等于或高于源版本
- 工作站：`bash` 和 `kubectl` 访问（kubeconfig/context）两个集群

## 先决条件

- 工作站上有两个 kubeconfig 上下文，每个集群一个；验证两者均可工作：

```bash
SRC_CTX="<source-context>";  SRC_NS="<source-namespace>";  SRC_CLUSTER="<source-instance-name>"
TGT_CTX="<target-context>";  TGT_NS="<target-namespace>";  TGT_CLUSTER="<target-instance-name>"

kubectl --context $SRC_CTX -n $SRC_NS get postgresql $SRC_CLUSTER
kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER 2>/dev/null || echo "目标实例尚未创建"
```

- 工作站带宽足够以支持两个 API 服务器的数据库大小（所有数据通过工作站流动）。
- 从排练中确定的维护窗口大小（见下文）——不要猜测。
- 两个实例上都有稳定的窗口：没有待处理的节点维护或驱逐。脚本在开始时解决每个主 pod；在运行中进行的 Patroni 故障转移会将流发送到降级的 pod。对于长时间运行的任务，考虑在两侧都使用 `patronictl pause`，并在发生故障转移时重新处理任何正在进行的数据库。
- 在两个命名空间中具有足够的 Kubernetes 权限：`get` 和 `list` 权限在 `postgresqls.acid.zalan.do`、`pods` 和 `secrets` 上；在目标侧额外的 `create` 权限在 `postgresqls` 和 `secrets`（凭证预先准备）以及 `patch` 权限在 `secrets`（故障排除）；在源侧，最后清理时，`delete` 权限在 `postgresqls` 和 `persistentvolumeclaims` 上。
- 这些命令假定 operator 的标准 Spilo 镜像：pod 标签 `spilo-role`/`cluster-name`，数据库容器名为 `postgres`，客户端二进制文件位于 `/usr/lib/postgresql/<major>/bin/`（当前镜像捆绑 13-17；脚本在启动前验证所需的主版本）。自定义或非 Spilo 镜像需要调整这些标签和路径。

### 排练和确定窗口大小

停止写入窗口等于完整的转储+恢复+验证持续时间——在不知道该数字的情况下不要打开维护窗口。首先进行排练：针对一个临时目标实例运行步骤 1，并在 **不停止源写入** 的情况下运行步骤 3 脚本。期望 `FAIL` 判定（`SOURCE CHANGED DURING DUMP` 在这里是正常的）——排练测量的是 *持续时间*，而不是正确性。然后删除排练目标（CR 和 PVC）。

在真实窗口之前设定一个进行/不进行的规则：如果验证未通过且剩余窗口时间未达到商定的边际，则回滚——重新启用源写入，保持源不变，并离线调查。目标可以随时删除并重新创建；源是资产。

## 步骤 1：创建目标实例

列出源实际拥有的应用数据库和所有者：

```bash
SRC_POD=$(kubectl --context $SRC_CTX -n $SRC_NS get pod \
  -l spilo-role=master,cluster-name=$SRC_CLUSTER -o jsonpath='{.items[0].metadata.name}')

kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -tA -c \
  "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database
   WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1;"
```

此列表中的每个 CR 管理的数据库必须在目标 CR 中声明（`spec.databases`，其所有者在 `spec.users` 中）——operator 创建角色和数据库并管理其凭证；不要尝试使用 `pg_dumpall` 从源转储全局对象（角色）。`postgres` 维护数据库由每侧的 operator/image 管理，并且不进行迁移。由 `postgres` 拥有的数据库（在 CR 规范之外创建）不会进入 CR——迁移脚本会自动在目标上创建它们。

目标 CR 的 `users:`/`databases:` 部分可以直接从源生成，而不是手动编写。`users:` 生成器从 `pg_roles` 枚举 **所有** 应用角色——不仅仅是数据库所有者——因为只读、监控和不拥有数据库的每个服务帐户也必须在目标上存在，并且它携带每个角色的属性作为 `userFlags`（在目标上生成的角色如 `some_role: []` 会默默丢失 `NOLOGIN`、`CREATEDB` 等）：

```bash
{
  echo "  users:"
  kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    psql -U postgres -tA -c \
    "SELECT '    ' || rolname || ': [' || array_to_string(ARRAY(
       SELECT f FROM unnest(ARRAY[
         CASE WHEN rolsuper THEN 'superuser' END,
         CASE WHEN rolcreatedb THEN 'createdb' END,
         CASE WHEN rolcreaterole THEN 'createrole' END,
         CASE WHEN NOT rolcanlogin THEN 'nologin' END]) f WHERE f IS NOT NULL), ',') || ']'
     FROM pg_roles
     WHERE rolname NOT LIKE 'pg\_%'
       AND rolname NOT IN ('postgres','standby','pooler','admin','zalandos','cron_admin','robot_zmon')
     ORDER BY (rolname) COLLATE \"C\";"
  echo "  databases:"
  kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
    psql -U postgres -tA -c \
    "SELECT '    ' || datname || ': ' || pg_get_userbyid(datdba) FROM pg_database
     WHERE NOT datistemplate AND datname <> 'postgres' AND pg_get_userbyid(datdba) <> 'postgres' ORDER BY 1;"
}
```

在应用之前检查生成的 `users:` 列表：`NOT IN` 过滤器排除了标准的 operator/image 系统角色——如果您的部署定义了其他 operator 管理的角色，也请排除这些，而不是在 CR 中声明它们。

### 保留应用凭证

默认情况下，目标 operator 为 CR 用户生成 **新** 密码，这将迫使每个应用在切换时重新配置。为了保留源密码，在创建 CR **之前** 将每个应用用户的凭证秘密复制到目标命名空间——当 operator 找到现有的凭证秘密时，它会采用它并从中设置角色的密码，而不是生成新密码：

```bash
SUFFIX="credentials.postgresql.acid.zalan.do"
for SEC in $(kubectl --context $SRC_CTX -n $SRC_NS get secret \
    -l application=spilo,cluster-name=$SRC_CLUSTER -o name); do
  NAME=${SEC#secret/}
  U=${NAME%.$SRC_CLUSTER.$SUFFIX}
  [ "$U" = "$NAME" ] && continue                          # 不是凭证秘密
  case "$U" in postgres|standby|pooler) continue ;; esac  # operator 管理的系统用户
  UB64=$(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.username}')
  PB64=$(kubectl --context $SRC_CTX -n $SRC_NS get $SEC -o jsonpath='{.data.password}')
  [ -n "$UB64" ] && [ -n "$PB64" ] \
    || { echo "WARNING: $NAME 的用户名/密码字段为空 — 跳过（请先在源上修复）" >&2; continue; }
  kubectl --context $TGT_CTX -n $TGT_NS apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: $U.$TGT_CLUSTER.$SUFFIX
data:
  username: $UB64
  password: $PB64
EOF
done
```

复制的秘密在 operator 采用之前不携带任何 operator 标签或 ownerReference，因此如果您放弃迁移并删除目标 CR，请手动删除这些预先准备的秘密——它们不会被垃圾回收。

用户名来自 **秘密的名称**（与目标 operator 将查找的 CR 用户匹配），而不是来自秘密的 `username` 字段，凭证字节以 base64 原样复制——在工作站上不进行解码。`postgres`、`standby` 和 `pooler` 系统用户故意被跳过：它们属于每个实例自己的 operator。顺序很重要：首先预先准备秘密，然后创建 CR（如果 CR 首先创建，请参见 [故障排除](#troubleshooting)）。如果源上启用了 **密码轮换**（`enable_password_rotation`），则秘密中的轮换登录用户名将与目标 operator 创建的任何角色不匹配——在迁移窗口期间禁用轮换，并使用基本凭证进行迁移。

将目标作为普通实例创建（无 `clusterReplication`），大小与源相同：

```yaml
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: acid-target          # $TGT_CLUSTER
  namespace: target-namespace
spec:
  teamId: acid
  numberOfInstances: 1       # 在单个实例上恢复；在步骤 4 之后扩展
  postgresql:
    version: "16"            # 与源相同，或更新的主版本
  # Pod 安全 — 复制源的值；请参阅下面的“匹配源的 pod 安全设置”。对于受限命名空间，作为一组是必需的；仅 operator 4.2.0+。如果源省略了整个块，则省略。
  restrictedPsaEnabled: true
  spiloAllowPrivilegeEscalation: false
  spiloPrivileged: false
  spiloRunAsUser: 101
  spiloRunAsGroup: 103
  users:
    app_owner: []            # 上面生成
  databases:
    appdb: app_owner         # 上面生成
  volume:
    size: 10Gi               # ~2x 源数据大小：数据 + 正在重建的索引 + 恢复期间的 WAL 增长
    storageClass: <target-storageclass>
```

在单个实例中恢复可以避免流复制和 WAL 存档的完整恢复 WAL 峰值；在验证后（步骤 4）将 `numberOfInstances` 扩展。根据余量调整 `volume` 大小——逻辑恢复同时保持数据、正在构建的索引和恢复自身的 WAL。

等待实例实际准备就绪——`Running` 报告 pod 健康，而 operator 会 **异步** 创建角色、数据库和凭证秘密，因此轮询步骤 3 依赖的对象：

```bash
until [ "$(kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER \
    -o jsonpath='{.status.PostgresClusterStatus}')" = "Running" ]; do sleep 5; done

TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

# 每个 CR 声明的用户必须作为角色存在，并且其凭证秘密：
until [ "$(kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
    psql -U postgres -tA -c "SELECT count(*) FROM pg_roles WHERE rolname = 'app_owner';")" = "1" ] \
  && kubectl --context $TGT_CTX -n $TGT_NS get secret \
    "app-owner.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do" >/dev/null 2>&1
do sleep 5; done
```

注意秘密的名称：operator 会将角色名称标准化为 RFC 1123 形式，因此像 `app_owner` 的角色会得到秘密 `app-owner.<cluster>.credentials...`（`_` 变为 `-`）。在通过名称获取秘密时，请使用标准化形式。

### 匹配源的 pod 安全设置

Pod 安全是 CR 的属性，而不是数据的属性——此过程中的任何内容都不会携带它，因此目标将根据其自己的 CR 声明运行。将整个集合从源复制过来：

```bash
kubectl --context $SRC_CTX -n $SRC_NS get postgresql $SRC_CLUSTER -o jsonpath='
restrictedPsaEnabled:          {.spec.restrictedPsaEnabled}
spiloAllowPrivilegeEscalation: {.spec.spiloAllowPrivilegeEscalation}
spiloPrivileged:               {.spec.spiloPrivileged}
spiloRunAsUser:                {.spec.spiloRunAsUser}
spiloRunAsGroup:               {.spec.spiloRunAsGroup}
{"\n"}'
```

**将这五个视为一个设置，而不是五个独立的设置。** 如果目标命名空间强制执行受限 Pod 安全标准，仅 `restrictedPsaEnabled: true` 本身不足以使实例运行：

- `restrictedPsaEnabled` 使 pods 具有 `runAsNonRoot: true`、`RuntimeDefault` seccomp 配置文件、`allowPrivilegeEscalation: false` 和 `capabilities.drop: [ALL]`。它并不会清除 `privileged`，这遵循 operator 自身的配置并可能默认为 `true`——在受限标准下，特权容器无论 CR 说什么都被拒绝。`spiloPrivileged: false` 是清除它的关键。
- `runAsNonRoot: true` 而没有非根 uid 是运行时失败，而不是入场失败：pod 被接纳，然后 kubelet 拒绝启动一个将以 root 身份运行的容器。`spiloRunAsUser: 101` / `spiloRunAsGroup: 103` 是 operator 为 Spilo 镜像定义的默认值。

通过平台控制台创建的实例将这五个一起携带；手动应用的 CR 通常不携带任何。检查目标命名空间的要求，然后再创建 CR：

```bash
kubectl --context $TGT_CTX get ns $TGT_NS \
  -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}{"\n"}'
```

不匹配的两个方向都会给您带来损失。设置太少，目标永远无法达到 `Running`，因此步骤 3 没有 pod 可以执行。设置为空，而源是受限的，迁移会悄悄将应用返回到切换前运行的较弱安全状态。

迁移本身无论如何都不受影响：步骤 3 中的每个操作都通过 `kubectl exec` 和 pod 本地套接字运行，转储文件在工作站上写入，而不是在 pod 内部。

**这些字段有版本底线。** 它们仅在 operator **4.2.0** 及更高版本中存在——没有 4.0.x 或 4.1.x 版本具有它们，并且它们由 operator 包安装的 CRD 承载，而不是 Helm chart 中的 CRD。缺少 CRD 中的属性时，API 服务器 **在应用时修剪它**：没有错误，没有警告，它在之后根本不存在。因此，在较旧的目标上，您可以应用上述 CR，看到它被接受，并获得没有您认为请求的安全上下文的 pods。请读取值，而不是信任应用：

```bash
kubectl --context $TGT_CTX -n $TGT_NS get postgresql $TGT_CLUSTER \
  -o jsonpath='{.spec.restrictedPsaEnabled}{"\n"}'
```

这里的空行——在应用设置了它的 CR 之后——意味着此目标根本无法遵守这些设置。如果源是受限的，并且目标 operator 早于 4.2.0，请在迁移之前升级目标 operator，或者接受差异作为故意决定，而不是在切换后发现。

## 步骤 2：停止写入

停止源上的应用写入——传输是时间点的复制，转储开始后写入的任何内容都会丢失。

不要依赖“团队说应用已停止”：**强制**它。阻止新连接并终止剩余连接将潜在的静默数据丢失转变为立即可见的故障：

```bash
# 每个应用数据库：没有新的非超级用户连接，杀死滞后者
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -c "ALTER DATABASE <database> CONNECTION LIMIT 0;"
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = '<database>' AND usename NOT IN ('postgres','standby');"
```

（如果您中止迁移，请使用 `ALTER DATABASE <database> CONNECTION LIMIT -1;` 恢复访问。）作为第二道防线，步骤 3 脚本在每次传输后重新读取源行计数，并在任何内容移动时以 `SOURCE CHANGED DURING DUMP` 使该数据库失败。

脚本会自动记录并比较每个表的确切行计数。为了对关键表提供更强的保证，现在还可以记录每个表的校验和，并在步骤 4 中重新检查它们。使用在 PostgreSQL 版本之间稳定且对 NULL 明确的构造（对可以为 NULL 的表达式进行聚合会默默跳过这些行）：

```bash
kubectl --context $SRC_CTX -n $SRC_NS exec $SRC_POD -c postgres -- \
  psql -U postgres -d <database> -tA -c \
  "SELECT count(*), md5(string_agg(id::text || ':' || coalesce(payload,'<NULL>'), '|' ORDER BY id))
   FROM <your_table>;"
```

## 步骤 3：运行迁移脚本

该脚本在一次运行中执行整个迁移：它枚举源的应用数据库，确保每个数据库在目标上 **具有源的编码和区域设置**（重新创建空的不同数据库——这也涵盖 CR 创建的数据库，operator 使用目标默认值构建），预先创建缺失的扩展，保留其模式和版本，传输每个数据库，携带数据库级设置，运行 `ANALYZE`，并验证行计数、对象普查和序列位置——每个数据库报告 `PASS`/`FAIL`，如果有任何失败则以非零状态退出。

在顶部填写六个变量，然后使用 `bash` 运行它。没有参数时，它迁移每个数据库；传递数据库名称（`bash migrate.sh appdb`）仅迁移这些——用于在失败后重新处理单个数据库。每次传输都通过相同的脚本以两种模式之一进行：

- **文件模式**（默认；使用 `DUMP_DIR=/path` 覆盖位置）：每个数据库首先转储到 `$DUMP_DIR/<db>.dump`，然后从文件恢复。这是默认值，因为长期存在的 `kubectl exec` 流是此中继中的脆弱环节——API 服务器负载均衡器和 kubelet 空闲超时可能会中断数小时的流，而文件使得成本仅为一个数据库，而不是整个运行。默认情况下，每次运行都会进行 **全新** 转储；设置 `REUSE_DUMPS=1` 以重用已完成的转储（可恢复）。重用仅在 **同一停止写入维护窗口内** 安全——在源写入恢复之前进行的转储将默默迁移过时数据。
- **管道模式**（`PIPE_MODE=1 bash migrate.sh`）：源直接流入目标——在工作站上没有中间存储。对于小实例（大约 5 GB 以下）是可以接受的，因为中断的流只意味着快速重跑；对于需要数小时的任何内容，请使用文件模式。

```bash
#!/usr/bin/env bash
# 整个实例 PostgreSQL 迁移通过工作站中继。
# 将 $SRC_CLUSTER 的每个应用数据库迁移到 $TGT_CLUSTER。
set -u -o pipefail

SRC_CTX="<source-context>";  SRC_NS="<source-namespace>";  SRC_CLUSTER="<source-instance-name>"
TGT_CTX="<target-context>";  TGT_NS="<target-namespace>";  TGT_CLUSTER="<target-instance-name>"

# 文件模式是默认值（可恢复；中断的 exec 流成本为一个数据库，
# 而不是整个运行）。PIPE_MODE=1 直接流式传输——仅适用于小实例。
DUMP_DIR="${DUMP_DIR:-./pg-migrate-dumps}"

SRC_POD=$(kubectl --context "$SRC_CTX" -n "$SRC_NS" get pod \
  -l spilo-role=master,cluster-name="$SRC_CLUSTER" -o jsonpath='{.items[0].metadata.name}') \
  && [ -n "$SRC_POD" ] || { echo "ERROR: 无法找到 $SRC_CLUSTER 的源主 pod" >&2; exit 1; }
TGT_POD=$(kubectl --context "$TGT_CTX" -n "$TGT_NS" get pod \
  -l spilo-role=master,cluster-name="$TGT_CLUSTER" -o jsonpath='{.items[0].metadata.name}') \
  && [ -n "$TGT_POD" ] || { echo "ERROR: 无法找到 $TGT_CLUSTER 的目标主 pod" >&2; exit 1; }

srcsql() { local db=$1; shift; kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }
tgtsql() { local db=$1; shift; kubectl --context "$TGT_CTX" -n "$TGT_NS" exec "$TGT_POD" -c postgres -- psql -U postgres -d "$db" -tA -v ON_ERROR_STOP=1 "$@"; }
tgtexec() { kubectl --context "$TGT_CTX" -n "$TGT_NS" exec "$TGT_POD" -c postgres -- "$@"; }

# 多小时的转储/恢复不得被实例或其角色上配置的超时杀死。
PGOPT='-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0'

# 客户端二进制文件与源服务器主版本匹配；镜像捆绑有限的主版本集
# 因此在启动之前验证，而不是在恢复中失败。
SRC_MAJOR=$(srcsql postgres -c "SHOW server_version;" | cut -d. -f1)
case "$SRC_MAJOR" in ''|*[!0-9]*) echo "ERROR: 无法确定源 PostgreSQL 主版本（通过 $SRC_POD 的 psql 失败）" >&2; exit 1 ;; esac
PG_BIN=/usr/lib/postgresql/$SRC_MAJOR/bin
tgtexec test -x "$PG_BIN/pg_restore" \
  || { echo "ERROR: 目标镜像中不存在 $PG_BIN/pg_restore" >&2; exit 1; }
echo "源 PostgreSQL 主版本：$SRC_MAJOR（客户端二进制文件：$PG_BIN）"

# 验证查询。显式 COLLATE "C" 固定排序顺序——两个
# 数据库可以合法地具有不同的排序规则，不同排序的文本比较
# 将报告错误的差异。对象普查排除扩展拥有的对象（扩展版本在不同的 PostgreSQL 主版本之间不同）并按类型计数所有其他对象。对 relkind 的 ::text 转换是必需的：relkind 是 "char" 类型，从 PostgreSQL 15 开始，"char" || <literal> 是模糊的（"operator is not unique"）——未转换时，普查会在每个现代目标上出错。
COUNT_QUERY="SELECT schemaname||'.'||relname, (xpath('/row/c/text()', query_to_xml(format(
  'SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint
  FROM pg_stat_user_tables
  WHERE schemaname NOT IN ('metric_helpers','user_management')
  ORDER BY (schemaname||'.'||relname) COLLATE \"C\";"
OBJ_QUERY="SELECT c.relkind::text||':'||count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast','metric_helpers','user_management')
    AND NOT EXISTS (SELECT 1 FROM pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e')
  GROUP BY c.relkind ORDER BY (c.relkind::text) COLLATE \"C\";"
SEQ_QUERY="SELECT schemaname||'.'||sequencename||'='||coalesce(last_value,0) FROM pg_sequences
  WHERE schemaname NOT IN ('metric_helpers','user_management')
  ORDER BY (schemaname||'.'||sequencename) COLLATE \"C\";"

FAILED=""; ATTEMPTED=0
while read -r DB OWNER; do
  [ -z "$DB" ] && continue
  # 如果有参数，仅迁移命名数据库（例如，重新处理一个 FAIL）。
  if [ "$#" -gt 0 ]; then
    case " $* " in *" $DB "*) ;; *) continue ;; esac
  fi
  ATTEMPTED=$((ATTEMPTED+1))
  echo "=== 正在迁移数据库：$DB（所有者：$OWNER） ==="

  # 目标数据库必须存在，且具有源的编码和区域设置——
  # 普通的 CREATE DATABASE 会继承目标模板的默认值，默默地
  # 更改排序顺序和 LIKE 行为（或在编码不匹配时直接失败恢复）。模板 template0 是覆盖它们所需的。
  read -r ENC COLL CTYPE < <(srcsql postgres -F' ' -c \
    "SELECT pg_encoding_to_char(encoding), datcollate, datctype FROM pg_database WHERE datname = '$DB';")
  CREATE_SQL="CREATE DATABASE \"$DB\" OWNER \"$OWNER\" TEMPLATE template0 ENCODING '$ENC' LC_COLLATE '$COLL' LC_CTYPE '$CTYPE';"
  TGT_LOC=$(tgtsql postgres -c "SELECT pg_encoding_to_char(encoding)||'/'||datcollate||'/'||datctype FROM pg_database WHERE datname = '$DB';")
  if [ -z "$TGT_LOC" ]; then
    echo "  在目标上创建数据库 $DB ($ENC/$COLL/$CTYPE)"
    tgtsql postgres -c "$CREATE_SQL" >/dev/null || { FAILED="$FAILED $DB(create)"; continue; }
  elif [ "$TGT_LOC" != "$ENC/$COLL/$CTYPE" ]; then
    if [ "$(tgtsql "$DB" -c "SELECT count(*) FROM pg_stat_user_tables WHERE schemaname NOT IN ('metric_helpers','user_management');")" = "0" ]; then
      echo "  使用源区域设置重新创建目标上的数据库 $DB ($ENC/$COLL/$CTYPE，之前是 $TGT_LOC)"
      tgtsql postgres -c "DROP DATABASE \"$DB\";" >/dev/null \
        && tgtsql postgres -c "$CREATE_SQL" >/dev/null \
        || { FAILED="$FAILED $DB(locale)"; continue; }
    else
      echo "  FAIL: 目标上的 $DB 存在不同的区域设置 ($TGT_LOC vs $ENC/$COLL/$CTYPE)，且不为空"
      FAILED="$FAILED $DB(locale)"; continue
    fi
  fi

  # 仅预先创建目标缺失的扩展（创建需要超级用户），保留源的模式位置和版本——
  # 迁移的扩展位置或版本漂移会在恢复时破坏依赖对象。
  while read -r EXT ESCH EVER; do
    [ -z "$EXT" ] && continue
    [ "$(tgtsql "$DB" -c "SELECT 1 FROM pg_extension WHERE extname = '$EXT';")" = "1" ] && continue
    tgtsql "$DB" -c "CREATE SCHEMA IF NOT EXISTS \"$ESCH\";" >/dev/null 2>&1
    tgtsql "$DB" -c "CREATE EXTENSION \"$EXT\" WITH SCHEMA \"$ESCH\" VERSION '$EVER';" >/dev/null 2>&1 \
      || tgtsql "$DB" -c "CREATE EXTENSION \"$EXT\" WITH SCHEMA \"$ESCH\";" >/dev/null 2>&1 \
      || echo "  WARNING: 无法在目标上创建扩展 $EXT（模式 $ESCH）— 恢复可能失败"
  done < <(srcsql "$DB" -F' ' -c \
    "SELECT e.extname, n.nspname, e.extversion FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql';")

  # 基线在源（确切计数、对象普查、序列位置）。
  # 每个捕获都有保护。必须永远不要将返回错误的验证查询误认为返回空的查询：
  # psql 退出非零，脚本继续（故意没有 `set -e`——一个坏数据库不得
  # 中止多小时的运行），并且两个失败的查询将比较相等
  # 并报告 PASS，而没有验证的数据库则是 FAILED 数据库。
  VERIFY_ERR=""
  SRC_COUNTS=$(srcsql "$DB" -c "$COUNT_QUERY") || VERIFY_ERR="源行计数"
  SRC_OBJS=$(srcsql "$DB" -c "$OBJ_QUERY")     || VERIFY_ERR="源对象普查"
  SRC_SEQS=$(srcsql "$DB" -c "$SEQ_QUERY")     || VERIFY_ERR="源序列位置"
  if [ -n "$VERIFY_ERR" ]; then
    echo "  FAIL: $DB（基线查询失败：$VERIFY_ERR — 不迁移无法验证的数据库）"
    FAILED="$FAILED $DB(verify)"; continue
  fi

  # 转移。恢复通过 pod 本地套接字以 postgres 身份连接，并
  # 使用 --role 切换到所有者：对象以所有者身份落地，没有密码处理，
  # 并且在 kubectl 参数列表中没有任何秘密。
  if [ "${PIPE_MODE:-0}" != "0" ]; then
    kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
        env PGOPTIONS="$PGOPT" \
        "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
        -N metric_helpers -N user_management "$DB" \
    | kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        env PGOPTIONS="$PGOPT" \
        "$PG_BIN/pg_restore" -U postgres --role="$OWNER" -d "$DB" --no-owner --no-tablespaces -x
    RC=$?
  else
    install -d -m 700 "$DUMP_DIR"
    DUMP_FILE="$DUMP_DIR/$DB.dump"
    if [ "${REUSE_DUMPS:-0}" != "0" ] && [ -s "$DUMP_FILE" ]; then
      echo "  重用现有转储 $DUMP_FILE"
    else
      kubectl --context "$SRC_CTX" -n "$SRC_NS" exec "$SRC_POD" -c postgres -- \
          env PGOPTIONS="$PGOPT" \
          "$PG_BIN/pg_dump" -U postgres -Fc --no-comments \
          -N metric_helpers -N user_management "$DB" > "$DUMP_FILE.partial" \
        && mv "$DUMP_FILE.partial" "$DUMP_FILE" \
        || { rm -f "$DUMP_FILE.partial"; FAILED="$FAILED $DB(dump)"; continue; }
    fi
    kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        env PGOPTIONS="$PGOPT" \
        "$PG_BIN/pg_restore" -U postgres --role="$OWNER" -d "$DB" --no-owner --no-tablespaces -x < "$DUMP_FILE"
    RC=$?
  fi

  # 携带数据库和角色级别的设置
  # （ALTER DATABASE ... SET / ALTER ROLE ... IN DATABASE ... SET）——pg_dump
  # 在不使用 --create 的情况下不会发出它们，因此它们会默默消失。
  srcsql postgres -c \
    "SELECT 'ALTER '||CASE WHEN s.setrole = 0 THEN 'DATABASE '||quote_ident(d.datname)
              ELSE 'ROLE '||quote_ident(r.rolname)||' IN DATABASE '||quote_ident(d.datname) END
            ||' SET '||quote_ident(split_part(cfg,'=',1))||' = '||quote_literal(substr(cfg, strpos(cfg,'=')+1))||';'
       FROM pg_db_role_setting s
       JOIN pg_database d ON d.oid = s.setdatabase
       LEFT JOIN pg_roles r ON r.oid = s.setrole
       CROSS JOIN LATERAL unnest(s.setconfig) cfg
      WHERE d.datname = '$DB';" \
    | kubectl --context "$TGT_CTX" -n "$TGT_NS" exec -i "$TGT_POD" -c postgres -- \
        psql -U postgres -v ON_ERROR_STOP=1 -f - >/dev/null \
    || echo "  WARNING: 无法携带 $DB 的 ALTER DATABASE/ROLE ... SET 设置"

  # 恢复不会发送规划器统计——没有 ANALYZE，生产流量的前几分钟
  # 在空统计上运行（到处都是顺序扫描）。
  # 这属于维护窗口内，而不是切换后。
  tgtexec env PGOPTIONS="$PGOPT" "$PG_BIN/vacuumdb" -U postgres --analyze-in-stages -d "$DB" >/dev/null 2>&1 \
    || echo "  WARNING: vacuumdb --analyze-in-stages 对 $DB 失败 — 在切换前手动运行 ANALYZE"

  # 验证：行、对象普查和序列位置必须匹配——并且在传输运行时源
  # 不能发生变化（未停止写入）。
  VERIFY_ERR=""
  TGT_COUNTS=$(tgtsql "$DB" -c "$COUNT_QUERY")  || VERIFY_ERR="目标行计数"
  TGT_OBJS=$(tgtsql "$DB" -c "$OBJ_QUERY")      || VERIFY_ERR="目标对象普查"
  TGT_SEQS=$(tgtsql "$DB" -c "$SEQ_QUERY")      || VERIFY_ERR="目标序列位置"
  SRC_RECHECK=$(srcsql "$DB" -c "$COUNT_QUERY") || VERIFY_ERR="源重新检查"
  if [ -n "$VERIFY_ERR" ]; then
    echo "  FAIL: $DB（验证查询失败：$VERIFY_ERR — 数据可能完好，但此运行未验证；不要根据此结果切换）"
    FAILED="$FAILED $DB(verify)"
  elif [ "$SRC_RECHECK" != "$SRC_COUNTS" ]; then
    echo "  FAIL: $DB（源在转储期间发生变化 — 根据步骤 2 强制停止写入，然后重新处理此数据库）"
    FAILED="$FAILED $DB"
  elif [ "$RC" -eq 0 ] && [ "$SRC_COUNTS" = "$TGT_COUNTS" ] && [ "$SRC_OBJS" = "$TGT_OBJS" ] && [ "$SRC_SEQS" = "$TGT_SEQS" ]; then
    echo "  PASS: $DB（行、对象和序列相同）"
  else
    echo "  FAIL: $DB（转移退出 $RC；行 $( [ "$SRC_COUNTS" = "$TGT_COUNTS" ] && echo match || echo DIFFER ); 对象 $( [ "$SRC_OBJS" = "$TGT_OBJS" ] && echo match || echo DIFFER ); 序列 $( [ "$SRC_SEQS" = "$TGT_SEQS" ] && echo match || echo DIFFER ))"
    FAILED="$FAILED $DB"
  fi
done < <(srcsql postgres -F' ' -c \
  "SELECT datname, pg_get_userbyid(datdba) FROM pg_database
   WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY (datname) COLLATE \"C\";")

echo
if [ "$ATTEMPTED" -eq 0 ]; then
  echo "ERROR: 没有数据库迁移 — 源枚举失败，或没有数据库与参数匹配" >&2
  exit 1
fi
if [ -n "$FAILED" ]; then echo "迁移不完整 — 失败:$FAILED"; exit 1; fi
echo "迁移完成 — $ATTEMPTED 个数据库已验证。"
```

如果数据库报告 `FAIL`，请参见 [故障排除](#troubleshooting)；在修复原因后，通过将其名称传递给脚本重新处理该数据库（在文件模式下，添加 `REUSE_DUMPS=1` 以跳过重新转储，如果写入保持停止）。

### 安全注意事项

- 此中继故意使管理员工作站成为两个其他隔离环境之间的数据路径——这正是隔离策略存在的控制对象。在迁移之前确认数据路径已获得您的安全/合规所有者的批准；“每个跳跃都是 TLS”是传输属性，而不是授权。
- 迁移脚本本身不处理任何数据库密码：转储和恢复以 `postgres` 身份通过 pod 本地套接字连接（恢复通过 `--role` 切换到所有者）。本指南中唯一带密码的命令是步骤 4 登录测试——请参阅其中的警告。
- 在文件模式下（默认），`$DUMP_DIR` 保存数据库的完整明文逻辑副本。脚本以模式 `700` 创建它；如果您将 `DUMP_DIR` 指向现有目录，请自行限制，按政策要求进行静态加密，并在迁移验证后删除转储。
- 数据通过两个受 TLS 保护的 `kubectl exec` 通道传输；除了两个 Kubernetes API 连接外，没有任何内容暴露在网络上。

## 步骤 4：验证应用访问

该脚本已经验证了每个表的行计数、对象普查和序列位置，并在每个数据库上运行了 `ANALYZE`。此外，确认每个应用用户实际上可以使用 **目标** 管理的凭证查询其数据（这立即捕获所有权问题），并重新检查任何步骤 2 校验和。如果您在步骤 1 中预先准备了凭证秘密，则此密码与源密码相同——应用保持其现有凭证，仅在切换时更改连接端点。请注意，秘密名称使用 RFC 1123 标准化的角色名称（`app_owner` → `app-owner`）：

```bash
TGT_POD=$(kubectl --context $TGT_CTX -n $TGT_NS get pod \
  -l spilo-role=master,cluster-name=$TGT_CLUSTER -o jsonpath='{.items[0].metadata.name}')

APP_PW=$(kubectl --context $TGT_CTX -n $TGT_NS get secret \
  <owner-sanitized>.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  -o jsonpath='{.data.password}' | base64 -d)

kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- \
  env PGPASSWORD="$APP_PW" psql -U <owner> -h localhost -d <database> -tA -c \
  "SELECT current_user, count(*) FROM <your-main-table>;"
```

**警告：** `kubectl exec` 将其命令——包括此 `PGPASSWORD` 值——放置在 API 请求 URI 中，Kubernetes 审计日志在 `Metadata` 级别及以上记录，并且在命令运行时也在本地 `ps` 输出中可见。这是一次性登录 *测试*；如果您的审计政策将记录的凭证视为暴露，请在切换后轮换此密码（或从应用 pod 验证）。

恢复跳过 ACL 语句（`pg_restore -x`），因为它们引用由源 operator 管理的角色。`GRANT` 本身仍然在 **转储文件** 内——如果其他（非所有者）用户需要对迁移数据的权限，则在现在手动重新授权，或者列出转储的 ACL 条目（`"$PG_BIN/pg_restore" -l <db>.dump | grep ' ACL '`）并在目标上创建角色后使用 `pg_restore -L` 仅重放这些。

## 步骤 5：切换和清理

- 将目标扩展回去（`numberOfInstances: 2` 或您的 HA 基线），并等待副本赶上。
- 将应用指向目标实例的服务并重新启用写入。
- 分阶段退役源，而不是立即删除——它是您发现切换后数据问题的唯一回滚。首先保持只读并缩放到零，观察一段时间：

```bash
# 冻结源但保留其数据（回滚保险）
kubectl --context $SRC_CTX -n $SRC_NS patch postgresql $SRC_CLUSTER \
  --type merge -p '{"spec":{"numberOfInstances":0}}'
```

- 在观察期（天数，按您的政策）后删除它。没有复制配置需要拆除。如果您的 operator 配置了删除保护注释（`delete_annotation_date_key`/`delete_annotation_name_key`），请先在 CR 上设置这些注释，否则 operator 会忽略删除：

```bash
kubectl --context $SRC_CTX -n $SRC_NS delete postgresql $SRC_CLUSTER
# PVC 保留取决于 operator 配置——删除剩余部分：
kubectl --context $SRC_CTX -n $SRC_NS delete pvc -l cluster-name=$SRC_CLUSTER --ignore-not-found
```

## 故障排除

### 应用用户在成功恢复后收到 `permission denied for table ...`

恢复在未切换到应用用户的情况下运行，因此所有对象都由 `postgres` 拥有（脚本以 `postgres` 身份连接，但使用 `--role=<owner>` 切换；这通常来自省略 `--role` 的手动恢复）。要么重新处理数据库——删除并重新创建它，然后使用数据库名称重新运行脚本——要么在原地转移所有权：

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO app_owner', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO app_owner', r.sequencename);
  END LOOP;
END $$;
```

此块仅涵盖 `public` 模式中的表和序列。视图、函数、类型和其他模式中的对象需要类似的 `ALTER ... OWNER TO` 语句（通过 `pg_views`、`pg_proc`、`pg_type` 或 `\dn`/`\df` 在 psql 中枚举它们）。

相关范围说明：迁移的 `--no-owner` 模型假定 operator 的标准布局——一个数据库完全由一个 CR 定义的用户拥有。如果一个数据库有多个拥有角色、`SECURITY DEFINER` 函数，或者在具有不同所有者的非 `public` 模式中有对象，则所有权会归结为恢复用户；计划对这些对象进行明确的恢复后所有权和授权传递。

### 恢复报告 `permission denied to create extension ...`

源数据库使用目标上未预安装的扩展，而应用用户无法创建它。脚本对此发出警告（`WARNING: 无法创建扩展`）。以 `postgres` 身份在目标数据库上创建扩展，然后重新运行恢复。如果 `CREATE EXTENSION` 本身因缺少文件错误而失败，则扩展的包根本不在目标镜像中——必须在此迁移之前将其添加到镜像/实例中。

### 恢复报告 `must be owner of extension pg_stat_statements`（以及类似情况）

`--no-comments` 被省略；扩展注释需要超级用户。数据恢复良好——错误仅打破干净的退出代码。使用 `--no-comments` 重新运行以获得可验证的结果。

### 恢复报告 `unrecognized configuration parameter "transaction_timeout"`

转储是使用比目标服务器更新的 `pg_dump` 进行的（通常是镜像的默认二进制文件——没有显式的 `PG_BIN` 路径的手动转储；脚本将 `$PG_BIN` 固定为源主版本，并在开始之前验证两侧都存在）。使用版本匹配的二进制路径重新运行。如果脚本自己的预检查失败（`pg_restore not present in the target image`——非常旧或自定义的镜像捆绑较少的主版本），请使用匹配主版本的工作站侧 PostgreSQL 客户端运行转储和恢复，而不是 pod 内的二进制文件。

### 数据库报告 `FAIL ... SOURCE CHANGED DURING DUMP`

源写入未完全停止：脚本在每次传输后重新读取源行计数，并拒绝通过 `SOURCE CHANGED DURING DUMP` 使数据库通过。根据步骤 2 强制停止写入（`CONNECTION LIMIT 0` 加上 `pg_terminate_backend`），然后重新处理该数据库（`bash migrate.sh <database>` 在目标上删除后）。

### 恢复报告 `schema "metric_helpers" already exists`（以及类似情况）

省略了 `-N metric_helpers -N user_management` 排除。这些错误对于被排除模式的对象是无害的，但请重新运行以获得干净、可验证的退出代码。

### 在失败恢复后重新运行

首先删除目标数据库——部分恢复留下了冲突的对象（`relation already exists`、重复键 COPY 失败）。请注意，`DROP DATABASE` 必须作为单个语句执行：

```bash
kubectl --context $TGT_CTX -n $TGT_NS exec $TGT_POD -c postgres -- psql -U postgres -c "DROP DATABASE appdb"
```

然后仅使用 **失败的数据库** 作为参数重新运行脚本（`bash migrate.sh <database>`）——它会使用正确的所有者和区域设置重新创建数据库；添加 `REUSE_DUMPS=1` 以从已完成的转储恢复，而不是重新转储（仅在源写入保持停止的情况下）。在部分成功后不要没有参数地重新运行它：恢复到已经转移的数据库会产生 `already exists` 冲突，使其标记为失败。

### 应用密码在迁移后更改

目标 CR 在凭证秘密预先准备（步骤 1）**之前** 创建，因此 operator 生成了新密码。要在事后恢复源凭证，请同时更新秘密和角色——仅凭秘密是不够的，单独的 `ALTER ROLE` 会被 operator 从秘密的下一个同步中还原。以下命令对包含引号、反斜杠或 JSON 元字符的密码保持安全：秘密使用 base64 值进行修补（按构造 JSON 安全），SQL 使用 psql 的 `:'pw'` 字面量引用，而不是字符串插值：

```bash
PW_B64=$(kubectl --context $SRC_CTX -n $SRC_NS get secret \
  app-owner.$SRC_CLUSTER.credentials.postgresql.acid.zalan.do -o jsonpath='{.data.password}')

kubectl --context $TGT_CTX -n $TGT_NS patch secret \
  app-owner.$TGT_CLUSTER.credentials.postgresql.acid.zalan.do \
  --type merge -p "{\"data\":{\"password\":\"$PW_B64\"}}"

kubectl --context $TGT_CTX -n $TGT_NS exec -i $TGT_POD -c postgres -- \
  psql -U postgres -v pw="$(printf %s "$PW_B64" | base64 -d)" <<'SQL'
ALTER ROLE app_owner PASSWORD :'pw';
SQL
```

通过步骤 4 中的登录测试进行验证。

### 传输速度慢

吞吐量受限于工作站与两个 API 服务器之间的连接（每个字节都通过它两次传输：exec 流入，exec 流出）。从与两个平台良好连接的机器（例如跳跃主机）运行迁移，并保持默认文件模式，以便按数据库可恢复。如果需要并行处理非常大的恢复，请注意 `pg_restore -j N` 不能从 stdin 读取——将转储文件复制到目标 pod（`kubectl cp`），并从那里恢复本地路径。如果测量的排练持续时间不适合任何可接受的窗口，则此中继是该实例的错误工具——计划一个网络连接的迁移路径。
