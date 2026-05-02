---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# CoreDNS pods crashloop with "Wrong argument count" parsing error

## Issue

DNS pods enter `CrashLoopBackOff`. The pod log includes a Corefile
parsing error:

```text
plugin/forward: /etc/coredns/Corefile:19 - Error during parsing:
  Wrong argument count or unexpected line ending after '.'
```

Pod restarts emit the same line every time. Cluster DNS is unavailable
to all workloads while the pods are looping because the cluster's
DNS Service has no healthy backends.

## Root Cause

The CoreDNS configuration injected into the pods includes a `forward`
plugin block whose stanza is incomplete. The DNS Operator (or the
operator-equivalent that builds the Corefile from declarative
configuration) emits a `forward` block for every zone the operator's
custom resource declares — but if a zone entry is present in the
operator's CR with no `forwardPlugin` (no list of upstream resolvers,
or a malformed upstream entry), the resulting Corefile contains a
`forward .` (or `forward <zone>`) line with no following arguments.

CoreDNS parses Corefiles strictly. A `forward` directive must be
followed by at least one upstream resolver. A trailing `.` with no
upstream is rejected with the `Wrong argument count` error and the
pod fails to start the plugin chain. The pod exits, the kubelet
restarts it, and the cycle continues indefinitely.

The same shape applies to any operator that builds a CoreDNS Corefile
from a CR — a stale or mistakenly added zone entry without a forwarder
will reproduce the failure.

## Resolution

Inspect the operator-managed DNS configuration and either populate the
zone with a valid `forwardPlugin` or delete the zone entry entirely:

```bash
kubectl edit dns.operator default
```

The CR's `spec.servers` list contains entries of the form:

```yaml
servers:
  - name: ABC
    forwardPlugin:
      policy: Random
      upstreams:
        - 10.0.0.100
    zones:
      - ABC
  - name: XYZ          # <-- this entry has no forwardPlugin
    zones:
      - XYZ
```

Either:

### Option A — remove the orphaned zone entry

```yaml
servers:
  - name: ABC
    forwardPlugin:
      policy: Random
      upstreams:
        - 10.0.0.100
    zones:
      - ABC
```

Save and exit. The operator regenerates the Corefile, the DNS pods
restart with valid configuration, and the crashloop clears within a
single rollout cycle.

### Option B — finish the zone configuration

```yaml
- name: XYZ
  forwardPlugin:
    policy: Random
    upstreams:
      - 10.0.0.200
  zones:
    - XYZ
```

If the zone was added on purpose, supply at least one upstream
resolver. Use the same `policy` value as the existing entries unless
there is a reason to differ.

After the configuration is corrected the operator regenerates the
ConfigMap, the DNS Deployment rolls out the new Corefile, and the
pods leave `CrashLoopBackOff`. Cluster DNS resumes within seconds of
the new pods becoming Ready.

## Diagnostic Steps

1. Confirm the failure mode is the Corefile parser, not an unrelated
   crash:

   ```bash
   kubectl logs -n <dns-ns> <dns-pod> --previous \
     | grep -i "Error during parsing"
   ```

2. Inspect the rendered Corefile from the operator-managed ConfigMap:

   ```bash
   kubectl get configmap -n <dns-ns> -o yaml | yq '.items[].data.Corefile'
   ```

   Look for `forward .` or `forward <zone>` lines with no upstreams
   following them. The line number reported in the error message
   points at the offending entry.

3. Inspect the operator CR for the zone entry that produced the
   broken line:

   ```bash
   kubectl get dns.operator default -o yaml | yq '.spec.servers'
   ```

4. After applying the correction, watch the pods recover:

   ```bash
   kubectl get pods -n <dns-ns> -w
   ```

   The new pods reach `Running` and the crashloop counter stops
   incrementing.

5. Validate cluster DNS is functional from a workload pod:

   ```bash
   kubectl run dnscheck --rm -it --image=busybox -- nslookup kubernetes.default
   ```

   A successful answer confirms the DNS Service is back to having
   healthy backends.
