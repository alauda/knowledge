---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3'
id: TBD
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  Knative releases, only the slots fenced with `factory:auto:*` markers below are updated by
  the factory pipeline (version, supported versions, operand image tags, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# Alauda support for Knative — Installation Guide

## Overview

**Alauda support for Knative** is the Alauda Application Services (S2, certified) packaging of the
upstream CNCF Knative Operator, listed on the Alauda Cloud marketplace and installable from the ACP
OperatorHub.

Knative is a CNCF project that adds serverless building blocks to Kubernetes. It has two components:

- **Serving** — runs stateless, request-driven workloads with scale-to-zero, revision-based traffic
  splitting, and a pluggable ingress layer (Kourier / Istio / Contour).
- **Eventing** — delivers CloudEvents through Brokers, Triggers, Channels, and Sources.

On Alauda Container Platform (ACP), Knative is delivered as an OLM Operator that you install from the
Marketplace. The Operator manages the lifecycle of `KnativeServing` and `KnativeEventing` custom
resources. This guide describes how to install the Knative Operator from the ACP Marketplace, bring
up Knative Serving with the Kourier ingress, and validate a serverless `Service` end to end.

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3 |
| Architectures | amd64 (x86_64), arm64 |
| Knative Operator (bundle) | v1.22.1 |
| Knative Serving / Eventing operands | v1.22.0 |
| Upstream bundle | `quay.io/operatorhubio/knative-operator:v1.22.1` |
<!-- factory:auto:supported-versions END -->

> **Networking requirement:** this release supports IPv4 and IPv4-primary dual-stack clusters only.
> See [Known Limitations](#known-limitations) for single-stack IPv6.

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to the target
  workload cluster.
- The **Knative Operator** plugin available in your cluster's OperatorHub. If it is not yet uploaded,
  an administrator can push it with the `violet` CLI:
  ```bash
  violet push knative-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.
- Cluster networking is IPv4 or IPv4-primary dual-stack (see [Known Limitations](#known-limitations)).

## Install the Knative Operator

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target cluster,
   find **Knative Operator**, and click **Install**.
2. Keep the default channel (`alpha`) and namespace, and confirm the installation.

### Verify the Operator

```bash
kubectl -n operators get csv | grep knative-operator
kubectl -n operators get deploy knative-operator
```

Expected: the CSV `knative-operator.v<version>` reaches phase `Succeeded`, and the
`knative-operator` Deployment shows `1/1` ready.

## Quick Start: Deploy a Serverless Service with Knative Serving

### 1. Create the KnativeServing instance

Knative Serving is a cluster singleton. Two ACP-specific rules apply:

- **It must be created in the `knative-serving` namespace** when using Kourier — the Operator's
  kourier-bootstrap ConfigMap hardcodes the xDS address `net-kourier-controller.knative-serving`.
- **You must set `spec.registry.override`** to rewrite the data-plane images to *tag* form. The
  Operator's embedded manifest references operands by digest, and the platform image allowlist cannot
  rewrite digest references — so on air-gapped clusters the pods would fail to pull. The
  `queue-proxy` sidecar comes from `config-deployment` and is set separately.

```yaml
apiVersion: operator.knative.dev/v1beta1
kind: KnativeServing
metadata:
  name: knative-serving
  namespace: knative-serving
spec:
  registry:
    override:
      # factory:auto:install-images BEGIN  (operand tag == operator's embedded serving version)
      activator: gcr.io/knative-releases/knative.dev/serving/cmd/activator:v1.22.0
      autoscaler: gcr.io/knative-releases/knative.dev/serving/cmd/autoscaler:v1.22.0
      autoscaler-hpa: gcr.io/knative-releases/knative.dev/serving/cmd/autoscaler-hpa:v1.22.0
      controller: gcr.io/knative-releases/knative.dev/serving/cmd/controller:v1.22.0
      webhook: gcr.io/knative-releases/knative.dev/serving/cmd/webhook:v1.22.0
      queue-proxy: gcr.io/knative-releases/knative.dev/serving/cmd/queue:v1.22.0
      net-kourier-controller/controller: gcr.io/knative-releases/knative.dev/net-kourier/cmd/kourier:v1.22.0
      # factory:auto:install-images END
  ingress:
    kourier:
      enabled: true
  config:
    network:
      ingress-class: "kourier.ingress.networking.knative.dev"
    deployment:
      # queue-proxy sidecar image comes from config-deployment; registry.override does not cover it
      queue-sidecar-image: gcr.io/knative-releases/knative.dev/serving/cmd/queue:v1.22.0
```

```bash
kubectl create namespace knative-serving --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f knative-serving.yaml
```

### 2. Wait for KnativeServing to become Ready

```bash
kubectl get knativeserving knative-serving -n knative-serving \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
kubectl get pods -n knative-serving
```

Expected: `Ready` is `True`, and the core Deployments (`activator`, `autoscaler`, `controller`,
`webhook`, `net-kourier-controller`, `3scale-kourier-gateway`) are all Running.

### 3. Deploy a sample Knative Service

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hello
  namespace: default
spec:
  template:
    spec:
      containers:
        - image: gcr.io/knative-samples/helloworld-go
          ports:
            - containerPort: 8080
          env:
            - name: TARGET
              value: "Knative on ACP"
```

```bash
kubectl apply -f hello.yaml
```

### 4. Verify the Service is serving

```bash
kubectl get ksvc hello -n default
# READY should be True and URL populated, e.g. http://hello.default.<domain>
URL=$(kubectl get ksvc hello -n default -o jsonpath='{.status.url}')
curl -s "$URL"
# -> Hello Knative on ACP!
```

## Enabling Eventing (optional)

Create a `KnativeEventing` instance in the `knative-eventing` namespace, applying the same
`spec.registry.override` pattern to the eventing images (controller, webhook, broker filter/ingress,
in-memory channel, mtping, jobsink) pinned to the operand version. See the
[upstream Eventing docs](https://knative.dev/docs/eventing/) for Broker/Trigger configuration.

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **Single-stack IPv6 / IPv6-primary dual-stack clusters are not supported in this release.** The
  Serving `autoscaler` enters `CrashLoopBackOff`: upstream's stat-forwarder hardcodes the bucket-lease
  `EndpointSlice` `AddressType` to IPv4 (`pkg/autoscaler/statforwarder/leases.go`), so on an IPv6 pod
  IP the API server rejects it (`endpoints[0].addresses ... must be an IPv4 address`) and
  `KnativeServing` never becomes `Ready`. Fixed upstream on `main`
  ([knative/serving#16591](https://github.com/knative/serving/pull/16591)) but not yet included in a
  released 1.22.x. This plugin follows the community release stream, so the limitation clears once a
  Knative release containing the fix is published. Until then, use IPv4 or IPv4-primary dual-stack
  clusters.
- The install path validated for this release covers **Serving with Kourier**; Eventing and non-Kourier
  ingress (Istio / Contour) are installed by the user per the upstream documentation.
<!-- factory:auto:known-limitations END -->

## Cleanup

```bash
kubectl delete ksvc hello -n default
kubectl delete knativeserving knative-serving -n knative-serving
kubectl delete namespace knative-serving
# Uninstall the Operator from Administrator > Marketplace > OperatorHub (or delete its Subscription/CSV)
kubectl -n operators delete subscription knative-operator
kubectl -n operators delete csv -l operators.coreos.com/knative-operator.operators
```

## FAQ

**Q: The `autoscaler` pod is in `CrashLoopBackOff` and `KnativeServing` never becomes Ready.**
Check the cluster's IP family: `kubectl get pod <autoscaler-pod> -n knative-serving -o jsonpath='{.status.podIPs}'`.
If the pod IP is IPv6, you are hitting the single-stack-IPv6 limitation above — use an IPv4 or
IPv4-primary dual-stack cluster until a Knative release containing the upstream fix is available.

**Q: Serving pods are stuck in `ImagePullBackOff`.**
Ensure `spec.registry.override` is present on the `KnativeServing` CR (and `queue-sidecar-image` under
`config.deployment`). Without it the Operator deploys operands by digest, which the platform image
allowlist cannot rewrite, so air-gapped clusters cannot pull them.

**Q: The Kourier gateway never becomes Ready.**
`KnativeServing` must be created in the `knative-serving` namespace — the kourier-bootstrap ConfigMap
hardcodes `net-kourier-controller.knative-serving`. Other namespaces will not converge.

**Q: How do I upgrade Knative?**
Upgrade the Operator to the new version from the Marketplace; it reconciles `KnativeServing` /
`KnativeEventing` to the matching operand version. Update the image tags in `spec.registry.override`
to the new operand version to keep them pinned.
