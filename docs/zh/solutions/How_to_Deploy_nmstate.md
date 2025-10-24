---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB250900006
sourceSHA: 624e664936baac664db395b551e49ca9271ca7ad288752f87f155608559e3ce6
---

# 如何部署 nmstate

## 目的

本文档解释了如何在 Alauda 容器平台上部署 nmstate，以启用网络状态管理和配置功能。nmstate 是一个声明式网络管理 API，允许您在不同的 Linux 发行版中以一致的方式管理网络配置。

## 解决方案

### 先决条件

#### 操作系统要求

支持的操作系统：

**Red Hat 参考环境配置：**

- 操作系统：Red Hat 8.7
- NetworkManager 版本：1.40.0-1.el8

**MicroOS 参考环境配置：**

- 操作系统版本：SUSE Linux Enterprise Micro 5.5
- NetworkManager 版本：1.38.6

#### 系统依赖

节点上必须安装 NetworkManager。您可以使用以下命令检查：

**检查 NetworkManager 状态**

```bash
systemctl status NetworkManager
```

预期输出：NetworkManager 服务状态应为 `active (running)`

#### SELinux 配置

如果环境中存在 SELinux，则需要配置额外的宽松策略。如果未被允许，在部署期间，来自 NetworkManager 到 nm_handler 的 dbus 消息将被拒绝，导致 nm_handler 保持在 0/1 状态。此问题仅在 MicroOS 中遇到，而在 Red Hat 中未遇到。

**创建 SELinux 策略文件**

```bash
sudo tee nmstate-networkmanager-dbus.te << 'EOF'
module nmstate-networkmanager-dbus 1.0;

require {
    type NetworkManager_t;
    type container_runtime_t;
    class dbus send_msg;
}

#============= NetworkManager_t ==============
allow NetworkManager_t container_runtime_t:dbus send_msg;
EOF
```

**编译并加载 SELinux 模块**

```bash
checkmodule -M -m -o nmstate-networkmanager-dbus.mod nmstate-networkmanager-dbus.te
semodule_package -o nmstate-networkmanager-dbus.pp -m nmstate-networkmanager-dbus.mod
sudo semodule -i nmstate-networkmanager-dbus.pp
```

### 安装步骤

#### 使用离线安装方法安装

**先决条件：** 访问具有市场功能的 Alauda 容器平台。

**安装步骤：**

1. **从 AC 市场下载：**
   - 导航到 **管理员** → **市场** → **应用程序**
   - 搜索 "Alauda Build of Kubernetes NMState Operator"
   - 下载安装包

2. **部署到目标环境：**

   - 使用 violet push 将下载的包部署到目标环境

   **violet push 命令示例：**

   ```bash
   violet push kubernetes-nmstate-operator.alpha.amd64.v4.1.4.tgz \
     --platform-address "$PLATFORM_URL" \
     --platform-username "$USERNAME" \
     --platform-password "$PASSWORD" \
     --clusters $CLUSTER_NAME
   ```

3. **通过 OperatorHub 安装：**
   - 导航到 **管理员** → **市场** → **OperatorHub**
   - 搜索 "kubernetes Nmstate" 组件
   - 点击 **安装** 部署操作员

#### 使用开源方法安装（替代）

```bash
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/nmstate.io_nmstates.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/namespace.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/service_account.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role_binding.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/operator.yaml
```

#### 创建 NMState 实例

在 nmstate-operator 部署完成后，执行：

**创建 NMState 实例**

```bash
cat <<EOF | kubectl create -f -
apiVersion: nmstate.io/v1
kind: NMState
metadata:
  name: nmstate
EOF
```

#### 验证部署

开始触发 nmstate 处理程序和相关组件的部署，等待部署完成：

**检查部署状态**

```bash
kubectl get pods -n nmstate
```

**部署状态输出示例**

```
nmstate-cert-manager-f5d78dc59-k56wd   1/1     Running   0          2d19h
nmstate-handler-728hx                  1/1     Running   0          2d20h
nmstate-handler-96k9g                  1/1     Running   0          2d19h
nmstate-handler-t7rph                  1/1     Running   0          2d19h
nmstate-metrics-744c85958c-nvkdq       2/2     Running   0          40h
nmstate-operator-56cc699fcf-9jcjc      1/1     Running   0          40h
nmstate-webhook-54d8bd69b7-4lml4       1/1     Running   0          2d19h
```

