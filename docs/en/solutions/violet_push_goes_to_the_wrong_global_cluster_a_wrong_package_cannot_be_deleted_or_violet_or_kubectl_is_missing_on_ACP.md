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
---

# violet push goes to the wrong global cluster, a wrong package cannot be deleted, or violet or kubectl is missing on ACP

## Issue

- Cluster plugins pushed for the standby global cluster still show as not listed (`未上架`) there (for example Log Essentials and Log Storage for Elasticsearch), although `violet push` reported no error.
- A package was uploaded by mistake (wrong architecture or wrong build), and the console says it cannot be deleted.
- Deploying an immutable upload package fails because `packtool` cannot run `kubectl`.
- `violet` is not available on the operator workstation, and the question is whether a container of the platform Core already has it, or where a specific version can be downloaded. On ACP 4.2.1 the console has no upload (`上架`) button like the one in 3.18.

Related articles: "violet push fails with no package found, code 000, HTTP 500 or 502, or invalid reference format on ACP" covers pushes that stop with an error; "Pushed package not listed where expected: global-only plugins, cluster affinity, catalog source, or plugin type on ACP" covers packages that were registered correctly but are not offered on a cluster.

## Root Cause

### Cause 1: the platform address given to violet resolves to the other global cluster

In a primary/standby global setup both clusters share one platform domain, which normally resolves to the primary. When `violet push` is given that domain as `--platform-address` on a host where it resolves to the other global cluster, the packages are registered there, the push reports success, and the intended standby cluster shows nothing new. Running the push with `--platform-address` set to the standby cluster's VIP registers the packages on the standby.

### Cause 2: a wrongly uploaded package cannot be deleted from the console

The console refuses to delete the package. `violet push --force` overwrites and updates an existing package with the same image and architecture on the platform, so pushing the correct package for the same image and architecture (for example ARM) with `--force` replaces the wrong upload.

### Cause 3: packtool fails because kubectl is not in PATH

Deploying an immutable upload package runs `packtool`, which calls `kubectl` during execution. The failure is not a push to the image registry: `kubectl` is not available through `$PATH` on the node where `packtool` runs. After `kubectl` is installed on that node, the deployment completes.

### Cause 4: violet is not part of the platform Core and is downloaded separately

The `violet` tool is not built into the platform Core package, so it cannot be copied out of a running Core container. On ACP 4.2.1 the console has no 3.18-style upload button; packages are uploaded with `violet`. `violet` is downloaded from the Alauda customer portal, under the command-line tools of the matching ACP release.

## Resolution

### Cause 1: the platform address given to violet resolves to the other global cluster

1. On the host that runs `violet`, check where the platform domain resolves, and compare it with the standby cluster's VIP:

   ```bash
   getent hosts <platform-domain>
   ```

2. If the domain resolves to the other global cluster, run the push with the standby cluster's VIP as the platform address:

   ```bash
   violet push <package>.tgz --platform-address "https://<standby-global-vip>" --platform-username <platform-admin-name> --platform-password '<platform-admin-password>'
   ```

3. On the standby global cluster, check that the packages are registered:

   ```bash
   kubectl get artifact,artifactversion -A | grep -i <package>
   kubectl get moduleplugins | grep -i <plugin-name>
   ```

If the push still does not register on the standby cluster, follow the Upload Packages procedure in the documentation for your platform version step by step for the standby cluster.

### Cause 2: a wrongly uploaded package cannot be deleted from the console

1. Get the correct package for the same image and architecture as the wrong upload.
2. Push it with `--force`.

   > **Warning:** `--force` overwrites the existing package with the same image and architecture on the platform. The previous upload is replaced, not kept. Precondition: only when the package already on the platform is the wrong one, the console refuses to delete it, and the file you push is the correct package for the same image and architecture. Rollback: none for the overwritten content; push the earlier file again with `--force` if you need it back.

   ```bash
   violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password='<platform-admin-password>' --force <correct-package>.tgz
   ```

3. Check that the console now shows the correct version and architecture for the package.

### Cause 3: packtool fails because kubectl is not in PATH

1. On the node where `packtool` runs, check for `kubectl`:

   ```bash
   command -v kubectl || echo "kubectl not in PATH: $PATH"
   ```

2. Install a `kubectl` that matches the cluster version (for example copied from a control-plane node) into a directory on `$PATH`, and check that it reaches the cluster:

   ```bash
   install -m 0755 <path-to-kubectl-binary> /usr/local/bin/kubectl
   kubectl version
   ```

3. Run the immutable upload package deployment again.

### Cause 4: violet is not part of the platform Core and is downloaded separately

1. Some platform builds serve `violet` themselves. Check whether your platform answers on this path before looking elsewhere:

   ```bash
   curl -k -I https://<platform-url>/platform/tools/download/violet/violet_linux_amd64
   ```

2. Otherwise download it from the Alauda customer portal: Products (`产品`) → Product Download (`产品下载`) → the release line in the left sidebar (for example v4.0 → v4.0.9, or v4.2 → v4.2.1) → on the Alauda Container Platform page, under Type (`类型`), select Command-line tools (`命令行工具`) and choose the architecture: x86, ARM, or Hybrid (`异构`). The other types on that page are Core Package (`核心包`) and Extensions (`扩展`).
3. Use the `violet` of the same version as the platform, and check it:

   ```bash
   violet version
   ```

## Diagnostic Steps

```bash
getent hosts <platform-domain>
command -v kubectl
violet version
kubectl get artifact,artifactversion -A | grep -i <package>
```

- The push reports success, nothing appears on the standby global cluster, and the platform domain resolves to the other global cluster from the push host: Cause 1.
- A wrong upload that the console will not delete: Cause 2.
- `packtool` stops on a missing `kubectl`: Cause 3. Expected: `command -v kubectl` prints nothing on that node.
- No `violet` binary on the workstation, or no upload button in the 4.2 console: Cause 4.
