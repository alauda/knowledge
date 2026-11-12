---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
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

### Other reasons a static record does not reach CoreDNS

The same symptom (a name added for CoreDNS never resolves in Pods) has two more causes, even when no ResourcePatch removes `/data/hosts`.

**A direct edit of `cpaas-coredns` is converted into a ResourcePatch.** `cpaas-coredns` is a chart-rendered platform resource. The `sentry` component watches UPDATE and DELETE of objects that carry the `helm.sh/chart-name` label, through the `ValidatingWebhookConfiguration` named `sentry` (its webhook `vsentry.kb.io` calls the sentry Service `/validate`). A `kubectl edit` or `kubectl patch` of the ConfigMap returns:

```text
admission webhook "vsentry.kb.io" denied the request: The operation is denied, but ResourcePatch <name> is created. Please wait sentry to apply the ResourcePatch.
```

The edit is not rejected for good: sentry applies the ResourcePatch it created. Whichever copy sentry applied last is the one CoreDNS serves, so a ResourcePatch can keep an older hosts list after the plugin page was saved, or the opposite, and the **Host Alias** list and the ConfigMap disagree.

**A hosts entry added by hand is in the wrong format or is overridden.** The Corefile loads the `hosts` plugin from a file (`hosts /etc/coredns/hosts`), and that file is the `hosts` data key of the same ConfigMap. A mapping written as a line inside the Corefile `hosts` block, or as a single-line data field `hosts: <ip> <domain>`, is not what the `hosts` key needs; it must be a multiline block (`hosts: |` followed by one `<ip> <domain>` line per entry). Even with the format corrected and CoreDNS restarted, a hand edit can still be overridden by the plugin-managed copy (the same mechanism as above); the entry then takes effect only when it is entered under **Host Alias**.

**Host Alias** is also the way to publish additional names to Pods when the node `/etc/resolv.conf` cannot take more nameservers.

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

### If a direct edit was denied by vsentry.kb.io

The edit was converted into a ResourcePatch for sentry to apply; modification is not prohibited. Do not send a second patch. Wait, then check that the ResourcePatch was applied and that the ConfigMap contains the change:

```bash
kubectl get validatingwebhookconfiguration sentry -o yaml
kubectl get rpch -A
kubectl get rpch <resourcepatch-name> -o yaml
kubectl -n kube-system get cm cpaas-coredns -o yaml
```

When the **Host Alias** list and the ConfigMap disagree, pick one writer and keep to it:

- **ConfigMap edits** (when other custom lines must stay in the ConfigMap): keep editing `cpaas-coredns` and let sentry apply the ResourcePatch.
- **Host Alias only**: back up the ConfigMap and the ResourcePatch as in step 1, delete the ResourcePatch that overrides the plugin, and enter the IP and the domains (separated by spaces) under **Host Alias**.

  > **Warning:** Deleting the ResourcePatch removes every ConfigMap customization that is not on the plugin page, including a hand-written `forward` block. Confirm with the application owners which lines must be re-entered first. To roll back, apply the saved ResourcePatch and ConfigMap.

### If a hand-added hosts entry is ignored after a restart

1. Enter the record under **Host Alias** in **Alauda Container Platform Cluster DNS** (fields **IP** and **Domains**). On ACP 4.x this setting is reloaded without a CoreDNS restart. Then query again from the workload Pod:

   ```bash
   kubectl -n <namespace> exec <pod> -- nslookup <domain>
   ```

2. If the record must stay in the ConfigMap instead, keep it in one place only (not both the Corefile and the `hosts` key), and write the `hosts` key as a multiline block:

   ```yaml
   data:
     hosts: |
       192.0.2.10 app.example.com
   ```

   > **Warning:** Editing `cpaas-coredns` changes DNS for every Pod in the cluster, and a malformed Corefile or hosts file can stop CoreDNS from loading. Back up the ConfigMap first (step 1). Sentry turns the write into a ResourcePatch, as described above. To roll back, run `kubectl apply -f cpaas-coredns.before.yaml`.

   If the ConfigMap edit still does not show up in answers, move the entry to **Host Alias**.

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

5. Tell the causes apart:

   - `cpaas-coredns` has no `hosts` key and a ResourcePatch on it has `op: remove` on `/data/hosts`: the ResourcePatch removes the hosts data (this article's main cause).
   - A direct edit returned `admission webhook "vsentry.kb.io" denied the request`, or the **Host Alias** list and the ConfigMap `hosts` entries differ: the edit was converted into a ResourcePatch.
   - A hosts line was added to `cpaas-coredns` by hand and a CoreDNS restart did not help: check the format of the `hosts` key and move the entry to **Host Alias**.
