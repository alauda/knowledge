---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# ClickHouse log storage plugin install fails or ClickHouse does not start on ACP

## Issue

Alauda Container Platform Log Storage for ClickHouse (module `logclickhouse`) is installed or reinstalled on a cluster and never reaches a working state. Typical reports:

- "After a redeploy the ClickHouse cluster fails with a port `already in use`, but nothing on the node uses that port."
- "The pre-upgrade inspection says the logging ClickHouse is abnormal."
- "The ClickHouse storage plugin failed while waiting for resources to be ready."
- "`logclickhouse` cannot be installed, and the plugin shows `安装失败` (installation failed)."
- "The logging ClickHouse is not running, and the log only says it cannot find `storage_configuration.xml`."

The pods in `cpaas-system` are `chi-cpaas-clickhouse-replicated-<shard>-<replica>-0` (ClickHouseInstallation `cpaas-clickhouse`) and `razor-<n>` (StatefulSet `razor`). The operator is `clickhouse-operator`. Some background on the install:

- `vector` is a container inside the `razor` pod, not a separate workload. Deploying ClickHouse log storage deploys `razor` and `vector` automatically.
- ClickHouse Keeper runs inside the ClickHouse container. In the pod, `clickhouse-server` listens on 8123, 9000, 9004, 9005, 9009, 9181 and 9444.
- The default data paths are `/cpaas/data/clickhouse` for ClickHouse and `/cpaas/data/vector` for the `vector` buffer. On nodes with an immutable OS they are under `/var/cpaas` instead.

This article covers the cases where ClickHouse itself does not come up. When ClickHouse runs but `razor` does not become ready, see [razor does not become ready after a ClickHouse log storage install or upgrade on ACP](./razor_does_not_become_ready_after_a_ClickHouse_log_storage_install_or_upgrade_on_ACP.md). An install with HTTPS S3 storage signed by a private CA is covered in [ClickHouse log storage fails on HTTPS S3 with a self-signed CA without the clickhouse-ca-certificates Secret on ACP](./ClickHouse_log_storage_fails_on_HTTPS_S3_with_a_self-signed_CA_without_the_clickhouse-ca-certificates_Secret_on_ACP.md).

## Root Cause

### Cause 1: ClickHouse reports a port already in use although no host process holds it

The logging ClickHouse fails after a redeploy and reports a port as `already in use`. The failure can first show up as an abnormal component in a pre-upgrade inspection. The ClickHouse log shows:

```text
<Warning> Context: Effective user of the process (clickhouse) does not match the owner of the data (root).
Application: Listen [0.0.0.0]:9181 failed: Poco::Exception. Code: 1000, e.code() = 98, Net Exception: Address already in use: 0.0.0.0:9181
Application: Listen [0.0.0.0]:9009 failed: Poco::Exception. Code: 1000, e.code() = 98, Net Exception: Address already in use: 0.0.0.0:9009
RaftInstance: deny, req term 6904, my term 6904, req log idx 77357199, my log idx 77357150
```

Nothing listens on that port on the node. The cluster had been deployed more than once, and the PVCs of an earlier deployment were never deleted. State files left in those old volumes make the new cluster believe the port is taken. Inside the pod, `netstat -tulpn` shows `clickhouse-server` itself on 9181 and 9009. Uninstalling the logging component, deleting the old PVCs and deploying again fixes it. Deleting the PVCs is the step that cannot be skipped.

A variant logs `Unable to resolve placement (cpaas-clickhouse-keeper)` beside the same `Address already in use` lines for 9181 and 9009, and `RaftInstance: peer (2) response error: failed to connect to peer 2`. The Keeper quorum never forms, ClickHouse is not ready, and Vector and razor fail with connection errors. That placement failure has not been fully diagnosed. The install succeeded after the leftover contents of `/cpaas/data` on the ClickHouse nodes were deleted before the install. Using Elasticsearch log storage instead is the alternative when this does not help.

Lines such as `RaftInstance: session ... failed to read rpc header from socket ... End of file` about every 10 seconds, or `CgroupsReader: Cannot find 'kernel' in '/sys/fs/cgroup/memory.stat'`, also appear on clusters that work. They are not the failure.

### Cause 2: The install fails and the operator ArtifactVersions stay empty because CPU passthrough is off

Deploying the cluster plugin on a workload cluster ends in `安装失败` (installation failed) with:

```text
failed to install chart for release "logclickhouse-operators": execution error at (install-operators/templates/subscriptions.yml:68:26): PackageManifest "cpaas-logging/clickhouse-operator" not exists.
```

The operator packages had been uploaded. The control-plane logs repeat `"wait csv" err="packagemanifests.packages.operators.coreos.com \"<operator>\" not found"`. `kubectl get artifactversion -A` lists `clickhouse-operator.<version>` and the other operators in `cpaas-system` with empty `VERSION`, `PHASE` and `REASON` columns.

The node VMs did not have CPU passthrough enabled. ClickHouse binaries require the SSE 4.2 instruction set, and a virtual CPU model that hides host CPU flags does not expose it. Without it the operator artifacts never became ready, and no PackageManifest was produced. After passthrough was enabled, the install succeeded.

### Cause 3: ClickHouse does not start and its log stops at Can not find storage_configuration.xml in configmap, skip

```text
[INFO] Try to parse HOST and DOMAIN ... [INFO] Try to generate keeper settings ... [INFO] Can not find storage_configuration.xml in configmap, skip
```

These lines are normal initialization messages, not the error. The resources configured for the ClickHouse component were too small for it to start. Raising them on the plugin let ClickHouse start normally.

## Resolution

### Cause 1: ClickHouse reports a port already in use although no host process holds it

