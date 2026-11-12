---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.2.x
  - 4.3.x
---

# Ingress NGINX controller serves the fake certificate, ignores an Ingress, or rejects Ingress saves on ACP

## Issue

These problems concern the Alauda build of Ingress NGINX Controller, deployed by `ingress-nginx-operator` from an `IngressNginx` resource (`ingressnginxes.ingress-nginx.alauda.io`), with IngressClass `ingress-nginx-operator-<name>`. Typical reports:

- A certificate was attached to a domain on the platform domain page, and services using that domain show a browser warning with the certificate `Kubernetes Ingress Controller Fake Certificate`, while another service whose Secret is in its own namespace works.
- An Ingress with its own TLS certificate still gets the controller's default certificate.
- Applications in one project cannot use an Ingress NGINX gateway from another project.
- An IngressClass limited with **Ingress Scope** is still selectable in other projects.
- After an Ingress was created, requests return `404` and the controller has no access log for them.
- Requests hang for about two minutes before they succeed, and the error log shows `connect() failed (110: Operation timed out) while connecting to upstream`.
- Saving an Ingress fails on ACP 4.0 when the Higress gateway is used.
- A GitLab Ingress with a `configuration-snippet` is rejected with `failed calling webhook "inject-label.cpaas.io": webhook returned response.patchType but not response.patch`.
- A gray-release (traffic-split) Ingress that repeats the host and path of the primary Ingress is rejected by the admission webhook of the platform component `metis`.

## Root Cause

### Cause 1: the domain default certificate option is used with Ingress NGINX

A wildcard domain created under **Platform Management > Network Management > Domain** keeps its certificate Secret in `cpaas-system`. When an Ingress of class `ingress-nginx-operator-<name>` selects the "domain default certificate" option, the generated YAML has `spec.tls: []` and only the annotation `alb.networking.cpaas.io/tls: <host>=cpaas-system/<domain-secret>`. That option, and the platform-assigned certificate in general, is designed for the ALB load balancer. Ingress NGINX lets an Ingress reference only a TLS Secret in the same namespace, so the binding fails and the controller serves its fake certificate (CN `Kubernetes Ingress Controller Fake Certificate`, O `Acme Co`). Plain `http://` access shows no certificate, which can hide the problem; the certificates themselves can be identical and valid.

### Cause 2: several Ingress objects share one host and only one has TLS

The Ingress with the dedicated certificate is correct (for example two host rules and a `tls` section listing both hosts with one `secretName`), but other Ingress objects use the same host names for other paths and are HTTP-only, without TLS. That conflicting configuration for the same host makes the controller's default certificate win for the domain.

### Cause 3: the IngressNginx instance is scoped to other namespaces

By default an Ingress NGINX instance handles Ingress resources in all namespaces that either name its IngressClass or name no IngressClass. `.spec.controller.scope.namespaceSelector` restricts it, for example `namespaceSelector: 'cpaas.io/project=demo'` limits it to namespaces labeled `cpaas.io/project=demo`. Ingress objects from other projects are then ignored.

### Cause 4: the console lists a scoped IngressClass in every project

The console does not filter the IngressClass list by project, so a class limited with **Ingress Scope** appears everywhere. The scope is enforced at runtime: Ingress objects from projects outside the scope are not served.

### Cause 5: an invalid Ingress makes requests return 404 with no access log

An invalid Ingress was added, for example one with `nginx.ingress.kubernetes.io/configuration-snippet: | gzip off;` next to `nginx.ingress.kubernetes.io/backend-protocol: HTTP` and `nginx.ingress.kubernetes.io/proxy-body-size: "0"`. Snippet annotations are disabled by default in newer Ingress NGINX versions (Cause 8). Removing the invalid Ingress is the fix.

### Cause 6: requests wait about 131 seconds for a stale upstream, then succeed

The controller error log shows:

```text
[error] ... connect() failed (110: Operation timed out) while connecting to upstream ... request: "GET <path> HTTP/1.1", upstream: "http://<old-pod-ip>:80<path>"
```

The access log line for the same request lists two upstreams, the old one on port 80 and the expected one on port 8080, with statuses `502, 200` and upstream times of about `131.015, 0.003`.

An Endpoints object was applied by hand for a Service that has a selector (it carries `kubectl.kubernetes.io/last-applied-configuration`), and a Pod of another service had been associated with the Service by mistake, which produced an EndpointSlice owned by the Service with a `ready: true` endpoint whose `targetRef` is a Pod of a different service. `kube-controller-manager` logs:

