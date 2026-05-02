---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Intermittent Image Pull i/o Timeout from a Single Node
## Issue

Pods scheduled on one node go into `ImagePullBackOff` while the same image pulls successfully on the rest of the cluster. Manual probes with `skopeo` or `podman pull` from inside the affected node reproduce the failure with the same `i/o timeout` symptom:

```text
FATA Get https://<registry-host>/v2/<repo>/blobs/sha256:<digest>:
       dial tcp <registry-ip>:443: i/o timeout
```

The error is intermittent — some pulls return small manifests within milliseconds, larger blob downloads stall and trip the timeout. Because the failure is per-node, the cluster's image pull retry policy keeps churning the pod between `ImagePullBackOff` and `ContainerCreating` rather than scheduling it elsewhere or surfacing a clear authentication error.

## Root Cause

`i/o timeout` from `dial tcp` is a TCP-layer event: the node opened a socket to the registry but the kernel's send queue did not drain within the configured deadline. There are three families of cause that all surface this way, only the first one is truly a registry problem:

- **Path-MTU mismatch.** The node's egress interface advertises a higher MTU than something on the path (usually a tunnel or NAT box) actually supports. Small packets (manifest API calls) succeed, large packets (blob bodies) get black-holed because ICMP fragmentation-needed messages are dropped on the way back. The connection stalls until the timeout fires.
- **Per-node firewall or proxy drift.** The node either lacks a route, lacks a NO_PROXY exemption, or sits behind a proxy that mid-stream-rate-limits large downloads. The fact that only one node fails is the giveaway: the platform-wide proxy is fine, but this host's per-interface configuration is not.
- **Upstream registry congestion.** Genuinely a registry-side issue, but rare; if it were the cause, every node would see slowdowns at the same time.

Pinpointing which family applies takes ten minutes of probing and saves hours of guessing at registry mirrors.

## Resolution

1. **Confirm the pull failure is reachable from the affected node only.** Use `kubectl debug` to drop into the node host and probe the registry endpoint directly. A deliberately tiny request that returns `401 Unauthorized` confirms reachability without needing credentials:

   ```bash
   NODE=<affected-node>
   REG=<registry-host>          # e.g. ghcr.io / quay.io / a private registry
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/sh -c "
       curl -sS -o /dev/null -w 'http=%{http_code} dns=%{time_namelookup}s
                                   connect=%{time_connect}s total=%{time_total}s\n' \
            https://$REG/v2/
     "
   ```

   `http=401` is normal — the API requires auth. `http=000` plus a long `time_connect` means the TCP handshake itself never completed; jump to step 3.

2. **Drive a large transfer to expose MTU issues.** A 1×1 manifest pull can succeed while a 50 MiB blob hangs. Probe a known-large path through the same TLS connection:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/sh -c "
       curl -sS -o /dev/null -w 'speed=%{speed_download} bytes=%{size_download}\n' \
            -m 30 https://$REG/v2/<large-public-blob>
     "
   ```

   If the transfer stalls after the first dozen kilobytes, MTU is the prime suspect. Confirm with a packet-size probe:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/sh -c "
       ping -M do -s 1472 -c 3 $REG;     # OK at 1500 MTU
       ping -M do -s 1372 -c 3 $REG      # OK if path MTU is 1400
     "
   ```

   The largest unfragmented size that succeeds, plus 28 bytes of IP+ICMP overhead, is the path MTU. If it is below the interface MTU, lower the interface MTU through the platform's node-configuration surface or fix the misbehaving middlebox.

3. **Compare per-node networking against a healthy peer.** When step 1 already showed the connect failing, it is almost always a route, proxy, or firewall delta on this single host:

   ```bash
   kubectl debug node/$NODE -it \
     --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
     -- chroot /host /bin/sh -c '
       ip route get $(getent hosts <registry-host> | awk "{print \$1}")
       cat /etc/resolv.conf
       env | grep -iE "https?_proxy|no_proxy"
     '
   ```

   Run the same block on a node that pulls successfully and diff the output. The difference is usually a missing default route after a NIC bond change, a stale `no_proxy` that doesn't include the registry, or an outbound rule on a node-local firewall that has not been re-applied.

4. **Make the cluster pull credentials match.** If `time_connect` is fast but the actual pull returns `401`, the failing node has a stale or missing image-pull secret. Reapply credentials cluster-wide via the kubelet's pull-secret surface — never patch `/var/lib/kubelet/config.json` by hand on a single node.

5. **Reduce blast radius while diagnosing.** Cordon the node so no further pods are scheduled until the network or credentials are fixed:

   ```bash
   kubectl cordon $NODE
   # ...investigate, fix, validate by step 1 again...
   kubectl uncordon $NODE
   ```

## Diagnostic Steps

Identify the failing pods and the exact image they are stuck on:

```bash
kubectl get pods -A -o wide \
  | awk '$4 ~ /ImagePullBackOff|ErrImagePull/'
kubectl describe pod -n <ns> <pod> \
  | sed -n '/Events:/,$p'
```

Pull credentials and registry config are read by the container runtime on the node. Inspect what the runtime sees, not what the cluster object says it should see:

```bash
kubectl debug node/$NODE -it \
  --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host /bin/sh -c '
    crictl info | grep -iE "registr|mirror"
    cat /etc/containers/registries.conf.d/*.conf 2>/dev/null | head
  '
```

After a fix lands, the cleanest validation is to delete a stuck pod and watch the next pull complete from end to end:

```bash
kubectl -n <ns> delete pod <stuck-pod>
kubectl -n <ns> get events --sort-by=.lastTimestamp | tail -n 20
```

A `Pulled` event with a non-zero byte count confirms the path is healthy.
