---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500549
sourceSHA: 12ce0593ad1f08fbd493d33e5a67f555833e6964b40ba5e1034cdb70db307983
---

# Alertmanager 在 ACP 中重启 pod 后发送被抑制的告警 — PrometheusRule 中的规则顺序

## 问题

在 Alauda 容器平台（安装包 `v4.3.4`，kube-prometheus chart `v4.3.3`，容器镜像 `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4`）上，Alertmanager 作为 StatefulSet pod `cpaas-system/alertmanager-kube-prometheus-0` 运行，由 `Alertmanager` CR `cpaas-system/kube-prometheus` 驱动。默认的 ACP 部署配置为 `spec.replicas=1`；多副本 HA 不是开箱即用的配置，必须通过将 CR 扩展到 `replicas>=2` 来选择。

当 Alertmanager 以多个副本（HA）运行且其中一个 pod 被重启时，抑制功能可能无法抑制应该被匹配的抑制告警所静音的告警。被抑制的告警随后作为虚假通知转发给接收者，即使抑制条件在同一时间触发。

## 根本原因

这种异常行为是 Alertmanager 二进制文件中的竞争条件。ACP 镜像 `registry.alauda.cn:60080/3rdparty/prometheus/alertmanager:v0.32.1-v4.3.4` 携带的是没有 ACP 特定补丁的原生上游 Prometheus Alertmanager `v0.32.1`，因此竞争条件存在于驱动抑制决策的同一路径中，围绕一个守卫 `if` 语句，并且在 ACP 中没有改变。

由于该错误存在于上游 Alertmanager 二进制文件本身，因此无法从 ACP 安装内部提供永久修复 — 实际的缓解措施是确保抑制告警在每个评估周期中严格早于被抑制告警到达 Alertmanager，这样在被抑制告警到达时，抑制状态已经建立。

系统的 Prometheus 方面使得这种缓解措施成为可能。ACP Prometheus 镜像 `registry.alauda.cn:60080/3rdparty/prometheus/prometheus:v3.11.3-v4.3.4` 是原生上游 Prometheus `v3.11.3` 二进制文件，其规则组评估器以文本（插入）顺序迭代每个组的 `spec.groups[].rules[]` 数组。单个 ACP `Prometheus` CR `cpaas-system/kube-prometheus-0` 具有一个 `ruleSelector`，匹配携带 `prometheus: kube-prometheus` 标签的 `PrometheusRule` 对象（chart 默认）；没有该标签的规则不会被此 Prometheus 实例加载，因此组内排序语义适用于每个选定规则，但用户编写的 `PrometheusRule` 必须携带该标签才能参与。

## 解决方案

在每个包含抑制告警和其要抑制的告警的规则组中，将抑制告警条目放在该组的 `spec.groups[].rules[]` 列表的首位。上游 Prometheus 规则评估器按文本顺序处理条目，因此抑制告警在每个评估周期中会在被抑制告警之前发送到 Alertmanager，并且在被抑制告警送达之前，抑制状态已经建立。

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: example-inhibition-rules
  namespace: cpaas-system
  labels:
    prometheus: kube-prometheus
spec:
  groups:
    - name: example-group
      rules:
        - alert: InhibitingRule
          expr: <选择抑制条件的表达式>
          labels:
            severity: critical
        - alert: InhibitedRule
          expr: <应该被抑制的告警的表达式>
          labels:
            severity: warning
```

组内排序的变通方法是针对每个组：当抑制和被抑制的告警分散在多个 `spec.groups[]` 条目中（在同一个 `PrometheusRule` 中或跨不同的 `PrometheusRule` 对象），每个包含被抑制规则的组也必须在同一组的 `rules[]` 列表中包含其自己的抑制规则。没有跨组排序的保证 — Prometheus 独立评估每个组 — 因此仅存在于组 A 中的抑制规则不会保护存在于组 B 中的被抑制规则。

该变通方法仅适用于集群管理员可以自由编辑的 `PrometheusRule` 对象。直接在 `monitoring.coreos.com/v1` CRD 下创建的用户定义的 `PrometheusRule` 对象没有控制器 `ownerReference`，因此规则顺序的编辑在每次协调中会持续存在。

由 operator 提供和协调的 `PrometheusRule` 对象携带控制器 `ownerReference`，因此不安全在原地重新排序。在 ACP 中，`cpaas-system` 中的 `cpaas-cluster-rules` `PrometheusRule` 由 `ait.alauda.io/v1 AlertRule` 控制器拥有（`controller=true`，`blockOwnerDeletion=true`），而 `kubevirt` 中的 `kubevirt-hyperconverged-prometheus-rule` 是由 HCO operator 渲染的（`Deployment hco-operator`，标签 `app.kubernetes.io/managed-by=hco-operator`）。对任一对象的手动编辑将在下次协调时被拥有的 operator 撤销，因此规则顺序的变通方法在 operator 管理的规则中无法生效，修复必须来自拥有的 operator。

## 诊断步骤

列出集群中的每个 `PrometheusRule` 作为检查组内排序的切入点。在 ACP 中，`kubectl get prometheusrule -A` 返回规则所在命名空间的完整清单（例如 `argocd`，`cpaas-system`，`kubevirt`），相同的列出命令/输出格式用于选择要完整读取的对象：

```bash
kubectl get prometheusrule -A
kubectl get prometheusrule -A -o yaml
```

对于每个包含被抑制规则的组，确认匹配的抑制规则在同一组的 `rules[]` 列表中出现得更早 — 数组由 apiserver 保持文本顺序，并由 Prometheus 规则组评估器按该顺序消费：

```bash
kubectl -n <namespace> get prometheusrule <name> -o yaml
```

在编辑 `PrometheusRule` 以应用排序变通方法之前，检查该对象是否携带控制器 `ownerReference`。由协调控制器拥有的对象（例如 `cpaas-system/cpaas-cluster-rules` 的 `ait.alauda.io/v1 AlertRule`，或 `kubevirt/kubevirt-hyperconverged-prometheus-rule` 的 `apps/v1 Deployment hco-operator`）在下次协调时会撤销其手动编辑，必须通过拥有的 operator 而不是直接进行更改：

```bash
kubectl -n <namespace> get prometheusrule <name> \
  -o jsonpath='{.metadata.ownerReferences}{"\n"}'
```
