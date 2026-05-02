---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pods CrashLoopBackOff with "address already in use" caused by an in-cluster security agent
## Issue

A handful of pods on the cluster — sometimes the same workload across many nodes, sometimes a mix — sit in `CrashLoopBackOff` and never get past startup. The container logs show a generic listener-bind failure, the wording differs by language and framework but always ends in the same kernel error:

```text
"msg":"error received after stop sequence was engaged",
"error":"listen tcp :4343: bind: address already in use"
```

```text
failed to start metrics server: failed to create listener:
listen tcp :8080: bind: address already in use
```

The literal port number and the prefix vary; the part to anchor on is `bind: address already in use`. Restarting the pod, deleting the pod, draining and rescheduling it — none of these clear the symptom, because nothing the kubelet does releases whoever is holding the port on the host.

## Root Cause

The previous container instance, or a sidecar component injected by an in-cluster security agent (Twistlock / Prisma Cloud Defender is the common offender, but any agent that runs as a privileged DaemonSet and intercepts container processes can produce the same shape), is still holding the listening socket when the new container starts. The kernel refuses the second `bind(2)` and the new process exits, the kubelet restarts it, and the loop repeats indefinitely because the socket-holder is not part of the pod the kubelet is restarting and is therefore never reaped.

This is not a bug in the workload. The hint that the workload itself is innocent is that the same port works on a node where the agent is absent, and the same image works in a different cluster where the agent is uninstalled.

## Resolution

Two paths, in this order:

### Confirm an outside process is holding the port

Open a node shell on the affected node and identify what owns the listening socket *outside* the pod's network namespace. The host network namespace is what most agents inject into — that is why the pod's own namespace looks empty when inspected from inside.

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
  -- bash
ss -tlnp | grep ":<port>"
# or:
lsof -nPi :<port>
```

If the holder turns out to be a `defender`, `twistlock`, `prisma`, or any non-kubelet binary running on the host, the workload's bind failure is collateral.

### Drop the agent's hold and let the workload bind

The supported fix for this class of agent is to **disable the agent on the affected nodes**, restart the affected pods, and confirm the listener comes up. Three concrete remediations, ordered by intrusiveness:

1. Stop the agent's enforcement on the affected nodes from its own console / CR — most enterprise agents have a "monitor only" toggle that releases the injected sockets without uninstalling.
2. Cordon the node, scale the agent's DaemonSet down on the node (taint the node so the agent's tolerations no longer match, or set `nodeSelector` on the DaemonSet), then reschedule the workload pods. The kernel releases the port as soon as the agent's process exits.
3. If the held socket persists after the agent is stopped, reboot the node — a kernel-side socket leak that the userspace exit did not clear is the only situation that requires this. Drain first.

Once the workload pods come up `Running`, re-enable the agent on a single node and verify that the workload survives that node's agent enforcement before re-enabling cluster-wide. If the workload crashes again with the agent on, the agent's policy needs to be tuned (e.g. exclude the workload's namespace, or drop the port-interception rule for the workload's PodSpec).

A long-term fix lives with the agent vendor, not with the cluster — open a case with whichever vendor ships the agent and attach the `ss`/`lsof` output and the affected workload's PodSpec.

## Diagnostic Steps

1. Confirm the loop is on the bind step and not on something else that happens to look similar (for example, a panic before bind, or a readiness probe killing the container at second 1):

   ```bash
   kubectl -n <ns> logs <pod> --previous --tail=100
   kubectl -n <ns> describe pod <pod> | sed -n '/Events:/,$p'
   ```

   The `Last State: Terminated` reason should be `Error` (not `OOMKilled`) and the previous-instance log should end on `bind: address already in use`.

2. Map the affected pods to nodes — the symptom is per-node, so the distribution tells you the blast radius:

   ```bash
   kubectl get pod -A -o wide \
     --field-selector=status.phase!=Running,status.phase!=Succeeded \
     | grep CrashLoop
   ```

3. On one of the affected nodes, identify the socket holder from the host network namespace:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- bash -c '
       ss -tlnp | grep -E ":<port>\b"
       echo "---"
       for ns in $(ls /var/run/netns 2>/dev/null); do
         echo "ns=$ns"
         ip netns exec "$ns" ss -tlnp 2>/dev/null | grep -E ":<port>\b"
       done
     '
   ```

   If the listener appears in the host namespace and **not** in any pod namespace, an out-of-pod process owns it.

4. Map the holder PID back to a Kubernetes object:

   ```bash
   pid=<from ss -tlnp>
   ls -l /proc/$pid/cgroup
   cat /proc/$pid/cgroup
   ```

   The cgroup path resolves to a kubelet pod path or a host systemd unit. A host systemd unit (e.g. `/system.slice/twistlock-defender.service`) confirms the agent is the holder; a `kubepods.slice/...` path means a different pod owns the port and the conflict is between two workloads — a different remediation entirely.

5. After the agent is stopped, verify the port is free *before* rolling the workload pods so that the next bind-attempt is the test:

   ```bash
   ss -tlnp | grep ":<port>" || echo "port is free"
   kubectl -n <ns> rollout restart deploy/<workload>
   ```

6. If the port stays held even after the agent's process is gone, capture the holding socket's state for the agent vendor — this is the artifact the case will turn on:

   ```bash
   ss -tlnpe state listening "( sport = :<port> )"
   ```
