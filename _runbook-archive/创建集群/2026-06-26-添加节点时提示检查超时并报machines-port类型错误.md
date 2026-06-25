---
tags: [incident]
date: 2026-06-26
component: "创建集群"
fault_type: "创建集群/添加节点/端口与环境校验失败"
symptom: "集群创建添加节点时提示 检查超时，请重试，接口同时报 clustermachine.machines.port 类型错误"
root_cause: "machines-port 字段被当成字符串提交，同时节点到 global vip 的关键端口未放通且存在 docker-runc 残留，导致添加节点校验失败"
runbook: "[[创建集群-添加节点检查超时与machines.port类型错误-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# 添加节点时提示检查超时并报 machines.port 类型错误

## 现象
- 在集群创建过程中添加节点时，页面提示 `检查超时，请重试`。
- 同时接口返回 `clustermachine.machines.port` 类型错误。
- 该问题不是单一网络异常，而是前端提交字段格式、节点连通性和节点环境残留多项因素叠加导致的添加节点失败。

## 排查过程与命令
- 首先检查添加节点接口返回内容，发现 `POST` 接口返回 `400`，报错为：
  ```text
  parse body error: json: cannot unmarshal string into Go struct field ClusterMachine.machines-port of type int32
  ```
  由此确认 `machines-port` 被当成字符串提交，前端提交数据类型不符合后端接口要求。
- 切换为英文输入法后重新填写端口信息，再次提交后，`检查超时，请重试` 这一类由字段格式触发的报错消失，说明第一个问题点已被排除。
- 但节点添加流程仍存在后续问题，于是继续检查节点到 `global vip` 的连通性。确认节点侧需要放通 `6443`、`60080`、`443` 等关键端口。
- 在节点侧执行：
  ```bash
  telnet 10.137.64.47 60080
  telnet 10.137.64.47 443
  ```
  访问失败，说明节点到 `global vip` 的网络路径并不满足添加节点要求。
- 随后进一步检查节点环境，发现当前节点存在 `docker-runc` 包残留。该残留可能影响节点初始化和运行时兼容性，因此建议先移除：
  ```bash
  yum remove docker-runc
  ```
- 在完成端口放通和 `docker-runc` 清理后，再次执行节点添加流程，节点已成功加入集群，不再报错。
- 综合整个排查过程可以确认，本次故障由三个环节共同触发：
  1. `machines-port` 字段类型错误；
  2. 节点到 `global vip` 关键端口不通；
  3. 节点存在 `docker-runc` 残留环境。

## 根因与修复方案
- **根因**
  - `machines-port` 字段填写类型错误，被作为字符串提交，导致接口解析失败。
  - 节点到 `global vip` 的 `6443`、`60080`、`443` 端口未放通，影响节点添加校验。
  - 节点存在 `docker-runc` 残留，进一步影响添加节点流程。
- **临时缓解方案**
  - 切换英文输入法后重新填写端口信息，确保 `machines-port` 以正确类型提交。
  - 放通节点到 `global vip` 的 `6443`、`60080`、`443` 端口。
  - 移除节点上的 `docker-runc` 残留后重新添加节点。
- **根本解决方案**
  - 在前端或接口侧增加 `machines-port` 字段类型校验，避免字符串格式直接提交到后端。
  - 将节点到 `global vip` 的关键端口连通性纳入添加节点前置检查项。
  - 在节点纳管前增加运行时环境残留检测，提前识别并清理 `docker-runc` 等冲突组件。
