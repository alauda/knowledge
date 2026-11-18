---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.2"
---

# Helm chart deployment from Catalog fails or creates the wrong objects on ACP

## Issue

A custom Helm chart deployed from Catalog (template deployment, a `HelmRequest` reconciled by `captain`) fails, or deploys a different set of objects than expected:

- A `range` that should create several Deployments creates only the last one; the earlier names show up and then are not found.
- The same package installs with `helm install`, but the platform rejects it: a permission error creating `apps/v1` Deployments, or a refusal to create resources outside the target namespace.
- `captain-controller-manager` fails the release with `artifacts.app.alauda.io "<chart>" not found` (for example `"higress-core"`).
- The deployment log shows `ytt: Error: Compiling YAML template 'template.yaml'`, `Expected ytt-formatted string (use '#@' for annotations or code, '#!' for comments)` and `error: no objects passed to apply`.
- The deploy fails with `rendered manifests contain a resource that already exists` and `cannot be imported into the current release`, naming a cluster-scoped object of another release.
- A release installed with `helm install` never appears as a platform application, or a later HelmRequest for it fails.
- The first import of a template reports success and creates no resources, although Harbor has the chart; a second import creates them.

A chart that Catalog does not list at all, or lists without a selectable version, is covered in [Catalog does not list a Helm chart that is already in Harbor, or a newly uploaded chart version, on ACP](Catalog_does_not_list_a_Helm_chart_that_is_already_in_Harbor_or_a_newly_uploaded_chart_version_on_ACP.md).

## Root Cause

### Cause 1: `range` emits several Deployments as one YAML document

The template walks a list with `range` and prints a Deployment each time, without a `---` document separator inside the loop. Helm parses the output as a single Deployment, and only the last iteration is stored. The earlier names may still appear in the UI, but no such Deployment exists.

### Cause 2: the chart renders namespaced objects outside the target namespace

HelmRequest `spec.namespace` is the namespace the release is installed into, and the chart has to render that same namespace. A chart that hard-codes `metadata.namespace` to another namespace fails on the platform even though `helm install` of it succeeds: a normal user gets a permission error creating Deployments, and a platform administrator is told that resources are not allowed in a namespace other than the target namespace.

The restriction is about namespaced objects. Catalog does not filter cluster-scoped objects that the chart defines, such as CRDs, StorageClasses, PersistentVolumes, and ClusterRoles; they are created. Whether they are created successfully depends on the template content, the permissions in the cluster, and the storage backend.

### Cause 3: `artifacts.app.alauda.io "<chart>" not found`

`captain` looks the chart up as an `Artifact`. The named chart (for example a dependency such as `higress-core`) is not in the template repository the deploy resolves from. Uploading the parent chart does not create the Artifact of that chart. The same log can also contain an `Unauthorized` HelmRequest error, which is a different fault; see [Application updates are slow, status stays Failed or Processing, or delete hangs because of captain on ACP](Application_updates_are_slow_status_stays_Failed_or_Processing_or_delete_hangs_because_of_captain_on_ACP.md).

### Cause 4: the chart's `template.yaml` is not valid ytt

The chart's own `template.yaml` is processed by ytt, and ytt rejects plain `#` comment lines: it accepts `#@` for annotations or code and `#!` for comments. Example:

```text
ytt: Error: Compiling YAML template 'template.yaml':
  Failed to parse line 113: '# ytt if/end: only wraps the immediately following node':
    Expected ytt-formatted string (use '#@' for annotations or code, '#!' for comments)
error: no objects passed to apply
```

Here line 113 is a plain comment placed right before `#@ if/end data.values.certmanagerEnabled:`. ytt fails on it, produces no objects, and the apply step has nothing to apply. The failure is in the chart content, not in the platform's Helm; the bundled Helm version (`v3.12.1` on ACP 4.0, older than some charts require) is not what produces this error.

### Cause 5: a cluster-scoped object already belongs to another release

```text
rendered manifests contain a resource that already exists
ClusterRole "<name>" in namespace ""
cannot be imported into the current release
release-name must equal "<new-release>": current value is "<owning-release>"
release-namespace must equal "<new-namespace>": current value is "<owning-namespace>"
```

A cluster-scoped object rendered by the chart already exists, and its Helm ownership annotations point to a different release in a different namespace, typically an earlier install of the same operator chart under another release name. Helm refuses to take over an object owned by another release.

### Cause 6: a release installed with `helm install` is not a platform application

Catalog creates a HelmRequest (`chart`, `version`, `clusterName`, `namespace`, `releaseName`, `values`, `valuesFrom`), and `captain` installs the release and writes `status.phase` and `status.reason`. A release created only with `helm install` on a server has no HelmRequest, so the platform does not show it as an application, and a later HelmRequest for the same release conflicts with it.

### Cause 7: the first template import reports success and creates no resources

The first import reports success and Harbor has the chart, but no resources are created; importing the same template again creates them. This is a product defect fixed in ACP 4.2.5.

## Resolution

### Cause 1: `range` emits several Deployments as one YAML document

Put a document separator inside the loop so each iteration is its own object:

```yaml
{{- range .Values.deployments }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  namespace: {{ $.Release.Namespace }}
spec:
  selector:
    matchLabels:
      app: {{ .name }}
  template:
    metadata:
      labels:
        app: {{ .name }}
    spec:
      containers:
        - name: app
          image: {{ .image }}
{{- end }}
```

