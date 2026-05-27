---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Disabling IPv6 Inside a Pod via Unsafe Sysctls on ACP

## Issue

A workload needs IPv6 turned off inside its own network namespace on Alauda Container Platform, which is done by setting kernel sysctls on the pod. Sysctls are configured per-pod through `.spec.securityContext.sysctls`, a list of `{name, value}` entries where both `name` and `value` are strings. The two sysctls that disable IPv6 — `net.ipv6.conf.all.disable_ipv6` and `net.ipv6.conf.default.disable_ipv6` — fall outside the set the kubelet permits by default, so a pod requesting them is rejected unless the node has first been configured to allow them.

## Root Cause

Only namespaced sysctls can be set independently on an individual pod; node-level (non-namespaced) sysctls cannot be set from within Kubernetes through the pod API. Most sysctls in the `net.*` group are namespaced, though exactly which are namespaced depends on the kernel version and distributor. On ACP at Kubernetes v1.34.5 the kubelet whitelists only the sysctls it considers safe by default, and any sysctl outside that safe set is treated as unsafe. An unsafe sysctl requested by a pod is rejected unless it has first been enabled on the node's kubelet.

## Resolution

Enabling an unsafe sysctl is a per-node operation: the sysctl name is added to the kubelet's allowed-unsafe-sysctls list, exposed as the `allowedUnsafeSysctls` field in the kubelet configuration. By default this field is unset across nodes, so the kubelet permits only the safe whitelist and rejects unsafe requests. Add both IPv6 sysctl names to `allowedUnsafeSysctls` in the kubelet configuration on every node that must run the workload, since the allowlist is evaluated independently per node.

```yaml
# kubelet configuration fragment, applied per node
allowedUnsafeSysctls:
  - "net.ipv6.conf.all.disable_ipv6"
  - "net.ipv6.conf.default.disable_ipv6"
```

Once the unsafe sysctls are allowed on the node, IPv6 is disabled inside the pod by setting `net.ipv6.conf.all.disable_ipv6=1` and `net.ipv6.conf.default.disable_ipv6=1` under the pod's `securityContext.sysctls`. Each entry is a `{name, value}` pair carrying a required `name` and a required string `value`.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: ipv6-disabled
spec:
  securityContext:
    sysctls:
      - name: net.ipv6.conf.all.disable_ipv6
        value: "1"
      - name: net.ipv6.conf.default.disable_ipv6
        value: "1"
  containers:
    - name: app
      image: <image>
```

## Diagnostic Steps

Confirm the node's kubelet allowlist before deploying: while `allowedUnsafeSysctls` is unset — the default observed across nodes — the kubelet enforces the safe whitelist only, so a pod requesting either IPv6 sysctl is rejected. A pod carrying these sysctls under `securityContext.sysctls` can therefore be permitted only after the names have been added to the kubelet `allowedUnsafeSysctls` list.

```bash
# Inspect a scheduled pod's configured sysctls
kubectl get pod ipv6-disabled \
  -o jsonpath='{.spec.securityContext.sysctls}'
```

Verify the value shape — each configured sysctl is a `{name, value}` entry where `value` is a string such as `"1"`.
