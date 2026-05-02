---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OpenTelemetry Apache auto-instrumentation fails with "No such file or directory"
## Issue

A Deployment that mounts the OpenTelemetry Apache auto-instrumentation
annotation never receives the instrumented binary. The pod errors out at
init with messages similar to:

```text
Error: opening file ... No such file or directory
```

The same Deployment runs fine without the annotation. The mutating webhook
has clearly fired (the pod spec gains the OTel init container, the
`/etc/otel` mount, and the patched `LD_PRELOAD`-style environment
variables), but the actual instrumentation files are not present at
runtime.

## Root Cause

The OpenTelemetry mutating webhook injects the instrumentation by attaching
an `emptyDir` volume to the pod and copying the prebuilt Apache module into
it from an init container. The runtime container is then expected to mount
that same `emptyDir` and load the module from a known mount path.

When the application Deployment already declares custom `volumeMounts` for
the application's own configuration (`/etc/httpd/conf.modules.d/...`,
`/var/www/html`, an Apache module ConfigMap, an HTML asset ConfigMap), the
webhook patches the pod spec but the resulting set of mounts collides — the
webhook's `emptyDir` is not present at the path the instrumented binary
expects, or it is shadowed by the application's own mount, and the file the
loader is looking for is `No such file or directory`.

The class of issue is generic to any auto-instrumentation that injects a
sidecar volume into pods that already manage their own volumes: the
webhook's added volume must coexist with the application's existing mounts,
and the instrumentation's expected path must be left undisturbed.

## Resolution

Pre-declare the instrumentation `emptyDir` and a non-conflicting mount path
in the Deployment's pod spec. By declaring the volume yourself you make sure
it is present, named consistently, and mounted at a path that does not
overlap any application config mount.

Add an `emptyDir` volume named `otel-instrumentation-fix` and mount it at a
path the application container does not otherwise touch (a path under
`/tmp` is a safe choice):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http
spec:
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-apache-httpd: "apache"
    spec:
      containers:
        - name: container
          image: example.io/httpd-2.4:instrumented
          volumeMounts:
            - mountPath: /etc/httpd/conf.modules.d/mod_http2.conf
              name: modhttp2
              subPath: mod_http2.conf
            - mountPath: /var/www/html
              name: apacheindex
            - mountPath: /tmp/.otel-instr-fix
              name: otel-instrumentation-fix
      volumes:
        - configMap:
            defaultMode: 420
            name: modhttp2
          name: modhttp2
        - configMap:
            defaultMode: 420
            name: apacheindex
          name: apacheindex
        - emptyDir: {}
          name: otel-instrumentation-fix
```

Two things matter:

1. The `mountPath` of the new entry (`/tmp/.otel-instr-fix` here) must not
   collide with anything the application container or its existing mounts
   already write to.
2. The `volumes` block must list the matching `emptyDir`. The webhook will
   then be able to add the OTel module files into a stable, known volume on
   the pod and the runtime container will find them where it expects.

After the Deployment is rolled out the auto-instrumentation init container
populates the volume and the application container starts cleanly with
tracing wired in.

## Diagnostic Steps

1. Confirm the webhook fired. Inspect the rendered pod spec and look for
   the OTel init container, the `LD_PRELOAD`-style environment variables,
   and the OTel-injected volumes:

   ```bash
   kubectl get pod <pod> -n <ns> -o yaml | yq '.spec'
   ```

2. Confirm the `volumeMounts` order in the runtime container does not
   shadow the OTel-injected mount path. A common failure is one of the
   ConfigMap mounts being rooted at `/`, `/etc`, or `/var` and burying the
   webhook's mount.

3. Tail the init container's logs. The init container reports success or
   failure of the module copy:

   ```bash
   kubectl logs <pod> -n <ns> -c <otel-init-container>
   ```

4. Exec into the runtime container after start (or use an ephemeral debug
   container) and confirm the instrumentation file is present at the path
   the loader expects:

   ```bash
   kubectl exec -n <ns> <pod> -- ls -l /tmp/.otel-instr-fix
   ```

   Empty or missing — the volume did not get populated; the webhook is
   misconfigured or the declared `emptyDir` name does not match what the
   webhook expects.

5. If the application crashes early, isolate by removing the OTel
   annotation; if the pod runs cleanly without it, the failure is in the
   instrumentation injection wiring and the volume/mount template above is
   the right corrective action.
