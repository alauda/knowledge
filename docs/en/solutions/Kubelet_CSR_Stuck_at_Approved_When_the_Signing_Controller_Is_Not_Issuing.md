---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Kubelet CSR Stuck at Approved When the Signing Controller Is Not Issuing

## Issue

When a node's kubelet client certificate expires, the kubelet renews it through the CertificateSigningRequest API, and the resulting requests surface in `kubectl get csr`. On Alauda Container Platform (Kubernetes server `v1.34.5`) the CSR API is the standard upstream `certificates.k8s.io/v1` group: the `csr` resource is cluster-scoped and listable directly with `kubectl get csr`.

In the affected state, one or more of these requests stay in the `Approved` condition and never progress to `Approved,Issued`. Listing the requests surfaces the stuck condition directly:

```bash
kubectl get csr
```

```text
NAME          AGE   SIGNERNAME                      CONDITION
csr-sqgzp     5m    kubernetes.io/kubelet-serving   Approved
```

## Root Cause

A CSR's `status.certificate` field is populated by the signer only after an `Approved` condition is present; while the signature has not been emitted, the request continues to show `Approved` in the CONDITION column of `kubectl get csr`. Once the signing controller emits the certificate, the same request shows `Approved,Issued`. A request that is approved but stuck with an empty `status.certificate` therefore indicates the signer has not acted.

The signer is the `csrsigning` controller in the `kube-controller-manager`. The controller-manager runs with `--controllers=*,bootstrapsigner,tokencleaner`, where `*` enables the default `csrapproving` and `csrsigning` controllers, and the signer is wired to a CA through `--cluster-signing-cert-file` and `--cluster-signing-key-file`; issued certificates use the configured `--cluster-signing-duration` lifetime. When approved CSRs are not reaching `Approved,Issued`, the root cause is that this signing controller is not issuing the requested certificates, which leaves a growing backlog of approved-but-unissued requests.

While that backlog persists, downstream workloads that depend on a freshly issued node certificate can fail to start until their request is signed.

## Diagnostic Steps

Confirm whether kubelet renewal requests have reached the apiserver and inspect their condition; in steady state the list is empty, so any request lingering in `Approved` is the signal to investigate:

```bash
kubectl get csr
```

Check the health of the signer by listing the controller-manager pod. On Alauda Container Platform the `kube-controller-manager` runs as a static pod in the `kube-system` namespace, and a portable filter surfaces it directly:

```bash
kubectl get pods -n kube-system | grep controller
```

```text
kube-controller-manager-192.168.135.152   1/1   Running
```

A `Running` controller-manager pod paired with CSRs stuck at `Approved` points at the `csrsigning` controller failing to issue rather than the pod being down.

## Resolution

Identify the pending kubelet request, then approve it so the signing controller is told to issue the certificate:

```bash
kubectl get csr
kubectl certificate approve <csr-name>
```

Approving a request instructs the certificate signing controller to issue the certificate, the same `csrsigning` mechanism examined above; a healthy signer then moves the request from `Approved` to `Approved,Issued` and populates `status.certificate`. Re-running `kubectl get csr` confirms the transition:

```bash
kubectl get csr
```

```text
NAME          AGE   SIGNERNAME                      CONDITION
csr-sqgzp     7m    kubernetes.io/kubelet-serving   Approved,Issued
```
