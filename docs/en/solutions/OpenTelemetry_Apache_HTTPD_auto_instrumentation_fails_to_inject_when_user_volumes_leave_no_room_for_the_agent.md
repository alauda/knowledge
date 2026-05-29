---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OpenTelemetry Apache HTTPD auto-instrumentation fails to inject when user volumes leave no room for the agent

## Issue

On Alauda Container Platform (Kubernetes v1.34.5), the Alauda Build of OpenTelemetry installs a pod-mutating admission webhook that wires in an Apache HTTPD auto-instrumentation init container plus its supporting volumes whenever a pod template carries the `instrumentation.opentelemetry.io/inject-apache-httpd: <Instrumentation-name>` annotation. The injected pod ends up with an init container that prepares the OTel Apache agent files into a shared `emptyDir`, plus `volumeMounts` on the application container so the Apache process loads those files at startup.

When a user's Deployment already declares `volumes` and `volumeMounts` whose paths or names conflict with — or leave no room for — the volumes the OTel webhook needs to add, the merged pod ends up in a layout where the Apache agent files are not present at the locations the Apache process expects. The Apache HTTPD container then fails to start (or fails to load its OTel agent module) with the error message `No such file or directory`.

## Environment

- Alauda Container Platform, Kubernetes v1.34.5
- Alauda Build of OpenTelemetry v2 (`opentelemetry-operator2.v0.147.0-r0`, image `build-harbor.alauda.cn/asm/opentelemetry-operator2:0.147.0-r0`), CSV `Succeeded`, controller pod `Running` in namespace `opentelemetry-operator2`
- Pod-CREATE mutating webhook `mpod.kb.io` registered at service path `/mutate-v1-pod` with `failurePolicy=Ignore`
- CRDs `instrumentations.opentelemetry.io` (v1alpha1, with `spec.apacheHttpd.{attrs, configPath, env, image, resourceRequirements, version, volumeClaimTemplate, volumeLimitSize}`), `opentelemetrycollectors.opentelemetry.io`, `opampbridges.opentelemetry.io`, `targetallocators.opentelemetry.io`

## Root Cause

The volume merge that happens at admission time runs the user-declared volumes and the OTel webhook's injected agent volumes through the same pod spec. If the user's layout occupies — or fails to leave room for — the slots the injector needs (notably the shared `emptyDir` it uses to stage the Apache agent files into the application container at `/opt/opentelemetry-webserver/agent`, and the generated `httpd.conf` snippet directory at `/usr/local/apache2/conf`), the resulting injected pod has a layout in which the agent files are not present at the locations the Apache process expects. The Apache process at startup then cannot find those expected files and emits `No such file or directory`.

## Diagnostic Steps

Confirm the OpenTelemetry pod-mutating webhook is live on the cluster — the inject path runs through this webhook:

```bash
kubectl get mutatingwebhookconfiguration -o json |
  jq -r '.items[].webhooks[] | select(.name=="mpod.kb.io") |
    "\(.name) | \(.clientConfig.service.namespace)/\(.clientConfig.service.name)\(.clientConfig.service.path) | failurePolicy=\(.failurePolicy)"'
```

On a working cluster this lists `mpod.kb.io` pointing at the `opentelemetry-operator-controller-manager-service` in the operator's namespace with path `/mutate-v1-pod`.

Confirm the Instrumentation CRD's `apacheHttpd` branch is registered (this is the input the injector reads when the annotation is applied):

```bash
kubectl explain instrumentation.spec.apacheHttpd
```

The reported fields are `attrs`, `configPath`, `env`, `image`, `resourceRequirements`, `version`, `volumeClaimTemplate`, `volumeLimitSize`.

Inspect the live merged pod spec to see whether the webhook actually injected its init containers and volumes. A working injection adds two init containers (`otel-agent-source-container-clone`, `otel-agent-attach-apache`) and two volumes (`otel-apache-conf-dir`, `otel-apache-agent`), with the main container mounting `otel-apache-agent` at `/opt/opentelemetry-webserver/agent` and `otel-apache-conf-dir` at `/usr/local/apache2/conf`:

