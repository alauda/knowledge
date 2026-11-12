---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.4"
---

# harbor-core cannot connect to Redis: NOAUTH from Sentinel, or ERR invalid password after a Redis password change

## Issue

`harbor-core` keeps restarting, or the Harbor login page reports that the core service is unavailable, and the core log shows that it cannot connect to Redis. Two signatures:

- A Harbor that uses Redis in Sentinel mode never comes up, or creating a standalone (single-instance) Harbor fails, and the core log has:

  ```text
  GetMasterAddrByName master="mymaster" failed: NOAUTH Authentication required
  redis: all sentinels specified in configuration are unreachable
  ```

- After the password of an external Redis was changed by editing the Redis Secret, `harbor-core` no longer starts, although `redis-cli` with the new password answers `PONG` and restarting `harbor-core` does not help:

  ```text
  [/lib/cache/cache.go:126]: failed to ping redis://:xxxxx@<redis>:6379/0?idle_timeout_seconds=30 : ERR invalid password
  [FATAL] [/core/main.go:161]: failed to initialize cache: retry timeout: ERR invalid password
  ```

Related articles: [Redis for Harbor unavailable: no Data Services license, or Redis in cluster mode reported as empty secrets](Redis_for_Harbor_unavailable_no_Data_Services_license_or_Redis_in_cluster_mode_reported_as_empty_secrets.md).

## Root Cause

### Cause 1: the Redis instance has an independent Sentinel password

Harbor connects to Redis in Sentinel mode through `spec.helmValues.redis.external` on the `Harbor` resource: `addr` lists the Sentinel endpoints on port 26379 (for example `rfs-<instance>-<n>.rfs-<instance>-hl.<redis-namespace>:26379` for ordinals 0, 1, and 2), `existingSecret` names the Redis credential Secret, `existingSecretKey` is `password`, and `sentinelMasterSet` is `mymaster`.

When the Redis instance is created in Data Services with both `Set Redis Password` and `Set Sentinel Password` enabled, its generated credential Secret (for example `redis-<instance>-default-credential`) carries both a `password` and a `sentinelPassword` key. Harbor reads only the key named in `existingSecretKey` and never sends the Sentinel password. The Sentinel nodes reject Harbor's master lookup with `NOAUTH`, every Sentinel counts as unreachable, and `harbor-core` cannot find the Redis master.

**Harbor does not support a Redis Sentinel independent password.** The Redis instance used by Harbor must have `Set Sentinel Password` disabled. The same limitation makes creation of a standalone Harbor fail. A manual `redis-cli` that succeeds with the Sentinel password does not rule this out, because Harbor does not send that password.

### Cause 2: the operator did not carry a changed external Redis password into harbor-core

With an external Redis (`redis.type: external`, `existingSecret: harbor-redis`, `existingSecretKey: password`), changing the password by editing the `harbor-redis` Secret does not update `REDIS_URL` in the Harbor core ConfigMap. `harbor-core` keeps authenticating with the old password, and restarting it re-reads the same stale ConfigMap. Triggering a Harbor instance update through the operator regenerates the configuration and `harbor-core` recovers.

## Resolution

### Cause 1

1. Confirm the cause (see Diagnostic Steps): `NOAUTH Authentication required` from `GetMasterAddrByName` in core, and `Set Sentinel Password` enabled on the Redis instance (or a `sentinelPassword` key in its credential Secret).

2. In Data Services, open the Redis instance, go to its connection (access) settings, keep `Set Redis Password` enabled, and turn off `Set Sentinel Password`.

   > **Warning:** Only when Cause 1 is confirmed. Impact: the Sentinel endpoints of this Redis instance stop requiring the Sentinel password; the Redis data password stays in force. Other clients of this instance that send the Sentinel password must be checked. Rollback: enable `Set Sentinel Password` again, which returns Harbor to the `NOAUTH` failure.

