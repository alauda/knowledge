---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A `NodeNetworkConfigurationPolicy` (NNCP) that defines static routes does not apply. The corresponding `NodeNetworkConfigurationEnactment` (NNCE) reports:

```text
Provide file is not valid NetworkState or NetworkPolicy:
routes.config[].state: unknown variant `up`, expected `absent` or `ignore`
```

The offending stanza in the policy looks like:

```yaml
routes:
  config:
    - destination: 10.25.0.10/32
      metric: 150
      next-hop-address: 10.64.0.1
      next-hop-interface: vlan109
      state: up
      table-id: 254
```

## Root Cause

NMState's schema for a `RouteEntry` accepts only two values for `state`: `absent` (mark the route for removal) and `ignore` (leave the route untouched even if it does not match the desired state). There is **no** `up` variant. A route is implicitly active simply by being declared in `routes.config` — there is no need to mark it `up`. Supplying `state: up` causes the NMState parser to reject the policy as a malformed Rust enum value.

## Resolution

Use the schema as designed:

- **To add or keep a route active**, omit the `state` field entirely. Declaring the route in `routes.config` is sufficient:

  ```yaml
  routes:
    config:
      - destination: 10.25.0.10/32
        metric: 150
        next-hop-address: 10.64.0.1
        next-hop-interface: vlan109
        table-id: 254
  ```

- **To remove a route**, set `state: absent`. Any field set to `null`/unspecified acts as a wildcard — for example, the following removes every route on the named interface:

  ```yaml
  routes:
    config:
      - next-hop-interface: vlan109
        state: absent
  ```

- **To leave existing routes untouched** while reconciling other fields in the policy, use `state: ignore`.

After fixing the manifest, re-apply and confirm the NNCE moves to a `Success` status. NMState will idempotently install the route on every node selected by the policy.

## Diagnostic Steps

1. Identify the failing policy:

   ```bash
   kubectl get nncp
   ```

   Look for `Available=False` or `Failing=True`.

2. Find the per-node enactment with the parsing error:

   ```bash
   kubectl get nnce
   kubectl get nnce <node>.<policy> -o yaml
   ```

   The `status.conditions[].message` carries the NMState parser output, including the offending key path (here `routes.config[].state`).

3. After the fix, watch the enactment converge:

   ```bash
   kubectl get nnce -w
   ```

4. On the affected node, validate that the route is actually present:

   ```bash
   kubectl debug node/<node> -- chroot /host ip route show 10.25.0.10/32
   ```
