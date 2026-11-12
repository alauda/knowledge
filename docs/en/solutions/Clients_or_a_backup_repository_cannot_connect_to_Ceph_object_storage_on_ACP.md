---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Clients or a backup repository cannot connect to Ceph object storage on ACP

## Issue

Applications or a backup repository cannot connect to Ceph object storage (RGW) on Alauda Container Platform:

- Clients report a connection error and production calls fail ("Ceph cannot be connected"). Under **Platform Management > Storage Management > Distributed Storage**, Ceph itself is up. The object storage access addresses show an internal address `rook-ceph-rgw-<object-store>.rook-ceph:7480` and an external address `<node-address>:<node-port>`, and the node in that external address is down. A follow-up question is how to avoid this single point of failure.
- Associating Ceph object storage with a backup repository fails. The Velero `BackupStorageLocation` (`bsl`) named `ceph` in `cpaas-system` is `phase: Unavailable` with:

  ```text
  BackupStorageLocation "ceph" is unavailable: ... operation error S3: ListObjectsV2, ... request send failed, Get "http://rook-ceph-rgw-object-store.rook-ceph:7480/<bucket>?...": dial tcp: lookup rook-ceph-rgw-object-store.rook-ceph on <dns-server>:53: no such host
  ```

  later `StatusCode: 404, ... api error NoSuchBucket`, and on a business cluster `kubectl get bsl` returns `error: the server doesn't have a resource type "bsl"`.

Services in `rook-ceph`: `rook-ceph-rgw-<object-store>` (ClusterIP, port `7480` to container port `8080`) and `rook-ceph-rgw-<object-store>-external` (NodePort, port `7480` to container port `8080`).

## Root Cause

### Cause 1: clients use the single node address the UI shows, and that node is down

The external access is a NodePort Service, which is reachable on the NodePort of every node in the cluster. The external address shown in the UI is one node picked for display; it is not a virtual IP that follows a healthy node. Clients configured with only that address lose the connection when that server is down. Ceph itself does not need any repair.

Two ways to remove the single point of failure:

1. Put an external load balancer in front of the same NodePort on several nodes.
2. Expose RGW with a Service of type LoadBalancer (or adjust internal routing in the RGW namespace). This is a backend change; the console does not offer it for object storage.

### Cause 2: the BackupStorageLocation is Unavailable because of a missing plugin and an in-cluster endpoint

Two problems keep the backup repository down, one after the other:

1. The backup plugin is not installed on the cluster that runs the backups, so that cluster has no `bsl` resource type at all.
2. The backup repository endpoint is the in-cluster Service name `rook-ceph-rgw-object-store.rook-ceph:7480`, which does not resolve from where the backup client runs (`no such host`). Once the name resolves, a wrong folder setting produces `NoSuchBucket`.

## Resolution

### Cause 1: clients use the single node address the UI shows, and that node is down

1. Confirm the node state and Ceph health:

```bash
kubectl get nodes
kubectl -n rook-ceph get svc | grep -i rgw
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

2. If `ceph -s` is healthy and the node in the published address is `NotReady` or powered off, recover that server; access returns when it is back. Meanwhile, clients can use any other Ready node's address on the same NodePort. The UI keeps showing the single node it picked.
3. For a setup that survives one node, point an external load balancer (for example an F5) at the NodePort on several Ready nodes:

```bash
kubectl -n rook-ceph get svc rook-ceph-rgw-<object-store>-external -o jsonpath='{.spec.ports[0].nodePort}{"\n"}'
kubectl get nodes -o wide
```

4. Alternatively, create a LoadBalancer Service for RGW. The manifest below is the generic Kubernetes form; reuse the selector of the existing in-cluster RGW Service:

```bash
kubectl -n rook-ceph get svc rook-ceph-rgw-<object-store> -o jsonpath='{.spec.selector}{"\n"}'
```

> **Warning:** A LoadBalancer Service publishes RGW on an address outside the cluster; anyone who can reach it can send S3 requests. Precondition: the cluster has a working LoadBalancer implementation, and the security owner approves the exposure. Rollback: `kubectl -n rook-ceph delete svc rook-ceph-rgw-<object-store>-lb`; the existing Services keep serving.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: rook-ceph-rgw-<object-store>-lb
  namespace: rook-ceph
spec:
  type: LoadBalancer
  selector:
    # use the selector printed by the command above
    app: rook-ceph-rgw
    rook_object_store: <object-store>
  ports:
    - name: http
      port: 7480
      targetPort: 8080
      protocol: TCP
```

`kubectl -n rook-ceph get svc rook-ceph-rgw-<object-store>-lb` shows the external IP once it is assigned. Clients then use `http://<external-ip>:7480`.

### Cause 2: the BackupStorageLocation is Unavailable because of a missing plugin and an in-cluster endpoint

1. Check that the backup plugin is installed on the cluster that runs the backups:

```bash
kubectl -n cpaas-system get bsl
kubectl -n cpaas-system get bsl ceph -o yaml
```

`error: the server doesn't have a resource type "bsl"` means the plugin is missing there. Install the backup plugin on that cluster from the platform plugin management, as on the other clusters, then read the BSL again.

2. On the cluster that runs Ceph, get the external RGW address:

```bash
kubectl -n rook-ceph get svc | grep rgw
kubectl get nodes -o wide
```

3. In the backup repository settings, set the endpoint to `http://<node-address>:<node-port>` (the `-external` NodePort) instead of the in-cluster name, and set the folder to `/`. Keep the provider (`aws`), `s3ForcePathStyle: "true"`, and the credential Secret as they are.
4. Confirm with an S3 client that the bucket in the repository settings exists under the same keys; `NoSuchBucket` means RGW was reached and the bucket name or path did not match:

```bash
s3cmd --host=<node-address>:<node-port> --host-bucket=<node-address>:<node-port> --no-ssl --access_key=<access-key> --secret_key=<secret-key> ls
```

5. Wait for the BSL to become available:

```bash
kubectl -n cpaas-system get bsl ceph -o jsonpath='{.status.phase}{"\n"}'
```

A node-address endpoint has the single-node exposure described in Cause 1. If that node goes down, the backup repository loses RGW the same way; a load balancer address avoids that.

## Diagnostic Steps

```bash
kubectl get nodes -o wide
kubectl -n rook-ceph get svc -o wide | grep -i rgw
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- ceph -s
```

- The node in the published address is down and `ceph -s` is healthy: Cause 1.
- `ceph -s` is not healthy: fix the Ceph cluster first; an address change does not replace a down OSD.
- A BSL `Unavailable` with `no such host` for `rook-ceph-rgw-<object-store>.rook-ceph`, `NoSuchBucket`, or no `bsl` resource type on the cluster: Cause 2.
- The client connects and then gets `InvalidAccessKeyId`: a credentials problem. A `Read timed out` after the bucket was found: see [Ceph OSDs nearfull, backfill blocked, or OSD usage uneven on ACP](./Ceph_OSDs_nearfull_backfill_blocked_or_OSD_usage_uneven_on_ACP.md), Cause 7.
- A `CephObjectStore` stuck in `Deleting` with `no route to host` to its own RGW: see [CephObjectStore stays in Deleting with failed to list buckets no route to host on ACP](./CephObjectStore_stays_in_Deleting_with_failed_to_list_buckets_no_route_to_host_on_ACP.md).
