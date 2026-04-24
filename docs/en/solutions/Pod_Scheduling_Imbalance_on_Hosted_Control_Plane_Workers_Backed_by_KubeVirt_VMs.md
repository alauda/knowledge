---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

On a Hosted Control Plane cluster whose data-plane nodes are KubeVirt virtual machines, pods pile up unevenly across workers even when resource usage, taints, and tolerations all look correct. The imbalance does not move over time — the same workers stay hot, the same workers stay cold — and reschedule events do not redistribute the load.

The problem becomes visible in two ways:

- `kubectl get pod -A -o wide` shows a handful of VM-backed workers with significantly more pods than their peers.
- Scheduler decisions appear to ignore image-locality even for pods whose image is already cached on an underutilised node.

## Root Cause

The scheduler's `ImageLocality` plugin scores nodes based on the images each node reports it already has. The kubelet populates this list in `Node.status.images`, and **by default caps the list at 50 images per node** (`nodeStatusMaxImages=50`). When a node has pulled more images than that cap, the kubelet truncates its report. For KubeVirt-backed workers, where every launcher pod pulls the virt-launcher image, and where VMs frequently cycle through OS and cloud-init images, the list exceeds 50 quickly.

Once the list is truncated:

- A node that actually has a given image cached does not advertise it.
- The scheduler treats that node as if the image is absent.
- The `ImageLocality` score drops, and the scheduler prefers other nodes.

The net effect is that nodes whose image set happens to remain under 50 — typically newer or quieter workers — keep attracting new pods, while older or busier workers are penalised. The more workloads a node runs over its lifetime, the worse the bias becomes.

This is an upstream Kubelet default rather than a scheduling bug. It is tracked as an imbalance in the Hosted Control Plane KubeVirt provider because that is where image churn is unusually high.

## Resolution

### Preferred path on ACP

ACP **virtualization** (`docs/en/virtualization/`) and the **Hosted Control Plane** extension (`hosted-control-plane-docs`) both use KubeVirt for the data plane. For tenant-cluster worker nodes that run inside VMs, the kubelet runs **inside** the VM guest — node-level kubelet tuning lands inside the VM image / ignition-style config, not on the hypervisor host.

Node-level kubelet configuration on ACP is managed through **`configure/clusters/nodes`** (in-core) and the extension product **Immutable Infrastructure** (`immutable-infra-docs`). The declarative knob to raise is `kubeletConfiguration.nodeStatusMaxImages`, applied through the node configuration surface that ACP offers for the cluster topology in question. The end state is the same as the underlying KubeletConfiguration below; the cluster-operator-facing API is just the ACP node-configuration resource.

### Underlying mechanics — raise the image-reporting cap

The workaround is to remove the cap on reported images by setting `nodeStatusMaxImages: -1`. The value `-1` tells the kubelet to report the full image list on every node status update.

The upstream kubelet reads this field from its `KubeletConfiguration`:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
# Report the full image list; removes the 50-image cap
nodeStatusMaxImages: -1
```

On ACP, surface the same field through the node-configuration resource that targets the worker pool backing the HCP tenant cluster (via the node-configuration in-core capability, or — for cluster profiles where node content is fully declarative — through the **Immutable Infrastructure** extension). The controller applies the field into the rendered kubelet config for the selected pool, rolls out the change, and restarts the kubelet cleanly.

Verify the applied configuration on a node:

```bash
kubectl debug node/<node> -- chroot /host cat /etc/kubernetes/kubelet.conf
```

The resulting config should include `nodeStatusMaxImages: -1`, and `kubectl get node <node> -o json | jq '.status.images | length'` should be able to report more than 50 entries once the node has cached that many.

### Trade-off to accept

Reporting every image on every status update makes each `Node` object larger. On clusters with very large per-node image caches the serialised size may grow enough to matter for API-server bandwidth and etcd watch throughput. For HCP / KubeVirt-backed workers the image count per node is usually bounded by what the VM image supports (tens of distinct images, not thousands), so the size cost is negligible compared to the scheduling win. On cluster profiles where image count per node is huge, set a higher bound instead of `-1` (for example `250`) to keep the reporting overhead bounded.

## Diagnostic Steps

Confirm that the observed imbalance correlates with `Node.status.images` truncation:

```bash
kubectl get node -o json | jq '.items[] | {name: .metadata.name, imageCount: (.status.images | length)}'
```

If the nodes with small image counts correspond to the under-loaded nodes, and the heavily loaded nodes each report exactly 50 images, the hypothesis is confirmed.

Compare scheduler decisions against image-locality scores for a representative pending pod:

```bash
kubectl -n <ns> get pod <pod> -o yaml | yq '.status.conditions'
kubectl -n kube-system logs deploy/kube-scheduler --tail=500 \
  | grep -E 'ImageLocality|Filter|Score' | grep <pod-name>
```

On a cluster where the default scheduler log verbosity is raised, the `ImageLocality` score for each candidate node appears in the log. Nodes with truncated image lists report zero or near-zero score for already-cached images — the smoking-gun output.

After applying the kubelet change, watch the image count per node recover and new scheduling decisions re-balance:

```bash
kubectl get node -o wide
kubectl top node
kubectl get pod -A -o wide | awk '{print $8}' | sort | uniq -c
```

The last command counts pods per node and is a quick visual check that the distribution evened out.
