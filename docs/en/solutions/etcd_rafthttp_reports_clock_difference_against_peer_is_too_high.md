---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500018
---

# etcd rafthttp reports clock difference against peer is too high
## Issue

The etcd pods on the control-plane nodes log repeated warnings of the form:

```text
W | rafthttp: the clock difference against peer xxxxxxxxxxxxxxxx is too high [4m18.466926704s > 1s]
W | rafthttp: the clock difference against peer xxxxxxxxxxxxxxxx is too high [4m18.463381838s > 1s]
```

In severe cases the etcd liveness probe starts to fail and one or more etcd members restart, which in turn can trigger API-server unavailability and cascading alerts on the cluster.

## Root Cause

`rafthttp` embeds a timestamp in every heartbeat exchanged between etcd peers. On each frame the receiver compares the embedded timestamp with its own local clock; if the absolute difference exceeds one second the warning above is emitted. A difference of several minutes, as in the log sample, means the system clocks on two or more control-plane nodes have drifted far apart.

Because etcd treats the heartbeat as authoritative evidence that a peer is alive, severe skew interacts badly with the member health check: a peer whose clock is many minutes ahead may appear to send "future" heartbeats that are discarded, and a peer that is far behind can miss the heartbeat window entirely. The underlying reason is almost always the same — NTP is not functioning correctly on at least one control-plane node.

## Resolution

Bring the control-plane nodes back into NTP sync. Once the clocks converge, the `rafthttp` warnings stop within a couple of heartbeat intervals and etcd recovers on its own; no etcd restart is required.

1. Identify which nodes are skewed relative to the others. Run a timedatectl check across every control-plane node. ACP's cluster PSA rejects `chroot /host`; use `--profile=sysadmin` and an image that ships `timedatectl`/`chronyc`:

   ```bash
   for NODE in $(kubectl get nodes -l node-role.kubernetes.io/control-plane= -o name); do
     echo "-------- $NODE --------"
     kubectl debug -q "$NODE" --image=<image-with-systemd> --profile=sysadmin -- \
       bash -c "hostname; timedatectl"
     echo
   done
   ```

   Pay attention to the `System clock synchronized:` line. A `no` means the kernel is not satisfied that chrony (or whatever NTP implementation is in use on the node OS) is keeping the clock aligned.

2. On each affected node, confirm chrony is running and has at least one reachable upstream source:

   ```bash
   kubectl debug node/<name> --image=<image-with-chrony> --profile=sysadmin -- \
     chronyc tracking
   kubectl debug node/<name> --image=<image-with-chrony> --profile=sysadmin -- \
     chronyc sources -v
   ```

   If the daemon is stopped, start it; if there are no reachable sources, fix the NTP server list or the firewall path for UDP/123.

3. For persistent configuration, update the node NTP config through your node configuration channel so that replacement nodes inherit the same NTP settings. A single hand-edited `chrony.conf` on a live host will not survive node replacement.

4. Wait a few minutes and confirm the etcd log is quiet:

   ```bash
   kubectl -n cpaas-system logs -c etcd <etcd-pod> | grep "clock difference against peer"
   ```

   An absence of new matches after the NTP fix confirms the cluster is back in agreement on time.

## Diagnostic Steps

Check the etcd pod logs first to confirm which peers are affected — the peer IDs in the warnings tell you whether a single member is out of sync or the whole cluster has drifted:

```bash
for POD in $(kubectl -n cpaas-system get pod -l app=etcd -o name); do
  echo "===== $POD ====="
  kubectl -n cpaas-system logs -c etcd "$POD" | grep "clock difference against peer" | tail -5
done
```

If `kubectl debug node/<name>` is not available (for example, node is `NotReady` or debug images cannot be pulled), fall back to SSH on the node's primary IP:

```bash
CONTROL_IPS=$(kubectl get nodes -l node-role.kubernetes.io/control-plane= -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}')
for IP in $CONTROL_IPS; do
  ssh -o StrictHostKeyChecking=no "$IP" "hostname; timedatectl"
done
```

Capture the chrony state at the time of the incident for post-mortem:

```bash
journalctl -u chronyd --since "1 hour ago"
chronyc sourcestats -v
chronyc tracking
```

An NTP server list that points exclusively at the control-plane nodes themselves, or at a single upstream that has since disappeared, is the most common root cause in the field. Point every cluster node at the same set of external (or load-balanced) NTP servers so all three control-plane nodes converge on the same reference time.
