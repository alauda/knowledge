---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Restarting OVN/OVS containers does not reload host NIC configuration changes on ACP

## Issue

On Alauda Container Platform, the OVS and OVN userspace runs inside the `ovs-ovn` DaemonSet in the `kube-system` namespace. Each node hosts one pod (label `app=ovs`) whose single `openvswitch` container (image `registry.alauda.cn:60080/acp/kube-ovn:v1.15.10`) launches `ovsdb-server`, `ovs-vswitchd`, and `ovn-controller` from the `/kube-ovn/start-ovs.sh` entrypoint; the pod runs with `hostNetwork=true` and `hostPID=true` so that it shares the host network namespace. The host's network manager varies by node OS; on the reference cluster all four nodes run Ubuntu 22.04.1 LTS with kernel `5.15.0-56-generic`, and host NIC, bond, and VLAN configuration is owned by the node OS network stack (on Ubuntu the default is `systemd-networkd` driven by `netplan`). The `ovs-ovn` pod attaches to those interfaces only after the host has brought them up.

After a host-level network change is applied on a node (for example editing the bond, a VLAN sub-interface, or an MTU), restarting the `ovs-ovn` pod or its constituent processes does not propagate the new configuration onto the live host interfaces — the dataplane container does not re-read or re-apply host-level interface state on restart, so host networking changes do not propagate via CNI restart.

## Root Cause

The OVS dataplane and the OVN southbound controller that ship inside the `ovs-ovn` pod do not author or manage host-level NIC, bond, or VLAN configuration; they consume host interfaces that the node OS network manager has already created. Because the host network owner is a separate subsystem from the CNI dataplane, restarting only the CNI userspace — by rolling the `ovs-ovn` DaemonSet or deleting the pod — leaves the host interface state untouched and re-attaches to whatever the node OS currently exposes. The same separation-of-concerns holds on any node-OS family, only the host-side configuration vehicle changes; on the reference cluster the host owner is `systemd-networkd` plus `netplan` (Ubuntu 22.04.1 LTS).

## Resolution

Apply host networking changes through the node OS network manager on each affected node, not through the CNI pod. On the reference Ubuntu 22.04.1 LTS nodes this means editing the relevant file under `/etc/netplan/` and reloading via `netplan apply`; the host owner re-creates or reconfigures the interface, and the `ovs-ovn` pod's `openvswitch` container then sees the updated interface state through the shared host network namespace.

For substantial NIC, bond, or VLAN reshapes, plan for a node reboot — or otherwise restart the host network stack — as the standard way to bring the new host networking config into effect. A reboot is expected to fully reinitialise the host network stack and, on ACP, also recreate the `ovs-ovn` pod so that the CNI re-attaches to the freshly initialised host interfaces.

The container-level restart action on ACP (rolling the `ovs-ovn` DaemonSet or deleting its pod) is still a valid recovery step for issues internal to the OVS/OVN userspace, but it is not a substitute for reapplying host network state, because the dataplane container does not own that state. The standard restart shape is:

```bash
kubectl -n kube-system rollout restart daemonset/ovs-ovn
kubectl -n kube-system rollout status daemonset/ovs-ovn
```

## Diagnostic Steps

Confirm the OVS/OVN delivery vehicle and image on the cluster. The `ovs-ovn` DaemonSet lives in `kube-system`, runs one pod per node with `hostNetwork=true` and `hostPID=true`, and packages `ovsdb-server`, `ovs-vswitchd`, and `ovn-controller` inside the single `openvswitch` container:

```bash
kubectl -n kube-system get daemonset ovs-ovn
kubectl -n kube-system get pods -l app=ovs -o wide
kubectl -n kube-system get daemonset ovs-ovn \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

Identify the node OS and the active host-network manager on each node. The CNI dataplane attaches to interfaces that this subsystem owns, so any change must be made through it:

```bash
kubectl get nodes -o wide
# On a target node (Ubuntu 22.04.1 LTS, kernel 5.15.0-56-generic on the reference cluster):
#   ls /etc/netplan/
#   systemctl status systemd-networkd
```

After applying a host network change, verify that the new state is visible on the host interface and that the `ovs-ovn` pod observes it through the shared host network namespace. If the host interface still shows the old configuration, the change was not committed at the host level and a pod restart will not fix it:

```bash
# Inspect host-side interface state:
ip -d link show <iface>
ip addr show <iface>

# Inspect what OVS currently sees from inside the ovs-ovn pod:
kubectl -n kube-system exec ds/ovs-ovn -c openvswitch -- ovs-vsctl show
```

If the change spans bonds, VLAN parents, or MTU on shared uplinks, schedule a node reboot to fully reinitialise the host network stack; the `ovs-ovn` pod is recreated by the DaemonSet controller after the node returns and re-attaches to the freshly initialised interfaces.
