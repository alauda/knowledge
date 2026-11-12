---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.2"
  - "4.3.3"
---

# auth-controller2 webhook certificate missing or log burst, monitoring query credentials, and Connector tokens on ACP

## Issue

One of these is reported on the platform:

- `auth-controller2` never starts. The Pod event is `MountVolume.SetUp failed for volume "cert": secret "auth-controller2-webhook-cert" not found`, and an upgrade of `3rdparty/chart-cert-manager` fails while creating a ResourceQuota at `metis-webhook.cpaas-system.svc:443/check-resourcequota` with `x509: certificate signed by unknown authority`.
- One daily `log-platform` index is suddenly many times larger than its neighbours (about a terabyte or more), and the question is which component produced it, or whether `auth-controller2` logs surge and the controller will crash while administrators are adding permissions for users.
- An external caller needs a credential for a Prometheus or VictoriaMetrics query, or the API token page shows `Permissions required. Please contact your administrator.`
- `kube-prometheus-exporter-node` uses a different username on some clusters.
- A Kubernetes-type Connector shows authentication failed.

## Root Cause

### Cause 1: `auth-controller2-webhook-cert` is not issued because a second cert-manager produces conflicting CertificateRequests

The certificate volume of `auth-controller2` is not optional (`optional: false`), so the Pod cannot start without the Secret `auth-controller2-webhook-cert` in `cpaas-system`. When a non-platform cert-manager and the platform cert-manager are both present, more than one `CertificateRequest` exists for the certificate, and admission to the `metis-validation` webhook fails with `x509: certificate signed by unknown authority` (also logged as `tls: failed to verify certificate: x509: certificate signed by unknown authority`). The webhook Secret comes back after `metis-validation` is set to ignore failures, the extra `CertificateRequest` objects are removed (one is kept), and cert-manager is restarted. This is not the case where the metis Pod is down and does not answer.

### Cause 2: a one-time `auth-controller2` log burst while user permissions are being added

A daily `log-platform` index can grow far beyond its neighbours when `auth-controller2` writes a burst of log lines while operations staff add permissions for users. In one such case the large day held about 62 million documents and about 2.1 TB, against about 18 to 39 million documents and 8 to 23 GB on neighbouring days. A product-log query on the two `auth-controller2` Pods returned about 13 million entries, about 10 million of them in a single interval, with the surrounding intervals near zero. During the burst, container `auth-controller2-manager` rose from about 750 Mi to about 1.1 Gi and returned to baseline, far below its 6144 Mi limit, so the Pod was not near an OOM kill; a "utilization from requests" figure above 1000 % only reflects its small memory request. No crash occurred, the burst did not repeat, and later daily indices returned to normal size. Why the permission changes produced that many lines was not determined.

### Cause 3: external Prometheus or VictoriaMetrics queries need the matching credential

Platform API queries use a platform API token. Native Prometheus queries use the basic-auth Secret `kube-prometheus-prometheus-basic-auth` in `cpaas-system`. Native VictoriaMetrics queries use `victoriametrics-basic-auth`. The API token page hides token creation from users who lack that page permission, which produces the `Permissions required` message; the monitoring endpoints below are an alternative for a monitoring caller that reads every cluster.

### Cause 4: the `kube-prometheus-exporter-node` credential changed in 4.2

`kube-prometheus-exporter-node` does not use the same username and password on every cluster. Before 4.2 it uses a fixed credential. From 4.2 the username is `monitor@cpaas.io` and the password is a random string. The difference is a security policy change in 4.2, not a cluster that lost its configuration.

### Cause 5: a Kubernetes Connector uses an endpoint that does not match its token

The Connector object is created and then shows authentication failed. The usual mismatches are: the endpoint is a cluster API server (`https://192.0.2.10:6443`) but the token is a platform API token, or the endpoint is the ACP platform address but the token is a cluster ServiceAccount token; the Secret that was inspected is not the Secret named on the Connector; or `secretRef` is not under `spec.auth` with `bearerTokenAuth`. A token created with `kubectl create token` is valid for one hour unless the API server lifetime flags say otherwise.

## Resolution

### Cause 1: `auth-controller2-webhook-cert` is not issued because a second cert-manager produces conflicting CertificateRequests

1. Confirm that the Secret is absent and the Pod event names it:

   ```bash
   kubectl -n cpaas-system get secret auth-controller2-webhook-cert
   kubectl -n cpaas-system describe pod <auth-controller2-pod>
   kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration -o name | grep metis-validation
   kubectl get certificaterequest.cert-manager.io -A
   ```

2. Set `failurePolicy: Ignore` on the `metis-validation` webhook entries (at least the one whose service is `metis-webhook` and path `/check-resourcequota`).

   > **Warning:** `failurePolicy: Ignore` lets requests through while the webhook certificate is untrusted, including requests the webhook would have rejected. Precondition: only when `auth-controller2-webhook-cert` is missing and admission to `metis-webhook.cpaas-system.svc:443/check-resourcequota` fails with `x509: certificate signed by unknown authority`. Rollback: `kubectl apply -f /tmp/metis-validation.bak.yaml`.

   ```bash
   kubectl get validatingwebhookconfiguration metis-validation -o yaml > /tmp/metis-validation.bak.yaml
   kubectl edit validatingwebhookconfiguration metis-validation
   ```

