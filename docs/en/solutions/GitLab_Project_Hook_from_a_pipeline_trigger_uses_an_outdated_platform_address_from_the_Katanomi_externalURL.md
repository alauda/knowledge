---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion: []
---

# GitLab Project Hook from a pipeline trigger uses an outdated platform address from the Katanomi externalURL

## Issue

A CI/CD pipeline is configured to build automatically when GitLab code changes. The webhook that the platform registers in the GitLab project (**Settings > Webhooks**, Project Hooks) points to an old address, for example `http://<old-platform-domain>/...`, instead of the address through which the platform is actually reached, for example `https://<current-platform-domain>/...`. The question is where this default address comes from and how to change it.

## Root Cause

### Cause 1: `spec.externalURL` of the `Katanomi` resource still holds the old address

The address written into the GitLab Project Hook is the address that the katanomi component exposes outside the cluster. It is taken from `spec.externalURL` of the `Katanomi` resource on the global cluster (for example `katanomi-global` in the `cpaas-system` namespace).

When the platform is reached through a new domain, a WAF or another front end, `spec.externalURL` keeps the address it was installed with. Every trigger created after that registers a hook with the old address. Hooks that already exist are not rewritten when the value changes; a trigger registers its hook when it is created.

## Resolution

### Cause 1

1. On the global cluster, read the current value:

   ```bash
   kubectl get katanomis -A -o yaml | grep -n externalURL
   ```

2. Check how many webhooks and triggers exist. Every one of them was registered with the old address, so the count shows how many pipelines must be recreated after the change:

   ```bash
   kubectl get webhook -A
   kubectl get trigger -A
   ```

3. Set `spec.externalURL` to the address through which GitLab reaches the platform:

   > **Warning:** The new address is used for every hook registered afterwards, on all pipelines. GitLab must be able to reach that address, otherwise new triggers stop firing. Record the current value from step 1; roll back by setting it again.

   ```bash
   kubectl -n cpaas-system edit katanomis <katanomi-resource-name>
   ```

   Change:

   ```yaml
   spec:
     externalURL: https://<current-platform-domain>
   ```

4. Delete the trigger of the affected pipeline and create it again. The recreated trigger registers the hook with the new address.

   > **Warning:** Between deleting and recreating the trigger, pushes to the GitLab project do not start the pipeline. Note the trigger settings before deleting it so it can be recreated the same way.

5. In the GitLab project, open **Settings > Webhooks** and confirm that the hook URL now uses the new address. Remove any leftover hook that still points to the old address.

## Diagnostic Steps

1. Compare the hook URL in GitLab with `spec.externalURL`:

   ```bash
   kubectl get katanomis -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}: {.spec.externalURL}{"\n"}{end}'
   ```

   Expected for this cause: the host of the GitLab Project Hook equals the host in `spec.externalURL`, and both differ from the address users open the platform with.

2. After the change, create a test trigger, or recreate an existing one, and check that the new hook in GitLab uses the new address. A hook created before the change still showing the old address is expected until its trigger is recreated.
