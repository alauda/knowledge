---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RocketMQ Exporter Frequent Restart in 3.12.1

:::info Applicable Versions
RocketMQ 3.12.1.
:::

## Problem

In some RocketMQ 3.12.1 deployments, the exporter container restarts repeatedly.

## Diagnosis

Check the pod and container events first. In the reported case, the exporter was being killed because of insufficient memory and showed `OOMKilled`.

Useful commands:

```bash
kubectl -n <namespace> describe pod <pod-name>
kubectl -n <namespace> get events --sort-by=.lastTimestamp
```

## Solution

Increase the resource specification for the affected exporter container from the Data Services YAML view or the underlying workload resource.

Adjust the exporter memory limit according to observed usage and restart behavior.

## Notes

- This issue was observed on the exporter side rather than on the RocketMQ brokers themselves.
- After increasing memory, re-check pod stability and exporter scrape continuity.
