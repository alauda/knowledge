---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x
  - 4.x
---

# Node NotReady caused by network, storage or host-level faults on ACP

## Issue

`kubectl get nodes` shows one or more nodes `NotReady`, and the reports look like this:

- "The business cluster went down again", "a large number of nodes are not ready", "the cluster status is Abnormal".
- Applications or middleware (for example Redis) restart and fail over on their own, with nobody deploying anything.
- A node "drops out" for about 30 seconds and recovers by itself, more and more often.
- A node shows abnormal on the platform and cannot be reached over SSH.
- Pods on one node stay `Terminating`, new Pods cannot be scheduled there, and the event says the node has a taint.
- After a host reboot, one Pod stays `0/1` with repeated `SandboxChanged` and `FailedKillPod ... failed to find plugin "galaxy-veth" in path [/opt/cni/bin]` events.
- A workload cluster shows `Abnormal`, and its KubeadmControlPlane has `MachinesReady` `Unknown` with `Kubelet stopped posting node status.`
- "An application Pod keeps restarting", but the Pod is really being recreated on other nodes.

A node is `NotReady` when its kubelet stops posting status to kube-apiserver within the node monitor grace period. The node then carries the `node.kubernetes.io/unreachable` or `node.kubernetes.io/not-ready` taint, so its Pods are evicted and recreated elsewhere, which looks like an application restart. This article covers cases where the kubelet itself is fine but the network, the storage under the host, or the host as a whole stops it from reporting. A kubelet or container runtime that is broken on the node is a different problem (see *Node NotReady on ACP with kubelet "PLEG is not healthy"* and *Diagnosing a node that reports NotReady on Alauda Container Platform*). Many Pods `Unknown` after an IaaS upgrade renamed the node NICs while the IPs stayed the same, with `kube-ovn-cni` logging `iface <old-nic> has no valid IP address`, is a Kube-OVN interface-binding problem and is not covered here; restarting the OVN/OVS containers does not pick up host NIC changes (see *Restarting OVN/OVS containers does not reload host NIC configuration changes on ACP*).

## Root Cause

### Cause 1: Network instability between the nodes and the API server VIP

The kubelet log around the NotReady window contains node-status update failures and connection timeouts to `https://<vip>:6443`. **Several nodes go NotReady at the same moment**, while kube-apiserver has not restarted and the masters have low load. Typical kubelet lines:

```text
"Error updating node status, will retry" err="error getting node \"<node>\": ... net/http: request canceled (Client.Timeout exceeded while awaiting headers)"
"Unable to update node status" err="update node status exceeds retry count"
"Failed to update lease" ... kube-node-lease ... net/http: request canceled
"failed to update lease using latest lease, fallback to ensure lease" err="failed 5 attempts to update lease"
http2: client connection lost
read tcp ...: use of closed network connection
"Failed to make webhook authenticator request" / "Unable to authenticate the request due to an error"
"Error processing volume" ... failed to fetch PVC from API server
dial tcp <vip>:6443: connect: no route to host
```

Ten nodes can go `NotReady` together, with dozens of health-check, restart, and volume-mount failures in the same minutes; Redis instances can switch master and replica each time their node goes `NotReady`. Even short packet loss between the nodes and `VIP:6443` is enough to make status reports fail; the nodes need continuous, stable reachability to the VIP. Evidence is packet loss between the masters, or a site-wide network outage; the nodes recover by themselves once the network recovers.

A **security device** on the path causes the same signature. Only some nodes log large numbers of failed connections to the API server and go `NotReady`; their Pods show `TaintManagerEviction: Marking for deletion Pod <namespace>/<pod>` and are recreated elsewhere. A firewall exception does not help, a port check on the VIP side shows nothing, and the apiserver logs have no errors. A packet capture on an affected node shows repeated `[TCP Retransmission]` `[PSH, ACK]` packets from the node to `<vip>:6443` with no response: a security device is intercepting that traffic.

### Cause 2: The node NIC intermittently goes down

The node goes NotReady for about 30 seconds and recovers on its own. Node monitoring shows **gaps in the metrics** over the same windows, while the monitoring components have not restarted. `dmesg -T` shows the interface (for example `eth0`) not ready, or the link down, at the matching times. Losing link cuts both the kubelet heartbeat and metric collection. Why the NIC loses readiness is outside Kubernetes: the host network configuration, the virtual switch, or the physical link.

### Cause 3: Underlying storage stalls block the host

During the incident window the IaaS or storage team reports a storage anomaly, host load rises sharply, `iowait` is high, and the kubelet **stops writing logs** before the node goes NotReady. The cluster status can show `Abnormal`; more than 30 nodes can go NotReady together. When the disks behind the hosts block on I/O, the kubelet cannot keep its heartbeat. A typical cascade:

