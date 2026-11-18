---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.1.x
  - 4.2.x
  - 4.3.x
---

# Metrics Service availability alert is not 1 while the target Pod looks healthy on ACP

## Issue

The real-time alert page reports that the availability of a Metrics Service obtained by Prometheus is not 1 (`the availability of Metrics Service != 1`), or "Prometheus failed to fetch metrics" (`Prometheus获取metrics异常`), or a node kubelet health alert. The rule stays firing for one or three minutes and sometimes clears by itself, often over and over. The Service named in the alert and its Pods are `Running`. `curl` from inside the Pod returns metrics, or an anonymous request to the Service returns HTTP 403, which only shows that the process answers. In vmagent targets the endpoint is `down`, or `up` for that Service is `0`.

The built-in rule on a cluster has this shape (the `vmcluster` label is the cluster name):

```promql
max by (namespace, service) (up{vmcluster="<cluster-name>",service!="kube-prometheus-exporter-dockerd",job!="apiserver",job!="kube-controller-manager",job!="kube-scheduler",job!="kubelet",job!="kube-dns",job!="kube-etcd"}) != 1
```

The alert reports that a scrape failed. Each cause below is a different reason for the failed scrape.

## Root Cause

### Cause 1: the node firewall blocks the metrics port

`curl` of `/metrics` inside the Pod succeeds. From another node the same endpoint IP and port fails with `No route to host` or `Failed to connect`, and vmagent lists the target as `down`. The host firewall zone on the node that hosts the endpoint does not allow the metrics port, for example `10254` of an ingress-nginx controller metrics Service. This is covered in detail in Cause 3 of [Node firewall or iptables rules block kubelet 10250, metrics 10254 or control-plane traffic on ACP](Node_firewall_or_iptables_rules_block_kubelet_10250_metrics_10254_or_control_plane_traffic_on_ACP.md).

### Cause 2: calico-felix-metrics-svc is scraped while Felix metrics are disabled

`calico-felix-metrics-svc` availability is `0`. The `calico-node` template sets `FELIX_PROMETHEUSMETRICSENABLED=false`, but the Service is still exposed on port `9091` with selector `k8s-app=calico-node`, so monitoring scrapes an endpoint that is turned off. After an upgrade to 4.3.2 (cpaas-calico chart `v4.3.30`) the same state was found with Endpoints on `<ip>:9091`; there the Service was confirmed as no longer used, left over from before the upgrade.

### Cause 3: the metrics backend is OOMKilled, so the alert clears by itself

Availability drops below 1 and later recovers with no scrape change. The backend named by the alert is restarting with `OOMKilled` (for example `clickhouse-operator`). Each restart takes the metrics endpoint away until the Pod is back.

### Cause 4: cluster-enhancer-apiserver scrape duration reaches the scrape timeout

The alert names `cpaas-system` / `cluster-enhancer-apiserver`, and `up` is `0` for minutes or hours, often on a cluster where the alert is sent again and again. The Pods are `Running` with normal CPU and memory. An anonymous `curl` to port `8443` returns HTTP 403 `forbidden`, which is the expected answer of this endpoint. `scrape_duration_seconds` for job `cluster-enhancer-apiserver` sits at or above the configured scrape timeout (for example `45.001` against a timeout of `45` with a sampling interval of `60`, the VictoriaMetrics plugin defaults). The scrape does not finish inside the timeout, so `up` is `0`. This was seen with image `cluster-enhancer-apiserver:v4.2.6`.

### Cause 5: the alb image serves metrics over HTTP

"Prometheus failed to fetch metrics" fires. On the targets page `serviceMonitor/cpaas-system/kube-prometheus-cpaas-components-1/1` is `0/5 up`, and the ALB targets (ports `1936` and `11782`, endpoint `https-metrics`) report:

```text
Get "https://<node>:<port>/metrics": http: server gave HTTP response to HTTPS client
```

The `alb` image had been changed away from the version the platform ships, and that image serves its metrics over plain HTTP.

### Cause 6: kubelet health flips because one container produces duplicate metric data

