---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# How to expose VerticalPodAutoscaler metrics

## Background

In exporter-kube-state v2.9.0 and later, the `verticalpodautoscalers` resource has been removed from the default resource list. This solution enables generating metrics for VerticalPodAutoscalers.

## Environment Information

Applicable Versions: 4.0.x,4.1.x

## Operational Steps

### Step 1: Deploy the VPA plugin via Administrator → Marketplace → Cluster Plugins → Alauda Container Platform Vertical Pod Autoscaler.

### Step 2: Create a Custom Resource State Metrics configuration file. Below is the complete CustomResourceStateMetrics to re-enable all VPA metrics removed from the default resource list. Customize metrics selection as needed.

```shell
cat  <<EOF> /root/vpa-metrics-config.yaml
kind: CustomResourceStateMetrics
spec:
  resources:
    - groupVersionKind:
        group: autoscaling.k8s.io
        kind: "VerticalPodAutoscaler"
        version: "v1"
      labelsFromPath:
        verticalpodautoscaler: [metadata, name]
        namespace: [metadata, namespace]
        target_api_version: [spec, targetRef, apiVersion]
        target_kind: [spec, targetRef, kind]
        target_name: [spec, targetRef, name]
      metricNamePrefix: "kube"
      metrics:
        - name: "verticalpodautoscaler_annotations"
          help: "Kubernetes annotations converted to Prometheus labels."
          each:
            type: Info
            info:
              labelsFromPath:
                annotation_*: [metadata, annotations]
                name: [metadata, name]
        - name: "verticalpodautoscaler_labels"
          help: "Kubernetes labels converted to Prometheus labels."
          each:
            type: Info
            info:
              labelsFromPath:
                label_*: [metadata, labels]
                name: [metadata, name]
        - name: "verticalpodautoscaler_spec_updatepolicy_updatemode"
          help: "Update mode of the VerticalPodAutoscaler."
          each:
            type: StateSet
            stateSet:
              labelName: "update_mode"
              path: [spec, updatePolicy, updateMode]
              list: ["Auto", "Initial", "Off", "Recreate"]
        - name: "verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_memory"
          help: "Minimum memory resources the VerticalPodAutoscaler can set for containers matching the name."
          commonLabels:
            unit: "byte"
            resource: "memory"
          each:
            type: Gauge
            gauge:
              path: [spec, resourcePolicy, containerPolicies]
              labelsFromPath:
                container: [containerName]
              valueFrom: [minAllowed, memory]
        - name: "verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_cpu"
          help: "Minimum cpu resources the VerticalPodAutoscaler can set for containers matching the name."
          commonLabels:
            unit: "core"
            resource: "cpu"
          each:
            type: Gauge
            gauge:
              path: [spec, resourcePolicy, containerPolicies]
              labelsFromPath:
                container: [containerName]
              valueFrom: [minAllowed, cpu]
        - name: "verticalpodautoscaler_spec_resourcepolicy_container_policies_maxallowed_memory"
          help: "Maximum memory resources the VerticalPodAutoscaler can set for containers matching the name."
          commonLabels:
            unit: "byte"
            resource: "memory"
          each:
            type: Gauge
            gauge:
              path: [spec, resourcePolicy, containerPolicies]
              labelsFromPath:
                container: [containerName]
              valueFrom: [maxAllowed, memory]
        - name: "verticalpodautoscaler_spec_resourcepolicy_container_policies_maxallowed_cpu"
          help: "Maximum cpu resources the VerticalPodAutoscaler can set for containers matching the name."
          commonLabels:
            unit: "core"
            resource: "cpu"
          each:
            type: Gauge
            gauge:
              path: [spec, resourcePolicy, containerPolicies]
              labelsFromPath:
                container: [containerName]
              valueFrom: [maxAllowed, cpu]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_lowerbound_memory"
          help: "Minimum memory resources the container can use before the VerticalPodAutoscaler updater evicts it."
          commonLabels:
            unit: "byte"
            resource: "memory"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [lowerBound, memory]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_lowerbound_cpu"
          help: "Minimum cpu resources the container can use before the VerticalPodAutoscaler updater evicts it."
          commonLabels:
            unit: "core"
            resource: "cpu"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [lowerBound, cpu]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_upperbound_memory"
          help: "Maximum memory resources the container can use before the VerticalPodAutoscaler updater evicts it."
          commonLabels:
            unit: "byte"
            resource: "memory"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [upperBound, memory]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_upperbound_cpu"
          help: "Maximum cpu resources the container can use before the VerticalPodAutoscaler updater evicts it."
          commonLabels:
            unit: "core"
            resource: "cpu"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [upperBound, cpu]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_target_memory"
          help: "Target memory resources the VerticalPodAutoscaler recommends for the container."
          commonLabels:
            unit: "byte"
            resource: "memory"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [target, memory]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_target_cpu"
          help: "Target cpu resources the VerticalPodAutoscaler recommends for the container."
          commonLabels:
            unit: "core"
            resource: "cpu"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [target, cpu]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_uncappedtarget_memory"
          help: "Target memory resources the VerticalPodAutoscaler recommends for the container ignoring bounds."
          commonLabels:
            unit: "byte"
            resource: "memory"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [uncappedTarget, memory]
        - name: "verticalpodautoscaler_status_recommendation_containerrecommendations_uncappedtarget_cpu"
          help: "Target memory resources the VerticalPodAutoscaler recommends for the container ignoring bounds."
          commonLabels:
            unit: "core"
            resource: "cpu"
          each:
            type: Gauge
            gauge:
              path: [status, recommendation, containerRecommendations]
              labelsFromPath:
                container: [containerName]
              valueFrom: [uncappedTarget, cpu]
EOF
```

