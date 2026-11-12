---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
  - Alauda Application Services
ProductsVersion: []
---

# Redis for Harbor unavailable: no Data Services license, or Redis in cluster mode reported as empty secrets

## Issue

Harbor cannot be deployed because its Redis is not available or not accepted:

- While preparing Redis for a Harbor v4 deployment, the Select Instance Type page blocks creation of a `Redis` instance with `请在 Data Services 视图使用此功能` ("use this function in the Data Services view"), and the create action is disabled. The list also shows `ActiveRedis`, `ActiveRedisConnection`, `DistributedRedisCluster`, and `RedisClusterBackup`. Opening Data Services then shows `无法访问此页面` ("the page cannot be accessed"), states that the Data Services product function cannot be used, and points to `许可证管理 / 平台许可证` (License Management / Platform License) with an `立即导入` (Import now) action.
- Deploying Harbor reports that the secrets are empty, although the Secrets named by the deployment do contain data.

Related articles: [harbor-core cannot connect to Redis: NOAUTH from Sentinel, or ERR invalid password after a Redis password change](harbor-core_cannot_connect_to_Redis_NOAUTH_from_Sentinel_or_ERR_invalid_password_after_a_Redis_password_change.md).

## Root Cause

### Cause 1: Data Services is not licensed

Redis provisioning for Harbor v4 from the platform goes through Data Services ("v4" is the ACP packaging name, not the Helm chart or Harbor version). When Data Services has not been purchased, its license is absent, the Data Services view cannot be opened, and a Redis instance cannot be created there. This is a licensing condition, not a fault. Harbor can instead be deployed against Redis and PostgreSQL that you provide, passed to Harbor through credential Secrets.

### Cause 2: the Redis instance runs in cluster mode

When the Redis instance configured for Harbor runs in cluster mode, deploying Harbor reports that the secrets are empty, even though the Secrets contain data. The error comes from the unsupported Redis mode, not from missing Secret content. **Harbor does not support Redis cluster mode**; it needs a Redis that is not in cluster mode (Sentinel or standalone).

## Resolution

### Cause 1

1. Check `许可证管理 / 平台许可证` (Platform License) for a Data Services license. If Data Services is purchased later, import the license from that page; Redis can then be created from the Data Services view.

2. Without the license, provide Redis and PostgreSQL yourself and give Harbor their connection details in Opaque Secrets in the Harbor namespace. Follow the "Harbor credentials" page of the Alauda Build of Harbor installation documentation for the Harbor version you deploy: it lists the Secret keys, the supported PostgreSQL versions, and how the Secrets are referenced from the `Harbor` resource. The Harbor version decides which PostgreSQL version is required (for example, Harbor 2.12.z requires PostgreSQL 14.x; Harbor 2.14.z supports PostgreSQL 15.x and 16.x).

   Redis in Sentinel mode uses the keys `password`, `address`, and `masterName`:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" create secret generic harbor-redis \
     --from-literal=password='<redis-password>' \
     --from-literal=address='192.0.2.11:26379,192.0.2.12:26379,192.0.2.13:26379' \
     --from-literal=masterName='mymaster'
   ```

   Redis in standalone mode uses `host`, `port`, and `password` instead.

   PostgreSQL uses `host`, `port`, `username`, `password`, `database`, and `sslmode`. The database must already exist and be empty; `harbor_db` below is only an example name and must be the database you created:

   ```bash
   kubectl -n "$NS" create secret generic harbor-database \
     --from-literal=host='192.0.2.20' \
     --from-literal=port='5432' \
     --from-literal=username='postgres' \
     --from-literal=password='<postgres-password>' \
     --from-literal=database='harbor_db' \
     --from-literal=sslmode='require'
   ```

3. Use a Redis without an independent Sentinel password: Harbor does not send the Sentinel password and fails with `NOAUTH` (see the related article).

### Cause 2

1. Confirm that the Secrets are not empty and that Redis runs in cluster mode:

   ```bash
   NS=<harbor-namespace>
   kubectl -n "$NS" get secret <referenced-secret> -o go-template='{{range $k, $v := .data}}{{$k}} {{len $v}}{{"\n"}}{{end}}'
   kubectl get redis -A
   kubectl -n <redis-namespace> get redis <instance> -o yaml | grep -n -i -E 'arch|mode|cluster'
   ```

   The cause is confirmed when every key has a non-zero length and the Redis instance is in cluster mode.

2. Create a Redis instance that is not in cluster mode (Sentinel or standalone) in Data Services, and copy its credential Secret into the Harbor namespace if it lives elsewhere:

   ```bash
   kubectl get secret -n <redis-namespace> -l middleware.instance/type=Redis
   ```

3. Point the `Harbor` resource at the new instance.

   > **Warning:** Only when the deployment reports empty secrets, the Secrets are not empty, and Redis is in cluster mode. Impact: the operator restarts Harbor components, and cache, sessions, and queued jobs on the old Redis are not carried over. Precondition: the new Redis instance is Ready and its Secret is in the Harbor namespace; save the current resource with the first command below. Rollback: apply the saved file, which returns the unsupported mode and the same error. Do not delete the cluster-mode instance until Harbor works on the new one; its deletion cannot be undone.

   ```bash
   NAME=<harbor-name>
   kubectl -n "$NS" get harbor "$NAME" -o yaml > "$HOME/harbor-$NAME-before.yaml"
   kubectl -n "$NS" patch harbor "$NAME" --type=merge -p '{
     "spec": {"helmValues": {"redis": {"type": "external", "external": {
       "addr": "<sentinel-1>:26379,<sentinel-2>:26379,<sentinel-3>:26379",
       "existingSecret": "<redis-credential-secret>",
       "existingSecretKey": "password",
       "sentinelMasterSet": "mymaster"
     }}}}
   }'
   ```

   For a standalone replacement, use its `host:port` as `addr` and leave `sentinelMasterSet` unset.

## Diagnostic Steps

1. For Cause 1 the evidence is in the UI: the text `请在 Data Services 视图使用此功能` when creating Redis, and `无法访问此页面` pointing to the platform license page when Data Services is opened. Check the Platform License page before investigating a fault.

2. For Cause 2, list the key sizes of every Secret the deployment references (command in Cause 2, step 1). Expected: non-zero sizes. Then check the Redis architecture. Expected: cluster mode.

3. Once Harbor is deployed, read the core log for Redis errors:

   ```bash
   CORE=$(kubectl -n <harbor-namespace> get pods -o name | grep harbor-core | head -1)
   kubectl -n <harbor-namespace> logs "$CORE" --tail=200 | grep -iE 'redis|sentinel|NOAUTH|invalid password'
   ```

   Expected: no Redis errors. `NOAUTH` or `ERR invalid password` is covered by the related article.