The node kubelet health alert fires (rule `sum(up{job="kubelet"}) / count(up{job="kubelet"})!=1` for 1 minute), and `up{job="kubelet"}` for one node (`endpoint="https-metrics"`, port `10250`) flips between 0 and 1. Restarting kubelet and containerd does not help. Node events can repeat `Starting kubelet.`, `InvalidDiskCapacity` / `invalid capacity 0 on image filesystem`, and `NodeNotReady` followed by `NodeReady`. A request to the kubelet metrics endpoint fails as a whole because one container on that node produces a duplicate series:

```text
An error has occurred while serving metrics: collected metric "kubelet_container_log_filesystem_used_bytes" { label:<name:"container" value:"<container>" > label:<name:"namespace" value:"<namespace>" > label:<name:"pod" value:"<pod>" > ... } was collected before with the same name and label values
```

When storage on the node had been cleaned by hand earlier, leftovers most likely made that container's metric conflict.

## Resolution

### Cause 1: the node firewall blocks the metrics port

Run the checks in the linked article: the metrics path answers inside the Pod and on its own node, fails from another node, and `firewall-cmd --list-all` on the owning node does not list the port.

> **Warning:** Opening the port on the node firewall exposes that metrics port to every source the zone allows. Precondition: the three checks match. Use the active zone if it is not `public`. Rollback: `firewall-cmd --zone=public --remove-port=10254/tcp --permanent` and `firewall-cmd --reload`.

```bash
firewall-cmd --zone=public --add-port=10254/tcp --permanent
firewall-cmd --reload
```

After the next scrape the target leaves `down`.

### Cause 2: calico-felix-metrics-svc is scraped while Felix metrics are disabled

1. Confirm the mismatch:

   ```bash
   kubectl get svc -A | grep calico-felix-metrics
   kubectl -n kube-system get ds calico-node -o yaml | grep -n -A1 FELIX_PROMETHEUSMETRICSENABLED
   ```

2. Where the Service is confirmed unused (as on 4.3.2 after the upgrade), back it up and delete it.

   > **Warning:** Deleting `calico-felix-metrics-svc` removes that scrape target. Precondition: Felix metrics are disabled, the alert names this Service, and nothing else uses it. On other versions confirm that it is unused first. Rollback: `kubectl apply -f /tmp/calico-felix-metrics-svc.yaml`.

   ```bash
   kubectl -n kube-system get svc calico-felix-metrics-svc -o yaml > /tmp/calico-felix-metrics-svc.yaml
   kubectl -n kube-system delete svc calico-felix-metrics-svc
   ```

Felix metrics can be disabled on purpose, as in [Disable Calico Node Metrics Port](How_to_Disable_Calico_Node_Metrics_Port.md); in that case the Service is the leftover, not the setting.

### Cause 3: the metrics backend is OOMKilled, so the alert clears by itself

1. Confirm that the last termination is `OOMKilled` and that availability returns to 1 after each restart:

   ```bash
   kubectl get pod -A | grep <metrics-backend>
   kubectl -n <namespace> describe pod <backend-pod> | grep -E 'OOMKilled|Exit Code|Restart Count'
   ```

2. Raise memory on the object that owns that workload, above the working set that was killed.

   > **Warning:** Raising memory rolls the backend; its control loop and metrics endpoint pause until the new Pod is Ready. Precondition: the export below is saved. Rollback: set the previous memory limit on the same object.

   ```bash
   kubectl -n <namespace> get deploy <backend-deploy> -o yaml > /tmp/backend-deploy.yaml
   kubectl -n <namespace> edit deploy <backend-deploy>
   ```

   If the edit is written back within a minute, an operator or plugin owns the size; make the same change on that owner instead.

### Cause 4: cluster-enhancer-apiserver scrape duration reaches the scrape timeout

1. In vmui on the affected cluster, compare scrape duration with the timeout:

   ```promql
   scrape_duration_seconds{vmcluster="<cluster-name>",job="cluster-enhancer-apiserver"}
   ```

2. Read the current sampling interval and scrape timeout in the VictoriaMetrics plugin configuration (Marketplace > Cluster Plugins, update the VictoriaMetrics monitoring plugin of that cluster). They are stored as `spec.config.components.vmagent.scrapeInterval` and `scrapeTimeout` on its ModuleInfo, default `60` and `45`.

