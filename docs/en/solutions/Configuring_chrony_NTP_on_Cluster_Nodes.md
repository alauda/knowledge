---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Cluster nodes need to synchronise their clocks against a specific NTP server set — often an internal time source inside a restricted network, or a hardened NTP pool with Network Time Security (NTS). The default chrony configuration that ships on each node points at public time servers, which is either not reachable (air-gapped / egress-controlled environments), not acceptable by policy, or not trusted (no NTS).

The question is how to push a custom `/etc/chrony.conf` onto every node — and keep it pushed across node reboots, node replacements, and scale-up events — without ad-hoc SSH edits that drift between nodes.

## Root Cause

Time sync on a cluster node is a property of the node operating system, not of a workload. Editing `/etc/chrony.conf` on a live node works for the moment but is undone the next time the node's base image is re-applied (reboot of an immutable host, PXE re-image, cloud autoscale replacement), leaving the fleet with inconsistent chrony configs and silent drift.

The declarative approach is to drive chrony configuration from a cluster-level object that the node-config controller translates into a file on disk, then re-applies whenever a node is brought up. ACP exposes this via the **Immutable Infrastructure** extension product and the in-core `configure/clusters/nodes` surface — both cover the same primitive: "here is a file (or systemd unit) that should exist on every node in this pool." The controller reconciles the file to the target path and triggers a coordinated rolling restart of the affected nodes so the new config takes effect without manual intervention per host.

## Resolution

### Preferred: declarative node configuration via the Immutable Infrastructure surface

On ACP, push the chrony configuration as a node-file object scoped to the node role(s) that should receive it. The shape is: a node-role selector, a list of files with target path + mode + content, and an optional list of systemd units to restart after the file is written. The controller computes the rendered config for each role and rolls the nodes through it one at a time, draining workloads first.

A typical custom `chrony.conf` targeted at every worker:

```text
# /etc/chrony.conf content applied to worker nodes
server time1.internal.example.com iburst
server time2.internal.example.com iburst
driftfile /var/lib/chrony/drift
makestep 1.0 3
rtcsync
logdir /var/log/chrony
```

Wrap that content in the node-config resource for the worker role, mark it mode `0644`, and attach a post-apply trigger that restarts `chronyd.service`. The controller will then:

1. Render the file and compute a new desired node configuration for the role.
2. Select nodes one at a time (respecting pool disruption budgets) and cordon + drain each one.
3. Write the file, reload systemd, restart `chronyd`.
4. Uncordon the node and move on.

For clusters where only a subset of nodes should use a specific time server — for example, edge nodes that have their own on-site NTP appliance — create a second node-config resource with a selector that matches the edge role, and pool-scoped rendering keeps the two sets separate.

At install time the same payload can be fed into the installer's additional-manifest input so the nodes come up with the correct chrony config on first boot, avoiding a post-install roll.

### OSS fallback: DaemonSet-driven config for clusters without the Immutable Infrastructure layer

When a cluster does not have the Immutable Infrastructure extension in place and the node file system is writable (not an image-locked host), a DaemonSet with a privileged init container can bind-mount `/etc/chrony.conf` and restart the service via `nsenter` into the host PID namespace. This is the traditional OSS pattern. It trades off the declarative rolling behaviour (no automatic drain, no rollback on failure) for portability. Use it only as a transition while the declarative path is being adopted — the state it produces is not captured in a cluster object, so it drifts as soon as a node is replaced.

Regardless of path, verify NTP reachability before changing production traffic over to the new source. A chrony misconfiguration that points at an unreachable server silently leaves nodes desynchronised, which then manifests as certificate-validity, etcd, and kubelet lease errors hours later.

## Diagnostic Steps

Confirm the rendered config landed on a sample node from each pool:

```bash
kubectl debug node/<node-name> \
  --image=busybox:1.36 -- chroot /host cat /etc/chrony.conf
```

Check that `chronyd` is active and the sources it is currently tracking:

```bash
kubectl debug node/<node-name> \
  --image=busybox:1.36 -- chroot /host \
    sh -c 'systemctl is-active chronyd && chronyc -n sources -v'
```

Expect one or more sources with a leading `^*` (the current master) and low offsets. A source line starting with `^?` means the node cannot reach the server — check egress rules from the node to the NTP endpoint on UDP/123 (or TCP/4460 for NTS).

Look for drift across nodes to catch a configuration that was only partially rolled out:

```bash
for n in $(kubectl get node -o name); do
  echo "== $n =="
  kubectl debug $n --image=busybox:1.36 -- chroot /host chronyc tracking \
    | grep -E 'System time|Reference ID|Stratum'
done
```

`System time` offsets above a few hundred milliseconds or differing `Reference ID` values across nodes that should be using the same source both indicate the push did not land uniformly. In that case, confirm the node-config resource selector actually matches the outlier nodes and that the roll has not been paused.

When switching to Network Time Security (NTS), the chrony config must use `server <host> nts` and the node must trust the server's TLS chain; otherwise chrony silently falls back to non-authenticated NTP. Verify with:

```bash
kubectl debug node/<node-name> \
  --image=busybox:1.36 -- chroot /host chronyc authdata
```

Non-zero `KeyID` and positive `NAK` / `KoD` counters close to zero are the expected signals; a flood of NAKs means the NTS handshake is failing and a normal NTP session has not been established.
