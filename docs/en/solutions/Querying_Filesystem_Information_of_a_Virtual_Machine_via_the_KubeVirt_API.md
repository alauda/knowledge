---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Querying Filesystem Information of a Virtual Machine via the KubeVirt API
## Overview

KubeVirt exposes a per-VMI subresource that returns the in-guest filesystem layout — mount points, filesystem types, total and used bytes — without requiring SSH or console access into the guest. The data is collected by the QEMU guest agent and surfaced through the `subresources.kubevirt.io` API group, which makes it suitable for inventory tooling, capacity dashboards, or pre-migration sanity checks where shelling into every VM is not feasible.

ACP virtualization ships KubeVirt unchanged, so the subresource is available on any namespace that hosts a running `VirtualMachineInstance` whose guest has the agent installed and reporting.

## Resolution

### Preferred: Inspect via kubectl

The cleanest invocation is through `kubectl get --raw`, which goes through the cluster's standard authentication and avoids managing tokens by hand:

```bash
NAMESPACE=<vm-namespace>
VM_NAME=<vmi-name>

kubectl get --raw "/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachineinstances/${VM_NAME}/filesystemlist" \
  | jq .
```

Sample response:

```json
{
  "items": [
    {
      "disk": [{"busType": "virtio"}],
      "diskName": "vda2",
      "fileSystemType": "vfat",
      "mountPoint": "/boot/efi",
      "totalBytes": 104634368,
      "usedBytes": 6047744
    },
    {
      "disk": [{"busType": "virtio"}],
      "diskName": "vda3",
      "fileSystemType": "xfs",
      "mountPoint": "/",
      "totalBytes": 32094793728,
      "usedBytes": 2682646528
    }
  ],
  "metadata": {}
}
```

The platform-preferred path is the ACP virtualization console — under the VM detail view, the **Storage** tab presents the same `filesystemlist` data after parsing it into a table, which is normally faster than crafting a `curl` request and avoids hand-rolling token auth.

### Fallback: Direct HTTPS Call

When the request must come from outside the cluster (a CMDB collector, an automation agent without a kubeconfig), call the API server directly. Capture the API endpoint and a bearer token tied to a least-privilege ServiceAccount that has `get` on `virtualmachineinstances/filesystemlist` in the target namespace:

```bash
API_URL=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
TOKEN=$(kubectl create token vm-inventory -n monitoring --duration=15m)
NAMESPACE=<vm-namespace>
VM_NAME=<vmi-name>

curl --silent --cacert /path/to/ca.crt \
     -H "Authorization: Bearer ${TOKEN}" \
     "${API_URL}/apis/subresources.kubevirt.io/v1/namespaces/${NAMESPACE}/virtualmachineinstances/${VM_NAME}/filesystemlist" \
  | jq .
```

Avoid `--insecure` against a production cluster — pin the cluster CA explicitly and rotate the ServiceAccount token regularly.

## Diagnostic Steps

If the call returns an empty `items` list or a 404, walk through the prerequisites:

1. **The VMI is actually running.** The subresource only answers for live instances:

   ```bash
   kubectl -n <vm-namespace> get vmi <vmi-name> -o jsonpath='{.status.phase}{"\n"}'
   ```

   Anything other than `Running` will not return filesystem data.

2. **The guest agent is installed and reachable.** KubeVirt reports agent connectivity in the VMI status conditions:

   ```bash
   kubectl -n <vm-namespace> get vmi <vmi-name> \
     -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.message}{"\n"}{end}'
   ```

   The `AgentConnected` condition must be `True`. If it is `False`, install `qemu-guest-agent` inside the guest and confirm it is enabled at boot.

3. **The caller has RBAC for the subresource.** The verb is `get` on `virtualmachineinstances/filesystemlist` under the `subresources.kubevirt.io` API group:

   ```bash
   kubectl auth can-i get virtualmachineinstances/filesystemlist \
     --subresource=filesystemlist -n <vm-namespace> \
     --as=system:serviceaccount:monitoring:vm-inventory
   ```

   If this returns `no`, bind a Role granting that verb to the ServiceAccount used by the collector.

4. **Network reachability.** From outside the cluster, the API server endpoint must be resolvable and the supplied token must not be expired — the response on a stale token is an HTTP 401, not the empty list returned for a missing agent.
