---
tags: [incident]
date: 2026-04-16
component: "监控系统"
fault_type: "监控系统/主备同步/实例定时重建"
symptom: "prometheus-1/prometheus-2 �?12 小时左右被定时重�?
root_cause: "�?global 集群 HA Prometheus �?prometheus-1/-2 未加入同步忽略列表，被主集群定时同步后触发重�?
runbook: ""
branch: ""
source_path: "/Users/slp/Downloads/_ 备global集群中prometheus pod重建_.docx"
affected_versions: [v3.12, v3.14, v3.16, v3.18]
---
# �?global 集群 Prometheus 实例定时重建

## 现象
- �?global 集群中的 Prometheus Pod 周期性重建，并触发相关告警�?
- 受影响实例集中在 `prometheus-1` �?`prometheus-2`，约�?12 小时出现一次；`prometheus-0` 未出现同类现象�?

## 排查过程与命�?
- 先对重建范围做对比，发现问题只出现在高可�?Prometheus 的部分副本，�?`prometheus-0` 始终稳定。这说明问题并非整个 Prometheus 服务普遍异常，而更可能与主备同步或特定实例配置差异有关�?
- 继续查看系统审计记录，发现存�?`prome-operator` 更新 `prome-1`、`prome-2` 的操作。该现象表明，实例重建并�?Pod 自发异常退出，而是被外部控制面周期性改写后触发重建�?
- 为确认是否存在主备同步忽略配置缺失，执行以下命令检�?`etcd-sync-ignore-text` 配置�?
```bash
kubectl get cm -n kube-system etcd-sync-ignore-text -oyaml | grep prome
```
- 检查结果显示，主备环境高可�?Prometheus �?`prometheus-1` �?`prometheus-2` 实例未被加入忽略同步列表，�?`prometheus-0` 已有对应忽略配置。由此可以确认，异常实例与忽略同步配置缺失直接相关�?

## 根因与修复方�?
- **根因**�?
  1. �?global 集群中高可用 Prometheus �?`prometheus-1` �?`prometheus-2` 未配置为忽略同步对象�?
  2. �?global 集群会向�?global 集群执行同步�?
  3. 当同步覆盖到上述两个实例的相关配置时，会触发 `prome-operator` 对实例执行更新�?
  4. 实例被更新后，`prometheus-1` �?`prometheus-2` 周期性发生重建，并进一步触发告警�?
- **临时缓解方案**�?
  - 修正 `etcd-sync-ignore-text` �?`data.ignore-equal.txt` 的配置或其生成维护逻辑，将 `prometheus-1` �?`prometheus-2` 按照 `prometheus-0` 的方式加入忽略同步列表，避免主集群定时同步触发备集群实例重建，并重启etcd-mirror的pod，但需额外评估其对升级流程的影响，避免引入 `rpch` 并阻塞升级�?
- **根本解决方案**�?
  - 后续产品将不再支持prometheus高可用，建议改为单点的prometheus或者使用victormetrics�?

