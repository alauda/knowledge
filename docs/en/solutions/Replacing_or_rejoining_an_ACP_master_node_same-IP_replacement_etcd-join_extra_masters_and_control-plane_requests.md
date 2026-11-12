---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Replacing or rejoining an ACP master node: same-IP replacement, etcd-join, extra masters, and control-plane requests

## Issue

- A master has to be replaced (virtual machine to physical machine, or the reverse), and the question is whether to delete it and add it again.
- After a master was removed and added back, kube-apiserver restarts and nothing listens on `127.0.0.1:2379`.
- An extra master is requested so that external clients can call `http://<new-master>:6443` and master CPU is spread out, or apiserver is to run on two workers.
- During a drill, a newly added machine is expected to become a master after a master fails.
- Master component CPU and memory requests look too small.

Related articles: "ACP control-plane limits: apiserver address change, snapshot.db scope, total master loss, x86 to ARM, and planned shutdown" covers changes that have no supported procedure.

## Root Cause

### Cause 1: Replace one master and keep the same node IP

When the new machine keeps the old master IP, the path for a business cluster is to delete that master in the platform UI and add it again, one node at a time. After each node, etcd membership and the Kube-OVN `OVN_Northbound` and `OVN_Southbound` databases must list the new master and must not list the removed one.

The Global Cluster Master Node Reset and Replacement operation guide is validated for v3.18.x, v4.0.x, v4.1.x, and v4.2.x, not for v4.3.x; on 4.3 use it as a reference only after a test cluster has been through it. Keeping the IP is a precondition in both paths. Adding a spare node now so that it can take over a master role later is not possible, because the node role is chosen when the node joins and cannot be changed afterwards.

### Cause 2: After rejoin, nothing listens on 127.0.0.1:2379 because etcd-join did not finish

The master was removed and added back. kube-apiserver is already generated and keeps exiting, and nothing listens on `127.0.0.1:2379`, so kube-apiserver cannot reach etcd. While the node was out, CoreDNS P99 latency on another master could stay high. The kubeadm etcd join phase did not run; `kubeadm join phase etcd-join --config=/etc/kubernetes/kubeadm-config.yaml --v=5` on the cleaned node completes it. This is not a WAL corruption and not a reason to delete `/var/lib/etcd`.

### Cause 3: Another master only to expose its :6443 or spread load

Adding control-plane nodes is supported, and the count should stay odd (3 or 5). Publishing `http://<one-new-node>:6443` to external clients, or running apiserver alone on former workers to spread load, is not an accepted layout and does not meet the need to spread pressure.

### Cause 4: A machine added in an expansion plan stays a compute node

In a drill that adds a device and then fails a master, the new device is expanded as a compute node, not imaged as a management node. The failed master is recovered first with the replacement procedure (Cause 1) until the cluster is back to three masters; after that a further master or worker failure still leaves the platform running. No step turns the new device into a master.

### Cause 5: apiserver and etcd requests are adjusted in their static Pod YAML

Master system-component requests are changed by editing the static Pod YAML of the components, including kube-apiserver and etcd. There is no fixed target value; use the size planned for the cluster. etcd Pods that are OOM-killed (with etcd sync then failing) are addressed by increasing the etcd component's resources.

## Resolution

### Cause 1: Replace one master and keep the same node IP

Continue only when the replacement machine uses the same IP as the master being removed, you are on 3.18, 4.0, 4.1, or 4.2 (or on 4.3 after a test cluster completed the procedure), and you replace one master at a time. Masters that also run workloads or pin log and monitoring Pods need extra planning; confirm the node is a clean master before the delete.

> **Warning:** Deleting a master in the platform UI removes a control-plane node and its etcd member. Do it only when the replacement keeps the same IP, `endpoint health` shows the other members healthy, and only one master at a time. The delete cannot be undone; the rollback is to add a machine back at that IP and wait until `member list` and both OVN cluster statuses agree.

Wait until the delete finishes before the add. After adding the new machine in the UI with the same IP, confirm membership before touching the next master:

```bash
kubectl -n kube-system exec etcd-<healthy-node> -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list -w table
```

The removed master's peer URL must be absent and the new master's present. On Kube-OVN clusters, check the OVN databases in Deployment `ovn-central` in `kube-system`:

