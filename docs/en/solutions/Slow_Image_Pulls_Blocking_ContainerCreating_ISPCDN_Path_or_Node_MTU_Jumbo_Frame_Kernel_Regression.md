---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Slow Image Pulls Blocking ContainerCreating — ISP/CDN Path or Node MTU Jumbo-Frame Kernel Regression
## Issue

Pods on the cluster get stuck in `ContainerCreating` for minutes (occasionally hours) while their container images download. The kubelet event stream shows `Pulling image …` without a matching `Successfully pulled image` for an unreasonable span:

```bash
kubectl get events -A \
  --field-selector=reason=Pulling \
  -o custom-columns='NS:.metadata.namespace,POD:.involvedObject.name,AGE:.firstTimestamp,MSG:.message' \
  | head
```

A healthy cluster completes most pulls in seconds to low single-digit minutes for large images. When multiple nodes show 10-plus-minute pull times against the same upstream registry, the bottleneck is in the path between the nodes and the registry — not in the container runtime, the scheduler, or the workload itself. Two root causes are observed in practice and should be triaged separately before chasing other possibilities.

## Root Cause

The slow pull manifests identically regardless of cause — `kubelet` waits on a TCP flow that drips bytes instead of delivering them in bulk — so the diagnostic must distinguish which underlying path is at fault.

### Cause 1: upstream CDN/ISP routing anomaly

Public registry CDNs (Quay, GHCR, generic cloud registries) distribute their blobs across many edge PoPs. A subset of those PoPs periodically exhibits poor throughput from specific geographical regions — a peering dispute, a misconfigured transit AS, or a congested edge node. Pulls from the affected region resolve to an IP in the bad PoP and drip at a fraction of the link's capacity, while pulls from a neighbouring region against the same hostname finish normally.

This is out of scope for the cluster itself: no configuration on the cluster can redirect traffic to a different PoP. The mitigation is either to involve the ISP / cloud provider, or to front the upstream registry with an in-region mirror that shortens the path and moves the bulk transfer onto the internal network.

### Cause 2: node OS kernel regression with MTU 9000 (jumbo frames)

A regression in recent node-OS kernels (Linux 5.14-based distributions and downstream derivatives aligned with that line) causes the TCP path to deliver at a fraction of line speed when the interface MTU is set to 9000 (jumbo frames). The pattern: sustained small-packet throughput looks fine, latency and ping look fine, but bulk transfers — which image pulls specifically are — crawl.

The bug interacts with how the kernel's GRO/TSO pipeline handles oversized frames under certain driver/offload combinations. Workarounds:

- Drop the interface MTU to 1500 on the affected nodes. This gives up the jumbo-frame throughput gain that the cluster originally opted into, but restores bulk transfer speed for pulls.
- Adjust the NIC driver's offload settings (`ethtool -K <iface> gro off` or an equivalent toggle) to sidestep the specific offload combination involved.
- Upgrade the node OS to a kernel version where the regression is fixed. This is the durable fix once available in the supported build channel.

A third cause — genuinely saturated or broken node egress — can mimic the same symptoms; rule it out early with a simple throughput probe (see Diagnostic Steps).

## Resolution

### Confirm pull duration and which images are affected

Capture the delta between `Pulling` and `Successfully pulled` events across the cluster to quantify the problem:

```bash
kubectl get events -A \
  --field-selector=reason=Pulled \
  -o custom-columns='NS:.involvedObject.namespace,POD:.involvedObject.name,MSG:.message' \
  | grep -E 'already present|Successfully pulled'
```

`Successfully pulled image "…" in Xs` entries show the per-image pull time. An environment where many pulls report `in 600s` or higher is pulling against a degraded path.

### If the registry is external — inspect the resolved CDN IP

Resolve the registry hostname from a node and compare against known-good paths:

```bash
kubectl debug node/<node> --image=<image-with-shell> -- \
  sh -c '
    getent hosts <registry-hostname>
    echo ---
    curl -o /dev/null -w "size=%{size_download} time=%{time_total}s speed=%{speed_download}B/s\n" \
         -sSL https://<registry-hostname>/v2/ --max-time 30
  '
```

If the resolved IP is consistent across nodes in the same region and the throughput probe is orders of magnitude below the node's link capacity, the path itself is the problem.

