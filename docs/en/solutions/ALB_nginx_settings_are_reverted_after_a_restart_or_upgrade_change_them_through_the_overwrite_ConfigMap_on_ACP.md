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

# ALB nginx settings are reverted after a restart or upgrade; change them through the overwrite ConfigMap on ACP

Related articles: [ALB overwrite ConfigMap edits do not apply, nginx fails with init_by_lua, or access logs lack trace_id on ACP](ALB_overwrite_ConfigMap_edits_do_not_apply_nginx_fails_with_init_by_lua_or_access_logs_lack_trace_id_on_ACP.md).

## Issue

Timeouts, access-log format, request-header buffers and similar nginx settings on an Alauda Load Balancer (ALB) do not survive a restart or a platform upgrade. The data plane is the `ALB2` object (`alaudaloadbalancer2.crd.alauda.io`, short name `alb2`), usually in `cpaas-system`. Typical reports:

- The ALB ConfigMap is restored every time it is edited. Where should ALB settings be configured?
- `proxy_read_timeout` was changed and goes back to `120s` after a restart.
- File downloads end with `gateway timeout` after a little over a minute, and a download timeout changed by hand is reset shortly afterwards.
- On ALB 3.14, edits to the Pod spec, container files or probes are reverted.
- A previously working nginx customization stopped working after an upgrade.
- After an upgrade to 4.3.3, the load balancer address and the domain stop answering, while `telnet` to the container port works.

## Root Cause

### Cause 1: the rendered ALB ConfigMap is not the source of truth

The ConfigMap with the same name as the ALB in `cpaas-system` (next to `<alb-name>-port-info`) is rendered and managed by the ALB. After an edit, a restart or an upgrade the controller writes it again, so a direct change to `proxy_read_timeout` or any other key is lost. The durable place for nginx settings is an overwrite ConfigMap referenced from `spec.config.overwrite.configmap` on the `ALB2`. Setting up the reference is a one-time step; later changes go into the overwrite ConfigMap, followed by an update of the `ALB2` (see the related article).

ALB configuration compatibility is not carried over automatically across a platform upgrade (for example from 3.8 to 3.12): customized parameters have to be checked and adapted by hand after the upgrade.

### Cause 2: proxy_read_timeout was changed in the grpc_server section and returns to 120s

Two mistakes together: the edit was made on the rendered ConfigMap (Cause 1), and it was made in the `grpc_server` section, which does not control these connection timeouts. Layer-7 timeouts are `proxy_read_timeout` and `proxy_send_timeout` in the `http` / `http_server` sections; the Layer-4 idle timeout is `proxy_timeout` in `stream-tcp`.

### Cause 3: on ALB 3.14, Pod YAML or files edited by hand are reverted by the operator

On platform 3.14 the ALB is owned by an operator (`alb-operator`). Changes to the Pod template, container files or probes are restored, and that release does not expose those fields on the CRD. Later 3.18 builds publish more ALB metrics; they do not make Pod edits durable on 3.14.

### Cause 4: custom nginx settings stop working after an upgrade although the overwrite is still referenced

The ALB overwrite from the previous version was not updated during the upgrade, so the upgraded ALB kept rendering from the old copy, which no longer matches the new template. The overwrite procedure itself is still valid; rebuilding the copy from the new version's template fixes it.

### Cause 5: after an upgrade to 4.3.3, Pod annotations added on the ALB Deployment are removed

When an ALB is set up for the MetalLB underlay scheme (MetalLB with ALB providing independent load balancing for underlay business traffic), the Pod annotations that scheme needs may have been added directly to the ALB Deployment. The upgrade to 4.3.3 regenerates the Deployment and drops those additions. Access through the load balancer address and the domain then fails, while the ALB itself is running and `telnet` to the container port works.

## Resolution

### Cause 1: the rendered ALB ConfigMap is not the source of truth

1. Back up the live ConfigMap, the overwrite ConfigMap if it already exists, and the `alb2` object, before an upgrade and before every edit:

   ```bash
   kubectl -n cpaas-system get configmap <alb-name> -o yaml > /tmp/<alb-name>-cm.backup.yaml
   kubectl -n cpaas-system get configmap <alb-name>-cm-update -o yaml > /tmp/<alb-name>-cm-update.backup.yaml
   kubectl -n cpaas-system get alb2 <alb-name> -o yaml > /tmp/<alb-name>-alb2.backup.yaml
   ```

