---
kind:
  - KnownIssue
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500689
sourceSHA: 378118b00fe4e18f939941acbc44d72c3e2563cb197802281019e59fc3fd4071
---

# Alertmanager 0.27+ UTF-8 匹配器解析器警告自定义路由规则

## 问题

在 Alauda 容器平台上，Prometheus 监控栈提供了一个从上游 `v0.32.1` 构建的 Alertmanager 二进制文件，打包为 `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`，并由 `cpaas-system/kube-prometheus` Alertmanager CR 运行。由于此版本远高于 `0.27`，该二进制文件使用了在 `0.27` 中引入的新 UTF-8 兼容匹配器解析器，该解析器相对于早期版本使用的经典匹配器解析器有许多向后不兼容的更改。

可见的症状是在 Alertmanager 配置加载时发出警告，即使集群上没有进行任何配置更改——该行为与解析器版本相关，而不是与配置编辑相关。在 `v0.32.1` 构建中，该行由 alertmanager 容器以其标准 `slog` 格式发出，带有 `source=parse.go:176` 字段：

```text
time=2026-05-29T12:59:11.225Z level=WARN source=parse.go:176 msg="Alertmanager is moving to a new parser for labels and matchers, and this input is incompatible. Alertmanager has instead parsed the input using the classic matchers parser as a fallback. To make this input compatible with the UTF-8 matchers parser please make sure all regular expressions and values are double-quoted and backslashes are escaped. If you are still seeing this message please open an issue." input="alertname = Optimize- Route existiert nicht" origin=config err="22:27: unexpected Route: expected a comma or close brace" suggestion="alertname=\"Optimize- Route existiert nicht\""
```

每个警告行都在 `input=` 字段中携带有问题的匹配器，在 `err=` 字段中携带解析错误位置（列和简短原因，如 `unexpected Route: expected a comma or close brace`），并在 `suggestion=` 字段中提供了已双引号的修正匹配器。

## 根本原因

当 UTF-8 匹配器解析器接收到无法解析的匹配器字符串时，它不会使配置失败。相反，它使用经典匹配器解析器重新解析该字符串并接受结果，然后记录 `parse.go:176` 警告，以便操作员可以在下次行为更改之前修复输入。回退路径在同一加载的相邻调试行中宣布：`source=parse.go:154 msg="Parsing with UTF-8 matchers parser, with fallback to classic matchers parser" input=... origin=config`。警告本身是操作员可见的信号，表明回退已运行。

该警告的范围限于通过 alertmanager 匹配器语法解析器的匹配器字符串。具体而言，这是路由或抑制规则下的 `matchers:` 列表中的每个条目，以及传递给 `amtool` 的匹配器。已弃用的 `match:` 键/值映射形式通过 YAML 处理，永远不会到达匹配器解析器，因此映射形式的匹配器无论值内容如何都不会触发警告。

在 `Secret cpaas-system/alertmanager-kube-prometheus` 中提供的 ACP 路由树完全是 `match:` 映射形式（例如 `match: {severity: Critical}` 和 `match: {alert_repeat_interval: 5m}`），并且每个值都是一个单一的字母数字令牌，没有空格或特殊字符。因此，在平台集群上，实时 alertmanager 容器日志中包含零个 `parse.go` 警告，即使该二进制文件包含严格的 UTF-8 解析器。只有当操作员（或集成控制器）在 `matchers:` 列表形式中添加包含空格、解析器会将其解释为令牌边界的连字符或非 ASCII 字符的自定义匹配器时——例如 `alertname = Optimize- Route existiert nicht`——警告才会出现。

## 解决方案

在现有配置基础上添加的自定义路由规则必须手动更新，以使用双引号形式表示任何非平凡值。已提供的 ACP 规则已经符合要求，无需更改。

对于每个不合规的 `matchers:` 列表条目，将值用双引号括起来（并转义任何嵌入的反斜杠）。使用警告文本中的示例，原始条目：

```yaml
route:
  routes:
  - matchers:
    - alertname = Optimize- Route existiert nicht
    receiver: default
```

被重写为符合解析器要求的形式：

```yaml
route:
  routes:
  - matchers:
    - alertname="Optimize- Route existiert nicht"
    receiver: default
```

在此更改后，相同的 `v0.32.1` Alertmanager 加载配置时没有 `parse.go` 警告，也没有回退——配置在第一次通过 UTF-8 解析器时干净地解析。

关于范围的两个额外说明：

- 值为单一字母数字令牌的匹配器（例如 `severity=Critical` 或 `alert_repeat_interval=5m`）在 UTF-8 解析器下无需引号即可干净解析；仅当值包含空格、特殊字符或非 ASCII 文本时，才需要引号。
- 以已弃用的 `match:` 映射形式编写的匹配器不会触发警告，因为 YAML 已经将值作为字符串携带。现有的映射形式条目继续按原样工作，无需迁移以消除警告。

现在应用双引号修复不会对合规输入产生任何行为变化，并清除了不合规输入的警告；相同的 `v0.32.1` 二进制文件随后加载路由树时完全没有 `parse.go` 行或警告。

## 诊断步骤

读取实时 alertmanager 容器日志并过滤 `parse.go` 警告，以列举哪些匹配器触发了回退：

```bash
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0 -c alertmanager --tail=2000 \
  | grep 'source=parse.go'
```

如果 grep 返回没有行，则当前 Alertmanager 加载的每个匹配器都是 UTF-8 解析器兼容的，无需采取任何行动。如果返回了行，则每行的 `input=` 字段标识确切的有问题匹配器，而 `suggestion=` 字段提供了修正的双引号形式以复制回配置中。

要在推出之前验证计划的配置，请在 Alertmanager 容器内运行 `amtool`——它与相同版本的相同映像一起提供（`amtool, version 0.32.1`），并在 `check-config` 期间重现解析器警告，因此可以在不轮换 pod 的情况下捕获形状不正确的匹配器：

```bash
kubectl -n cpaas-system exec alertmanager-kube-prometheus-0 -c alertmanager -- \
  /bin/amtool check-config /etc/alertmanager/config_out/alertmanager.env.yaml
```

没有前导 `parse.go:176 WARN` 的 `SUCCESS` 行表示配置完全符合 UTF-8 匹配器解析器；前面有一个或多个 `parse.go:176 WARN` 行的 `SUCCESS` 行表示该配置当前仅因经典解析器回退而被接受，必须在下次 Alertmanager 升级之前进行更新。

## 另请参阅

- `带有空格的自定义匹配器触发 Alertmanager UTF-8 解析器回退警告`——相同的根本原因，明确讲解了未加引号的空格示例。
