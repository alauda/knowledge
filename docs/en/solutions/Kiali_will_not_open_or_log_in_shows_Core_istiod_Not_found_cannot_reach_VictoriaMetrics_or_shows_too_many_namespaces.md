---
kind:
  - Troubleshooting
products:
  - Alauda Service Mesh
ProductsVersion:
  - "4.1"
  - "4.2"
  - "4.3"
---

# Kiali will not open or log in, shows Core istiod Not found, cannot reach VictoriaMetrics, or shows too many namespaces

## Issue

Kiali (Alauda Build of Kiali) on Service Mesh v2 shows one of these problems:

- Kiali access fails and its log shows nothing useful. OpenID login goes to a wrong address: behind the business-cluster ALB, `GET .../kiali/api/auth/info` returns an authorization address built from the business cluster domain instead of the ACP platform domain.
- The page shows `Cannot start authentication because it is not possible to use OpenId's authorization code flow. Check Kiali logs for more details.` at `/kiali/api/auth/openid_redirect`.
- Kiali loads, but its metrics are empty because the Kiali server cannot reach the cluster's VictoriaMetrics.
- The Overview page shows the cluster badge `Kubernetes` in error, Cluster Status `Core istiod Not found`, `Control planes (0)`, and `Data planes (0)`.
- A user who has access to only one namespace should see only that namespace in Kiali.

A failure after the ACP login with `Authentication openid_error: Unable to create a Kubernetes client from the auth token: illegal base64 data at input byte <N>` is covered in "Kiali OpenID login fails with illegal base64 data at input byte because api_proxy_ca_data is malformed".

## Root Cause

### Cause 1: OpenID login uses the business cluster domain because `web_fqdn` is not set and the ALB sets `X-Forwarded-Host`

The authorization endpoint that Kiali returns from `/api/auth/info` is built from `conf.Server.WebFQDN` (`GuessKialiURL` in the kiali-server source). When that value is empty, Kiali falls back in order to the `X-Forwarded-Host` request header, then the request URL host name, then the request `Host`. With `web_fqdn` not configured, the business-cluster ALB sets `X-Forwarded-Host` to the business cluster domain, so the authorization address is wrong. The ALB log on the business cluster shows Kiali requests (rule `istio-system/kiali`, upstream port `20001`) with the business cluster domain in `host`, while the same requests through the global cluster ALB under `/clusters/<cluster-name>/kiali/` carry the ACP platform domain.

Switching the Kiali CR to `spec.auth.strategy: anonymous` loads the console through the ACP platform domain at `/clusters/<cluster-name>/kiali/console/overview`, which isolates the fault to the OpenID address. OpenID access is restored by setting `web_fqdn` and the related server settings in the Kiali CR, turning off automatic ingress generation, and creating the Ingress `kiali` in `istio-system` by hand with an annotation that clears `X-Forwarded-Host`.

### Cause 2: OpenID discovery times out because of a node DNS search domain

The Kiali log shows:

```text
WRN Error when fetching OpenID provider's metadata: Get "https://<platform-domain>/dex/.well-known/openid-configuration": context deadline exceeded (Client.Timeout exceeded while awaiting headers)
WRN Could not read the session: session [not found]: cookie [kiali-token-Kubernetes] does not exist in request
```

The Kiali Pod runs on a node that has an extra DNS search domain configured. Pods with the default DNS policy inherit the node's search domains, and that search domain affects name resolution, so Kiali's request to the Dex discovery endpoint times out. Removing the search domain from the node makes the Kiali page accessible.

### Cause 3: Kiali cannot reach VictoriaMetrics through the business-cluster ALB

Kiali opens, but a network problem prevents the Kiali server from reaching the cluster's VictoriaMetrics through the business-cluster ALB. Pointing the Kiali monitoring address at the ACP platform domain address is a workaround; the network path itself still needs a fix.

### Cause 4: `Core istiod Not found` because Istio is not deployed

The Kiali log shows:

```text
WRN Cannot resolve local cluster name. Err: no istiod deployment found, no clusterName determined. Falling back to [Kubernetes]
```

Istio is not deployed in the cluster, so Kiali has no control plane to show.

### Cause 5: namespace visibility follows ACP RBAC by default

Kiali with `auth.strategy: openid` and `auth.openid.disable_rbac: false` enforces ACP RBAC, so no extra synchronization is needed. Namespaces that the user has no permission for may still be listed, but no data is displayed for them. A user given a RoleBinding in only one namespace sees only that namespace in Kiali.

