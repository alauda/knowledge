---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Security scan reports a weak Grafana admin password equal to the username on ACP

## Issue

A security scan of a cluster's monitoring endpoint reports a weak password on the Grafana login page, for example on a URL of the form:

```text
http://<platform-address>:11780/clusters/<cluster>/grafana/login
```

The finding says that the Grafana `admin` user accepts the password `admin`, the same as the username. Operators then ask whether Grafana has a password of its own, separate from the platform login, and where to change it.

## Root Cause

### Cause 1: the platform Grafana admin password is still `admin`

The platform Grafana runs in the `cpaas-system` namespace of each cluster (Pods named `kube-prometheus-grafana-<hash>`). It has its own `admin` account, separate from platform users, and that account's password is stored in Grafana itself. When the password has not been changed, it is `admin`, the same as the username, and the scanner reports it as a weak credential.

The platform also keeps the Grafana credentials in the Secret `kube-prometheus-grafana-basic-auth` in `cpaas-system`. The Secret has the keys `username`, `password`, `guestUsername` and `guestPassword`. In this state, `username` and `password` both decode to `admin`. The password in Grafana and the `password` value in this Secret must match. So a password change has to be made in both places, and the `prometheus` and `warlock` components of that cluster are restarted afterwards.

## Resolution

### Cause 1

Run the steps on the cluster named in the scanned URL (`/clusters/<cluster>/grafana`), with `kubectl` access to that cluster. Choose the new password first; `<new-password>` below stands for it.

1. Find the Grafana Pod:

   ```bash
   kubectl -n cpaas-system get pod | grep kube-prometheus-grafana
   ```

2. Back up the credentials Secret and decode its current values:

   ```bash
   kubectl -n cpaas-system get secret kube-prometheus-grafana-basic-auth -o yaml > kube-prometheus-grafana-basic-auth.bak.yaml
   kubectl -n cpaas-system get secret kube-prometheus-grafana-basic-auth -o jsonpath='{.data.username}' | base64 -d; echo
   kubectl -n cpaas-system get secret kube-prometheus-grafana-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
   ```

   `admin` and `admin` confirm the finding.

3. Reset the Grafana admin password inside the Grafana Pod.

   > **Warning:** Impact: from this step until the Secret is updated in step 4, the password in Grafana and the copy in the Secret differ. Platform features that log in to Grafana with the Secret can fail during that time. Precondition: the backup from step 2 exists, and you run step 4 right after this one. Rollback: run the same command again with the old password (the value decoded in step 2), then restore the Secret with `kubectl apply -f kube-prometheus-grafana-basic-auth.bak.yaml`. Rolling back brings the weak password back.

   ```bash
   kubectl -n cpaas-system exec -it <kube-prometheus-grafana-pod> -- \
     grafana-cli --homepath=/usr/share/grafana admin reset-admin-password '<new-password>'
   ```

   If the Pod has more than one container, add `-c <grafana-container>` (list the containers with `kubectl -n cpaas-system get pod <kube-prometheus-grafana-pod> -o jsonpath='{.spec.containers[*].name}'`).

4. Write the same password into the Secret. Change only the `password` key, and leave `username`, `guestUsername` and `guestPassword` unchanged:

   ```bash
   NEW_B64=$(echo -n '<new-password>' | base64 -w0)
   kubectl -n cpaas-system patch secret kube-prometheus-grafana-basic-auth \
     --type merge -p "{\"data\":{\"password\":\"${NEW_B64}\"}}"
   kubectl -n cpaas-system get secret kube-prometheus-grafana-basic-auth -o jsonpath='{.data.password}' | base64 -d; echo
   ```

   The last command must print the new password exactly.

5. Restart `prometheus` and `warlock` on the same cluster.

   > **Warning:** Impact: while the Pods restart, metric queries, monitoring charts and alert evaluation on this cluster are briefly unavailable, and a short gap can appear in the collected data. Precondition: steps 3 and 4 are done and the Secret prints the new password. Rollback: none needed for a restart, because the controllers recreate the Pods. Choose a low-traffic time.

   ```bash
   kubectl get pods -A | grep -E 'warlock|prometheus'
   kubectl -n <namespace> delete pod <warlock-pod>
   kubectl -n <namespace> delete pod <prometheus-pod>
   kubectl get pods -A | grep -E 'warlock|prometheus'
   ```

   Delete the Pods of the `warlock` and Prometheus workloads that the first command prints. Do not delete the Grafana Pod in this step. Wait until the recreated Pods are `Running` and ready.

6. Verify and rescan. In the commands below, `<grafana-base-url>` is the scanned URL without the trailing `/login`, for example `http://<platform-address>:11780/clusters/<cluster>/grafana`:

   ```bash
   curl -sk -u 'admin:admin' -o /dev/null -w '%{http_code}\n' '<grafana-base-url>/api/user'
   curl -sk -u 'admin:<new-password>' -o /dev/null -w '%{http_code}\n' '<grafana-base-url>/api/user'
   ```

   Expect `401` for `admin:admin` and `200` for the new password. Then open the cluster monitoring pages and Grafana from the platform console, check that they still load, and run the security scan again.

## Diagnostic Steps

1. Confirm that the platform Grafana runs on the scanned cluster:

   ```bash
   kubectl -n cpaas-system get pod | grep kube-prometheus-grafana
   kubectl -n cpaas-system get secret | grep grafana
   ```

   Expected: a `Running` `kube-prometheus-grafana-<hash>` Pod and the Secret `kube-prometheus-grafana-basic-auth`. If there is no Grafana Pod, the scanned address belongs to a different Grafana, not to the platform one in `cpaas-system`. If the Secret has another name, use the name printed here in the Resolution steps.

2. Confirm the weak credential from a host that can reach the scanned URL:

   ```bash
   curl -sk -u 'admin:admin' -o /dev/null -w '%{http_code}\n' '<grafana-base-url>/api/user'
   ```

   Expected: `200` while the weak password is still active, and `401` after the fix.

3. After the change, check that Grafana and the Secret hold the same password. Decode the Secret as in step 2 of the Resolution, then test that value against Grafana with the second `curl` in step 6. A `401` for the Secret's value means the two differ. Repeat step 4 with the password that was set in Grafana, then repeat step 5.

4. If the console reports `dial tcp <address>:11780: i/o timeout` when it opens Grafana, the problem is network reachability of port `11780`, not the password. See [Workload cluster abnormal or monitoring empty in the console because global cannot reach its ports on ACP](Workload_cluster_abnormal_or_monitoring_empty_in_the_console_because_global_cannot_reach_its_ports_on_ACP.md).
