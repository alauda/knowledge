---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
id: KB260100011
---

# Migrating VMware Virtual Machines to Alauda Container Platform Virtualization

## Overview

This document describes how to migrate virtual machines from a VMware cluster to **Alauda Container Platform (ACP) Virtualization with KubeVirt** using the **Alauda Build of Forklift Operator**.

Forklift supports multiple source platforms including VMware, OpenShift Virtualization (OCP), Red Hat Virtualization (RHV), OpenStack, and ACP itself. This guide specifically focuses on the workflow for migrating from VMware to ACP (the destination provider named `host`).

## Environment Information

Alauda Container Platform: >= 4.2.0

Forklift Version: >= v4.2.1 (get latest from cloud.alauda.io)

ESXi Version: >= 6.7.0

## Prerequisites

- **Alauda Container Platform Environment**: An available ACP cluster with virtualization enabled.
- **Operator Bundle**: The Alauda Build of Forklift Operator must be downloaded from the Alauda cloud.
- **Network Plugins**: Multus must be installed (_Platform Management → Cluster Management → Cluster Plugins → Install Multus_).
- **VMware Environment**:
  - The ESXi hostname must be resolvable (via DNS or CoreDNS override).
  - The SSH service must be enabled on the ESXi host.
  - VMware Tools must be installed in the guest VM.
- **Mechanism Note**: Forklift builds migration pods using ESXi hostnames to construct the `V2V_libvirtURL` and connects via `esx://` over SSH to retrieve disk images.

## Terminology

Before proceeding, understand the following key concepts used in the migration process:

- **Provider**: Represents the source or destination virtualization platform (e.g., `vmware`, `ocp`, `rhv`, `openstack`, `acp`). A default destination provider named **host** is automatically created for the current ACP cluster.
- **StorageMap**: Maps storage classes used in the source environment to storage classes in the destination ACP cluster.
- **NetworkMap**: Maps source subnets/networks to destination subnets/networks.
- **Plan**: A migration plan describing which virtual machines to migrate. It references a `StorageMap` and a `NetworkMap`.
- **Migration**: Triggers the execution of a `Plan` and provides real-time status updates.

## Migration Procedure

The migration process is divided into the following steps:

1.  Upload and deploy the operator
2.  Deploy the Forklift Controller
3.  Prepare the VDDK Init Image
4.  Add the VMware Provider
5.  Create Network and Storage Maps
6.  Execute the Migration Plan
7.  Post-Migration Configuration

### 1. Upload Forklift Operator Using Violet

