---
tags: [incident]
date: 2026-06-26
component: "创建集群"
fault_type: "创建集群/marketplace/chart下载失败"
symptom: "创建业务集群时 marketplace 卡在 ChartDownloading"
root_cause: "新建集群节点到客户 DNS 服务器 53 端口不通，导致无法解析 acp.tebonlocal.cn 并下载 marketplace chart 失败"
runbook: "[[创建集群-marketplace卡在ChartDownloading-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# 创建业务集群时 marketplace 卡在 ChartDownloading

## 现象
- 在创建业务集群过程中，`marketplace` 组件状态卡在 `ChartDownloading`。
- 查看 `ars` 状态可见 `cpaas-system/marketplace` 长时间未继续推进。
- 现场进一步检查发现，`olm`、`package`、`market` 相关 Pod 均未正常拉起，说明问题发生在 chart 下载阶段，尚未进入后续组件启动流程。

## 排查过程与命令
- 首先检查 `ars` 状态，确认异常组件为 `cpaas-system/marketplace`，且状态停留在 `ChartDownloading`。
- 随后检查相关 Pod 是否已经被拉起，以区分问题是下载阶段异常还是组件启动后异常：
  ```bash
  kubectl get pod -A | grep olm
  kubectl get pod -A | grep package
  kubectl get pod -A | grep market
  ```
- 检查结果显示未查询到相关 Pod，说明问题不在运行态，而是在 chart 获取阶段已失败。
- 继续 `describe` 对应 `ars`，事件中显示下载 `ait/chart-marketplace-v4.1.16` 失败，请求以下地址超时：
  ```text
  http://acp.tebonlocal.cn/v2/ait/chart-marketplace/manifests/v4.1.16
  ```
  同时报错包含：
  ```text
  dial tcp: lookup acp.tebonlocal.cn on 172.30.0.10:53 ... i/o timeout
  ```
  由此可以将排查方向收敛到 DNS 解析链路。
- 为排除本地配置差异，继续对比其他业务集群节点和新建集群节点的 `/etc/resolv.conf`，结果配置一致；同时检查其他集群 `coredns` 插件，也未发现额外 `host` 配置，说明异常并非由节点解析配置差异或额外静态解析导致。
- 随后在其他集群节点执行：
  ```bash
  nslookup acp.tebonlocal.cn
  ```
  可正常解析；而在新建集群节点执行相同命令时报错：
  ```text
  connection timed out; no servers could be reached
  ```
  这说明问题集中在新建集群节点到 DNS 服务的访问链路，而不是域名本身不存在。
- 为进一步确认，继续在新建集群节点执行：
  ```bash
  dig @10.1.148.57 acp.tebonlocal.cn
  ```
  同样返回：
  ```text
  connection timed out; no servers could be reached
  ```
- 最后通过 `telnet dns-ip 53` 验证，确认新建集群节点到客户 DNS 服务器 `53` 端口网络不通。至此可以确定，`acp.tebonlocal.cn` 无法被解析，直接导致 marketplace chart 下载失败。

## 根因与修复方案
- **根因**
  - 新建集群节点到客户 DNS 服务器 `53` 端口网络不通。
  - 节点无法解析 `acp.tebonlocal.cn`，从而无法下载 `marketplace` 所需 chart。
  - 最终表现为创建业务集群时 `marketplace` 卡在 `ChartDownloading`。
- **临时缓解方案**
  - 开通新建集群节点到客户 DNS 服务器 `53` 端口的网络访问能力。
  - 恢复 DNS 解析后重新触发 chart 下载或重新推进业务集群创建流程。
- **根本解决方案**
  - 将新建集群节点到客户 DNS 服务器的 `53` 端口连通性纳入交付前网络检查项，避免业务集群创建时因 DNS 解析失败卡在组件下载阶段。
  - 在集群初始化链路中增加对关键域名解析与 DNS 端口可达性的预检查，提前暴露环境侧网络问题。
