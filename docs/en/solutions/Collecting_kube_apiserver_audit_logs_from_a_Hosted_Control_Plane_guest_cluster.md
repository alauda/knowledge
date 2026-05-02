---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

`kube-apiserver` audit logs for a Hosted Control Plane (HCP) guest cluster do not live on the guest's nodes. The control plane runs as a set of pods inside a dedicated namespace on the **management** cluster, so any tool that scrapes audit logs from the guest's nodes (`must-gather`-style helpers, node-filesystem grabs) returns empty output. The audit files are inside the running `kube-apiserver` pods on the management side, under `/var/log/kube-apiserver/`.

This article documents the supported retrieval path: identify the hosting namespace, pull the log file out of each `kube-apiserver` pod, and concatenate the results locally.

## Resolution

### Identify the hosting namespace

Each `HostedCluster` has its own control-plane namespace, conventionally named `clusters-<hostedcluster-name>`. Retrieve it from the `HostedCluster` resource on the management cluster:

```bash
HOSTED_NAME=<hostedcluster-name>
HOSTING_NS=$(kubectl get hostedcluster "$HOSTED_NAME" -A \
  -o jsonpath='{.items[0].status.kubeadminPassword.namespace}{"\n"}')
# Fallback to the convention if the status field isn't populated:
: "${HOSTING_NS:=clusters-${HOSTED_NAME}}"
```

The `kube-apiserver` `Deployment` runs in `$HOSTING_NS`; its pods are labelled `app=kube-apiserver`.

### Pull audit log files from every kube-apiserver pod

Each replica writes its own audit file. Iterate over the pods and stream `audit.log` out:

```bash
mkdir -p audit
kubectl get pods -n "$HOSTING_NS" -l app=kube-apiserver -o name | while read -r pod; do
  name=${pod##pod/}
  kubectl exec -n "$HOSTING_NS" "$pod" -c kube-apiserver -- \
    cat /var/log/kube-apiserver/audit.log > "audit/${name}.audit.log"
done
```

Concatenate into a single file if a downstream parser expects one stream:

```bash
cat audit/*.audit.log > audit_all.log
```

### Capturing rotated segments

The audit file is rotated by size or age depending on the apiserver flags configured by the HCP control plane. Rotated files are present in the same directory with a numeric suffix. Capture them in the same loop:

```bash
kubectl get pods -n "$HOSTING_NS" -l app=kube-apiserver -o name | while read -r pod; do
  name=${pod##pod/}
  kubectl exec -n "$HOSTING_NS" "$pod" -c kube-apiserver -- \
    sh -c 'cd /var/log/kube-apiserver && tar c audit.log* 2>/dev/null' \
    > "audit/${name}.tar"
done
```

Each per-pod tar holds the active log plus rotated segments still on disk at the time of capture.

### Long-term retention

The pod-local audit volume is sized to the HCP control plane's defaults; do not rely on it for long retention. For continuous capture, ship audit events into the platform's logging stack by configuring an audit policy and forwarding via the control-plane logging operator. The collector pods can be configured to read this same path through a sidecar or a host-path mount inside the hosting namespace.

## Diagnostic Steps

1. Confirm the `kube-apiserver` pods exist in the hosting namespace and are healthy:

   ```bash
   kubectl get pods -n "$HOSTING_NS" -l app=kube-apiserver -o wide
   ```

2. Verify the audit file is being written:

   ```bash
   kubectl exec -n "$HOSTING_NS" \
     $(kubectl get pods -n "$HOSTING_NS" -l app=kube-apiserver -o name | head -n 1) \
     -c kube-apiserver -- ls -lh /var/log/kube-apiserver/
   ```

3. If `audit.log` is empty or very small, confirm an audit policy is configured and not at `None`:

   ```bash
   kubectl get hostedcluster "$HOSTED_NAME" -A \
     -o jsonpath='{.items[0].spec.configuration.apiServer.audit}' | jq .
   ```

   The default profile (typically `Default`) writes metadata-level events; `None` disables audit entirely and explains an empty file.
