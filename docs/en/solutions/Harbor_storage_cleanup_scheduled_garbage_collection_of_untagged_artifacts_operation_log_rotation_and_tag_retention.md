---
kind:
  - How To
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor storage cleanup: scheduled garbage collection of untagged artifacts, operation-log rotation, and tag retention

## Issue

Harbor storage keeps growing and a cleanup policy is needed, or an image is gone and the question is whether Harbor removed it. Typical questions:

- How do I delete untagged images in Harbor on a schedule?
- Can Harbor keep only one month of operation (audit) logs?
- Do images in Harbor have a retention period, or expire? How do I list every Harbor instance in the cluster?
- A business system restarted and a specific image version can no longer be found in Harbor.
- A retention policy that keeps only the 10 most recently pulled tags has to be set up in many projects. Is there a global or batch way?

All of this is Harbor's own Clean Up service (System Management, Clean Up; English builds label the area Administration) and per-project Tag Retention.

## Root Cause

### Cause 1: untagged artifacts are removed only by garbage collection with the untagged option enabled

Untagged artifacts stay in storage until a garbage collection (GC) run with "Allow garbage collection on untagged artifacts" enabled removes them. The Garbage Collection tab of Clean Up holds the schedule (for example `Weekly`), that option, and the buttons GC Now and Dry Run. Artifacts pushed within the last two hours (the default window) are not collected, so a GC run right after a push can free less than expected.

### Cause 2: operation-log retention is set by Log Rotation, in days

Harbor operation logs are purged by the Log Rotation tab of the Clean Up service. The retention period is set in days, as an integer greater than 0 and less than 10000. The purged operations are Create, Delete, and Pull. Without a saved schedule, nothing is purged and the Log Rotation history stays empty.

### Cause 3: Harbor keeps images until they are deleted; node copies are removed by kubelet image garbage collection

Harbor keeps stored images permanently by default. An image leaves Harbor only when someone deletes it, or when a cleanup policy configured in Harbor (a Tag Retention rule followed by GC) removes it. A restart of a business system does not delete images from Harbor.

The copies of an image on cluster nodes are a separate store. The kubelet garbage-collects node images according to `/var/lib/kubelet/config.yaml`, for example:

- `imageGCHighThresholdPercent: 85`: cleanup starts at 85% disk usage.
- `imageGCLowThresholdPercent: 80`: cleanup stops at 80% disk usage.
- `imageMinimumGCAge: 2m0s`: minimum image age before it can be collected.
- `imageMaximumGCAge: 0s`: age-based cleanup is disabled.

The Pod's `imagePullPolicy` decides whether Harbor is contacted at start: `Always` pulls from Harbor on every start; `IfNotPresent` uses the node copy when it exists. A tag missing from Harbor therefore shows up only when a Pod starts on a node without a copy, or when the policy is `Always`.

### Cause 4: Tag Retention is per project; there is no global or batch setting

Tag Retention in Harbor is a per-project policy. Harbor has no global, one-time configuration that applies a retention policy to all projects, and no product-level batch feature. Each project carries its own policy, created by hand or by a script that calls the Harbor API for each project.

## Resolution

### Cause 1

1. Open Harbor as a system administrator: System Management (Administration), Clean Up, Garbage Collection.
2. Enable "Allow garbage collection on untagged artifacts".
3. Click Dry Run and read its log; it reports what a real run would delete.
4. Set the schedule, for example `Weekly`, and save. Use GC Now only for an immediate run.

> **Warning:** Garbage collection with the untagged option permanently deletes untagged artifacts and the blobs that only they reference. Impact: anything that pulls those artifacts by digest fails afterwards. Precondition: the Dry Run log has been reviewed and no workload depends on untagged digests. Rollback: none; deleted artifacts must be pushed again.

Check the saved schedule and recent runs (read-only):

```bash
curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc/schedule'
curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc?page=1&page_size=10'
```

The schedule response shows the schedule type and `delete_untagged` set to `true` in its parameters.

### Cause 2

1. System Management (Administration), Clean Up, Log Rotation.
2. Set the retention period in days, an integer from 1 to 9999; `30` keeps about one month.
3. Keep the operations to purge (Create, Delete, Pull) selected as required.
4. Set a schedule and save.

> **Warning:** Log Rotation permanently deletes operation-log entries older than the retention period. Impact: the audit history for those operations is gone. Precondition: export the logs first if an audit requirement keeps them longer. Rollback: none.

```bash
curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/purgeaudit/schedule'
```

After the first scheduled run, the Log Rotation history lists a finished job.

### Cause 3

1. List every Harbor instance in the cluster:

   ```bash
   kubectl get harbor -A
   ```

2. Check whether the tag is still in Harbor. A `404` means Harbor no longer has it. A nested repository name is URL-encoded twice (`a/b` becomes `a%252Fb`).

   ```bash
   curl -sk -o /dev/null -w '%{http_code}\n' -u 'admin:<password>' \
     'https://<harbor-host>/api/v2.0/projects/<project>/repositories/<repository>/artifacts/<tag>'
   ```

3. Check the policies that can remove it: the project's Tag Retention rules (Projects, the project, Policy, Tag Retention) and the GC schedule. The project metadata carries a `retention_id` when a retention policy exists.

   ```bash
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/projects/<project>' | grep -o '"retention_id": *"[0-9]*"'
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/retentions/<retention-id>'
   ```

4. Read the project's operation log for delete operations on that repository (the Logs tab of the project). Log Rotation may already have purged old entries.

   ```bash
   curl -sk -u 'admin:<password>' \
     'https://<harbor-host>/api/v2.0/projects/<project>/logs?page=1&page_size=100' | grep -i -B2 -A6 delete
   ```