2. If `spec.config.overwrite` already exists, do not create a second copy: edit the ConfigMap it references and go to step 5. Otherwise create the overwrite ConfigMap once, from a full copy of the live `data` keys. Do not `kubectl apply` the backup itself; that object is owned by the ALB.

   ```bash
   kubectl -n cpaas-system get configmap <alb-name> -o json | python3 -c '
   import json, sys
   cm = json.load(sys.stdin)
   out = {
     "apiVersion": "v1",
     "kind": "ConfigMap",
     "metadata": {
       "name": cm["metadata"]["name"] + "-cm-update",
       "namespace": cm["metadata"]["namespace"],
     },
     "data": cm.get("data") or {},
   }
   json.dump(out, sys.stdout, indent=2)
   print()
   ' > /tmp/<alb-name>-cm-update.json
   kubectl apply -f /tmp/<alb-name>-cm-update.json
   ```

   The same copy can be made in the console: **Cluster Management > Resource Management**, search ConfigMap for the ALB name, copy the content of `<alb-name>` into **Create Resource Object**, rename it `<alb-name>-cm-update`, and keep only `name` and `namespace` under `metadata` (remove `creationTimestamp`, `labels` such as `alb.cpaas.io/managed-by: alb-operator`, `managedFields`, `ownerReferences` and `resourceVersion`).

3. Point the `ALB2` at that object. On 4.1, `spec.config.overwrite.configmap` of the `alb2` (`crd.alauda.io/v2beta1`) is a list of `name` entries, each a `namespace/name` string:

   > **Warning:** Pointing the ALB at a different ConfigMap for the first time can make the ALB remount it and restart, which interrupts its listeners; nginx takes the new configuration at once, and a faulty configuration breaks it at once. Check the content before saving the reference, do it in a maintenance window with more than one ALB replica, and keep the `alb2` backup. To roll back, remove the `overwrite` entry (apply the saved `alb2` YAML).

   ```bash
   kubectl -n cpaas-system patch alb2 <alb-name> --type merge -p \
     '{"spec":{"config":{"overwrite":{"configmap":[{"name":"cpaas-system/<alb-name>-cm-update"}]}}}}'
   ```

4. From now on, edit only the overwrite ConfigMap. Typical keys inside `data.http` are the nginx `http` context: `log_format`, `large_client_header_buffers`, `client_max_body_size` and the `proxy_*_timeout` directives. Leave every other line in place. For long calls (large-model inference, downloads), put `proxy_connect_timeout`, `proxy_send_timeout` and `proxy_read_timeout` here; this applies to the whole ALB, not to one frontend. Per-frontend timeouts are fields of the `Frontend` resource instead. On 4.2 the same kinds of setting are also available from the Ingress and ALB resources.

5. After each edit, update the `alb2` so the controller regenerates its ConfigMap. The `force-reload` annotation is a hot reload and does not delete the Pod:

   > **Warning:** A bad `data.http` makes every replica of this ALB fail its reload or crash, which drops traffic for every Ingress and rule on it. Change one setting at a time. To roll back, re-apply the overwrite backup and set the annotation again.

   ```bash
   kubectl -n cpaas-system annotate alb2 <alb-name> force-reload="$(date +%s)" --overwrite
   ```

