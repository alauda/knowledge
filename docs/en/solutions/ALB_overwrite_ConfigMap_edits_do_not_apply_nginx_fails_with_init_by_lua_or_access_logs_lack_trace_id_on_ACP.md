---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.10.x
  - 3.14.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# ALB overwrite ConfigMap edits do not apply, nginx fails with init_by_lua, or access logs lack trace_id on ACP

Related articles: [ALB nginx settings are reverted after a restart or upgrade; change them through the overwrite ConfigMap on ACP](ALB_nginx_settings_are_reverted_after_a_restart_or_upgrade_change_them_through_the_overwrite_ConfigMap_on_ACP.md).

## Issue

An Alauda Load Balancer (ALB) already uses an overwrite ConfigMap (referenced from `spec.config.overwrite.configmap` of the `alb2`, setup described in the related article), and:

- a timeout or another key was changed in the overwrite ConfigMap, the ALB Pod was restarted, and the running nginx still has the old value;
- before a production change, someone asks whether editing the overwrite ConfigMap restarts the ALB and how much a timeout change affects the business;
- after the overwrite ConfigMap was created, the ALB Pod crashes in Lua before it listens, with `init_by_lua` errors and the `balancer` module failing to load;
- the access logs do not contain a trace ID, so a failed call cannot be tied to the caller's `X-Trace-Id`.

## Root Cause

### Cause 1: edits to the overwrite ConfigMap are not synced until the alb2 resource changes

When an overwrite ConfigMap is set, edits to it are not synced on their own: the ConfigMap with the same name as the ALB is regenerated only when the `alb2` resource itself changes. A Pod restart is not such a change.

A second problem can hide behind the first. After the `alb2` was updated, a value can still be missing because the overwrite ConfigMap itself is wrong, for example `proxy_connect_timeout s60;` instead of `proxy_connect_timeout 60s;` in the `stream-tcp` section (the unit must follow the number), or lines in the last section of the YAML that need more indentation. On 3.14 the new values can appear only after a delay, although a mounted ConfigMap normally reloads quickly.

Editing only the content of the ConfigMap that is already referenced has small impact: normally none, and with many slow connections the ALB uses somewhat more memory. Adding an annotation to the `alb2` to trigger the update applies the new value without restarting the ALB Pod.

### Cause 2: init_by_lua error, cannot load the balancer module

The overwrite ConfigMap was cloned from the live object, but part of `data.http` was dropped (for example while adding `escape=json` to the log format), so Lua initialization no longer sees the balancer setup, `init_by_lua` fails and the `balancer` module does not load.

### Cause 3: the access logs do not contain trace_id

The default `log_format http` has no `trace_id` variable. This is a missing overwrite entry, not a dropped request.

## Resolution

### Cause 1: edits to the overwrite ConfigMap are not synced until the alb2 resource changes

1. After every edit of the overwrite ConfigMap, change the `alb2` resource so that the controller regenerates the ALB ConfigMap. Any annotation change works, for example:

   ```bash
   kubectl -n cpaas-system annotate alb2 <alb-name> force-reload="$(date +%s)" --overwrite
   ```

   In the console the same step is **Resource Management**, resource type `alb2`, version `v2beta1`: edit the ALB and add an annotation.

2. Compare the rendered ConfigMap with the overwrite copy, then check the running files inside the ALB Pod:

   ```bash
   kubectl -n cpaas-system get configmap <alb-name>-cm-update -o yaml | grep -n -E 'proxy_(connect_)?timeout|proxy_(send|read)_timeout'
   kubectl -n cpaas-system get configmap <alb-name> -o yaml | grep -n -E 'proxy_(connect|send|read)_timeout'
   kubectl -n cpaas-system exec <alb-pod> -c nginx -- sh -c 'grep -R -n -E "proxy_(connect|send|read)_timeout|proxy_timeout" /alb/tweak 2>/dev/null | head'
   ```

3. If the new value is still absent, the overwrite ConfigMap itself is wrong. Look for a malformed value such as `s60` instead of `60s`, a misplaced entry, or indentation errors in the last block, fix it, and trigger the `alb2` update again. A correct `stream-tcp` section looks like this:

   ```nginx
   proxy_connect_timeout 60s;
   proxy_next_upstream_tries 5;
   proxy_timeout 600s;
   tcp_nodelay on;
   ```

   > **Warning:** A broken overwrite ConfigMap makes every replica of this ALB fail its reload, which drops traffic for every Ingress and rule on it. Back up the overwrite ConfigMap before each edit. To roll back, re-apply the backup and change the `alb2` annotation again.

### Cause 2: init_by_lua error, cannot load the balancer module

Rebuild the overwrite ConfigMap from a fresh full copy of the live object's `data` (procedure in the related article), then change only `log_format`. Replacing `log_format http` with `log_format http escape=json` is enough for JSON access logs. Keep the `access_log` line pointed at that format, for example `access_log /dev/stdout http buffer=16k flush=1s;`. Then trigger the `alb2` update.

> **Warning:** Reloading after a truncated `http` block keeps the ALB down until the full `data.http` is restored. Keep a backup of the overwrite ConfigMap. To roll back, `kubectl apply` the backup and set the `force-reload` annotation again.

### Cause 3: the access logs do not contain trace_id

Add the map and the log variables to the overwrite ConfigMap `data.http`, preserving the rest of the content, then trigger the `alb2` update. When the client sends `X-Trace-Id`, that value is logged; otherwise nginx's `$request_id` is used.

```nginx
map $http_x_trace_id $trace_id {
    default $http_x_trace_id;
    ""      $request_id;
}
```

Inside `log_format http`, add `trace_id="$trace_id"` and `req_id="$request_id"`. To forward the inbound header to the upstream, add `proxy_set_header X-Trace-Id $http_x_trace_id;` in the `http_server` section of the same ConfigMap. Do not create a second log format name; the data plane reads the format named `http`.

## Diagnostic Steps

1. Confirm that an overwrite ConfigMap is referenced. If not, start with the related article:

   ```bash
   kubectl -n cpaas-system get alb2 <alb-name> -o jsonpath='{.spec.config.overwrite.configmap}{"\n"}'
   ```

2. If the overwrite is set and a restart did not apply an edit, compare the overwrite ConfigMap, the rendered ConfigMap and `/alb/tweak` in the Pod (Cause 1). A value missing from the rendered ConfigMap means the `alb2` was not updated; a malformed value in the overwrite copy is the second part of Cause 1.

3. For a Lua crash, read the previous container log before editing anything else. `init_by_lua` and `balancer` errors are Cause 2:

   ```bash
   kubectl -n cpaas-system logs <alb-pod> -c nginx --previous | grep -E 'init_by_lua|balancer'
   ```

4. After a successful reload, confirm the running files rather than the ConfigMap alone:

   ```bash
   kubectl -n cpaas-system exec <alb-pod> -c nginx -- sh -c 'find / -path "*tweak*http.conf" 2>/dev/null | head'
   ```
