---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Fetching per-VM filesystem information via the KubeVirt subresource API

## Issue

Operators of virtual machines on Alauda Container Platform Virtualization need a programmatic way to read each VM's in-guest filesystem inventory — mount points, filesystem type, total bytes, used bytes — without logging into the guest. The KubeVirt subresource API exposes this data as a dedicated endpoint backed by the in-guest qemu-guest-agent (qga); this article shows the exact endpoint, the authentication shape, the response payload, and the prerequisite for it to return useful data.

## Resolution

KubeVirt on this platform serves a per-VMI filesystem inventory at the aggregated subresource path below:

```text
GET /apis/subresources.kubevirt.io/v1/namespaces/<namespace>/virtualmachineinstances/<vmi-name>/filesystemlist
```

The path lives under the `subresources.kubevirt.io/v1` API group, which is registered as an aggregated APIService (`v1.subresources.kubevirt.io`, `Available=True`) and routed by the kube-apiserver to the `virt-api` Service in the `kubevirt` namespace. `kubectl api-resources --api-group=subresources.kubevirt.io` returns an empty table because aggregated subresources have no `kind`; the source of truth is the discovery JSON at `/apis/subresources.kubevirt.io/v1`, which lists `virtualmachineinstances/filesystemlist` alongside its sibling guest-agent subresources `virtualmachineinstances/userlist` and `virtualmachineinstances/guestosinfo`.

Issue the call as an authenticated HTTPS request to the cluster API server, presenting a Bearer token in the `Authorization` header — this is the standard aggregated-API auth path; the API server checks RBAC for the verb `get` on `subresources.kubevirt.io/virtualmachineinstances/filesystemlist`, then proxies the request to `virt-api`, which dispatches to the per-VMI `virt-launcher` to talk to qga over the virtio-serial channel.

```bash
API_URL=<api-host>:<port>          # e.g. host:port of the cluster API server
TOKEN=<bearer-token>
NAMESPACE=<vm-namespace>
VM_NAME=<vmi-name>

curl --insecure \
  -H "Authorization: Bearer ${TOKEN}" \
  "https://${API_URL}/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachineinstances/${VM_NAME}/filesystemlist"
```

The response is a JSON object with the shape `{ "items": [...], "metadata": {} }`. Each entry in `items` describes one in-guest filesystem: `disk` (a list of `{ "busType": ... }` objects), `diskName` (e.g. `vda1`), `fileSystemType` (e.g. `ext4`, `vfat`), `mountPoint` (e.g. `/`, `/boot/efi`), `totalBytes`, and `usedBytes`. The field set is identical across guest operating systems; only the values differ. Sample response from an Ubuntu 20.04 guest:

```text
{
  "items": [
    {
      "disk": [{"busType": "virtio"}],
      "diskName": "vda15",
      "fileSystemType": "vfat",
      "mountPoint": "/boot/efi",
      "totalBytes": 109422592,
      "usedBytes": 5448704
    },
    {
      "disk": [{"busType": "virtio"}],
      "diskName": "vda1",
      "fileSystemType": "ext4",
      "mountPoint": "/",
      "totalBytes": 9343795200,
      "usedBytes": 1620111360
    }
  ],
  "metadata": {}
}
```

In-cluster callers can hit the same endpoint with `kubectl get --raw` (which uses the kubeconfig credential instead of an explicit Bearer header but routes through the identical aggregation path):

```bash
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachineinstances/${VM_NAME}/filesystemlist"
```

The caller's token (or ServiceAccount) must hold the `get` verb on `subresources.kubevirt.io/virtualmachineinstances/filesystemlist`. The upstream-named ClusterRoles `kubevirt.io:view`, `kubevirt.io:edit`, and `kubevirt.io:admin` ship with this verb, and the aggregated Kubernetes roles `view` / `edit` / `admin` carry it too — granting any of them to the caller is sufficient. Confirm authorization for a given identity with `kubectl auth can-i get virtualmachineinstances/filesystemlist.subresources.kubevirt.io` (returns `yes` when permitted).

## Root Cause

The `filesystemlist` subresource does not read from the VMI custom resource or any cluster-side state. The VMI CRD's OpenAPI schema does not even contain a `filesystemlist` field; the response shape lives in the `virt-api` Go handler. When the subresource call arrives, `virt-api` proxies it to the `virt-launcher` pod that hosts the target VMI, and `virt-launcher`'s cmd-server issues the QMP `guest-get-fsinfo` command to the in-guest qemu-guest-agent over the virtio-serial channel `org.qemu.guest_agent.0`. qga collects the live mount table and returns it; `virt-launcher` marshals the result into the JSON the subresource emits. This means the endpoint only returns useful data when qemu-guest-agent is installed, started, and registered with `virt-launcher` — the VMI then carries the condition `AgentConnected=True` in `status.conditions`. When qga is absent or not connected, the call cannot retrieve mount points.

## Diagnostic Steps

Before calling `filesystemlist`, confirm three things on the cluster: the subresource API is reachable, the target VMI is `Running`, and qga is connected.

Verify that the aggregated subresource API is healthy and serves the `filesystemlist` resource:

```bash
# APIService aggregation: should report Available=True, backed by svc kubevirt/virt-api
kubectl get apiservice v1.subresources.kubevirt.io

# Discovery listing: filesystemlist (and siblings userlist, guestosinfo) should appear
kubectl get --raw /apis/subresources.kubevirt.io/v1
```

Confirm the VMI is up and qga has registered. The relevant signal is the `AgentConnected` condition on the VMI's `status.conditions` array; without `status=True`, `filesystemlist` cannot return mount data:

```bash
kubectl get vmi <vmi-name> -n <namespace> \
  -o jsonpath='{.status.conditions[?(@.type=="AgentConnected")]}'
```

Expected output when qga is connected:

```text
{"lastProbeTime":null,"lastTransitionTime":null,"status":"True","type":"AgentConnected"}
```

If `AgentConnected` is missing or its `status` is `False`, install and enable qemu-guest-agent inside the guest before retrying the subresource call. On Debian/Ubuntu guests this is the `qemu-guest-agent` package plus `systemctl enable --now qemu-guest-agent`; the same package name is used on Fedora-family guests; on Windows it is delivered as the QEMU Guest Agent MSI. KubeVirt does not install the agent — it only consumes its results.

Confirm that the caller's identity can invoke the verb, so an empty / 403 response is not mistaken for missing data:

```bash
kubectl auth can-i get virtualmachineinstances/filesystemlist.subresources.kubevirt.io \
  -n <namespace>
```

Then issue the actual subresource call and inspect the JSON payload:

```bash
kubectl get --raw \
  "/apis/subresources.kubevirt.io/v1/namespaces/<namespace>/virtualmachineinstances/<vmi-name>/filesystemlist"
```

If the API server returns an error of the form `virtualmachineinstance.kubevirt.io "<name>" not found`, the aggregated APIService is wired correctly and the request reached `virt-api`'s handler — the VMI name in the URL is wrong (or the VMI no longer exists). A plain `404` from the kube-apiserver instead would indicate the APIService itself is unavailable.