```bash
kubectl -n kube-system exec deploy/ovn-central -c ovn-central -- ovn-nbctl cluster/status OVN_Northbound
kubectl -n kube-system exec deploy/ovn-central -c ovn-central -- ovn-sbctl cluster/status OVN_Southbound
```

Both must show the new master and not the removed one. If `-c ovn-central` fails, read the container name from `kubectl -n kube-system get deploy ovn-central -o yaml`. Then check etcd health:

```bash
kubectl -n kube-system exec etcd-<healthy-node> -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health --cluster
```

Proceed to the next master only when that command reports every member healthy and the two OVN statuses match the new set. If the replacement uses a different IP, this procedure does not apply; update the VIP forwarding policy to the new IP before clients use it, and follow the platform procedure for replacing masters with new IPs.

### Cause 2: After rejoin, nothing listens on 127.0.0.1:2379 because etcd-join did not finish

Apply only when this master was removed and is being added back, kube-apiserver is restarting, and nothing listens on `127.0.0.1:2379`. Confirm the other members are healthy first:

```bash
ss -lnt | grep 2379 || true
ls -l /etc/kubernetes/kubeadm-config.yaml
```

> **Warning:** `kubeadm join phase etcd-join` adds this node's etcd member and starts it. Run it only on the cleaned node that is missing from `member list` or has no listener on `127.0.0.1:2379` after a rejoin, in a maintenance window, with the other members healthy. If the phase errors, stop and collect `member list` from a healthy master; do not wipe `/var/lib/etcd` unless the WAL is corrupt (`walpb: crc mismatch`).

```bash
sudo kubeadm join phase etcd-join --config=/etc/kubernetes/kubeadm-config.yaml --v=5
```

Afterwards `ss -lnt | grep 2379` shows a listener and kube-apiserver stops restarting. Check membership with the `member list` command from Cause 1 before the next master change.

### Cause 3: Another master only to expose its :6443 or spread load

If a real extra master is needed for quorum, keep the control-plane count odd (3 or 5), add it through the normal master-add path with its own IP, and check membership as in Cause 1. Do not build an external-endpoint or worker-hosted apiserver layout by hand.

### Cause 4: A machine added in an expansion plan stays a compute node

Treat the new device as a worker. If a master has already failed, restore that master with Cause 1 until `member list` shows three healthy members, then continue the drill.

```bash
kubectl get nodes -l node-role.kubernetes.io/control-plane= -o wide
kubectl get nodes -o wide
```

### Cause 5: apiserver and etcd requests are adjusted in their static Pod YAML

```bash
sudo ls -l /etc/kubernetes/manifests/kube-apiserver.yaml /etc/kubernetes/manifests/etcd.yaml
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /var/tmp/kube-apiserver.yaml.before
sudo cp /etc/kubernetes/manifests/etcd.yaml /var/tmp/etcd.yaml.before
```

> **Warning:** Saving `/etc/kubernetes/manifests/kube-apiserver.yaml` or `etcd.yaml` restarts that static Pod on this node. One master at a time, in a maintenance window, and change only `resources.requests`. A request larger than the node's allocatable CPU or memory leaves the static Pod Pending. Keep the backups outside `/etc/kubernetes/manifests/`. Rollback: copy the backups back.

Edit `resources.requests`, save, and wait until the Pod is Ready before the next master:

```bash
kubectl -n kube-system get pods -l 'component in (kube-apiserver,etcd)' -o wide
```

## Diagnostic Steps

```bash
kubectl -n kube-system get pods -l component=etcd -o wide
kubectl get nodes -l node-role.kubernetes.io/control-plane= -o wide
kubectl get machine -A
```

- Same IP, one master, version 3.18 to 4.2 (or 4.3 after a test run): Cause 1.
- Spare node added ahead of time so it can later become a master: not possible; the role is fixed at join (Cause 1).
- Rejoin, kube-apiserver restarting, nothing on `127.0.0.1:2379`: Cause 2.
- Request for an extra endpoint or worker-hosted apiservers: Cause 3.
- New device during a drill, expected to become a master: Cause 4.
- apiserver or etcd `requests` too small, or etcd OOM-killed: Cause 5.

A `member list` that still contains a node you already deleted is an unfinished Cause 1 check, not a reason to wipe `/var/lib/etcd` on the surviving members.
