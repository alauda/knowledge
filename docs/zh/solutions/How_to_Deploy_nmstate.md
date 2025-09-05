---
kind:
  - How to
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.0,4.2.x
---

# nmstate 部署指南

## 1. 部署前提

### 1.1 操作系统要求

支持的操作系统：
- Red Hat
- MicroOS

### 1.2 系统依赖

节点上需要安装 NetworkManager，可以通过以下命令检查：

**检查 NetworkManager 状态**
```bash
systemctl status NetworkManager
```

预期输出：NetworkManager 服务状态为 `active (running)`

**红帽参考环境配置：**
- 操作系统: Red Hat 8.7
- NetworkManager 版本: 1.40.0-1.el8

**MicroOS 参考环境配置：**
- 操作系统版本：SUSE Linux Enterprise Micro 5.5
- NetworkManager 版本: 1.38.6

### 1.3 SELinux 配置

如果环境中存在 SELinux，需要额外配置放行策略。如果不放行，部署时 NetworkManager 到 nm_handler 的 dbus 消息会被拒绝，导致 nm_handler 一直处于 0/1 状态。目前只在 MicroOS 中遇到过，Red Hat 没有此问题。

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

## 2. 安装步骤

### 2.1 使用离线安装脚本安装

**前提条件：** 确保安装脚本在附件目录中可用。

**运行安装脚本**
```bash
attachments/nmstate/install.sh
```

### 2.2 使用开源方式安装（备选方案）

```bash
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/nmstate.io_nmstates.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/namespace.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/service_account.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role_binding.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/operator.yaml
```

### 2.3 创建 NMState 实例

等待 nmstate-operator 部署完成后执行：

**创建 NMState 实例**
```bash
cat <<EOF | kubectl create -f -
apiVersion: nmstate.io/v1
kind: NMState
metadata:
  name: nmstate
EOF
```

### 2.3 验证部署

开始触发 nmstate 的 handler 以及相关组件的部署，等待部署完成：

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

## 3. 测试场景：使用 nmstate 配置 Bond 网卡给 ovn underlay 子网使用

### 3.1 nmstatectl show 命令

进入任意的 nmstate-handler pod 内：

**显示网络信息**
```bash
# Execute nmstatectl show to see all network information of this node, including routes, network cards, policy routes, etc.
nmstatectl show
```

在 master 上查看 NodeNetworkState，也能看到同样的网卡，路由等信息：

**检查节点网络状态**
```bash
kubectl get NodeNetworkState
```

**节点网络状态输出示例**
```
NAME              AGE
192.168.132.204   2d19h
192.168.134.35    2d19h
192.168.143.191   2d19h
```

### 3.2 配置 underlay bond 网卡

**前提条件：** underlay 的物理网卡必须还没挂载在任何 ovs 上，可以通过 `ip l show {网卡} |grep ovs` 检查，如果输出为空就表示没挂载。

配置 YAML 如下：

**Bond 网卡配置**
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

**验证 Bond 网卡生成：**

**验证 Bond 接口**
```bash
ip link show bond0
```

**Bond 接口状态输出示例**
```
bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:61:e5:29 brd ff:ff:ff:ff:ff:ff
```

并且可以看到网卡被 NetworkManager 管理：

**检查 NetworkManager 连接**
```bash
nmcli connection show
```

**NetworkManager 连接状态输出示例**
```
NAME                UUID                                  TYPE      DEVICE
eth1                fd473133-8e47-42c2-bb7e-44a5bd8439bb  ethernet  eth1
bond0               256d0da6-a3c4-4752-881d-acc9d5f1b406  bond      bond0
Wired connection 2  e18df776-bfca-32df-95dc-14effbff880b  ethernet  eth2
Wired connection 3  c09edc4a-3b4b-3b1b-b376-117bcd5832fb  ethernet  eth3
Wired connection 1  70e6cf1f-3a77-3ac0-ae87-c25f7700fac9  ethernet  --
```

**注意：** 这个持久化做得不是太好，尝试手动 down 网卡，网卡不会被自动拉起来，需要重新配置 policy 或者重启 nmstate-handler 才行。

### 3.3 配置 underlay 网络

后续配置和正常配置 underlay 的步骤一样：

1. **配置 Bridge Network**: 
   - 导航路径：**平台管理** → **网络** → **Bridge Networks** → **创建 Bridge Network**
   - 配置：名称（如 `provider`），默认网卡选择 `bond0`

2. **配置 VLAN**: 
   - 导航路径：**平台管理** → **网络** → **VLANs** → **创建 VLAN**
   - 配置：名称（如 `vlan341`），VLAN ID（如 `341`），关联到上一步的 bridge network

3. **配置子网**: 
   - 导航路径：**平台管理** → **网络** → **子网** → **创建子网**
   - 配置：选择 **Underlay** 传输模式，指定网关 IP 和 VLAN

### 3.4 验证 underlay 网络

配置 deploy 在 underlay 的子网上，能够启动成功表示 pod 已经能连接到网关，underlay 网络配置成功。

## 4. 卸载命令

### 4.1 使用离线卸载脚本


**运行卸载脚本**
```bash
attachments/nmstate/uninstall.sh
```

### 4.2 使用开源方式卸载 （备选方案）

```bash
kubectl delete NMState nmstate
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/nmstate.io_nmstates.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/namespace.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/service_account.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role_binding.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/operator.yaml
```
