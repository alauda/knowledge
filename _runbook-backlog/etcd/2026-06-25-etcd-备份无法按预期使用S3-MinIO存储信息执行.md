---
tags: [incident]
date: 2026-06-25
component: "etcd"
fault_type: "etcd/备份/S3-MinIO配置失效"
symptom: "etcd 备份配置为 s3 存储后，备份无法按预期使用 MinIO 存储信息执行"
root_cause: "ebc 的 s3 存储引用未正确指向 MinIO secret，且 cpaas:etcd-backup 缺少 secrets 读取权限，导致 etcd 备份任务无法按配置读取存储信息"
runbook: ""
branch: ""
source_path: ""
affected_versions: [v4.1, v4.2, v4.3]
---
# etcd 备份无法按预期使用 S3/MinIO 存储信息执行

## 现象
- 在 `v4.1` 及后续相关环境中，etcd 备份配置为 s3 存储后，备份无法按预期使用 MinIO 存储信息执行。
- 现场核对发现，4.1 之后与 etcd 备份相关的资源包括 `etcdbackupconfigurations`、`etcdbackuprecords`，同时仍存在 `advancedcronjobs`、`broadcastjob`。
- 进一步确认后发现，实际执行 etcd 备份任务的仍是 `advancedcronjob`，而 `ebc` 主要负责备份配置管控。

## 排查过程与命令
- 首先核对 4.1 之后 etcd 备份相关资源的职责分工，明确运行链路并未完全切换到新的资源模型，因此需要同时关注 `ebc` 配置层和实际执行链路。
- 随后检查集群中与 etcd 备份相关的凭据对象，执行以下命令定位存储 MinIO 连接信息的 secret：
  ```bash
  kubectl get secret -A | grep etcd
  ```
- 现场确认该 secret 类型为 `Opaque`，说明 MinIO 连接信息已存在，但尚需继续验证 `ebc` 是否正确引用了该 secret。
- 接着编辑默认 etcd 备份配置，将 `secretRef` 调整为实际存储 MinIO 连接信息的 secret 名称，并设置 `skipTLSVerify: true`：
  ```bash
  kubectl edit ebc etcd-backup-default
  ```
- 完成配置修正后，继续检查 etcd 备份执行侧权限，发现 `cpaas:etcd-backup` 对 `secrets` 的读取权限不足，因此无法稳定获取外部存储凭据。
- 为消除该限制，补充 etcd 备份相关 `clusterrole` 的 `secrets` 权限，包括 `get`、`list`、`watch`：
  ```bash
  kubectl edit clusterrole cpaas:etcd-backup
  ```
- 综合配置核对与权限修正结果，可以确认本次问题并非备份任务本身未创建，而是备份执行链路在读取 S3/MinIO 存储配置时存在引用与权限两方面障碍。
- 调整 `secretRef`、设置 `skipTLSVerify: true` 并补充 `secrets` 读取权限后，etcd 备份已可按 s3/MinIO 配置正常执行。

## 根因与修复方案
- **根因**
  - 初步判断问题与 `ebc` 的 s3 存储配置引用不正确，以及 `cpaas:etcd-backup` 对 `secrets` 权限不足有关，导致 etcd 备份任务无法按配置读取 MinIO 存储信息。
- **临时缓解方案**
  - 编辑 `etcd-backup-default`，将 `secretRef` 修改为实际存储 MinIO 连接信息的 secret，并设置 `skipTLSVerify: true`。
  - 为 `cpaas:etcd-backup` 补充 `secrets` 的 `get`、`list`、`watch` 权限。
- **根本解决方案**
  - 在 etcd 备份配置模型与执行链路之间建立一致的配置校验，确保 `ebc` 引用的存储凭据与实际执行任务读取路径一致。
  - 将 etcd 备份对 `secrets` 的依赖权限纳入默认 RBAC 基线，避免因权限缺失导致 S3/MinIO 备份配置失效。
