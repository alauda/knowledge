---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cross-cluster workload migration is configured with an S3-compatible
replication repository (object-storage backed by Ceph RGW, MinIO, or
similar). The migration registry pod on the source cluster fails to
stabilise:

```text
Readiness probe failed: HTTP probe failed with statuscode: 500
```

The replication-repository status flips to `BackupStorageProviderTestFailed`
and the registry log carries a confusing mix of S3 errors:

```text
InvalidEndpointURL
InvalidAccessKeyId (status code: 403)
RequestFailure: status code 500
```

The S3 credentials and bucket are valid: the same access key and secret
work fine when tested **from inside** the cluster that owns the object
storage. The misleading authentication errors lead to long unproductive
investigations of credentials and bucket policy.

## Root Cause

The replication repository was given an S3 endpoint that resolves only on
the cluster that hosts the object-store gateway, e.g.
`rook-ceph-rgw-<store>.<storage-ns>.svc`. That hostname is part of the
in-cluster service network of the storage cluster — it has no DNS record
visible from any other cluster, and even if forwarded its IP belongs to
the storage cluster's service CIDR which is not routable from outside.

The migration registry pod runs on the **source** cluster (the one losing
the workload). It tries to resolve the configured S3 endpoint, falls
through DNS, may pick up a stale negative cache entry, and ends up
attempting connections that never reach the gateway. The S3 SDK's
behaviour for a half-open or unreachable endpoint is to emit
`InvalidAccessKeyId` and `403` errors that look like authentication
failures but are actually transport failures — the SDK never received a
valid auth challenge to validate the credentials against.

## Resolution

Use the externally reachable hostname for the S3 endpoint instead of the
in-cluster `.svc` name. For Ceph RGW the gateway is normally exposed via
an Ingress/route on the cluster that hosts it; for MinIO the equivalent is
the user-facing Service exposed via Ingress or a LoadBalancer.

1. On the cluster that hosts the object-storage gateway, look up the
   external endpoint:

   ```bash
   # Ceph RGW exposed via an Ingress
   kubectl get ingress -n <storage-ns> | grep rgw

   # Or a LoadBalancer Service
   kubectl get svc -n <storage-ns> -l app=rook-ceph-rgw
   ```

2. Update the migration's replication-repository (MigStorage / Backup-
   Storage-Location / equivalent) to reference:

   - the externally reachable HTTPS URL of the gateway (`https://rgw.example.com`),
   - the same access key and secret that worked in-cluster,
   - the same bucket name.

3. Restart the migration registry pod so it picks up the new endpoint:

   ```bash
   kubectl delete pod -n <migration-ns> -l app=registry
   ```

4. Confirm the registry pod becomes ready, the
   `BackupStorageProviderValid` condition flips to `True`, and any pending
   stage backup proceeds.

For ongoing hygiene, treat in-cluster `.svc` hostnames as forbidden in any
configuration that crosses cluster boundaries — replication repositories,
remote registries, image-pull mirrors, telemetry exporters. The migration
UI cannot tell at validation time whether the endpoint is reachable from
the source cluster, so the configuration appears valid but fails at
runtime.

## Diagnostic Steps

1. Verify the registry pod is the one in trouble (not the underlying
   gateway):

   ```bash
   kubectl get pods -n <migration-ns>
   kubectl logs -n <migration-ns> <registry-pod>
   ```

2. From a debug pod on the **source** cluster, attempt to resolve the
   configured endpoint:

   ```bash
   kubectl run dnscheck --rm -it --image=busybox -- nslookup <s3-endpoint-host>
   ```

   `Name or service not known` confirms the source cluster cannot resolve
   the hostname.

3. From the same debug pod, attempt a TCP connect:

   ```bash
   kubectl run tcpcheck --rm -it --image=busybox -- nc -vz <s3-endpoint-host> 443
   ```

   A timeout or `Network is unreachable` confirms the IP is not routable
   from the source cluster.

4. Re-run the same checks from a debug pod on the **storage** cluster
   (where the `.svc` name resolves). If they succeed there but fail on the
   source cluster, the endpoint is the issue, not the credentials.

5. After repointing the migration storage at the externally reachable
   endpoint, confirm the registry pod stabilises and a manual S3
   list-buckets through the AWS CLI from the same source cluster
   succeeds — both the migration registry and the AWS CLI use the same
   transport, so an SDK-side success is conclusive.
