---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500424
---

# kube-apiserver Secret watch-cache LIST fails with gRPC ResourceExhausted when cumulative Secret bytes exceed the apiserver-etcd message size on ACP

## Issue

On Alauda Container Platform running Kubernetes `v1.34.5` (kube-apiserver image `tkestack/kube-apiserver:v1.34.5`, etcd image `tkestack/etcd:v3.5.28-260325`), the kube-apiserver pods are kubeadm-style static pods in the `kube-system` namespace and reach a single-member etcd over a TLS gRPC channel to `https://127.0.0.1:2379` using the `apiserver-etcd-client` certificate; the watch-cache subsystem (`cacher.go`) inside the apiserver issues an initial LIST against etcd for all `*core.Secret` objects, and the response is returned as a single gRPC message on that apiserver-etcd connection.

When the size of that single LIST response exceeds the gRPC client's maximum receive message size, the kube-apiserver Secret watch-cache cannot initialize and the cacher emits an `unexpected ListAndWatch error: failed to list *core.Secret: rpc error: code = ResourceExhausted desc = grpc: trying to send message larger than max (<actual-bytes> vs. <limit-bytes>)` line from `cacher.go`; the same `cacher.go:<line>]` emitter format is observed in the ACP kube-apiserver log on this build. While the cacher is stuck reinitializing in this state, Secret LIST and WATCH requests that would normally be served from the kube-apiserver Secret watch-cache cannot complete successfully.

## Root Cause

The apiserver-to-etcd connection on this build uses plain upstream gRPC, and the kube-apiserver does not expose a flag to raise its gRPC client-side `MaxRecvMsgSize` for the etcd channel; the kube-apiserver command line on this build carries only the `--etcd-cafile` / `--etcd-certfile` / `--etcd-keyfile` / `--etcd-servers` flags with no gRPC message-size override, so the upstream gRPC default of `math.MaxInt32` (2147483647 bytes, approximately 2 GiB) for `MaxRecvMsgSize` / `MaxSendMsgSize` applies to the apiserver-etcd channel verbatim.

The condition that trips this failure is structural: the cumulative on-disk size of all `core/v1` Secret objects stored under the `/kubernetes.io/secrets/` prefix in etcd has to exceed the gRPC maximum receive message size in use (the ~2 GiB ceiling at the default) for the single LIST response carrying every Secret to overflow the gRPC message limit and produce the `ResourceExhausted` error above. On the inspected cluster the current footprint is 122 Secrets cluster-wide totalling roughly 1.1 MB of apiserver JSON, four orders of magnitude below the default ceiling; the failure mode is structurally possible but is not active on this environment.

## Resolution

Delete `core/v1` Secret objects whose combined size brings the cumulative `/kubernetes.io/secrets/` footprint in etcd back below the gRPC maximum receive message size in effect on the apiserver-etcd connection; this restores the kube-apiserver Secret watch-cache's ability to complete its initial LIST and serve Secret LIST/WATCH requests again. The Secret DELETE path on ACP is the standard upstream `core/v1` Secret DELETE through the kube-apiserver, and bringing the prefix below the ~2 GiB gRPC ceiling reinstates cacher initialization.

Target the largest Secrets first, identified by the diagnostic procedure below, and prefer removing Secrets that are recreated by their controllers (for example, regenerated TLS material) or that are demonstrably unused before deleting any Secret whose contents cannot be reconstructed:

```bash
kubectl delete secret <name> -n <namespace>
```

Note that the ACP etcd process is launched with `--max-request-bytes=3145728` (3 MiB) and `--quota-backend-bytes=8589934592` (8 GiB); these are server-side etcd limits and are distinct from the apiserver-side gRPC `MaxRecvMsgSize` ceiling that governs the LIST response described above, so changes to those etcd flags do not alter the apiserver-side ceiling that this failure mode trips.

## Diagnostic Steps

Confirm the cacher emission on the kube-apiserver pod in `kube-system`; the `cacher.go` lines around watch-cache initialization for `*core.Secret` carry the `ResourceExhausted` shape when the failure is active:

```bash
kubectl -n kube-system get pods -l component=kube-apiserver
kubectl -n kube-system logs <kube-apiserver-pod> | grep -E 'cacher\.go|ResourceExhausted|\*core\.Secret'
```

Enumerate per-Secret on-disk sizes directly from etcd to identify the heaviest contributors to the `/kubernetes.io/secrets/` prefix. The etcd image on ACP ships `etcdctl` version `3.5.28` (API 3.5) in-container, and the etcd static pod in `kube-system` is reached with `kubectl exec` plus the cluster-CA and client-cert flags mounted at the standard kubeadm paths:

```bash
kubectl -n kube-system exec etcd-<node> -- \
  etcdctl \
    --endpoints=https://127.0.0.1:2379 \
    --cacert=/etc/kubernetes/pki/etcd/ca.crt \
    --cert=/etc/kubernetes/pki/etcd/server.crt \
    --key=/etc/kubernetes/pki/etcd/server.key \
    get --prefix --keys-only /kubernetes.io/secrets/
```

For each key returned, the value's protobuf byte length gives the per-Secret on-disk size; wrapping the per-key `etcdctl get <key> -w protobuf` in a loop over the key list and piping its response through `wc -c` produces a `<size> <key>` tally that can be sorted in descending order to rank the heaviest Secrets and identify the candidates for deletion under Resolution:

```bash
kubectl -n kube-system exec etcd-<node> -- sh -c '
  for key in $(etcdctl \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      get --prefix --keys-only /kubernetes.io/secrets/); do
    size=$(etcdctl \
      --endpoints=https://127.0.0.1:2379 \
      --cacert=/etc/kubernetes/pki/etcd/ca.crt \
      --cert=/etc/kubernetes/pki/etcd/server.crt \
      --key=/etc/kubernetes/pki/etcd/server.key \
      get "$key" -w protobuf | wc -c)
    echo "$size $key"
  done | sort -rn
'
```

Sum the per-Secret protobuf byte lengths across the entire `/kubernetes.io/secrets/` prefix to estimate the cumulative footprint and compare it against the ~2 GiB default gRPC ceiling; this is the quantity the cacher LIST response carries in a single gRPC message and is the figure that has to drop below the ceiling for the watch-cache initialization to succeed again.
