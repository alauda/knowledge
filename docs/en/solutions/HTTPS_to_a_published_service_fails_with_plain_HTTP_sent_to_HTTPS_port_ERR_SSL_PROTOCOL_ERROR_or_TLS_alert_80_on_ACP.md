---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# HTTPS to a published service fails with plain HTTP sent to HTTPS port, ERR_SSL_PROTOCOL_ERROR, or TLS alert 80 on ACP

## Issue

HTTPS access to a service published through ALB or an Ingress fails during or right after the TLS handshake. One of the following is seen:

- The browser or client gets `400 Bad Request` with the body `The plain HTTP request was sent to HTTPS port`, typically when traffic arrives through an external load balancer.
- The browser reports `ERR_SSL_PROTOCOL_ERROR` after the service was switched from HTTP to HTTPS.
- The handshake fails with TLS alert 80, even with certificate verification disabled:

  ```text
  curl: (35) error:14094438:SSL routines:ssl3_read_bytes:tlsv1 alert internal error
  ```

  `openssl s_client` shows `SSL alert number 80`. This can follow an application migration in which the Ingress was set up again with the application's previous self-signed certificate.

A self-signed certificate that the client does not trust gives a verification error, not an alert from the server; `curl -k` still failing means the server side aborted the handshake.

Related articles: *Old business TLS certificate still served after an Ingress, ALB rule, or upstream load balancer update on ACP* (the handshake works but the previous certificate is presented). [TLS passthrough breaks behind an L7 load balancer on ACP ALB ingress](TLS_passthrough_breaks_behind_an_L7_load_balancer_on_ACP_ALB_ingress.md) explains TCP passthrough versus TLS termination on ALB frontends.

## Root Cause

### Cause 1: an external load balancer sends decrypted HTTP to the ALB HTTPS port

The ALB listener on 443 is HTTPS. Opening that ALB entry directly, bypassing the external load balancer, reaches the service. The external load balancer terminates TLS on 443 and forwards the decrypted HTTP request to the ALB port that still expects TLS, and the ALB answers `400 The plain HTTP request was sent to HTTPS port`.

A port 80 to 443 redirect does not repair this forward. The fix is on the external load balancer, and it depends on where TLS should terminate:

- TCP passthrough to ALB 443 makes the ALB certificate the one clients see.
- Sending the decrypted HTTP to an HTTP listener on the ALB keeps TLS termination on the external load balancer, so the certificate clients see is the external load balancer's certificate.

### Cause 2: ERR_SSL_PROTOCOL_ERROR because the published Service port reaches a container port that speaks plain HTTP

The application inside the Pod terminates TLS itself (for example nginx with `listen 443 ssl`, certificate and key files present), but the Service port that clients use still targets the container's HTTP port. For example, the original Service port 80 targets container port 80, and the added Service port 443 also targets container port 80 instead of 443. The client starts a TLS handshake against a plain HTTP listener and the browser reports `ERR_SSL_PROTOCOL_ERROR`.

This cause applies only when the Pod terminates TLS and the Service `targetPort` is the HTTP container port. If the ALB log says no certificate is bound for the domain, or the ALB rule form rejects the domain because it is not registered under the platform domain names, that is a different problem.

### Cause 3: ALB returns TLS alert 80 and logs cert_tool.lua: no cert found

All replicas of the ALB (for example `common-lb` or `global-alb2` in `cpaas-system`) fail the handshake with `tlsv1 alert internal error` / SSL alert number 80. The ALB `nginx` container logs:

```text
cert_tool.lua: no cert found for <host>/<port>
SSL_do_handshake() failed ... cert cb error
```

`<port>` is the frontend port. The same replicas can also log `policy_fetch.lua` with `empty policy` or `invalid policy data`, and `/etc/alb2/nginx/policy.new` can be seen at 0 bytes or at a partial size while it is rewritten; when parsing fails, the running ALB keeps the previous active policy, so those lines alone do not explain a lasting outage. The direct failure is the runtime certificate lookup miss for the host in the ALB's in-memory certificate cache. A rolling restart of the ALB replicas makes them serve the expected certificate again. If a fresh replica immediately logs `no cert found` again, the certificate binding itself is missing and a restart does not help.

### Cause 4: the Ingress names the intended certificate, but the controller has not refreshed it

