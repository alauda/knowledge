---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

ACP Virtualization is configured to use a **dedicated migration network** — a Multus `NetworkAttachmentDefinition` that gives every `virt-handler` pod a second interface used exclusively for live-migration traffic between hypervisor nodes. Live migration of VMs between most nodes works, but migrations between specific node pairs hang or fail with timeout / connection-refused at the network layer.

The administrator wants to verify, end to end, that **every** `virt-handler` can reach **every** other `virt-handler` over the dedicated migration network — and to surface the problem pair quickly so the network team can dig in.

## Root Cause

Live migration between two nodes happens between their `virt-handler` pods over the migration network's interface (port `8443/tcp`, TLS-protected). For migration to work the path must satisfy three conditions:

1. The Multus NAD attaches a working interface to every `virt-handler` pod (an IP is assigned, the link is up).
2. Every `virt-handler` IP on that network can reach every other `virt-handler` IP on the same network — no underlay drops, no firewall in the middle.
3. The receiving side accepts the TLS handshake on `:8443` and serves `/healthz`.

Any condition that holds globally except for one pair fails silently in production: `virt-controller` schedules the migration and the source `virt-handler` opens a connection to the destination's migration IP — and waits. There is no proactive health check on the migration network from the platform.

The fix path is therefore **diagnostic**: run a full pairwise reachability matrix between every `virt-handler`'s migration-network IP and surface any pair that fails or has unreasonable latency. Once the failing pair is known, the underlying cause (VLAN config, node firewall, NAD CNI plugin issue) is investigated by the network team.

## Resolution

### Step 1 — find the dedicated migration network's NAD name

The KubeVirt HyperConverged CR (or its ACP-Virt equivalent) carries the live-migration config. The `network` field is the NAD name:

```bash
NS=<kubevirt-namespace>     # e.g. kubevirt
HCO=<hyperconverged-name>   # e.g. kubevirt-hyperconverged

NAD=$(kubectl -n "$NS" get hyperconverged "$HCO" \
  -o=jsonpath='{.spec.liveMigrationConfig.network}')
echo "Migration NAD: $NAD"
```

If the field is empty, no dedicated migration network is configured and migration uses the default pod network — this article does not apply, look for a node-firewall or pod-network issue instead.

### Step 2 — collect each virt-handler's migration-network IP

Multus attaches additional interfaces to each pod and records them in the `k8s.v1.cni.cncf.io/network-status` annotation. Parse the annotation to find the IP each pod has on the migration NAD:

```bash
NS=<kubevirt-namespace>

kubectl -n "$NS" get pod -l kubevirt.io=virt-handler -o=json | \
  jq -r --arg nad "$NAD" '
    .items[] |
    .metadata.name as $name |
    (.metadata.annotations["k8s.v1.cni.cncf.io/network-status"] // "[]" | fromjson) as $nets |
    ($nets[] | select(.name | contains($nad)) | .ips[0]) as $ip |
    "\($name) \($ip)"
  '
```

Expected output (one line per node):

```
virt-handler-4gv7h 192.168.4.1
virt-handler-7d77r 192.168.4.2
virt-handler-9k2lm 192.168.4.3
...
```

If any expected pod is missing from the list, that pod has no IP on the migration NAD — investigate Multus / NAD attachment for that node first (look at events on the pod, the NAD CR, and the CNI plugin logs).

Save the table to a variable for the next step:

```bash
mapfile -t PODS < <(kubectl -n "$NS" get pod -l kubevirt.io=virt-handler -o=json | \
  jq -r --arg nad "$NAD" '
    .items[] |
    .metadata.name as $name |
    (.metadata.annotations["k8s.v1.cni.cncf.io/network-status"] // "[]" | fromjson) as $nets |
    ($nets[] | select(.name | contains($nad)) | .ips[0]) as $ip |
    "\($name) \($ip)"')
```

### Step 3 — run the pairwise reachability matrix

For every pair `(src, dst)` where `src != dst`, exec into the source pod and `curl` the destination's `/healthz` over the migration IP. Record TCP + TLS handshake timings:

```bash
for src in "${PODS[@]}"; do
  src_pod=${src%% *}
  for dst in "${PODS[@]}"; do
    dst_pod=${dst%% *}
    dst_ip=${dst##* }
    [[ "$src_pod" == "$dst_pod" ]] && continue
    printf "%s -> %s (%s): " "$src_pod" "$dst_pod" "$dst_ip"
    kubectl -n "$NS" exec "$src_pod" -c virt-handler -- \
      curl -o /dev/null -sk \
        "https://${dst_ip}:8443/healthz" \
        -w "tcp:%{time_connect}s tls:%{time_appconnect}s total:%{time_total}s code:%{http_code}\n"
  done
done
```

