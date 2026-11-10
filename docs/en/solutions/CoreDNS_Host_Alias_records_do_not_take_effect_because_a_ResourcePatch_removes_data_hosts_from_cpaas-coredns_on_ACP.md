---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# CoreDNS Host Alias records do not take effect because a ResourcePatch removes data hosts from cpaas-coredns on ACP

## Issue

Static DNS records added in the cluster plugin **Alauda Container Platform Cluster DNS** (CoreDNS) under **Host Alias** do not take effect. Pods report `Could not resolve host` for the new name. After CoreDNS is restarted, names that used to work resolve to the wrong IP address.

In `kube-system`, the ConfigMap `cpaas-coredns` has a `Corefile` that still contains the `hosts /etc/coredns/hosts` plugin, but the ConfigMap has no `hosts` key, and the hosts file inside the CoreDNS pods is empty or missing.

## Root Cause

The records entered under **Host Alias** are written to the `hosts` key of the ConfigMap `cpaas-coredns`. CoreDNS mounts that key as `/etc/coredns/hosts` and serves it with the `hosts` plugin (`hosts /etc/coredns/hosts { reload ... fallthrough }`).

A `ResourcePatch` (`operator.alauda.io/v1alpha1`, short name `rpch`) applies JSON patches to the resources of a platform-managed release and keeps them applied. When a ResourcePatch for the `coredns` release targets `cpaas-coredns` with an operation such as:

```yaml
spec:
  jsonPatch:
    - op: replace
      path: /data/Corefile
      value: |
        ...
    - op: remove
      path: /data/hosts
```

the `hosts` key is stripped from the ConfigMap every time. This often happens when a ResourcePatch was created to customize the Corefile (for example to forward a private domain to a dedicated DNS server) and the `remove /data/hosts` operation was included with it.

As a result:

- new Host Alias entries never reach CoreDNS;
- after a restart, CoreDNS starts with no static records, and because of `fallthrough` the names are resolved by the upstream DNS instead, which can return a different, stale address.

## Resolution

1. Back up the ConfigMap and the ResourcePatch:

   ```bash
   kubectl -n kube-system get cm cpaas-coredns -o yaml > cpaas-coredns.before.yaml
   kubectl get rpch -A
   kubectl get rpch <resourcepatch-name> -o yaml > coredns-resourcepatch.before.yaml
   ```

   Add `-n <namespace>` to the last command if `kubectl get rpch -A` lists the patch in a namespace.

2. Decide whether the other changes in the patch are still needed. Read its `spec.jsonPatch`: besides `remove /data/hosts` it may replace the Corefile, for example to add a forwarding block for a private domain.

3. Remove the patch that strips the hosts data.

   > **Warning:** Deleting the ResourcePatch also drops every other customization it carries, such as an extra forwarding block in the Corefile; names that depend on it stop resolving. Do this only when `kubectl get rpch <name> -o yaml` shows a `remove` operation on `/data/hosts` of `cpaas-coredns`, and only after the backups in step 1. To roll back, run `kubectl apply -f coredns-resourcepatch.before.yaml`.

   - If none of its other operations are needed any more (for example, the private DNS server it forwarded to is no longer used), delete it:

     ```bash
     kubectl delete rpch <resourcepatch-name>
     ```

   - If the Corefile customization is still needed, edit the ResourcePatch instead and remove only the `op: remove` / `path: /data/hosts` entry from `spec.jsonPatch`:

     ```bash
     kubectl edit rpch <resourcepatch-name>
     ```

4. Check that the hosts data is back in the ConfigMap. If it is still empty, open **Administrator** > **Marketplace** > **Cluster Plugins**, update **Alauda Container Platform Cluster DNS**, re-enter the IP addresses and domains under **Host Alias** and click **Update**.

   ```bash
   kubectl -n kube-system get cm cpaas-coredns -o jsonpath='{.data.hosts}{"\n"}'
   ```

5. Verify from a workload Pod. The `hosts` plugin reloads the file automatically once the updated ConfigMap reaches the CoreDNS pods (kubelet syncs mounted ConfigMaps periodically, so allow a minute or two):

   ```bash
   kubectl -n <namespace> exec <pod> -- nslookup <domain>
   ```

Do not add a `remove /data/hosts` operation to a ResourcePatch for CoreDNS again. Keep static records in **Host Alias** and limit the ResourcePatch to the Corefile changes that cannot be made in the plugin.

## Diagnostic Steps

1. Check whether the ConfigMap carries the static records. A `Corefile` that references `/etc/coredns/hosts` but no `hosts` key matches this issue:

   ```bash
   kubectl -n kube-system get cm cpaas-coredns -o yaml
   ```

2. List the ResourcePatches and look for one that targets `cpaas-coredns` with `remove` on `/data/hosts`:

   ```bash
   kubectl get rpch -A
   kubectl get rpch <resourcepatch-name> -o yaml | grep -n -B2 -A2 '/data/hosts'
   ```

3. Check the file CoreDNS actually reads:

   ```bash
   kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
   kubectl -n kube-system exec <coredns-pod> -- cat /etc/coredns/hosts
   ```

   An empty result or `No such file or directory` confirms that the records are not loaded. If the CoreDNS image has no `cat`, compare the ConfigMap instead (step 1).

4. Rule out NodeLocal DNSCache. If the Pod's `/etc/resolv.conf` points at the NodeLocal address (for example `169.254.20.10`) and a direct query to the CoreDNS Service IP succeeds while the default one fails, the records are in CoreDNS and the cache is not forwarding that name, which is a different problem:

   ```bash
   kubectl -n <namespace> exec <pod> -- cat /etc/resolv.conf
   kubectl -n <namespace> exec <pod> -- nslookup <domain> <coredns-service-ip>
   ```