The Ingress for the host already references the intended TLS Secret (for example the application's previous self-signed certificate, reused after a migration), the Secret exists and parses, and `curl -k` still fails with `tlsv1 alert internal error`. Setting the same certificate on the Ingress again does not help. Switching the Ingress to a different certificate (for example the platform certificate) and then back to the intended certificate makes the controller pick it up, and access recovers. The certificate had not been refreshed by the controller; the exact mechanism has not been determined.

## Resolution

### Cause 1: an external load balancer sends decrypted HTTP to the ALB HTTPS port

1. Confirm the ALB and the application work when requested directly:

   ```bash
   curl -vk --resolve <host>:443:<alb-node> https://<host>/
   ```

   A response from the application means the ALB listener and the Pods are fine.

2. Change the forwarding on the external load balancer so that it no longer sends decrypted HTTP to ALB 443:
   - When the ALB should be the only certificate presenter, pass TCP through to the ALB 443 listener.
   - When the external load balancer should keep terminating TLS, forward the decrypted HTTP to an HTTP listener on the ALB. The certificate to maintain is then the one on the external load balancer.

3. Retry through the public name. The `400` should be gone.

### Cause 2: ERR_SSL_PROTOCOL_ERROR because the published Service port reaches a container port that speaks plain HTTP

1. Compare the Service ports with the port where the process enables TLS:

   ```bash
   kubectl get svc -n <namespace> <service-name> -o yaml
   kubectl exec -n <namespace> <pod> -- sh -c 'ss -lntp || netstat -lntp'
   ```

2. Point the HTTPS Service port at the container port that terminates TLS.

   > **Warning:** Changing the Service `targetPort` drops the current mapping for that port (and its NodePort or load balancer port). Clients using that port fail until the new target answers. Do this only when the client error is `ERR_SSL_PROTOCOL_ERROR` and the Service's HTTPS port targets the container's HTTP port. Save the Service first; roll back with `kubectl apply -f` of the saved file.

   ```bash
   kubectl get svc -n <namespace> <service-name> -o yaml > "$HOME/<service-name>.yaml"
   kubectl edit svc -n <namespace> <service-name>
   ```

   For example, set `targetPort: 443` on the Service port that clients use for HTTPS.

3. A new HTTPS request should complete the handshake.

### Cause 3: ALB returns TLS alert 80 and logs cert_tool.lua: no cert found

1. Find the ALB workload and confirm the log signature on its replicas:

   ```bash
   kubectl get pods -A | grep -E 'common-lb|global-alb2'
   kubectl logs -n cpaas-system <alb-pod> -c nginx --tail=100 | grep -E 'cert_tool|alert|policy_fetch'
   ```

   Make sure the Pods are the platform ALB in `cpaas-system`, not another ingress controller that the `grep` also matched. If the leaf is simply expired, replace the certificate instead of restarting. Do not hand-edit `/etc/alb2/nginx/policy.new`.

2. Restart the ALB replicas one at a time.

   > **Warning:** A rolling restart closes the HTTPS connections handled by each replica while it is recreated; in-flight requests on that replica fail and must be retried. With only one ready replica the ALB is unavailable during the restart, so use a maintenance window. Do this only after `cert_tool.lua: no cert found` is confirmed and clients see TLS alert 80. The in-memory certificate cache is rebuilt by the restart; there is nothing to roll back to.

   ```bash
   kubectl rollout restart deployment/<alb-name> -n cpaas-system
   kubectl rollout status deployment/<alb-name> -n cpaas-system
   ```

   If the ALB is not a Deployment, restart the workload kind that `kubectl get pods` shows, one replica at a time.

3. Check that each replica serves the expected certificate:

   ```bash
   echo | openssl s_client -connect <alb-node>:443 -servername <host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   ```

   If a new replica logs `no cert found` again right away, bind the certificate to the host on the ALB rule or Ingress; a restart will not fix a missing binding.

### Cause 4: the Ingress names the intended certificate, but the controller has not refreshed it

1. Confirm that the Ingress references the Secret and that the certificate in it is valid for the host:

   ```bash
   kubectl get ingress -A -o yaml | grep -F '<host>'
   kubectl get ingress -n <namespace> <ingress-name> -o yaml
   kubectl get secret -n <namespace> <tls-secret> -o jsonpath='{.data.tls\.crt}' \
     | base64 -d | openssl x509 -noout -dates -subject -issuer
   ```

2. Check whether the server presents any certificate:

   ```bash
   echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -issuer
   ```

   No certificate printed, together with the TLS alert, matches this cause.

3. In the Ingress, switch the TLS certificate to a different valid certificate (for example the platform certificate), save, then switch it back to the intended certificate and save again.

   > **Warning:** While the other certificate is selected, clients of this host receive that certificate and may see a name mismatch. Do this only when the intended Secret exists and parses and the host is already failing with TLS alert 80. Save the Ingress first (`kubectl get ingress -n <namespace> <ingress-name> -o yaml > "$HOME/<ingress-name>.yaml"`); roll back with `kubectl apply -f` of that file.

4. Retry `curl https://<host>/` (with `-k` for a self-signed certificate) and confirm the handshake completes.

## Diagnostic Steps

1. Read what the client actually receives:

   ```bash
   curl -vk https://<host>/
   echo | openssl s_client -connect <host>:443 -servername <host>
   ```

2. Compare with a direct request to the ALB, bypassing any external load balancer:

   ```bash
   curl -vk --resolve <host>:443:<alb-node> https://<host>/
   ```

3. Match the signature:

   | What you see | Cause |
   | --- | --- |
   | `400` with `The plain HTTP request was sent to HTTPS port` through the external load balancer; the direct ALB request works | 1 |
   | `ERR_SSL_PROTOCOL_ERROR`; the Service HTTPS port targets the container's HTTP port | 2 |
   | TLS alert 80 on every ALB replica; ALB log `cert_tool.lua: no cert found for <host>/<port>` | 3 |
   | TLS alert 80; the Ingress already references a valid Secret for the host; set up again after a migration | 4 |
   | Handshake succeeds but the old certificate is presented | *Old business TLS certificate still served after an Ingress, ALB rule, or upstream load balancer update on ACP* |
