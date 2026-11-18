---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.1.4"
  - "4.2"
  - "4.3"
---

# Namespace quota exceeds the project quota, a project shows the whole cluster's resources, or system namespaces on ACP

## Issue

The project view shows quota, resources, or namespaces that do not match what the project should own. Typical questions:

- "The project has a resource quota, but a namespace created in it has no limit." The namespace quota can then exceed the project quota, and the console does not force a quota when the namespace is created.
- A namespace quota change is rejected.
- "The `cpaas-system` quota is allocated unreasonably and cannot be managed." `cpaas-system` appears with a project and quota figures.
- "How do I give a user `kube-system` access?" The project namespace list shows `命名空间 (0)` (Namespaces (0)) with `无可用命名空间，请联系管理员创建命名空间或添加已有命名空间权限` (no namespace available, ask an administrator), and a chart deployed from Platform Management > App Store Management > Template Repository offers only `default`.
- "How do I dedicate a few nodes to one project?" After nodes are dedicated, a namespace with no project quota still shows the whole cluster's resources.
- "Which namespaces on this cluster are built in by the platform?" A security scan flags `acp-storage` and `argo-rollouts` and asks whether they can be removed.

## Root Cause

### Cause 1: namespace quota fields are optional, and a namespace can be created without a quota limit

Project quota (`projectquota.auth.alauda.io`) is enforced only when a namespace `ResourceQuota` is created or updated: the sum of the same keys across the project's namespaces must stay within the project's hard limits. On the namespace creation page the resource quota is optional; a resource type with no quota is unbounded, so the namespace can consume all of that resource allocated to the project. A key that is not written into the namespace `ResourceQuota` is not limited by the project quota. Separately, creating a namespace in a project that has a quota can intermittently produce a namespace with no quota limit at all; this is a known product defect with a fix planned for 4.3, and no workaround is available for it.

### Cause 2: a namespace quota change that would exceed the project quota is rejected

Namespace quotas are carved out of the project quota. A change that would push the project total above its hard limit is rejected; the project quota has to be raised first.

### Cause 3: the `cpaas-system` project shown from the cluster view is display only

There is no real `cpaas-system` project. When `cpaas-system` is opened from a cluster's container groups, the project shown is for display only, and its overview and resource limits can be ignored.

### Cause 4: `kube-system` and `cpaas-system` are not offered as project namespaces by design

System namespaces such as `kube-system` and `cpaas-system` are not selectable in the project namespace list or the template deployment form. Making them selectable is a feature request, not a setting.

### Cause 5: dedicated nodes are a Node Isolation Policy, and resource figures follow quota, not nodes

Nodes are dedicated to a project with a Node Isolation Policy (Platform Management > Security Management) with **Project Exclusive** (`项目独占`) on: only the projects in the policy may use the nodes. Resource pages on the container platform show resources by project and namespace, not by node. A project without a quota can use the whole cluster, so its namespace shows the whole cluster's totals even when its Pods can land only on the dedicated nodes. Project exclusivity and project quota can be used together. This was confirmed on 4.1.4.

### Cause 6: platform namespaces depend on which components are installed

There is no single official list of platform namespaces. Common ones:

- Always present: `cpaas-system` (platform components) and `kube-system` (Kubernetes system components), plus the Kubernetes defaults `default`, `kube-public`, and `kube-node-lease`.
- Present when the related component is deployed: `argocd`, `cert-manager` (certificate management), `katanomi-system` (pipeline katanomi components), `kubevirt` (virtualization), `rook-ceph` (Ceph storage), `nativestor-system` (TopoLVM local storage), `operators` (pipeline-related operators such as `devops-tool-operator-controller-manager`, `harbor-operator-controller-manager`, `katanomi-api`), `rds-system` and `redis` (data services), `argo-rollouts` (default namespace of Alauda Build of Argo Rollouts), and `acp-storage` (default namespace of Alauda Build of Local Storage and of Alauda Container Platform Storage Essentials).

These are system-component namespaces, not business namespaces to delete.

## Resolution

### Cause 1: namespace quota fields are optional, and a namespace can be created without a quota limit