### 测试场景：使用 nmstate 配置 OVN 下层子网的 Bond 网络卡

#### nmstatectl show 命令

进入任意 nmstate-handler pod：

**显示网络信息**

```bash
# 执行 nmstatectl show 查看此节点的所有网络信息，包括路由、网络卡、策略路由等。
nmstatectl show
```

在主节点上，您还可以查看 NodeNetworkState，以查看相同的网络卡、路由和其他信息：

**检查节点网络状态**

```bash
kubectl get NodeNetworkState
```

**节点网络状态输出示例**

```
NAME              AGE
node1          2d19h
node2           2d19h
node3           2d19h
```

#### 配置下层 Bond 网络卡

**先决条件：** 下层物理网络卡不得挂载在任何 OVS 上。您可以使用 `ip l show {network_card} |grep ovs` 检查。如果输出为空，则表示未挂载。

配置 YAML 如下：

**Bond 网络配置**

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: configure-bond-underlay0-complete
  namespace: nmstate
spec:
  desiredState:
    interfaces:
      - name: eth2
        type: ethernet
        state: up
      - name: eth3
        type: ethernet
        state: up
      - name: bond0
        type: bond
        state: up
        link-aggregation:
          mode: active-backup
          options:
            miimon: 100
          port:
            - eth2
            - eth3
        ipv4:
          enabled: false
        ipv6:
          enabled: false
```

**验证 Bond 网络卡生成：**

**验证 Bond 接口**

```bash
ip link show bond0
```

**Bond 接口状态输出示例**

```
bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000
    link/ether xx:xx:xx:xx:xx:xx brd ff:ff:ff:ff:ff:ff
```

您可以看到网络卡由 NetworkManager 管理：

**检查 NetworkManager 连接**

```bash
nmcli connection show
```

**NetworkManager 连接输出示例**

```
NAME                UUID                                  TYPE      DEVICE
bond0               xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  bond      bond0
Wired connection 2  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  ethernet  eth2
Wired connection 3  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  ethernet  eth3
```

**注意：** 持久性不是很好。如果您手动关闭网络卡，它不会自动恢复。您需要重新配置策略或重启 nmstate-handler。

#### 配置下层网络

后续配置与正常的下层配置步骤相同：

1. **配置桥接网络**：
   - 导航路径：**平台管理** → **网络** → **桥接网络** → **创建桥接网络**
   - 配置：名称（例如，`provider`），默认网络卡选择 `bond0`

2. **配置 VLAN**：
   - 导航路径：**平台管理** → **网络** → **VLANs** → **创建 VLAN**
   - 配置：名称（例如，`vlan341`），VLAN ID（例如，`341`），与上一步的桥接网络关联

3. **配置子网**：
   - 导航路径：**平台管理** → **网络** → **子网** → **创建子网**
   - 配置：选择 **下层** 传输模式，指定网关 IP 和 VLAN

#### 验证下层网络

在下层子网上配置部署。如果成功启动，则表示 pod 可以连接到网关，并且下层网络配置成功。

### 卸载命令

#### 使用离线卸载方法

**卸载步骤：**

1. **通过 OperatorHub 移除：**
   - 导航到 **管理员** → **市场** → **OperatorHub**
   - 找到已安装的 "kubernetes Nmstate" 组件
   - 点击 **卸载** 移除操作员

2. **通过 AC 市场清理：**
   - 导航到 **管理员** → **市场** → **应用程序**
   - 如有需要，移除 "Alauda Build of Kubernetes NMState Operator"

3. **手动清理：**
   - 删除 nmstate 实例：
     ```bash
     kubectl delete nmstates.nmstate.io nmstate
     ```

   - 手动清理 CRD：
     ```bash
     kubectl delete crd nmstates.nmstate.io
     kubectl delete crd nodenetworkconfigurationenactments.nmstate.io
     kubectl delete crd nodenetworkconfigurationpolicies.nmstate.io
     kubectl delete crd nodenetworkstates.nmstate.io
     ```

#### 使用开源方法卸载（替代）

```bash
kubectl delete NMState nmstate
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/nmstate.io_nmstates.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/namespace.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/service_account.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role_binding.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/operator.yaml
```

## 相关信息

- [kubernetes-nmstate GitHub 仓库](https://github.com/nmstate/kubernetes-nmstate) - 通过 Kubernetes API 驱动的声明式节点网络配置