1. Cluster memory overcommit above 200% and actual node memory use above 90%, with high Pod density.
2. Heavy page-cache reclaim, which turns into large amounts of disk I/O.
3. The I/O reaches the per-node storage QoS limit (for example 30 MB/s) and exhausts the shared storage bandwidth.
4. I/O blocks, kubelet heartbeats time out, and the nodes become `NotReady`.
5. Eviction and rescheduling load the neighbouring nodes, and the failure spreads.

On a workload cluster managed from the global cluster, the same chain shows in the KubeadmControlPlane status: `RollingOut`, `Remediating`, `ScalingDown`, and `ScalingUp` are `False`, but:

```text
type: MachinesReady
status: Unknown
reason: ReadyUnknown
message: ... NodeHealthy: Node.AllConditions: Kubelet stopped posting node status. ... Control plane components: Node <node> is unreachable
```

If `dmesg` shows `INFO: task ... blocked for more than 120 seconds` or `nfs: server ... not responding` with many `D`-state processes, see *Node NotReady with high load average and D-state processes on ACP*. If `/var/lib/containerd` returns `Input/output error` and kube-apiserver refuses connections, the host disk itself has failed.

### Cause 4: The host itself is hung or unreachable

The node is `NotReady` and **SSH to it fails or hangs**. The platform web CLI cannot reach it either; only the IaaS console shows the VM or server. With no shell on the node, the cause cannot be determined from Kubernetes. The hosts return to normal after a reboot at the infrastructure level.

### Cause 5: Pods stuck in Terminating on a NotReady or just-restarted node

Pods that ran on the NotReady node stay `Terminating` and cannot be deleted normally, and replacements for a StatefulSet or a node-pinned workload do not start. Pod deletion is completed by the kubelet on the Pod's node; if that kubelet is down or cannot reach the API server, it can neither stop the containers nor report back, so the Pod object is never finalised.

A variant appears after a host restart: the old Pod hangs while terminating because the CNI plugin binary is not found during teardown. The Pod shows `0/1` with 0 restarts while other Pods on the node run, and its events repeat:

```text
SandboxChanged: Pod sandbox changed, it will be killed and re-created.
FailedKillPod: error killing pod: failed to "KillPodSandbox" for "<pod-uid>" with KillPodSandboxError: "rpc error: code = Unknown desc = networkPlugin cni failed to teardown pod \"<pod>_<namespace>\" network: failed to find plugin \"galaxy-veth\" in path [/opt/cni/bin]"
```

## Resolution

### Cause 1: Network instability between the nodes and the API server VIP

1. Confirm the kubelet errors are connectivity errors and that kube-apiserver and the masters are healthy (Diagnostic Steps 2 to 4).
2. Hand the path between the nodes and `VIP:6443` (switches, load balancer or keepalived VIP, firewalls) to the network team, with the timestamps of the NotReady windows and the packet-loss evidence.
3. If a packet capture shows the node's packets to `<vip>:6443` retransmitted with no answer while the VIP side is healthy, have the network and security teams check security devices (IPS, firewalls, anti-intrusion appliances) on the path. Adding the affected nodes to the security device's allow list stops the recurrences.
4. No change on the nodes is needed; they return to `Ready` once the network is stable. Then check that evicted workloads have been recreated:

```bash
kubectl get nodes
kubectl get pods -A -o wide | grep -viE 'Running|Completed'
```

### Cause 2: The node NIC intermittently goes down

Have the host or IaaS owner check the interface configuration and the virtual or physical link for the interface named in `dmesg`. Kubernetes needs no action; the node recovers each time the link returns, and the recurrences stop once the link is stable.

### Cause 3: Underlying storage stalls block the host

1. Reduce cluster load: scale down or stop non-critical workloads, and lower ingress traffic into the cluster.
2. Have the storage team restore the storage queue and free storage bandwidth.
3. Reboot the nodes that do not return to `Ready` by themselves once I/O recovers.

> **Warning:** Rebooting a node kills every container on it, and single-replica services on that node are unavailable until it returns. Precondition: storage I/O has recovered, and the node has stayed `NotReady` after that or its shell is unresponsive. Reboot one node at a time, starting with nodes that hold no unique stateful replicas. A reboot cannot be rolled back; an unclean reboot may need a filesystem check on boot.

```bash
# from the IaaS console, or if the shell still responds:
systemctl reboot
```

4. Afterwards, remove the memory pressure that started the reclaim storm: lower the overcommit, or add memory or nodes. The root cause of the storage anomaly itself belongs to the infrastructure team.

### Cause 4: The host itself is hung or unreachable

Before rebooting, take a screenshot of the IaaS VM console; kernel panic, hung-task, or OOM messages are often visible there. Then reboot from the infrastructure side.

> **Warning:** A hard reset or power cycle is an unclean shutdown: Pods on the host restart, and in-flight application writes can be lost. Precondition: the node is confirmed unreachable over SSH and from the console, and the infrastructure owner has checked the host. Irreversible.

After it boots, collect the logs of the previous boot so the hang can be analysed (`journalctl -b -1` needs a persistent journal; otherwise read `/var/log/messages`):

