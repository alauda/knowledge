---
kind:
  - KnownIssue
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500867
sourceSHA: e9bc24d02b267a9cc53e98a0b2a7c86ca67e4d6a5003837d2005151dbb41c5ab
---

# 带有空格的自定义匹配器触发 Alertmanager UTF-8 解析器回退警告

## 问题

在 Alauda 容器平台上，Prometheus 监控栈提供了一个从上游 `v0.32.1` 构建的 Alertmanager 二进制文件，打包为 `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`，并由 `cpaas-system/kube-prometheus` Alertmanager CR 运行。由于此版本远高于 `0.27`，该二进制文件使用了在 `0.27` 中引入的新 UTF-8 兼容匹配器解析器，该解析器对匹配器值的引号使用有严格要求。

当配置的路由树包含一个 `matchers:` 列表条目，其值带有空格（或其他特殊字符）但未用双引号括起来时——例如 `region=production EU`——解析器无法将该值作为单个令牌进行处理，回退到经典匹配器解析器，并发出一条 `parse.go:176` 警告行，标识出有问题的输入。在 `v0.32.1` 构建中，该行由 alertmanager 容器以其标准 `slog` 格式发出，并带有 `source=parse.go:176` 字段：

```text
time=2026-05-29T14:56:00.665Z level=WARN source=parse.go:176 msg="Alertmanager is moving to a new parser for labels and matchers, and this input is incompatible. Alertmanager has instead parsed the input using the classic matchers parser as a fallback. To make this input compatible with the UTF-8 matchers parser please make sure all regular expressions and values are double-quoted and backslashes are escaped. If you are still seeing this message please open an issue." input="region=production EU" origin=config err="18:20: unexpected EU: expected a comma or close brace" suggestion="region=\"production EU\""
```

每条警告行包含四个标识字段：`input=`（确切的有问题的匹配器字符串）、`origin=config`、`err=`（列位置和简短原因，如 `unexpected EU: expected a comma or close brace`），以及 `suggestion=`（已用双引号括起来的修正匹配器）。

`parse.go:176` 行是 WARN，而不是致命错误：Alertmanager 在有问题的配置上继续运行，因为解析器回退到经典匹配器解析器，而不是拒绝加载。在实验室重现中，带有上述匹配器的探针 Pod 加载了配置并达到了 `Phase=Running`，`restartCount=0`，调度程序和 gossip 集群正常启动——对于这一类输入，`v0.27`-`v0.32+` 的上游信号是解析器警告加经典解析器回退，而不是进程崩溃。

## 根本原因

当 UTF-8 匹配器解析器接收到无法解析的匹配器字符串时，它不会使配置失败。相反，它使用经典匹配器解析器重新解析该字符串并接受结果，然后记录 `parse.go:176` 警告，以便操作员可以在下次行为变化之前修复输入。回退路径通过同一加载的相邻 DEBUG 行进行公告——`source=parse.go:154 msg="Parsing with UTF-8 matchers parser, with fallback to classic matchers parser" input=... origin=config`（在 `--log.level=debug` 下可见）——而 `parse.go:176` 的 WARN 是操作员可见的信号，表明回退实际上已运行。

该警告与 alertmanager 二进制版本相关，而不是与任何配置编辑相关：`v0.32.1` 二进制文件在每次配置加载时检查每个匹配器字符串是否符合 UTF-8 解析器，因此一个形状不正确的 `matchers:` 条目在第一次加载时发出警告，并在每次重新加载时发出，直到该值被重写。

对于文章中的字面输入 `region=production EU`，解析器在第 20 列停止，因为空格后的单词 `EU` 不能是值或以逗号分隔的延续；`err=` 字段报告 `18:20: unexpected EU: expected a comma or close brace`，而 `suggestion=` 字段显示语法正确的形式 `region="production EU"`。

## 解决方案

对于每个不合规的 `matchers:` 列表条目，将值用双引号括起来（并转义任何嵌入的反斜杠）。使用警告文本中的示例，原始条目：

```yaml
route:
  routes:
  - matchers:
    - region=production EU
    receiver: default
```

被重写为符合解析器要求的形式：

```yaml
route:
  routes:
  - matchers:
    - region="production EU"
    receiver: default
```

在此更改后，相同的 `v0.32.1` Alertmanager 加载配置时没有 `parse.go:176` WARN 行，并且根本没有调用经典解析器回退——`parse.go:154` DEBUG 行仍然宣布两个通道解析器已启动，但该值现在在通过 UTF-8 解析器的第一次通道中干净解析，没有回退运行。

应用双引号修复对已经合规的输入没有行为变化，并清除了不合规输入的警告；相同的 `v0.32.1` 二进制文件随后干净地加载路由树。

## 诊断步骤

读取实时 alertmanager 容器日志，并过滤 `parse.go:176` 警告以列举哪些匹配器触发了回退：

```bash
kubectl -n cpaas-system logs alertmanager-kube-prometheus-0 -c alertmanager --tail=2000 \
  | grep 'source=parse.go:176'
```

如果 grep 返回没有行，则当前 Alertmanager 加载的每个匹配器都是 UTF-8 解析器合规的，无需采取任何行动。如果返回了行，则每行的 `input=` 字段标识确切的有问题的匹配器，而 `suggestion=` 字段提供了修正的双引号形式以复制回配置中。

要在推出之前验证计划的配置，请在 Alertmanager 容器内运行 `amtool`——它与相同版本的相同镜像一起提供（`amtool, version 0.32.1`），并在 `check-config` 期间重现解析器警告，因此可以在不旋转 Pod 的情况下捕获形状不正确的匹配器：

```bash
kubectl -n cpaas-system exec alertmanager-kube-prometheus-0 -c alertmanager -- \
  /bin/amtool check-config /etc/alertmanager/config_out/alertmanager.env.yaml
```

一条没有前导 `parse.go:176 WARN` 的 `SUCCESS` 行表示配置完全符合 UTF-8 匹配器解析器；一条前面有一个或多个 `parse.go:176 WARN` 的 `SUCCESS` 行表示该配置当前仅因经典解析器回退而被接受，必须在下次 Alertmanager 升级之前进行更新。