```text
"Error mirroring EndpointSlices for Endpoints, retrying" logger="endpointslice-mirroring-controller" key="<namespace>/<service>" err="error(s) deleting 1/1 EndpointSlices for <namespace>/<service> Endpoints, including: endpointslices.discovery.k8s.io \"<service>-<suffix>\" not found"
```

The hand-made Endpoints disrupt the native controller's takeover; its cleanup gets stuck on a slice that no longer exists, the stale slice stays, and the controller keeps trying the old upstream first.

### Cause 7: saving an Ingress fails on 4.0 when the Higress gateway is used

On ACP 4.0, the Ingress check webhook `check-ingress` of the `metis` Deployment in `cpaas-system` interferes with saving Ingress resources used by Higress. The same operation works on 3.16.

### Cause 8: an Ingress with a configuration-snippet is rejected with an inject-label.cpaas.io webhook error

Newer Ingress NGINX versions disable snippet annotations by default. A Helm-deployed GitLab whose `gitlab-webservice-default` Ingress gains a multi-line `nginx.ingress.kubernetes.io/configuration-snippet` (for WebSocket) is not served, although the controller log shows `"Found valid IngressClass"` for it, and admission fails with `failed calling webhook "inject-label.cpaas.io": webhook returned response.patchType but not response.patch`.

### Cause 9: a gray-release Ingress with the same host and path as the primary Ingress is rejected by metis

The `check-ingress` webhook of `metis` enforces a duplicate host and path check on Ingress resources. A gray-release Ingress (one that carries the ingress-nginx gray-release annotations, for example routing requests with the header `runenv: gray-ack` to the new version) shares host and path with the primary Ingress by design, so the check rejects it.

From ACP 4.3, the `metis` Deployment carries `--disable-webhook=check-ingress` automatically.

## Resolution

### Cause 1: the domain default certificate option is used with Ingress NGINX

Create the certificate Secret in the business namespace and reference it from the Ingress `spec.tls`; do not use the domain default certificate option with Ingress NGINX.

```bash
kubectl -n <namespace> create secret tls <tls-secret> --cert=<cert.pem> --key=<key.pem>
```

```yaml
spec:
  ingressClassName: ingress-nginx-operator-<name>
  tls:
    - hosts:
        - app.example.com
      secretName: <tls-secret>
```

### Cause 2: several Ingress objects share one host and only one has TLS

Change every Ingress that uses the domain to HTTPS and add the same TLS certificate to each of them. Find them with:

```bash
kubectl get ingress -A -o json | jq -r '.items[] | select([.spec.rules[]?.host] | index("app.example.com")) | .metadata.namespace + "/" + .metadata.name + " tls=" + ((.spec.tls // []) | length | tostring)'
```

### Cause 3: the IngressNginx instance is scoped to other namespaces

Check the scope of the instance. To serve Ingress objects from all projects, use an instance without `controller.scope.namespaceSelector`; otherwise adjust the selector to include the other project's namespaces.

```bash
kubectl -n <namespace> get ingressnginxes.ingress-nginx.alauda.io <name> -o jsonpath='{.spec.controller.scope}{"\n"}'
```

```yaml
apiVersion: ingress-nginx.alauda.io/v1
kind: IngressNginx
metadata:
  name: <name>
spec:
  controller:
    nodeSelector:
      kubernetes.io/os: linux
    replicaCount: 1
```

### Cause 4: the console lists a scoped IngressClass in every project

No change is needed for isolation; it works at runtime. Selecting the class from a project outside the scope does not get that Ingress served.

### Cause 5: an invalid Ingress makes requests return 404 with no access log

Find the invalid Ingress in the controller log or with `kubectl describe`, and remove it (or fix it, for example as in Cause 8 for snippets).

> **Warning:** Deleting the Ingress removes its hosts from the controller. Do it only when the controller log or events name this Ingress as invalid, and save its YAML first. To roll back, apply the saved YAML after fixing it.

```bash
kubectl -n <ingress-nginx-namespace> logs deploy/<name>-ingress-nginx-controller --since=30m | grep -iE 'error|invalid' | tail
kubectl -n <namespace> get ingress <ingress-name> -o yaml > /tmp/<ingress-name>.yaml
kubectl -n <namespace> delete ingress <ingress-name>
```

### Cause 6: requests wait about 131 seconds for a stale upstream, then succeed

Only when the access log shows the two-upstream `502, 200` pattern and an EndpointSlice of the Service lists an address that should not be there, delete that residual EndpointSlice. The requests then stop trying the old upstream. Avoid hand-made Endpoints for Services that have a selector.

