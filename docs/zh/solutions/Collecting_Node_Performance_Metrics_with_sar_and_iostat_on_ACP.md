---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500236
sourceSHA: 88452c3308d508e113d02bdcdc5870eabe9472065414f986dc861fe1a3ebe874
---

# 使用 sar 和 iostat 收集 ACP 上的节点性能指标

## 问题

低级节点性能数据——运行队列长度、内存压力、每设备磁盘 I/O、CPU 利用率和上下文切换率——通过 `sar` 系统活动报告工具在 Linux 主机上暴露，该工具由 `sysstat` 包提供；缺少该包的主机在调用 `sar` 时会返回 `command not found`。在 Alauda Container Platform 节点主机上，该包可能不在默认用户路径中，因此收集这些指标需要从已经携带 `sysstat` 的特权调试上下文访问主机，而不是依赖于二进制文件在节点本身上安装。

## 解决方案

从捆绑了 `sysstat` 包的特权节点调试 pod 上运行 `sar` 和 `iostat`，然后将输出重定向到本地文件以供后续分析。与 ACP 一起提供的容器调试镜像携带 `sysstat` 版本 12.7.8，暴露了下面描述的相同 `sar`/`iostat` 标志集。启动针对目标节点的调试 pod，并固定容器调试镜像，以确保工具可用：

```bash
kubectl debug node/<NODE> -it --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2
```

读取主机级性能数据需要以 root 身份运行收集命令；特权节点调试容器以 root 身份运行，满足该要求。调试节点命令的标准输出可以使用 `>` 重定向到操作员工作站上的文件中，从而保存报告以供后续查看：

```bash
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- sar -q 1 100 > load_report.txt
```

在 `<flag> <interval> <count>` 调用格式中，两个尾随整数表示每 `<interval>` 秒采样一次，并重复 `<count>` 次——因此 `1 100` 表示每秒采样一次，共采样一百次。`iostat` 接受与 `sar` 相同的 `interval count` 节奏。

## 诊断步骤

每个 `sar` 标志针对不同的子系统；该标志集存在于容器调试镜像携带的 `sysstat` 12.7.8 版本中。使用 `sar -q` 报告系统负载平均值和运行队列长度。使用 `sar -r` 报告内存利用率统计。使用 `sar -d` 报告每设备的块 I/O 活动。

对于处理器活动，`sar -u` 报告所有核心的总 CPU 利用率，而 `sar -P ALL` 报告每个核心的利用率，每个 CPU 一行。使用 `sar -w` 报告上下文切换活动，包括进程创建和上下文切换率。以下调用遵循相同的 `interval count` 节奏：

```bash
# 内存，每秒采样一次，100 次采样
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- sar -r 1 100 > mem_report.txt

# 每核心 CPU
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- sar -P ALL 1 100 > cpu_report.txt
```

对于在单个报告中结合 CPU 和每设备磁盘 I/O，`iostat` 在与 `sar` 相同的 `interval count` 节奏中报告两者：

```bash
kubectl debug node/<NODE> --image=registry.alauda.cn:60070/acp/container-debug:v4.3.2 \
  -- iostat 1 100 > io_report.txt
```
