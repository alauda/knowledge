---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# sentry at full CPU or a redeployed component fails because of Failed or leftover ResourcePatches on ACP

## Issue

- One of the two `sentry` Pods is almost idle and the other runs at about 100% of its CPU limit (around 2000m). The spikes can come and go within minutes.
- The platform cert-manager component keeps upgrading and never finishes.
- After ClickHouse was installed no ClickHouse instance appears, and redeploying the ClickHouse plugin fails.
- `olm-registry-custom`, `olm-registry-platform`, and `olm-registry-system` are all `0/1` `CrashLoopBackOff` a few minutes after they were created.

`sentry` (Deployment `sentry` in `cpaas-system` on each cluster) installs, upgrades, and removes plugin charts and records the result on the `ars` (AppRelease) objects. A ResourcePatch (`rpch`) records a change made to a platform-managed resource; `sentry` applies it on top of the chart every time the release is reconciled. A ResourcePatch is not removed when its plugin is uninstalled, and it is applied again when the plugin is reinstalled.

Related articles: "Plugin install or uninstall stuck, or Marketplace and OperatorHub empty: sentry OOMKilled or cluster-transformer errors".

## Root Cause

### Cause 1: One sentry Pod at 100% CPU because Failed ResourcePatches are retried in a tight loop

The busy `sentry` Pod logs `ResourcePatch Reconcile` every few seconds for the same objects, with errors such as:

```text
Apply ResourcePatch rp-4mcvk for apps/v1.Deployment cert-manager/cert-manager-cainjector in Release cpaas-system/cert-manager error: error in add for path: '/spec/template/spec/containers/1': Unable to access invalid index: 1: invalid index referenced
```

The idle Pod writes no log lines. Three ResourcePatches are in `Failed`, targeting release `cpaas-system/cert-manager` and the `cert-manager-cainjector`, `cert-manager`, and `cert-manager-webhook` Deployments. Each tries to patch `/spec/template/spec/containers/1`, a second container that does not exist in those Deployments, so `sentry` retries them continuously. Deleting those ResourcePatches brings the busy Pod down from about 2000m to about 456m CPU.

### Cause 2: cert-manager keeps upgrading because the platform cert-manager was replaced with community images

The cert-manager component stays in upgrading. `kubectl get rpch -A | grep cert-manager` shows the ResourcePatches for the `cert-manager-cainjector`, `cert-manager-webhook`, and `cert-manager` Deployments and the `cert-manager-webhook` and `cert-manager` Services in `Failed` (the RBAC and ServiceAccount ones `Active`), and the `cert-manager-controller` container runs `jetstack/cert-manager-controller:v1.16.1` with `--leader-election-namespace=kube-system` and `--max-concurrent-challenges=60`.

The cert-manager deployment script of the Kubeflow 1.10 community release, run when Kubeflow was deployed, replaced the platform cert-manager images with community images. That conflicts with the platform component, so its upgrade stays stuck. Restore every cert-manager component to the platform's own images and do not modify platform components. Restoring the images does not affect platform certificates. The Kubeflow certificates issued by the community controller (in `ai-platform`, `kserve`, and `kubeflow`, some managed by Argo CD) stay, but the platform cert-manager manages only platform certificates and will not renew them; the team that deployed Kubeflow has to plan their renewal.

### Cause 3: A leftover ResourcePatch breaks a redeployed component

A component that was removed and deployed again fails, and a ResourcePatch for it from the earlier deployment is still in the cluster.

- ClickHouse: the ClickHouse plugin deployment fails because of a leftover ClickHouse ResourcePatch; after it is deleted, the plugin deploys normally. Separately, the ClickHouse operator (for example `clickhouse-operator.v4.2.1` in `cpaas-logging`, `Succeeded`) does not create an instance by itself; the instance has to be created manually.
- OLM: all three `olm-registry-*` Pods are `0/1` `CrashLoopBackOff` with the same restart count, and ResourcePatches related to them exist. After the patches that are no longer needed are deleted, the OLM components run normally.

## Resolution

### Cause 1: One sentry Pod at 100% CPU because Failed ResourcePatches are retried in a tight loop

```bash
kubectl -n cpaas-system top pod | grep sentry
kubectl -n cpaas-system logs <busy-sentry-pod> --tail=300 | grep -E 'ResourcePatch|invalid index'
kubectl get rpch -A | grep -i failed
```

Back up every ResourcePatch the log names:

```bash
mkdir -p "$HOME/rpch-backup"
for rp in <rpch-1> <rpch-2> <rpch-3>; do kubectl get rpch "$rp" -o yaml > "$HOME/rpch-backup/$rp.yaml"; done
```

