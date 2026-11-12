---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - 4.3.x
---

# Tekton pipeline Pod rejected by Pod Security admission because of the katanomi-setting-init init container

## Issue

A Tekton pipeline (for example one using the official `git-clone` and `buildah` tasks) cannot run in a namespace that enforces the `restricted` Pod Security Standard. The admission event names the init container `katanomi-setting-init` as not meeting the namespace security policy, in the usual Pod Security admission form:

```text
pods "<pod>" is forbidden: violates PodSecurity "restricted:latest": ... (container "katanomi-setting-init" ...)
```

Setting `set-security-context: "true"` under `spec.pipeline` of the `TektonConfig` does not change the result; the same event is reported again.

## Root Cause

### Cause 1: the DevOps v3 components inject `katanomi-setting-init` into pipeline Pods

`katanomi-setting-init` is not part of the Tekton task. It is an init container injected by the DevOps v3 (katanomi) components while they are installed on the cluster:

- **v3 pipelines** do not support running in a `restricted` namespace.
- **v4 (Tekton) pipelines** also get the `katanomi-setting-init` init container injected automatically as long as the v3 components are still installed. The container does not satisfy the `restricted` policy, so the whole Pod is rejected.

`set-security-context` in the `TektonConfig` applies to the containers Tekton creates. It does not remove or change the injected `katanomi-setting-init` container, which is why changing it has no effect.

## Resolution

### Cause 1

Choose the option that matches how the cluster still uses DevOps v3.

**Option A: v3 is no longer needed.** Uninstall the DevOps v3 components. After that, v4 pipeline Pods no longer carry `katanomi-setting-init` and can run in a `restricted` namespace.

> **Warning:** Uninstalling the DevOps v3 components removes the v3 pipeline functions, including Jenkins-based pipelines that still run on v3. Do this only after every pipeline that still depends on v3 has been migrated to v4 and verified. Reinstalling the v3 components is the only way back.

**Option B: v3 and v4 must run in parallel for a while** (for example while Jenkins pipelines are still being migrated). Keep the v3 components and run the v4 pipelines in a namespace whose Pod Security level the pipeline Pods satisfy, and plan the move to a `restricted` namespace after the migration to v4 is finished.

1. Check what a lower level would allow before changing it. The server-side dry run prints a warning for every existing Pod that would still be rejected:

   ```bash
   kubectl label --dry-run=server --overwrite ns <pipeline-namespace> pod-security.kubernetes.io/enforce=baseline
   ```

2. Apply the level that the pipeline Pods pass:

   > **Warning:** Lowering the enforced Pod Security level allows more privileged Pods in the namespace for every workload there, not only the pipelines. Prefer a dedicated namespace for pipelines. Record the current label first and roll back by setting it again.

   ```bash
   kubectl get ns <pipeline-namespace> --show-labels
   kubectl label --overwrite ns <pipeline-namespace> pod-security.kubernetes.io/enforce=<baseline|privileged>
   ```

3. Run the pipeline again and confirm that the Pod is admitted.

## Diagnostic Steps

1. Read the event of the rejected Pod or TaskRun and check which container is named:

   ```bash
   kubectl -n <pipeline-namespace> get events --sort-by=.lastTimestamp | grep -i podsecurity
   kubectl -n <pipeline-namespace> describe taskrun <taskrun-name> | sed -n '/Events/,$p'
   ```

   Expected for this cause: the violation lists `katanomi-setting-init`. If it lists only Tekton containers such as `prepare`, `place-scripts` or `step-*`, the problem is the securityContext of the Tekton containers, not the v3 injection.

2. Check the namespace Pod Security labels:

   ```bash
   kubectl get ns <pipeline-namespace> -o jsonpath='{.metadata.labels}{"\n"}'
   ```

   Expected: `pod-security.kubernetes.io/enforce: restricted`.

3. Check whether the DevOps v3 (katanomi) components are still installed:

   ```bash
   kubectl get katanomis.operators.katanomi.dev -A
   kubectl get pods -A | grep -i katanomi
   ```

   Resources and Pods present mean the v3 components are installed and will keep injecting `katanomi-setting-init`.
