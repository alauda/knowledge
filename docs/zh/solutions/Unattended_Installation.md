---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1765182144-0B80
sourceSHA: f097b955d44096e1ae6d0476db6bf7ae89e0aa30497c5cc58aab5ac844e9cc77
---

# Alauda 云平台 (ACP) 的无人值守安装

## 功能概述

**主要功能：**

- 无人值守安装。
- 指定配置文件以便于安装。
- 仅生成并打印配置文件的干运行模式。
- 脚本可以配置为无限等待，直到 ACP 安装完成。否则，它将在触发安装后立即返回。

**限制：**

- 所有节点 *必须* 共享相同的 SSH 配置。如果需要为每个节点指定 SSH 配置，必须编辑脚本生成的配置文件。
- 目前不支持与 GPU 相关的配置。
- 在无人值守安装中，不允许用户工作负载在控制平面节点上运行。

## 先决条件

有关环境要求的完整列表，请参见 [先决条件](https://docs.alauda.io/container_platform/4.1/install/prepare/prerequisites.html) 部分。

:::info
**已验证与此脚本兼容的 ACP 版本：**

- v3.12.x
- v3.14.x
- v4.1.x
  :::

## 安装 ACP

<Steps>

### 下载并解压 ACP 安装程序 tarball 文件

### 启动安装程序

有关详细步骤，请参见 [启动安装程序](https://docs.alauda.io/container_platform/4.1/install/installing.html#start_installer)。

### 下载并执行安装脚本

将下载的 [安装脚本](https://raw.githubusercontent.com/alauda/knowledge/9b147b69045d7c84c709233c3c21397d1adcd7e3/docs/public/unattended_installation/platform-install.sh) 放入解压后的安装程序目录中。然后通过以下命令执行它：

```shell
bash platform-install.sh <options>
```

:::warning

- `--cri-version` 和 `--cluster-version` 的值必须与安装程序包中提供的版本匹配，这些版本可以在 ACP 基线文档中找到。
- 脚本仅对输入参数执行基本检查。您必须确保所有参数值有效。
- 脚本无法验证所有节点是否满足 ACP 安装的先决条件。您 *必须* 在开始安装之前手动检查所有节点的配置。
  :::

```
Options:
    --installer-ip                      安装程序运行主机的 IP 地址。默认值：`127.0.0.1`。
    --config-file                       现有配置文件的路径。当设置此项时，除了 `--installer-ip`、`--dry-run` 和 `--wait` 之外的所有参数都将被忽略。
    --dry-run                           仅生成并显示配置文件，而不启动实际安装。默认值：`false`。
    --wait                              在脚本退出之前等待部署完成。默认值：`true`。
    --admin-username                    平台管理员的用户名。默认值：`admin`。
    --admin-password                    平台管理员的密码。
    --cluster-version                   Kubernetes 版本。此参数是必需的。
    --cri-version                       CRI 类型和版本。默认值：`containerd://1.6.20-4`。
                                        * 您可以通过以下方式获取支持的 Kubernetes 和 CRI 版本：
                                          `curl -H "Authorization: Bearer <TOKEN>" ${INSTALLER_IP}:8080/api/v1/namespaces/kube-public/configmaps/base-component-version`
                                          * 其中 `<TOKEN>` 可以通过 `curl ${INSTALLER_IP}:8080//cpaas-installer/api/token` 获取。
    --self-vip                          是否启用自管理 VIP。默认值：`false`。
    --vrid                              自管理 VIP 使用的 VRID。范围：`1–255`。VRID 在同一子网内必须唯一。默认值：`137`。
    --cluster-ha                        global 集群的 HA 地址。
    --platform-domain                   平台访问地址，可以是 IP 地址或域名。
    --platform-http                     访问平台使用的 HTTP 端口。默认值：`0`。值为 `0` 时禁用 HTTP 访问。
    --platform-https                    访问平台使用的 HTTPS 端口。默认值：`443`。
    --tls-cert-file                     平台访问地址的 TLS 证书文件路径。省略时使用自签名证书。
    --tls-key-file                      平台访问地址的 TLS 私钥文件路径。省略时使用自签名证书。
    --external-registry-address         外部镜像注册表的地址。省略时使用平台提供的注册表。
    --registry-domain                   注册表域名。使用平台提供的注册表时，默认与 `--cluster-ha` 相同。
    --registry-username                 注册表的用户名，如果需要身份验证。
    --registry-password                 注册表用户的密码。
    --cni-type                          CNI 类型。有效值：`ovn`、`calico`。默认值：`ovn`。
    --dual-stack                        是否启用双栈网络。默认值：`false`。
    --network-device                    网络接口名称。没有默认值。
    --cluster-cidr-ipv4                 global 集群的 IPv4 集群 CIDR。默认值：`10.3.0.0/16`。
    --service-cidr-ipv4                 global 集群的 IPv4 服务 CIDR。默认值：`10.4.0.0/16`。
    --join-cidr-ipv4                    使用 OVN 作为 global 集群中的 CNI 时的 IPv4 加入 CIDR。默认值：`100.64.0.0/16`。
    --cluster-cidr-ipv6                 global 集群的 IPv6 集群 CIDR。默认值：`fd00:10:16::/64`。
    --service-cidr-ipv6                 global 集群的 IPv6 服务 CIDR。默认值：`fd00:10:96::/112`。
    --join-cidr-ipv6                    使用 OVN 作为 global 集群中的 CNI 时的 IPv6 加入 CIDR。默认值：`fd00:100:64::/64`。
    --hostname-as-node-name             使用主机名作为节点名称。设置为 `false` 时，使用节点 IP 地址。默认值：`false`。
    --node-isolate                      启用 global 集群的平台节点隔离。当启用时，平台组件仅限于控制平面节点。默认值：`false`。
    --control-planes                    控制平面节点的 IPv4 地址，以逗号分隔，例如：`192.168.1.1,192.168.1.2,192.168.1.3`。
    --workers                           工作节点的 IPv4 地址，以逗号分隔。
    --control-planes-ipv6               控制平面节点的 IPv6 地址。双栈所需。以逗号分隔，与 `--control-planes` 一一对应。
    --workers-ipv6                      工作节点的 IPv6 地址。双栈所需。以逗号分隔，与 `--workers` 一一对应。
    --control-planes-app-deployable     允许在控制平面节点上调度应用程序。默认值：`false`。当启用 `--node-isolate` 时，此设置无效。
    --ssh-port                          SSH 服务端口。默认值：`22`。
    --ssh-username                      SSH 用户名。默认值：`root`。
    --ssh-password                      SSH 登录密码。
    --ssh-key-file                      用于登录的 SSH 私钥文件路径。
    --prometheus-nodes                  应部署 Prometheus 的节点的 IPv4 地址，以逗号分隔。留空以跳过部署 Prometheus。
    --victoriametrics-nodes             应部署 VictoriaMetrics 的节点的 IPv4 地址，以逗号分隔。留空以跳过部署 VictoriaMetrics。
    --victoriametrics-agent-replicas    要部署的 VictoriaMetrics Agent 副本数量。
    --elasticsearch-nodes               应部署 Elasticsearch 的节点的 IPv4 地址，以逗号分隔。留空以跳过部署 Elasticsearch。
    --node-max-pods                     每个节点允许的最大 Pods 数量。默认值：`110`。
    --alternative-hosts                 平台的其他访问地址，以逗号分隔。
    --products                          要部署的产品，以逗号分隔。`base` 和 `acp` 是必需的。默认值：`base,acp,devops,asm,dataServices`。
```

#### 示例

```shell
bash platform-install.sh \
    --admin-password 'password' \
    --self-vip true --vrid 219 \
    --cri-version containerd://1.7.27-4 --cluster-version 1.32.7 \
    --cluster-ha 192.168.137.42 \
    --platform-domain 192.168.137.42 \
    --control-planes 192.168.130.220,192.168.137.238,192.168.131.232 \
    --ssh-password 'AlMdCcQfgiEEEawVBIz6' \
    --products 'base,acp'
```

</Steps>
