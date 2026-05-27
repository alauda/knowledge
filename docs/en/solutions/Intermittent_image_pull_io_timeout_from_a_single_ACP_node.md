---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Intermittent image-pull i/o timeout from a single ACP node

## Issue

On an Alauda Container Platform cluster (kube-apiserver image `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5`, Kubernetes `v1.34.5`), a workload pod stays in `ImagePullBackOff` while pods of the same image start normally on other nodes. The kubelet event surfaced for the failing node carries a Go-style network error of the form `Failed to pull image "...": ... dial tcp <registry-ip>:443: i/o timeout`, indicating the node could not complete the TCP handshake to the registry endpoint inside the container runtime's image-pull timeout window.

## Root Cause

The error string is emitted verbatim by the container runtime when the underlying `net.Dial` to the registry's HTTPS endpoint exceeds the pull deadline. It is not a registry-side rejection, an authentication problem, or a manifest issue — the request never reaches HTTP at all. When the same image pulls correctly from other nodes in the same cluster, the failure is localized to the affected node's outbound network path to the registry rather than to the registry service or to cluster-wide settings.

Image-pull traffic on this cluster comes from the kubelet and container runtime on the node's host network stack rather than from inside a pod's network namespace, and is therefore not subject to pod-network NetworkPolicy enforcement regardless of which NetworkPolicy objects exist in the cluster. The fix surface is the node host's outbound path — firewall, web proxy, or upstream network device on the egress route — rather than any Kubernetes-level policy object.

## Resolution

Restore reachability from the affected node to the registry endpoint on TCP/443. Verify the node's egress firewall rules permit the registry IP and port, that any web proxy configured for the runtime is reachable and forwarding correctly, and that intermediate network devices on the node's path are not dropping or rate-limiting the connection. Once the host-level path to the registry is healthy, the container runtime's next pull attempt completes the TCP handshake and the pod proceeds out of `ImagePullBackOff`.

When the registry is a self-hosted one — on ACP the in-cluster registry is `registry.alauda.cn:60080`, from which every workload pulls — also inspect the registry's own service logs for the same time window. A service-side error or rate limit on the registry can present alongside, or independently of, node-side network faults, and the registry's logs are the primary place to confirm or rule out a service-side cause on ACP.

## Diagnostic Steps

Reproduce the pull directly on the affected node using the runtime's manual-pull tooling. ACP nodes run `containerd://2.2.1-5` on Ubuntu 22.04.1 LTS, so the manual-pull diagnostic is `crictl pull` (or `nerdctl pull`) against the same image reference the failing pod requested. If the manual pull returns the same `dial tcp ...:443: i/o timeout`, the failure is at the node-to-registry network layer, independent of the kubelet's image-pull bookkeeping or any pod-level configuration. Substitute the failing pod's exact image reference for `REPO/IMAGE:TAG` below (for example `tkestack/kube-apiserver:v1.34.5`):

```bash
crictl pull registry.alauda.cn:60080/REPO/IMAGE:TAG
```

Localize the problem to a single node by attempting the same pull from a second, healthy worker. The cluster topology (one control-plane plus three workers, each with its own InternalIP) makes per-node comparison straightforward: identify the node whose pull times out by InternalIP, and confirm at least one other node completes the same pull. A pull that succeeds on the other node and times out only on the affected node confirms the failure is bound to that node's egress, not to the registry or to cluster-wide configuration.

Distinguish network-layer failure from a registry-side or auth-side failure by issuing an unauthenticated probe to the registry's `/v2/` endpoint from the affected node. Any conformant OCI Distribution registry — including `registry.alauda.cn:60080` — replies to an unauthenticated `GET /v2/` with HTTP `401 UNAUTHORIZED` when the endpoint is reachable:

```bash
curl -v https://registry.alauda.cn:60080/v2/
```

A `401 UNAUTHORIZED` response from this command shows that the TCP/443 path from the node to the registry is open and the registry's HTTP front end is responsive; the symptom is then not a network-path failure, and investigation should move to credentials or the specific repository being pulled. A `connect: timed out`, `connection refused`, or no-response outcome from the same `curl -v` indicates the network path itself is broken, matching the runtime's `dial tcp ...:443: i/o timeout` and pointing back at the node's egress firewall, proxy, or route.
