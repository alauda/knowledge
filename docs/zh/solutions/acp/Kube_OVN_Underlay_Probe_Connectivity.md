---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - '4.2.x,4.3.x,4.4.x'
id: KB261000040
sourceSHA: e83c5d2e594955ac2002db6430cc2c1266984258725f0b2d40730e0aec5520e7
---

# Kubelet 探测隔离节点与底层网络的连通性

## 问题

当在使用物理网关的底层子网中未启用 U2O 时，其逻辑交换机无法通过 U2O 路由器端口连接到默认 VPC 的 OVN 路由器。节点无法通过加入网络访问该子网。因此，Kubelet 对底层 Pod 的探测需要可达的物理网络路径或其他专用路径。如果节点管理网络与底层工作负载网络隔离且没有可用的替代路径，则探测请求无法到达 Pods，导致超时或连接失败。

![在没有 U2O 的情况下，物理网络隔离阻止 kubelet 探测到达底层 Pods](../../../en/solutions/acp/assets/underlay-probe-isolation.svg)

该解决方案结合了 **底层到覆盖网络的互连 (U2O)、允许来自加入子网的流量的 ACL，以及通过每个节点的 200 表进行的基于目的地的策略路由**。对于满足以下条件的探测连接，节点的加入 IP 被选为源，请求和响应都通过 OVN 网络传输。成功意味着实际探测在两个方向上都有效；仅存在路由和规则是不够的。

## 环境和范围

**适用版本：** ACP 4.2.x、4.3.x 和 4.4.x，受以下网络要求的限制。

**验证版本：** 兼容性审查和共享转发路径升级测试使用了以下版本组合：

| ACP 版本 | Kube-OVN 版本 |
| ----------- | ---------------- |
| 4.2.3       | v1.14.34         |
| 4.3.3       | v1.15.24         |

ACP 4.4.x 和其他补丁版本在列出的版本系列中尚未单独测试。在部署之前，请确认已安装的 Kube-OVN 功能并完成目标环境中的验证步骤。

**验证范围：** 在 ACP 4.2.3 到 4.3.3 的升级过程中，使用覆盖 Pods 进行的测试覆盖了 `table 200 → ovn0 → join → default VPC` 转发路径。路由配置保持不变，并在组件更换期间的瞬态中断后恢复了测试连通性。在该测试中未对启用 U2O 和加入 CIDR ACL 的底层 Pods 进行端到端的 kubelet 探测。请使用以下检查在目标环境中验证完整路径。

- ACP 集群使用 Kube-OVN，其子网 CRD 支持 `spec.u2oInterconnection` 和 `spec.acls`。在部署之前检查这些字段和已安装版本的 U2O 行为。
- 本文涵盖使用物理网关的默认 VPC 中的 IPv4 底层子网：`spec.vlan` 已配置，且 `spec.logicalGateway` 为 `false`。
- 底层地址是工作负载 Pod 的主要网络 IP，也是 kubelet 探测的实际目标。如果只有辅助接口使用底层，首先确定探测目标的地址。
- 节点的 ovn0 接口、加入网络、默认 VPC 路由器和底层 VLAN/ProviderNetwork 配置正常。
- 操作员具有修改子网和工作负载的 Kubernetes 权限，并对受影响节点具有 root 访问权限。

请勿将此操作步骤直接应用于自定义 VPC、覆盖子网或 `logicalGateway: true` 的底层子网。U2O 将底层子网连接到其自身 VPC 的路由器。它不会自动将自定义 VPC 连接到默认 VPC 的加入网络或向物理路由器通告路由。

## 工作原理

### U2O 连接逻辑网络

在 U2O 中，U 代表底层，O 代表覆盖。默认 VPC 中的加入子网已经连接到该 VPC 的 OVN 逻辑路由器。启用目标底层子网的 U2O 将其通过 U2O 路由器端口连接到同一路由器，形成以下路径：

`Node ovn0 → join → default VPC router → U2O router port → Underlay Pod`

加入网关是节点路由的下一个跳点。U2O IP 是底层侧的路由器接口地址。底层物理网关提供相应的物理网络出口。这些是不同的地址。

![逻辑拓扑和双向探测路径](../../../en/solutions/acp/assets/underlay-probe-topology.svg)

