---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# kube-ovn-pinger CrashLoopBackOff context deadline exceeded on bonded NICs due to Geneve TX checksum offload on ACP

## Issue

Right after a workload cluster is created on physical machines whose network uses a bond, every `kube-ovn-pinger` pod in `kube-system` is `0/1` `CrashLoopBackOff`. Other pods that talk to the API server, such as `kube-prometheus-exporter-kube-state` and `vm-operator` in `cpaas-system`, can crash-loop as well.

The `kube-ovn-pinger` log shows that the pod cannot reach the API server through the `kubernetes` Service ClusterIP:

```text
config.go:162] failed to get self pod kube-system/kube-ovn-pinger-<pod>: Get "https://<cluster-ip>:443/api/v1/namespaces/kube-system/pods/kube-ovn-pinger-<pod>?timeout=15s": context deadline exceeded (Client.Timeout exceeded while awaiting headers)
"failed to parse config" err=... context deadline exceeded
```

`<cluster-ip>` is the ClusterIP of the `default/kubernetes` Service (`443/TCP`). The nodes themselves can reach each other.

## Root Cause

Kube-OVN carries pod traffic between nodes in Geneve tunnels (UDP `6081`). With TX checksum offload enabled, the kernel leaves the checksum of the encapsulated packets for the NIC to fill in. On some physical NICs, the checksum computed after offload for Geneve-encapsulated packets is wrong, so the receiving side drops the packets.

Pod-to-API-server traffic through the `kubernetes` Service crosses that path, so it times out, and `kube-ovn-pinger` exits because it cannot load its own pod. Host-to-host traffic is not encapsulated and keeps working, which is why the nodes look healthy.

A bond is a virtual interface: the offload is actually performed by its slave (member) NICs, so the setting has to be changed on every slave NIC, not only on the bond.

The permanent fix is a NIC firmware update from the NIC vendor. Disabling TX offload is the workaround.

## Resolution

1. On each affected node, list the slave NICs of the bond:

   ```bash
   cat /proc/net/bonding/<bond-name> | grep 'Slave Interface'
   ```

2. Disable TX offload on every slave NIC.

   > **Warning:** Changing NIC offload settings can briefly disturb traffic on that NIC and moves checksum work to the CPU, which increases CPU usage under heavy traffic. Apply it only when the checksum-offload signature in the Diagnostic Steps is confirmed, and on production clusters apply it one node at a time. To roll back, run `ethtool -K <nic> tx on` and remove the persistent setting from step 3.

   ```bash
   ethtool -K <nic> tx off
   ethtool -k <nic> | grep -E 'tx-checksumming|tx-checksum-ip-generic'
   ```

   Expected: `tx-checksumming: off`.

3. Make the setting persistent across reboots. On systems that use `network-scripts`, add the option to the configuration file of each slave NIC:

   ```bash
   echo 'ETHTOOL_OPTS="-K <nic> tx off"' >> /etc/sysconfig/network-scripts/ifcfg-<nic>
   ```

   On systems managed by NetworkManager without `network-scripts`, use the equivalent persistent setting of that tool.

4. Delete the crash-looping pods so they restart immediately instead of waiting for the back-off:

   ```bash
   kubectl -n kube-system delete pod -l app=kube-ovn-pinger
   ```

   Confirm they become `1/1 Running`.

5. Contact the NIC vendor for a firmware update that fixes Geneve checksum offload. After the firmware is updated, TX offload can be re-enabled and verified.

## Diagnostic Steps

1. Check whether the failure is limited to pod-to-Service traffic. From the node, the API server answers; from inside the pod network, the ClusterIP times out:

   ```bash
   kubectl get svc -n default kubernetes
   curl -k -m 5 https://<master-ip>:6443/healthz            # on the node: ok
   ```

   If the node cannot reach `<master-ip>:6443` either, the problem is in the host network (firewall, routing), not in the overlay.

2. Check the offload state of the bond's slave NICs. `tx-checksumming: on` on a slave NIC of the encapsulation path matches this issue; `off [fixed]` rules it out:

   ```bash
   ethtool -k <nic> | grep -E 'tx-checksumming|tx-checksum-ip-generic'
   ```

3. Capture Geneve traffic on the receiving node. Packets arriving with bad checksums, or not arriving at all while the sender transmits, point at the offload:

   ```bash
   tcpdump -i <nic> -nn -vv udp port 6081
   ```

   A capture taken on the sending node shows bad checksums whenever offload is on, because `tcpdump` sees the packet before the NIC fills in the checksum. Only a capture on the receiving side is evidence.

4. If disabling TX offload on all slave NICs makes `kube-ovn-pinger` recover, the cause is confirmed.
