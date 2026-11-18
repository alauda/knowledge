---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x
  - 4.0.x
  - 4.3.x
---

# Ceph operator install returns 404, or the storage page is empty because rook-ceph-tools never starts on ACP

## Issue

Ceph distributed storage on Alauda Container Platform shows "no Ceph operator" or an empty distributed-storage page, in one of these shapes:

- Installing the Ceph operator returns 404, the operator catalog page has nothing to install, and `kubectl get packagemanifests -A` prints no rows.
- A `CephCluster` exists and the operator is up, but the storage page does not list the cluster and the device class is empty. `rook-ceph-tools` is not Running, and its container spec has `tty: true`.
- Storage-pool installation runs for a long time, and `ceph-cluster` stays `HEALTH_WARN` with `TOO_FEW_OSDS` (`OSD count 0 < osd_pool_default_size 3`), often together with `PG_AVAILABILITY` (`Reduced data availability: 2 pgs inactive`) and `MDS_SLOW_METADATA_IO`, while the tools pod has `tty: true`.
- On ACP 3.18 the `rook-ceph-operator` Deployment disappears or comes back, and the pod fails at startup with `C | rookcmd: failed to get pod: pods "rook-ceph-operator-<hash>" is forbidden: User "system:serviceaccount:rook-ceph:rook-ceph-system" cannot get resource "pods" in API group "" in the namespace "rook-ceph"`. Creating the operator from the Distributed Storage page fails with the same error.

Environment: Rook namespace `rook-ceph`, toolbox Deployment `rook-ceph-tools`, operator Deployment `rook-ceph-operator`. On ACP 4.3 the OLM components `packageserver`, `catalog-operator`, and `olm-operator` run in `cpaas-system`. On ACP 4.3.4 the CoreDNS Corefile is ConfigMap `kube-system/cpaas-coredns`, data key `Corefile`.

Related articles: [Ceph storage pool cannot be created or never finishes because the deployment created no OSD on ACP](./Ceph_storage_pool_cannot_be_created_or_never_finishes_because_the_deployment_created_no_OSD_on_ACP.md) (the tools pod is Running and still no OSD exists), [A raw disk added to a Ceph device class does not become an OSD on ACP](./A_raw_disk_added_to_a_Ceph_device_class_does_not_become_an_OSD_on_ACP.md).

## Root Cause

### Cause 1: packagemanifests empty because packageserver cannot resolve a name it needs

`packageserver` logs show errors, and from inside that pod a DNS name it needs does not resolve. Without packagemanifests, the catalog has no Ceph operator to install and the install API answers 404. The operator Deployment is absent because OLM never got a package, not because `rook-ceph-operator` crashed. Adding the missing resolution entries to CoreDNS let the operator install. The name that fails depends on the environment.

### Cause 2: rook-ceph-tools pod rejected because tty is true

The tools container spec contains `tty: true`. A security policy or a host security component on the cluster refuses or terminates a container with a TTY, so `rook-ceph-tools` never becomes Ready. The distributed-storage page loads the cluster through the tools pod. While it is down, the page shows no cluster and the device class looks empty even when `CephCluster` is fine and OSD pods are Running, and storage-pool installation cannot finish, leaving the OSD count at 0. Redeploying the `CephCluster` does not help, and neither does uninstalling the operator (its objects in `app-storage` and `rook-ceph` remain).

The tools Deployment is rendered from the operator's CSV. Changing `tty` in the CSV prevents the next reconcile from putting `tty: true` back, but a CSV edit alone may not roll out to the running Deployment; patching the live Deployment is what brings the pod up. Check both objects.

### Cause 3: rook-ceph-system cannot get pods on ACP 3.18

The operator is OLM-managed: its Deployment carries `olm.managed: "true"` and `olm.owner.kind: ClusterServiceVersion`, with Subscription `rook-operator` in `rook-ceph`. The Deployment and the RBAC it depends on went missing, so the recreated pod runs without permission to get pods. Adding roles and service accounts by hand starts the pod, but the platform still does not see the Ceph cluster. Deleting the Subscription and the CSV and redeploying `ceph-operator` restores it. Why the Deployment and its RBAC went missing is not known.

## Resolution

### Cause 1: packagemanifests empty because packageserver cannot resolve a name it needs

1. Confirm the failure is DNS inside `packageserver`, and save CoreDNS before editing it. If `cpaas-coredns` does not exist on your version, list `kubectl -n kube-system get configmap` and use the ConfigMap that holds the `Corefile` key.

```bash
kubectl get packagemanifests -A
kubectl -n cpaas-system logs deploy/packageserver --tail=200
kubectl -n cpaas-system exec deploy/packageserver -- cat /etc/resolv.conf
kubectl -n kube-system get configmap cpaas-coredns -o yaml > cpaas-coredns.backup.yaml
```

2. Add a `hosts` entry for the name that failed, with an address that is valid on this cluster.

> **Warning:** A bad Corefile makes CoreDNS fail and every in-cluster lookup fail, including Kubernetes service DNS. Precondition: `cpaas-coredns.backup.yaml` exists and has been read back, and you only add a `hosts` record for the name `packageserver` could not resolve. Rollback: `kubectl -n kube-system apply -f cpaas-coredns.backup.yaml` and wait until the CoreDNS pods are Ready.

```bash
kubectl -n kube-system edit configmap cpaas-coredns
```

