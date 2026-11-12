---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.6"
  - "3.8"
  - "3.12"
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Local overrides reverted or blocking an ACP upgrade: ResourcePatch, ALB ConfigMap, chart and feature gate changes

## Issue

An ACP upgrade is blocked by a pre-upgrade check, or it completes and a hand-edited setting returns to the catalog value. Typical signatures:

- The pre-upgrade checklist prints `ERROR: check alb <alb-name> configmap patch`.
- `kubectl get rpch -A` returns a long list of `ResourcePatch` objects.
- New Pods in a Service Mesh namespace log `FailedToRetrieveImagePullSecret` naming `global-registry-auth`.
- Charts are reported missing from the local template repository after a Pod moved to another node, or hand edits disappear after a HelmRequest sync.
- ALB on a business cluster restarts while only the `global` cluster is being upgraded.
- ALB is missing after the upgrade to 4.3.
- A custom inspector role can suddenly use WebCLI to exec into Pods and log in to nodes.
- The documented fix for checklist item `check_alb_configmap_ge_3_12` fails with `unknown field "sepc.confg"`.

ACP stores some local changes as `ResourcePatch` objects (`rpch`) and re-applies them on every reconcile. A direct edit of a generated ConfigMap or of a Helm-rendered object is not such a patch, so the next sync puts the catalog value back.

## Root Cause

### Cause 1: ERROR: check alb <alb-name> configmap patch

The checklist names an ALB ConfigMap that was edited in place. An in-place ConfigMap edit is not an override the upgrade preserves: the upgrade rewrites the ConfigMap from the chart, and the edit is gone afterwards even though the checklist only warned about it.

### Cause 2: ResourcePatch (rpch) entries block or silently override the upgrade

`rpch` objects record personalized edits of platform components. Before a business-cluster upgrade (for example 4.2.2 to 4.2.5) or a `global` patch upgrade (for example 4.1.2 to 4.1.5), every entry has to be classified by what it changes. Image overrides, including old hotfix images, are not safe to carry across an upgrade. CPU and memory overrides usually are. Empty patches that only store an annotation and an update timestamp are noise. A patch whose effect nobody can explain is a stop sign. Which patches are kept is a decision for each environment; there is no global allow-list.

### Cause 3: Subnet isolation or a temporary otel injection image is still in place

For the upgrade from 3.18.1 to 4.2.5, subnet resource isolation and cross-subnet access that were changed away from the platform default have to be restored to the default before the upgrade and configured again from the 4.2.5 documentation afterwards. A changed Harbor storage address, the etcd-mirror synchronization of Prometheus resources, and nevermore `compression=none` can stay in place across that upgrade.

A temporary image used so that the OpenTelemetry injection jar can start despite wrong file permissions must be checked against the target 4.x build. If the target build contains the fix, revert the temporary image before the upgrade. If it does not, the image is an image-type `rpch` and Cause 2 applies as soon as a fixed image exists.

### Cause 4: Chart template not found, and manual edits reappear as the chart

`/cpaas/captain-chartmuseum`, the local template repository, is a hostPath. When its Pod is rescheduled onto another node, that node does not have the files and the chart is reported missing. This happens on every move of the Pod (for example during a 3.6 to 3.8 upgrade). A related failure is a HelmRequest (`helmrequests.app.alauda.io`) resync that redeploys the chart and overwrites objects that were edited by hand.

### Cause 5: FailedToRetrieveImagePullSecret global-registry-auth

After a business cluster that uses Service Mesh is upgraded, new microservice Pods raise:

`FailedToRetrieveImagePullSecret: Unable to retrieve some image pull secrets (global-registry-auth); attempting to pull the image may not succeed`

`IstioOperator` and the injector ConfigMap `istio-sidecar-injector-1-20` list `imagePullSecrets: global-registry-auth`. Since the 3.16 injection change, that name is added to the `istio-proxy` injection. The Secret does not exist in the business namespace, so every injection logs the warning.

### Cause 6: ALB is not enabled after the upgrade to 4.3

