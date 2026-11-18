---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "4.1"
  - "4.2"
  - "4.3"
---

# ALB TLS 1.0 and 1.1, and HTTP port 80 access to the platform console on ACP

## Issue

- A compliance scan requires TLS 1.0 and TLS 1.1 to be disabled, and the question is where the ALB's nginx configuration can be checked.
- The platform console can only be opened over HTTPS on 443; `http://` on port 80 does not work, and the administrator wants HTTP access back, or asks whether port 80 can still be opened after the platform is deployed.
- A script calls a platform API such as `/apis/platform.tkestack.io/v1/clusters` over HTTP and gets `404` on one platform while the same call works on another.

These are settings of the ALB data plane and of the platform configuration, not of a single rule.

## Root Cause

### Cause 1: ssl_protocols in the ALB ConfigMap enables TLSv1 and TLSv1.1

The protocols the ALB accepts are set by `ssl_protocols` in the ConfigMap that has the same name as the ALB (namespace `cpaas-system` of the cluster where the ALB runs), for example:

```nginx
ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;
```

`TLSv1` and `TLSv1.1` in that line mean TLS 1.0 and TLS 1.1 are enabled.

### Cause 2: forceRedirectHttps: true and httpPort: 0 in the prdb base

Whether the console is served on port 80 is decided by the `http` section of the `base` ProductBase (`kubectl get prdb base -o yaml`). With `forceRedirectHttps: true`, `httpPort: 0` and `httpsPort: 443`, only HTTPS is served; the platform ALB `global-alb2` follows it (its Deployment carries the environment variable `DEFAULT-SSL-STRATEGY` with value `Always`), and there is no `global-alb2-00080` frontend. Changing these two fields after deployment opens port 80.

This concerns the platform console only. Do not set `forceRedirectHttps` to `false` to change redirects of business listeners. The platform console protocol is also unrelated to the access protocol of a business Harbor instance.

### Cause 3: 404 with X-ALB-ERR-REASON: InvalidUpstream : no rule match on port 80 of global-alb2

`curl -v http://<platform-address>/apis/platform.tkestack.io/v1/clusters` returns `HTTP/1.1 404 Not Found` with `X-ALB-ERR-REASON: InvalidUpstream : no rule match` and `Via: alb`, and the `global-alb2` log shows the request with `404` and `no rule match` for the port 80 policy. On that platform the `erebus` rules for `/api`, `/apis`, `/kubernetes/` and `/tunnel` exist only on port 443 (`global-alb2-00443-*`) because port 80 is not enabled, so HTTP requests match no rule. A platform where the call works has the same rules on both `global-alb2-00080-*` and `global-alb2-00443-*`.

## Resolution

### Cause 1: ssl_protocols in the ALB ConfigMap enables TLSv1 and TLSv1.1

Remove `TLSv1` and `TLSv1.1` from `ssl_protocols` and restart the ALB Pods. Make the edit in the overwrite ConfigMap so the next reconcile does not restore the old line (see "ALB nginx settings are reverted after a restart or upgrade; change them through the overwrite ConfigMap on ACP"). Keep the newer protocols the line already lists:

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
```

> **Warning:** Clients that only speak TLS 1.0 or 1.1 can no longer connect to any HTTPS port of this ALB, and each restart drops connections on that replica. Check client compatibility and back up the overwrite ConfigMap first. Restoring the previous line and restarting again is the rollback.

```bash
kubectl -n cpaas-system get pods -o wide | grep <alb-name>
kubectl -n cpaas-system delete pod <alb-pod>
```

Delete one ALB Pod at a time and wait for its replacement to be Ready before the next.

### Cause 2: forceRedirectHttps: true and httpPort: 0 in the prdb base

On the global cluster:

1. Choose the HTTP port (for example `80`) and add a forwarding rule on the platform address (VIP or external load balancer) that sends that port to the three global masters.
2. Back up the ProductBase and the platform ALB:

   ```bash
   kubectl get prdb base -o yaml > /tmp/prdb-base.backup.yaml
   kubectl -n cpaas-system get deploy global-alb2 -o yaml > /tmp/global-alb2-deploy.backup.yaml
   ```

3. Edit the ProductBase and set `spec.http.httpPort: 80` and `spec.http.forceRedirectHttps: false`, then wait until every `ars` in `cpaas-system` is ready.

   > **Warning:** The platform releases reconcile, the console then also answers in clear text on port 80, and the console can be briefly unreachable while `global-alb2` restarts. Do it in a window and only where HTTP access to the console is acceptable on that network. Roll back with `kubectl apply -f /tmp/prdb-base.backup.yaml` and wait for the `ars` again.

   ```bash
   kubectl edit prdb base
   kubectl get ars -n cpaas-system
   ```

4. Check that the port 80 frontend exists and that `DEFAULT-SSL-STRATEGY` changed. If not, restart the `global-alb2` Pods one at a time.

   ```bash
   kubectl get ft -n cpaas-system | grep global-alb2
   kubectl -n cpaas-system get deploy global-alb2 -o yaml | grep -n -A1 DEFAULT-SSL-STRATEGY
   kubectl -n cpaas-system delete pod <global-alb2-pod>
   ```

5. Log in over both `http://` and `https://`.

### Cause 3: 404 with X-ALB-ERR-REASON: InvalidUpstream : no rule match on port 80 of global-alb2

Send the request over HTTPS on port 443, where the `erebus` rules exist. If HTTP on port 80 is required for the platform, enable it with Cause 2, which creates the `global-alb2-00080` frontend and its rules.

```bash
curl -k -sS -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <token>' https://<platform-address>/apis/platform.tkestack.io/v1/clusters
```

## Diagnostic Steps

1. Read the enabled protocols and test the handshake:

   ```bash
   kubectl -n cpaas-system get configmap <alb-name> -o yaml | grep -C 10 ssl_protocols
   openssl s_client -connect 192.0.2.10:443 -servername app.example.com -tls1_1 </dev/null
   openssl s_client -connect 192.0.2.10:443 -servername app.example.com -tls1 </dev/null
   ```

   `TLSv1` or `TLSv1.1` in the line, or a completed handshake with `-tls1_1` or `-tls1`: Cause 1. After the change, rerun `openssl s_client`; both handshakes should fail.

2. Platform HTTP access:

   ```bash
   kubectl get prdb base -o yaml | grep -n -A4 'http:'
   kubectl get ft -n cpaas-system | grep global-alb2
   ```

   `forceRedirectHttps: true` with `httpPort: 0` and no `global-alb2-00080` frontend: Cause 2.

3. A `404` on port 80:

   ```bash
   curl -sv http://<platform-address>/apis/platform.tkestack.io/v1/clusters 2>&1 | grep -iE '^< HTTP|x-alb-err-reason|^< via'
   kubectl get rule -A | grep erebus
   ```

   `no rule match` and only `global-alb2-00443-*` rules for `erebus`: Cause 3.
