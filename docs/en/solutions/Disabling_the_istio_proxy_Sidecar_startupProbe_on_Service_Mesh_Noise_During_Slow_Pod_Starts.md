---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Workloads with the istio-proxy sidecar injected occasionally take several extra seconds to reach `Ready` and emit noisy events about probe failure:

```text
Events:
  Warning  Unhealthy  5s (x3 over 30s)  kubelet  Startup probe failed: HTTP probe failed with statuscode: 503
```

The Mesh data-plane itself is healthy — the workload pod does eventually come ready — but during slow-start windows the probe fails repeatedly and emits events. On large clusters this produces thousands of events per hour and obscures real problems.

The `ServiceMeshControlPlane` (SMCP) CR surfaces a direct knob for the sidecar `readinessProbe` but not for the `startupProbe`, so the operator-expected way of tuning does not work.

## Root Cause

Newer sidecar-injection templates add a `startupProbe` to the istio-proxy container. The probe guards the container against being flagged ready before the proxy has fully loaded configuration (xDS) from the Mesh control plane. The default values — often `initialDelaySeconds: 0`, `periodSeconds: 1`, `failureThreshold: 10` — are tuned for a fast control-plane response. On clusters where:

- The control plane is busy (many namespaces, many subscribers, many routes), or
- The node is CPU-constrained during bulk pod creation (rolling upgrades, cluster startup), or
- The sidecar image pull takes longer than the probe's `failureThreshold × periodSeconds` window,

the probe fails one or more times while the proxy is still legitimately initialising. Kubernetes restarts the container (because of a failed startup probe, not because of a readiness failure). The restart adds time, and the cycle can repeat until the proxy's xDS-config catch-up outpaces the probe attempts.

Unlike the `readinessProbe`, the startup probe's tuning values were not exposed in the SMCP CR's top-level `spec.proxy` schema at the time this sidecar change shipped. The workaround is to configure the probe via the SMCP's `techPreview` section, which passes arbitrary Helm values through to the sidecar injection template.

A note on `techPreview`: values placed there bypass the regular SMCP schema and are applied as-is. They are not covered by the normal operator support contract — use only when a supported direct setting is not available, and revert to the direct setting if it becomes available in a later release.

## Resolution

### Step 1 — confirm the probe is the source of the failure events

Describe an affected pod during its start window and filter for probe-related events:

```bash
NS=<workload-namespace>
POD=<a-slow-starting-pod>
kubectl -n "$NS" describe pod "$POD" | grep -A3 -E 'Warning.*Unhealthy|Startup probe'
```

A cluster hitting this issue shows `Startup probe failed` events with HTTP 503 or connection-refused, clustered within the first 15–30 seconds of the pod's lifetime.

Check the sidecar injection template shipped with your Mesh version to confirm the probe is in the template:

```bash
kubectl -n <smcp-namespace> get cm istio-sidecar-injector -o=yaml | \
  yq '.data."config"' | grep -A5 startupProbe
```

If the yaml contains a `startupProbe:` block on the istio-proxy container, the template is the source.

### Step 2 — disable the probe via the SMCP techPreview block

Edit the SMCP CR and add the `techPreview.global.proxy.startupProbe.enabled: false` override:

```bash
SMCP_NS=<smcp-namespace>
SMCP_NAME=<smcp-name>

kubectl -n "$SMCP_NS" patch servicemeshcontrolplane "$SMCP_NAME" --type=merge -p='
{
  "spec": {
    "techPreview": {
      "global": {
        "proxy": {
          "startupProbe": {
            "enabled": false
          }
        }
      }
    }
  }
}'
```

Wait for the SMCP operator to reconcile — the operator regenerates the sidecar-injection ConfigMap. On most installations this takes under a minute.

```bash
kubectl -n "$SMCP_NS" get smcp "$SMCP_NAME" -o=jsonpath='{.status.readiness.components}'
```

### Step 3 — restart any pod that still has the old sidecar template

The injection template applies at pod creation. Pods already running with the old sidecar keep the old probe until they are recreated. Roll affected workloads:

```bash
# Per Deployment:
kubectl -n "$NS" rollout restart deployment <name>

# Or cluster-wide for every workload in the Mesh:
kubectl get ns -o=jsonpath='{range .items[?(@.metadata.labels.maistra\.io/member-of)]}{.metadata.name}{"\n"}{end}' | \
  xargs -I{} kubectl -n {} rollout restart deployment
```

(Replace the `member-of` label selector with whatever the Mesh uses to mark member namespaces on your distribution.)

### Step 4 — alternative: keep the probe but relax its timing

If you want to keep a start-up gate (for example, because the Mesh is legitimately slow enough that workloads have come ready before xDS was synced, causing request failures on the first request), override the timing instead of disabling:

```yaml
spec:
  techPreview:
    global:
      proxy:
        startupProbe:
          enabled: true
          # Raise the failure budget so slow xDS catches up:
          failureThreshold: 60
          periodSeconds: 2
```

Values shown target roughly 120 seconds before the kubelet gives up — a reasonable ceiling for even a busy Mesh control plane.

### Step 5 — optionally tune the readinessProbe at the same time

The readiness probe has a direct, supported knob on the SMCP. If its default timing is contributing to slow-start noise, tune it via the top-level `spec.proxy.runtime.readiness` block (not techPreview):

```bash
kubectl -n "$SMCP_NS" patch servicemeshcontrolplane "$SMCP_NAME" --type=merge -p='
{
  "spec": {
    "proxy": {
      "runtime": {
        "readiness": {
          "failureThreshold": 6,
          "initialDelaySeconds": 5,
          "periodSeconds": 2
        }
      }
    }
  }
}'
```

### Step 6 — confirm the change took effect

Verify that freshly-created pods in Mesh namespaces no longer have a `startupProbe` on the istio-proxy container:

```bash
# After a pod restart in an affected namespace:
kubectl -n "$NS" get pod "$POD" -o=jsonpath='{.spec.containers[?(@.name=="istio-proxy")].startupProbe}'
```

With the probe disabled, the field is empty. With the probe retained but retuned, the printed JSON shows the new values.

Watch for the absence of `Startup probe failed` events on new pods over a full workload rolling-deploy cycle.

## Diagnostic Steps

Reproduce by deploying a CPU-constrained pod in a Mesh namespace and watching the startup race:

```bash
kubectl -n "$NS" run slow-start --image=<your-sidecar-ready-image> --restart=Never -- \
  sh -c 'sleep 10; exec <workload-entrypoint>'
kubectl -n "$NS" describe pod slow-start | grep -A4 -E 'Startup probe|Events:'
```

A pod whose main container sleeps longer than the startup-probe budget will reliably hit the issue before Step 2 is applied, and will not hit it after.

Check the effective sidecar template:

```bash
kubectl -n "$SMCP_NS" get cm istio-sidecar-injector -o=yaml | \
  yq '.data."config"' | grep -A10 -E 'istio-proxy|startupProbe'
```

After Step 2 + Step 3, the template should no longer list a startupProbe for the istio-proxy container.

Finally, confirm the SMCP status has applied the techPreview values:

```bash
kubectl -n "$SMCP_NS" get smcp "$SMCP_NAME" -o=jsonpath='{.status.appliedValues.istio.global.proxy}' | jq
```

`startupProbe.enabled: false` should appear in the applied-values block, which is the Mesh-operator's record of what it actually rendered.

If the applied values do not reflect your patch, the SMCP controller has rejected the techPreview values — check the SMCP's `status.conditions` for a Rejected reason (often a typo in the Helm path).
