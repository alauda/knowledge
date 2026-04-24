---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A worker node transitions to `NotReady` with an unusually high load average, yet `top` shows almost no CPU usage. The process list contains many tasks stuck in uninterruptible-sleep (`D`) state. Pods scheduled on the node stop making progress and the kubelet loses its heartbeat.

## Root Cause

Linux load average counts runnable processes **plus** processes in uninterruptible sleep. When a large number of threads block inside a kernel syscall that cannot be killed, each one contributes to the load figure even though no CPU is consumed. The most common trigger on container hosts is an NFS mount whose server stops answering: the kernel parks every reader/writer in `rpc_wait_bit_killable` until the server returns, so a single unreachable NFS export can push load into the thousands.

Because the kubelet and its probes ultimately hit the same filesystem paths (image pull cache, volume subpaths, log rotation), they inherit the same stall. The node goes `NotReady` once kubelet fails to renew its lease within the grace period.

## Resolution

Shift the investigation off the blocked kernel path, then remove the dependency.

1. **Confirm the signature** — match the load figure against the number of `D`-state threads; if they track within ~5%, you are looking at uninterruptible sleep, not CPU saturation.
2. **Identify the wait channel** — `rpc_wait_bit_killable` points at NFS or another SunRPC client (e.g. rpc.gssd). Other common channels (`io_schedule`, `wait_on_page_bit`, `wb_wait_for_completion`) point at block I/O or dirty-page writeback, which require a different fix.
3. **Fix the server or the mount** — if the NFS server is reachable, restart its services or remount. If the server is permanently gone, reboot the node: the kernel cannot release threads that are waiting on an unresponsive hard-mounted export without a reboot, and neither `kill -9` nor killing the pod will dislodge them.
4. **Harden the mount for next time** — switch the affected PersistentVolumes or hostPath mounts to `soft,timeo=<tenths>,retrans=<n>` when data-loss semantics are acceptable, or stick with `hard` but add `intr` / `nofail` via a CSI driver parameter. Pair this with a node-local liveness check that drains the node if the mount goes unresponsive.

For long-term fleet hygiene, consider fronting the NFS server with a highly-available endpoint (VIP or DNS-based failover) so a single backend outage does not wedge every node that mounts it.

## Diagnostic Steps

Open a debug pod on the suspect node:

```bash
kubectl debug node/<node-name> -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 -- chroot /host
```

Check the load average and compare it to the count of `D`-state tasks:

```bash
uptime
# 11:25:02 up 25 days,  8:45,  4 users,  load average: 3524.92, 3524.04, 3523.24

ps -eLo state,wchan,comm | awk '$1=="D"' | wc -l
# ~3520
```

Extract the kernel wait channel for each blocked thread. `rpc_wa*` prefixes implicate NFS/SunRPC:

```bash
ps -eLo state,wchan:20,comm | awk '$1=="D" {print $2}' | sort | uniq -c | sort -rn
#    3519 rpc_wait_bit_kil
#       1 io_schedule
```

Confirm the NFS angle by looking for server-timeout messages in kernel logs:

```bash
dmesg -T | grep -iE "nfs: server .* not responding"
# [Tue Apr  8 02:14:30 2026] nfs: server 10.0.0.1 not responding, timed out
# [Tue Apr  8 02:14:35 2026] nfs: server 10.0.0.1 not responding, still trying
```

List the mounts that depend on the stalled server so you know which pods to reschedule:

```bash
awk '$3 ~ /^nfs/ {print $1, $2}' /proc/self/mountinfo | grep 10.0.0.1
```

Once the node is cordoned and the blocked processes cleared (server recovery or reboot), verify kubelet recovery:

```bash
kubectl get node <node-name> -o wide
kubectl -n kube-system logs -l component=kubelet --tail=50   # or: journalctl -u kubelet -n 200
```
