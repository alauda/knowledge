---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Console returns HTTP 500 or clusters show abnormal because the global-kubeconfig or cluster kubeconfig Secret expired on ACP

## Issue

The platform suddenly cannot be opened after running for about one year. Any of the following can be seen:

- The page shows "Internal server error. System exception, please contact the platform administrator", `/console-portal/` returns HTTP 500, or login fails (`平台无法登录`, the platform cannot be logged in). Many platform API calls return 500 at the same time.
- The two `apollo` Pods in `cpaas-system` are `0/1 CrashLoopBackOff`. Their log shows `Updated current TLS certificate` and `Starting certificate watcher`, then `ERROR cache New cache error:could not create RESTMapper from config` and `Error: failed to initialize dexClientMgr: could not create RESTMapper from config`. Other `cpaas-system` Pods can be `Pending` or `CrashLoopBackOff`.
- `kubectl get cls` on the global cluster shows the global or a business cluster as `failed` or abnormal. Global component logs contain `Unauthorized` or `the server has asked for the client to provide credentials`.
- The cluster management page shows every node of a cluster as abnormal and leaves CPU, memory, storage, pod count, and system load empty, while `kubectl get nodes` on that cluster prints Ready.
- After the global platform was recovered, a business cluster stays abnormal and its nodes cannot be operated, although `kubectl` on that cluster works and port 6443 is reachable from global.
- A disaster-recovery standby global cannot be opened.

On the control-plane nodes, `kubectl` often fails at the same time with `You must be logged in to the server` unless `--kubeconfig` is passed. That node file is a separate credential, covered in "Node kubectl fails with You must be logged in to the server or an alert names root kube config on ACP".

## Root Cause

### Cause 1: the client certificate in cpaas-system/global-kubeconfig expired

Secret `global-kubeconfig` in namespace `cpaas-system` holds the platform-side kubeconfig that the console and platform controllers use to reach the global cluster. Under Cluster API, kubeadm issues its client certificate with a default validity of one year. On the affected releases this certificate is not renewed automatically, which is a known defect. About one year after installation it expires; platform authentication fails, `apollo` cannot create its RESTMapper and stops starting, the console returns HTTP 500, and cluster status on global goes abnormal. Restarting `apollo` alone does not help.

Backing up and deleting the Secret makes the platform regenerate it with a renewed certificate, after which the clusters and `apollo` recover. Judge expiry by `notAfter` only: kubeadm-style signing can copy the CA's `notBefore` into the client certificate, so the gap between the two dates is not always the issued lifetime.

Automatic renewal of this Secret is fixed in these releases:

| Version line | Status |
|---|---|
| 4.3 | Fixed since 4.3.0 |
| 4.2 | Fixed in 4.2.5; earlier 4.2 releases are affected |
| 4.1 | Fix targeted for 4.1.6; check the release notes of your version |
| 4.0 | Fix targeted for 4.0.10; check the release notes of your version |

After an upgrade to a release later than 4.2.6, the certificate issued in `global-kubeconfig` is valid for 10 years. Automatic renewal only prevents expiry: a Secret that is already past `notAfter` must be recreated with the procedure below on any version, including a fixed one. A disaster-recovery standby global has its own `global-kubeconfig` and needs the same renewal.

### Cause 2: the client certificate in cpaas-system/<cluster>-kubeconfig expired

Each business cluster has its own Secret in `cpaas-system` on global, named `<cluster>-kubeconfig`, which the platform uses to reach that cluster. It has the same one-year client certificate, the same defect, and the same fixed versions as Cause 1. When it expires, the console shows that cluster as abnormal, blanks its node utilization, and cannot operate its nodes, while the cluster itself is healthy. After `global-kubeconfig` was recreated, a business cluster whose own Secret is hundreds of days old in the `AGE` column stays abnormal until its Secret is recreated too.

## Resolution

Use a working `kubectl` on a global control-plane node. If `/root/.kube/config` on that node is also expired, pass `--kubeconfig /etc/kubernetes/admin.conf` on each command, or fix the node file first as described in "Node kubectl fails with You must be logged in to the server or an alert names root kube config on ACP". Check first that the `admin.conf` client certificate has a future `notAfter`:

```bash
awk '/client-certificate-data/ {print $2}' /etc/kubernetes/admin.conf | base64 -d | openssl x509 -noout -dates
```

### Cause 1: the client certificate in cpaas-system/global-kubeconfig expired

1. List the data keys of the Secret and print the end date of the client certificate. The kubeconfig is either under key `value`, or `client-certificate-data` is at the top level of the Secret:

   ```bash
   kubectl get secret -n cpaas-system global-kubeconfig -o go-template='{{range $k, $v := .data}}{{printf "%s\n" $k}}{{end}}'
   # kubeconfig under key value
   kubectl get secret -n cpaas-system global-kubeconfig -o jsonpath='{.data.value}' \
     | base64 -d | awk '/client-certificate-data/ {print $2}' | base64 -d \
     | openssl x509 -noout -subject -dates
   # client-certificate-data at the top level
   kubectl get secret -n cpaas-system global-kubeconfig -o jsonpath='{.data.client-certificate-data}' \
     | base64 -d | openssl x509 -noout -subject -dates
   ```

   Continue only when `notAfter` is in the past. If it is in the future, this is not the cause: check `apollo`, node clocks, and node readiness instead. When nothing is broken and the question is only whether the certificate expires, answer from the dates and delete nothing. A planned renewal of a Secret that is within days of `notAfter` can be done the same way in a maintenance window.

