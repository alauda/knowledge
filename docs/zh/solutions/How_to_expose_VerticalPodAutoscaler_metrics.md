---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB250900009
sourceSHA: b4996a2b06460c032775b19543cb5128aee81b1c5082b84c672ac8ae4111c534
---

# 如何暴露 VerticalPodAutoscaler 指标

## 背景

在 kube-state-metrics v2.9.0 及之后的版本中，`verticalpodautoscalers` 资源已从默认资源列表中移除。此解决方案通过自定义资源状态配置重新启用 VerticalPodAutoscaler (VPA) 指标。

## 环境信息

适用版本：4.0.x, 4.1.x

## 操作步骤

### 步骤 1：通过管理员 → Marketplace → 集群插件 → Alauda Container Platform Vertical Pod Autoscaler 部署 VPA 插件

### 步骤 2：创建自定义资源状态指标配置文件。以下是完整的 CustomResourceStateMetrics，以重新启用从默认资源列表中移除的所有 VPA 指标。根据需要自定义指标选择。

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
          help: "Kubernetes 注释转换为 Prometheus 标签。"
          each:
            type: Info
            info:
              labelsFromPath:
                annotation_*: [metadata, annotations]
                name: [metadata, name]
        - name: "verticalpodautoscaler_labels"
          help: "Kubernetes 标签转换为 Prometheus 标签。"
          each:
            type: Info
            info:
              labelsFromPath:
                label_*: [metadata, labels]
                name: [metadata, name]
        - name: "verticalpodautoscaler_spec_updatepolicy_updatemode"
          help: "VerticalPodAutoscaler 的更新模式。"
          each:
            type: StateSet
            stateSet:
              labelName: "update_mode"
              path: [spec, updatePolicy, updateMode]
              list: ["Auto", "Initial", "Off", "Recreate"]
        - name: "verticalpodautoscaler_spec_resourcepolicy_container_policies_minallowed_memory"
          help: "VerticalPodAutoscaler 可以为匹配名称的容器设置的最小内存资源。"
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
          help: "VerticalPodAutoscaler 可以为匹配名称的容器设置的最小 CPU 资源。"
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
          help: "VerticalPodAutoscaler 可以为匹配名称的容器设置的最大内存资源。"
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
          help: "VerticalPodAutoscaler 可以为匹配名称的容器设置的最大 CPU 资源。"
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
          help: "容器在 VerticalPodAutoscaler 更新器驱逐之前可以使用的最小内存资源。"
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
          help: "容器在 VerticalPodAutoscaler 更新器驱逐之前可以使用的最小 CPU 资源。"
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
          help: "容器在 VerticalPodAutoscaler 更新器驱逐之前可以使用的最大内存资源。"
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
          help: "容器在 VerticalPodAutoscaler 更新器驱逐之前可以使用的最大 CPU 资源。"
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
          help: "VerticalPodAutoscaler 为容器推荐的目标内存资源。"
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
          help: "VerticalPodAutoscaler 为容器推荐的目标 CPU 资源。"
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
          help: "VerticalPodAutoscaler 为容器推荐的目标内存资源，忽略边界。"
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
          help: "VerticalPodAutoscaler 为容器推荐的目标 CPU 资源，忽略边界。"
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

### 步骤 3：创建 ConfigMap 来存储 VPA 监控指标规则

```shell
kubectl create configmap vpa-metrics-config --from-file=vpa-config.yaml=/root/vpa-metrics-config.yaml  -n cpaas-system 
```

### 步骤 4：编辑 kube-prometheus-exporter-kube-state 部署，将自定义 VPA 指标配置添加到 kube-state-metrics

```shell
kubectl edit deploy -n cpaas-system kube-prometheus-exporter-kube-state
```

```yaml
spec:
  template:
    spec:
      containers:
      - command:
        # 1. 在保留现有参数的同时添加此参数。
        - --custom-resource-state-config-file=/config/vpa-config.yaml

        # 2. 添加一个新的挂载卷。
        volumeMounts:
        - mountPath: /config
          name: vpa-config-volume
          readOnly: true

      # 3. 在 volumes 部分下添加。
      volumes:
      - configMap:
          defaultMode: 420
          name: vpa-metrics-config
        name: vpa-config-volume
```

### 步骤 5：添加 RBAC 权限

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
  # 注意：当平台监控组件为 Prometheus 时，使用 prometheus-sa；当监控组件为 VictoriaMetrics 时，使用 vm-sa。
  name: prometheus-sa
  namespace: cpaas-system
EOF

kubectl apply -f /root/vpa-rbac-binding.yaml
```

### 步骤 6：修改 ModuleInfo(minfo) 资源以收集 exporter-kube-state 暴露的 VPA 指标，使用以下解决方案

请参考 \[[如何添加监控收集的指标](How_to_Add_Metrics_for_Monitoring_Collection.md)] 获取实现细节。

### 步骤 7：验证指标成功暴露

```shell
# kube-state-metrics 仅收集现有资源。VPA 指标需要实际的 VPA 对象。
kubectl get verticalpodautoscaler -A

# 如果没有结果，创建一个测试 VPA 对象：
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
    # 替换为 cpaas-system 中现有的 Deployment 名称
    name: <your-deployment-name>
  updatePolicy:
    updateMode: "Auto"
EOF

kubectl apply -f /root/vpa-test.yaml

# 获取 pod IP
kubectl get pod -A -o wide | grep kube-prometheus-exporter-kube-state

# 验证指标暴露（替换 <pod_ip>）。如果正常返回以下示例内容，则证明暴露和收集成功。您还可以选择通过在 Prometheus/VictoriaMetrics UI 中查询指标进一步验证。
curl -s http://<pod_ip>:8080/metrics | grep '^kube_verticalpodautoscaler'

kube_verticalpodautoscaler_annotations{annotation_kubectl_kubernetes_io_last_applied_configuration="{\"apiVersion\":\"autoscaling.k8s.io/v1\",\"kind\":\"VerticalPodAutoscaler\",\"metadata\":{\"annotations\":{},\"name\":\"test-vpa\",\"namespace\":\"cpaas-system\"},\"spec\":{\"targetRef\":{\"apiVersion\":\"apps/v1\",\"kind\":\"Deployment\",\"name\":\"sentry\"},\"updatePolicy\":{\"updateMode\":\"Auto\"}}}\n",customresource_group="autoscaling.k8s.io",customresource_kind="VerticalPodAutoscaler",customresource_version="v1",name="test-vpa",namespace="cpaas-system",target_api_version="apps/v1",target_kind="Deployment",target_name="sentry",verticalpodautoscaler="test-vpa"} 1
```
