---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500019
sourceSHA: 57643b3eb01153e06f3f59961a1515e7d1c3619d69dc6907b60dbfc35289d628
---

# Velero includedNamespaces 不支持通配符或正则表达式

## 问题

在 ACP 备份表面（`configure/backup`，它打包了上游的 Velero 项目）上进行备份或恢复时，在 `spec.includedNamespaces` 中声明了一个通配符模式：

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: backup-test
  namespace: cluster-backup
spec:
  includedNamespaces:
    - "*test"
```

期望 Velero 会将该模式扩展为所有名称以 `test` 结尾的命名空间，并备份它们。然而，实际上 Velero 将字符串 `*test` 视为一个字面命名空间名称。由于没有命名空间的名称确实是 `*test`，备份记录在其元数据中按原样记录命名空间选择器，但从未找到任何工作负载对象进行捕获。备份文件的内容几乎为空——任何意外匹配的命名空间的命名空间定义可能会被写入，但内部的资源则没有。

此情况下 Velero 的日志显示模式被逐字存储，随后针对该不可能的名称进行逐资源枚举：

```text
level=info msg="Including namespaces: *test"
level=info msg="Excluding namespaces: "
level=info msg="Including resources: *"
level=info msg="Listing items" backup=cluster-backup/backup-test \
    namespace="*test" resource=persistentvolumeclaims
```

结果：“`Including namespaces: *test`”被字面存储，资源枚举请求 API 获取命名空间 `*test` 中的项目，而 API 返回为空。

## 根本原因

Velero 的 `includedNamespaces` 字段（以及对称的 `excludedNamespaces` 字段及其 `Restore` 对应项）期望一个 **确切的命名空间名称列表**。Velero 唯一识别的通配符是单个字符 `*`，表示“每个命名空间”，并且仅在列表中的唯一条目时有效。任何其他字符串——`*test`、`test-*`、`/test-.*/`——都与每个命名空间名称进行字符串相等比较，并且不会匹配。

这是 Velero 的一个长期设计选择，而不是 ACP 打包中的缺陷。上游文档直接指出：“*”包含/排除的命名空间必须单独列出；不支持通配符和正则表达式。”

输出字段 `spec.resources`（要包含的对象类型）以相同的方式支持单个 `*`，但否则需要显式的 GVK 列表。同样适用“无正则表达式”规则。

## 解决方案

显式列出目标命名空间，或者通过在创建时从标签选择器生成列表。

### 选项 A — 显式列出命名空间

用实际名称替换通配符：

```yaml
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: backup-test
  namespace: cluster-backup
spec:
  includedNamespaces:
    - app-test
    - billing-test
    - frontend-test
  ttl: 720h
  storageLocation: default
```

这是最简单的修复，也是唯一一个在上游不需要任何 Velero 侧更改的解决方案。

### 选项 B — 在命名空间上使用标签选择器

Velero 在 Backup CR 上尊重 `labelSelector`，并将其应用于 **所有对象** 在包含的命名空间中，这几乎总是与预期不符（它还会过滤掉未标记的 ConfigMaps 和 Deployments）。对于命名空间级过滤，建议对命名空间进行标记，并在驱动程序中生成列表：

```bash
NAMESPACES=$(kubectl get ns -l backup-set=nightly \
             -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
             | paste -sd, -)

cat <<EOF | kubectl -n cluster-backup apply -f -
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: backup-$(date -u +%Y%m%d%H%M)
  namespace: cluster-backup
spec:
  includedNamespaces:
$(for n in $(kubectl get ns -l backup-set=nightly -o jsonpath='{.items[*].metadata.name}'); do
    echo "    - $n"
  done)
  ttl: 720h
  storageLocation: default
EOF
```

备份在创建 CR 时对命名空间标签成员资格是声明性的。将新命名空间添加到未来备份集是一个标记操作；无需代码更改或 CR 编辑。

### 选项 C — 字面量 `*` 表示“所有”

当意图确实是“备份集群中的每个命名空间”时，使用单条目形式：

```yaml
spec:
  includedNamespaces:
    - "*"
```

与 `excludedNamespaces` 配对，以排除 kube-system 级命名空间，这些命名空间在恢复过程中不会进行回环：

```yaml
spec:
  includedNamespaces:
    - "*"
  excludedNamespaces:
    - kube-system
    - kube-public
    - kube-node-lease
    - cluster-backup
```

### 选项 D — 调度级命名空间模板

`Schedule` CR 根据计划生成备份，模板可以通过控制器或小型 CronJob 定期重新生成，该作业重新读取命名空间标签选择器并重写 Schedule 的模板。这使得扩展的命名空间列表保持最新，而无需在每次备份时预先计算。

## 诊断步骤

确认 Velero 实际记录的失败备份中的命名空间选择器：

```bash
kubectl -n cluster-backup get backup backup-test \
  -o jsonpath='{.spec.includedNamespaces}{"\n"}'
```

任何除了唯一条目 `*` 形式以外的包含 `*` 的字面字符串都是明显的证据。

检查备份自身的日志以查看它枚举了什么。Velero 在对象存储中与备份元数据一起写入日志文件；获取它并 grep 命名空间行：

```bash
kubectl -n cluster-backup logs deploy/velero | \
  grep 'Including namespaces' | tail -10
```

每一行应为真实命名空间名称的逗号分隔列表——绝不应有以 `*suffix` 或 `prefix*` 结尾的行。

验证完成备份的资源计数：

```bash
kubectl -n cluster-backup get backup backup-test -o jsonpath='{.status}{"\n"}' | jq
```

`progress` 块列出了 `totalItems` 和 `itemsBackedUp`。声明了三个通配符选择的命名空间并报告 `itemsBackedUp: 0` 的备份（除了 `namespaces` 本身）正好遇到了这个问题，需要用显式名称形式重新运行。

在重写使用通配符的现有 `Schedule` 时，也要重新检查可能已针对相同通配符预先编写的任何 `Restore` CR——恢复端同样是字面意义的，将找不到任何内容进行恢复：

```bash
kubectl -n cluster-backup get restore -o yaml \
  | grep -A1 includedNamespaces
```

用备份应覆盖的显式列表替换每个 `"*<something>"` 或 `"<something>*"` 模式。
