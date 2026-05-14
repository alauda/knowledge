---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Setting a Non-UTC Timezone on Cluster Nodes
## Issue

Some operational environments require a node-level timezone other than UTC — typically because legacy log-shipping pipelines, on-call rotation tools, or local compliance reports expect timestamps in regional time. Out of the box, the node OS shipped with ACP is configured for UTC. The question is how to override that for a specific subset of nodes (or for the whole cluster) in a way that survives reboots, image upgrades, and node replacements.

The short answer: it works, it is supported, and it is **not recommended**. Anything that consumes logs from more than one source — the platform's own log pipeline, an external SIEM, an aggregator that stitches together pod logs and node logs — has to rationalise mixed timezones before correlation. Daylight Saving Time transitions add a second class of bugs: applications that log local time silently change their offset twice a year, and any time-window query against historical data has to know which side of the transition it is reading.

If the requirement is real anyway, do it declaratively at the node-pool level so it survives the next node reconcile.

## Root Cause

The node OS keeps timezone state under `/etc/localtime` (a symlink into `/usr/share/zoneinfo/...`) and exposes it via `timedatectl`. The kubelet, the container runtime, and every pod that does **not** mount its own zoneinfo inherit this value through `TZ`-derived defaults.

On ACP, nodes are managed declaratively: any change made by hand on the host (`timedatectl set-timezone`, `ln -sf /usr/share/zoneinfo/...`) is reverted at the next reconcile. The change must therefore be expressed in the node-configuration surface — the same surface used for sysctls, kubelet drop-ins, and other host-level settings — so the platform applies it on every matching node and reapplies it after replacement.

## Resolution

### Preferred: platform-managed node configuration

Use the `configure/clusters/nodes` node-configuration surface (the same one that owns kubelet drop-ins and host-level sysctls; the underlying mechanism is the platform's Immutable Infrastructure capability). Declare a unit that runs `timedatectl set-timezone` once per node and ties to a label selector so only the intended node pool is affected.

A typical declaration, scoped to nodes labelled `node-role/timezone=local`:

```yaml
nodeSelector:
  matchLabels:
    node-role/timezone: local
files: []
systemdUnits:
  - name: custom-timezone.service
    enabled: true
    contents: |
      [Unit]
      Description=Set node timezone
      After=network-online.target
      ConditionPathExists=!/etc/.timezone-applied
      [Service]
      Type=oneshot
      ExecStart=/usr/bin/timedatectl set-timezone Europe/Madrid
      ExecStartPost=/usr/bin/touch /etc/.timezone-applied
      [Install]
      WantedBy=multi-user.target
```

Substitute the desired IANA timezone (`Europe/Madrid`, `Asia/Shanghai`, etc.) — `timedatectl list-timezones` on any node enumerates the valid values. The `ConditionPathExists=!` plus `ExecStartPost=touch` idiom keeps the unit a true one-shot: subsequent reboots see the marker and do not re-run, which keeps the unit out of "failed but harmless" status reporting.

The platform applies the change by draining each matching node, restarting the relevant unit, and reconciling. Each affected node reboots (or, where the underlying mechanism is a kubelet drop-in only, restarts the kubelet) — schedule the rollout off-peak and stage it pool-by-pool.

To target a subset rather than the whole cluster, label the relevant nodes first:

```bash
kubectl label node <worker-01> <worker-02> node-role/timezone=local
```

Removing the label (`kubectl label node <name> node-role/timezone-`) does **not** undo the change; the symlink that `timedatectl` writes survives. To revert, declare a second node-configuration entry that pins the timezone back to `UTC` and let it land on the originally-modified pool.

### Fallback: per-pod TZ environment

When the requirement is "this one application logs in regional time" rather than "the node logs in regional time", do not touch the host. Set `TZ` on the pod and (where the application's runtime needs it) mount the zoneinfo file into the container:

```yaml
spec:
  containers:
    - name: app
      image: example.io/app:1.0
      env:
        - name: TZ
          value: "Europe/Madrid"
      volumeMounts:
        - name: zoneinfo
          mountPath: /etc/localtime
          readOnly: true
  volumes:
    - name: zoneinfo
      hostPath:
        path: /usr/share/zoneinfo/Europe/Madrid
        type: File
```

The pod-level approach side-steps every operational drawback of changing the host timezone: log aggregation still sees a consistent UTC clock at the platform layer, and there is no DST cliff to coordinate across the fleet.

## Diagnostic Steps

After a node has reconciled, confirm the change actually landed:

```bash
NODE=<node-name>
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c '
     timedatectl
     ls -l /etc/localtime
   '
```

Expected: `Time zone: Europe/Madrid (CET, +0100)` (or whichever zone was declared) and `/etc/localtime` symlinked into the same path under `/usr/share/zoneinfo`. If the node still shows UTC, either the label is missing on that node (`kubectl get node $NODE --show-labels`) or the platform rollout has not completed yet — check the node-pool status surface.

To compare what the kubelet's containers see versus what the host shows:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host sh -c 'date; TZ=UTC date'
```

The bare `date` reflects the host's local timezone; the `TZ=UTC date` reflects UTC. A divergence between the two confirms the override is in effect.

To audit timezone consistency across a fleet (looking for nodes that did not pick up a rollout, or that picked up a stale rollout):

```bash
for n in $(kubectl get node -l node-role/timezone=local -o name); do
  echo "=== $n"
  kubectl debug "$n" -it \
    --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
    -- chroot /host sh -c 'timedatectl | grep "Time zone"'
done
```

Any node whose output disagrees with the rest is a candidate for re-reconcile. Inconsistent timezones across a single node pool are almost always an in-flight rollout, not a permanent state — re-check after the platform finishes.
