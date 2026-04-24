---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Installing the container-security scanner (StackRox or its downstream variants) deploys a `collector` DaemonSet intended to land on every node. On some clusters, the DaemonSet's pods enter `Pending` and never schedule, with a scheduler message that looks fine on its face:

```text
0/9 nodes are available:
  1 node(s) didn't match Pod's node affinity/selector.
  preemption: 0/9 nodes are available: 9 Preemption is not helpful for scheduling.
```

The message is misleading — the "1 node(s) didn't match" is actually reporting that every node in the cluster fails a selector the collector pod did not set explicitly. The selector is being **added** to the pods by a cluster-wide admission layer, specifically the scheduler's `defaultNodeSelector`, which auto-injects a nodeSelector onto every new pod in every namespace that does not opt out.

## Root Cause

Some platforms expose a cluster-level default node selector — a fallback nodeSelector that is merged into every pod spec at admission time. It is a convenience for "every workload should default to worker nodes", but it interacts badly with DaemonSets and privileged agents that legitimately need to run on every node (including control-plane nodes).

Concretely:

1. The scanner installs a `collector` DaemonSet with an empty / permissive `nodeSelector`.
2. The platform's admission layer merges the cluster-level default selector into each pod spec at creation time.
3. Control-plane nodes (or any node not matching the default selector) never match, and the scheduler refuses to place the collector pod there.
4. On clusters where even worker nodes carry a label combination that does not match the cluster default (rare but possible), **every** node fails the check and the pod is Pending against the full node list.

The collector was designed to run everywhere; the injected selector narrows the scope without the collector's knowledge.

Two related constructs drive this on some platforms:

- A cluster-level `Scheduler` CR with a `spec.defaultNodeSelector`. Cluster-wide default.
- A namespace annotation (`scheduler.alpha.kubernetes.io/node-selector` or an equivalent vendor-specific annotation) that overrides the cluster default per-namespace. An empty value explicitly turns off the cluster default for that namespace.

On platforms that follow these conventions, setting the namespace annotation to empty is the supported way to exempt a namespace. On platforms that do not carry a cluster-level scheduler default at all, the default selector is irrelevant and this issue does not present — but the general principle applies: check for any admission or policy layer that rewrites pod specs, and exclude the collector's namespace from it.

## Resolution

### Preferred — exempt the collector's namespace from the cluster default

On any platform that honours the `scheduler.alpha.kubernetes.io/node-selector` annotation for namespaces, annotate the namespace that holds the `SecuredCluster` CR:

```bash
# Add or override the namespace's per-project default.
kubectl annotate namespace <collector-ns> \
  scheduler.alpha.kubernetes.io/node-selector="" --overwrite
```

An empty value explicitly clears the namespace's own default, so the scheduler does not merge any nodeSelector into pods in that namespace beyond what they declare. The collector DaemonSet's pods then land on every node as intended.

After annotating, bounce the collector pods so newly-scheduled replicas pick up the exempt annotation:

```bash
kubectl -n <collector-ns> rollout restart daemonset/collector
kubectl -n <collector-ns> get pod -o wide -w
```

Pods should transition from `Pending` to `Running` on every node.

### If the platform uses a different exemption mechanism

Check whether the platform has a different equivalent:

- **PodPresets or mutating admission webhooks** that inject nodeSelector: inspect their match conditions and narrow them so they skip the collector's namespace.
- **Scheduler profiles / policies** that score nodes against a predicate: add an exception for the collector's labels.
- **Admin policies** (Gatekeeper / Kyverno rules) that enforce nodeSelector: add an exclusion for the collector's namespace.

If none of these mechanisms is in play, the `defaultNodeSelector` problem does not apply and the `Pending` pods have a different root cause — inspect the specific pod's `spec.nodeSelector` and `spec.affinity` for other restrictions.

### Alternative — explicitly target every node in the DaemonSet

If exempting the namespace from the cluster default is not acceptable (the cluster default is there to enforce a specific policy), set an explicit `nodeSelector` on the collector DaemonSet that matches every node. The `SecuredCluster` CR typically exposes a `.spec.collector.placement` field:

```yaml
apiVersion: platform.stackrox.io/v1alpha1
kind: SecuredCluster
metadata:
  name: stackrox-secured-cluster-services
  namespace: stackrox
spec:
  collector:
    placement:
      nodeSelector:
        # A label that all nodes (control-plane + workers) carry.
        kubernetes.io/os: linux
```

`kubernetes.io/os: linux` is on every standard node; the DaemonSet schedules everywhere and overrides whatever default selector would otherwise narrow it. Use this path when the namespace exemption is not available or not desired.

## Diagnostic Steps

Confirm the failure is the cluster-default node selector (not a DaemonSet tolerations issue or a different selector misconfiguration):

```bash
# The pending collector pod's effective spec — look for a merged nodeSelector
# that the DaemonSet did not declare.
kubectl -n <collector-ns> get pod -l app=collector \
  --field-selector=status.phase=Pending \
  -o jsonpath='{.items[0].spec.nodeSelector}{"\n"}' | jq
```

If the response includes a selector like `node-role.kubernetes.io/worker=` that the DaemonSet's own `spec.template.spec.nodeSelector` does not set, admission injection is the cause.

Check for a cluster-wide `Scheduler` default (where the CR exists):

```bash
kubectl get scheduler/cluster -o yaml | grep -i defaultNodeSelector
# spec:
#   defaultNodeSelector: "node-role.kubernetes.io/worker="
```

Confirm the namespace has no existing override:

```bash
kubectl get namespace <collector-ns> \
  -o jsonpath='{.metadata.annotations.scheduler\.alpha\.kubernetes\.io/node-selector}{"\n"}'
```

Empty or absent → the cluster default applies. After applying the exemption annotation, re-read:

```bash
kubectl get namespace <collector-ns> \
  -o jsonpath='{.metadata.annotations.scheduler\.alpha\.kubernetes\.io/node-selector}{"\n"}'
# "" (empty string)
```

Restart the collector DaemonSet and watch pods schedule:

```bash
kubectl -n <collector-ns> rollout restart daemonset/collector
kubectl -n <collector-ns> get pod -l app=collector -o wide -w
```

`Running` on every node — including control-plane nodes if that is the design — confirms the fix.