Two mitigations at the cluster layer:

- **Mirror the registry inside the cluster's network perimeter.** Point the cluster at a local mirror so image pulls stay on the internal network; the external CDN is only hit during mirror replication, which can run on a tolerant schedule. Any in-region registry (Harbor, Quay mirror, Nexus, the platform's own built-in registry) fits.
- **Pre-pull to nodes during quiet hours.** For images that rarely change, a `DaemonSet` (or the cluster's built-in image-preload mechanism) can warm every node's local cache during off-hours so at-runtime pod starts hit the local storage, not the external path.

Changing the cluster's upstream registry requires coordination with whatever signs and publishes images, so the mirror path is usually the most durable answer.

### If the node MTU is 9000 — probe the kernel regression

Check the interface MTU on a sample affected node:

```bash
kubectl debug node/<node> --image=<image-with-shell> -- \
  sh -c '
    ip -o link show | awk -F: "{print \$2, \$0}" | awk "{for (i=1;i<=NF;i++) if (\$i==\"mtu\") print \$2,\$(i+1)}"
  '
```

Nodes reporting `mtu 9000` on the primary interface that carries pod traffic are candidates. Run a controlled throughput test with the MTU at 9000 and again at 1500 to confirm the regression:

```bash
# On the node, toggle MTU and re-probe. Schedule during a maintenance window.
sudo ip link set dev <iface> mtu 1500
curl -o /dev/null -w "speed=%{speed_download}B/s\n" \
     -sSL https://<registry-hostname>/v2/_catalog --max-time 30
sudo ip link set dev <iface> mtu 9000
curl -o /dev/null -w "speed=%{speed_download}B/s\n" \
     -sSL https://<registry-hostname>/v2/_catalog --max-time 30
```

A large delta between the two MTU values on an otherwise idle node indicates the regression. The durable fixes are listed above — either lower the MTU fleet-wide through the platform's node-configuration channel, tune offloads, or schedule the kernel upgrade.

Follow the platform's documented procedure for MTU changes; doing it ad-hoc in `iproute2` survives only until the next node reboot.

### Neither CDN nor MTU — general egress diagnosis

If the registry resolves normally and node MTUs are at 1500, the slow path is somewhere else on the network — a saturated uplink, a firewall that rate-limits long-lived TLS flows, an internal proxy whose cache has evicted the relevant images. The standard egress diagnostics apply:

```bash
# From an affected node, measure the full image-pull path.
kubectl debug node/<node> --image=quay.io/curl/curl-base:latest -- \
  sh -c 'curl -o /dev/null -w "latency=%{time_starttransfer}s speed=%{speed_download}B/s\n" \
              -sSL https://<registry-hostname>/v2/<image-name>/manifests/latest'
```

Abnormally high `latency=…` with normal `speed=…` points at the handshake / auth path; low `speed=…` points at the bulk-transfer path.

## Diagnostic Steps

Confirm the failing pulls are concentrated on a specific image or registry (rather than cluster-wide):

```bash
kubectl get pod -A -o json | \
  jq -r '.items[] | select(.status.containerStatuses[]?.state.waiting.reason == "ImagePullBackOff" or
                           .status.containerStatuses[]?.state.waiting.reason == "ErrImagePull" or
                           .status.containerStatuses[]?.state.waiting.reason == "ContainerCreating")
         | "\(.metadata.namespace)/\(.metadata.name)\t\(.spec.containers[].image)"'
```

If every slow pull targets the same registry host, the issue is path-specific to that registry. If slow pulls span multiple unrelated registries, the bottleneck is more likely on the cluster's own egress side (MTU bug, saturated link) rather than upstream.

Inspect `crictl`/container-runtime logs on a node mid-pull to see where the time is spent:

```bash
kubectl debug node/<node> --image=<image-with-shell> -- \
  journalctl -u crio -n 500 \
  | grep -E 'PullImage|pulling image|pulled image'
```

`PullImage` requests that span many minutes without matching completions confirm the runtime is waiting on the network, not on disk or on an auth retry.

Finally, a controlled mirror test: pick one node, flip it to use a known-good mirror (through the platform's image-policy surface), and re-run the failing pod. If pulls through the mirror complete in seconds while pulls directly to the upstream continue to crawl, the path to the upstream is the confirmed culprit.
