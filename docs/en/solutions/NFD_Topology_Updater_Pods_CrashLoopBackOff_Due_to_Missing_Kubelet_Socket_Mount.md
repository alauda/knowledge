---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# NFD Topology Updater Pods CrashLoopBackOff Due to Missing Kubelet Socket Mount
## Issue

After enabling the topology-updater workload of the Node Feature Discovery (NFD) operator on Alauda Container Platform, the `nfd-topology-updater` pods continually restart with `CrashLoopBackOff`. The NFD custom resource shows the operator in a degraded state, and existing GPU/CPU feature labels stop refreshing on affected nodes.

## Root Cause

The topology updater binary expects to talk to the kubelet's pod-resources gRPC socket so it can compute per-NUMA topology hints. By default the binary points at:

```text
/host-var/lib/kubelet/pod-resources/kubelet.sock
```

The DaemonSet generated for the topology updater must therefore mount the kubelet's working directory **as a directory** and run privileged enough to read it. Two mistakes seen in the field cause the crash loop:

1. The DaemonSet mounts only individual files from `/var/lib/kubelet` (for example just `config.yaml`) instead of the entire directory. The expected `pod-resources/kubelet.sock` and `device-plugins/` subtrees are then absent inside the container.
2. The container's `securityContext.privileged` is left unset, so even when the directory is bind-mounted the kernel denies access to the kubelet's UNIX socket and to `/sys`/`/dev` paths the updater needs.

When either condition is true the binary exits within seconds of start and the kubelet relaunches it forever.

## Resolution

Adjust the topology updater DaemonSet so the host's `/var/lib/kubelet` is bind-mounted in full and the container runs privileged. A safe rollout is to validate on one cordoned node first, then apply cluster-wide.

1. Cordon one node so the change can be tested in isolation:

   ```bash
   kubectl cordon <node>
   ```

2. Delete the failing pod on that node so the kubelet recreates it once you patch the DaemonSet:

   ```bash
   kubectl -n <nfd-ns> delete pod <topology-updater-pod>
   ```

3. Patch the DaemonSet (or the `NodeFeatureDiscovery` CR field that controls it) so the volume and security context look like this:

   ```yaml
   volumes:
   - name: kubelet-state
     hostPath:
       path: /var/lib/kubelet
       type: Directory
   containers:
   - name: nfd-topology-updater
     securityContext:
       privileged: true
     volumeMounts:
     - name: kubelet-state
       mountPath: /host-var/lib/kubelet
       readOnly: true
   ```

   The mount must include `pod-resources/`, `device-plugins/` and `config.yaml`; mounting the parent directory is the simplest way to guarantee all three are present at the expected paths.

4. Verify the new pod stabilises and that node labels are unchanged:

   ```bash
   kubectl -n <nfd-ns> get pods -o wide -l app=nfd-topology-updater
   kubectl get node <node> --show-labels | grep -E 'nvidia|nfd'
   ```

5. Roll the same patch out cluster-wide once the canary node is healthy, then uncordon:

   ```bash
   kubectl uncordon <node>
   ```

The change does not invalidate existing CPU/GPU labels emitted by NFD; it only allows the topology updater to populate `NodeResourceTopology` objects again.

## Diagnostic Steps

If the pod still crashes after the patch:

```bash
kubectl -n <nfd-ns> logs <topology-updater-pod>
```

Common follow-up errors:

- `dial unix /host-var/lib/kubelet/pod-resources/kubelet.sock: connect: no such file or directory` — the host path is wrong; confirm with `kubectl debug node/<node> -- ls /var/lib/kubelet/pod-resources` that the kubelet really exposes the socket at this location.
- `permission denied` — privileged mode did not take effect; verify the PodSecurity admission profile of the namespace is set to `privileged` (or the operator's namespace label allows it).
- `connection refused` — the kubelet is up but `--feature-gates=KubeletPodResourcesGet=true` (and GetAllocatable, depending on version) is not enabled. Confirm with `kubectl get node <node> -o yaml` and the kubelet config under `/var/lib/kubelet/config.yaml`.

If the operator regenerates the DaemonSet and reverts the change, the patch must be expressed through the `NodeFeatureDiscovery` CR (`spec.workerConfig` / `spec.topologyUpdater`) rather than directly on the DaemonSet, so the operator's reconciler keeps it.
