---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On clusters whose container image policy enforces GPG signature verification using the `signedBy` policy type (a `policy.json` / `/etc/containers/policy.json` entry that requires every pull from a given registry to be signature-checked), CRI-O on individual nodes begins hanging indefinitely inside the image-pull step. Symptoms observed on the affected nodes:

- Pods that land on the stuck node stay in `ContainerCreating` for the entire pull timeout and often past it, with events similar to
  `Failed to pull image "<registry>/<image>": context deadline exceeded`.
- The CRI-O process on the node accumulates file descriptors over time; `ls /proc/$(pidof crio)/fd | wc -l` grows monotonically, dominated by pipe FDs.
- Restarting the CRI-O service on the node temporarily restores pull behaviour, but the symptom reappears after a period of steady-state pulling.
- The cluster-wide `signedBy` policy is known-good; pulls on unaffected nodes succeed against the same registry with the same signing configuration.

The pattern is node-local and random across the fleet — a pull that hangs on one node may succeed on another.

## Root Cause

CRI-O shells out to the `containers/image` signature-verification library, which in turn invokes GPGME (GNU Privacy Guard Made Easy) to validate the signature attached to each layer/manifest fetched from the registry. GPGME communicates with its child `gpg` process through a pair of anonymous pipes.

On the versions affected by this issue, one of the pipe file descriptors is not closed in all error / early-return paths inside the signature verification flow. Under sustained pull pressure the leaked pipe FDs accumulate in the CRI-O process. Once the process approaches its FD soft limit — or once the GPGME library's own pool of pipe FDs is exhausted — the next signature verification call blocks forever waiting for a read on a pipe that is never going to be written. Because the verification is synchronous in the pull path, the entire CRI-O pull hangs.

It is a race-agnostic slow leak: any node that handles enough signed pulls will eventually reproduce it. Which node hangs first is simply a function of how many pulls it has handled since CRI-O was started.

## Resolution

This is a known defect in the CRI-O image pull / signature verification code path and must be fixed by an upstream/vendor patch; the working fix is to run a CRI-O build where the leaked pipe FD is closed correctly. Until that build is rolled to the affected nodes, use the node-local mitigations below to restore service.

### Apply the patched CRI-O build

Consult the release notes for your CRI-O package channel and pick the first build that documents the GPGME pipe FD leak as fixed. The fix is delivered as a refreshed `cri-o` RPM / package (for the affected `cri-o-1.33.x` line and later). Roll it through the cluster with the same node lifecycle you use for other CRI-O upgrades:

1. Cordon the target node:
   ```bash
   kubectl cordon <node>
   ```
2. Drain it (respect PDBs):
   ```bash
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   ```
3. Upgrade the CRI-O package on the node through the standard node-OS update channel for the platform's node-config system (for in-core ACP, via `configure/clusters/nodes`; for the Immutable Infrastructure extension, via its node image pipeline).
4. Reboot / restart `crio.service`, uncordon, verify a signed pull succeeds:
   ```bash
   kubectl uncordon <node>
   kubectl -n default run sigtest --image=<signed-image> --restart=Never --rm -it --command -- true
   ```
5. Watch the node's CRI-O FD count to confirm it is no longer climbing over time (see Diagnostic Steps).

### Temporary mitigation before the patched build is available

If the cluster cannot tolerate waiting for the fixed build, either of these reduces the probability of a stuck node but does **not** make the bug disappear:

- **Periodic CRI-O restart** on affected nodes — drain, `systemctl restart crio.service`, uncordon — on a schedule shorter than the observed time-to-hang. This resets the leaked FDs.
- **Loosen signature policy scope** — restrict the `signedBy` requirement to the smallest set of registries that actually ship signatures, so fewer pulls go through the GPG verification path. Only do this if your compliance posture allows it; do not disable signature verification cluster-wide.

Neither mitigation is a substitute for the patched build.

## Diagnostic Steps

```bash
# 1. Identify nodes whose pull operations are currently stuck.
kubectl get events -A --sort-by=.lastTimestamp | \
  grep -E 'Failed to pull image|ImagePullBackOff|context deadline exceeded' | tail

# 2. From inside a debug shell on a suspect node, look for the FD leak.
kubectl debug node/<node> --image=<debug-image> -- chroot /host /bin/sh
pid=$(pidof crio)
ls /proc/$pid/fd | wc -l
ls -l /proc/$pid/fd | grep -c pipe:

# 3. Confirm the signature policy path is actually in use.
cat /etc/containers/policy.json | \
  grep -A3 -B1 '"type": "signedBy"'

# 4. Look for CRI-O log lines that correlate with the hang.
journalctl -u crio --since "30 min ago" | \
  grep -iE 'gpg|signature|pulling image|stalled|deadline'

# 5. Check how long CRI-O has been running. Long uptimes correlate with
#    accumulated leak.
systemctl show crio.service -p ActiveEnterTimestamp
```

If step 2 shows a pipe-FD count that climbs steadily over a workload period while image-pull latency grows on that node, you have confirmed the leak signature. Once the patched build is in place the count should plateau at a low, stable value instead of growing monotonically.