Inside the `Corefile` value, a block of this shape is enough (replace the documentation address and the name):

```text
hosts {
    192.0.2.10 <unresolved-name>
    fallthrough
}
```

Keep the existing `forward` and zone blocks. CoreDNS reloads the ConfigMap.

3. If `packagemanifests` is still empty after lookups succeed, restart `packageserver`.

> **Warning:** Restarting `packageserver` interrupts operator catalog reads for about a minute. It does not delete Subscriptions or Ceph data. Precondition: CoreDNS pods are Ready and the name resolves. Rollback: none needed.

```bash
kubectl -n cpaas-system rollout restart deploy/packageserver
kubectl get packagemanifests -A
```

When the Ceph package is listed, install it again from the console.

### Cause 2: rook-ceph-tools pod rejected because tty is true

1. Show which container has `tty` set, and read the rejection:

```bash
kubectl -n rook-ceph get deploy rook-ceph-tools -o jsonpath='{range .spec.template.spec.containers[*]}{.name}{" tty="}{.tty}{"\n"}{end}'
kubectl -n rook-ceph describe deploy rook-ceph-tools
kubectl -n rook-ceph get pods -l app=rook-ceph-tools -o wide
kubectl -n rook-ceph get csv | grep rook-ceph
kubectl -n rook-ceph get csv <rook-ceph-csv> -o yaml | grep -n -5 tty
```

2. Set the tools container `tty` to `false` in the CSV (the container under the CSV's `rook-ceph-tools` Deployment spec), so reconciles stop rendering `tty: true`:

```bash
kubectl -n rook-ceph get csv <rook-ceph-csv> -o yaml > rook-ceph-csv-before.yaml
kubectl -n rook-ceph edit csv <rook-ceph-csv>
```

3. If the Deployment still shows `tty: true`, patch it.

> **Warning:** Patching `rook-ceph-tools` recreates the toolbox pod; `ceph` commands from the toolbox fail until the new pod is Ready, while OSDs and client IO keep running. Precondition: container index 0 is the one whose `tty` printed `true` (change the index if not). Rollback: set `tty` back with the same patch only if the security policy allows it.

```bash
kubectl -n rook-ceph patch deploy rook-ceph-tools --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/containers/0/tty","value":false}]'
kubectl -n rook-ceph rollout status deploy/rook-ceph-tools
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

The storage page lists the cluster again once `ceph -s` works from that pod, and pool installation proceeds past the `OSD count 0` warning that the missing tools pod caused. If `MDS_SLOW_METADATA_IO` remains after the tools pod is up, it is a different fault.

### Cause 3: rook-ceph-system cannot get pods on ACP 3.18

Use this only when the operator log contains `cannot get resource "pods"` for `system:serviceaccount:rook-ceph:rook-ceph-system` in `rook-ceph`.

```bash
kubectl get subs -A | grep -i -E 'rook|ceph'
kubectl get csv -A | grep -i ceph
kubectl -n rook-ceph get deploy rook-ceph-operator -o jsonpath='{.metadata.labels}{"\n"}'
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=50
```

> **Warning:** Deleting the Subscription and the CSV makes OLM remove the operator Deployment and the RBAC it owns; no Rook reconcile happens until the operator is redeployed. Running MON, OSD, and RGW pods are not deleted by this step, and the `CephCluster` resource stays. Precondition: the forbidden error above is in the log, the names come from the `get subs` and `get csv` output for the Ceph operator in `rook-ceph`, and both objects are saved. Rollback: reinstall the operator from the Distributed Storage page or the operator catalog.

```bash
kubectl -n rook-ceph get subs rook-operator -o yaml > rook-operator-subs-before.yaml
kubectl -n rook-ceph get csv <rook-ceph-csv> -o yaml > rook-ceph-csv-before.yaml
kubectl -n rook-ceph delete subs rook-operator
kubectl -n rook-ceph delete csv <rook-ceph-csv>
```

Then redeploy `ceph-operator` from the Distributed Storage page (or the catalog path that installed it). When the new pod is Running, confirm that the platform lists the Ceph cluster again:

```bash
kubectl -n rook-ceph get pods | grep operator
kubectl -n rook-ceph get cephcluster
```

## Diagnostic Steps

```bash
kubectl get packagemanifests -A
kubectl -n rook-ceph get deploy,pods | grep -E 'operator|tools'
kubectl -n rook-ceph get cephcluster
```

- No packagemanifests and no `rook-ceph-operator`: Cause 1. Read the `packageserver` logs in `cpaas-system` for lookup errors, then compare Services and Endpoints for the name that failed (`kubectl -n cpaas-system get svc,endpoints`).
- Operator and `CephCluster` present, tools pod not Ready, `tty=true`, or pool installation on `HEALTH_WARN` with `TOO_FEW_OSDS` while the tools pod has `tty: true`: Cause 2. `kubectl -n rook-ceph describe pod -l app=rook-ceph-tools` shows the policy or security-component rejection.
- Operator pod forbidden to get pods as `rook-ceph-system` on ACP 3.18 (`rookcmd: failed to get pod ... is forbidden`): Cause 3. A hand-added Role that only makes the pod start is not sufficient.
- Tools pod Running and still no OSD, or an empty device class: a disk-prepare or device-name problem; see the related article on deployments that created no OSD.
