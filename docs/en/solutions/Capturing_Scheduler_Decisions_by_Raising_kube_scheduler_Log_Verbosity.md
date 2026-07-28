---
title: Capturing kube-scheduler decisions on Alauda Container Platform
component: observability
scenario: how-to
tags: [kube-scheduler, kubelet, control-plane, leader-election, logging]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Capturing kube-scheduler decisions on Alauda Container Platform

## Issue

When pods churn across nodes during scale-out, drain, or eviction, the
question is usually "why did the scheduler pick that node?" The answer
lives in the `kube-scheduler` container log on the leader replica. On
Alauda Container Platform the `kube-scheduler` runs as a kubeadm-style
static pod named `kube-scheduler-<control-plane-ip>` in the `kube-system`
namespace (one per control-plane node, owned by the `Node` object via
`kubernetes.io/config.source=file`) [ev:c1]. Operators are accustomed to
the upstream pattern but need the ACP-specific locations and verbosity
knob to read the same diagnostic signal.

## Root Cause

At any moment only a single `kube-scheduler` replica is active — the
holder of the `kube-system/kube-scheduler` Lease (API group
`coordination.k8s.io/v1`). The other replicas idle and renew nothing
until the lease expires (default 15 second duration, ~10 second renew
interval) [ev:c2_a]. Per-pod scheduling-decision log lines are emitted
only by the current leader's container, so log collection that fans out
across all replicas without filtering on the lease holder will appear
sparse on non-leader pods even during heavy scheduling load [ev:c2_b].

The kube-scheduler binary that ships on ACP
(`registry.alauda.cn:60080/tkestack/kube-scheduler:v1.34.5-1`) gates
each diagnostic line behind a klog verbosity level. At the default
verbosity, the binary emits `Successfully bound pod to node` from
`schedule_one.go` once a binding completes, plus errors and lifecycle
events — nothing else per-pod [ev:c4]. Filter/score predicate outcomes,
the candidate-node trace, and the `About to try and schedule pod` /
`Attempting to bind pod to node` events live at higher verbosity levels
in the same binary, and are silent unless the verbosity flag is raised
[ev:c5].

## Resolution

The kube-scheduler verbosity is controlled by the `--v=N` flag passed
to the `kube-scheduler` binary. On ACP the static-pod manifest lives at
`/etc/kubernetes/manifests/kube-scheduler.yaml` on each control-plane
node; the kubelet watches that directory and restarts the container
whenever the manifest file changes, so editing the manifest is sufficient
to take effect — there is no operator reconciliation in this path. To
raise verbosity for an investigation, append a `--v=N` entry to
`spec.containers[0].command` on each control-plane node [ev:c1]:

```yaml
spec:
  containers:
  - command:
    - kube-scheduler
    - --authentication-kubeconfig=/etc/kubernetes/scheduler.conf
    - --authorization-kubeconfig=/etc/kubernetes/scheduler.conf
    - --kubeconfig=/etc/kubernetes/scheduler.conf
    - --leader-elect=true
    - --config=/etc/kubernetes/scheduler-config.yaml
    - --profiling=false
    - --v=4          # add this line
    image: registry.alauda.cn:60080/tkestack/kube-scheduler:v1.34.5-1
```

The mapping between the verbosity number and the lines that become
visible follows the upstream klog convention baked into the binary:
`--v=2` (default) shows successful binding; `--v=3` adds the
`Attempting to bind pod to node` lines; `--v=4` adds the `About to try
and schedule pod` lines and per-plugin filter/score detail [ev:c5].

After the investigation, remove the `--v=N` line from the manifest on
each control-plane node — the kubelet again restarts the container with
the original flag set, returning to default verbosity. Because each
manifest is edited independently per node, repeat the change on every
control-plane node that runs a `kube-scheduler` static pod [ev:c1].

## Diagnostic Steps

Locate the `kube-scheduler` pods and identify the current leader. The
pod naming on ACP follows the kubeadm convention
`kube-scheduler-<control-plane-ip>` in `kube-system`, with one static
pod per control-plane node [ev:c1]:

```bash
kubectl get pod -n kube-system -l component=kube-scheduler -o wide
```

The active leader holds the `kube-system/kube-scheduler` Lease, and the
holder identity in the Lease object is the authoritative source for
which replica is currently leading [ev:c2_a]:

```bash
kubectl get lease -n kube-system kube-scheduler \
  -o jsonpath='{.spec.holderIdentity}{"\n"}'
```

The leader replica's container log also carries a one-shot
`leaderelection.go:271] successfully acquired lease
kube-system/kube-scheduler` line at startup, which serves as a
secondary confirmation when log retention reaches back to the lease
acquisition [ev:c3]:

```bash
kubectl logs -n kube-system <leader-pod-name> \
  | grep -i 'successfully acquired lease kube-system/kube-scheduler'
```

Once the leader is known, tail its log for the per-pod decision events.
At default verbosity, look for `Successfully bound pod to node` lines
from `schedule_one.go`; after raising verbosity to `--v=3` or `--v=4`,
additional `Attempting to bind pod to node` (from `default_binder.go`)
and `About to try and schedule pod` lines surface [ev:c4][ev:c5]:

```bash
kubectl logs -n kube-system <leader-pod-name> \
  | grep -E 'schedule_one.go|default_binder.go'
```

The log format is the standard klog structured form with a source-file
annotation (for example `schedule_one.go:346`) followed by a message
and key=value pairs including `pod="<namespace>/<name>"` and
`node="<node-name>"`, matching the per-pod decision template typical
of upstream kube-scheduler [ev:c4].

If a pod stays in `Pending` and the `kube-scheduler` leader log shows
no related activity for that pod, the cause is not a scheduling
decision: a successful bind emits the `Scheduled` Event
(`Reason=Scheduled`, `Message=Successfully assigned <ns>/<pod> to
<node>`) from the kubelet side, and pod-lifecycle failures such as
`ImagePullBackOff` or volume-mount errors are downstream of the
scheduler and surface as kubelet events rather than scheduler log
entries. Investigate those paths separately rather than continuing to
chase the scheduler log [ev:c8]:

```bash
kubectl describe pod -n <namespace> <pod-name>
kubectl get events -n <namespace> \
  --field-selector involvedObject.name=<pod-name>
```