```bash
journalctl -b -1 -p warning --no-pager | tail -n 300
journalctl -b -1 -u kubelet --no-pager | tail -n 200
```

### Cause 5: Pods stuck in Terminating on a NotReady or just-restarted node

- If the node will come back soon (network or IaaS recovery is in progress), wait. When the kubelet reconnects, it completes the pending deletions itself, and the taint clears once the node is `Ready`.
- If the node stays down, or the Pod is stuck after a host restart and nothing else is wrong, force-delete the stuck Pod so its controller can create a new one.

> **Warning:** A force delete only removes the Pod object from the API server; it does not confirm that the containers are stopped. Precondition: the node is confirmed powered off or isolated, or (after a restart) the old containers are confirmed gone with `crictl ps -a` or `docker ps -a` on the node. Otherwise, for a StatefulSet or any workload writing to shared storage, two instances can run at once and corrupt data. A force delete cannot be undone, but the controller recreates the Pod.

```bash
kubectl get pods -A -o wide --field-selector spec.nodeName=<node-name> | grep Terminating
kubectl delete pod <pod-name> -n <namespace> --grace-period=0 --force
```

For the `failed to find plugin "galaxy-veth" in path [/opt/cni/bin]` case after a reboot, force-deleting the Pod with the command above lets a new instance start. Use it only when that event repeats for the old Pod and the node is otherwise `Ready`. Compare `/opt/cni/bin` with a healthy node, in case other Pods on the node hit the same teardown error:

```bash
kubectl get events -n <namespace> --field-selector involvedObject.name=<pod-name> | grep -E 'SandboxChanged|FailedKillPod'
ls /opt/cni/bin/
```

## Diagnostic Steps

1. If the cluster status is abnormal and the CNI is suspected, first test the API VIP on `6443` from a global node and from a node of the affected cluster, and compare with a master IP. A VIP that does not answer while a master IP does is a network-side VIP forwarding fault; nothing inside the cluster needs to change.

```bash
nc -vz -w 3 <vip> 6443
curl -k --max-time 5 https://<vip>:6443/healthz || true
curl -k --max-time 5 https://<master-ip>:6443/healthz || true
```

2. Find out how many nodes went NotReady, and when. Many nodes at the same moment point to Cause 1 or 3; a single node to Cause 2 or 4.

```bash
kubectl get nodes -o wide
kubectl get events -A --field-selector reason=NodeNotReady --sort-by=.lastTimestamp
kubectl describe node <node-name> | sed -n '/Conditions:/,/Addresses:/p'
kubectl describe node <node-name> | grep -A3 Taints
```

3. On an affected node, read the kubelet log for the window. Timeouts to `:6443` and failed status or lease updates are Cause 1. A kubelet that **stops logging altogether** points to I/O blocking (Cause 3) or a hung host (Cause 4).

```bash
journalctl -u kubelet --since "<YYYY-MM-DD HH:MM>" --until "<YYYY-MM-DD HH:MM>" --no-pager \
  | grep -iE 'node status|lease|6443|timeout|deadline' | tail -n 50
```

For a workload cluster shown `Abnormal`, read the KubeadmControlPlane conditions from the global cluster; `MachinesReady` `Unknown` with `Kubelet stopped posting node status` names the control-plane node to look at:

```bash
kubectl get kubeadmcontrolplane -A
kubectl get kubeadmcontrolplane -n <namespace> <kcp-name> -o yaml | grep -B2 -A8 'type: MachinesReady'
```

4. Rule out the API server: the kube-apiserver Pods have not restarted, and the masters are not overloaded.

```bash
kubectl -n kube-system get pods -l component=kube-apiserver -o wide
kubectl top nodes
```

5. Measure the path to the VIP from the affected node and keep it running until the next occurrence. A `000` code or multi-second times that line up with the NotReady windows are Cause 1.

```bash
ping -i 0.2 -c 300 <vip>
while true; do
  echo "$(date '+%F %T') $(curl -sk -o /dev/null -w '%{http_code} %{time_total}s' --max-time 5 https://<vip>:6443/healthz)"
  sleep 1
done
```

If the VIP answers from other hosts but the affected node still times out, capture its traffic during a failure; retransmissions with no reply point to a device on the path:

```bash
tcpdump -i any -nn host <vip> and port 6443 -c 200 -w /tmp/vip-6443.pcap
tcpdump -nn -r /tmp/vip-6443.pcap | head -n 50
kubectl get events -A --sort-by=.lastTimestamp | grep -E 'TaintManagerEviction|NodeNotReady' | tail -n 20
```

6. Check the kernel log for NIC events at the NotReady times (Cause 2):

```bash
dmesg -T | grep -iE 'link is not ready|link is down|link is up|NIC Link'
```

7. Check for I/O blocking (Cause 3): high `wa` in `top`, high `await` and `%util` in `iostat`, and hung-task messages:

```bash
top -b -n 1 | head -n 5
iostat -x 1 5
dmesg -T | grep -iE 'blocked for more than|hung_task|I/O error'
```
