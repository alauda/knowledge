---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# StackRox Collector CrashLoopBackOff Unable to Download Kernel Object for Current Node Kernel
## Issue

The StackRox Collector DaemonSet — the per-node runtime-visibility agent that backs the ACP **Container Security** extension (`security-docs`, OSS StackRox lineage) — enters `CrashLoopBackOff` on every node in the cluster. Pod listing shows:

```text
stackrox  collector-47d6l  1/2 CrashLoopBackOff  2087  8d
stackrox  collector-4gbbx  1/2 CrashLoopBackOff  2088  8d
stackrox  collector-5dcm2  1/2 Error              2088  8d
stackrox  collector-hcctj  1/2 CrashLoopBackOff  2089  8d
stackrox  collector-kpqcf  1/2 CrashLoopBackOff  2088  8d
```

Logs from the collector container show a failed attempt to download the kernel object matching the node's running kernel:

```text
Starting StackRox Collector...
[INFO ] Hostname: '<node-name>'
[INFO ] Attempting to download kernel object from
        https://sensor.stackrox.svc:443/kernel-objects/2.3.0/collector-<kernel-ver>.ko.gz
[INFO ] HTTP Request failed with error code 404
[ERROR] Error getting kernel object: collector-<kernel-ver>.ko
[INFO ] == Collector Startup Diagnostics: ==
[INFO ] Connected to Sensor? true
[INFO ] Kernel driver available? false
[INFO ] Driver loaded into kernel? false
[INFO ] ====================================
[FATAL] No suitable kernel object downloaded for kernel <kernel-ver>
```

The Collector reaches Sensor successfully, but Sensor returns 404 because the pre-built kernel object / eBPF probe for this kernel version is not present in the on-cluster cache and the Collector cannot fall back to a compatible one.

## Root Cause

Older Collector versions (StackRox 3.73 and earlier, roughly, and the Collector images that ship with them) rely on a pre-built kernel module (`.ko.gz`) or eBPF probe matching the running kernel exactly. These are served by Sensor from a bundle baked into the Sensor image; any node whose kernel is newer than the bundle's matrix gets a 404 and the Collector exits.

Newer Collector (shipped with StackRox 4.5 and later) supports **CO-RE eBPF** (Compile Once, Run Everywhere): the probe is compiled once against kernel BTF metadata and runs across any kernel that exposes BTF. CO-RE removes the per-kernel bundle dependency entirely and is the path forward on any modern node OS.

On ACP, this translates to: the Container Security stack should be running a recent enough Collector to use CO-RE on any node OS kernel the cluster runs. Nodes on newer kernels paired with an older Collector is exactly the mismatch above.

## Resolution

### Primary fix: upgrade the Container Security stack

Upgrade the underlying StackRox / Container Security components (operator / central / sensor / collector) from the 3.7x-era release to 4.5 or later. Once Collector 4.5+ is running:

```bash
kubectl -n stackrox set image daemonset/collector \
  collector=<registry>/collector:<4.5-or-later>
kubectl -n stackrox rollout status daemonset/collector
```

Collectors come up in `Running` / `2/2 Ready` and the `kernel object` lines disappear from the logs — CO-RE mode does not need to fetch one.

On an ACP **Container Security** managed install, the equivalent is to bump the Container Security subscription / CR to the matching newer channel and let the operator reconcile the new image set. The CO-RE support is a product of the Collector version, not a separate configuration flag.

### Bridging option until the upgrade lands

If an upgrade is not possible in the short term:

- **Pin node kernels to a version covered by the Sensor-bundled modules.** Check the Sensor image's bundled kernel matrix; roll the affected nodes back to (or pin them on) a kernel the bundle supports. Node-level kernel pinning in ACP is expressed through the **Immutable Infrastructure** extension (`kb/ACP_CAPABILITIES.md`) — declare the target kernel package set in a node-config object and let the reconciler land it.
- **Pre-stage the kernel modules on Sensor.** If an upstream build of the Collector module for the target kernel is available, inject it into the Sensor's kernel-object cache (mount a PVC at Sensor's cache path and drop the `.ko.gz` there). The Collector then finds the object on the first retry and boots.

These are holding patterns; the long-term answer is Collector 4.5+ because every future kernel upgrade (OS updates, CVE remediation) will reopen the same problem until CO-RE is in the picture.

## Diagnostic Steps

1. Collect the kernel version and the download URL the Collector is failing on for each affected node:

   ```bash
   for p in $(kubectl -n stackrox get pod \
       -l app.kubernetes.io/component=collector -o name); do
     echo "=== $p ==="
     kubectl -n stackrox logs "$p" -c collector \
       | grep -E 'kernel object|kernel driver|suitable kernel' \
       | tail -n 4
   done
   ```

2. Verify Sensor reachability from the Collector (rule out a network issue):

   ```bash
   kubectl -n stackrox exec -it daemonset/collector -c collector -- \
     sh -c 'curl -vk https://sensor.stackrox.svc:443/ 2>&1 | head -n 20'
   ```

   A 404 on the kernel-object path but a reachable TLS handshake is the expected signature of this issue. A connection refused or unreachable error is a separate networking problem.

3. Check the Collector image tag and confirm whether it supports CO-RE:

   ```bash
   kubectl -n stackrox get daemonset collector \
     -o jsonpath='{.spec.template.spec.containers[?(@.name=="collector")].image}'
   ```

   Anything earlier than the 4.5 line is the vulnerable set.

4. List the kernel versions across nodes; pods fail on exactly the nodes whose kernel is outside the Sensor bundle:

   ```bash
   kubectl get nodes \
     -o custom-columns=NAME:.metadata.name,KERNEL:.status.nodeInfo.kernelVersion
   ```

5. After the upgrade (or the bridging fix), observe the Collector DaemonSet until all pods reach `Running` and `Ready 2/2`:

   ```bash
   kubectl -n stackrox get pods -l app.kubernetes.io/component=collector -w
   kubectl -n stackrox logs daemonset/collector -c collector --tail=30 \
     | grep -Ei 'CO-RE|kernel driver|Driver loaded'
   ```

   `Driver loaded into kernel? true` — or a startup log line that mentions CO-RE — is the healthy signal.
