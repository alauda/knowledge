---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500832
sourceSHA: 6dc795e166c5d502f10c28b43afac51def859adb83041cbc0b585432dccd105c
---

# PipelineRun 在引用已移除的 ClusterTask 类型后卡住 — 迁移到 Tekton 集群解析器

## 问题

在 Alauda 容器平台 (Kubernetes `v1.34.5`，Alauda DevOps Pipelines / `tektoncd-operator` CSV `tektoncd-operator.v4.2.0`，OperatorBundle 渠道 `latest` 来自目录 `platform`，TektonConfig 发布 `v0.76.0-c46274a`)，一个仍通过 `taskRef.kind: ClusterTask` 引用任务的 `Pipeline` 无法作为 v1 `Pipeline` 被接纳：没有注册 `clustertasks.tekton.dev` CRD，而 v1 Pipeline 接纳 webhook (`validation.webhook.pipeline.tekton.dev`) 将 `taskRef.kind: ClusterTask` 视为自定义任务引用，并以 `invalid value: custom task ref must specify apiVersion: spec.tasks[0].taskRef.apiVersion` 拒绝应用。相同的限制也阻止了对任何较旧版本的 `Pipeline`（在早期构建中被接纳的版本，其中 `ClusterTask` 仍被识别为一种类型）的 `PipelineRun` 继续进行解析以调度 `TaskRun` Pod — `kubectl get pipeline -n <ns> -o yaml | grep -iE 'ClusterTask|resolver'` 是查找命名空间中任何剩余 `ClusterTask` 引用的第一步。

## 根本原因

`ClusterTask` 不再是 ACP 上随 `tektoncd-operator` 提供的第一类类型。标准的 tekton.dev v1 CRD 在 `v4.2.0` 中存在的有 `pipelines`、`pipelineruns`、`tasks`、`taskruns`、`customruns`、`stepactions` 和 `verificationpolicies`；集群范围的遗留 `clustertasks.tekton.dev` 不在该集合中，且 `kubectl get clustertask -A` 返回 `error: the server doesn't have a resource type "clustertask"`。由于该类型已消失，v1 Pipeline 架构不再将 `kind: ClusterTask` 识别为内置的 `taskRef.kind`，并转而进入自定义任务引用分支，这需要 `apiVersion` — 然后接纳 webhook 直接拒绝应用，任何仍携带该字段的先前 Pipeline 在 PipelineRun 协调期间无法解析任务。

支持的替代方案是上游 Tekton 远程解析框架（“Resolvers” 集合），特别是 **集群解析器**，它通过名称从同一集群的另一个命名空间获取 `Task`（或 `Pipeline`）。在 ACP DevOps Pipelines `v4.2.0` 中，集群解析器默认启用：名为 `config` 的 `TektonConfig` 单例具有 `spec.pipeline.enable-cluster-resolver: true`（以及 `enable-bundles-resolver`、`enable-git-resolver`、`enable-hub-resolver`），更广泛的 `enable-api-fields` 开关控制远程解析功能的表面在此版本中以 `beta` 形式提供。

## 解决方案

将任何 `taskRef` 仍命名为 `kind: ClusterTask` 的 `Pipeline` 迁移为使用 `taskRef.resolver: cluster`，并提供集群解析器所需的三个参数（`name`、`kind`、`namespace`）。原始的 `ClusterTask` 通过名称引用一个集群范围的任务；解析器引用相应的命名空间 `Task`（通常是安装在 `tektoncd-operator` 的命名空间 `tekton-pipelines` 中的 Task，或您任务所在的任何地方）。

前后对比，应用于同一步骤：

```yaml
# 旧版（在 ACP DevOps Pipelines v4.2.0 上被拒绝）
spec:
  tasks:
    - name: test-task
      taskRef:
        kind: ClusterTask
        name: <task-name>
```

```yaml
# 迁移后 — 使用集群解析器
spec:
  tasks:
    - name: test-task
      taskRef:
        resolver: cluster
        params:
          - name: name
            value: <task-name>
          - name: kind
            value: task
          - name: namespace
            value: tekton-pipelines      # 或者持有 Task 的任何命名空间
```

集群解析器在 ACP DevOps Pipelines `v4.2.0` 中默认启用（`TektonConfig` `config` 提供 `spec.pipeline.enable-cluster-resolver: true` 和 `spec.pipeline.enable-api-fields: beta`），因此新安装不需要 `TektonConfig` 补丁。如果您的环境已被自定义且 `enable-api-fields` 不再是 `beta`，请在名为 `config` 的单例 `TektonConfig` 上恢复它：

```bash
kubectl patch tektonconfig config --type=merge \
  -p '{"spec":{"pipeline":{"enable-api-fields":"beta","enable-cluster-resolver":true}}}'
```

通过重新应用迁移后的 `Pipeline` 并创建针对它的 `PipelineRun` 来验证迁移的端到端过程：集群解析器从指定命名空间获取引用的 `Task`，控制器生成一个 `TaskRun`，然后 `kube-scheduler` 将 `TaskRun` Pod 放置在工作节点上，之后步骤正常执行。

## 诊断步骤

确认在受影响命名空间中的任何 `Pipeline` 中仍在使用遗留的 `kind: ClusterTask`：

```bash
kubectl get pipeline -n <namespace> -o yaml | grep -iE 'ClusterTask|resolver'
```

输出中的 `ClusterTask` 行正是需要迁移的引用；`resolver` 行已经在支持的路径上。要进行集群范围的检查，请去掉 `-n <namespace>` 并添加 `-A`。

确认集群中没有 `clustertasks.tekton.dev` CRD，并且 v1 Pipeline 接纳 webhook 拒绝 `kind: ClusterTask`，因此在此构建中迁移是强制性的而非可选的：

```bash
kubectl get crd | grep -i clustertask    # 期望：没有行
kubectl get clustertask -A               # 期望：error: the server doesn't have a resource type "clustertask"
```

确认 `TektonConfig` 单例上的解析器侧前提条件 — 在默认的 ACP 安装中，这两个开关应该已经到位：

```bash
kubectl get tektonconfig config \
  -o jsonpath='enable-api-fields={.spec.pipeline.enable-api-fields} enable-cluster-resolver={.spec.pipeline.enable-cluster-resolver}{"\n"}'
```

在 ACP DevOps Pipelines `v4.2.0` 上的预期输出：

```
enable-api-fields=beta enable-cluster-resolver=true
```