## Resolution

### Cause 1: OpenID login uses the business cluster domain because `web_fqdn` is not set and the ALB sets `X-Forwarded-Host`

1. Confirm the host that the ALB passes to Kiali on the business cluster, and the current Kiali settings:

   ```bash
   kubectl logs -l service_name=alb2-cpaas-system --tail 200 -n cpaas-system | grep '/<cluster-name>/kiali/'
   kubectl get kiali -n istio-system
   kubectl get kiali -n istio-system <kiali-name> -o jsonpath='{.spec.auth}{"\n"}{.spec.server}{"\n"}{.spec.deployment.ingress}{"\n"}'
   ```

2. Optionally isolate the fault by switching to `anonymous` for a short test.

   > **Warning:** With `strategy: anonymous`, anyone who can reach the URL uses Kiali without logging in. Precondition: only as a short isolation test for Cause 1, with the Kiali CR backed up. Rollback: patch `strategy` back to `openid` (first command of the next step).

   ```bash
   kubectl get kiali -n istio-system <kiali-name> -o yaml > /tmp/kiali-cr.bak.yaml
   kubectl patch kiali -n istio-system <kiali-name> --type=merge -p '{"spec":{"auth":{"strategy":"anonymous"}}}'
   ```

3. Set `spec.server.web_fqdn` to the ACP platform domain that the browser uses, and turn off automatic ingress generation with `spec.deployment.ingress.enabled: false`. Align the related server settings (`spec.server.web_root`, `spec.server.web_port`, `spec.server.web_schema`) with the platform URL in the browser.

   > **Warning:** The Kiali operator reconciles, Kiali restarts, and the generated ingress is removed, so Kiali is unreachable until the Ingress in the next step exists. Precondition: only when Cause 1 is confirmed (wrong host in `/api/auth/info` or in the ALB log, and `web_fqdn` empty) and `/tmp/kiali-cr.bak.yaml` exists. Rollback: restore the previous `spec.server` and `spec.deployment.ingress` values from the backup, and delete the manual Ingress.

   ```bash
   kubectl patch kiali -n istio-system <kiali-name> --type=merge -p '{"spec":{"auth":{"strategy":"openid"}}}'
   kubectl patch kiali -n istio-system <kiali-name> --type=merge \
     -p '{"spec":{"server":{"web_fqdn":"<acp-platform-domain>"},"deployment":{"ingress":{"enabled":false}}}}'
   ```

