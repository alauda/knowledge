---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.4.1
---

# CephObjectStore stays in Deleting with failed to list buckets no route to host on ACP

## Issue

A Ceph object storage pool on Alauda Container Platform keeps showing "Deleting" (`删除中`) and never goes away, while other object stores on the same cluster stay `Ready`:

```text
kubectl -n rook-ceph get cephobjectstore
NAME             PHASE     ENDPOINT                                                 AGE
<working-store>  Ready     http://rook-ceph-rgw-<working-store>.rook-ceph.svc:7480  11d
<store>          Deleting  http://rook-ceph-rgw-<store>.rook-ceph.svc:7481          21h
```

The events of the stuck object store repeat every quarter of an hour or so:

```text
Warning  ReconcileFailed  rook-ceph-object-controller  failed to reconcile CephObjectStore "rook-ceph/<store>". failed to get dependents of CephObjectStore "rook-ceph/<store>": failed to list buckets in CephObjectStore "rook-ceph/<store>": Get "http://rook-ceph-rgw-<store>.rook-ceph.svc:7481/admin/bucket?": dial tcp <service-ip>:7481: connect: no route to host
```

`rook-ceph-object-controller` is one of the controllers inside the Rook operator. It has no pod of its own; its messages are in the log of Deployment `rook-ceph-operator` in `rook-ceph`. The RGW of each store runs as pods labelled `app=rook-ceph-rgw,rook_object_store=<store>` behind the ClusterIP Service `rook-ceph-rgw-<store>`, whose port is the gateway port of that store (for example `7480` for the first store and `7481` for the second).

A whole `CephCluster` in `Deleting` is covered in [Removing Rook-Ceph fails in the UI, or the CephCluster stays in Deleting on ACP](./Removing_Rook-Ceph_fails_in_the_UI_or_the_CephCluster_stays_in_Deleting_on_ACP.md).

## Root Cause

### Cause 1: a host firewall blocks the RGW Service port, so the dependents check cannot list buckets

Before Rook removes a `CephObjectStore`, the object controller checks whether the store still has dependents. Part of that check lists the buckets through the RGW admin API at `http://rook-ceph-rgw-<store>.rook-ceph.svc:<port>/admin/bucket`. When the operator cannot reach that endpoint, the check fails, the reconcile is retried later, and the object store stays in `Deleting`.

On bare-metal clusters whose hosts run a firewall, the firewall can block the traffic to the stuck store's Service port (`7481` here) while the port of the working store (`7480`) is allowed. A firewall that rejects a packet with an ICMP "host prohibited" reply produces exactly the client-side error `connect: no route to host`, even though the Service and its pods exist.

## Resolution

### Cause 1: a host firewall blocks the RGW Service port, so the dependents check cannot list buckets

Use this only when the events show `failed to list buckets` with `no route to host` (or a timeout) for the store's own RGW Service.

1. Confirm that the RGW of the store is running and the Service has endpoints:

```bash
kubectl -n rook-ceph describe cephobjectstore <store> | sed -n '/Events/,$p'
kubectl -n rook-ceph get pod -l app=rook-ceph-rgw,rook_object_store=<store> -o wide
kubectl -n rook-ceph get svc,endpoints rook-ceph-rgw-<store> -o wide
kubectl -n rook-ceph get pod -l app=rook-ceph-operator -o wide
```

If the RGW pods are gone and the endpoints are empty, this procedure does not apply; read the operator log for the store first.

2. Reproduce the failure from the operator and compare with the working store. Any HTTP status code (for example `200` or `403`) means the port is reachable; `No route to host` or a timeout reproduces the problem.

```bash
kubectl -n rook-ceph exec deploy/rook-ceph-operator -- curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://rook-ceph-rgw-<store>.rook-ceph.svc:<port>/
kubectl -n rook-ceph exec deploy/rook-ceph-operator -- curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://rook-ceph-rgw-<working-store>.rook-ceph.svc:<working-port>/
kubectl -n rook-ceph get svc rook-ceph-rgw-<store> -o jsonpath='{.spec.ports[*].port} {.spec.ports[*].targetPort}{"\n"}'
```

3. On the node that runs the operator pod and on the nodes that run the store's RGW pods, read the host firewall rules. Look for what lets the working store's port through and what rejects the stuck store's port:

```bash
systemctl is-active firewalld
firewall-cmd --list-all
iptables -S | grep -iE 'reject|drop'
```

> **Warning:** Changing the host firewall changes what can reach the nodes, and a wrong reload can drop other allowed traffic. Precondition: the security owner approves the rule, and the current rules are saved (`firewall-cmd --list-all > firewall-before.txt` or `iptables-save > iptables-before.txt`). Rollback: remove the added rule (`firewall-cmd --permanent --remove-port=<port>/tcp && firewall-cmd --reload`) or restore the saved rules with `iptables-restore < iptables-before.txt`.

4. Allow the stuck store's Service port and its `targetPort` in the same way the working store is already allowed. With firewalld, for example:

```bash
firewall-cmd --permanent --zone=<zone> --add-port=<port>/tcp
firewall-cmd --reload
```

Repeat on every node from step 3, then run the `curl` from step 2 again until it returns an HTTP code.

5. Wait for the next reconcile and check that the object store leaves `Deleting`:

```bash
kubectl -n rook-ceph logs deploy/rook-ceph-operator --since=30m | grep -i '<store>'
kubectl -n rook-ceph get cephobjectstore
```

6. Once the bucket list succeeds, the dependents check reports what still uses the store. If the event now names buckets or `CephObjectStoreUser` objects, those hold the deletion. List them before removing anything:

```bash
kubectl -n rook-ceph get cephobjectstoreuser
kubectl get objectbucketclaim -A
kubectl -n rook-ceph exec deploy/rook-ceph-tools -- radosgw-admin bucket list --rgw-realm=<store> --rgw-zonegroup=<store> --rgw-zone=<store>
```

> **Warning:** Deleting the users, ObjectBucketClaims, or buckets of the store deletes the objects in them. Precondition: the owners have confirmed that the data of `<store>` is no longer needed or has been copied elsewhere. Rollback: none.

```bash
kubectl -n rook-ceph delete cephobjectstoreuser <user>
```

## Diagnostic Steps

```bash
kubectl -n rook-ceph get cephobjectstore,cephobjectstoreuser
kubectl -n rook-ceph describe cephobjectstore <store> | sed -n '/Events/,$p'
kubectl -n rook-ceph get svc,endpoints | grep rgw
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200 | grep -i 'object'
```

- `ReconcileFailed` with `failed to list buckets` and `connect: no route to host` for the store's own Service, RGW pods running, and another store `Ready` on a different port: Cause 1; check the host firewall for that port.
- No endpoints and no RGW pod for the store: not this cause; read the operator log for the store.
- The event names remaining buckets or users instead of a connection error: the connectivity part is done; handle the dependents as in step 6.
