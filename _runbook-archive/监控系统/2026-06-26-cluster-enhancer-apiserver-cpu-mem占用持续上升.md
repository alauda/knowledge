---
tags: [incident]
date: 2026-06-26
component: "监控系统"
fault_type: "监控系统/metrics采集/历史数据累积导致资源上涨"
symptom: "cluster-enhancer-apiserver 的 cpu/mem 占用持续上升"
root_cause: "enhancer 相关逻辑缺陷导致 metrics 历史数据持续累积，返回内容随时间增长，最终引发请求压力上升并推高 cpu/mem 占用"
runbook: "[[监控系统-cluster-enhancer-apiserver资源持续上升-排查手册]]"
branch: ""
source_path: ""
affected_versions: [v4.2]
---
# cluster-enhancer-apiserver 的 cpu/mem 占用持续上升

## 现象
- `cluster-enhancer-apiserver` 的 `cpu/mem` 占用持续上升。
- 现场排查表明，该问题与 `vmagent` 对 enhancer 指标的采集链路相关，而不是单纯的 Pod 资源配置不足。
- 对比本地 `4.2.1` 环境后发现，异常环境中的指标返回内容明显更大，表现出历史数据持续累积的特征。

## 排查过程与命令
- 首先检查 `ServiceMonitor`，确认 `vmagent` 拉取 enhancer 指标所使用的 token 与采集配置：
  ```bash
  kubectl get servicemonitor -n cpaas-system cluster-enhancer-apiserver -oyaml
  ```
- 随后在 `vmagent` 所在节点上，依次通过以下命令定位对应容器与 token 文件目录：
  ```bash
  kubectl get po -A -owide | grep vmagent
  crictl ps | grep vmagent
  crictl inspect 91ec4b523f85e | grep -C 10 serviceaccount
  ```
- 获取 token 后，继续使用该 token 请求 enhancer 的 `metrics` 接口，发现返回内容中包含大量历史写入数据。这个现象说明问题并不只是采集侧超时，而是被采集端本身返回了持续膨胀的数据集合。
- 将异常环境与本地 `4.2.1` 环境进行对比后，进一步怀疑 enhancer 未正确清理历史数据，导致返回内容随日期不断增长。
- 随着返回数据量不断变大，单次 metrics 请求的处理成本持续上升，最终表现为 `cluster-enhancer-apiserver` 的 `cpu/mem` 占用持续抬高，并可能进一步引发请求超时。
- 综合以上现象可以确认，问题核心不在 `vmagent` token 本身或抓取配置错误，而在 enhancer 指标数据累积逻辑存在缺陷。

## 根因与修复方案
- **根因**
  - enhancer 相关逻辑存在缺陷，导致 metrics 历史数据不断累积。
  - 返回数据量随时间持续增长，最终推高请求处理开销，表现为 `cluster-enhancer-apiserver` 的 `cpu/mem` 占用持续上升。
- **临时缓解方案**
  - 定期重建 `cluster-enhancer-apiserver` Pod，缓解历史数据累积带来的资源上涨问题。
- **根本解决方案**
  - 升级到已修复该问题的 `v4.2.5` 版本。
  - 从实现层修复 enhancer 的历史 metrics 数据清理逻辑，避免数据持续累积导致资源和请求压力线性增长。
