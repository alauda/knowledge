---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A NodeNetworkConfigurationPolicy (NNCP) is updated to add a new VLAN as a localnet bridge-mapping on an OVS bridge that already carries production traffic for KubeVirt VMs. The NNCP transitions to `Degraded`, the corresponding NodeNetworkConfigurationEnactment (NNCE) reports `Failing`, and the kernel logs from `nmstatectl` carry a verification error similar to:

```text
failed to execute nmstatectl set --no-commit --timeout 480: 'exit status 1'
... VerificationError: Verification failure:
ovs-br1.interface.bridge.port desire '[{"name":"enp3s0"}]',
                              current '[{"name":"enp3s0"},{"name":"patch-localnet1_ovn_localnet_port-to-br-int"}]'
```

The desired-state in the NNCP lists only the physical port, while the live-state on the node carries an extra patch port (`patch-<name>_ovn_localnet_port-to-br-int`) that the SDN added to splice the VM-side localnet network into the OVS bridge. nmstate sees this as drift, fails verification, and the rollout stops.

## Root Cause

When the platform's CNI uses OVS with localnet network attachments (multus + the OVN secondary network), the SDN owns one or more patch ports on the OVS bridge — they are added at runtime, not by nmstate. nmstate's default contract is exclusive ownership: the desired `port` list must equal the live list. Any extra port on the bridge — even one the SDN itself created — is treated as drift, and the policy fails to apply.

The opt-in flag `allow-extra-patch-ports: true` on the bridge tells nmstate that patch ports it did not declare are allowed to coexist on the bridge; nmstate then reconciles only the ports it owns and leaves the SDN's patch ports alone.

## Resolution

Add `allow-extra-patch-ports: true` to every OVS bridge in the NNCP that carries localnet attachments managed by the SDN. Apply with the same NNCP name so the NNCE re-enacts:

```yaml
apiVersion: nmstate.io/v1
kind: NodeNetworkConfigurationPolicy
metadata:
  name: ovs-br1
spec:
  nodeSelector:
    node-role.kubernetes.io/worker: ""
  desiredState:
    interfaces:
      - name: ovs-br1
        type: ovs-bridge
        state: up
        bridge:
          allow-extra-patch-ports: true        # required when SDN owns patch ports
          options:
            stp: false
          port:
            - name: enp3s0
      - name: br-ex-mapping
        type: ovs-interface
        state: up
        bridge: ovs-br1
```

Apply and watch:

```bash
kubectl apply -f ovs-br1-nncp.yaml
kubectl get nncp ovs-br1
kubectl get nnce | grep ovs-br1
```

The NNCP should report `Available`; per-node NNCEs should reach `SuccessfullyConfigured` within `--timeout`. Validate on a node that the SDN's patch ports are still attached:

```bash
kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
  -- chroot /host ovs-vsctl list-ports ovs-br1
```

`enp3s0` and the `patch-...localnet...-to-br-int` port should both be present.

## Diagnostic Steps

1. Identify the failing NNCE — the message points to the bridge and the unexpected port:

   ```bash
   kubectl get nnce -o jsonpath='{range .items[?(@.status.conditions[0].type=="Failing")]}{.metadata.name}{"\t"}{.status.conditions[?(@.type=="Failing")].message}{"\n"}{end}'
   ```

2. On the node, confirm an SDN-owned patch port is in fact attached to the bridge listed by the error:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host ovs-vsctl list-ports <bridge>
   ```

   Names matching `patch-*_ovn_localnet_port-to-br-int` are the SDN's; presence of any of these without `allow-extra-patch-ports: true` reproduces the error.

3. After applying the fix, re-confirm nmstate's view matches:

   ```bash
   kubectl debug node/<node> -it --profile=sysadmin --image=<utility-image> \
     -- chroot /host nmstatectl show <bridge> | grep -A20 'bridge:'
   ```

   The `port:` list should contain only the physical port; the SDN's patch ports are tolerated, not declared.
