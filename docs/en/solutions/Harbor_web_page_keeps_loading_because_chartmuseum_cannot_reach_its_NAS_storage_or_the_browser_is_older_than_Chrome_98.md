---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor web page keeps loading because chartmuseum cannot reach its NAS storage, or the browser is older than Chrome 98

## Issue

The Harbor web UI shows a loading spinner that never finishes, while every Harbor Pod is `Running` and none is in `CrashLoopBackOff`. Harbor looks "slow" rather than down. There are two variants:

- Login works, but opening a project page keeps loading for a very long time.
- The Harbor page stays on loading and never redirects to the login page. The API requests the page sends, as seen in the browser developer tools, return no obvious error.

## Root Cause

### Cause 1: chartmuseum requests to NAS storage time out from a node with a network fault

The `harbor-chartmuseum` Pod is `Running` on a node that has a network fault, and its requests to the NAS (NFS) storage behind its volume time out. A chartmuseum Pod that cannot reach its storage holds the project page in a loading state while the rest of Harbor stays healthy. Moving the Pod to a node with a working network restores the page.

This applies only to Harbor deployments that still include the chartmuseum component with its storage on NAS (NFS). Harbor releases that no longer ship chartmuseum are not affected by this cause.

### Cause 2: the browser is older than Chrome 98

The Harbor UI requires Chrome 98 or later. In an older browser the page cannot render: it keeps loading, never reaches the login page, and the API calls behind it succeed. Updating the browser restores access; no change on the cluster is needed.

## Resolution

### Cause 1: chartmuseum requests to NAS storage time out from a node with a network fault

1. Identify the node that runs chartmuseum and confirm the NAS timeouts from that node (see Diagnostic Steps). Report the node network fault to whoever owns the node network so it gets repaired; the Pod restart below restores the page, it does not repair the node.

2. If the node's network is still faulty, cordon it so the replacement Pod is scheduled on a healthy node.

   > **Warning:** Only when the chartmuseum Pod's node is the one with the confirmed network fault. Impact: no new Pods are scheduled on that node; running Pods stay. Precondition: other nodes have capacity for the chartmuseum Pod and can reach the NAS. Rollback: `kubectl uncordon <node-name>` once the network is repaired.

   ```bash
   kubectl cordon <node-name>
   ```

3. Delete the chartmuseum Pod so its controller recreates it on another node.

   > **Warning:** Only when chartmuseum runs on a node whose NAS requests time out, as confirmed in Diagnostic Steps. Impact: chart requests are interrupted until the replacement Pod is `Ready`. Precondition: the volume is NAS/NFS storage that other nodes can mount. The deleted Pod is not restored; the replacement created by the controller is the recovery.

   ```bash
   NS=<harbor-namespace>
   CM=$(kubectl -n "$NS" get pods -o name | grep chartmuseum | head -1)
   kubectl -n "$NS" delete "$CM"
   kubectl -n "$NS" get pods -o wide | grep chartmuseum
   ```

4. Open the project page again. It loads normally once the new chartmuseum Pod is `Ready` on a healthy node.

### Cause 2: the browser is older than Chrome 98

1. Check the browser version before changing anything in Harbor: open `chrome://version` and read the major version.
2. If it is lower than 98, update the browser to Chrome 98 or later (or open the same Harbor URL in such a browser).
3. Reload the Harbor URL. The login page appears. Do not restart Harbor Pods or edit the Harbor resource for this cause.

## Diagnostic Steps

1. List the Harbor components and follow chartmuseum to its node:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" get pods -o wide
   CM=$(kubectl -n "$NS" get pods -o name | grep chartmuseum | head -1)
   kubectl -n "$NS" logs "$CM" --tail=100
   kubectl -n "$NS" get "$CM" -o jsonpath='{.spec.nodeName}{"\n"}'
   ```

   All Pods `Running` is expected for both causes; it does not rule either out. No chartmuseum Pod at all rules out Cause 1.

2. Check whether the chartmuseum volume is NAS/NFS and whether a filesystem call from the Pod hangs. A `df` that does not return within the timeout means the mount is not answering:

   ```bash
   kubectl -n "$NS" get pvc | grep -i chartmuseum
   kubectl get pv <pv-name> -o jsonpath='{.spec.nfs.server}{" "}{.spec.nfs.path}{"\n"}'
   kubectl -n "$NS" exec "$CM" -- timeout 10 df -h || echo "df did not complete: storage not responding"
   ```

3. On the node that runs chartmuseum, look for NFS timeouts and test reachability of the NAS server. Repeat the `ping` from another node for comparison:

   ```bash
   dmesg -T | grep -iE 'nfs.*(not responding|timed out)' | tail -20
   ping -c 3 <nas-server-address>
   ```

   NFS `not responding` / `timed out` messages on that node only, while other nodes reach the NAS, point to Cause 1.

4. Tell the two causes apart:

   | What you see | Cause |
   | --- | --- |
   | Login works, the project page keeps loading, NAS timeouts only from the chartmuseum node | Cause 1 |
   | The page never reaches login, API requests show no error, the browser is older than Chrome 98 | Cause 2 |
   | The NFS export is reachable but has no free space | [Harbor unreachable or its PostgreSQL out of space because Harbor storage is full](Harbor_unreachable_or_its_PostgreSQL_out_of_space_because_Harbor_storage_is_full.md) |
   | The portal says the core service is unavailable instead of loading slowly | [Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit](Harbor_core_service_unavailable_or_internal_server_error_stuck_instance_status_or_Pods_cycling_after_an_edit.md) |

   For slow `harbor-database` startup on NFS storage, see [Harbor PostgreSQL database Pod never starts after an operator upgrade with transparent huge pages, low CPU, or on NFS](Harbor_PostgreSQL_database_Pod_never_starts_after_an_operator_upgrade_with_transparent_huge_pages_low_CPU_or_on_NFS.md).
