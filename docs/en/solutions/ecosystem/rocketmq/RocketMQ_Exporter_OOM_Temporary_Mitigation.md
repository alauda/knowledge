---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RocketMQ Exporter OOM Temporary Mitigation

:::info Applicable Versions
RocketMQ 3.12.x.
:::

## Problem

RocketMQ exporter can run out of memory in some environments. A reported case stabilized only after increasing the exporter memory to `2Gi`.

The default exporter resource profile was:

- CPU: `500m`
- Memory: `512Mi`
- scrape interval: `15s`

The exporter is implemented in Java, and the custom resource could not directly update exporter resource settings in the reported environment.

## Temporary Workaround

Manually patch or edit the exporter `Deployment` and raise its memory request and limit to `2Gi`.

## Important Limitation

This is only a temporary workaround. If the RocketMQ instance is updated or reconciled again, the manual change can be overwritten.

## Recommendation

- Apply the manual adjustment only as a short-term mitigation.
- Monitor actual steady-state memory usage after the change.
- Follow up with a product-side fix that exposes exporter sizing through the CR or improves exporter memory behavior.
