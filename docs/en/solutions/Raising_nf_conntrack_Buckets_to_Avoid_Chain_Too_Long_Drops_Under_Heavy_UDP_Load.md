---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Raising nf_conntrack Buckets to Avoid Chain-Too-Long Drops Under Heavy UDP Load
## Issue

A heavy load test against a single host — roughly 35 000 requests per second of UDP (or bursty TCP with rapid connection turnover) landing on the primary interface of a node — starts dropping SYN packets and failing kubelet health probes on every pod hosted on that node. Symptoms seen on the host:

- `conntrack -S` reports a large and growing `chaintoolong` counter per CPU:

  ```text
  conntrack -S | grep -v chaintoolong=0
  cpu=0 found=9466 invalid=5 insert=0 insert_failed=18776 drop=2  chaintoolong=18774
  cpu=1 found=6028 invalid=14 insert=0 insert_failed=17933 drop=1 chaintoolong=17932
  ...
  ```

- Pods flap between `Ready=True` and `Ready=False` while the load test is running. ICMP to the affected node is lossy.
- Packet captures taken simultaneously on the node's CNI port and inside the destination pod show that many SYN packets sent by kubelet (via the node-local CNI port) never arrive inside the pod — they are dropped silently in the networking stack.

## Root Cause

The kernel connection tracker (`nf_conntrack`) stores flow entries in a hash table. Under sustained high connection rates, collisions at the same hash bucket form long chains; once a chain exceeds the allowed length the kernel aborts insertion rather than traversing further, and the new flow is dropped. The counters above (`insert_failed`, `chaintoolong`) are exactly that failure mode.

On a stock cluster `nf_conntrack_buckets` defaults to `262144` (or `1048576` on larger-memory nodes), while `nf_conntrack_max` is often sized much higher. That asymmetry is the trap: the total table capacity looks ample, but because the bucket count is small, average chain length grows linearly with load and passes the safety threshold well before the table itself is full.

The behaviour is kernel / CNI agnostic in the sense that any CNI routing traffic through the host netfilter path can hit it. On Kube-OVN-backed ACP the kubelet-to-pod path goes through the host-side veth + conntrack, so the same sysctl tuning applies; the `ovn-k8s-mp0`-style naming in the upstream report is an artefact of OVN-Kubernetes but the underlying kernel limit is the same.

More recent kernels (5.14.0-284.105.1 and later on the 9.2 family, or equivalent upstream 6.x fixes) raise the cap internally; if the node OS ships a kernel at or above that revision the `chaintoolong` counter stops climbing at the same load. Before that kernel fix landed, the only option was to enlarge the bucket table.

## Resolution

Increase both `nf_conntrack_buckets` and `nf_conntrack_max` so chain length stays below the threshold at your expected request rate. On most bare-metal worker nodes running heavy ingress traffic, a starting point is two million of each; nodes handling tens of thousands of new flows per second per CPU need more.

### 1. Validate the fix with a runtime change

On one affected node, apply the new values live and rerun the load test:

```bash
sudo sysctl -w net.netfilter.nf_conntrack_buckets=2000000
sudo sysctl -w net.netfilter.nf_conntrack_max=2000000

sysctl -a | grep -E 'conntrack_max|conntrack_buckets'
# net.netfilter.nf_conntrack_buckets = 2000384   # kernel rounds up to fill 512-byte slots
# net.netfilter.nf_conntrack_max     = 2000000
```

The `buckets` value is rounded up so the hash table exactly fills its slots (512 bytes each); that is expected. If `chaintoolong` stops incrementing and pod readiness stabilises, the tuning is correct and you can make it persistent.

### 2. Persist on ACP via Immutable Infrastructure

ACP's node-configuration story maps the OSS MachineConfig / node-tuning pattern onto the **Immutable Infrastructure** extension (see `kb/ACP_CAPABILITIES.md` for the full list). Declare the sysctl values in a node-tuning / node-config object so new and rebuilt nodes always boot with the larger table:

```yaml
# ACP node-config snippet (adapt the CR kind/name to the version in your cluster)
spec:
  sysctl:
    - name: net.netfilter.nf_conntrack_buckets
      value: "2000000"
    - name: net.netfilter.nf_conntrack_max
      value: "2000000"
```

If the cluster is not yet on Immutable Infrastructure, the fallback is a Kubernetes-native DaemonSet that writes the same values to `/etc/sysctl.d/` and runs `sysctl -p` on each node. Example manifest (drop-in sysctl file + oneshot systemd-style container, runs on every matching worker):

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sysctl-conntrack
  namespace: kube-system
spec:
  selector:
    matchLabels: {name: sysctl-conntrack}
  template:
    metadata:
      labels: {name: sysctl-conntrack}
    spec:
      hostPID: true
      tolerations:
        - operator: Exists
      containers:
        - name: sysctl
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - /bin/sh
            - -ec
            - |
              sysctl -w net.netfilter.nf_conntrack_buckets=2000000
              sysctl -w net.netfilter.nf_conntrack_max=2000000
              sleep infinity
```

Do not set `nf_conntrack_buckets` inside a pre-baked tuning profile's `[sysctl]` stanza — on the kernel, the bucket count is linked to `nf_conntrack_hashsize` and sysctl writes to `nf_conntrack_buckets` are ignored when the profile writer puts them in the sysctl section. Either set `nf_conntrack_hashsize` in the kernel parameters section, or write the value via sysctl directly on the running host.

### 3. Size sensibly

Larger tables consume RAM and add a small overhead to every lookup. Budget the memory cost: each bucket is 512 bytes, so two million buckets occupies about one GiB. On nodes with 64 GiB+ of memory and heavy connection turnover, two to five million is a reasonable range; beyond that, consider whether the workload should be split across more nodes instead of continuing to enlarge the table.

## Diagnostic Steps

1. Capture conntrack counters on the affected node and look for non-zero `chaintoolong`:

   ```bash
   sudo conntrack -S | grep -v chaintoolong=0
   ```

2. Correlate with pod readiness transitions during the same window:

   ```bash
   kubectl get events -A --field-selector type=Warning \
     | grep -E 'Unhealthy|ProbeWarning'
   ```

3. Capture traffic on every interface on the suspect node. The kubelet-to-pod direction traverses the host CNI port, so dropped SYNs will appear on the CNI side but not inside the pod's network namespace:

   ```bash
   for iface in $(ip -o link show | awk -F': ' '/mtu/ {print $2}'); do
     echo $iface
     tcpdump -B 20480 -i $iface -C 200 -W 5 -w /tmp/$iface.pcap &
   done
   # stop after the load test: pkill tcpdump
   ```

   Pick a single client source port that failed and grep both pcaps. A flow that is visible on the CNI side but absent inside the pod confirms a netfilter drop.

4. After raising the sysctl values, rerun the load test with `conntrack -S` sampled every few seconds. The `chaintoolong` counter should stay flat. Pod readiness and ICMP to the node should stabilise. Leave the sampling in place for at least one full test cycle before declaring the fix.