5. On the node, read the kubelet image GC settings, whether the node still holds the image, and the Pod's pull policy:

   ```bash
   grep -i -E 'imageGC|imageMinimumGCAge|imageMaximumGCAge' /var/lib/kubelet/config.yaml
   crictl images | grep <repository>
   kubectl -n <app-namespace> get pod <pod> -o jsonpath='{range .spec.containers[*]}{.image}{" "}{.imagePullPolicy}{"\n"}{end}'
   ```

   A node copy removed by the kubelet is expected behavior at its thresholds, not a loss from Harbor. If the tag is gone from Harbor, a retention rule, a GC run, or a delete in the project log is where to look. For the node side, see [Container image garbage collection on ACP nodes](Container_image_garbage_collection_on_ACP_nodes.md).

### Cause 4

For one project, in the UI: Projects, the project, Policy, Tag Retention, Add Rule. Choose the rule that retains the most recently pulled artifacts, set the count to `10`, set the repository and tag filters (`**` matches everything), then set a schedule.

For many projects, script it against the Harbor v2.0 API. One way: create the policy once in the UI on a reference project, export it, and post a copy to every project that has no retention policy yet. Test on one project before running it on all.

1. Export the reference policy (`<retention-id>` is the reference project's `retention_id`):

   ```bash
   HARBOR='https://<harbor-host>'
   AUTH='admin:<password>'
   curl -sk -u "$AUTH" "$HARBOR/api/v2.0/retentions/<retention-id>" \
     | jq 'del(.id) | .rules |= map(del(.id))' > /tmp/retention-template.json
   cat /tmp/retention-template.json
   ```

2. List the projects without a retention policy (repeat with `page=2` and so on for more than 100 projects), and remove from the file every project that must not get the policy:

   ```bash
   curl -sk -u "$AUTH" "$HARBOR/api/v2.0/projects?page=1&page_size=100" \
     | jq -r '.[] | select(.metadata.retention_id == null) | "\(.project_id) \(.name)"' > /tmp/retention-targets.txt
   cat /tmp/retention-targets.txt
   ```

3. Create the policy in each listed project. Harbor accepts a create only for a project that has no policy yet; a `201` means it was created.

   > **Warning:** A retention policy removes, on every scheduled run, all tags in its scope that the rule does not retain, here every tag outside the 10 most recently pulled in each repository. Impact: workloads that pull a removed tag fail, and the space returns only after the next GC. Precondition: `/tmp/retention-targets.txt` holds only the intended projects, and a dry run on each project (step 4) is reviewed before its schedule first fires. Rollback: deleting or disabling the policy stops future runs; removed tags must be pushed again.

   ```bash
   while read -r pid name; do
     jq --argjson pid "$pid" '.scope = {"level": "project", "ref": $pid}' /tmp/retention-template.json \
       | curl -sk -u "$AUTH" -H 'Content-Type: application/json' -X POST \
           -o /dev/null -w "$name %{http_code}\n" -d @- "$HARBOR/api/v2.0/retentions"
   done < /tmp/retention-targets.txt
   ```

4. Dry-run each new policy and read the result; with `dry_run` set to `true` nothing is deleted. The project's Tag Retention page shows the same results per repository.

   ```bash
   curl -sk -u "$AUTH" "$HARBOR/api/v2.0/projects/<project>" | jq -r '.metadata.retention_id'
   curl -sk -u "$AUTH" -H 'Content-Type: application/json' -X POST \
     -d '{"dry_run": true}' "$HARBOR/api/v2.0/retentions/<new-retention-id>/executions"
   curl -sk -u "$AUTH" "$HARBOR/api/v2.0/retentions/<new-retention-id>/executions"
   ```

## Diagnostic Steps

1. Read the current Clean Up state before changing anything:

   ```bash
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc/schedule'
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/purgeaudit/schedule'
   ```

2. Untagged artifacts are not removed: check that the GC schedule has `delete_untagged` set to `true`, and remember that artifacts pushed in the last two hours are skipped (Cause 1).

3. Operation logs grow without limit and the Log Rotation history is empty: no Log Rotation schedule is saved (Cause 2).

4. Scheduled or manual GC runs end in `Error`, for example with `0 blob(s) and 0 manifest(s) deleted, 0 space freed`: a schedule whose runs fail frees no space. Read the job log of one failed run; the jobservice Deployment log can show only `reap outdated job stats` lines while the job log holds the error.

   ```bash
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/system/gc/<gc-id>/log'
   ```

   - `failed to execute GC job at mark phase` with `write: broken pipe` to `:5432`: see [Harbor garbage collection fails with write broken pipe to PostgreSQL when jobservice exhausts database connections](Harbor_garbage_collection_fails_with_write_broken_pipe_to_PostgreSQL_when_jobservice_exhausts_database_connections.md).
   - `too many clients already (SQLSTATE 53300)`: see [Harbor PostgreSQL rejects sessions with too many clients already (SQLSTATE 53300)](Harbor_PostgreSQL_rejects_sessions_with_too_many_clients_already_SQLSTATE_53300.md).

5. A tag reported missing, or a question about image expiry: Cause 3. Check the tag in Harbor first, then the policies and the project log, then the node copy and the pull policy.

6. One retention policy needed in many projects: Cause 4. List which projects already have a policy before scripting:

   ```bash
   curl -sk -u 'admin:<password>' 'https://<harbor-host>/api/v2.0/projects?page=1&page_size=100' \
     | jq -r '.[] | "\(.name) \(.metadata.retention_id // "none")"'
   ```
