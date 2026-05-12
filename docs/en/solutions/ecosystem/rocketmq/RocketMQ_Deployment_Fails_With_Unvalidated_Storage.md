---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RocketMQ Deployment Fails with Unvalidated Storage

:::info Applicable Versions
All currently affected versions mentioned in the source page.
:::

## Problem

RocketMQ deployment can fail when it uses a storage backend that requires root-owned permissions or otherwise does not work with the default non-root runtime model.

## Root Cause

For security reasons, RocketMQ containers do not run as `root` by default. Some customer-provided storage backends require ownership or write permissions that are incompatible with the default container user, which causes cluster creation or startup to fail.

## Solution

Set an explicit security context through the custom resource and use a matching `fsGroup`.

Example:

```yaml
spec:
  override:
    statefulSet:
      spec:
        template:
          spec:
            securityContext:
              runAsUser: 1001
              runAsGroup: 1001
              fsGroup: 1001
```

## Notes

- Apply this only after confirming that the storage class or backend really needs it.
- Re-verify volume mount permissions after the change.
