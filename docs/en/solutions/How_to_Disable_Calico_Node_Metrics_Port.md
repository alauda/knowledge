---
kind:
   - How To
products:
  - Alauda Container Platform
ProductsVersion:
   - 3.16,3.18,4.0,4.1,4.2
id: KB251200002
---

# Disable Calico Node Metrics Port

## Issue

In Calico-based Kubernetes clusters, the `calico-node` DaemonSet exposes Felix metrics on TCP port `9091` on each node. The metrics endpoint is protected only by a self-signed TLS certificate and does not enforce authentication. In environments where this endpoint is not required, platform owners may want to fully disable it and close port `9091` on all nodes for security and compliance reasons.

This document describes how to disable Felix Prometheus metrics on `calico-node` and close port `9091`.

## Environment

* Kubernetes cluster using Calico as the CNI plugin.
* `calico-node` deployed as a DaemonSet in the `kube-system` namespace.
* Felix Prometheus metrics currently enabled via the `FELIX_PROMETHEUSMETRICSENABLED` environment variable.

The procedure is generic and applies to environments where `calico-node` exposes Felix metrics on port `9091`.

## Resolution

Follow the steps below to disable Felix Prometheus metrics and close port `9091`.

:::warning
Updating the `calico-node` DaemonSet will cause the pods to restart. This may temporarily disrupt container networking. Plan a maintenance window and proceed with caution.
:::

### Step 1: Disable Felix Prometheus metrics

Update the `calico-node` DaemonSet to set `FELIX_PROMETHEUSMETRICSENABLED=false`:

```bash
kubectl -n kube-system set env ds/calico-node -c calico-node FELIX_PROMETHEUSMETRICSENABLED=false
```

This command updates the environment variable on the `calico-node` container and triggers a rolling restart of the DaemonSet.

### Step 2: Wait for the rolling restart to complete

Monitor the rollout status of the `calico-node` DaemonSet and wait until it completes successfully:

```bash
kubectl -n kube-system rollout status ds/calico-node
```

Only proceed once the command reports that the rollout has completed.

### Step 3: Verify that port 9091 is closed

After the rollout finishes, verify that Felix metrics are no longer exposed on port `9091`.

Examples (choose a method that fits your environment and security policies):

1. **From a node hosting `calico-node`**

   * Use `ss` or `netstat` to confirm that nothing is listening on `:9091`:

     ```bash
     ss -lntp | grep ':9091[[:space:]]\+' || echo "port 9091 is not listening"
     ```

2. **From within the cluster**

   * From a debug pod that previously could access the metrics endpoint, run:

     ```bash
     curl -k https://<node-ip>:9091/metrics || echo "metrics endpoint not reachable"
     ```

   * The metrics endpoint should no longer be reachable.

Once verified, Felix metrics on port `9091` are disabled cluster-wide.

## Root Cause

By default (or per prior configuration), `calico-node` is configured with `FELIX_PROMETHEUSMETRICSENABLED=true`, which causes Felix to expose Prometheus metrics on TCP port `9091` on each node. The endpoint is secured only by a self-signed TLS certificate and does not implement authentication. In environments where this endpoint is not needed, leaving it enabled unnecessarily exposes an additional open port on every node.

Disabling `FELIX_PROMETHEUSMETRICSENABLED` removes the metrics listener and closes port `9091`.

## Diagnostic Steps

Use the following steps to determine whether this solution applies to your environment and to confirm current configuration.

### 1. Check `calico-node` configuration

Verify whether Felix Prometheus metrics are enabled:

```bash
kubectl -n kube-system get ds calico-node -o yaml | grep -A3 FELIX_PROMETHEUSMETRICSENABLED
```

If the value is `true` or the variable is not explicitly set (and metrics are known to be enabled by default in your build), this solution is applicable.

### 2. Confirm port 9091 is listening

On a node that runs `calico-node`, check for a listener on port `9091`:

```bash
ss -lntp | grep ':9091[[:space:]]\+'
```

If a process associated with `calico-node` or Felix is listening on `:9091`, the metrics endpoint is active.

### 3. Confirm endpoint reachability (optional)

From a pod with network access to node IPs, attempt to reach the metrics endpoint:

```bash
curl -k https://<node-ip>:9091/metrics
```

If you receive metrics output, Felix Prometheus metrics are enabled and exposed via port `9091`. In this case, you can apply the **Resolution** steps to disable the endpoint and close the port.
