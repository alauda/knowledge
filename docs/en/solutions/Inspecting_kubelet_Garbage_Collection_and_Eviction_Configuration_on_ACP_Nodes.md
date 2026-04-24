---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Operators ask three related questions:

- Has garbage collection been explicitly configured on this cluster, or is it running with defaults?
- What are the effective eviction thresholds for the nodes, and where did they come from?
- How can I see what the kubelet is actually using, as opposed to what some configuration object claims it should be using?

These are the right questions to ask before tuning — editing the node configuration without first knowing the running values leads to changes that either silently do nothing (wrong pool) or produce a surprising outcome (stacked on top of an unnoticed explicit value).

## Resolution

There are three complementary inspection paths. Pick the one that matches the question being asked: the first is "what is the kubelet actually doing right now", the second is "what is on disk on the node", the third is "what is the node configuration CR committing to render". They should agree; when they disagree, that discrepancy is itself the finding.

### Option 1 — Ask the kubelet what it is running

The authoritative answer lives inside the kubelet process itself and is exposed by the `/configz` endpoint on every node. Query it through the API server proxy and extract only the garbage-collection and eviction-related fields:

```bash
NODE=worker1.cluster.example.com

kubectl get --raw "/api/v1/nodes/${NODE}/proxy/configz" \
  | jq '.kubeletconfig
      | .kind       = "KubeletConfiguration"
      | .apiVersion = "kubelet.config.k8s.io/v1beta1"' \
  | jq '. | {
        evictionHard,
        evictionSoft,
        evictionSoftGracePeriod,
        evictionPressureTransitionPeriod,
        imageMinimumGCAge,
        imageGCHighThresholdPercent,
        imageGCLowThresholdPercent
      }'
```

A field that comes back as `null` or absent means the default is in effect (it has not been overridden). A typical default shape is:

```text
{
  "evictionHard": {
    "imagefs.available": "15%",
    "memory.available":  "100Mi",
    "nodefs.available":  "10%",
    "nodefs.inodesFree": "5%"
  },
  "evictionSoft": null,
  "evictionSoftGracePeriod": null,
  "evictionPressureTransitionPeriod": "5m0s",
  "imageMinimumGCAge": "2m0s",
  "imageGCHighThresholdPercent": 85,
  "imageGCLowThresholdPercent": 80
}
```

### Option 2 — Look at `kubelet.conf` on the node filesystem

The kubelet renders its final configuration to `/etc/kubernetes/kubelet.conf`. Use a debug container chrooted to the host to read it directly:

```bash
kubectl debug node/${NODE} -- chroot /host cat /etc/kubernetes/kubelet.conf
```

The relevant fields are the same set shown above: `evictionHard`, `evictionSoft`, `evictionSoftGracePeriod`, `evictionPressureTransitionPeriod`, `imageMinimumGCAge`, `imageGCHighThresholdPercent`, `imageGCLowThresholdPercent`. If a value shows up here but not in the live `/configz`, the node has been reconfigured but not restarted.

### Option 3 — Inspect the rendered node configuration object

If the cluster manages node configuration through ACP's node configuration CR (under `configure/clusters/nodes`, or via the **Immutable Infrastructure** extension product), the committed-but-not-yet-rendered state lives in that CR, not on the node. Locate the rendered configuration for the relevant pool, find the file entry for `/etc/kubernetes/kubelet.conf`, and decode it — its contents use the same Ignition-style `data:` URI convention (base64 or URL-encoded inline content):

```bash
# Adjust the selector/resource names to match the ACP node-config CR in use.
POOL=worker
kubectl get <node-config-cr> "${POOL}" -o json \
  | jq -r '.spec.configuration.files[]
           | select(.path == "/etc/kubernetes/kubelet.conf")
           | .contents.source' \
  | awk -F',' '{ print $2 }' \
  | base64 -d 2>/dev/null \
  | jq '{
      evictionHard,
      evictionSoft,
      evictionSoftGracePeriod,
      evictionPressureTransitionPeriod,
      imageMinimumGCAge,
      imageGCHighThresholdPercent,
      imageGCLowThresholdPercent
    }'
```

If the `contents.source` uses URL encoding rather than base64, swap the `base64 -d` step for a URL-decode (for example `python3 -c 'import sys,urllib.parse; sys.stdout.write(urllib.parse.unquote(sys.stdin.read()))'`).

This path is the one to use when reading from a support bundle / diagnostic archive: the live kubelet isn't reachable, but the rendered node configuration is preserved verbatim in the archive.

## Diagnostic Steps

If the three paths disagree, the disagreement is the answer:

- **Option 3 shows a value, Option 2 agrees, Option 1 does not** — configuration has been committed and written to disk but the kubelet has not reloaded; confirm the kubelet service has been restarted on the target node since the change landed.
- **Option 1 shows a value, Option 3 is empty** — the value is the built-in kubelet default; no operator has overridden it.
- **Option 1 and Option 3 both show values but they differ** — there is another layer (a node-scoped override, a second pool matching the same node) that is winning. Inspect labels on the node and the selector in the node configuration CR(s) to find the duplicate.

The kubelet emits `EvictionThresholdMet` and `ImageGCFailed` events on the node when these thresholds fire; `kubectl get events -A --field-selector involvedObject.name=${NODE}` surfaces them and is often the fastest way to confirm the eviction settings are being enforced as expected.
