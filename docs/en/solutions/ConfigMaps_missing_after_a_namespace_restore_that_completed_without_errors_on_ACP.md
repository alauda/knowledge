---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# ConfigMaps missing after a namespace restore that completed without errors on ACP

## Issue

A namespace was restored with the platform backup and restore tool on Alauda Container Platform. The restore task shows `Completed`, neither the backup task nor the restore task reported an error, and yet some objects (for example two ConfigMaps) are missing from the restored namespace. The objects can be recreated by importing their YAML in the console, but the question is why they are missing, and whether the restore task logs or the backup files show it.

Typical `kubectl -n cpaas-system describe restores.velero.io <restore-name>` output:

- `Phase: Completed`, `Items Restored` equal to `Total Items`, and a non-zero `Warnings` count;
- `Spec.Included Namespaces` names the source namespace, and `Spec.Namespace Mapping` maps it to a new target namespace.

## Root Cause

### Cause 1: the objects were restored and deleted afterwards

The Velero log on the restore cluster contains, for each missing ConfigMap, an `Attempting to restore ConfigMap: <configmap-name>` entry with `resource=configmaps` and the target namespace, followed by a `level=info` progress entry such as `Restored <n> items out of an estimated total of <total>`. That shows the backup carried the objects and the restore created them without error. The platform audit logs of the restore cluster then show that the ConfigMaps existed in the target namespace and were deleted manually after the restore. The restore was not at fault.

The `describe` output and its warning count do not identify individual objects; only the per-object Velero log entries and the audit log do.

## Resolution

### Cause 1: the objects were restored and deleted afterwards

Use this only when the Velero log shows the missing object being restored (Diagnostic Steps, step 2).

1. Search the platform audit logs of the restore cluster for operations on ConfigMaps with that name in the target namespace, to find who deleted them and when.
2. Recreate the missing objects, through the console YAML import or with `kubectl` when the source namespace still holds them:

```bash
kubectl -n <source-namespace> get configmap <configmap-name> -o yaml > /tmp/<configmap-name>.yaml
```

Edit the file: set `metadata.namespace` to the target namespace and remove `metadata.uid`, `metadata.resourceVersion`, `metadata.creationTimestamp`, and `metadata.managedFields`. Then create the object and check the workloads that use it:

```bash
kubectl apply -f /tmp/<configmap-name>.yaml
kubectl -n <target-namespace> get configmap <configmap-name>
kubectl -n <target-namespace> get pods
```

If the log has no `Attempting to restore` entry for the object, it was not restored by this task. Check whether the backup contained it, as described in [What platform backup, application snapshots, and volume snapshots cover on ACP](./What_platform_backup_application_snapshots_and_volume_snapshots_cover_on_ACP.md).

## Diagnostic Steps

1. Work on the cluster that runs the restore, not on the backup source cluster; it is the cluster where the `Restore` object exists:

```bash
kubectl -n cpaas-system get restores.velero.io <restore-name>
kubectl -n cpaas-system get restores.velero.io <restore-name> -o jsonpath='{.status.phase}{" "}{.status.progress}{" warnings="}{.status.warnings}{"\n"}'
```

2. Search the Velero log for the missing object. Velero tags restore log entries with `restore=cpaas-system/<restore-name>`. A restore of a few thousand items writes many lines, so do not cut the log with a small `--tail`:

```bash
kubectl -n cpaas-system logs deploy/velero | grep 'restore=cpaas-system/<restore-name>' | grep -A2 'Attempting to restore ConfigMap: <configmap-name>'
kubectl -n cpaas-system logs deploy/velero | grep 'restore=cpaas-system/<restore-name>' | grep -iE 'level=(warning|error)'
```

If the Velero pod restarted after the restore, add `--previous`, or read the stored restore log through the Velero CLI in the pod:

```bash
kubectl exec -n cpaas-system deploy/velero -- ./velero restore describe <restore-name> --details
kubectl exec -n cpaas-system deploy/velero -- ./velero restore logs <restore-name> | grep '<configmap-name>'
```

3. Do not treat an empty label query as proof that the restore skipped the object. Velero labels restored objects with `velero.io/restore-name`, but an object deleted after the restore is not listed either:

```bash
kubectl -n <target-namespace> get configmap -l velero.io/restore-name=<restore-name>
```

4. Match the result:
   - `Attempting to restore ConfigMap: <name>` present, followed by a `Restored <n> items` entry, and the object is gone now: Cause 1; check the audit log for the deletion.
   - No entry for the object: it was not restored by this task; check the backup content.

## Related Information

- [Application restore fails, hangs, or restored workloads do not run on another cluster on ACP](./Application_restore_fails_hangs_or_restored_workloads_do_not_run_on_another_cluster_on_ACP.md)