对于使用此底层子网作为其主要网络的新创建 Pods，CNI 根据 U2O 设置配置 Pod 网关。更新子网不会自动更新现有 Pods 的网络命名空间。根据工作负载可用性要求逐步重新创建它们。U2O 还会影响与覆盖网络的连通性和出口处理，因此也要验证现有应用流量路径。

### 200 表控制节点上的路由选择

该解决方案在每个节点上添加了两个对象：

| 对象                                                 | 目的                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `ip rule … to <UNDERLAY_CIDR> … table 200`             | 匹配目标底层 CIDR，并在主表之前查找 200 表。 |
| `ip route … <UNDERLAY_CIDR> via <JOIN_GW> … table 200` | 提供通过加入网关和 ovn0 的路由。                 |

主表中自动管理的路由可能将节点的 InternalIP 指定为其首选源地址。200 表中的路由不指定 `src`，允许未绑定源地址的请求根据所选路由使用 ovn0 的加入 IP。**策略规则不执行 SNAT，并且不会覆盖已由应用程序绑定的源地址。** 使用 `ip route get` 和实际的 kubelet 流量验证所选源。

![源地址和返回路径：主表与 200 表](../../../en/solutions/acp/assets/underlay-probe-route-selection.svg)

发往节点的加入 IP 的响应可以通过 U2O、默认 VPC 路由器和加入返回。发往节点 InternalIP 的响应可能仍然通过 U2O 路由策略指向物理网关。因此，现有的通过 ovn0 的路由本身并不能证明解决方案正在工作。

## 配置

### 1. 确定参数并保存当前配置

从一个节点和一组代表性的工作负载 Pods 开始，然后逐个节点进行操作。最终覆盖每个可能运行受影响工作负载的节点，包括新添加的节点。

| 参数                                   | 来源或要求                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<UNDERLAY_SUBNET>`, `<UNDERLAY_CIDR>`      | 使用目标子网的名称和 `spec.cidrBlock`。如果有多个子网，请分别列出每个子网。                                                                                                |
| `<JOIN_SUBNET>`, `<JOIN_CIDR>`, `<JOIN_GW>` | 从实际的加入子网中读取名称、CIDR 和网关。不要假设固定地址。在每个 CIDR 中使用规范网络地址。                                                                 |
| `<NODE_JOIN_IP>`                            | 读取每个节点上 ovn0 的 IPv4 地址。该地址在节点之间不同。                                                                                                                               |
| `<RULE_PRIORITY>`                           | 选择一个未使用的优先级，该优先级在主表查找之前运行，并检查是否存在任何早期匹配的策略。较低的数字优先运行。不要仅仅因为它出现在示例输出中而重复使用优先级。 |
| `<POD_IP>`, `<PROBE_PORT>`, `<PROBE_PATH>`  | 使用实际工作负载或专用验证 Pod 的底层主要 IP，以及其真实的健康检查端口和路径。                                                                                      |

从集群管理终端，检查子网并在进行更改之前保存其 YAML：

```bash
kubectl get subnet <UNDERLAY_SUBNET> -o yaml
kubectl get subnet <JOIN_SUBNET> -o yaml
kubectl get subnet -o yaml
```

在每个受影响的节点上，保存以下输出和任何将被修改的 `.network` 文件、systemd 单元或脚本的副本。将备份存储在管理主机或节点的持久目录中，而不仅仅是在临时容器文件系统中。

```bash
ip -4 addr show dev ovn0
ip -4 rule show
ip -4 route show table main
ip -4 route show table 200
ip -4 route get <POD_IP>
systemctl is-active systemd-networkd NetworkManager
```

确认 200 表与其他策略路由、`Subnet.spec.policyRoutingTableID` 或网络管理工具没有冲突。`ovn_table` 别名仅影响表名的显示方式。使用数字 ID 200 就足够了；反复将别名附加到 `/etc/iproute2/rt_tables` 是不必要的。如果已经存在等效规则，请在继续之前识别它们的优先级和持久性机制，并避免添加重复项。

### 2. 启用 U2O 并合并 ACL

在目标底层子网上启用 U2O：

```bash
kubectl patch subnet <UNDERLAY_SUBNET> --type=merge \
  -p '{"spec":{"u2oInterconnection":true}}'
