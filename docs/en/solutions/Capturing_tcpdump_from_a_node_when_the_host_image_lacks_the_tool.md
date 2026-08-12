---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Capturing tcpdump from a node when the host image lacks the tool
## Issue

Cluster engineers regularly need a packet capture taken on the worker node itself — bond interface, the CNI bridge, the host-side veth, or `lo` — for diagnosing slow or dropped traffic. Many cluster nodes run a minimal, immutable host image that does not ship `tcpdump`. Installing it on the host (`yum install`, `apt install`) is either impossible or violates the immutable-image contract, and SSHing in just to run an ad-hoc binary leaves no audit trail.

The need is to run `tcpdump` against a node's interfaces from a transient pod, save the resulting `.pcap` to durable storage, and clean up afterwards — all through the cluster API.

## Resolution

Use `kubectl debug` to drop a privileged debug pod onto the target node. The debug pod runs in the host network namespace, mounts `/` of the host at `/host` inside the container, and bundles the standard troubleshooting tools (`tcpdump`, `ss`, `tshark`, `iproute`, `ethtool`, ...) so the capture can start immediately:

```bash
NODE=worker-3.lab.example.com
kubectl debug node/"$NODE" -it --image=registry.example.com/support/network-tools:latest -- bash
```

`kubectl debug node/X` schedules a transient pod with `hostNetwork: true`, `hostPID: true`, and the host filesystem mounted at `/host`. Anything written under `/host/var/tmp/` lands on the node's filesystem and survives the pod's deletion; anything else lives only inside the pod and is gone when the session ends.

Note: the cluster's PodSecurity admission policy on ACP rejects `chroot /host` even with privileged + hostPath enabled — every example below writes to and reads from `/host/<path>` directly rather than chrooting in.

If the cluster does not maintain its own debug image, use any image that has `tcpdump`. A minimal alternative is the upstream `nicolaka/netshoot` image. For air-gapped environments, mirror the chosen image into the cluster registry first and reference the mirror path.

### Capture into a node-local file

Once inside the debug pod, run `tcpdump` against the host interface, writing into the host's filesystem:

```bash
INTERFACE=eth0
HOSTNAME=$(hostname)
FILENAME="/host/var/tmp/${HOSTNAME}_${INTERFACE}_$(date +%Y%m%d-%H%M%S).pcap"

tcpdump -nn -s 0 -i "$INTERFACE" -w "$FILENAME" \
  'host 10.0.0.5 and port 8080'
```

`-s 0` keeps the full packet payload; trim with a smaller snap length if disk pressure is a concern. The trailing BPF filter follows the standard `tcpdump` syntax — restrict by host, port, protocol or direction to keep the file size manageable for long captures.

For multi-interface capture, run several `tcpdump` instances in parallel writing to distinct files (`-i any` collapses encapsulation and is rarely useful for CNI debugging).

### Pull the file off the node

The simplest transfer path is `kubectl cp` from the debug pod's view of `/host/var/tmp/`. With the debug session still active in one terminal:

```bash
DEBUG_POD=$(kubectl get pod -n default -o name \
  | grep -E '^pod/node-debugger-' | head -1)

kubectl cp "default/${DEBUG_POD#pod/}:host/var/tmp/${HOSTNAME}_${INTERFACE}_*.pcap" \
  "./${HOSTNAME}-${INTERFACE}.pcap"
```

(Adjust the namespace and pod-name pattern to match the cluster's `kubectl debug` placement.) For long captures or large files, copy to an intermediate ConfigMap or attach to an existing log-export sidecar rather than streaming through the apiserver, which limits in-flight payloads.

### Clean up

Delete the .pcap from the node, then exit the debug session — the debug pod is removed automatically:

```bash
rm "/host/var/tmp/${HOSTNAME}_${INTERFACE}_"*.pcap
exit
```

Confirm the debug pod has terminated:

```bash
kubectl get pods -A | grep debugger
```

If a pod is left behind (for instance because the session was closed forcibly), delete it explicitly:

```bash
kubectl delete pod -n default node-debugger-<node-name>-<hash>
```

## Diagnostic Steps

If `kubectl debug node/X` fails to schedule the debug pod, the most common causes are:

- The user lacks `pods/debug` on the node — verify with `kubectl auth can-i create pods/debug --subresource=debug`.
- The cluster's PodSecurity admission denies privileged pods in the chosen namespace. Either run the debug pod in a namespace whose PSS label is `privileged`, or switch namespaces explicitly (`kubectl debug --profile=netadmin -n debug-tools`).
- The node is `Unreachable` or the kubelet is down. In that case, no pod can be scheduled there; SSH access (if available) is the fallback, but a healthy CNI is the safer route.

If `tcpdump` shows zero packets when traffic is expected, confirm the interface name matches the actual host NIC (the in-pod `ip link` shares the host network namespace because the debug pod uses `hostNetwork`):

```bash
ip -br link
```

For pods that talk to each other through the CNI, the relevant interface is usually a `veth` pair on the host or the CNI bridge — capture on the bridge to see all pod-to-pod traffic on that node.

If the file size grows uncontrollably, rotate captures with `-C <MB>` and keep the last few:

```bash
tcpdump -nn -s 0 -i "$INTERFACE" \
  -C 100 -W 5 \
  -w "$FILENAME"
```

This produces five 100 MB rotating files, which is enough to retain the last few minutes of a high-throughput link without filling the node's `/var/tmp`.

If the capture must be taken inside a workload pod rather than on the node (for instance to see the post-NAT view from the workload), run a separate ephemeral container against the target pod with `kubectl debug -c capture --image=<network-tools-image> --target=<container> <pod>` and redirect the output through `kubectl cp` from the ephemeral container's filesystem.
