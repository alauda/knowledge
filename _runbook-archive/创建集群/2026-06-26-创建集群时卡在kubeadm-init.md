---
tags: [incident]
date: 2026-06-26
component: "创建集群"
fault_type: "创建集群/kubeadm init/镜像拉取与主机解析异常"
symptom: "创建集群时卡在 kubeadm init，节点初始化失败"
root_cause: "老版本节点 hosts.toml 中 http 配置优先级高于 https，且 global vip 可访问 80 端口，导致新集群节点优先走 80 端口拉取镜像超时；同时 master 节点缺少本机 hosts 解析，进一步影响初始化流程"
runbook: "[[创建集群-kubeadm-init卡住-排查手册]]"
branch: ""
source_path: ""
affected_versions: []
---
# 创建集群时卡在 kubeadm init

## 现象
- 在 `3.18` 环境创建集群时，流程卡在 `kubeadm init`，节点初始化失败。
- 现场同时观察到镜像拉取速度较慢，说明初始化卡顿不仅发生在 `kubeadm` 阶段，也与镜像获取链路异常有关。
- 故障处理过程中，虽然部分问题被修复，但在前置步骤长时间卡住后，仍出现 `authentication` 相关报错，最终需要重装集群完成恢复。

## 排查过程与命令
- 首先定位到新建集群卡在 `kubeadm init`，并同时发现镜像拉取速度异常偏慢。检查 `/etc/containerd/certs.d/0.0.0.0_0/hosts.toml` 后发现，`http` 配置排在 `https` 之前，导致节点优先通过 `80` 端口拉取镜像，超时后才回退到 `443`。
- 针对这一问题，先调整三个 `master` 节点上的 `/etc/containerd/certs.d/0.0.0.0_0/hosts.toml`，将 `https` 与 `http` 的配置顺序调整为优先使用 `https`。调整后镜像拉取恢复正常，但集群创建流程仍卡在 `init`，说明还存在其他阻塞因素。
- 随后查看 `tke-platform-controller` 日志，发现存在 `host` 解析相关报错。继续检查三个 `master` 节点的 `/etc/hosts`，确认未配置本机 `host` 解析。补充节点 `IP` 与主机名映射后，相关 `host` 解析报错消失。
- 在前述问题处理后，流程中又出现 `authentication` 相关报错，并发现 `71` 节点的 `etcd member` 已被添加为 `learner`。由于前置步骤卡住时间较长，环境状态已经偏离正常初始化路径，因此选择重装集群。
- 重装过程中又发现节点残留未清理干净，导致流程再次卡住。最终在创建集群执行到 `runc` 阶段时，及时修改 `/etc/containerd/certs.d/0.0.0.0_0/hosts.toml`，随后集群创建成功，不再卡在 `kubeadm init`。
- 综合整个排查过程可以确认，最初的主因是镜像拉取路径选择异常；而 `hosts` 解析缺失则进一步放大了初始化阶段的失败概率，二者共同影响了集群创建流程。

## 根因与修复方案
- **根因**
  - 老版本节点 `/etc/containerd/certs.d/0.0.0.0_0/hosts.toml` 中 `http` 配置优先于 `https`。
  - 同时 `global vip` 未禁止外部访问 `80` 端口，导致新集群节点优先经 `80` 端口拉取镜像并超时。
  - 此外 `master` 节点缺少本机 `/etc/hosts` 解析，进一步影响初始化过程中的主机名解析链路。
  - 多个问题叠加后，最终表现为创建集群时卡在 `kubeadm init`。
- **临时缓解方案**
  - 调整 `hosts.toml` 中 `https` 与 `http` 的顺序，确保优先通过 `https` 拉取镜像。
  - 为 `master` 节点补充本机 `IP` 与主机名映射。
  - 在环境状态已被长时间阻塞污染时，重装集群重新推进创建流程。
- **根本解决方案**
  - 修正老版本节点的默认 `hosts.toml` 配置，避免镜像拉取优先走不可靠的 `http/80` 路径。
  - 在交付侧收紧 `global vip` 的端口暴露策略，避免外部访问 `80` 端口干扰镜像拉取路径。
  - 将 `master` 节点本机 `hosts` 解析检查纳入创建集群前置校验项，提前发现并修复主机名解析问题。
