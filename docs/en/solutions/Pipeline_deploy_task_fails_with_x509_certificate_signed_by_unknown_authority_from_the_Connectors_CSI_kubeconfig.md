---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion: []
---

# Pipeline deploy task fails with x509 certificate signed by unknown authority from the Connectors CSI kubeconfig

## Issue

A Tekton pipeline task that updates a workload with `kubectl apply` (for example a `workload-apply` task that renders a Deployment and applies it) fails in its `apply` step. The task uses the kubeconfig mounted into the workspace:

```text
==> Using kubeconfig from workspace: /workspace/kubeconfig/kubeconfig
error: error validating "/shared/rendered.yaml": error validating data: failed to download openapi: Get "https://<platform-address>/kubernetes/<cluster>/openapi/v2?timeout=32s": tls: failed to verify certificate: x509: certificate signed by unknown authority; if you choose to ignore these errors, turn validation off with --validate=false
==> Apply failed, continue to finalize flow
```

The following steps then fail and the PipelineRun ends as failed. The same pipeline worked before, and the platform address itself is reachable with a trusted certificate from other clients.

The same step can instead fail with an expired certificate on the same platform path, while the browser still shows a valid certificate for the platform address:

```text
error: error validating "/shared/rendered.yaml": error validating data: failed to download openapi: Get "https://<platform-address>/kubernetes/<cluster>/openapi/v2?timeout=32s": tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time <now> is after <notAfter>; if you choose to ignore these errors, turn validation off with --validate=false
```

## Root Cause

### Cause 1: the Connectors CSI component keeps a certificate it loaded at startup

When a pipeline runs, its Pod mounts a CSI volume provided by Connectors (driver `connectors.alauda.io`). At mount time the Connectors CSI component uses a CA to sign a certificate and injects it into the Pod, together with the kubeconfig the task uses.

In Connectors versions before 1.14.0, the CSI component loads this certificate material only once, when it starts. The certificate is valid for 60 days and is rotated upstream. A CSI component that has been running longer than that keeps injecting the stale certificate, so the kubeconfig in the pipeline Pod no longer matches and the TLS check fails with `x509: certificate signed by unknown authority`.

Connectors 1.14.0 fixes this: the certificate is rotated automatically upstream, and the CSI component detects the change and reloads it.

### Cause 2: the certificate used by Connectors expired on connectors-operator v1.12.0

With `connectors-operator.v1.12.0` installed in namespace `connectors-operator`, the certificate that the pipeline's request runs into belongs to Connectors. On Connectors Pods that have been running for a long time this certificate can expire, and then `kubectl` validation through the platform `/kubernetes/<cluster>/` path fails with `x509: certificate has expired or is not yet valid`. Restarting the Connectors Pods generates a new certificate, valid for 60 days, so the restart is a temporary fix. The permanent fix is to upgrade `connectors-operator` from v1.12.0 to v1.14.

## Resolution

### Cause 1

**Workaround:** restart all Connectors components so that the CSI component loads the current certificate.

1. List the Connectors workloads:

   ```bash
   kubectl get deployments,daemonsets -A | grep -i connectors
   ```

2. Restart each of them:

   > **Warning:** While the Connectors Pods restart, pipeline Pods that start at that moment cannot mount their Connectors volumes and stay in the init phase or fail; Pods that are already running keep their mounts. Do this only when the error is `x509: certificate signed by unknown authority` from the workspace kubeconfig, and preferably when no pipelines are starting. A restart has nothing to roll back; re-run any PipelineRun that failed during the restart.

   ```bash
   kubectl -n <connectors-namespace> rollout restart deployment/<name>
   kubectl -n <connectors-namespace> rollout restart daemonset/<name>
   kubectl -n <connectors-namespace> rollout status deployment/<name>
   kubectl -n <connectors-namespace> rollout status daemonset/<name>
   ```

3. Re-run the PipelineRun and confirm that the `apply` step succeeds.

**Permanent fix:** upgrade Connectors to 1.14.0 or later, where the CSI component refreshes the certificate when it changes. Without the upgrade, the error comes back each time the certificate is rotated while the CSI component keeps running.

### Cause 2

1. Confirm the installed version and the Pods:

   ```bash
   kubectl get csv -n connectors-operator | grep connectors-operator
   kubectl get pod -n connectors-operator
   ```

2. Restart the Connectors Pods:

   > **Warning:** Deleting the Connectors Pods interrupts the Connectors API, CSI, proxy, and the git, harbor, and oci plugins until the replacements are Running; pipeline runs that start in the gap can fail. Do this only when the pipeline error is `x509: certificate has expired or is not yet valid` on the platform `/kubernetes/<cluster>/` path, the platform certificate in the browser is valid, and `connectors-operator.v1.12.0` is installed. The workloads recreate the Pods; there is nothing to roll back.

   ```bash
   for p in api controller-manager csi git-plugin harbor-plugin oci-plugin proxy; do
     kubectl get pod -n connectors-operator -o name | grep "connectors-${p}" | xargs -r kubectl delete -n connectors-operator
   done
   kubectl get pod -n connectors-operator
   ```

   The `operator-connectors-operator` and `operator-connectors-ui-plugin` Pods do not need to be restarted.

3. Re-run the PipelineRun.

**Permanent fix:** upgrade `connectors-operator` to v1.14 through OperatorHub, following the upgrade procedure for that operator. Until then, repeat the restart before the 60-day certificate expires.

Do not use `--validate=false` as a fix. It only skips the OpenAPI schema download; the apply itself talks to the same API endpoint with the same kubeconfig and fails TLS verification in the same way.

## Diagnostic Steps

1. Confirm that the failing step uses the mounted kubeconfig: the log shows `Using kubeconfig from workspace: /workspace/kubeconfig/kubeconfig` before the x509 error.

2. Check the Connectors version:

   ```bash
   kubectl get csv -A | grep -i connectors
   ```

   A version earlier than 1.14.0 is affected.

3. Check how long the Connectors Pods have been running:

   ```bash
   kubectl get pods -A -o wide | grep -i connectors
   ```

   Pods older than about 60 days (the certificate validity) make this cause likely. After the restart, the next pipeline run succeeding confirms it.

4. To rule out a platform certificate problem, check the platform address from outside the pipeline, for example in a browser or with `curl -v https://<platform-address>/`. A trusted certificate there, together with the failure only inside pipeline Pods, points to the injected kubeconfig and not to the platform endpoint.

5. Match the error text to the cause. `x509: certificate signed by unknown authority` is Cause 1. `x509: certificate has expired or is not yet valid` on the platform `/kubernetes/<cluster>/` path with `connectors-operator.v1.12.0` installed is Cause 2. If the URL in the error is the API server directly (`https://<address>:6443/openapi/v2`) instead of the platform path, the request does not go through Connectors and neither cause applies; print the certificate that address serves:

   ```bash
   echo | openssl s_client -connect <address>:6443 2>/dev/null | openssl x509 -noout -subject -issuer -dates
   ```