6. Confirm the rendered files in the ALB Pod under `/alb/tweak` (`http.conf`, `stream-tcp.conf`, `stream-udp.conf`) instead of assuming that the ConfigMap and the running file match:

   ```bash
   kubectl -n cpaas-system exec <alb-pod> -c nginx -- sh -c 'grep -R -n -E "proxy_(connect|send|read)_timeout|proxy_timeout" /alb/tweak | head'
   ```

   Alternatively, update the overwrite ConfigMap and restart the ALB Pods one at a time in a maintenance window, then read the files in the new Pod.

   > **Warning:** Restarting the ALB Pods drops in-flight connections on each replica and, for a single-replica ALB, interrupts all its listeners until the Pod is Ready. Wait until each replacement is Ready before the next.

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep <alb-name>
   kubectl -n cpaas-system delete pod <alb-pod>
   kubectl -n cpaas-system exec <new-alb-pod> -- cat /alb/tweak/stream-tcp.conf /alb/tweak/stream-udp.conf
   ```

### Cause 2: proxy_read_timeout was changed in the grpc_server section and returns to 120s

Set up the overwrite ConfigMap as in Cause 1 (or edit the one already referenced), and set `proxy_read_timeout` / `proxy_send_timeout` in the `http_server` section, and `proxy_timeout` in `stream-tcp` for TCP ports. Then trigger the `alb2` update and check `/alb/tweak` in the nginx container.

```bash
kubectl -n cpaas-system get alb2 <alb-name> -o yaml | grep -A8 overwrite
kubectl -n cpaas-system get cm <alb-name>-cm-update -o yaml | grep -n -E '^  [a-z_-]+:|proxy_(read|send)_timeout|proxy_timeout'
```

### Cause 3: on ALB 3.14, Pod YAML or files edited by hand are reverted by the operator

Stop editing the Deployment, the Pod and files inside the container. Put supported settings on the `ALB2` (or on rule and Ingress objects), and nginx settings in the overwrite ConfigMap. Probe and sidecar changes that are not CRD fields cannot be kept on 3.14. Do not scale `alb-operator` to zero to make a Pod edit stick; that is too risky for production.

```bash
kubectl -n cpaas-system get deploy alb-operator
kubectl -n cpaas-system get alb2 <alb-name> -o yaml
```

### Cause 4: custom nginx settings stop working after an upgrade although the overwrite is still referenced

1. Before an upgrade, export the overwrite ConfigMap and the `alb2` (Cause 1, step 1).
2. After the upgrade, rebuild the overwrite ConfigMap from the new version's rendered ConfigMap and re-apply only the custom lines, so the copy matches the new template. Then trigger the `alb2` update.

   > **Warning:** Replacing the overwrite content reloads nginx on every replica of this ALB, and a mistake stops the reload for all its listeners. Keep backups of the old overwrite ConfigMap and the new rendered ConfigMap, and write down the list of custom lines. To roll back, re-apply the old overwrite backup and change the `alb2` annotation again.

3. Some settings are fields of the `alb2` resource rather than nginx text. For example, forwarded headers are enabled with a `config` block under `spec`, leaving the other spec fields (`enablePortProject`, `networkMode`, `nodeSelector`) unchanged, in a maintenance window:

   ```yaml
   spec:
     config:
       proxy_header:
         use_forward_headers: "true"
   ```

   Verify inside the ALB container:

   ```bash
   kubectl -n cpaas-system exec <alb-pod> -- sh -c 'cat /etc/alb2/nginx/policy.new | grep forwarded'
   ```

### Cause 5: after an upgrade to 4.3.3, Pod annotations added on the ALB Deployment are removed

Put the Pod annotations on the `alb2` resource instead of the Deployment, with the `alb.cpaas.io/pod-annotations` annotation, so they persist at the `alb2` level and are rendered into the Pods. Replace the example key and value with the annotations the scheme needs:

> **Warning:** The ALB Pods roll to pick up the new annotations, and wrong network annotations can leave them without the intended address. Copy the annotations from the pre-upgrade Deployment YAML (or the scheme documentation) and save the `alb2` YAML. To roll back, run `kubectl annotate alb2 -n cpaas-system <alb-name> alb.cpaas.io/pod-annotations-`.

```bash
kubectl annotate alb2 -n cpaas-system <alb-name> \
  'alb.cpaas.io/pod-annotations={"example.com/key":"value"}' \
  --overwrite
```

Also check the external load balancer's forwarding to the ALB.

## Diagnostic Steps

1. Identify which ALB owns the traffic and whether an overwrite ConfigMap is already referenced. If the jsonpath prints nothing, edits to the rendered ConfigMap will be lost (Cause 1):

   ```bash
   kubectl get alb2 -A
   kubectl -n cpaas-system get alb2 <alb-name> -o jsonpath='{.spec.config.overwrite.configmap}{"\n"}'
   kubectl -n cpaas-system get configmap <alb-name> <alb-name>-cm-update
   ```

2. For a timeout that returns to `120s`, find which section carries the edited line. A hit only under `grpc_server` is Cause 2:

   ```bash
   kubectl -n cpaas-system get cm <alb-name> -o yaml | grep -n -E '^  [a-z_-]+:|proxy_(read|send)_timeout|proxy_timeout'
   ```

3. On 3.14, an existing `alb-operator` Deployment is the reconciler that undoes Pod edits (Cause 3):

   ```bash
   kubectl get deploy -n cpaas-system alb-operator
   ```

4. After an upgrade, diff the rendered `data.http` against the backup (Cause 4), and compare the Pod annotations with the Deployment YAML saved before the upgrade (Cause 5):

   ```bash
   kubectl -n cpaas-system get configmap <alb-name> -o jsonpath='{.data.http}' > /tmp/live-http.conf
   diff -u /tmp/expected-http.conf /tmp/live-http.conf
   kubectl -n cpaas-system get pod <alb-pod> -o jsonpath='{.metadata.annotations}{"\n"}'
   kubectl -n cpaas-system get alb2 <alb-name> -o jsonpath='{.metadata.annotations}{"\n"}'
   ```
