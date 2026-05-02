---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

An etcd snapshot has been captured from a running cluster. The operator wants to know whether that snapshot can be restored into a freshly provisioned, separately installed cluster — effectively using etcd backup as a cross-cluster migration tool for workloads, PVs, and cluster-scoped state.

The short answer is no: an etcd snapshot is an in-place disaster-recovery artifact, not a migration payload. Restoring it into a different cluster is not supported and will break the target cluster. Use a workload-level backup tool instead.

## Root Cause

An etcd snapshot captures the raw key-value state of the control plane at a point in time. That state is intimately tied to the identity of the cluster it came from:

- Node objects reference node UUIDs, cloud provider IDs, and internal IPs that belong to the original hosts. The target cluster's kubelets and machine registry do not know those identities and will not reconcile.
- The etcd snapshot is encrypted with cluster-specific TLS material and, if at-rest encryption is enabled, wrapped under a key that lives outside the snapshot. The target cluster's API server cannot decrypt the payload without the exact same keys and certificates.
- Core cluster certificates (CA, serving certs, aggregation-layer certs) are pinned to SANs and expiry dates belonging to the source cluster. Overlaying them onto a cluster whose PKI was minted separately corrupts the trust chain.
- The snapshot also does not contain PersistentVolume data, container images, pod logs, or any out-of-etcd state — so even if a restore worked, the workloads would come up with dangling PV references.

An etcd snapshot is therefore only useful to roll a single cluster back to an earlier point in its own history, on the same control plane members (or ones installed with the same cluster identity).

## Resolution

Separate two concerns:

1. **Same-cluster roll-back.** The etcd snapshot is the right tool. Use it to restore the control plane of the cluster it came from, following the platform's documented recovery runbook for the specific control plane / API server pair. Do not attempt it against a different cluster.

2. **Cross-cluster migration of workloads and data.** Use a Kubernetes-native workload backup tool that operates on API resources and PV contents, not on raw etcd:

   - **Velero** (or the operator-packaged equivalent delivered in the ACP `configure/backup` area). Velero serialises namespaced resources to object storage, invokes CSI snapshots or restic/kopia for PV contents, and restores them into any compatible target cluster.
   - For workloads that need application-consistent snapshots, combine Velero with per-application quiesce hooks (e.g. database flush, Kafka controlled-shutdown).

   A minimal Velero backup/restore pair:

   ```bash
   # On the source cluster
   velero backup create migrate-2026-02 \
     --include-namespaces app-prod \
     --snapshot-volumes=true

   # On the target cluster, after velero has been installed and points at
   # the same object-store bucket:
   velero restore create --from-backup migrate-2026-02
   ```

   This gives you a portable, supported migration path that does not depend on etcd identity.

For mixed scenarios (some namespaces move, others stay), drive Velero with label selectors rather than trying to surgically extract keys from etcd.

## Diagnostic Steps

Confirm which kind of backup you actually have:

```bash
# An etcd snapshot is a single .db file plus a checksum.
ls -l /path/to/etcd-backup/
file /path/to/etcd-backup/snapshot.db
```

If that is all you have, restoring into a new cluster is not an option — inventory the cluster identity you would be overwriting:

```bash
kubectl get nodes -o wide
kubectl -n kube-system get configmap kubeadm-config -o yaml 2>/dev/null | head -40
```

For a workload migration, check whether the source cluster already has a Velero (or equivalent) backup schedule in place:

```bash
kubectl get backup -A
kubectl get schedule -A
velero backup get
```

If none exist, install Velero first, run a full backup, validate the backup contents against a test namespace on a scratch cluster, and only then migrate production.
