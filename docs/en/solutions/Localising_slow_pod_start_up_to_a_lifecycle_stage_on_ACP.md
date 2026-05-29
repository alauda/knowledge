---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Localising slow pod start-up to a lifecycle stage on ACP

## Issue

A pod that takes a long time to reach `Ready` rarely reveals which lifecycle stage absorbed the delay from its phase alone. On Alauda Container Platform (kube `v1.34.5`) the per-stage timing is recoverable by reading two surfaces the upstream scheduler, kubelet, and CNI populate against every Pod: the Pod's lifecycle Events and the Pod's `.status.conditions`. Mapping the timestamp of each stage — scheduling, network-interface add, and image pull — back onto a single timeline lets the delay be attributed to a specific layer rather than guessed at.

## Root Cause

Start-up latency accrues across distinct, sequential stages, each emitting its own timestamped signal. For the pod under investigation, the lifecycle Events carry stage reasons such as `Scheduled`, `AddedInterface`, and `Pulling`, each marking when that stage occurred, so the gaps between their timestamps localise where the wall-clock time went. In parallel, that same pod's `.status.conditions` list carries the `PodScheduled`, `PodReadyToStartContainers`, `Initialized`, `ContainersReady`, and `Ready` condition types, each with a `lastTransitionTime`, giving a second independent reconstruction of its stage timeline. Read both surfaces for one pod and compare them: the Event reasons and the condition transitions are two views of the same lifecycle, so a wide gap in one corroborates the dominant stage seen in the other.

## Resolution

List the pod's lifecycle Events ordered by stage, then read its condition transition times, and compare the two timelines to find the dominant gap.

List the lifecycle Events for the pod:

```bash
kubectl get events -n <ns> \
  --field-selector involvedObject.name=<pod> \
  -o jsonpath='{range .items[*]}{.reason}{"\t"}{.eventTime}{"\t"}{.lastTimestamp}{"\n"}{end}'
```

On kube `v1.34.5` these lifecycle Events carry their timestamp in the `lastTimestamp` column while `eventTime` is `null`, so a `sort -k2` keyed on `eventTime` does not order the rows reliably — read the timeline from the `lastTimestamp` column instead.

Read each pod-status condition with its transition time:

```bash
kubectl get pod <pod> -n <ns> \
  -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.lastTransitionTime}{"\n"}{end}'
```

The `AddedInterface` Event is emitted with `source.component=multus`, the CNI meta-plugin on ACP, while `Scheduled` is emitted with `source.component=default-scheduler`; attributing each Event to its emitter confirms which subsystem owns the stage being timed.

## Diagnostic Steps

When the network-interface stage is the suspected gap, compare the Pod's `creationTimestamp` against the `time` on its Multus `.metadata.managedFields` entry to measure how long elapsed before Multus readied the interfaces. On this ACP build Multus ships as `acp/multus-cni:v4.2.4-b223aa77`, so the managed-fields entry below reflects that build's behaviour. The relevant managed-fields entry is written by the manager named `multus` (operation `Update`, subresource `status`, carrying the `k8s.v1.cni.cncf.io/network-status` annotation); on a representative pod the interval was `creationTimestamp 15:02:41Z` versus the `multus` entry `time 15:02:48Z`, i.e. 7 seconds.

Read the two timestamps together:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.metadata.creationTimestamp}{"\n"}'
kubectl get pod <pod> -n <ns> \
  -o jsonpath='{range .metadata.managedFields[?(@.manager=="multus")]}{.time}{"\n"}{end}'
```

This interval is a measurable stage that can dominate perceived start-up latency when Multus is slow to ready a pod's interfaces; the 7-second case above is small, but the stage exists and is timestamped on every pod, so a large interval here marks network-interface setup as the dominant contributor to the delay.
