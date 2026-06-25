---
tags: [incident]
date: 2026-06-26
component: "容器网络"
fault_type: "容器网络/节点iptables/10250访问受阻"
symptom: "节点 web-cli 连接失败，运行在该节点上的 Pod 日志无法查看"
root_cause: "节点存在异常 iptables REJECT 规则，拒绝外部访问 10250 端口，导致 apiserver 无法访问 kubelet 提供的日志与 web-cli 通道"
runbook: "[[容器网络-节点10250访问受阻导致web-cli和日志失败-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# 节点 web-cli 连接失败且 Pod 日志无法查看

## 现象
- 节点 `web-cli` 连接失败。
- 运行在该节点上的 `Pod` 日志无法查看。
- 现场排查表明，问题并非 `Pod` 调度异常，而是访问该节点 `10250` 端口的链路被阻断，导致平台和 `kubectl logs` 均无法正常获取节点侧能力。

## 排查过程与命令
- 首先检查 `Pod` 调度情况，未发现异常，说明问题不在调度器或 Pod 分布层面。
- 随后验证 `10250` 端口的可达性：在问题节点本机访问 `10250` 正常，但从同集群其他节点访问该问题节点 `10250` 端口失败，执行：
  ```bash
  telnet <问题节点IP> 10250
  ```
  返回：
  ```text
  No route to host
  ```
  说明故障不在 kubelet 监听本身，而在外部到该节点的访问链路。
- 进一步在平台查看运行在该节点上的 `Pod` 日志失败；在集群中执行 `kubectl logs` 也报错，显示访问该节点 `10250` 失败，报错为：
  ```text
  connect: no route to host
  ```
  由此可以确认，问题同时影响 `web-cli` 与 `Pod logs` 两条依赖节点 `10250` 的访问路径。
- 为进一步缩小范围，继续确认问题节点到集群 `6443` 端口访问正常，因此节点状态仍可正常上报给 `apiserver`。这说明异常不是节点完全失联，而是反向从 `apiserver` 或其他节点访问该节点 `10250` 时被丢弃。
- 检查节点本机规则后，发现存在如下异常 `iptables` 规则：
  ```text
  REJECT all -- anywhere anywhere reject-with icmp-host-prohibited
  ```
  该规则会直接拒绝外部访问，和前述 `No route to host` 现象一致。
- 为恢复访问，执行：
  ```bash
  iptables -F
  ```
  清理异常 `iptables` 规则后，重启节点 `kube-proxy` 和 `cni`，由平台默认规则重新补齐。
- 处理完成后，`web-cli` 与 `Pod` 日志访问恢复正常。由此可以确认，本次故障的根因是节点 `iptables` 规则异常，而不是 kubelet 或 apiserver 本身异常。

## 根因与修复方案
- **根因**
  - 节点存在异常 `iptables` `REJECT` 规则，拒绝外部访问节点 `10250` 端口。
  - `apiserver` 无法通过 `10250` 访问节点 `kubelet`，最终导致 `web-cli` 和 `Pod` 日志访问失败。
- **临时缓解方案**
  - 执行 `iptables -F` 清理异常规则。
  - 重启节点 `kube-proxy` 和 `cni`，由平台默认规则重新补齐。
- **根本解决方案**
  - 排查并修复节点上异常 `iptables` 规则的来源，避免规则再次漂移或被错误覆盖。
  - 将节点 `10250` 连通性与关键 `iptables` 拒绝规则纳入节点网络健康检查项，提前发现并处理访问阻断问题。
