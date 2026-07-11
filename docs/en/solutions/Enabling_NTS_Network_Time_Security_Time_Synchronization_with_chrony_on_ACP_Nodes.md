---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Enabling NTS (Network Time Security) Time Synchronization with chrony on ACP Nodes
## Issue

Operators need the node clock to synchronize over **NTS (Network Time Security, RFC 8915)** instead of plain NTP. NTS authenticates the time source and protects samples against tampering, which is mandatory in many audit baselines that disallow unauthenticated time sources. The requirement translates into two things: replace the default chrony configuration on every cluster node with one that declares the upstream server with the `nts` option, and make sure the certificate chain presented by that NTS server is trusted by the node.

## Root Cause

ACP nodes ship with a chrony-based time-sync daemon and a default `chrony.conf` that targets plain NTP. NTS needs the `nts` keyword on the `server` directive, an `ntsdumpdir` for cached cookies, and trust for the server certificate at the node-OS level. None of that is set by default, and because node configuration is declarative, the change has to be rolled out as a managed config object rather than by SSHing to each node.

## Resolution

ACP's preferred path for node-OS configuration is the node configuration surface under `configure/clusters/nodes`, with the extended **Immutable Infrastructure** product providing the MachineConfig-equivalent CR. The generic pattern is the same whichever concrete resource you pick: declare the target file content, target the worker or control-plane pool, and let the node controller roll the change out with ordered reboots.

1. **Author the desired `/etc/chrony.conf`.** Add `nts` to the `server` line and declare `ntsdumpdir` so the chrony cookie cache survives restart:

   ```text
   server time.example.com iburst nts
   driftfile /var/lib/chrony/drift
   makestep 1.0 3
   rtcsync
   logdir /var/log/chrony
   ntsdumpdir /var/lib/chrony
   ```

2. **Ship the file through the node-configuration mechanism.** On ACP this means a node configuration / machine-config-style resource that writes the file to `/etc/chrony.conf`, mode `0644`, scoped by node role label (for example `node-role.kubernetes.io/worker` for workers, the matching label for control-plane or infra pools). Conceptually:

   ```yaml
   # Illustrative shape; use the ACP node configuration CR appropriate
   # for the cluster (configure/clusters/nodes or Immutable Infrastructure).
   spec:
     selector:
       matchLabels:
         node-role.kubernetes.io/worker: ""
     files:
       - path: /etc/chrony.conf
         mode: 0644
         overwrite: true
         contents:
           inline: |
             server time.example.com iburst nts
             driftfile /var/lib/chrony/drift
             makestep 1.0 3
             rtcsync
             logdir /var/log/chrony
             ntsdumpdir /var/lib/chrony
   ```

   Repeat (or parameterize) for every node role that must be covered — control-plane, worker, infra.

3. **Trust the NTS server certificate.** If the NTS/chronyd server presents a certificate signed by an internal CA, add that CA to the cluster's trusted bundle (the same mechanism used for trusting private registries and internal proxies). Without this, chrony will refuse to establish the NTS-KE session and fall back or alarm.

4. **Roll out in order.** Node configuration changes trigger a controlled reboot of the matching pool. Drain sensibly, watch the rollout per pool, and verify on the node side (see `Diagnostic Steps`) before moving to the next pool. Do not apply to all three pools (control-plane, worker, infra) simultaneously.

## Diagnostic Steps

Confirm the rendered `chrony.conf` on a representative node matches intent:

```bash
kubectl debug node/<node> -- cat /etc/chrony.conf
```

Check that the NTS key exchange completed and cookies were established:

```bash
kubectl debug node/<node> -- chronyc -N authdata
```

Expected output lists the configured server with `Mode` = `NTS`, a non-zero `KeyID`, a `KLen` (key length, commonly 256), and a non-zero `Cook` count (number of cached cookies):

```text
Name/IP address             Mode KeyID Type KLen Last Atmp  NAK Cook  CLen
================================================================
time.example.com             NTS     1   15  256  33m    0    0    8   100
```

If `Mode` is not `NTS`, the `server` line is not being read with the `nts` keyword — re-check the rendered config. If `Mode` shows `NTS` but `Cook` is `0` and `NAK` is non-zero, the key-exchange failed: inspect `chronyc sources -v` and `journalctl -u chronyd` on the node to see whether the error is TLS (certificate trust), DNS, or network reachability to the NTS-KE port.
