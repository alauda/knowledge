---
kind:
   - How To
products: 
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
# How to Deploy nmstate

## Purpose

This document explains how to deploy nmstate on Alauda Container Platform to enable network state management and configuration capabilities. nmstate is a declarative network manager API that allows you to manage network configuration in a consistent way across different Linux distributions.

## Resolution

### Prerequisites

#### Operating System Requirements

Supported operating systems:
**Red Hat Reference Environment Configuration:**
- Operating System: Red Hat 8.7
- NetworkManager Version: 1.40.0-1.el8

**MicroOS Reference Environment Configuration:**
- Operating System Version: SUSE Linux Enterprise Micro 5.5
- NetworkManager Version: 1.38.6

#### System Dependencies

NetworkManager must be installed on the nodes. You can check it with the following command:

**Check NetworkManager Status**
```bash
systemctl status NetworkManager
```

Expected output: NetworkManager service status should be `active (running)`



#### SELinux Configuration

If SELinux exists in the environment, additional permissive policies need to be configured. If not permitted, during deployment, dbus messages from NetworkManager to nm_handler will be rejected, causing nm_handler to remain in 0/1 state. This issue has only been encountered in MicroOS, not in Red Hat.

**Create SELinux Policy File**
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

**Compile and Load SELinux Module**
```bash
checkmodule -M -m -o nmstate-networkmanager-dbus.mod nmstate-networkmanager-dbus.te
semodule_package -o nmstate-networkmanager-dbus.pp -m nmstate-networkmanager-dbus.mod
sudo semodule -i nmstate-networkmanager-dbus.pp
```

### Installation Steps

#### Install Using Offline Installation Script

**Prerequisites:** Ensure the installation script is available in the attachments directory.

**Run Installation Script**
```bash
attachments/nmstate/install.sh
```

#### Install Using Open Source Method (Alternative)

```bash
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/nmstate.io_nmstates.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/namespace.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/service_account.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role_binding.yaml
kubectl apply -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/operator.yaml
```

#### Create NMState Instance

After the nmstate-operator deployment is complete, execute:

**Create NMState Instance**
```bash
cat <<EOF | kubectl create -f -
apiVersion: nmstate.io/v1
kind: NMState
metadata:
  name: nmstate
EOF
```

#### Verify Deployment

Start triggering the deployment of nmstate handler and related components, wait for deployment to complete:

**Check Deployment Status**
```bash
kubectl get pods -n nmstate
```

**Deployment Status Output Example**
```
nmstate-cert-manager-f5d78dc59-k56wd   1/1     Running   0          2d19h
nmstate-handler-728hx                  1/1     Running   0          2d20h
nmstate-handler-96k9g                  1/1     Running   0          2d19h
nmstate-handler-t7rph                  1/1     Running   0          2d19h
nmstate-metrics-744c85958c-nvkdq       2/2     Running   0          40h
nmstate-operator-56cc699fcf-9jcjc      1/1     Running   0          40h
nmstate-webhook-54d8bd69b7-4lml4       1/1     Running   0          2d19h
```

### Test Scenario: Using nmstate to Configure Bond Network Cards for OVN Underlay Subnets

#### nmstatectl show Command

Enter any nmstate-handler pod:

**Show Network Information**
```bash
# Execute nmstatectl show to see all network information of this node, including routes, network cards, policy routes, etc.
nmstatectl show
```

On the master node, you can also view NodeNetworkState to see the same network cards, routes, and other information:

**Check Node Network State**
```bash
kubectl get NodeNetworkState
```

**Node Network State Output Example**
```
NAME              AGE
node1          2d19h
node2           2d19h
node3           2d19h
```

#### Configure Underlay Bond Network Card

**Prerequisites:** The underlay physical network cards must not be mounted on any OVS. You can check with `ip l show {network_card} |grep ovs`. If the output is empty, it means it's not mounted.

Configuration YAML as follows:

**Bond Network Configuration**
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

**Verify Bond Network Card Generation:**

**Verify Bond Interface**
```bash
ip link show bond0
```

**Bond Interface Status Output Example**
```
bond0: <BROADCAST,MULTICAST,MASTER,UP,LOWER_UP> mtu 1500 qdisc noqueue state UP mode DEFAULT group default qlen 1000
    link/ether 52:54:00:61:e5:29 brd ff:ff:ff:ff:ff:ff
```

And you can see the network card is managed by NetworkManager:

**Check NetworkManager Connections**
```bash
nmcli connection show
```

**NetworkManager Connections Output Example**
```
NAME                UUID                                  TYPE      DEVICE
eth1                fd473133-8e47-42c2-bb7e-44a5bd8439bb  ethernet  eth1
bond0               256d0da6-a3c4-4752-881d-acc9d5f1b406  bond      bond0
Wired connection 2  e18df776-bfca-32df-95dc-14effbff880b  ethernet  eth2
Wired connection 3  c09edc4a-3b4b-3b1b-b376-117bcd5832fb  ethernet  eth3
Wired connection 1  70e6cf1f-3a77-3ac0-ae87-c25f7700fac9  ethernet  --
```

**Note:** The persistence is not very good. If you manually bring down the network card, it won't automatically come back up. You need to reconfigure the policy or restart nmstate-handler.

#### Configure Underlay Network

The subsequent configuration is the same as normal underlay configuration steps:

1. **Configure Bridge Network**: 
   - Navigation path: **Platform Management** → **Networking** → **Bridge Networks** → **Create Bridge Network**
   - Configuration: Name (e.g., `provider`), default network card select `bond0`

2. **Configure VLAN**: 
   - Navigation path: **Platform Management** → **Networking** → **VLANs** → **Create VLAN**
   - Configuration: Name (e.g., `vlan341`), VLAN ID (e.g., `341`), associate with the bridge network from the previous step

3. **Configure Subnet**: 
   - Navigation path: **Platform Management** → **Networking** → **Subnets** → **Create Subnet**
   - Configuration: Select **Underlay** transmission mode, specify gateway IP and VLAN

#### Verify Underlay Network

Configure deploy on the underlay subnet. If it starts successfully, it means the pod can connect to the gateway and the underlay network configuration is successful.

### Uninstall Commands

#### Using Offline Uninstallation Script

**Run Uninstallation Script**
```bash
attachments/nmstate/uninstall.sh
```

#### Using Open Source Method (Alternative)

```bash
kubectl delete NMState nmstate
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/nmstate.io_nmstates.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/namespace.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/service_account.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/role_binding.yaml
kubectl delete -f https://github.com/nmstate/kubernetes-nmstate/releases/download/v0.84.0/operator.yaml
```
