---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cross-checking virt-handler-to-virt-handler reachability on a dedicated VM live-migration network

## Issue

When a dedicated Multus network is wired in for VM live migrations and one or more migrations between specific nodes start failing, the next step is usually to confirm that every `virt-handler` pod can reach every other `virt-handler` pod over that secondary network. On Alauda Container Platform `virt-handler` runs as a per-node DaemonSet in the `kubevirt` namespace, with pods labelled `kubevirt.io=virt-handler` and an agent container also named `virt-handler`. To localize a per-pair connectivity issue without running a full migration each time, the article walks a lightweight pairwise probe — exec into each `virt-handler`, curl the peer's `/healthz` over the dedicated migration interface, and read the TCP/TLS handshake timings out of `curl -w`.

## Root Cause

The dedicated VM live-migration network is selected by setting `HyperConverged.spec.liveMigrationConfig.network` to the `<namespace>/<name>` of a Multus `NetworkAttachmentDefinition` (CRD `network-attachment-definitions.k8s.cni.cncf.io`); the CRD's own description states the field's purpose verbatim, "The migrations will be performed over a dedicated multus network to minimize disruption to tenant workloads due to network saturation when VM live migrations are triggered.". Once that field is set, `virt-handler` attaches each of its pods to the referenced secondary network, and Multus writes a `k8s.v1.cni.cncf.io/network-status` annotation onto each pod whose value is a JSON array of `{name, interface, ips, mac}` entries — one per attachment. The entry whose `name` matches the dedicated migration NAD carries the IP each `virt-handler` uses on that secondary interface. The receiving end of the probe is `virt-handler`'s own `/healthz` HTTPS endpoint on TCP port 8443 — the same endpoint kubelet uses for its liveness and readiness probes (`httpGet path=/healthz port=8443 scheme=HTTPS`), TLS-terminated with a self-signed certificate managed by `virt-operator` (which is why the probe uses `curl -k`). A failed or significantly slow handshake between a specific pair therefore localizes the connectivity problem to the L2/VLAN underlay between those two nodes' migration-network NICs, since both peers run the same `virt-handler` image and certificate set.

## Resolution

First read the NAD reference that the cluster's HyperConverged points at — it is the value of `spec.liveMigrationConfig.network`:

```bash
NAD=$(kubectl -n kubevirt get hyperconverged kubevirt-hyperconverged \
  -o jsonpath='{.spec.liveMigrationConfig.network}')
echo "$NAD"
```

If `NAD` comes back empty, the dedicated migration network has not been wired in yet — set the field on the HyperConverged CR first and let `virt-handler` reroll, then re-read the value before continuing.

Next, for each `virt-handler` pod read its `k8s.v1.cni.cncf.io/network-status` annotation, select the entry whose `name` matches the migration NAD, and pull the first IP from its `ips` array — that IP is the pod's address on the dedicated migration network:

```bash
kubectl -n kubevirt get pods -l kubevirt.io=virt-handler -o json \
  | jq -r --arg nad "$NAD" '.items[]
      | .metadata.name as $name
      | (.metadata.annotations."k8s.v1.cni.cncf.io/network-status"
          | fromjson
          | .[] | select(.name | contains($nad)) | .ips[0]) as $ip
      | [$name, $ip] | join(" ")'
```

Then, for every ordered pair `(src, dst)` of `virt-handler` pods, exec into the source pod's `virt-handler` container and curl `https://<dst-ip>:8443/healthz`. The receiving endpoint is `virt-handler`'s own liveness/readiness probe target, so a successful response confirms both TCP reachability and that the receiving `virt-handler` is alive. The handshake timings come from `curl`'s write-out variables: `time_connect` is the cumulative seconds from start until the TCP connection completes, `time_appconnect` is the cumulative seconds until the SSL/TLS handshake completes, and `time_total` is the seconds the full operation lasted:

```bash
mapfile -t PODS < <(kubectl -n kubevirt get pods -l kubevirt.io=virt-handler -o json \
  | jq -r --arg nad "$NAD" '.items[]
      | .metadata.name as $name
      | (.metadata.annotations."k8s.v1.cni.cncf.io/network-status"
          | fromjson
          | .[] | select(.name | contains($nad)) | .ips[0]) as $ip
      | [$name, $ip] | join(" ")')

for src in "${PODS[@]}"; do
  for dst in "${PODS[@]}"; do
    src_pod=${src%% *}; dst_pod=${dst%% *}
    dst_ip=${dst##* }
    [[ "$src_pod" != "$dst_pod" ]] && {
      echo "$src_pod -> $dst_pod ($dst_ip):"
      kubectl -n kubevirt exec "$src_pod" -c virt-handler -- \
        curl -k -s -o /dev/null \
        -w 'tcp_handshake: %{time_connect}s\ntls_handshake: %{time_appconnect}s\ntotal: %{time_total}s\n' \
        "https://$dst_ip:8443/healthz"
    }
  done
done
```

For a dedicated low-latency migration NIC on a quiet L2 segment, expect TCP handshakes well under 1 ms, TLS handshakes well under 10 ms, and total request times well under 15 ms between any two `virt-handler` pods. Sample output for one healthy pair:

```text
virt-handler-4gv7h -> virt-handler-7d77r (192.168.4.1):
tcp_handshake: 0.000657s
tls_handshake: 0.007440s
total: 0.007879s
```

## Diagnostic Steps

Failures or significant outliers in the pairwise output point at the L2/VLAN underlay between the two pods' nodes — both peers run the same `virt-handler` image and the same `virt-operator`-managed certificate set, so the asymmetry has to live below KubeVirt. Common patterns to read from the pairwise output, all interpreted against the per-pair `time_connect` / `time_appconnect` / `time_total` columns:

- One direction times out (connection refused or hangs on TCP handshake): the NAD-attached interface on the destination node is not actually reachable from the source node — check the underlying VLAN/bond and the destination node's L2 path.
- Both directions complete TCP quickly but TLS is slow or fails: TCP-layer reachability is intact but something in front of port 8443 (MTU/fragmentation on a tunneled migration network, a firewall doing inspection, a flapping cable) is interfering with the SSL handshake.
- All pairs are slow uniformly compared to the sub-1ms / sub-10ms / sub-15ms guidance: this is a fabric-wide issue (saturation, sub-1Gbps NIC where 10Gbps was assumed, NIC offload bugs), not a single-pod problem.

A quick spot-check against a single peer, useful while iterating, uses the same `kubectl exec` + `curl -k -w` primitive as the loop but for one ordered pair only:

```bash
kubectl -n kubevirt exec virt-handler-<src> -c virt-handler -- \
  curl -k -s -o /dev/null \
  -w 'tcp=%{time_connect}s tls=%{time_appconnect}s total=%{time_total}s code=%{http_code}\n' \
  https://<peer-migration-ip>:8443/healthz
```

A successful response code of `200` confirms `virt-handler` is reachable and alive on the dedicated migration network from the source pod's perspective.