Download the `violet` tool from [cloud.alauda.io](https://cloud.alauda.io).

Use the `violet` tool to upload the Forklift operator artifact to the platform.

```bash
export PLATFORM_URL=https://<platform-address>/
export PLATFORM_USER=<platform-user>
export PLATFORM_PASSWORD=<platform-password>

violet push <forklift-operator-package-name> \
  --platform-address $PLATFORM_URL \
  --platform-username $PLATFORM_USER \
  --platform-password $PLATFORM_PASSWORD
```

### 2. Deploy the Operator

1. Navigate to **Administrator → Marketplace → OperatorHub**.
2. Locate **forklift-operator**.
3. Click **Deploy**.

### 3. Create ForkliftController Instance

Create a `ForkliftController` resource to initialize the system.

1. Navigate to **Deployed Operators → Resource Instances** under the Forklift Operator.
2. Create the `ForkliftController`.

Verify that all pods are running:

```bash
kubectl get pod -n konveyor-forklift
```

Expected pods include:

- `forklift-api`
- `forklift-controller`
- `forklift-operator`
- `forklift-validation`
- `forklift-volume-populator-controller`

_Note: A provider named **host** will be automatically created to represent the current ACP cluster, serving exclusively as a destination._

### 4. Prepare VDDK Init Image

The VMware Virtual Disk Development Kit (VDDK) is required for disk transfer.

1. Download the matching VMware VDDK Linux package from the Broadcom official website: [Broadcom VDDK Download](https://developer.broadcom.com/sdks/vmware-virtual-disk-development-kit-vddk/latest) (log in required).
2. Extract the package:
   ```bash
   tar xf VMware-vix-disklib-<vddk-version>.x86_64.tar.gz
   ```
3. Create a `Containerfile`:
   ```
   FROM registry.access.redhat.com/ubi8/ubi-minimal
   USER 1001
   COPY vmware-vix-disklib-distrib /vmware-vix-disklib-distrib
   RUN mkdir -p /opt
   ENTRYPOINT ["cp", "-r", "/vmware-vix-disklib-distrib", "/opt"]
   ```
4. Build and push the image to your registry:
   ```bash
   podman build -t registry.example.com/kubev2v/vddk:<vddk-version> .
   podman push registry.example.com/kubev2v/vddk:<vddk-version>
   ```

### 5. Add VMware Provider

Create a secret containing VMware credentials and register the Provider.
The sdkEndpoint for VMware defines how the tool connects to the source or target environment, `vcenter` connects via vCenter for managing multiple hosts, while `esxi` connects directly to a single ESXi host.

```bash
export VMWARE_URL=https://<vmware-url>/sdk
export VMWARE_USER=<vmware-user>
export VMWARE_PASSWORD=<vmware-password>
export VDDKIMAGE=registry.example.com/kubev2v/vddk:8.0
export SDK_ENDPOINT='esxi'

# Create Secret
kubectl -n konveyor-forklift create secret generic vmware \
  --from-literal=url=$VMWARE_URL \
  --from-literal=user=$VMWARE_USER \
  --from-literal=password=$VMWARE_PASSWORD \
  --from-literal=insecureSkipVerify=true

kubectl label secret vmware -n konveyor-forklift \
  createdForProviderType=vsphere \
  createdForResourceType=providers

# Create Provider
kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: Provider
metadata:
  name: vmware
  namespace: konveyor-forklift
spec:
  type: vsphere
  url: $VMWARE_URL
  secret:
    name: vmware
    namespace: konveyor-forklift
  settings:
    sdkEndpoint: $SDK_ENDPOINT
    vddkInitImage: $VDDKIMAGE
EOF
```

Verify that the provider status is `Ready`.

### 6. Create NetworkMap

Map the source VMware network to the destination Pod network.

To find the Network ID:

1. Open the VM in VMware → **Edit Settings** → **Network Adapter**.
2. Click the connected network.
3. Observe the browser URL (e.g., `.../portgroups/HaNetwork-data`). The ID is the last segment (e.g., `HaNetwork-data`).

```bash
export VMWARE_NET=HaNetwork-data

kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: NetworkMap
metadata:
  name: vmware-networkmap
  namespace: konveyor-forklift
spec:
  map:
    - source:
        id: $VMWARE_NET
      destination:
        type: pod
  provider:
    source:
      name: vmware
      namespace: konveyor-forklift
    destination:
      name: host
      namespace: konveyor-forklift
EOF
```

### 7. Create StorageMap

Map the source Datastore to the destination StorageClass.

To find the Datastore UUID:

1. Go to **Storage** in VMware and select the datastore used by the VM.
2. Locate the **UUID** field in the details page (e.g., `68b175ce-3432506e-e94c-74867adff816`).

```bash
export SC_NAME=topolvm
export VMWARE_DATA_ID=<datastore-uuid>

kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: StorageMap
metadata:
  name: vmware-storagemap
  namespace: konveyor-forklift
spec:
  map:
    - source:
        id: $VMWARE_DATA_ID
      destination:
        storageClass: $SC_NAME
  provider:
    source:
      name: vmware
      namespace: konveyor-forklift
    destination:
      name: host
      namespace: konveyor-forklift
EOF
```

### 8. Create Migration Plan

Define the `Plan` resource to specify which VMs to migrate and link the mapping resources.

```bash
export TARGET_NS=demo-space
export VM_NAME=vm-test

kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: Plan
metadata:
  name: example-plan
  namespace: konveyor-forklift
  annotations:
    populatorLabels: "True"
spec:
  provider:
    source:
      name: vmware
      namespace: konveyor-forklift
    destination:
      name: host
      namespace: konveyor-forklift
  map:
    network:
      name: vmware-networkmap
      namespace: konveyor-forklift
    storage:
      name: vmware-storagemap
      namespace: konveyor-forklift
  targetNamespace: $TARGET_NS
  migrateSharedDisks: true
  pvcNameTemplateUseGenerateName: true
  warm: true
  vms:
    - name: $VM_NAME
EOF
```

Wait until the Plan status is `READY=True` before proceeding.

### 9. Create Migration

Trigger the migration process.

```bash
kubectl apply -f - <<EOF
apiVersion: forklift.konveyor.io/v1beta1
kind: Migration
metadata:
  name: example-migration
  namespace: konveyor-forklift
spec:
  plan:
    name: example-plan
    namespace: konveyor-forklift
EOF
```

**Perform Cutover (for Warm Migration):**

For warm migration, incremental snapshots run hourly. When ready to switch to the destination VM, set a specific cutover timestamp. The system will automatically shut down the source VM at the scheduled time, synchronize the final snapshot to ACP, and then start the destination VM.

```bash
kubectl patch migration example-migration -n konveyor-forklift \
  --type='merge' \
  -p '{"spec":{"cutover":"2025-01-16T10:00:00Z"}}'
```

Replace `2025-01-16T10:00:00Z` with your desired cutover time in RFC3339 format.

### 10. Post-Migration Configuration (Add Disk Labels)

After migration, label the PVCs to ensure they are correctly associated with the VM in the ACP UI and managed properly.

```bash
export VM_PVC=<pvc-name>

kubectl label pvc -n $TARGET_NS $VM_PVC vm.cpaas.io/used-by=$VM_NAME
kubectl label pvc -n $TARGET_NS $VM_PVC vm.cpaas.io/reclaim-policy=Delete
```

Once labeled, the virtual disks will be visible in the VM details page on ACP.
