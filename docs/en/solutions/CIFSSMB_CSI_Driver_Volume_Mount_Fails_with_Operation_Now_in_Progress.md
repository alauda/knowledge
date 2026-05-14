---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# CIFS/SMB CSI Driver Volume Mount Fails with "Operation Now in Progress"
## Issue

After the CIFS/SMB CSI driver is installed on the cluster, a pod that asks for a CIFS/SMB-backed PVC stays in `ContainerCreating` and the kubelet reports a mount failure. The corresponding event against the pod contains a `MountVolume.MountDevice` failure with the underlying `mount` error:

```text
MountVolume.MountDevice failed for volume "pv-name":
  rpc error: code = Internal desc = volume(//samba.domain.com/service) mount
  "//samba.domain.com/service" on
  "/var/lib/kubelet/plugins/kubernetes.io/csi/smb.csi.k8s.io/<hash>/globalmount" failed
  with mount failed: exit status 32
Mounting command: mount
Mounting arguments: -t cifs -o dir_mode=0777,file_mode=0777,gid=1001010000,domain=,
  //samba.domain.com/service /var/lib/kubelet/plugins/kubernetes.io/csi/smb.csi.k8s.io/<hash>/globalmount
Output: mount error(115): Operation now in progress
  Refer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)
```

Error 115 (`EINPROGRESS`) surfaced by `mount.cifs` typically means the kernel CIFS client tried to set up a TCP session to the SMB server and could not — the mount reports "operation in progress" because the underlying socket did not complete its connect before the CIFS client gave up.

## Root Cause

The CIFS/SMB CSI driver does not itself talk to the SMB server from a central component — it runs the ordinary `mount.cifs` / kernel CIFS client on **the node where the pod is being scheduled**, through the kubelet's CSI plugin socket. Any node that is supposed to host a pod with an SMB-backed PVC must have network reachability to the SMB server on TCP port `445`.

Error 115 on a fresh mount almost always collapses to one of:

- The worker node has no route to the SMB server (different network segment, missing firewall rule, NetworkPolicy denying egress to port 445 for pods that proxy the mount).
- The SMB server is up but is not listening on 445 (restrictive bind, service down, LB misconfigured).
- DNS for the SMB server returns an unreachable IP (legacy record, split-horizon DNS that resolves differently on the node than on the SMB client that validated the share manually).
- An intermediate firewall or cloud security group silently drops SYN packets from worker nodes.

`mount.cifs` reports the failure to the kubelet, the kubelet reports it to the API server as a pod event, and the CSI driver returns `Internal` to the kubelet — the same underlying condition, reported at three different layers.

## Resolution

Treat this as a node-to-server connectivity problem first; only after connectivity is confirmed should the CIFS layer itself be debugged.

1. **Validate TCP reachability from a worker node.** From the node where the failing pod would be scheduled, test that port `445` of the SMB server is reachable. A quick check without installing tooling on the node is:

   ```bash
   kubectl debug node/<node> -- chroot /host bash -c 'nc -vz samba.domain.com 445'
   ```

   Two useful outcomes:

   - `Ncat: TIMEOUT` / `Connection refused` → a networking problem. Proceed to step 2.
   - `Ncat: Connected to samba.domain.com:445` → connectivity is good; the problem is inside the CIFS layer (credentials, SMB protocol dialect, share ACLs). Proceed to step 3.

2. **Fix the connectivity path.** Depending on where the block is:

   - **Route missing on the node** — check `ip route get <smb-server-ip>` on the node; add the missing route or fix the default gateway as the environment requires.
   - **Egress NetworkPolicy too restrictive** — if the CSI driver pod or the node itself is subject to a NetworkPolicy that drops egress to the SMB subnet, add an explicit allow rule for port 445 to that subnet. On the platform's **Kube-OVN**-based CNI, the matching `NetworkPolicy` applies as usual; confirm it is not filtering the CSI plugin's traffic.
   - **Firewall between segments** — engage the network team to allow TCP/445 from every worker subnet to the SMB server.
   - **DNS mismatch** — resolve `samba.domain.com` from the node (`nslookup samba.domain.com` via `kubectl debug node/<node>`), and compare with the server the SMB administrator believes the clients should reach. If they differ, fix the forwarder, the node's `/etc/resolv.conf`, or the cluster's DNS policy to agree.

3. **If connectivity is fine, inspect the CIFS layer.** Once `nc -vz` reports `Connected`, the remaining possibilities are SMB-side:

   - Check credentials in the CSI `Secret` referenced by the `PersistentVolume`.
   - Verify the SMB server accepts the dialect the kernel CIFS client is offering; mount options such as `vers=3.1.1` may be necessary.
   - Confirm the share ACL grants the credentials in use.

   Collect the node's kernel log to see the CIFS client's own view:

   ```bash
   kubectl debug node/<node> -- chroot /host dmesg -T | tail -50 | grep -i cifs
   ```

4. **Retry the pod.** After any remediation, delete the stuck pod so the kubelet re-invokes the CSI driver:

   ```bash
   kubectl -n <ns> delete pod <stuck-pod>
   ```

   The controller (Deployment, StatefulSet, and so on) re-creates the pod, the CSI driver re-runs `mount.cifs`, and a clean mount should now complete within a second or two.

## Diagnostic Steps

Identify the specific node the failing pod was scheduled on — the problem is almost always node-scoped:

```bash
kubectl -n <ns> get pod <pod> -o wide
kubectl -n <ns> describe pod <pod>
```

The event stream shows `MountVolume.MountDevice failed`; the `Node:` field at the top tells you which worker to target.

Inspect the CSI driver plugin log on that node — the driver logs every `NodeStageVolume` / `NodePublishVolume` call and its underlying `mount` stderr:

```bash
kubectl -n <csi-namespace> logs <csi-smb-node-pod-on-target-node> -c smb
```

If the plugin is installed as a DaemonSet, target the instance on the node in question. A line repeating `mount error(115)` confirms the diagnosis above.

Validate DNS and port reachability from *within a pod on the same node*, which is the most accurate reproduction of what the kubelet sees when the CSI node plugin runs:

```bash
kubectl debug node/<node> -it --image=busybox -- sh -c '
  nslookup samba.domain.com;
  nc -vz samba.domain.com 445;
'
```

A clean `Connected` here with a failing CIFS mount narrows the problem to the SMB protocol layer. A timeout here confirms the issue is on the data path between the node and the SMB server and must be fixed outside of the cluster.