kubectl edit subnet <UNDERLAY_SUBNET>
```

在编辑器中，**将以下 ACL 附加或合并到现有的 `spec.acls` 列表中**，保留现有规则。这是一个配置片段，而不是完整的子网清单。不要用它覆盖整个 ACL 列表。

```yaml
spec:
  u2oInterconnection: true
  acls:
    # 保留现有 ACL 并合并以下规则。
    - action: allow-related
      direction: to-lport
      match: "ip4.src == <JOIN_CIDR>"
      priority: 3000
```

`to-lport` 意味着流量进入 Pod 的逻辑端口，而 `allow-related` 提供有状态的权限。与原始操作步骤一样，该规则允许来自加入子网的所有 IPv4 协议和端口，而不仅仅是健康探测。如果需要更窄的规则，请为实际的探测协议和端口设计它，然后再次验证。优先级 3000 并不能保证优先于所有其他 ACL 或 NetworkPolicy，并且 ACL 不会替代返回路由检查。

检查子网状态、U2O 地址分配和相关事件，以确认控制器已处理配置：

```bash
kubectl get subnet <UNDERLAY_SUBNET> -o yaml
kubectl describe subnet <UNDERLAY_SUBNET>
```

一旦节点策略路由准备就绪，逐步在此子网中重新创建现有工作负载 Pods，以使其网络配置生效。考虑工作负载类型、可用副本和中断预算。首先验证新创建的 Pods，然后分批进行；不要一次性删除所有工作负载 Pods。

### 3. 使节点路由持久化

选择以下方法之一。对于多个子网，每个底层 CIDR 必须有其自己的匹配路由和规则。不要使用不相关的 CIDR 作为规则的匹配条件。

以下示例明确了接口或规则优先级，并向脚本添加了就绪性和重复执行检查。这些是实施保护措施。路由原则保持不变：查找 200 表以获取目标 CIDR，使用加入网关作为下一个跳点，并且在路由中不指定 `src`。

#### 方法 1：systemd-networkd

在已启用 systemd-networkd 并已确认与 CNI 管理 ovn0 共存的节点上使用此方法。运行 `networkctl status ovn0` 以识别当前匹配的文件。`.network` 文件根据其匹配顺序生效。确保新文件不会无意中替换现有配置，并且不要让 NetworkManager 和 networkd 同时管理同一接口。

以下是 `/etc/systemd/network/10-ovn0.network` 的示例。替换每个占位符。`KeepConfiguration=yes` 旨在保留现有配置。在部署之前，请确认已安装的 systemd 版本支持此设置，并在第一个节点上验证重新配置不会删除现有地址或路由。

```ini
[Match]
Name=ovn0

[Network]
DHCP=no
KeepConfiguration=yes

[Route]
Destination=<UNDERLAY_CIDR>
Gateway=<JOIN_GW>
Table=200

[RoutingPolicyRule]
To=<UNDERLAY_CIDR>
Table=200
Priority=<RULE_PRIORITY>
```

对于多个子网，为每个 CIDR 重复 `[Route]` 和 `[RoutingPolicyRule]` 对。两个部分中使用相同的 CIDR 和每个规则的计划优先级。不要将 `PreferredSource` 设置为节点的 InternalIP。

在维护窗口期间，逐个节点加载并检查配置：

```bash
networkctl reload
networkctl reconfigure ovn0
networkctl status ovn0
journalctl -u systemd-networkd --since '-10 min' --no-pager
```

重新配置接口可能会影响正在使用的地址或路由。请在下一节中立即执行完整验证。对于使用 NetworkManager 的节点，通过环境中现有的持久性机制实现等效的路由和规则，并验证它们是如何恢复的。

#### 方法 2：systemd 一次性服务

当网络管理器不维护此配置时，使用此方法。以下模板需要 Bash 4 或更高版本和 iproute2。以 root 身份在每个节点上创建文件。设置脚本最多等待大约 120 秒以获取 ovn0 的 IPv4 地址和到加入网关的路由，如果它们未准备好则报告失败。

创建 `/etc/ovn0-routes.conf`，并填入环境的值。每个条目使用格式 `Underlay CIDR|rule priority`。每个列出的条目必须由此解决方案独占管理。

```bash
JOIN_GW='<JOIN_GW>'
UNDERLAY_ROUTES=(
  '<UNDERLAY_CIDR>|<RULE_PRIORITY>'
  # 为其他子网添加条目，为每个使用不同的优先级。
)
```

创建 `/usr/local/bin/setup-ovn0-routes.sh`：

```bash
#!/bin/bash
set -euo pipefail
source /etc/ovn0-routes.conf