3. Watch `harbor-core` until the `NOAUTH` lines stop and the Pod becomes Ready:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" get pods -w | grep harbor-core
   CORE=$(kubectl -n "$NS" get pods -o name | grep harbor-core | head -1)
   kubectl -n "$NS" logs "$CORE" --tail=50 | grep -E 'NOAUTH|sentinels' || echo "no Sentinel auth errors"
   ```

4. If the option cannot be turned off on the existing instance, recreate the Redis instance with `Set Sentinel Password` disabled.

   > **Warning:** Only when Cause 1 is confirmed and the Sentinel password cannot be disabled on the existing instance. Impact: deleting the Redis instance deletes its data; Harbor keeps cache, session, and job-queue data in Redis, so logged-in sessions end and queued jobs are lost. Precondition: the instance is used only by this Harbor (or Harbor is not yet in service), and a maintenance window. Deletion cannot be undone.

   Find the credential Secret Data Services generated for the new instance, and copy it into the Harbor namespace if it lives elsewhere:

   ```bash
   kubectl get secret -n <redis-namespace> -l middleware.instance/type=Redis
   ```

5. If the new instance's Sentinel addresses or Secret name differ from what the `Harbor` resource references, update the `Harbor` resource.

   > **Warning:** Only when the replacement Redis has a different address or Secret name. Impact: the operator restarts Harbor components; login, push, and pull fail until the Pods are Ready. Precondition: save the current resource with the first command below. Rollback: apply the saved file.

   ```bash
   NS=<harbor-namespace>
   NAME=<harbor-name>
   kubectl -n "$NS" get harbor "$NAME" -o yaml > "$HOME/harbor-$NAME-before.yaml"
   kubectl -n "$NS" patch harbor "$NAME" --type=merge -p '{
     "spec": {"helmValues": {"redis": {"type": "external", "external": {
       "addr": "rfs-<instance>-0.rfs-<instance>-hl.<redis-namespace>:26379,rfs-<instance>-1.rfs-<instance>-hl.<redis-namespace>:26379,rfs-<instance>-2.rfs-<instance>-hl.<redis-namespace>:26379",
       "existingSecret": "<redis-credential-secret>",
       "existingSecretKey": "password",
       "sentinelMasterSet": "mymaster"
     }}}}
   }'
   ```

### Cause 2

1. Test the new password from a host that can reach Redis, then compare the password in the Secret with the one in the core ConfigMap without printing either:

   ```bash
   redis-cli -u "redis://:<new-password>@<redis>:6379/0" PING
   NS=<harbor-namespace>
   kubectl -n "$NS" get secret harbor-redis -o jsonpath='{.data.password}' | base64 -d | sha256sum
   CM=$(kubectl -n "$NS" get cm -o name | grep -- '-core$' | head -1)
   kubectl -n "$NS" get "$CM" -o yaml | grep REDIS_URL \
     | sed -E 's#.*://[^:]*:([^@]*)@.*#\1#' | sort -u \
     | while read -r p; do printf '%s' "$p" | sha256sum; done
   ```

   The cause is confirmed when `PING` returns `PONG`, core logs `ERR invalid password`, and the ConfigMap digest differs from the Secret digest. A password with special characters can appear URL-encoded in `REDIS_URL`; decode it before comparing if the digests differ only for that reason.

2. Trigger a Harbor instance update through the operator: open the instance in the Harbor operator's update view and submit it, or make a change to the `Harbor` resource that the operator reconciles.

   > **Warning:** Only when the cause is confirmed in step 1. Impact: the operator regenerates the Harbor configuration and restarts components; login, push, and pull fail until the Pods are Ready. Precondition: a short maintenance window and the `Harbor` resource saved. Rollback: apply the saved file (the stale password in the ConfigMap is not a state to return to).

   ```bash
   NAME=<harbor-name>
   kubectl -n "$NS" get harbor "$NAME" -o yaml > "$HOME/harbor-$NAME-before-redis.yaml"
   kubectl -n "$NS" patch harbor "$NAME" --type=merge \
     -p '{"spec":{"helmValues":{"core":{"resources":{"requests":{"cpu":"<new-cpu-request>"}}}}}}'
   kubectl -n "$NS" get pods -w | grep harbor-core
   ```

3. Run the digest comparison again: the two values match and the `ERR invalid password` lines stop.

## Diagnostic Steps

1. Read the core log:

   ```bash
   NS=<harbor-namespace>
   kubectl get harbor -A
   CORE=$(kubectl -n "$NS" get pods -o name | grep harbor-core | head -1)
   kubectl -n "$NS" logs "$CORE" --tail=200 | grep -iE 'redis|sentinel|NOAUTH|invalid password'
   ```

   `NOAUTH Authentication required` from `GetMasterAddrByName` points to Cause 1; `ERR invalid password` with `redis.type: external` after a password change points to Cause 2.

2. For Cause 1, check what Harbor is configured with and which keys the credential Secret carries (key names only):

   ```bash
   kubectl -n "$NS" get harbor <harbor-name> -o jsonpath='{.spec.helmValues.redis}{"\n"}'
   kubectl -n "$NS" get secret <redis-credential-secret> \
     -o go-template='{{range $k, $v := .data}}{{$k}}{{"\n"}}{{end}}'
   ```

   Expected for Cause 1: a `sentinelPassword` key next to `password`, and `existingSecretKey: password` on the Harbor resource.

3. Query Sentinel directly on port 26379 (add `-c <container>` if the Pod has more than one container):

   ```bash
   kubectl -n <redis-namespace> exec rfs-<instance>-0 -- \
     redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
   ```

   `NOAUTH Authentication required` confirms that Sentinel requires its own password; after the option is disabled the command returns the master address and port. `redis-cli` defaults to port 6379, the data port, where a `SENTINEL` command returns `unknown command`.

4. `redis: all sentinels specified in configuration are unreachable` alone is not specific to Cause 1. If `GetMasterAddrByName` fails with `dial tcp: lookup rfs-<instance>-<n>.rfs-<instance>-hl.<redis-namespace> ...: no such host` instead of `NOAUTH`, the Sentinel Pods do not exist yet. Check them before changing any password setting:

   ```bash
   kubectl -n <redis-namespace> get pods -o wide | grep -E 'rfs-|rfr-'
   kubectl -n <redis-namespace> describe pod rfs-<instance>-0 | sed -n '/Events:/,$p'
   ```

   `Init:ImagePullBackOff` or `Init:0/1` on the `rfs-` Pods with `Failed to pull image ... i/o timeout` is an image-pull problem on the node, not a password problem.