> **Warning:** Deleting a ResourcePatch drops the customization it carries from that component. A `Failed` patch is not being applied, so nothing that currently runs changes. Precondition: only for ResourcePatches in `Failed` whose `invalid index referenced` errors repeat in the `sentry` log, with the backups written and the owner of the customization informed. Rollback: `kubectl apply -f "$HOME/rpch-backup/<rpch>.yaml"` (remove `metadata.resourceVersion` and `metadata.uid` first).

```bash
kubectl delete rpch <rpch-1> <rpch-2> <rpch-3>
kubectl -n cpaas-system top pod | grep sentry
```

If `kubectl get rpch -A` shows a namespace for these objects, add `-n <namespace>` to the `get` and `delete` commands.

When the spikes are short and gone before you can look, check for the same retry pattern after the fact: `Failed` ResourcePatches, and the same object names repeating in the `sentry` log. Raising the `sentry` CPU limit does not stop a retry loop.

### Cause 2: cert-manager keeps upgrading because the platform cert-manager was replaced with community images

Confirm the community images and record which certificates depend on them:

```bash
kubectl get ars -A | grep -i cert
kubectl get rpch -A | grep cert-manager
kubectl get deploy -A | grep cert-manager
kubectl -n <cert-manager-namespace> get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}'
kubectl get certs -A
kubectl -n <cert-manager-namespace> get deploy -o yaml > "$HOME/cert-manager-deploy.before.yaml"
```

Images such as `jetstack/cert-manager-controller:<version>` instead of images from the platform registry are this cause. Get the platform images and container settings for your platform version from a cluster on the same version where cert-manager is healthy (same command), or from Alauda support.

> **Warning:** Restoring the platform cert-manager images changes the controller that issues certificates; the Kubeflow certificates created by the community controller stay but are no longer renewed by the platform cert-manager. Precondition: only when the cert-manager Deployments run community images after a Kubeflow community deployment script and the cert-manager upgrade is stuck; agree with the team that owns Kubeflow how its certificates will be renewed first. Rollback: `kubectl apply -f "$HOME/cert-manager-deploy.before.yaml"`, which returns the conflicting state.

```bash
kubectl -n <cert-manager-namespace> set image deploy/<cert-manager-deployment> <container>=<platform-registry>/<platform-cert-manager-image>:<tag>
kubectl get ars -A | grep -i cert
```

Repeat for each cert-manager Deployment, and bring the container arguments back to the platform values if they differ (the community controller runs with `--leader-election-namespace=kube-system`). Do not run third-party scripts that modify platform components.

### Cause 3: A leftover ResourcePatch breaks a redeployed component

Find the ResourcePatches for the component, back them up, and confirm with their owner that they are no longer needed:

```bash
kubectl get rpch -A
kubectl get rpch -A -o yaml | grep -n -i -E '<component>|release:'
mkdir -p "$HOME/rpch-backup"
kubectl get rpch <rpch-name> -o yaml > "$HOME/rpch-backup/<rpch-name>.yaml"
```

> **Warning:** Deleting a ResourcePatch removes the customization it would apply to the component when it is deployed again. Precondition: only when the redeployed component (the ClickHouse plugin, or all `olm-registry-*` Pods in `CrashLoopBackOff`) fails, the ResourcePatch belongs to that component's earlier deployment, its owner confirmed it is not needed, and the backup is written. Rollback: `kubectl apply -f "$HOME/rpch-backup/<rpch-name>.yaml"`.

```bash
kubectl delete rpch <rpch-name>
```

Redeploy the ClickHouse plugin, or watch the OLM registry Pods recover (`kubectl -n cpaas-system get pods -w | grep olm-registry`). For ClickHouse, create the ClickHouse instance manually after the plugin is deployed:

```bash
kubectl get csv -n cpaas-logging | grep -i clickhouse
```

## Diagnostic Steps

```bash
kubectl -n cpaas-system get pods | grep sentry
kubectl -n cpaas-system top pod | grep sentry
kubectl get rpch -A
kubectl get rpch -A | grep -i failed
kubectl -n cpaas-system logs <sentry-pod> --tail=300 | grep -E 'ResourcePatch|invalid index'
```

- One `sentry` Pod near its CPU limit logging `ResourcePatch Reconcile` with `invalid index referenced`, and `Failed` ResourcePatches: Cause 1.
- A stuck cert-manager upgrade with `jetstack/...` images: Cause 2.
- A redeployed ClickHouse plugin or OLM registry failing while an old ResourcePatch for it exists: Cause 3.
- `sentry` restarting with `OOMKilled`: see the related article on stuck installs and uninstalls.
