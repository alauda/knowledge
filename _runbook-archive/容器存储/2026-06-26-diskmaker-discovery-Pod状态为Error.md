---
tags: [incident]
date: 2026-06-26
component: "容器存储"
fault_type: "容器存储/topolvm/本地存储发现组件依赖缺失"
symptom: "global 集群中 diskmaker-discovery Pod 状态为 Error"
root_cause: "Alauda Build of Local Storage operator 被卸载或资源残缺，导致 diskmaker-discovery 引用的 local-storage-admin serviceAccount 不存在"
runbook: "[[容器存储-diskmaker-discovery异常-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# diskmaker-discovery Pod 状态为 Error

## 现象
- `global` 集群中 `diskmaker-discovery-592zd` Pod 状态为 `Error`。
- 该组件用于新版 `topolvm` 检查节点 `lvm`，并将其转化为 `topolvm` 可识别的“磁盘”。
- 故障期间 `diskmaker` 无法正常运行，说明本地存储发现链路已经中断。

## 排查过程与命令
- 首先查看 `Pod` 配置，确认其使用：
  - `serviceAccount: local-storage-admin`
  - `serviceAccountName: local-storage-admin`
  - `priorityClassName: system-node-critical`
  - `restartPolicy: Always`
- 随后查看 `describe` 事件，发现持续报错：
  ```text
  Warning FailedMount ... kubelet MountVolume.SetUp failed for volume "kube-api-access-kzrwx" : failed to fetch token: serviceaccounts "local-storage-admin" not found
  ```
  该错误近两天重复出现近两千次，说明问题并非偶发，而是依赖对象持续缺失。
- 为确认是否为单 Pod 异常，删除 `127` 节点上的 `disk-maker` 后观察重建情况，结果 Pod 未自动拉起；继续查看 `ds` 事件，仍提示：
  ```text
  serviceaccounts "local-storage-admin" not found
  ```
  说明问题不在单个 Pod，而在控制器依赖资源层面。
- 接着执行：
  ```bash
  kubectl get sa -A | grep local
  ```
  确认 `ds` 引用的 `serviceAccount` 实际不存在。
- 进一步检查相关 `operator` 资源，执行：
  ```bash
  kubectl get subs,installplan,csv -A | grep local
  ```
  仅查询到一条 `installplan`，据此判断 `Alauda Build of Local Storage` 相关 `operator` 资源不完整，安装状态异常。
- 最终在 `global` 集群重新安装 `Alauda Build of Local Storage` 后，`127` 节点 `diskmaker` Pod 恢复正常。由此可以确认，问题根因不是节点本地 `lvm` 本身异常，而是本地存储发现组件所依赖的 `operator` 资源缺失。

## 根因与修复方案
- **根因**
  - `Alauda Build of Local Storage` operator 被卸载或资源残缺。
  - `diskmaker-discovery` 依赖的 `local-storage-admin` 不存在，导致 Pod 无法挂载 `kube-api-access` 相关卷并持续报错。
- **临时缓解方案**
  - 重新安装 `Alauda Build of Local Storage`，恢复 `serviceAccount` 与相关控制器资源。
- **根本解决方案**
  - 建立本地存储发现组件及其 `operator` 依赖资源的完整性检查，避免 `serviceAccount`、`CSV`、`installplan` 等对象缺失后长期无人发现。
  - 将 `diskmaker-discovery`、`topolvm` 依赖链路纳入集群存储组件健康检查，提前识别本地存储发现链路异常。
