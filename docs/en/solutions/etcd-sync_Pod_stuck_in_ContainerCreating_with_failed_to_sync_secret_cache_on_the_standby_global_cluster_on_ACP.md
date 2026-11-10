---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# etcd-sync Pod stuck in ContainerCreating with failed to sync secret cache on the standby global cluster on ACP

## Issue

On the standby `global` cluster of a primary/standby (disaster recovery) setup, a new `etcd-sync` Pod in `cpaas-system` stays in `ContainerCreating`. `kubectl describe pod` shows:

```text
Warning  FailedMount  ...  MountVolume.SetUp failed for volume "etcd-sync-token" : failed to sync secret cache: timed out waiting for the condition
```

The Secrets the Pod uses (`etcd-sync-token`, `local-etcd-client`, `remote-etcd-client`) are listed by `kubectl get secret -n cpaas-system`, and other `etcd-sync` or `etcd-sync-monitor` Pods may still be `Running`. Listing Secrets across all namespaces fails with an error like:

```text
Error from server (InternalError): Internal error occurred: unable to transform key "/registry/secrets/<namespace>/<secret-name>": invalid padding on input
```

## Root Cause

The Kubernetes API server encrypts Secrets at rest with the keys in its encryption provider configuration, `/etc/kubernetes/encryption-provider.conf` on each control plane node. etcd synchronization copies the primary cluster's etcd data, including Secrets encrypted with the primary cluster's keys, into the standby cluster's etcd. The standby cluster can only decrypt that data when its control plane nodes use the same encryption provider configuration as the primary cluster.

For that reason the standby installation procedure requires `/etc/kubernetes/encryption-provider.conf` to be copied from the first control plane node of the primary cluster to every standby control plane node **before** the standby cluster is installed. When this step is skipped, the standby cluster is installed with its own keys. The API server cannot decrypt the synchronized Secrets and returns `unable to transform key ... invalid padding on input`. The kubelet then cannot read the Secret behind the `etcd-sync-token` volume, and the Pod never leaves `ContainerCreating`.

## Resolution

The encryption configuration of a cluster is fixed when the cluster is installed. A standby cluster that was installed without the primary's encryption configuration has to be rebuilt.

> **Warning:** Rebuilding the standby cluster removes it and its data. The primary cluster and its workloads are not affected, but there is no disaster recovery standby until the rebuild and the etcd synchronization have finished. Do this only when the diagnostic steps confirm the `invalid padding on input` error and a differing `encryption-provider.conf` on the standby control plane nodes. Plan a maintenance window for it. There is no rollback once the standby has been removed. Keep the primary cluster untouched throughout.

1. Remove the standby cluster according to the product documentation.

2. Log in to the first control plane node of the **primary** cluster and copy the encryption configuration to every control plane node of the standby cluster:

   ```bash
   for i in <standby-cp-ip-1> <standby-cp-ip-2> <standby-cp-ip-3>
   do
     ssh "<user>@$i" "sudo mkdir -p /etc/kubernetes/"
     scp /etc/kubernetes/encryption-provider.conf "<user>@$i:/tmp/encryption-provider.conf"
     ssh "<user>@$i" "sudo install -o root -g root -m 600 /tmp/encryption-provider.conf /etc/kubernetes/encryption-provider.conf && rm -f /tmp/encryption-provider.conf"
   done
   ```

3. Install the standby cluster again by following the standby installation steps of the global cluster disaster recovery documentation. The Platform Access Address, the certificate fields and the image repository fields must be the same as on the primary cluster.

4. Enable etcd synchronization again and confirm that the `etcd-sync` Pods become `Running`:

   ```bash
   kubectl -n cpaas-system get pods | grep etcd-sync
   ```

## Diagnostic Steps

1. Confirm the mount failure on the Pod:

   ```bash
   kubectl -n cpaas-system get pods | grep etcd-sync
   kubectl -n cpaas-system describe pod <etcd-sync-pod> | grep -A3 FailedMount
   ```

   Expected for this issue: `failed to sync secret cache: timed out waiting for the condition` for volume `etcd-sync-token`.

2. Confirm that the Secrets exist, so that the problem is not a missing Secret:

   ```bash
   kubectl -n cpaas-system get secret etcd-sync-token local-etcd-client remote-etcd-client
   ```

   If a Secret is missing (`NotFound`), create it as described in the etcd synchronization steps instead. That is a different cause.

3. Read Secrets through the API server:

   ```bash
   kubectl get secret -A > /dev/null
   ```

   Expected for this issue: `unable to transform key "/registry/secrets/...": invalid padding on input`. This means that etcd holds Secrets the API server cannot decrypt.

4. Compare the encryption configuration on the control plane nodes of both clusters:

   ```bash
   sudo sha256sum /etc/kubernetes/encryption-provider.conf
   ```

   Run this on the first control plane node of the primary cluster and on each standby control plane node. Different checksums confirm that the file was not copied before the standby cluster was installed.