# 使用默认主表优先级 32766，使用优先级 1-32765。
# 在更改任何路由或规则之前拒绝重复条目。
declare -A seen_priorities=() seen_cidrs=()
for entry in "${UNDERLAY_ROUTES[@]}"; do
  IFS='|' read -r cidr priority <<< "$entry"
  if [[ -z "$cidr" || ! "$priority" =~ ^[1-9][0-9]{0,4}$ ]] ||
     ((priority >= 32766)); then
    echo "无效的底层路由条目：$entry" >&2; exit 1
  fi
  if [[ -n "${seen_priorities[$priority]+x}" || -n "${seen_cidrs[$cidr]+x}" ]]; then
    echo "重复的底层路由条目：$entry" >&2; exit 1
  fi
  seen_priorities[$priority]=1
  seen_cidrs[$cidr]=1
done

ready=false
for ((i=0; i<120; i++)); do
  if ip -4 addr show dev ovn0 scope global 2>/dev/null | grep -q 'inet ' &&
     ip -4 route get "$JOIN_GW" 2>/dev/null | grep -Eq 'dev ovn0( |$)'; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'ovn0 IPv4 地址或到加入网关的路由未准备好' >&2
  exit 1
fi

# 首先检查所有计划的优先级；现有条目必须与此配置匹配。
for entry in "${UNDERLAY_ROUTES[@]}"; do
  IFS='|' read -r cidr priority <<< "$entry"
  ip -4 rule show | awk -v p="$priority:" -v c="$cidr" '
    $1 == p {
      n++
      if ($2 == "from" && $3 == "all" && $4 == "to" && $5 == c &&
          $6 == "lookup" && ($7 == "200" || $7 == "ovn_table") &&
          (NF == 7 || (NF == 9 && $8 == "proto"))) good++
    }
    END { exit !(n == 0 || (n == 1 && good == 1)) }
  ' || { echo "冲突的规则优先级：$priority" >&2; exit 1; }
done

for entry in "${UNDERLAY_ROUTES[@]}"; do
  IFS='|' read -r cidr priority <<< "$entry"
  ip -4 route replace "$cidr" via "$JOIN_GW" dev ovn0 table 200
  if ! ip -4 rule show | awk -v p="$priority:" \
       '$1 == p { found=1 } END { exit !found }'; then
    ip -4 rule add priority "$priority" to "$cidr" table 200
  fi
done
echo '底层探测路由和规则已应用'
```

创建 `/usr/local/bin/cleanup-ovn0-routes.sh`。它仅删除配置文件中列出的条目；不会刷新整个路由表或不相关的策略规则。

```bash
#!/bin/bash
set -u
source /etc/ovn0-routes.conf
for entry in "${UNDERLAY_ROUTES[@]}"; do
  IFS='|' read -r cidr priority <<< "$entry"
  ip -4 rule del priority "$priority" to "$cidr" table 200 || true
  ip -4 route del "$cidr" via "$JOIN_GW" dev ovn0 table 200 || true
done
```

创建 `/etc/systemd/system/ovn0-routes.service`：

```ini
[Unit]
Description=通过 ovn0 的底层探测路由
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=150
ExecStart=/usr/local/bin/setup-ovn0-routes.sh
ExecStop=/usr/local/bin/cleanup-ovn0-routes.sh

[Install]
WantedBy=multi-user.target
```

设置文件权限并启动服务：

```bash
chown root:root /etc/ovn0-routes.conf \
  /usr/local/bin/setup-ovn0-routes.sh /usr/local/bin/cleanup-ovn0-routes.sh