2. Back up and delete the Secret, and wait for the platform to regenerate it.

   > **Warning:** Deleting `cpaas-system/global-kubeconfig` removes the platform's own credential until the platform regenerates it; the console stays unavailable during that gap. Do this only when step 1 shows the certificate is expired (or within days of expiry, for a planned renewal), and only from a node where `admin.conf` works. The backup contains a client key: keep it at mode `0600` and remove it once the new end date is confirmed. Rollback is `kubectl apply -f` of the backup, which restores the old (expired) credential. On a disaster-recovery pair, repeat on the standby global.

   ```bash
   umask 077
   kubectl get secret -n cpaas-system global-kubeconfig -o yaml > "$HOME/global-kubeconfig.yaml"
   kubectl delete secret -n cpaas-system global-kubeconfig
   kubectl get secret -n cpaas-system global-kubeconfig
   ```

3. Print the end date again with the command from step 1; it must be in the future. Then check that `apollo` starts and the console opens:

   ```bash
   kubectl get pods -A | grep apollo
   ```

4. If `apollo` or other platform Pods are still not Ready after the new `notAfter` is in the future, or the UI and business cluster list still return 401 or 500, restart the Pods that log authentication errors, starting with `apollo`. If the global cluster status stays `failed` and `apollo` still logs a certificate error, restart the platform component `api`.

   > **Warning:** Deleting the `apollo`, `erebus`, `courier`, or `api` Pod interrupts console and cluster-proxy calls served by it until the new Pod is Running. Do this only when the recreated `global-kubeconfig` already shows a future `notAfter` and the symptoms remain. The workload recreates the Pod; there is nothing to roll back.

   ```bash
   kubectl get pods -n cpaas-system --no-headers | awk '$1 ~ /apollo|erebus|courier/ {print}'
   kubectl get deploy,sts -A | grep -w api
   kubectl delete pod -n <namespace> <pod-name>
   ```

5. For a lasting fix, upgrade to a release where the Secret is renewed automatically (table in Cause 1).

### Cause 2: the client certificate in cpaas-system/<cluster>-kubeconfig expired

1. List the cluster kubeconfig Secrets on global and print each embedded client certificate. Skip Secrets whose `notAfter` is still in the future.

   ```bash
   kubectl get secret -n cpaas-system | grep kubeconfig
   kubectl get secret -n cpaas-system <cluster>-kubeconfig -o jsonpath='{.data.value}' \
     | base64 -d | awk '/client-certificate-data/ {print $2}' | base64 -d \
     | openssl x509 -noout -dates -subject -issuer
   ```

   If `value` is empty, list the data keys as in step 1 of Cause 1 and decode the entry that holds the client certificate.

2. Back up and delete each expired Secret.

   > **Warning:** Deleting `cpaas-system/<cluster>-kubeconfig` drops the credential platform controllers use for that cluster until the Secret is recreated; the console keeps showing that cluster as abnormal during the gap. Do this only when step 1 shows the embedded client certificate is expired, one Secret at a time, and never against a Secret that was already recreated. The backup contains a client key. Rollback is `kubectl apply -f` of the backup, which brings the expired certificate and the fault back.

   ```bash
   umask 077
   kubectl get secret -n cpaas-system <cluster>-kubeconfig -o yaml > "$HOME/<cluster>-kubeconfig.yaml"
   kubectl delete secret -n cpaas-system <cluster>-kubeconfig
   kubectl get secret -n cpaas-system <cluster>-kubeconfig -o jsonpath='{.data.value}' \
     | base64 -d | awk '/client-certificate-data/ {print $2}' | base64 -d \
     | openssl x509 -noout -enddate
   ```

3. Wait until the new `notAfter` is in the future, then check the cluster on global:

   ```bash
   kubectl get cls <cluster> -o yaml
   ```

   The conditions `HealthCheck`, `Ready`, `ControlPlaneInitialized`, `ControlPlaneReady`, and `InfrastructureReady` should be `"True"` and `phase` should be `Running`. If the cluster is still abnormal, restart the Pods as in step 4 of Cause 1.

## Diagnostic Steps

1. Check node readiness and the Pods that are not Running. Recreating `global-kubeconfig` does not help when a global node is NotReady; fix the node first.

   ```bash
   kubectl --kubeconfig /etc/kubernetes/admin.conf get nodes
   kubectl get pods -n cpaas-system --no-headers | awk '$3 !~ /^Running$/ {print}'
   kubectl logs -n cpaas-system <apollo-pod> --tail=50 | grep -i -E 'dexClientMgr|RESTMapper|certificate'
   ```

2. A quick hint that the credentials are due is the node `AGE` column: nodes at about `365d` mean the kubeconfig Secrets of that cluster were issued about a year ago.

3. Print `notAfter` of `global-kubeconfig` and of each `<cluster>-kubeconfig` with the commands in the Resolution, including on the standby global of a disaster-recovery pair.

4. Branch:

   - `global-kubeconfig` past `notAfter`, console 500 or `apollo` logging `could not create RESTMapper from config`: Cause 1.
   - The console works, but one business cluster stays abnormal and its `<cluster>-kubeconfig` is past `notAfter`: Cause 2.
   - Both Secrets are in date and the log module and monitoring dashboard are what fail after more than a year of kube-apiserver uptime: see "Log module and monitoring dashboard unavailable after a kube-apiserver internal certificate expires on ACP".
