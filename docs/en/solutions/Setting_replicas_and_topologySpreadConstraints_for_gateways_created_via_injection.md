---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The mesh's *gateway injection* flow lets you stand up an Istio Gateway by labelling a Deployment with `istio.io/gateway-name=<name>` and letting the injector materialise the proxy container, the listener, and the wiring. The shape is convenient — one label, no helm chart per gateway — but operators quickly run into the question of how to set fleet-wide defaults: minimum replica count, topology spread across zones, pod anti-affinity, etc., on **every** gateway that the injection produces, without editing each Deployment by hand.

The mesh exposes a per-class defaults mechanism, but it only takes effect when the ConfigMap that carries the defaults is itself labelled correctly. A defaults ConfigMap created in the mesh control-plane namespace without the right label is silently ignored — the visible symptom is that operators add `replicas: 3` and `topologySpreadConstraints` to a defaults ConfigMap, expect new gateways to inherit them, and see freshly-injected gateways come up with a single replica and no spread.

## Root Cause

The Istio gateway-injection controller looks up gateway-class defaults by reading ConfigMaps in the control-plane namespace that carry a specific label:

```text
gateway.istio.io/defaults-for-class: istio
```

The label tells the controller *"this ConfigMap defines defaults for the `istio` gateway class — apply its `data` to every Deployment created for a gateway of that class."* Without the label, the ConfigMap is just a ConfigMap in the namespace; nothing wires it to gateway injection, and the resulting Deployments fall back to the controller's hard-coded defaults (one replica, no topology spread).

The mistake is therefore not in the ConfigMap's `data:` (which can be a perfectly correct override block), but in its `metadata.labels` (where the wiring label is missing). Adding the label is the entire fix.

## Resolution

Create or patch the defaults ConfigMap with the `gateway.istio.io/defaults-for-class: istio` label, and put the desired Deployment overrides under `data.deployment`. The controller merges that block into the Deployment template it generates for every gateway of the targeted class.

### Example — three replicas, zonal spread

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: gateway-class-defaults
  namespace: istio-system          # or whatever the mesh control-plane namespace is
  labels:
    gateway.istio.io/defaults-for-class: istio
data:
  deployment: |
    spec:
      replicas: 3
      template:
        spec:
          topologySpreadConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: ScheduleAnyway
              labelSelector:
                matchLabels:
                  istio.io/gateway-name: ""    # placeholder, the controller fills it in
          affinity:
            podAntiAffinity:
              preferredDuringSchedulingIgnoredDuringExecution:
                - weight: 100
                  podAffinityTerm:
                    topologyKey: kubernetes.io/hostname
                    labelSelector:
                      matchLabels:
                        istio.io/gateway-name: ""
```

Apply with `kubectl apply -f gateway-class-defaults.yaml`. The next gateway created with `istio.io/gateway-name=<name>` (or via a Gateway CR for the corresponding GatewayClass) inherits all three replicas, the zone spread, and the soft anti-affinity. Existing gateway Deployments are not retroactively rewritten — delete and re-create them to pick up the new defaults, or patch them once by hand.

### Per-class scoping

`defaults-for-class: istio` covers gateways of the `istio` class. If your cluster uses multiple gateway classes (`istio-east`, `istio-internal`, etc.), make one ConfigMap per class and label it accordingly. The matching is exact — `defaults-for-class: istio-east` does not also apply to `istio`.

### What you can put in `data.deployment`

The block is a Deployment patch; the controller merges it on top of its own template. Common fields users set there:

- `spec.replicas` — minimum replica count for HA.
- `spec.template.spec.topologySpreadConstraints` — zonal/host spread.
- `spec.template.spec.affinity` — anti-affinity to keep gateway pods on different nodes.
- `spec.template.spec.priorityClassName` — keep gateways above general workloads.
- `spec.template.spec.tolerations` — schedule onto dedicated gateway nodes.
- `spec.template.spec.containers[*].resources` — bigger requests/limits for the proxy container.

Other ConfigMap keys the injection controller reads (`service`, `pdb`, `hpa`, etc., depending on version) follow the same pattern: a ConfigMap with the `defaults-for-class` label, with each key carrying a YAML patch for the corresponding object.

## Diagnostic Steps

1. List the ConfigMaps in the mesh control-plane namespace and look for the one that *should* be the defaults — confirm whether the label is actually present:

   ```bash
   kubectl get cm -n istio-system -L gateway.istio.io/defaults-for-class
   ```

   Each row prints the value of the label (or empty). The defaults ConfigMap must show `istio` (or your class name) in the rightmost column.

2. If the label is missing, patch it on:

   ```bash
   kubectl label cm -n istio-system <cm-name> \
     gateway.istio.io/defaults-for-class=istio
   ```

3. Take a fresh gateway Deployment and confirm the defaults landed. The Deployment's pod template should reflect the override block:

   ```bash
   kubectl get deploy -n <ns> <gw-deploy> \
     -o yaml | yq '{ replicas: .spec.replicas,
                     spread: .spec.template.spec.topologySpreadConstraints }'
   ```

4. If the label is present but the defaults still do not flow to new gateways, look at the gateway-injection controller's logs — it logs which defaults ConfigMaps it picked up at start and on each ConfigMap event:

   ```bash
   kubectl logs -n istio-system <istiod-or-gateway-controller-pod> \
     | grep -E 'defaults-for-class|GatewayClass'
   ```

   Stale defaults that the controller cached at start-up are released on a controller restart; bouncing the deployment is the fastest way to make sure the new ConfigMap is read.