4. Create the Ingress, clearing `X-Forwarded-Host`:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     name: kiali
     namespace: istio-system
     annotations:
       alb.ingress.cpaas.io/rewrite-request: '{"headers_var": {"X-Forwarded-Host": ""}}'
       nginx.ingress.kubernetes.io/backend-protocol: HTTP
       nginx.ingress.kubernetes.io/secure-backends: "false"
   spec:
     ingressClassName: cpaas-system
     rules:
       - http:
           paths:
             - path: /clusters/<cluster-name>/kiali
               pathType: Prefix
               backend:
                 service:
                   name: kiali
                   port:
                     number: 20001
   ```

   ```bash
   kubectl apply -f kiali-ingress.yaml
   kubectl get ingress -n istio-system kiali
   ```

5. Log in through the ACP platform domain. OpenID login succeeds.

### Cause 2: OpenID discovery times out because of a node DNS search domain

1. Confirm the Dex discovery timeout and find the node that runs Kiali; compare its resolver configuration with a node where Kiali works:

   ```bash
   kubectl -n istio-system logs deploy/kiali --tail=300 | grep -i -E 'openid|context deadline'
   kubectl -n istio-system get pod -o wide | grep kiali
   kubectl -n istio-system exec deploy/kiali -- cat /etc/resolv.conf
   # on the Kiali node and on a healthy node
   cat /etc/resolv.conf
   ```

   An extra `search` domain on the Kiali node that the healthy nodes do not have matches this cause.

2. Remove the extra search domain from the node.

   > **Warning:** Changing the node resolver changes name resolution for the node and for Pods created on it afterwards. Precondition: only when Cause 2 is confirmed. Back up the file first. If the file is generated by a network manager, remove the search domain in that manager's configuration instead, or it comes back. Rollback: `cp /etc/resolv.conf.bak /etc/resolv.conf` (or restore the network manager setting).

   ```bash
   cp /etc/resolv.conf /etc/resolv.conf.bak
   vi /etc/resolv.conf
   ```

3. A Pod's `/etc/resolv.conf` is written when the Pod is created, so recreate the Kiali Pod if it still times out:

   ```bash
   kubectl -n istio-system delete pod <kiali-pod>
   ```

   The Kiali page becomes accessible.

### Cause 3: Kiali cannot reach VictoriaMetrics through the business-cluster ALB

1. Read where Kiali points for metrics and confirm the failure in its log:

   ```bash
   kubectl get kiali -n istio-system <kiali-name> -o jsonpath='{.spec.external_services.prometheus}{"\n"}'
   kubectl -n istio-system logs deploy/kiali --tail=200 | grep -i -E 'prometheus|metrics|timeout'
   ```

2. As a workaround, point Kiali at the VictoriaMetrics address on the ACP platform domain.

   > **Warning:** Kiali restarts and queries metrics through the platform domain, so the platform entry carries Kiali's metric queries. Precondition: only when Cause 3 is confirmed. Back up the CR first. Rollback: `kubectl apply -f /tmp/kiali-cr-monitoring.bak.yaml`.

   ```bash
   kubectl get kiali -n istio-system <kiali-name> -o yaml > /tmp/kiali-cr-monitoring.bak.yaml
   kubectl patch kiali -n istio-system <kiali-name> --type=merge \
     -p '{"spec":{"external_services":{"prometheus":{"url":"<victoriametrics-url-on-acp-platform-domain>"}}}}'
   ```

3. Fix the network path from Kiali to the business-cluster ALB separately.

### Cause 4: `Core istiod Not found` because Istio is not deployed

```bash
kubectl get istio,istiorevision -A
kubectl get deploy -A | grep istiod
```

No `Istio` object and no `istiod` Deployment confirm this cause. Deploy Istio by following the Service Mesh v2 installation documentation. Kiali shows the control plane after `istiod` is running.

### Cause 5: namespace visibility follows ACP RBAC by default

1. Confirm the Kiali auth settings. A working layout on the `global` cluster:

   ```yaml
   auth:
     strategy: openid
     openid:
       api_proxy: <acp-platform-domain>/kubernetes/global
       api_proxy_ca_data: <certificate>
       client_id: alauda-auth
       disable_rbac: false
       insecure_skip_verify_tls: true
       issuer_uri: <platform-address>/dex
       username_claim: email
   ```

   ```bash
   kubectl get kiali -A -o jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{" "}{.spec.auth.strategy}{" disable_rbac="}{.spec.auth.openid.disable_rbac}{"\n"}{end}'
   ```

2. With `disable_rbac: false`, grant the user access only to the target namespace, for example with a RoleBinding. With `username_claim: email`, the subject name is the user's email. Bind the namespace role that the user should have:

   ```yaml
   apiVersion: rbac.authorization.k8s.io/v1
   kind: RoleBinding
   metadata:
     name: <user>-kiali-view
     namespace: <target-namespace>
   subjects:
     - apiGroup: rbac.authorization.k8s.io
       kind: User
       name: <user-email>
   roleRef:
     apiGroup: rbac.authorization.k8s.io
     kind: ClusterRole
     name: <namespace-role>
   ```

   ```bash
   kubectl apply -f <user>-kiali-rolebinding.yaml
   ```

3. The user sees only that namespace in Kiali.

## Diagnostic Steps

1. Read the Kiali log first; most of these causes have a distinct line:

   ```bash
   kubectl -n istio-system logs deploy/kiali --tail=300 | grep -E 'WRN|ERR'
   ```

2. Check the auth and server settings and how Kiali is exposed:

   ```bash
   kubectl get kiali -A -o yaml | grep -n -E 'strategy|web_fqdn|web_root|ingress|disable_rbac|prometheus'
   kubectl get ingress -n istio-system
   ```

| What you see | Cause |
| --- | --- |
| `/api/auth/info` or the ALB log carries the business cluster domain, and `web_fqdn` is empty | 1 |
| `Cannot start authentication ... authorization code flow`, log `context deadline exceeded` on `/dex/.well-known/openid-configuration` | 2 |
| Kiali up, metrics missing, Kiali cannot reach VictoriaMetrics through the business-cluster ALB | 3 |
| `Core istiod Not found`, `Control planes (0)`, log `no istiod deployment found ... Falling back to [Kubernetes]` | 4 |
| A user should see only their own namespaces | 5 |
| After the ACP login, `openid_error: ... illegal base64 data at input byte <N>` | see "Kiali OpenID login fails with illegal base64 data at input byte because api_proxy_ca_data is malformed" |
