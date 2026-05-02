---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Scope Object Bucket Visibility for Tenant Users with RBAC
## Issue

A tenant developer or namespace admin should only see the `ObjectBucketClaim` resources (and the matching backing `ObjectBucket`s) belonging to their own namespace, plus a few cluster-scoped supporting objects. By default the platform console either shows every bucket cluster-wide (unsafe across tenants) or none (because the user has no access). The goal is to grant a least-privilege bundle of permissions so the bucket browser works for that user without leaking other tenants' buckets.

## Resolution

Bucket visibility is governed by Kubernetes RBAC, not by the storage system itself: the console talks to the API server using the user's identity and lists exactly what RBAC allows. Three pieces of permission are needed.

### 1. Per-namespace view of ObjectBucketClaim and ObjectBucket

The bucket-claim CRDs are namespaced. Bind a `view`-style role to the user only in the namespaces they should see:

```bash
kubectl create clusterrole view-object-buckets \
  --resource=objectbucketclaims.objectbucket.io,objectbuckets.objectbucket.io \
  --verb=get,list,watch

kubectl -n <tenant-ns> create rolebinding view-object-buckets-binding \
  --clusterrole=view-object-buckets \
  --user=<user>
```

A `RoleBinding` (not a `ClusterRoleBinding`) keeps the grant scoped to one namespace; repeat per namespace the user is allowed into.

### 2. Cluster-scope read of operator metadata

The console resolves which storage operator is installed by reading OLM `Subscription` and `ClusterServiceVersion` objects. These are effectively cluster-scoped; without read access the bucket panel renders empty.

```bash
kubectl create clusterrole view-storage-operator-meta \
  --resource=subscriptions.operators.coreos.com,clusterserviceversions.operators.coreos.com \
  --verb=get,list,watch

kubectl create clusterrolebinding view-storage-operator-meta-binding \
  --clusterrole=view-storage-operator-meta \
  --user=<user>
```

### 3. Read of the bucket admin Secret

The console fetches connection info (endpoint, root credentials per bucket) from a Secret in the storage system's namespace — for the Ceph object stack this is typically the `*-admin` Secret in the `cpaas-system` (or equivalent operator) namespace. Grant a narrow read on that Secret only:

```bash
kubectl -n <storage-ns> create role view-bucket-admin-secret \
  --resource=secrets \
  --verb=get,list,watch

kubectl -n <storage-ns> create rolebinding view-bucket-admin-secret-binding \
  --role=view-bucket-admin-secret \
  --user=<user>
```

Bind only the Secret name needed — `kubectl create role` accepts `--resource-name` if a stricter scope is desired:

```bash
kubectl -n <storage-ns> create role view-bucket-admin-secret \
  --resource=secrets --resource-name=ceph-rgw-admin --verb=get,list,watch
```

## Diagnostic Steps

After applying the bindings, validate the user's effective permissions before they hit the console:

```bash
kubectl auth can-i get objectbucketclaims --as=<user> -n <tenant-ns>
kubectl auth can-i list subscriptions.operators.coreos.com --as=<user>
kubectl auth can-i get secret/ceph-rgw-admin --as=<user> -n <storage-ns>
```

All three should print `yes`. Common pitfalls:

- The bucket panel still shows nothing after the grants land. The user is most likely cached against the API server; have them log out and back in, or run `kubectl auth can-i ... --as=<user>` from the same client to confirm RBAC really took effect.
- The user can list claims in `<tenant-ns>` but the corresponding `ObjectBucket` (cluster-scoped) is hidden. The `view-object-buckets` ClusterRole above includes `objectbuckets.objectbucket.io`, but the `RoleBinding` only scopes the namespaced subset. To grant cluster-wide read of `ObjectBucket` add a separate `ClusterRoleBinding` with the same role — accept that the user will then see all OB names cluster-wide (this is read-only metadata, no data leak).
- Tenant claims show up but bucket details fail with 403. Verify the storage-namespace Secret RoleBinding actually targets the Secret the storage operator publishes — name varies by backend (`rook-ceph-object-user-*` for Rook, `minio-creds-*` for MinIO).

For a full-tenant model where many users share the same namespace, replace `--user=<user>` with `--group=<group>` so adding a user to the IdP group automatically opens the bucket view.
