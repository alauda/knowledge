---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Velero pods deployed by a managed backup operator need a second network interface — typically because the backup target (an S3-compatible object store, an NFS export, or a tape library gateway) is reachable only through a separate physical network rather than the cluster's default pod network. By default the Velero Deployment only carries the primary CNI interface and cannot reach an isolated storage VLAN.

A second NIC can be attached on a per-pod basis through Multus, but Velero is reconciled by the backup operator, so any direct edit to the Velero Deployment is overwritten on the next reconcile.

## Root Cause

Multus selects secondary networks via the standard pod annotation `k8s.v1.cni.cncf.io/networks: <NAD-name>`. The annotation must be set at pod-creation time — adding it to a running pod has no effect. For pods owned by a Deployment that is itself owned by an operator's CRD, the annotation must be propagated through the CRD's pod-template path, otherwise the operator wipes it on reconcile.

The backup operator's `DataProtectionApplication` (DPA) CRD exposes a `spec.podAnnotations` map specifically for this case. Annotations placed there are merged into the pod templates of every pod the operator owns (Velero server pods, node-agent pods, restore helpers), so Multus picks them up the moment the pod is scheduled.

## Resolution

ACP delivers the platform-managed backup workflow through the `configure/backup` capability area, which uses the same DPA CRD and Velero binary as upstream. The platform-preferred path is to drive secondary-network attachment from the DPA spec rather than poking individual Velero pods:

### Step 1 — Define the secondary network as a NetworkAttachmentDefinition

Create the NAD in the same namespace as the Velero Deployment (typically `acp-backup`). The NAD describes how the backup-network interface is connected — bridged to a host interface, routed over a VLAN subif, or built on top of an SR-IOV VF, depending on how the backup target is reachable.

A bridged example over a host interface:

```yaml
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: ens35-host-nad
  namespace: acp-backup
spec:
  config: |
    {
      "cniVersion": "0.4.0",
      "type": "bridge",
      "name": "ens35-host-nad",
      "bridge": "br-backup",
      "ipam": {
        "type": "static",
        "addresses": [
          { "address": "10.48.55.152/24", "gateway": "10.48.55.1" }
        ]
      }
    }
```

Use the IPAM type that matches the backup network — `static`, `host-local`, or DHCP. If the backup network is large enough that pool exhaustion matters, use `whereabouts` instead of `host-local` so that IP allocations are coordinated across nodes.

### Step 2 — Reference the NAD from the DPA pod-annotations field

Patch the DataProtectionApplication so the operator stamps the Multus annotation onto every Velero pod it creates:

```yaml
apiVersion: oadp.acp.io/v1alpha1
kind: DataProtectionApplication
metadata:
  name: dpa-sample
  namespace: acp-backup
spec:
  podAnnotations:
    k8s.v1.cni.cncf.io/networks: ens35-host-nad
  backupLocations:
    - velero:
        provider: aws
        default: true
        objectStorage:
          bucket: velero-backup
          prefix: cluster-1
        config:
          region: minio
          s3ForcePathStyle: "true"
          s3Url: "http://10.48.55.10:9000"
        credential:
          name: cloud-credentials
          key: cloud
```

Apply with `kubectl apply -f dpa.yaml`. The operator reconciles, recreates the Velero pods, and the new pods inherit the annotation.

### Step 3 — Confirm Velero pods carry the secondary interface

After the rollout settles, every Velero pod should report two networks in its CNI status — the cluster default and the backup NAD:

```bash
kubectl -n acp-backup get pod -l component=velero -o name | head -1 | xargs -I{} \
  kubectl -n acp-backup get {} -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/network-status}{"\n"}' \
  | jq .
```

Expected output (abbreviated):

```text
[
  {"name": "kube-ovn", "interface": "eth0", "ips": ["10.131.2.11"], "default": true, "dns": {}},
  {"name": "acp-backup/ens35-host-nad", "interface": "net1", "ips": ["10.48.55.152"], "dns": {}}
]
```

Velero now has `net1` reachable on the backup VLAN. The default route still goes through `eth0`; only traffic to the backup target needs to leave via `net1`. If the backup target's IP is in the same subnet as `net1`, no extra routes are required. If the target is on a different subnet behind a router on the backup network, add a static route to the IPAM block (or push it via a routing init-container).

### Step 4 — Validate end-to-end backup over the new NIC

Trigger a one-shot backup and tail the Velero logs for the connection attempt to the object store:

```bash
kubectl -n acp-backup create -f - <<'EOF'
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: smoke-test
  namespace: acp-backup
spec:
  includedNamespaces:
    - default
EOF

kubectl -n acp-backup logs deploy/velero --tail=200 | grep -E "uploading|backup-location"
```

A successful upload to the object store via the backup VLAN confirms the NAD attachment is working end-to-end. If Velero still reaches the target via `eth0`, IP/route ordering inside the pod is wrong — see the diagnostic steps.

## Diagnostic Steps

Inspect the route table inside the Velero pod to confirm which NIC carries the backup traffic:

```bash
POD=$(kubectl -n acp-backup get pod -l component=velero -o jsonpath='{.items[0].metadata.name}')
kubectl -n acp-backup exec "$POD" -- ip route
kubectl -n acp-backup exec "$POD" -- ip -4 addr show
```

Expected: `eth0` with the cluster-pod CIDR carrying the default route; `net1` with the backup-network CIDR. If the target's CIDR is not directly connected on `net1`, add an explicit route via the IPAM `routes` field on the NAD:

```json
"ipam": {
  "type": "static",
  "addresses": [{ "address": "10.48.55.152/24", "gateway": "10.48.55.1" }],
  "routes": [{ "dst": "10.49.0.0/16", "gw": "10.48.55.1" }]
}
```

If the secondary NIC is missing entirely from the pod, the most common causes are:

- DPA was applied but the Velero pods were not recreated — force a rollout: `kubectl -n acp-backup rollout restart deploy/velero`.
- The NAD lives in a different namespace from the Velero pod — Multus requires same-namespace lookup unless the NAD is declared with the cluster-scoped form `<ns>/<name>` and the namespace permission allows it. Recreate the NAD in `acp-backup`.
- The NAD JSON is malformed — `kubectl -n acp-backup get net-attach-def ens35-host-nad -o jsonpath='{.spec.config}' | jq .` should parse cleanly. A JSON error makes Multus skip the attachment silently and stamps an event on the pod, visible via `kubectl describe pod <pod>`.

If routing is correct but TCP to the target fails, run a packet capture on the host bridge that backs `net1` to confirm whether the SYN actually leaves the node:

```bash
NODE=$(kubectl -n acp-backup get pod "$POD" -o jsonpath='{.spec.nodeName}')
kubectl debug node/$NODE -it --image=registry.k8s.io/e2e-test-images/busybox:1.36 \
  -- chroot /host tcpdump -nn -i br-backup host 10.48.55.10 -c 50
```
