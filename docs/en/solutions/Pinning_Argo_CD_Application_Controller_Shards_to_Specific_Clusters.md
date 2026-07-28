---
title: Assigning clusters to specific application-controller shards in Argo CD
component: gitops
scenario: how-to
tags: [argocd, gitops, sharding, application-controller]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Assigning clusters to specific application-controller shards in Argo CD

## Issue

When the Argo CD application-controller runs with more than one replica, the controller distributes the managed clusters across the replicas automatically. There are situations where a specific cluster should be pinned to a chosen shard rather than relying on automatic distribution. This article describes the supported way to perform that manual assignment on Alauda Container Platform [ev:c1].

The Alauda Build of Argo CD on this platform bundles the upstream Argo CD Operator and the upstream Argo CD binary directly (operator image `build-harbor.alauda.cn/3rdparty/argoprojlabs/argocd-operator:v4.2.0-beta.3.gc879ad57` and Argo CD binary `build-harbor.alauda.cn/3rdparty/argoproj/argocd:v3.1.4-1`), so the cluster-Secret shape and the controller code path that reads the shard value are identical to the upstream project [ev:c1][ev:c3].

## Root Cause

By default the application-controller distributes clusters across its replicas using its own hashing logic. To override that distribution, a per-cluster shard value is read from the cluster Secret. The standard application-controller code path consults this value when assigning a cluster to a replica; setting it pins the cluster to the requested replica ordinal instead of letting the default distribution decide [ev:c3][ev:c4].

## Resolution

Manual shard assignment is only meaningful when sharding is enabled on the application-controller, which is controlled by the operator-managed ArgoCD custom resource. The relevant field path on the v1beta1 ArgoCD resource is `.spec.controller.sharding`, and the two knobs of interest are `enabled` (toggle the multi-replica application-controller) and `replicas` (set the desired replica count). At least one replica beyond the default is required before a per-cluster shard pin can be used [ev:c5]:

```yaml
apiVersion: argoproj.io/v1beta1
kind: ArgoCD
metadata:
  name: argocd-gitops
  namespace: argocd
spec:
  controller:
    sharding:
      enabled: true
      replicas: 2
```

Once sharding is enabled, the per-cluster shard value lives on the cluster Secret in the Argo CD instance namespace. Cluster Secrets are standard `core/v1` Secrets carrying the label `argocd.argoproj.io/secret-type=cluster`. The shard value is added as a string field; the convenient way to write it is through `stringData`, which the Kubernetes API server merges into `.data` on write (the at-rest value at `.data.shard` is the base64-encoded form of the integer string) [ev:c2][ev:c6]:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cluster1
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
type: Opaque
stringData:
  name: testcluster.com
  server: https://testcluster.example.com:6443
  config: |
    {"bearerToken":"<token>","tlsClientConfig":{"caData":"<ca-base64>"}}
  shard: "1"
```

Apply the Secret to the namespace where the ArgoCD custom resource lives (the default namespace for the Alauda Build of Argo CD is `argocd`). After applying, the cluster shifts from whichever replica auto-distribution had placed it on to the replica matching the requested shard ordinal [ev:c4].

## Diagnostic Steps

Confirm the application-controller is running with more than one replica before attempting a manual pin; otherwise the shard field has no destination to point at [ev:c5]:

```kubectl
kubectl --context lab-base explain argocds.spec.controller.sharding
```

Confirm the cluster Secret carries the expected label and the `shard` key. The Secret's `.data` is a `map[string]string` whose values are base64-encoded; reading the field back from `.data.shard` and decoding it yields the integer string that was written through `stringData` [ev:c2][ev:c6]:

```kubectl
kubectl --context lab-base get secret -n argocd <secret-name> \
  -o jsonpath='{.metadata.labels.argocd\.argoproj\.io/secret-type}{"\n"}{.data.shard}{"\n"}' \
  | { read label; read shard_b64; echo "label=$label"; echo "shard=$(echo "$shard_b64" | base64 -d)"; }
```

The Argo CD CRD versions installed by the Argo CD Operator package on this platform are `v1alpha1` and `v1beta1`; use `v1beta1` for new ArgoCD resources [ev:c1].