```bash
kubectl get pod -n <ns> <pod> -o jsonpath='
init: {.spec.initContainers[*].name}{"\n"}
volumes: {range .spec.volumes[*]}{.name}{","}{end}{"\n"}
mounts:  {range .spec.containers[0].volumeMounts[*]}{.name}:{.mountPath}{","}{end}{"\n"}'
```

If those four names are absent from the merged spec, the webhook did not inject — confirm the `Instrumentation` CR named in the annotation exists in the pod's namespace and that the pod template carries the literal annotation `instrumentation.opentelemetry.io/inject-apache-httpd: <Instrumentation-name>`.

## Resolution

Add a non-conflicting `volumeMount` path (e.g. `/tmp/.otel-instr-fix`) backed by a new `emptyDir` volume to the user's Deployment. This gives the OTel mutating webhook the headroom it needs to complete the Apache HTTPD instrumentation preparation steps so the merged layout is consistent. After the mitigation, the Apache HTTPD container no longer emits `No such file or directory` on startup and the OTel auto-instrumentation injection succeeds.

First, ensure the `Instrumentation` CR for Apache HTTPD exists in the workload's namespace. The `apacheHttpd` block selects the agent image and the in-container Apache configuration directory:

```yaml
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: apache-instrumented
spec:
  exporter:
    endpoint: http://otel-collector:4317
  apacheHttpd:
    image: registry.alauda.cn:60080/3rdparty/otel/instrumentation-apache-httpd:1.0.4
    configPath: /usr/local/apache2/conf
  propagators:
    - tracecontext
    - baggage
```

A user Deployment that fails with `No such file or directory` typically looks like the following — the user has declared their own `modhttp2`/`apacheindex` volumes and mounts but has not left room for the OTel agent files:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http
spec:
  replicas: 1
  selector:
    matchLabels:
      app: http
  template:
    metadata:
      annotations:
        instrumentation.opentelemetry.io/inject-apache-httpd: "apache-instrumented"
      labels:
        app: http
    spec:
      containers:
        - image: <your-apache-image>
          imagePullPolicy: IfNotPresent
          name: container
          ports:
            - containerPort: 8080
              protocol: TCP
          volumeMounts:
            - mountPath: /etc/httpd/conf.modules.d/mod_http2.conf
              name: modhttp2
              subPath: mod_http2.conf
            - mountPath: /var/www/html
              name: apacheindex
      volumes:
        - configMap:
            defaultMode: 420
            name: modhttp2
          name: modhttp2
        - configMap:
            defaultMode: 420
            name: apacheindex
          name: apacheindex
```

Extend the Deployment's `volumes` and `volumeMounts` with the extra emptyDir (`(1)` is a non-existing, non-conflicting mount path; `(2)` is the backing `emptyDir`) so the mutating webhook can lay down the Apache HTTPD instrumentation preparation it needs:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: http
spec:
  template:
    spec:
      containers:
        - image: <your-apache-image>
          volumeMounts:
            - mountPath: /etc/httpd/conf.modules.d/mod_http2.conf
              name: modhttp2
              subPath: mod_http2.conf
            - mountPath: /var/www/html
              name: apacheindex
            - mountPath: /tmp/.otel-instr-fix          # (1)
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
        - emptyDir: {}                                 # (2)
          name: otel-instrumentation-fix
```

After applying the updated Deployment, re-inspect the merged pod spec with the `kubectl get pod ... -o jsonpath` command above; the post-admission pod should now carry the user's `modhttp2`, `apacheindex`, and `otel-instrumentation-fix` volumes alongside the webhook-injected `otel-apache-conf-dir` and `otel-apache-agent` volumes, with the OTel init containers in place.

## Notes and Caveats

- The underlying behaviour — the volume-merge interaction between user-supplied `volumes`/`volumeMounts` and the webhook-added agent volumes — is the upstream OpenTelemetry Operator inject path; this mitigation applies until a newer Alauda Build of OpenTelemetry release tolerates arbitrary user volume layouts in the source Deployment natively. Whether your specific operator version still requires the mitigation should be checked against the release notes for the operator build you have installed.
- The mutating webhook's `failurePolicy` is `Ignore`; if the webhook is unreachable, pods are admitted without the injection rather than rejected. If you expect injection but the post-admission pod is missing the OTel init containers and agent volumes, verify that the operator pod is `Running` and that the `Instrumentation` CR referenced by the annotation exists in the same namespace as the workload.
