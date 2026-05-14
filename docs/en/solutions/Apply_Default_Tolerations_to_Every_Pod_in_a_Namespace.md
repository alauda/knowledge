---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Apply Default Tolerations to Every Pod in a Namespace
## Issue

A namespace owner needs new pods landing in their namespace to be schedulable on tainted nodes (typically an `infra` pool, an `edge` pool, or a hardware-accelerated pool) without asking every workload manifest to add the same `tolerations` block by hand.

The two recurring asks:

- "How can pods in a project/namespace automatically tolerate one specific taint, so that they all land on the dedicated node pool?"
- "How can pods in a namespace tolerate **every** taint, regardless of how the node pool is set up?"

Editing every Deployment / StatefulSet to add a `tolerations` block is brittle and easy to forget when new charts are introduced.

## Resolution

Tolerations can be applied at namespace scope through the scheduler's pod admission controller via two namespace annotations:

- `scheduler.alpha.kubernetes.io/defaultTolerations` — every pod created in the namespace gets these tolerations merged in;
- `scheduler.alpha.kubernetes.io/tolerationsWhitelist` — caps which tolerations are allowed in the namespace, so a workload cannot opt out of the default.

The defaults are applied at admission time. Existing pods are not retroactively patched; the change only affects pods created after the annotation is in place.

### Pin a namespace to a single tainted pool

Goal: every pod in `example-namespace` lands on nodes labelled `node-role.kubernetes.io/infra` and tolerates the matching taint, and nothing else can be added.

1. **Label and taint the dedicated nodes.** The label is what the namespace's `node-selector` will key on; the taint is what the toleration will satisfy.

   ```bash
   kubectl label node <node> node-role.kubernetes.io/infra=
   kubectl taint nodes <node> role=infra:NoSchedule
   ```

2. **Annotate the namespace** with the default toleration, the toleration allowlist, and the matching node selector. The first annotation injects the toleration; the second locks the surface so workload owners cannot widen it; the third pushes pods to the labelled pool.

   ```yaml
   apiVersion: v1
   kind: Namespace
   metadata:
     name: example-namespace
     annotations:
       scheduler.alpha.kubernetes.io/node-selector: "node-role.kubernetes.io/infra="
       scheduler.alpha.kubernetes.io/defaultTolerations: |
         [{"Key": "role", "Operator": "Equal", "Value": "infra", "Effect": "NoSchedule"}]
       scheduler.alpha.kubernetes.io/tolerationsWhitelist: |
         [{"operator": "Exists", "effect": "NoSchedule", "key": "role"}]
   ```

   Apply with:

   ```bash
   kubectl apply -f example-namespace.yaml
   ```

3. **Verify.** A new pod created in the namespace inherits the toleration with no tolerations declared in its own manifest.

   ```bash
   kubectl -n example-namespace run probe --image=registry.k8s.io/pause:3.9
   kubectl -n example-namespace get pod probe -o jsonpath='{.spec.tolerations}{"\n"}'
   ```

   The output includes the `role=infra:NoSchedule` toleration even though the pod manifest did not declare one.

### Make a namespace tolerate every taint

For a namespace whose pods must run anywhere — typically a debug / break-glass namespace — a single annotation with `Exists` on no key is enough. Use this sparingly; it removes the protection that taints provide.

```bash
kubectl annotate namespace example-namespace \
  'scheduler.alpha.kubernetes.io/defaultTolerations=[{"operator":"Exists"}]'
```

Every new pod in the namespace will be admitted with a wildcard toleration. Pods created before the annotation are unaffected; restart them if the new behaviour needs to apply immediately.

### When the platform's node-pool surface is available

ACP exposes node pools in `configure/clusters/nodes`. Where a workload class is well-defined (infra, GPU, edge), prefer to:

- declare the pool with the platform's node-pool API so the labels and taints stay consistent across reconciles, and
- bind the namespace to the pool through the same surface.

This is equivalent to the annotations above but survives node replacement and is auditable from the platform UI. The annotations remain useful for ad-hoc namespaces that do not warrant a managed pool.

### Important caveats

- The `defaultTolerations` annotation is processed by the scheduler admission plugin. If the plugin is not enabled on the cluster, the annotation is silently a no-op — verify a test pod actually receives the toleration before trusting it in production.
- `tolerationsWhitelist` rejects pods whose tolerations are not a subset of the allowlist. A workload that already declared a broader toleration set will fail admission until it is trimmed to the allowlist or the allowlist is widened.
- Default tolerations do not magically place pods on tainted nodes — they only allow them to land there. Combine with `node-selector` (or pod `nodeAffinity`) to actually steer placement.

## Diagnostic Steps

Confirm the annotations are present and parseable JSON. A typo in the annotation value silently breaks admission for the namespace:

```bash
kubectl get ns example-namespace -o json \
  | jq '.metadata.annotations | with_entries(select(.key | startswith("scheduler.alpha")))'
```

Create a probe pod and inspect the merged toleration set:

```bash
kubectl -n example-namespace run probe --image=registry.k8s.io/pause:3.9
kubectl -n example-namespace get pod probe -o yaml | yq '.spec.tolerations'
kubectl -n example-namespace get pod probe -o wide
```

If the probe lands on a non-target node, check that the `node-selector` annotation matches the label on the intended pool exactly — `node-role.kubernetes.io/infra=` and `node-role.kubernetes.io/infra` (no trailing equals) are not the same selector.

If a pre-existing workload is *rejected* by admission after the allowlist is added, dump its tolerations and compare against the allowlist:

```bash
kubectl -n example-namespace get deploy <name> -o jsonpath='{.spec.template.spec.tolerations}{"\n"}'
```

The most common cause is a Helm chart that always sets a `node.kubernetes.io/not-ready` toleration the allowlist did not anticipate; widen the allowlist or drop the chart's defaults.
