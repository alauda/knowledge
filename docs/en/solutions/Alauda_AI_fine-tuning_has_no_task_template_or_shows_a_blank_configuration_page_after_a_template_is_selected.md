---
kind:
  - Troubleshooting
products:
  - Alauda AI
ProductsVersion: []
---

# Alauda AI fine-tuning has no task template or shows a blank configuration page after a template is selected

## Issue

- In **Model Optimization** > **Fine-Tuning**, the task template list is empty, so a fine-tuning task cannot be created. The expectation was that a task template is available right after the initial deployment.
- A template is selected in the **Create Fine-tuning Task** dialog, and the task configuration page that follows is completely blank.
- The question is what goes in the dataset text input column (`数据集文本输入列`), and whether more than one column can be selected.

Fine-tuning and training are optional features. They need the fine-tuning plugins (Volcano, Kubeflow Training Operator, MLFlow, and the others listed in "Enable Fine-Tuning and Training Features" of the Alauda AI documentation) and `tuneModels: true` under `spec.values.experimentalFeatures` of the `AmlCluster` resource `default`. If the Fine-Tuning menu itself is missing, start with that guide.

## Root Cause

### Cause 1: no template has been uploaded, or the template lacks the label the fine-tuning entry filters on

Task templates are not created by the deployment. The example templates are shipped in the `alaudadockerhub/training-templates` image and have to be extracted and uploaded to **Task Template**, as described in "Enable Fine-Tuning and Training Features". In addition, a task template is shown at the fine-tuning entry only when it carries the label that the fine-tuning entry filters on; a template uploaded without it does not appear.

### Cause 2: an old template with missing fields is still in use after a Volcano upgrade conflict

A conflict during the Volcano component upgrade left the old component in place. The fine-tuning task was therefore created from the old task template, which lacks fields that the current configuration form needs, and the form renders as a blank page. Uploading the current template again makes the page display normally.

### Cause 3: the text input column takes text columns only

The dataset text input column must contain only text columns and must not include the label column. More than one column can be selected.

## Resolution

### Cause 1: no template has been uploaded, or the template lacks the label the fine-tuning entry filters on

1. Check whether template projects exist in the GitLab that Alauda AI uses. The built-in templates are GitLab projects under `<namespace>/aml-templates/`, for example `<namespace>/aml-templates/finetune-text-classification`:

   ```bash
   GITLAB=https://<gitlab-address>
   TOKEN=<gitlab-token>
   curl -s -H "PRIVATE-TOKEN: ${TOKEN}" "${GITLAB}/api/v4/projects?search=aml-templates&simple=false" \
     | jq '.[] | {id, path_with_namespace, topics}'
   curl -s -H "PRIVATE-TOKEN: ${TOKEN}" "${GITLAB}/api/v4/projects?search=finetune&simple=false" \
     | jq '.[] | {id, path_with_namespace, topics}'
   ```

2. If no template project exists, extract the example templates from the `alaudadockerhub/training-templates` image and upload them to **Task Template**, following "Enable Fine-Tuning and Training Features" for your Alauda AI version. Make sure all Bash scripts in the template (especially `run.sh`) are executable before uploading, as "Developing Custom Fine-Tuning Templates" requires.
3. If templates exist but are not listed, compare their labels and topics with a template that is listed (in another namespace or environment), and add the label the fine-tuning entry expects, as the Alauda AI fine-tuning template documentation of your version describes.
4. Reopen **Create Fine-tuning Task** and check the list.

### Cause 2: an old template with missing fields is still in use after a Volcano upgrade conflict

1. Check for an old Volcano component next to the new one:

   ```bash
   kubectl get pods -A | grep -i volcano
   kubectl get deploy -A | grep -i volcano
   kubectl get apprelease -A | grep -i volcano
   kubectl get minfo | grep <cluster-name> | grep -i volcano
   ```

   Two generations of Volcano workloads, or an AppRelease of the previous version that is still present, matches this cause.

2. Compare the template in use with the template package of the installed Alauda AI version; the old template lacks fields the new one has.
3. Upload the current template again to the same **Task Template** location. Reopen **Create Fine-tuning Task**, select the template, and confirm that the configuration form renders.

### Cause 3: the text input column takes text columns only

Select one or more text columns as the text input column and leave the label column out.

## Diagnostic Steps

1. Confirm the feature is on:

   ```bash
   kubectl get amlcluster default -o jsonpath='{.spec.values.experimentalFeatures}{"\n"}'
   ```

   The output should include `tuneModels: true`.

2. Open the browser developer tools (F12) on the fine-tuning page. An empty template list returned with HTTP `200` points at missing or unlabeled templates (Cause 1). A `500` from `aml-api-deploy-svc` points at the backend, not at templates.
3. For a blank form, note which template was selected and compare its files with the current template package (Cause 2).
4. A question about which dataset columns to select is Cause 3.