`helm template <release> ./chart --namespace <target-namespace>` must print one `---` document per Deployment. Package the chart as a new version, upload it through Catalog, and redeploy.

### Cause 2: the chart renders namespaced objects outside the target namespace

Render namespaced objects into the release namespace (`{{ .Release.Namespace }}`, as in Cause 1) and remove hard-coded namespaces. Check before uploading:

```bash
helm template <release> ./chart --namespace <target-namespace> | grep -n '^  namespace:'
```

Every namespaced object must show `<target-namespace>`. Upload the new version and redeploy into that namespace.

### Cause 3: `artifacts.app.alauda.io "<chart>" not found`

1. Upload the missing chart package into the same template repository the parent chart is resolved from (Catalog > Helm Charts > Add Template, or the Catalog API `POST /catalog/v1/chartrepos/cpaas-system/<chartrepo>/charts`).
2. Retry the HelmRequest once the Artifact exists:

   ```bash
   kubectl get artifact -A | grep <chart>
   kubectl get helmrequest -n <namespace> <name> -o jsonpath='{.spec.dependencies}{"\n"}{.status.phase}{" "}{.status.reason}{"\n"}'
   ```

If the HelmRequest lists names in `spec.dependencies`, those HelmRequests must be in the same namespace and `Synced` first. The package has to exist even when `spec.dependencies` is empty.

### Cause 4: the chart's `template.yaml` is not valid ytt

Fix the line the error names: turn the plain comment into a ytt comment (or remove it) and keep the `#@` annotation that follows:

```yaml
#! ytt if/end: only wraps the immediately following node
#@ if/end data.values.certmanagerEnabled:
- --cert-dir=/var/run/gpustack/certs
```

Check every other plain `#` line in files that ytt processes, then repackage, upload the new version, and redeploy. With the ytt CLI, `ytt -f template.yaml` (plus the data values the template expects) reproduces the parse error offline.

### Cause 5: a cluster-scoped object already belongs to another release

1. Read the ownership of the object named in the error and confirm it matches the `current value` in the message:

   ```bash
   kubectl get clusterrole <name> \
     -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}{" "}{.metadata.annotations.meta\.helm\.sh/release-namespace}{"\n"}'
   helm list -A | grep <owning-release>
   kubectl get helmrequest -A | grep <owning-release>
   ```

2. When the owning release is no longer needed (or agrees to give up the object), delete the object and deploy the chart again.

   > **Warning:** Deleting a ClusterRole removes those permissions from every subject bound to it; workloads of `<owning-release>` lose that access at once. Only when the `cannot be imported into the current release` error is confirmed for this object. Precondition: the object is saved by the first command. Rollback: before the new deploy, `kubectl apply -f <name>.yaml`; after the new release has created its own copy, the new release has to be removed first.

   ```bash
   kubectl get clusterrole <name> -o yaml > <name>.yaml
   kubectl delete clusterrole <name>
   ```

3. If the next attempt names another object, repeat the ownership check for that object instead of deleting objects blindly.

### Cause 6: a release installed with `helm install` is not a platform application

Install charts that must appear as applications through Catalog. For a release that already exists, either keep managing it with Helm and create no HelmRequest with the same release name, or uninstall it in a window and let the HelmRequest install it.

> **Warning:** `helm uninstall` deletes the workloads of that release and cannot be undone. Only when a HelmRequest will reinstall the same chart and you have its package and values. Rollback: `helm install` the same package again.

```bash
helm list -n <namespace>
kubectl get helmrequest -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,CHART:.spec.chart,REL:.spec.releaseName,PHASE:.status.phase,REASON:.status.reason
helm uninstall <release> -n <namespace>
```

### Cause 7: the first template import reports success and creates no resources

Import the template again; the second import creates the resources. Upgrade to ACP 4.2.5 or later for the fix. If a first import still creates nothing on 4.2.5 or later, or the application exists but stays processing with `spec.assemblyPhase` `pending`, use [Application updates are slow, status stays Failed or Processing, or delete hangs because of captain on ACP](Application_updates_are_slow_status_stays_Failed_or_Processing_or_delete_hangs_because_of_captain_on_ACP.md) instead.

```bash
kubectl get application -n <namespace> <application> -o jsonpath='phase={.status.phase} assembly={.spec.assemblyPhase}{"\n"}'
```

## Diagnostic Steps

```bash
helm template <release> ./chart --namespace <target-namespace>
kubectl -n cpaas-system logs deploy/captain-controller-manager --tail=200 | grep -E 'artifacts.app.alauda.io|Unauthorized'
kubectl get helmrequest -n <namespace> <name> -o jsonpath='{.status.phase}{" "}{.status.reason}{"\n"}'
```

The HelmRequest `status.reason` carries the failure text of a Catalog deployment.

```text
helm template prints several Deployments as one document, the UI keeps only the last   -> Cause 1
rendered namespace differs from <target-namespace>; helm install works, platform refuses -> Cause 2
captain log: artifacts.app.alauda.io "<chart>" not found                               -> Cause 3
ytt: Error ... Expected ytt-formatted string, then error: no objects passed to apply    -> Cause 4
rendered manifests contain a resource that already exists ... cannot be imported        -> Cause 5
release only in helm list, no HelmRequest, or a new HelmRequest fights it               -> Cause 6
first import said success, Harbor has the chart, nothing created                         -> Cause 7
```