1. Find the project's namespaces that have no `ResourceQuota`, and compare the keys of an existing quota with the project's:

   ```bash
   PROJECT=<project-name>
   for ns in $(kubectl get namespace -l "cpaas.io/project=${PROJECT}" -o name | cut -d/ -f2); do
     printf '%s ' "$ns"; kubectl get resourcequota -n "$ns" --no-headers 2>/dev/null | wc -l
   done
   kubectl get projectquota -l "cpaas.io/project=${PROJECT}" -o yaml
   kubectl get resourcequota -n <namespace> -o yaml
   ```

   `0` means no `ResourceQuota`; a quota whose `hard` lacks `requests.cpu`, `limits.cpu`, `requests.memory`, or `limits.memory` leaves those resources unbounded.

2. Set the missing values in the console as a normal namespace quota update (Project Management > Namespaces > the namespace > resource quota). The platform rejects a value above what the project has left. When creating namespaces, fill in requests and limits instead of leaving them unlimited.
3. For the intermittent defect where a namespace in a quota-limited project is created with no quota limit, upgrade to 4.3, where the fix is planned.

### Cause 2: a namespace quota change that would exceed the project quota is rejected

Raise the project quota on the project details page first, or reduce other namespaces' quotas, then change the namespace quota:

```bash
kubectl get projectquota -l "cpaas.io/project=<project-name>" -o yaml
kubectl get resourcequota -n <namespace> -o yaml
```

### Cause 3: the `cpaas-system` project shown from the cluster view is display only

No action is needed.

### Cause 4: `kube-system` and `cpaas-system` are not offered as project namespaces by design

No setting changes this. Submit a feature request if it is needed.

### Cause 5: dedicated nodes are a Node Isolation Policy, and resource figures follow quota, not nodes

1. Go to Platform Management > Security Management > Node Isolation Policy > **Create**. Enter a name, turn on **Project Exclusive** (`项目独占`), select the project and the nodes, read the confirmation dialog, and create the policy.

   > **Warning:** Existing Pods of the project are moved onto the policy's nodes only when they are rebuilt; with Project Exclusive on, Pods of other projects already on those nodes are not evicted automatically. Only when these nodes should serve this project alone; plan the rescheduling in a maintenance window. Rollback: delete the policy, or turn Project Exclusive off.

2. Find workloads of other projects still running on a dedicated node and restart them so they are scheduled elsewhere:

   ```bash
   kubectl get pods -A -o wide --field-selector spec.nodeName=<node>
   ```

   > **Warning:** A restart recreates all Pods of the workload; a single-replica workload is briefly unavailable. Only for other projects' workloads still on the dedicated nodes. Rollback: none needed.

   ```bash
   kubectl rollout restart deployment/<deployment> -n <other-project-namespace>
   ```

3. To see the project's own capacity, set a project quota sized to the total resources of the dedicated nodes, then view it under Project Management > Namespaces. Node status is checked in the cluster view.

### Cause 6: platform namespaces depend on which components are installed

For a namespace not in the list, look at what runs in it and how it is labeled:

```bash
kubectl get pods -n <namespace>
kubectl get namespace <namespace> --show-labels
kubectl get deploy,sts,ds -n <namespace>
```

Pods named after platform components (for example `topolvm-*` or `katanomi-*`) identify a platform namespace. A `cpaas.io/project` label that names a business project identifies a project namespace. Answer a scan finding on `acp-storage` or `argo-rollouts` by showing the owning component running there.

## Diagnostic Steps

```bash
kubectl get namespace -l "cpaas.io/project=<project-name>"
kubectl get resourcequota,limitrange -n <namespace>
kubectl get projectquota -l "cpaas.io/project=<project-name>"
```

| What you see | Cause |
| --- | --- |
| Namespace in a quota-limited project has no `ResourceQuota`, or its quota lacks CPU or memory keys | 1 |
| Namespace quota update rejected as exceeding the project quota | 2 |
| `cpaas-system` shows a project and quota that cannot be managed | 3 |
| `kube-system` or `cpaas-system` missing from the project namespace list or the chart form | 4 |
| Nodes needed for one project only, or a namespace shows the whole cluster's resources | 5 |
| Which namespaces belong to the platform, or a scan flags `acp-storage` or `argo-rollouts` | 6 |
