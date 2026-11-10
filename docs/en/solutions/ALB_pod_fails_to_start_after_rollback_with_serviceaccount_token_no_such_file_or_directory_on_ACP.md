---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
---

# ALB pod fails to start after rollback with serviceaccount token no such file or directory on ACP

## Issue

After an ALB upgrade caused application errors, the ALB was rolled back urgently: the ALB operator version was set back to the version shipped with ACP 3.16, and the Deployment of the ALB instance was deleted so that the operator would recreate it. The recreated ALB pod does not start. Its log shows:

```text
driver: use InClusterConfig
"lifecycle: get rest cfg fail" err="open /var/run/secrets/kubernetes.io/serviceaccount/token: no such file or directory"
"run fail" err="open /var/run/secrets/kubernetes.io/serviceaccount/token: no such file or directory"
```

The startup configuration printed by the pod shows `"K8s": {"Mode": "incluster", ...}`. The pod exits and restarts in a loop, and the traffic served by that ALB is not restored.

## Root Cause

The rolled-back ALB runs in in-cluster mode: it builds its Kubernetes client from the ServiceAccount token at the standard path `/var/run/secrets/kubernetes.io/serviceaccount/token`.

That file only exists when Kubernetes mounts the ServiceAccount token into the pod. The ServiceAccount used by the ALB in `cpaas-system` has `automountServiceAccountToken: false`, and the pod created after the rollback does not mount the token itself, so the file is missing. Without the token the ALB cannot create its REST client and exits.

## Resolution

1. Find the ServiceAccount used by the ALB Deployment:

   ```bash
   kubectl -n cpaas-system get deploy <alb-name> -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
   ```

2. Enable automatic token mounting on that ServiceAccount:

   ```bash
   kubectl -n cpaas-system patch sa <service-account-name> -p '{"automountServiceAccountToken": true}'
   ```

   To revert this change later, apply the same patch with `false`.

3. Restart the ALB pods so that they are recreated with the token mounted.

   > **Warning:** Deleting an ALB pod interrupts the traffic it serves until the new pod is ready. Do this only after the `serviceaccount/token: no such file or directory` error is confirmed in the pod log. If the ALB has several replicas, delete one pod at a time and wait for it to become `Running` before the next. Pods are recreated by the Deployment, so no rollback is needed for this step.

   ```bash
   kubectl -n cpaas-system get pods -o wide | grep <alb-name>
   kubectl -n cpaas-system delete pod <alb-pod-name>
   ```

4. Confirm the new pod is `Running`, its log no longer shows the token error, and the applications behind the ALB respond again.

## Diagnostic Steps

1. Read the log of the failing ALB pod. The `get rest cfg fail` and `serviceaccount/token: no such file or directory` lines identify this issue:

   ```bash
   kubectl -n cpaas-system logs <alb-pod-name> --previous | grep -E 'InClusterConfig|rest cfg|serviceaccount/token'
   ```

2. Check whether the token is mounted. Expected for this issue: the ServiceAccount prints `false`, and the pod has no volume mounted at `/var/run/secrets/kubernetes.io/serviceaccount`:

   ```bash
   kubectl -n cpaas-system get sa <service-account-name> -o jsonpath='{.automountServiceAccountToken}{"\n"}'
   kubectl -n cpaas-system get pod <alb-pod-name> \
     -o jsonpath='{.spec.automountServiceAccountToken}{"\n"}{range .spec.containers[*].volumeMounts[*]}{.mountPath}{"\n"}{end}'
   ```

3. After the fix, the pod spec lists a mount at `/var/run/secrets/kubernetes.io/serviceaccount` and the log no longer reports the token error.