> **Warning:** Only delete a slice that contains the stale address. Deleting the wrong slice removes healthy endpoints until the controller recreates them. Save the slice YAML first; to roll back, apply it.

```bash
kubectl -n <namespace> get endpointslices -o wide
kubectl -n <namespace> get endpoints <service-name> -o yaml
kubectl -n kube-system logs <kube-controller-manager-pod> --since=1h | grep -i 'mirroring EndpointSlices'
kubectl -n <namespace> get endpointslices <slice-name> -o yaml > /tmp/<slice-name>.yaml
kubectl -n <namespace> delete endpointslices <slice-name>
```

### Cause 7: saving an Ingress fails on 4.0 when the Higress gateway is used

Add `check-ingress` to the `--disable-webhook` startup argument of the `metis` Deployment in `cpaas-system`, as in Cause 9.

### Cause 8: an Ingress with a configuration-snippet is rejected with an inject-label.cpaas.io webhook error

Enable snippet annotations and raise the allowed annotation risk level in the controller's global configuration (`spec.controller.config` of the IngressNginx resource):

```yaml
spec:
  controller:
    config:
      allow-snippet-annotations: "true"
      annotations-risk-level: "Critical"
```

> **Warning:** Snippet annotations let anyone who can edit an Ingress inject raw nginx configuration into the shared controller, which affects every host it serves. Do this only when Ingress write access is limited to trusted users. To roll back, remove both keys from `spec.controller.config`.

### Cause 9: a gray-release Ingress with the same host and path as the primary Ingress is rejected by metis

Long-term fix: upgrade to ACP 4.3, where the argument is set automatically. On an earlier release, add `check-ingress` to the `--disable-webhook` argument of the `metis` Deployment. If the container already has a `--disable-webhook` argument, add `check-ingress` to it rather than adding a second flag. Only the Ingress duplicate host and path check is disabled.

```bash
kubectl -n cpaas-system get deploy metis -o jsonpath='{.spec.template.spec.containers[*].args}{"\n"}'
```

> **Warning:** Only when the error comes from the `metis` webhook and, for a gray release, the rejected Ingress intentionally shares host and path with another Ingress. Impact: the platform's Ingress check is turned off for every Ingress in the cluster, so accidental duplicate hosts and paths are no longer caught at admission, and the edit rolls the `metis` Pods. Save the Deployment YAML first. To roll back, remove `check-ingress` from `--disable-webhook` again and wait for the rollout.

```bash
kubectl -n cpaas-system get deploy metis -o yaml > /tmp/metis-deploy.before.yaml
kubectl -n cpaas-system edit deployments.apps metis
kubectl -n cpaas-system rollout status deploy/metis
```

```yaml
args:
  - --disable-webhook=check-ingress
```

Then create or save the Ingress again. After an upgrade, read the arguments again to confirm the setting.

## Diagnostic Steps

1. Which certificate is served, and where the Ingress takes it from. `CN=Kubernetes Ingress Controller Fake Certificate` with an empty `spec.tls` is Cause 1; a dedicated `spec.tls` on one Ingress and HTTP-only Ingress objects for the same host is Cause 2:

   ```bash
   openssl s_client -connect 192.0.2.10:443 -servername app.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
   kubectl -n <namespace> get ingress <ingress-name> -o jsonpath='{.spec.tls}{" "}{.metadata.annotations}{"\n"}'
   ```

2. Instances, their scope and classes (Causes 3 and 4):

   ```bash
   kubectl get ingressnginxes.ingress-nginx.alauda.io -A
   kubectl get ingressclass
   ```

3. Upstream attempts per request (Cause 6). Two upstream addresses and two statuses in one access-log line mean a retry after a dead endpoint:

   ```bash
   kubectl -n <ingress-nginx-namespace> logs deploy/<name>-ingress-nginx-controller --since=30m | grep 'Operation timed out' | tail -n 3
   kubectl -n <namespace> get endpointslices -l kubernetes.io/service-name=<service-name> -o yaml | grep -n -E 'name:|addresses'
   ```

4. Admission failures on save show the webhook name in the API error (Causes 7, 8 and 9). List the webhooks and the `metis` arguments, and for a gray release confirm the duplicate host and path:

   ```bash
   kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations | grep -iE 'ingress|inject-label|metis'
   kubectl -n cpaas-system get deploy metis -o jsonpath='{.spec.template.spec.containers[*].args}{"\n"}' | grep -o 'disable-webhook=[^"]*'
   kubectl -n <namespace> get ingress -o custom-columns='NAME:.metadata.name,HOSTS:.spec.rules[*].host,PATHS:.spec.rules[*].http.paths[*].path'
   ```
