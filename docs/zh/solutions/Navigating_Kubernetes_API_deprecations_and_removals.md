---
kind:
  - BestPractices
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x,4.3.x'
id: KB260500011
sourceSHA: 9458b123a7cf3088b671f079dea9d29c8fc9b71c333efbbbe4413d10d93a002f
---

# 处理集群升级前后移除的 Kubernetes API 版本

## 问题

Alauda Container Platform 运行上游 Kubernetes API 服务器，并遵循上游 API 生命周期，因此随着集群在 Kubernetes 次要版本之间的推进，beta API 版本最终会被移除。在 Kubernetes v1.34.5 的集群中，流量控制组仅提供 GA 版本 `flowcontrol.apiserver.k8s.io/v1`；该组没有提供任何 `v1beta*` 版本，反映了上游规则，即 beta API 版本在弃用后会在定义的窗口内保留，然后在后续的次要版本中移除。一旦某个版本达到这一点并被移除，仍然针对已移除版本的工作负载、工具或其他组件的请求将开始失败。

```text
Error from server (NotFound): the server could not find the requested resource
```

针对已移除版本的直接请求，例如 `flowcontrol.apiserver.k8s.io/v1beta3`，将会被 API 服务器以 HTTP `404 Not Found` 响应，因为该版本不再提供服务。

## 根本原因

提供服务的 API 版本集完全由运行的次要版本的上游 Kubernetes API 机制管理。当集群达到一个版本，其中 beta 版本已超过其弃用窗口时，该版本将从提供的版本集中移除；在 v1.34.5 中，流量控制组仅暴露 `flowcontrol.apiserver.k8s.io/v1`，任何仍然针对已移除的 `v1beta*` 形式发出调用的客户端都没有可用的端点。因此，这些失败并不是集群配置错误，而是客户端继续使用升级后的 API 服务器不再识别的 API 版本的预期结果。

## 解决方案

在跨越发生 API 移除的版本升级集群之前，识别哪些工作负载、清单、控制器和客户端工具仍然针对即将移除的 API 版本，并在升级之前将它们迁移到适当的替代版本。下面的命令仅显示 API 服务器当前提供的版本；它们本身并不列出哪些客户端仍在调用给定版本，因此工作负载侧的审查必须通过检查清单、Helm 图表、GitOps 仓库、控制器镜像以及任何已知引用已弃用版本的 API 流量源来完成。对于流量控制组，在 v1.34.5 集群上存活的提供版本是 GA `flowcontrol.apiserver.k8s.io/v1`；清单和客户端应更新为该版本，以便在升级后继续解析。

确认某个组在运行的集群上当前提供哪些版本，然后更新资源以针对 GA 版本：

```bash
kubectl api-versions | grep flowcontrol.apiserver.k8s.io
```

```yaml
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
```

## 诊断步骤

要确定故障是否源于已移除的 API 版本，请检查 API 服务器对受影响请求的响应。已移除的版本返回 `404 Not Found`，并且 API 服务器报告无法找到请求的资源，从而将已移除版本的调用与授权或准入失败区分开。交叉检查受影响组的提供版本与 v1.34.5 集群上仅存在的 GA 集合：这确认了故障请求中命名的版本是否仍在运行的次要版本上提供服务，以及哪个版本仍然作为迁移目标。查询报告提供的版本，而不是正在使用的调用者，因此它确认了已移除版本调用的诊断，但并不单独列出仍在发出旧版本请求的每个客户端——该枚举必须通过检查已知发送故障请求的工作负载、清单和工具来完成。

```bash
kubectl get --raw /apis/flowcontrol.apiserver.k8s.io
```