chmod 600 /etc/ovn0-routes.conf
chmod 700 /usr/local/bin/setup-ovn0-routes.sh /usr/local/bin/cleanup-ovn0-routes.sh
systemctl daemon-reload
systemctl enable --now ovn0-routes.service
systemctl status ovn0-routes.service --no-pager
journalctl -u ovn0-routes.service --since '-10 min' --no-pager
```

`active (exited)` 仅表示最后一次执行成功。该服务不会持续监控或修复路由。如果接口被删除并重新创建，与 ovn0 相关的路由可能会消失。在排除配置冲突后，直接再次运行设置脚本并验证结果。不要使用 `systemctl restart` 作为只读检查：它在 ExecStart 重新应用之前运行 ExecStop 以删除规则和路由，从而在配置中留下临时间隙。

## 验证

### 1. 检查每个节点上的路由、规则和源地址

```bash
ip -4 addr show dev ovn0
ip -4 rule show
ip -4 route show table 200
ip -4 route get <POD_IP>
```

接受标准：

- 目标 CIDR 的策略规则存在，并在实际路由查找中在主表之前被选中。
- 200 表中包含相应的路由，`via <JOIN_GW> dev ovn0`，且没有错误的节点 InternalIP 首选源地址。
- `ip route get <POD_IP>` 报告 `dev ovn0`、`table 200`（或其别名 `ovn_table`），以及该节点的 `src <NODE_JOIN_IP>`。
- ovn0 具有正确的加入地址和健康的接口标志。报告 `state UNKNOWN` 的虚拟接口并不自动 DOWN；需要一起评估其 `UP`/`LOWER_UP` 标志、地址和实际流量。

如果规则存在但 200 表没有匹配的路由，查找可能会继续到后面的表。仅仅使用 `ip rule show` 并不足以确认成功。

### 2. 验证实际探测和返回路径

使用实际的探测协议测试底层 Pod 的主要网络 IP。以下 HTTP 示例未指定源地址，因此测试未绑定其源的正常连接的路由选择：

```bash
curl --noproxy '*' --connect-timeout 3 --max-time 5 \
  'http://<POD_IP>:<PROBE_PORT>/<PROBE_PATH>'
tcpdump -ni ovn0 'host <POD_IP> and port <PROBE_PORT>'
```

观察 kubelet 发送的实际探测。请求必须使用节点的加入 IP 作为源，Pod IP 作为目标，响应必须通过 ovn0 返回。使用 `curl --interface` 的测试可以帮助诊断，但不能替代对真实 kubelet 探测的验证。

```bash
kubectl -n <NAMESPACE> get pods -o wide
kubectl -n <NAMESPACE> describe pod <POD_NAME>
```

确认就绪探测和存活探测符合工作负载的要求。观察几个探测周期，检查是否没有持续的 Unhealthy 事件或由于探测失败导致的新重启。覆盖不同节点和每个目标底层子网中的代表性 Pods。重新检查现有工作负载出口和相关的覆盖连通性。仅测试覆盖 Pods 并不能替代此底层/U2O 验证。

### 3. 验证持久性

在维护窗口期间，验证在代表性节点重启后的恢复，然后单独检查其余节点。对于方法 1，检查有效的 networkd 配置和日志。对于方法 2，检查服务日志和实际路由及规则。两种方法都需要新的源地址查找和实际探测的测试。仅凭配置文件和服务状态是不够的。

## 故障排除和恢复

| 症状                                                              | 检查和操作                                                                                                                                                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200 表中有路由，但查找仍使用主表          | 检查目标 CIDR、规则优先级和任何早期匹配的规则。确认检查在节点的网络命名空间中运行。                                                                  |
| 请求使用 ovn0，但仍将节点 InternalIP 作为源 | 检查路由是否指定 `src`/`PreferredSource` 或应用程序是否绑定其源地址。通过数据包捕获进行确认。添加目的地规则不会重写绑定的源地址。 |
| 请求到达 Pod，但响应未返回                  | 检查 Pod 的实际网关、U2O 状态、响应目的地址以及 ACL/NetworkPolicy 规则。确认在启用 U2O 之前创建的 Pods 是否已按计划重新创建。                  |
| 一次性服务处于活动状态，但规则或路由缺失       | 检查日志以及 ovn0 是否被重新创建。排除其他管理工具删除配置，重新运行设置脚本，并重复完整验证。                                 |
| networkd 文件存在但未生效                    | 检查服务是否已启用，哪个 `.network` 文件首先匹配，已安装的版本是否支持这些设置，以及是否有多个管理器竞争该接口。           |

在恢复更改之前，确定之后将可用的工作负载访问路径，然后遵循变更记录。对于方法 1，恢复并加载先前的 `.network` 配置。对于方法 2，停止并禁用该服务，然后检查清理结果。仅删除此更改添加的路由和规则；不要刷新整个表。如果必须恢复 U2O 或 ACL 设置，仅撤销此更改并保留不相关的规则。禁用 U2O 可能还需要计划 Pod 的重新创建以恢复其网关。仅更新子网并不能确立恢复已完成。之后再次验证实际探测和工作负载流量。
