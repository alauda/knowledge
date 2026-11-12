---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.4"
---

# Platform access fails or navigation entries disappear after a load balancer, DNS, or access address change on ACP

## Issue

Something outside the ACP objects changed how the platform address, the API endpoint, or the platform domain is reached. Typical symptoms:

- The platform cannot be reached at its VIP after NGINX or an external load balancer was adjusted, although nothing changed in the cluster.
- The platform answers by IP, but login through the domain shows `授权码不合法` (invalid authorization code).
- After a new `global` installation, the administrator no longer sees **Operations Center** or **Marketplace Management**, in every browser and in an incognito window.
- After a `global` upgrade, the overview and App Market pages do not render.
- How do I change the platform domain, and does the old address still work after a new one is added?

Check, in order: is a `global` control-plane node abnormal, is the domain registered as a platform access address (`prdb` `base`), and does the platform domain resolve inside the cluster.

## Root Cause

### Cause 1: the platform VIP does not answer because one global control-plane node is abnormal

After a load balancer outside the cluster was adjusted, the `global` VIP does not open the console. One control-plane node is abnormal, and rebooting it restores VIP access. Why the node failed was not established.

### Cause 2: the domain is not registered as a platform access address

Login by IP works and login by domain shows `授权码不合法`. The domain is not a platform access address: **Platform Access Address** lists only the default IP, and `kubectl get prdb base -o yaml` on the `global` cluster has no entry for the domain under `spec.alternativeURLs`.

### Cause 3: the platform domain does not resolve inside the cluster

**Operations Center** and **Marketplace Management** disappear for `admin`; under **Cluster Management** only **Clusters**, **Cloud Credentials**, **Custom Resource Definitions**, and **Resource Management** remain, and the user menu shows only **Appearance**, **Language**, and **Log Out**. Opening the Marketplace Management URL (`/console-platform/manage-platform/cluster/global/catalog-management/operator`) redirects elsewhere. The platform looks healthy: AppReleases are `Synced`/`Ready`, the role bindings exist, and the navigation requests (`selfsubjectaccessreviews`, `userbindings`, `navconfig-platform.yaml`, `custom-navconfig-platform`) return 200 or 201.

From a Pod such as `pinger`, the platform domain is `unknown host`. The domain exists only in hosts files, not in DNS. A hosts entry that had been added by hand to the CoreDNS ConfigMap was lost, so in-cluster components cannot resolve the platform domain and the navigation modules are not shown.

### Cause 4: CoreDNS runs on global nodes that have no resolver

After a `global` upgrade, the overview and App Market pages do not render. Some `global` nodes have no DNS configuration in `/etc/resolv.conf`; when CoreDNS runs on those nodes, it cannot resolve the platform name.

### Cause 5: an address added under Other Access Address does not replace the deployment address

In **Administrator** > **System Settings** > **Platform Parameters**, the platform access URLs show the deployment address marked `Default`. The **Update Platform Access URLs** dialog has an **Other Access Address** list. An address added there is an additional way to reach the platform; it does not replace the deployment address, so the `Default` address keeps working. There is no one-step automation for changing the platform domain.

## Resolution

### Cause 1: the platform VIP does not answer because one global control-plane node is abnormal

```bash
kubectl get nodes
```

> **Warning:** Rebooting a control-plane node restarts its static Pods and drops its API server until the node is back. Do this only when the `global` VIP does not open the console and this node is the abnormal one, in a maintenance window, with console access to the other masters.

Reboot that node. The VIP answers once the node is `Ready`. If domain login then shows `授权码不合法`, continue with Cause 2.

### Cause 2: the domain is not registered as a platform access address

1. Check the registered addresses:

   ```bash
   kubectl get prdb base -o yaml | grep -i url -A5
   ```

2. Log in by IP. Under **Platform Management** > **Platform Settings** > **Platform Parameters** > **Platform Access Address**, choose **Update Platform Access Address** and add the domain. Removing the entry again is the rollback.

3. `kubectl get prdb base -o yaml` now lists the domain under `spec.alternativeURLs`, and login by domain succeeds.

### Cause 3: the platform domain does not resolve inside the cluster

1. Test the domain from inside the cluster and find the CoreDNS module object:

   ```bash
   kubectl get pods -A | grep pinger
   kubectl exec -n <namespace> <pinger-pod> -- ping -c 1 <platform-domain>
   kubectl get minfo -A | grep -i coredns
   ```

   `unknown host`, with healthy AppReleases, matches this cause. If `pinger` is `Pending` because every node is tainted, use any Pod that has `ping` or `nslookup`.

2. Make the domain resolvable in a way that persists. Preferably add it to the DNS servers that the nodes use. Otherwise add a **Host Alias** to the **Alauda Container Platform Cluster DNS** plugin as described in [Platform console does not open because the cluster VIP domain name cannot be resolved inside the cluster on ACP](Platform_console_does_not_open_because_the_cluster_VIP_domain_name_cannot_be_resolved_inside_the_cluster_on_ACP.md), or add the entry under `spec.config.hosts` of the CoreDNS `minfo`. Entries added only by hand to the CoreDNS ConfigMap can be lost.

   > **Warning:** The CoreDNS configuration drives name resolution for the whole `global` cluster. Do this only when the platform domain is not served by any DNS server. Export the object first; applying the export is the rollback.

   ```bash
   kubectl get minfo <coredns-minfo> -o yaml > "$HOME/coredns-minfo.yaml"
   kubectl edit minfo <coredns-minfo>
   ```

   If `spec.config.hosts` already has an entry, copy its exact shape. Otherwise:

   ```yaml
   spec:
     config:
       hosts:
       - domains:
         - <platform-domain>
         ip: 192.0.2.10
   ```

3. The left navigation, including **Operations Center** and **Marketplace Management**, returns once the domain resolves from inside the cluster.

### Cause 4: CoreDNS runs on global nodes that have no resolver

```bash
kubectl get pods -n kube-system -o wide | grep coredns
```

On each node that hosts CoreDNS, `/etc/resolv.conf` must list a resolver that can answer the platform DNS name. Add the resolver that the other `global` nodes use, then delete the CoreDNS Pod on that node so that it is recreated and reads the new configuration. The overview and App Market render once the platform name resolves from every CoreDNS Pod.

### Cause 5: an address added under Other Access Address does not replace the deployment address

To let users reach the platform by a new domain, add it under **Other Access Address** in **Update Platform Access URLs**. The `Default` deployment address keeps working alongside it. Replacing the `Default` address is not a console operation; contact technical support for that. Check the current addresses with:

```bash
kubectl get prdb base -o yaml | grep -i url -A5
```

## Diagnostic Steps

```bash
kubectl get nodes
kubectl get prdb base -o yaml | grep -i url -A5
kubectl get minfo -A | grep -i coredns
kubectl exec -n <namespace> <pinger-pod> -- ping -c 1 <platform-domain>
```

```text
VIP dead after a load balancer change, one control-plane node abnormal       -> Cause 1
domain login 授权码不合法, IP login works, domain missing from alternativeURLs -> Cause 2
Operations Center and Marketplace Management missing, unknown host in a Pod  -> Cause 3
overview and App Market blank, a CoreDNS node has no resolver                -> Cause 4
new domain added, old Default address still works                            -> Cause 5, by design
```