On 4.3, ALB is off unless its feature gate `alaudafeaturegates/alb2` in `cpaas-system` is enabled. Existing ALB installations can keep running. A new 4.3 deployment should not enable ALB as the long-term design: ALB is deprecated from 4.3.1, and the replacement is `ingress-nginx-operator` or Envoy Gateway.

### Cause 7: A custom inspector role can use WebCLI on nodes

A custom platform-inspector role that was limited before the upgrade can exec everywhere afterwards, including node login. Its manifest contains `acp-podsexec` and `acp-rootexec`. The built-in platform auditor role on 4.2 is query-only on WebCLI and has no create, delete, or node login permission; the custom role picked up the extra entries and was not trimmed.

### Cause 8: Business-cluster ALB restarts during the global upgrade

Only `global` is upgraded, but ALB on a business cluster restarts. The ALB Deployment on the business cluster no longer matches the HelmRequest on `global`, so the sync during the global upgrade writes the HelmRequest's desired state and the business ALB rolls. Once the pre-upgrade logs and audit data are gone, the field that differed cannot be reconstructed; only the current mismatch can be checked.

### Cause 9: check_alb_configmap_ge_3_12 fix fails with unknown field "sepc.confg"

The checklist reports `check_alb_configmap_ge_3_12` as failed, and applying the documented fix fails with `unknown field "sepc.confg"` (the field the fix writes is the ALB's `spec.config`). `spec.config` belongs to the `v2beta1` version of the ALB2 resource. The update was sent without selecting resource type `alb2.v2beta1.crd.alauda.io`. Repeating it with that resource type succeeds.

## Resolution

### Cause 1: ERROR: check alb <alb-name> configmap patch

Export the ConfigMap before the upgrade and compare it afterwards. If the upgrade restored the chart copy, put the required keys back through the ALB overwrite mechanism, not through another `kubectl edit` of the ConfigMap.

```bash
kubectl get configmap <alb-name> -n <namespace> -o yaml > <alb-name>-configmap.yaml
```

> **Warning:** Re-applying a full ConfigMap YAML with `kubectl apply` fights the controller and can drop keys the chart added during the upgrade. Use the ALB overwrite path for that setting and keep `<alb-name>-configmap.yaml` as the backup. If the overwrite itself is wrong, remove the overwrite entry so the chart value returns; do not delete the ALB instance to recover one ConfigMap key.

### Cause 2: ResourcePatch (rpch) entries block or silently override the upgrade

Export every patch, then classify each entry:

```bash
kubectl get rpch -A -o yaml > rpch-backup.yaml
```

| What the patch changes | Before the upgrade |
| --- | --- |
| Image, including an old hotfix image | Delete it. |
| CPU or memory only | May stay. |
| CoreDNS host resolution, or a dex access address | May stay through the upgrade. Delete it afterwards and move the data into plugin management or the platform access-address configuration. |
| Empty patch (annotation and timestamp only) | Delete. |
| A file under the component configuration | If nothing depends on it strongly, back up the live resource, delete the `rpch`, and restore the intended content after the upgrade. |
| Startup arguments or an environment variable of a component | May stay, but the flag's location can move. If the component then crashes or conflicts, delete that `rpch`. |
| Anything you cannot explain | Stop. Neither delete it nor keep it blindly. |

Entries of type `Artifact` can be left out of this classification; confirm the type before you skip one.

> **Warning:** Deleting an image `rpch` makes the component run the catalog image at the next reconcile, which can restart it and drop the hotfix. Take `rpch-backup.yaml` first. If the catalog image is worse than the hotfix and the upgrade has not started, restore that one object with `kubectl apply`. Re-applying an old image patch after the upgrade puts the old image back; do that only to recover a failed upgrade, and remove it again before the next attempt. Deleting a CPU or memory patch resets the component to the chart requests, which can cause OOM or throttling.

```bash
kubectl delete rpch <name> -n <namespace>
```

### Cause 3: Subnet isolation or a temporary otel injection image is still in place

Restore subnet resource isolation and cross-subnet access to the platform default before the 4.2.5 upgrade, then configure them again following the 4.2.5 documentation. Do not carry the pre-4.2 isolation syntax across and edit it in place.

For the OpenTelemetry injection image, confirm whether the target 4.x build fixes the jar permission failure. If it does, point the injection back to the catalog image before the upgrade. If it does not, keep the workaround until a fixed image is uploaded, then delete it as an image `rpch` (Cause 2).

> **Warning:** Restoring subnet isolation to the default opens or closes cross-subnet paths that the custom policy enforced. Do it in the maintenance window with the previous manifest saved. Roll back by re-applying that manifest only if the upgrade has not started; once the cluster is on 4.2.5, configure it from the new documentation instead. Reverting the otel image before the target build has the fix brings back the Pod start failure.

### Cause 4: Chart template not found, and manual edits reappear as the chart

Find the Pod that mounts the hostPath and the node that has the files:

```bash
kubectl get pods -A -o json | python3 -c 'import json,sys
d=json.load(sys.stdin)
for p in d.get("items",[]):
  for v in p["spec"].get("volumes",[]):
    path=(v.get("hostPath") or {}).get("path") or ""
    if "captain-chartmuseum" in path:
      print(p["metadata"]["namespace"], p["metadata"]["name"], p["spec"].get("nodeName"), path)'
```

On that node, `ls /cpaas/captain-chartmuseum` must show the charts. For the duration of the upgrade, keep the Pod on that node by setting a nodeSelector `kubernetes.io/hostname=<node-name>` on its owner.

> **Warning:** A nodeSelector pins the template repository to one node; if that node is drained, the charts disappear again. Removing the nodeSelector returns the Pod to normal scheduling and loses the charts unless the files were copied to shared storage first. Do not delete the Pod to "refresh" a missing chart.

Put every intentional difference into Helm values and change it through those values. A hand edit of a rendered Deployment is overwritten the next time the HelmRequest syncs.

### Cause 5: FailedToRetrieveImagePullSecret global-registry-auth

Confirm the Secret is absent, then remove `global-registry-auth` from the ServiceMesh configuration (`IstioOperator` at `spec.values.global.imagePullSecrets`) and from the injector ConfigMap that still lists it. Creating the missing Secret is not the fix.

```bash
kubectl get secret global-registry-auth -n <business-namespace>
kubectl get servicemesh -A
kubectl get istiooperator -A
kubectl get configmap -A | grep istio-sidecar-injector
```

> **Warning:** Restarting microservice Pods re-injects the sidecar and drops their current connections. Do it after neither the ServiceMesh nor the injector names `global-registry-auth`, in a window those services can restart. Roll back by restoring the previous ServiceMesh and ConfigMap YAML and restarting again.

```bash
kubectl -n <business-namespace> rollout restart deploy <deploy-name>
```

### Cause 6: ALB is not enabled after the upgrade to 4.3

If the cluster already serves traffic with ALB and the gate is off, enable it. On a new 4.3 installation, do not enable ALB; plan `ingress-nginx-operator` or Envoy Gateway instead. From 4.3.1, treat enabling ALB as a temporary bridge.

```bash
kubectl get alaudafeaturegates -n cpaas-system alb2 -o yaml
```

> **Warning:** Enabling the gate reconciles ALB on a cluster where it is deprecated from 4.3.1. Enable it only to keep an ALB that is already in use. To turn it off again, patch `spec.enabled` to `false` with the same annotation. Do not delete the `alb2` feature-gate object.

```bash
kubectl patch alaudafeaturegates alb2 -n cpaas-system --type=merge -p '{"spec":{"enabled":true},"metadata":{"annotations":{"cpaas.io/ignoreme":"true"}}}'
```

Keep the `cpaas.io/ignoreme` annotation in the patch so the setting persists. Read the object again and require `spec.enabled: true`.

### Cause 7: A custom inspector role can use WebCLI on nodes

Find the custom role YAML that contains `acp-podsexec` or `acp-rootexec`, remove those entries, and keep `get`, `list`, and `watch`. The 4.2 platform auditor is the reference for query-only access.

```bash
grep -n -e acp-podsexec -e acp-rootexec <role-file>.yaml
```

> **Warning:** Applying the trimmed role removes node login and Pod exec from everyone bound to it. Save the previous YAML and restore it if the trim removes a permission the role still needs. Do not delete the whole role to remove two entries; that locks out the inspectors.

```bash
kubectl apply -f <role-file>.yaml
```

If the role is not a plain ClusterRole, apply it through the same API the platform uses for custom roles.

### Cause 8: Business-cluster ALB restarts during the global upgrade

Before upgrading `global`, compare the business ALB Deployment with the HelmRequest on `global` that owns it. Put the intended values on the HelmRequest so the sync is a no-op, or schedule the business ALB restart inside the global window and inform the application owners.

```bash
kubectl get helmrequests.app.alauda.io -A
kubectl -n <alb-namespace> get deploy <alb-deploy> -o yaml > business-alb-deploy.yaml
```

> **Warning:** Editing the HelmRequest to match a hand-tuned Deployment rolls ALB when the request syncs. Change it at the start of the window, not in the middle of the global upgrade. To undo a bad edit, re-apply the previous HelmRequest YAML. Deleting the HelmRequest removes the release, not just the drift.

Aligning the HelmRequest only removes this drift-induced restart. The ALB restart that comes with upgrading the cluster that runs the ALB cannot be avoided or deferred; see "ALB load balancer Pods restart during an ACP upgrade and the restart cannot be deferred".

### Cause 9: check_alb_configmap_ge_3_12 fix fails with unknown field "sepc.confg"

Repeat the documented update with resource type `alb2.v2beta1.crd.alauda.io` selected. In the console, pick that resource type before editing. From the command line, name the fully qualified resource:

```bash
kubectl get alb2.v2beta1.crd.alauda.io -A
kubectl -n <alb-namespace> get alb2.v2beta1.crd.alauda.io <alb-name> -o yaml > <alb-name>-alb2.yaml
```

> **Warning:** Changing `spec.config` reconciles the ALB and can restart its Pods, which interrupts traffic through it briefly. Precondition: `<alb-name>-alb2.yaml` saved and a maintenance window. Rollback: `kubectl apply -f <alb-name>-alb2.yaml`.

```bash
kubectl -n <alb-namespace> edit alb2.v2beta1.crd.alauda.io <alb-name>
```

Make the change the checklist item's documentation describes, save, and run the checklist again.

## Diagnostic Steps

List the overrides before judging upgrade readiness. A healthy node list does not mean the upgrade keeps local edits.

```bash
kubectl get rpch -A
kubectl get helmrequests.app.alauda.io -A
kubectl get alaudafeaturegates -n cpaas-system alb2 -o jsonpath='{.spec.enabled}{"\n"}'
```

Use the first matching signature:

1. Checklist text `check alb` with `configmap patch`: Cause 1.
2. Any `rpch` row: Cause 2. Image rows are deleted; a row is not kept just because the component is currently healthy.
3. Subnet isolation or cross-subnet access is non-default and the target is 4.2.5, or an otel injection image is a known temporary build: Cause 3.
4. A chart template cannot be found, or a hand edit vanished after a sync, and a volume uses `/cpaas/captain-chartmuseum`: Cause 4.
5. Event text naming `global-registry-auth`: Cause 5. Check the business namespace for the Secret before editing the injector.
6. ALB missing on 4.3 and `alaudafeaturegates/alb2` not enabled: Cause 6.
7. A custom inspector role can exec or log in to nodes, and its YAML contains `acp-podsexec` or `acp-rootexec`: Cause 7.
8. Business ALB restarted while only `global` changed, and its Deployment does not match the HelmRequest on `global`: Cause 8.
9. The `check_alb_configmap_ge_3_12` fix fails with `unknown field "sepc.confg"` or `unknown field "spec.config"`: Cause 9.

A `ResourcePatch` whose owner cannot say what it changes stays a stop. Do not delete it to make `kubectl get rpch` shorter.
