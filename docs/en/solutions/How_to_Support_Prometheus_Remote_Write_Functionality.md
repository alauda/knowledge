---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# How to Support Prometheus Remote Write Functionality

## Environment Information

Applicable Versions: 4.0.x,4.1.x

## Feature Introduction

Prometheus Remote Write is a feature that allows users to remotely send metrics data to external persistent storage systems instead of storing them locally in Prometheus time-series database. This enables integration of Prometheus data with other monitoring systems or storage solutions, providing greater flexibility and scalability.

## Configuration Methods

**Prerequisites**: The remote write solution requires a third-party Prometheus version **v2.25 or higher**, and parameters must be modified to enable remote write support.

- When deploying Prometheus directly via StatefulSet: Set the startup parameter `--web.enable-remote-write-receiver`.

  Example StatefulSet Snippet:

```yaml
apiVersion: apps/v1
kind: StatefulSet
spec:
  template:
    spec:
      containers:
      - name: prometheus
        args:
        - "--web.enable-remote-write-receiver"
        # ... other args
```
- When deploying via Prometheus Operator: Add `enableRemoteWriteReceiver: true` to the `spec` section of the `prometheus.monitoring.coreos.com` resource.

  Example Prometheus CR Snippet:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: prometheus
spec:
  enableRemoteWriteReceiver: true
  # ... other spec fields
```

### When Prometheus is a single-node deployment, it is recommended to use the following

Log in to the master node of the global cluster in the target environment.
Modify the minfo Prometheus configuration to add remoteWrite settings:

#### Step 1: Get Prometheus minfo name

```shell
kubectl get minfo -A | grep prometheus | grep <cluster-name>
```

#### Step 2: Add remoteWrite configuration to minfo (replace <minfo_name> with the name obtained in Step 1)

```shell
kubectl edit minfo <minfo_name>
```

Add the following content under `spec`:

```yaml
spec:
  valuesOverride:
    ait/chart-kube-prometheus:
      prometheus:
        remoteWrite:
        ### Required: Remote write URL of third-party Prometheus.
        ### This address can serve for either Prometheus or VictoriaMetrics:
        ### - For the platform monitoring component VictoriaMetrics: https://<platform-domain>/clusters/<clusters_name>/vminsert
        ### - For the platform monitoring component Prometheus: https://<platform-domain>/clusters/<clusters_name>/prometheus-0/api/v1/write
        - url: "https://x.x.x.x/api/v1/write"
          ### Optional: Write timeout (default: 30s)
          remoteTimeout: 60s
          ### Optional: BasicAuth configuration for the URL. Requires creating a Secret in the `cpaas-system` namespace if authentication is enabled.
          basicAuth:
            ### Optional: Username. `name` is the Secret name; `key` is the username key in the Secret.
            username:
              key: <username-key>
              name: <remote-secret-name>
            ### Optional: Password. `name` is the Secret name; `key` is the password key in the Secret.
            password:
              key: <password-key>
              name: <remote-secret-name>
          ### Optional: Disable certificate verification
          tlsConfig:
            insecureSkipVerify: true
          writeRelabelConfigs:
          ### Example: Discard both the nginx_http_connections metric and metrics starting with kube_, using regular expressions to match the metric names to discard. Multiple rules can be used for matching.
          - action: drop
            regex: nginx_http_connections|kube_.+
            sourceLabels:
            - __name__
          ### Example: Retain both the up metric and metrics starting with http_ and discard all others.
          - action: keep
            regex: up|http_.+
            sourceLabels:
            - __name__
          ### Example: Add a label `clusters="test"` to distinguish data. This label is added ONLY to remotely written data; platform data remains unmodified.
          - action: replace
            replacement: test
            targetLabel: clusters
```

### When Prometheus is deployed in a high-availability configuration, it is recommended to use the following approach:

Log in to the master node of the monitoring cluster (where remote write needs to be configured).
Modify the Prometheus resource to add remoteWrite settings.

#### Step 1: Get the Prometheus resource name.

```shell
kubectl get prometheus -A
```

#### Step 2: Edit the Prometheus instance (e.g., prometheus-0, prometheus-1, or prometheus-2)

```shell
kubectl edit prometheus -n cpaas-system kube-prometheus-0
```

Add the following content under `spec`:

```yaml
spec:
  remoteWrite:
  - basicAuth:
      ### Optional: Username for authentication (name=secret name, key=username key)
      username:
        key: <username-key>
        name: <remote-secret-name>
      ### Optional: Password for authentication (name=secret name, key=password key)
      password:
        key: <password-key>
        name: <remote-secret-name>
    ### Optional: Write timeout (default: 30s)
    remoteTimeout: 60s
    ### Optional: Disable certificate verification
    tlsConfig:
      insecureSkipVerify: true
    ### Required: Remote write URL of third-party Prometheus.
    ### This address can serve for either Prometheus or VictoriaMetrics:
    ### - For the platform monitoring component VictoriaMetrics: https://<platform-domain>/clusters/<clusters_name>/vminsert
    ### - For the platform monitoring component Prometheus: https://<platform-domain>/clusters/<clusters_name>/prometheus-0/api/v1/write
    url: https://x.x.x.x/api/v1/write
    writeRelabelConfigs:
    ### Example: Discard both the nginx_http_connections metric and metrics starting with kube_, using regular expressions to match the metric names to discard. Multiple rules can be used for matching.
    - action: drop
      regex: nginx_http_connections|kube_.+
      sourceLabels:
      - __name__
    ### Example: Retain both the up metric and metrics starting with http_ and discard all others.
    - action: keep
      regex: up|http_.+
      sourceLabels:
      - __name__
    ### Example: Add a clusters="test" label to distinguish data (applies only to remotely written data; platform data remains unmodified)
    - action: replace
      replacement: test
      targetLabel: clusters
```

## Verification method

Check by querying the platform Prometheus's metrics in the third-party Prometheus.

```shell
curl -k -s -u username:password https://x.x.x.x/api/v1/query?query=up

{"status":"success","data":{xxxx}}
```
Replace the address, authentication method, and the metric "up" with actual values. If the response status in the result is "success", it indicates that the remote write configuration is working correctly.