### Step 3: Create a ConfigMap to store the VPA monitoring metric rules.

```shell
kubectl create configmap vpa-metrics-config   --from-file=vpa-config.yaml=/root/vpa-metrics-config.yaml  -n cpaas-system 
```

### Step 4: Edit the kube-prometheus-exporter-kube-state Deployment to add custom VPA metric configurations to kube-state-exporter.

```shell
kubectl edit deploy -n cpaas-system kube-prometheus-exporter-kube-state
```



```yaml
spec:
  template:
    spec:
      containers:
      - command:
        # 1.Add this parameter while retaining existing parameters.
        - --custom-resource-state-config-file=/config/vpa-config.yaml

        # 2.Add a new mount volume.
        volumeMounts:
        - mountPath: /config
          name: vpa-config-volume
          readOnly: true

      # 3.Add under the volumes section..
      volumes:
      - configMap:
          defaultMode: 420
          name: vpa-metrics-config
        name: vpa-config-volume
```

### Step 5: Add RBAC permissions.

```shell
cat  <<EOF> /root/vpa-rbac.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kube-state-metrics-vpa-access
rules:
- apiGroups: ["autoscaling.k8s.io"]
  resources: ["verticalpodautoscalers"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apiextensions.k8s.io"]
  resources: ["customresourcedefinitions"]
  verbs: ["get", "list", "watch"]
EOF

kubectl apply -f /root/vpa-rbac.yaml

cat  <<EOF> /root/vpa-rbac-binding.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: kube-state-metrics-vpa-access
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kube-state-metrics-vpa-access
subjects:
- kind: ServiceAccount
  # Note: When the platform monitoring component is Prometheus, use prometheus-sa; when the monitoring component is VictoriaMetrics, use vm-sa.
  name: prometheus-sa
  namespace: cpaas-system
EOF

kubectl apply -f /root/vpa-rbac-binding.yaml
```

### Step 6: Modify the minfo resource to collect VPA metrics exposed by exporter-kube-state using the following solution:

Please refer to [How to Add Metrics for Monitoring Collection](How_to_Add_Metrics_for_Monitoring_Collection.md) for the implementation details.

### Step 7: Verify successful metrics exposure:

```shell
# kube-state-metrics only collects existing resources. VPA metrics require actual VPA objects.
kubectl get verticalpodautoscaler -A

# If no results, create a test VPA object:
cat  <<EOF> /root/vpa-test.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: test-vpa
  namespace: cpaas-system
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: apollo
  updatePolicy:
    updateMode: "Auto"
EOF

kubectl apply -f /root/vpa-test.yaml

# Get pod IP
kubectl get pod -A -o wide | grep kube-prometheus-exporter-kube-state

# Verify metrics exposure (replace <pod_ip>):
curl -k -s http://<pod_ip>:8080/metrics | grep verticalpodautoscaler

# Further validate by querying metrics in Prometheus/VictoriaMetrics UI
```