1. Confirm the signature:

   ```bash
   kubectl -n cpaas-system get pod | grep -E 'click|raz'
   kubectl -n cpaas-system logs <ck-pod> -c clickhouse --tail=50 | grep -Ei 'already in use|placement'
   ss -ltnp | grep -E ':(8123|9000|9009|9181|9444)\b'
   kubectl -n cpaas-system get pvc | grep -Ei 'clickhouse|razor'
   ```

   Run `ss` on the node. This cause matches when the pod log says `already in use`, `ss` shows no listener on the node, and some PVCs are older than the current install. To see that ClickHouse itself holds the port inside the pod:

   ```bash
   kubectl -n cpaas-system exec <ck-pod> -c clickhouse -- netstat -tulpn
   ```

2. Uninstall the logging component, then delete the leftover PVCs.

   > **Warning:** Deleting the old ClickHouse PVCs destroys the log data in them, and log search stays empty until the new cluster ingests again. Precondition: only when this cause is confirmed, the logging component is already uninstalled, and every PVC you delete belongs to an earlier ClickHouse deployment. Rollback: none; local volumes are gone together with their data.

   ```bash
   kubectl -n cpaas-system delete pvc <old-clickhouse-pvc>
   ```

   Repeat this for each leftover PVC, and confirm that the PVs are released or deleted. If the PVs use node-local storage and keep their files, also empty the host path printed in the PV's `spec.local.path`.

3. Deploy the logging component again.

4. For the `Unable to resolve placement (cpaas-clickhouse-keeper)` variant without leftover PVCs, list what is left under `/cpaas/data` on each ClickHouse node (`du -sh /cpaas/data/*`).

   > **Warning:** Deleting the contents of `/cpaas/data` removes every log storage data directory on that node, including Elasticsearch, Kafka or ZooKeeper data if those also run there. Precondition: only when the logging component is uninstalled, the placement error persists, and the directories hold nothing that must be kept. Rollback: none.

   Delete the leftover contents, then install again. If the placement error persists, use Elasticsearch log storage on that cluster instead.

### Cause 2: The install fails and the operator ArtifactVersions stay empty because CPU passthrough is off

1. Confirm the signature:

   ```bash
   kubectl get artifactversion -A
   kubectl get packagemanifest -A | grep -i clickhouse
   grep -o -w -E 'sse4_2|avx|avx2' /proc/cpuinfo | sort | uniq -c
   ```

   Run the `grep` on a node VM. Empty `VERSION`, `PHASE` and `REASON` columns on the operator ArtifactVersions, no `clickhouse-operator` PackageManifest, and missing CPU flags all match this cause.

2. Enable CPU passthrough on the hypervisor.

   > **Warning:** Changing the VM CPU mode needs a VM restart, which stops every pod on that node. Precondition: the node is cordoned and drained (`kubectl cordon <node>` and `kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`), and the hypervisor allows host passthrough for that VM. Rollback: switch the CPU mode back and restart again.

   Set the CPU mode of the node VMs to host passthrough, restart them one at a time, and run `kubectl uncordon <node>` when each node is back.

3. Retry the plugin install.

### Cause 3: ClickHouse does not start and its log stops at Can not find storage_configuration.xml in configmap, skip

1. Check the current resources and events:

   ```bash
   kubectl -n cpaas-system describe pod <ck-pod> | grep -E 'Limits|Requests|OOMKilled|Events' -A3
   kubectl get moduleinfo <clickhouse-moduleinfo> -o yaml | grep -n -A6 resources
   ```

2. Raise the resources.

   > **Warning:** Changing the resources restarts the ClickHouse pods. Precondition: the nodes have free CPU and memory for the new values. Rollback: set the previous values on the plugin.

   Raise the ClickHouse CPU and memory on the log storage plugin (Marketplace, Cluster Plugins, update the plugin). Size them from the node capacity. No single value is prescribed.

## Diagnostic Steps

1. Read the plugin and pod state:

   ```bash
   kubectl get ars -A | grep -Ei 'click|log'
   kubectl get artifactversion -A | grep -i clickhouse
   kubectl -n cpaas-system get pods | grep -Ei 'click|razor'
   kubectl -n ck-system get pods 2>/dev/null
   ```

2. Match the signature:

   | What you see | Cause |
   |---|---|
   | `already in use` with no host listener, or `Unable to resolve placement (cpaas-clickhouse-keeper)` | Cause 1 |
   | `PackageManifest "cpaas-logging/clickhouse-operator" not exists`, or empty operator ArtifactVersions on VMs without CPU passthrough | Cause 2 |
   | A log that stops at the `storage_configuration.xml` line, with small resource limits | Cause 3 |

3. If ClickHouse runs and `razor` stays not ready, the failure is in the `razor` initialization. See [razor does not become ready after a ClickHouse log storage install or upgrade on ACP](./razor_does_not_become_ready_after_a_ClickHouse_log_storage_install_or_upgrade_on_ACP.md).

## Related Information

- Related articles: [razor does not become ready after a ClickHouse log storage install or upgrade on ACP](./razor_does_not_become_ready_after_a_ClickHouse_log_storage_install_or_upgrade_on_ACP.md) covers the other first-install and upgrade failures of the same plugin.
- [ClickHouse log storage logs RaftInstance errors with pod restarts, merge CPU spikes, or a hand-built ClickHouse on ACP](./ClickHouse_log_storage_logs_RaftInstance_errors_with_pod_restarts_merge_CPU_spikes_or_a_hand-built_ClickHouse_on_ACP.md)
- [ClickHouse log queries fail after the log storage had been working: missing tables or broken parts on ACP](./ClickHouse_log_queries_fail_after_the_log_storage_had_been_working_missing_tables_or_broken_parts_on_ACP.md)