3. Keep one `CertificateRequest`, delete the extra ones created by the non-platform cert-manager, and restart cert-manager.

   > **Warning:** Deleting a `CertificateRequest` drops that issuance. Precondition: only when both cert-managers have produced multiple `CertificateRequest` objects for this certificate and the Secret is still missing. Save the YAML first. Re-applying a deleted `CertificateRequest` retries issuance.

   ```bash
   kubectl get certificaterequest.cert-manager.io -A -o yaml > /tmp/cr.bak.yaml
   kubectl delete certificaterequest.cert-manager.io -n <namespace> <extra-request>
   kubectl get deploy -A | grep cert-manager
   kubectl -n <cert-manager-namespace> rollout restart deploy/<cert-manager-deploy>
   kubectl -n cpaas-system get secret auth-controller2-webhook-cert
   ```

4. `auth-controller2` starts after the Secret exists. Once the webhook certificate verifies (the `x509` error is gone), restore the previous `failurePolicy` of `metis-validation` from `/tmp/metis-validation.bak.yaml`.

Do not install a second cert-manager next to the platform cert-manager.

### Cause 2: a one-time `auth-controller2` log burst while user permissions are being added

1. Find the source of the volume before treating it as business logs. In the Operations Center, open **Logs > Query**, select product logs, narrow the time range to the large day, filter by the `auth-controller2` Pod names, and look at the histogram for a single spike.

2. Check the Pod's memory in monitoring for the same interval, and its current state:

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep auth-controller2
   kubectl -n cpaas-system get pod <auth-controller2-pod> -o jsonpath='{range .status.containerStatuses[*]}{.name}{" restarts="}{.restartCount}{" lastState="}{.lastState}{"\n"}{end}'
   kubectl -n cpaas-system top pod <auth-controller2-pod> --containers
   ```

   A single spike at the time permissions were being granted, memory back at baseline, and no restart or `OOMKilled` last state need no action.

3. If the burst repeats, collect a sample of the repeated lines while it happens, together with the permission operations being performed, for the support team:

   ```bash
   kubectl -n cpaas-system logs <auth-controller2-pod> -c auth-controller2-manager --since=10m > /tmp/auth-controller2-burst.log
   wc -l /tmp/auth-controller2-burst.log
   ```

### Cause 3: external Prometheus or VictoriaMetrics queries need the matching credential

Platform API, with a platform API token:

```text
https://<platform-address>/v2/metrics/<cluster-name>/prometheus/query
```

Native Prometheus, with the username and password from the Secret:

```bash
kubectl get secret -n cpaas-system kube-prometheus-prometheus-basic-auth -o jsonpath='{.data.username}' | base64 -d; echo
kubectl get secret -n cpaas-system kube-prometheus-prometheus-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
```

```text
https://<platform-address>/clusters/<cluster-name>/prometheus-0/api/v1/query
```

VictoriaMetrics uses the Secret `victoriametrics-basic-auth` and paths of the form `/clusters/global/vmselect/api/v1/query` and `/api/v1/query_range` under the same prefix. Replacing `vmselect` in that path with `prometheus-0` gives the native Prometheus form; the query APIs are the same.

### Cause 4: the `kube-prometheus-exporter-node` credential changed in 4.2

Read the credential that the cluster actually uses and compare it with the cluster version. On 4.2 and later, expect username `monitor@cpaas.io` and a random password. No reset is needed to make clusters of different versions "match".

### Cause 5: a Kubernetes Connector uses an endpoint that does not match its token

1. Match the endpoint and the token. A cluster API server address takes a bearer token from that cluster. An ACP platform address takes a platform API token. The Secret name and namespace on the Connector must be the Secret you filled in.

2. To use a ServiceAccount token for a cluster API server endpoint, create one for the ServiceAccount the Connector should act as, store it in the Secret key `token`, and reference the Secret under `spec.auth.bearerTokenAuth.secretRef` (name and namespace).

   > **Warning:** Anyone who can read the Connector Secret can call the API as that ServiceAccount until the token expires (one hour by default). Precondition: only when the Connector endpoint and this ServiceAccount are the pair that should authenticate. Rollback: replace the `token` value or delete the key; a token already issued stays valid until it expires. The API server flags `--service-account-extend-token-expiration` and `--service-account-max-token-expiration` affect the lifetime of tokens issued later.

   ```bash
   kubectl -n <serviceaccount-namespace> create token <serviceaccount>
   ```

3. After the endpoint, the token type, and `secretRef` agree, the Connector authenticates and can be used from a pipeline Task.

## Diagnostic Steps

```bash
kubectl -n cpaas-system get pods | grep auth-controller
kubectl -n cpaas-system get secret auth-controller2-webhook-cert
kubectl -n cpaas-system get secret kube-prometheus-prometheus-basic-auth
```

- Event `secret "auth-controller2-webhook-cert" not found`, a `metis-validation` `x509` error, a second cert-manager, and more than one `CertificateRequest`: Cause 1. If the metis Pod itself is not Running, the webhook does not answer at all, which is a different problem.
- One daily `log-platform` index many times larger than its neighbours, and a product-log query showing a single `auth-controller2` spike at the time user permissions were added, with no restart: Cause 2.
- An external metrics query needs a credential: Cause 3. Exporter username differs by cluster version: Cause 4.
- Connector authentication failed: Cause 5.
