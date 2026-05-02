---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
sourceSHA: c2c607b2fda0ce84091f2834f0c5ae31daa5da9fb8b88745a7c3f5e0da648988
---

## 问题

一个工作负载需要从多个私有注册表中拉取容器镜像（例如一个公共镜像、一个供应商注册表和一个团队内部的 Harbor）。每个注册表在单独的 `~/.docker/config.json` 风格的文件中暴露其凭据。Kubernetes 默认每个 ServiceAccount 仅接受一个 `imagePullSecrets` 条目，即使列出了多个，提供多个凭据也会增加操作噪音。

本文描述了如何将两个或多个现有的拉取凭据 JSON 文件合并为一个满足所有注册表的 `kubernetes.io/dockerconfigjson` Secret。

## 根本原因

`dockerconfigjson` Secret 类型是一个简单的 base64 包装的 JSON 文档副本，其结构如下：

```json
{
  "auths": {
    "registry-a.example.com": { "auth": "<base64>" },
    "registry-b.example.com": { "auth": "<base64>" }
  }
}
```

当两个拉取凭据文件包含不重叠的 `auths` 键时，合并纯粹是一个 JSON 联合 — kubelet 拉取器在拉取时查找注册表主机名，任何在 `auths` 下匹配的条目都会被使用。因此，这项工作是客户端的文本操作；不需要 API 更改。

## 解决方案

### 步骤

1. 将每个现有的拉取凭据导出为一个普通的 JSON 文件。对于已经存在于集群中的 Secret：

   ```bash
   kubectl get secret registry-a-pull -n team-x \
     -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > /tmp/auth-a.json

   kubectl get secret registry-b-pull -n team-x \
     -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > /tmp/auth-b.json
   ```

   对于由 `docker login` 生成的 `~/.docker/config.json`，逐字复制该文件。

2. 使用 `jq` 合并 `.auths` 对象。右侧操作数在键冲突时胜出，因此如果同一主机在两个中都出现，则将优先级更高的注册表放在第二位：

   ```bash
   jq -s '.[0] * .[1] | {auths: .auths}' /tmp/auth-a.json /tmp/auth-b.json \
     > /tmp/auth-merged.json
   ```

   检查：

   ```bash
   jq '.auths | keys' /tmp/auth-merged.json
   ```

3. 创建或替换合并后的 Secret：

   ```bash
   kubectl create secret generic glean-merged-pull \
     --from-file=.dockerconfigjson=/tmp/auth-merged.json \
     --type=kubernetes.io/dockerconfigjson \
     -n team-x \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

4. 在每个 Pod 上引用合并后的 Secret（或将其附加到命名空间的默认 ServiceAccount，以便 Pods 自动继承）：

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: multi-registry-app
   spec:
     imagePullSecrets:
       - name: glean-merged-pull
     containers:
       - name: app
         image: registry-a.example.com/foo:1.0
   ```

   或者：

   ```bash
   kubectl patch serviceaccount default -n team-x \
     -p '{"imagePullSecrets":[{"name":"glean-merged-pull"}]}'
   ```

5. 删除源临时文件 (`/tmp/auth-*.json`) — 它们包含明文凭据。

## 诊断步骤

如果 Pod 在切换到合并后的 Secret 后仍报告 `ImagePullBackOff`：

- 确认 Secret 类型确实是 `kubernetes.io/dockerconfigjson`：

  ```bash
  kubectl get secret glean-merged-pull -n team-x -o jsonpath='{.type}'
  ```

- 解码实时 Secret 以确认注册表主机名出现在 `.auths` 下：

  ```bash
  kubectl get secret glean-merged-pull -n team-x \
    -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq '.auths | keys'
  ```

- 检查 Pod 事件流以获取 kubelet 尝试的确切注册表主机名（它必须与 `.auths` 中的键逐字匹配，包括非标准端口）：

  ```bash
  kubectl describe pod multi-registry-app -n team-x | tail -20
  ```

- 如果缺少失败的主机，请使用额外的源文件重复合并。
