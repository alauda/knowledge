---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A bond interface configured at installation time (day-0 network configuration, often through kickstart, cloud-init, or the platform's initial network provisioning) loses one or more member interfaces after a node reboot or a node-configuration rollout. Immediately after the reboot, `/proc/net/bonding/<bond>` shows fewer slaves than expected:

```text
$ cat /proc/net/bonding/bond0 | grep 'Slave Interface:'
Slave Interface: ens224
# Expected two entries (ens192 + ens224), only one remains.
```

The missing physical interface is still visible with `ip link show` — it is up at the link layer — but the bond driver does not have it attached. Traffic intended to go over the bond only traverses the remaining slave; performance drops or, if the two slaves were on different switches for redundancy, a single switch failure can take the node offline.

`dmesg` shows the interface joining the bond on boot, then being kicked out moments later by a NetworkManager reconfiguration:

```text
kernel: bnxt_en 0000:b4:00.0 ens192: NIC Link is Up, 10000 Mbps full duplex
kernel: <bond>: (slave ens192): link status definitely up, 10000 Mbps full duplex
NetworkManager: device (ens192): carrier: link connected
kernel: <bond>: (slave ens192): link status definitely down, disabling slave
```

The link did not actually go down — NetworkManager was told to reconfigure ens192 as a standalone interface after the bond had already claimed it, and that reconfigure evicts the slave from the bond.

## Root Cause

A day-0 bond (configured during installation) is persistent node-side configuration that the node OS's network-management layer expects to own. A day-2 `NodeNetworkConfigurationPolicy` (NNCP) that names the same physical interface as a standalone ethernet device — even with the intent of just "make sure ens192 is up" — creates a conflict:

1. The day-0 config enslaves `ens192` into `bond0`. After boot, the bond is up with two slaves.
2. The nmstate operator reconciles the NNCP's desired state. The NNCP says `ens192` is a standalone `type: ethernet`, `state: up`.
3. To satisfy that shape, nmstate tells NetworkManager to detach `ens192` from the bond and bring it up as a standalone device.
4. NetworkManager applies the change; the bond loses its second slave.

From the bond's perspective, the slave "went down"; from NetworkManager's perspective, it reconfigured the interface per its policy; from the operator's perspective, the NNCP reconciled successfully. Each layer did the right thing according to its own configuration; the conflict is between two independent authorities trying to own the same physical interface.

The rule: primary physical interfaces that participate in a day-0 bond must **not** be simultaneously declared as standalone interfaces in an NNCP. Day-2 NNCP should either describe the bond as a whole (so nmstate owns the bonding relationship too) or leave the primary interfaces out of its `interfaces` list entirely.

## Resolution

### Option A — remove the conflicting interfaces from the NNCP

If the NNCP exists to configure other interfaces on the node (not the ones participating in the day-0 bond), edit the policy to remove the bond-member entries:

```yaml
spec:
  desiredState:
    interfaces:
      # REMOVE: ens192 and ens224 (the bond members) — these are day-0 managed.
      # - name: ens192
      #   type: ethernet
      #   state: up
      # - name: ens224
      #   type: ethernet
      #   state: up

      # KEEP: other interfaces the NNCP legitimately needs to manage.
      - name: ens256
        type: vlan
        state: up
        vlan:
          base-iface: bond0
          id: 100
        ipv4:
          enabled: true
          address:
            - ip: 10.10.10.5
              prefix-length: 24
```

Apply:

```bash
kubectl apply -f nncp.yaml
```

A **node reboot is required** after removing the conflict. Without the reboot, NetworkManager's in-memory state still has the interfaces under its control; after the reboot, the day-0 configuration re-asserts itself without the NNCP to contest it.

If the NNCP was the only source of config for those interfaces, delete the policy entirely:

```bash
kubectl delete nodenetworkconfigurationpolicy <name>
```

Reboot the affected nodes and verify:

```bash
NODE=<node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host cat /proc/net/bonding/bond0 | grep 'Slave Interface:'
# Slave Interface: ens192
# Slave Interface: ens224
```

Both slaves present confirms the day-0 bond is intact.

### Option B — move bond management fully into the NNCP

The alternative is to let the NNCP own the bond as well, so there is only one authority. This is more invasive:

```yaml
spec:
  desiredState:
    interfaces:
      - name: bond0
        type: bond
        state: up
        link-aggregation:
          mode: 802.3ad       # or whatever bonding mode the day-0 config used
          options:
            miimon: "100"
          ports:
            - ens192
            - ens224
        ipv4:
          enabled: true
          dhcp: true
```

When the NNCP declares both the bond **and** its member interfaces implicitly through `link-aggregation.ports`, nmstate configures everything consistently; NetworkManager does not end up holding a conflicting standalone shape. Verify that the bonding mode, MII monitor interval, and any LACP parameters match the day-0 configuration exactly — nmstate will apply what is in the policy, not what was on the node at install.

This option is the durable fix but requires careful replication of the day-0 shape. Option A is usually less risky.

### Do not

- **Do not ignore the conflict hoping it resolves itself.** The conflict is deterministic: every reboot or node-config rollout reproduces it. Intermittent symptoms mean something else is involved.
- **Do not set the NNCP's affected interfaces to `state: absent`**. That tells nmstate to take them down, which worsens the problem.

## Diagnostic Steps

Confirm the missing slave:

```bash
NODE=<node>
kubectl debug node/$NODE --image=busybox -- \
  chroot /host sh -c '
    ip -br link show
    echo ---
    for bond in /proc/net/bonding/*; do
      echo "=== $bond ==="; cat "$bond"
    done
  '
```

The `/proc/net/bonding/` file lists the bond's configured vs currently-attached slaves. Fewer attached than configured is the symptom.

Walk the boot sequence in `dmesg` to confirm the NetworkManager-driven eviction:

```bash
kubectl debug node/$NODE --image=busybox -- \
  chroot /host dmesg -T | grep -E 'slave|bond|NetworkManager' | tail -30
```

A pattern of "slave up → NetworkManager carrier connected → slave disabled" is the NNCP-conflict footprint.

List NNCPs that name the bond-member interfaces:

```bash
kubectl get nodenetworkconfigurationpolicy -o json | \
  jq -r '.items[] |
         select(.spec.desiredState.interfaces[]?.name as $n |
                ["ens192","ens224"] | index($n) != null) |
         .metadata.name'
```

Any policy returned is contributing to the conflict — edit or delete per Option A.

After the fix and a reboot, re-run the bond-status check. Both slaves should be attached and stay attached through subsequent node reboots. If a future NNCP edit accidentally re-adds the bond members, the same failure returns — document the constraint in the team's NNCP authoring guide.
