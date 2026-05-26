---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
---

# Cross-namespace ConfigMap and Secret references in Pod specs on ACP

## Overview

On Alauda Container Platform (kube v1.34.5), `ConfigMap` and `Secret` are namespace-scoped core/v1 resources — `kubectl api-resources` reports `NAMESPACED=true` for both kinds, so each object lives in exactly one namespace [ev:c1]. The PodSpec reference fields that consume them carry no `namespace` selector: `kubectl explain pod.spec.volumes.configMap` and `pod.spec.volumes.secret` list `{defaultMode, items, name, optional}` and `{defaultMode, items, optional, secretName}` respectively, and the `secretName` description states verbatim that it is the "name of the secret in the pod's namespace to use"; the env-injection shapes `envFrom.configMapRef` / `envFrom.secretRef` and the keyed `valueFrom.configMapKeyRef` / `valueFrom.secretKeyRef` likewise expose only `{name, optional}` (plus `key` on the keyRef variants), with no namespace field [ev:c2]. The standard upstream PodSpec therefore cannot, by schema, point at a ConfigMap or Secret outside the Pod's own namespace.

## Root Cause

The standard upstream `ContainerStateWaiting` shape carries `{reason, message}` fields — `kubectl explain pod.status.containerStatuses.state.waiting` enumerates exactly that pair, and the kubelet uses them to surface a `CreateContainerConfigError` reason together with a `not found` message identifying the unresolvable referent when the container configuration step cannot find a referenced ConfigMap or Secret in the Pod's namespace [ev:c3]. Because the reference fields hold only a bare name resolved against the Pod's namespace, naming a ConfigMap or Secret that exists only in some other namespace yields the same outcome as naming one that does not exist at all.

## Resolution

There is no built-in cross-namespace reference for ConfigMaps or Secrets via the standard volume, `envFrom`, or `valueFrom` paths — the schema does not expose one. To make a configuration or secret value available to Pods in multiple namespaces, create a copy of the ConfigMap or Secret in each namespace where a consuming Pod runs, and have each Pod reference its local copy by name [ev:c5]. This per-namespace-copy pattern is already the upstream norm on this cluster: a cluster-wide listing shows the same name `kube-root-ca.crt` present as an independent ConfigMap in many namespaces (`acp-storage`, `argocd`, `cert-manager`, and more), one copy per namespace [ev:c5].

When the same data must stay in sync across namespaces over time, drive the copies from a single source of truth so the per-namespace objects stay aligned as the source changes. The PodSpec reference shape itself remains unchanged: each consuming Pod still references a ConfigMap or Secret living in its own namespace [ev:c5].

```yaml
# Same ConfigMap, copied into each consuming namespace.
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: team-a
data:
  app.properties: |
    log.level=info
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: team-b
data:
  app.properties: |
    log.level=info
```

## Diagnostic Steps

When a Pod stays out of `Running` and its container reports `CreateContainerConfigError`, the kubelet records the missing-reference detail as a Pod event aggregated under `kubectl describe pod` — the core/v1 `Event` resource is present on this cluster (`kubectl api-resources` lists it as a kubectl-visible, namespaced kind), so the container's waiting `reason` / `message` and the surrounding `Events:` block are where the missing-referent detail surfaces; expect a `not found` indication naming the ConfigMap or Secret the kubelet could not resolve in the Pod's namespace [ev:c4_a].

```bash
kubectl get pod -n <pod-ns> <pod>
kubectl describe pod -n <pod-ns> <pod>
```

To confirm the referent is absent from the Pod's own namespace, query it directly. A namespaced GET against a missing object returns `Error from server (NotFound): configmaps "<name>" not found` (or `secrets "<name>" not found`) with a non-zero exit code, confirming the Pod's namespace does not hold the referenced resource [ev:c4_b].

```bash
kubectl get configmap -n <pod-ns> <name>
kubectl get secret    -n <pod-ns> <name>
```

To distinguish a typo from a same-named object created in the wrong namespace, list cluster-wide and filter by name. On this cluster `kubectl get configmaps --all-namespaces` surfaces the same name across many namespaces in the `kube-root-ca.crt` case, demonstrating the "same name, different namespace" shape this diagnostic relies on [ev:c4_c].

```bash
kubectl get configmaps --all-namespaces | grep <name>
kubectl get secrets    --all-namespaces | grep <name>
```

A hit in a namespace other than the Pod's confirms the resource exists but is not reachable from the Pod by the standard reference fields — the resolution is to create a copy in the Pod's namespace rather than to attempt a cross-namespace reference [ev:c5].