Reasonable steady-state numbers on a healthy migration network (10 GbE underlay):

- `tcp_handshake`: < 0.001 s
- `tls_handshake`: < 0.010 s
- `total`: < 0.015 s
- `http_code`: 200

A pair that fails Step 3 manifests as one of:

- `total` > 5 s with `tcp:0` → no L3 path or firewall drop.
- `total` > 5 s with `tcp:<small>` and `tls:0` → TCP works but the TLS handshake hangs (cert/SNI issue, or the receiver is not actually listening on 8443).
- `code: 000` → the connection failed before Envoy could write a status.
- `total: 30s+` → kernel/curl default timeout, treat as outright failure.

### Step 4 — narrow the failing pair

Once Step 3 surfaces a pair, dig into the failing direction with extra detail:

```bash
SRC=virt-handler-<bad-src>
DST_IP=192.168.4.<bad-dst-ip>

kubectl -n "$NS" exec "$SRC" -c virt-handler -- \
  curl -vk "https://${DST_IP}:8443/healthz" 2>&1 | head -30
```

The verbose output shows where the conversation stops:

- "Trying ... Connection timed out" → underlay path missing.
- "TLS handshake … connection reset" → receiver not really listening on the migration IP, or middlebox interfering.
- "certificate verify failed" → certificate plumbing on the dedicated network is broken.

Cross-check with the destination node's perspective. SSH (or node-debug) to the destination node and observe the listener:

```bash
DST_NODE=<destination-node-name>
kubectl debug node/"$DST_NODE" --image=docker.io/library/ubuntu:22.04 -it -- chroot /host bash

ss -ltn | grep 8443
# Should list 0.0.0.0:8443 or the dedicated-network IP:8443

# Watch incoming traffic during a re-run of Step 3 from the source side:
tcpdump -nn -i any port 8443 and host <src-migration-ip> -c 20
```

If `tcpdump` shows the SYN arriving but no SYN-ACK leaving, the receiver is the problem (listener bound to the wrong interface). If no SYN ever arrives, the underlay drops it.

### Step 5 — capture the matrix as a baseline / regression check

Once the cluster is healthy, save Step 3's output as a baseline. Re-run after any node/network change (NAD edit, switch firmware update, VLAN reconfig) and compare. Latency creep is often the leading indicator of a future failure.

A cron-friendly version that posts only failures to a webhook:

```bash
#!/bin/bash
NS=kubevirt
HCO=kubevirt-hyperconverged
NAD=$(kubectl -n "$NS" get hyperconverged "$HCO" \
  -o=jsonpath='{.spec.liveMigrationConfig.network}')
mapfile -t PODS < <(kubectl -n "$NS" get pod -l kubevirt.io=virt-handler -o=json | \
  jq -r --arg nad "$NAD" '.items[] |
    .metadata.name as $n |
    (.metadata.annotations["k8s.v1.cni.cncf.io/network-status"] // "[]" | fromjson |
     .[] | select(.name | contains($nad)) | .ips[0]) as $i |
    "\($n) \($i)"')
fail=0
for src in "${PODS[@]}"; do
  for dst in "${PODS[@]}"; do
    [[ "${src%% *}" == "${dst%% *}" ]] && continue
    code=$(kubectl -n "$NS" exec "${src%% *}" -c virt-handler -- \
      curl -o /dev/null -sk -m 3 "https://${dst##* }:8443/healthz" -w '%{http_code}')
    if [[ "$code" != 200 ]]; then
      echo "FAIL ${src%% *} -> ${dst%% *} (${dst##* }) code=$code"
      fail=1
    fi
  done
done
exit $fail
```

Wire to a Prometheus blackbox-exporter probe, or run as a `CronJob` and route failures to alertmanager / Slack.

## Diagnostic Steps

If Step 3 shows every pair failing, the problem is global rather than per-pair:

- Recheck Step 2 — the NAD name might be wrong (typo in `liveMigrationConfig.network`).
- Confirm the NAD CR exists: `kubectl get net-attach-def -A | grep <NAD-name>`.
- Confirm `network-status` annotations are populated on every virt-handler pod.

For a single failing pair, also rule out the source side:

```bash
# Are migrations to the SAME destination from a third (working) source also fine?
# If yes -> source-side problem on the failing source.
# If no  -> destination-side problem.
```

If `tcpdump` on the destination shows the SYN-ACK leaving but the source never sees it, an asymmetric route exists — the reply takes a different path that drops it (often a firewall on a default interface that has no rule for the migration subnet). The fix lives on the underlay; surface it to the network team with the source/destination IPs and the offending node.

For chronic latency (Step 3 numbers slowly rising over time), the migration network is sharing capacity with another workload it should not be. Check switch port stats, NIC ring buffer drops (`ethtool -S <iface>`), and any QoS class configured on the network.
