---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.3"
---

# Harbor toolchain integration fails: images not selectable, katanomi-plugin timeout, or push asks for credentials

## Issue

A Harbor toolchain integration of DevOps v3 is configured and does not work. One of these symptoms is shown:

- Harbor images cannot be selected from the dropdown when a service is created in one environment (for example production), while another environment (for example test) works.
- The Harbor integration fails with `katanomi-plugin.cpaas-system.svc.cluster.local i/o timeout`.
- A pipeline image push fails saying that Harbor credentials are required, and at the same time the Harbor integration in the toolchain shows an error.

These integrations are served by katanomi (`katanomi-api` and `katanomi-plugin` in `cpaas-system`). Related articles: "GitLab toolchain integration fails: token-gitlab not found, Internal error, projects API 500, or an extra bot project" covers the GitLab integration; "Image tag cannot be selected in Update Image Version because the integration repositories request returns 500" covers a tag dropdown that fails with `500` and `Client.Timeout`.

## Root Cause

### Cause 1: the platform project is not assigned in the Harbor toolchain project

Image tags appear in the service creation dropdown only after the platform project has been assigned to the Harbor toolchain project. When one environment has the assignment and the other does not, only the first one lists images.

### Cause 2: the full `svc.cluster.local` name of `katanomi-plugin` does not resolve

The integration URLs are generated with the `.cluster.local` suffix. On the affected cluster (Kubernetes `v1.33.7`), `http://katanomi-plugin.cpaas-system.svc` and `http://katanomi-plugin.cpaas-system` answered from a Pod, while the names ending in `.svc.cluster` and `.svc.cluster.local` did not resolve. Harbor did not accept a change that drops the suffix. Setting `ndots: 1` in the `dnsConfig` of the `katanomi-api` Deployment restores the Harbor integration as a workaround. Why the full name did not resolve on that cluster was not determined, so cluster DNS still needs investigation.

### Cause 3: a firewall blocks katanomi from reaching Harbor

The pipeline push and the toolchain integration fail together, while all Pods on the global cluster are Running. A connectivity test from katanomi to Harbor fails: katanomi cannot reach Harbor at all, because a firewall in front of the Harbor address (for example on the VIP side) blocks that traffic. The push cannot obtain the integration's credentials, so it reports that credentials are required, although the credentials themselves are correct. Removing the matching firewall rules restores both the integration and the push.

## Resolution

### Cause 1: the platform project is not assigned in the Harbor toolchain project

Open the Harbor toolchain integration in the failing environment and assign the platform project to the Harbor project that holds the images. Projects are assigned individually. Then open service creation again. The image and tag dropdowns list the Harbor images.

### Cause 2: the full `svc.cluster.local` name of `katanomi-plugin` does not resolve

1. Test the names from a Pod:

   ```bash
   kubectl -n <namespace> exec <running-pod> -- curl -sv -o /dev/null http://katanomi-plugin.cpaas-system.svc
   kubectl -n <namespace> exec <running-pod> -- curl -sv -o /dev/null http://katanomi-plugin.cpaas-system.svc.cluster.local
   ```

   The short name answering and the full name timing out is this cause.

2. Set `ndots: 1` on `katanomi-api`.

   > **Warning:** Patching `katanomi-api` restarts it. If the katanomi operator renders this Deployment, the patch can be reverted on its next reconcile. Precondition: only when the Harbor integration fails with this exact timeout and the short Service name resolves. Save the Deployment first. Rollback: remove the `dnsConfig` again with the second command below.

   ```bash
   kubectl -n cpaas-system get deploy katanomi-api -o yaml > /tmp/katanomi-api.yaml
   kubectl -n cpaas-system patch deploy katanomi-api --type='merge' -p '{"spec":{"template":{"spec":{"dnsConfig":{"options":[{"name":"ndots","value":"1"}]}}}}}'
   kubectl -n cpaas-system rollout status deploy/katanomi-api
   # rollback:
   # kubectl -n cpaas-system patch deploy katanomi-api --type=json -p '[{"op":"remove","path":"/spec/template/spec/dnsConfig"}]'
   ```

3. The Harbor integration completes. This is a workaround; keep investigating why the `.cluster.local` names do not resolve in cluster DNS.

### Cause 3: a firewall blocks katanomi from reaching Harbor

1. Check for unhealthy Pods, then test Harbor from inside a katanomi Pod, not from a node:

   ```bash
   kubectl get po -A | grep -vi running
   kubectl -n cpaas-system exec deploy/katanomi-api -- curl -skv -o /dev/null --max-time 10 https://<harbor-address>/api/v2.0/ping
   ```

   If the image has no `curl`, run the same request from another Pod on the same cluster. A timeout or `No route to host` while Harbor itself is up is this cause. A fast HTTP answer means the path is open and the error is elsewhere (Cause 2 for a `katanomi-plugin` timeout).

2. Trace the path from the cluster to the Harbor address, including any VIP in front of Harbor, and have the network owner remove the rule that drops this traffic. Change only the rules that match this traffic.

3. The Harbor integration is healthy again, and the image push completes without a credentials error.

## Diagnostic Steps

```bash
kubectl get pods -A | grep -E 'katanomi-api|katanomi-plugin'
kubectl -n cpaas-system logs deploy/katanomi-api --tail=100 | grep -Ei 'harbor|timeout|500'
```

- Harbor images missing in one environment only, with no error status in the browser: Cause 1.
- `katanomi-plugin.cpaas-system.svc.cluster.local i/o timeout`, and the short Service name resolves: Cause 2.
- The image push asks for Harbor credentials, the Harbor integration shows an error, and katanomi cannot connect to Harbor: Cause 3.
- The tag dropdown request `repositories?itemsPerPage=100&page=1` returns `500` with `Client.Timeout ... while reading body`: not one of these causes; see "Image tag cannot be selected in Update Image Version because the integration repositories request returns 500".
- Harbor integration health-check warnings that appear only during a network change and disappear when the network is stable need no action.
