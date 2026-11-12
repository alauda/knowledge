---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.10"
---

# Image tag cannot be selected in Update Image Version because the integration repositories request returns 500

## Issue

In the container platform, the image tag cannot be selected in the **Update Image Version** dialog of a Deployment container. The tag dropdown stays empty or fails to load, although the repository in Harbor has tags. The failure is intermittent: the same dialog sometimes works and sometimes does not. The browser developer tools show the failing request returning `500` after about 10 seconds with this body:

```json
{
  "metadata": {},
  "status": "Failure",
  "message": "Internal error occurred: unexpected error when reading response body. Please retry. Original error: net/http: request canceled (Client.Timeout or context cancellation while reading body)",
  "reason": "InternalError",
  "code": 500
}
```

The `harbor-core` log repeats `[panic.go:969] Handler crashed with error net/http: abort Handler`, while every Harbor component is Running and none restarts often.

## Root Cause

### Cause 1: katanomi has run for a very long time without a restart, and its repository list requests to Harbor time out

The dialog reads registry data through the DevOps v3 toolchain Harbor integration, which is served by katanomi (`katanomi-api`, `katanomi-plugin`, and `katanomi-controller` in `cpaas-system`, and `katanomi-operator` in `operators`).

The dialog first lists registry projects (`GET .../projects?includeType=ImageRegistry&itemsPerPage=100&page=1`), and that call returns `200`. It then lists the repositories of the selected Harbor project:

```text
GET /integrations/v1alpha1/namespaces/<namespace>/integrations/<harbor-integration>/projects/<harbor-project>/repositories?itemsPerPage=100&page=1
```

That call fails with the `500` above after about 10 seconds. When the katanomi Pods have been running for a very long time (for example about two years without a restart), they accumulate cached state, and with that state the repository list requests to Harbor time out. The integration API returns the timeout to the browser as `InternalError`. The `abort Handler` panic in `harbor-core` accompanies these timeouts and is consistent with Harbor's handler being aborted because the caller gave up the request, which is why Harbor itself looks healthy.

Restarting the katanomi components, including the `katanomi-operator` Pod, reloads that state, and tag selection works again.

## Resolution

### Cause 1: katanomi has run for a very long time without a restart, and its repository list requests to Harbor time out

1. Capture the requests in the browser developer tools (Network tab) while opening the tag dropdown. This cause needs both: `projects?includeType=ImageRegistry...` returns `200`, and `repositories?itemsPerPage=100&page=1` returns `500` with `Client.Timeout or context cancellation while reading body`. An empty `200` answer is not this cause.

2. Confirm that Harbor has the repositories and answers directly, so that the fault is on the integration side:

   ```bash
   curl -sk -u '<harbor-user>:<harbor-password>' --max-time 30 \
     -w '\ncode=%{http_code} time=%{time_total}\n' \
     'https://<harbor-host>/api/v2.0/projects/<harbor-project>/repositories?page=1&page_size=100'
   kubectl -n <harbor-namespace> get pods
   kubectl -n <harbor-namespace> logs <harbor-core-pod> --tail=300 | grep -c 'abort Handler'
   ```

3. Read the katanomi Pod ages and restart counts:

   ```bash
   kubectl get pods -A -o wide | grep katanomi
   ```

   Running katanomi Pods that are months or years old, with Harbor answering on its own, match this cause. A katanomi Pod in `CrashLoopBackOff` is a different fault.

4. Save the logs, then restart the katanomi Pods.

   > **Warning:** Deleting the katanomi Pods makes DevOps pages, toolchain integrations, image and tag selectors, and pipeline triggers unavailable on that cluster until the new Pods are Ready. Running TaskRun Pods are not deleted. Precondition: only when the `repositories` call returns `500` with `Client.Timeout or context cancellation while reading body`, Harbor answers the same listing directly, and the katanomi Pods are Running. Do it in a quiet period. Rollback: none needed; the owners recreate the Pods from an unchanged spec.

   ```bash
   mkdir -p /tmp/katanomi-logs
   for p in $(kubectl -n cpaas-system get pods -o name | grep katanomi); do
     kubectl -n cpaas-system logs "$p" --all-containers --tail=500 > "/tmp/katanomi-logs/$(basename "$p").log"
   done
   kubectl -n cpaas-system delete pod <katanomi-api-pod> <katanomi-plugin-pod> <katanomi-controller-pod>
   kubectl -n operators delete pod <katanomi-operator-pod>
   kubectl get pods -A | grep katanomi
   ```

5. Open the **Update Image Version** dialog again, several times, because the fault was intermittent. The `repositories` request returns `200` well within 10 seconds and the tags are listed. If the `500` returns soon after the restart, keep the saved katanomi logs and the `harbor-core` log for the support team.

## Diagnostic Steps

```bash
kubectl get pods -A -o wide | grep katanomi
kubectl -n <harbor-namespace> get pods
kubectl -n <harbor-namespace> logs <harbor-core-pod> --tail=300 | grep 'abort Handler'
```

- Browser: `repositories?itemsPerPage=100&page=1` returns `500` with `Client.Timeout or context cancellation while reading body`, Harbor is healthy, and the katanomi Pods are very old: Cause 1.
- The image dropdown is empty in one environment only, with no `500`, and the platform project is not assigned to the Harbor project in the toolchain integration: see "Harbor toolchain integration fails: images not selectable, katanomi-plugin timeout, or push asks for credentials".
- A tag that cannot be selected in an artifact promotion form, not in the Update Image Version dialog, is a different problem.