3. When duration is at or above the timeout, set the sampling interval to `90` and the scrape timeout to `60` in the plugin configuration and save. The interval must be greater than the timeout.

   > **Warning:** A longer timeout and interval reduce scrape frequency for every target of that vmagent and let slow scrapes hold resources longer. Precondition: `up` is 0, the Pod is Running, and `scrape_duration_seconds` is at or above the current timeout. Rollback: set the interval back to `60` and the timeout back to `45` in the same form.

4. After the next scrapes, `scrape_duration_seconds` stays below the new timeout, `up` returns to `1`, and the alert stops.

If the Pod has stayed Running with `up` at 0 for hours and the duration is not pinned at the timeout, restarting the Pod also restored scraping:

> **Warning:** Restarting `cluster-enhancer-apiserver` drops its endpoint for one start. Precondition: the duration query does not show the timeout case above. Rollback is the new Pod reaching Ready.

```bash
kubectl -n cpaas-system get pod | grep cluster-enhancer-apiserver
kubectl -n cpaas-system delete pod <cluster-enhancer-apiserver-pod>
```

HTTP 403 from an anonymous `curl` is not the reason `up` is 0; do not restart for it.

### Cause 5: the alb image serves metrics over HTTP

1. Compare the `alb` image tag with the one the platform version ships (a healthy cluster of the same version is the easiest reference):

   ```bash
   kubectl get deploy,ds -A -o wide | grep -i alb
   ```

2. Set the image back.

   > **Warning:** Changing the `alb` image rolls the ALB Pods and can briefly interrupt traffic through them. Precondition: the running image differs from the shipped one and the alert started after that change. Rollback: `kubectl apply -f /tmp/alb-deploy.yaml`.

   ```bash
   kubectl -n <alb-namespace> get deploy <alb-deploy> -o yaml > /tmp/alb-deploy.yaml
   kubectl -n <alb-namespace> set image deploy/<alb-deploy> <container>=<shipped-image>
   ```

The scrape recovers and the alert clears.

### Cause 6: kubelet health flips because one container produces duplicate metric data

1. Fetch the kubelet metrics and read the error:

   ```bash
   kubectl get --raw "/api/v1/nodes/<node>/proxy/metrics" > /tmp/kubelet-metrics.txt; echo "exit=$?"
   ```

   Or from the node, with the kubelet client certificate:

   ```bash
   curl -sk https://<node-ip>:10250/metrics --cacert /etc/kubernetes/pki/ca.crt \
     --cert /etc/kubernetes/pki/apiserver-kubelet-client.crt --key /etc/kubernetes/pki/apiserver-kubelet-client.key | head -3
   ```

2. Confirm that the Pod named in the duplicate-metric error runs on this node, then recreate it.

   > **Warning:** Recreating the Pod interrupts that workload until it is Running again. Precondition: the kubelet metrics error names that container's metric and the Pod is on the flapping node. Rollback is the controller recreate.

   ```bash
   kubectl -n <namespace> delete pod <pod-named-in-error>
   ```

After the restart the duplicate data is gone and the kubelet health of the node recovers.

## Diagnostic Steps

1. Read the alert labels and query `up` for that namespace and Service. `up=0` with a Running Pod is this article.

   ```bash
   kubectl get pod -A | grep -E 'vmagent|cluster-enhancer-apiserver|calico-node'
   ```

2. In-Pod `curl` works and another node gets `No route to host`: Cause 1.

3. `calico-felix-metrics-svc` at 0 with `FELIX_PROMETHEUSMETRICSENABLED=false`: Cause 2.

4. The alert clears by itself and the backend's last state is `OOMKilled`: Cause 3.

5. `cluster-enhancer-apiserver` Running, anonymous `curl` returns 403, and `scrape_duration_seconds` equals the scrape timeout: Cause 4. Expected after the fix: duration below the new timeout and `up` at `1`.

6. Targets page shows `server gave HTTP response to HTTPS client` on ALB endpoints after an image change: Cause 5.

7. Kubelet health flapping on one node, and the kubelet metrics endpoint returns `was collected before with the same name and label values`: Cause 6.
