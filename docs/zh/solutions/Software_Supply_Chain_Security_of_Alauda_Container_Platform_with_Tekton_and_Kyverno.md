---
id: KB250600001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: 7e3980ae21e998f2fd0014ace7f2cd8b3264c605d2948ce55999536f20eab834
---

```yaml
- `generate-git-clone-results`: The script to simulate cloning the code and write the repository URL and commit message into the results.
- `source_repo_ARTIFACT_INPUTS`: The result of the source repository artifact input.
  - `digest`: The digest of the source repository.
  - `uri`: The URI of the source repository.
- `tasks`:
  - `git-clone`: The task to simulate cloning the repository and generating the results.
  - `generate-dockerfile`: The task to generate a Dockerfile for building an image.
  - `build-image`: The task to build and push the image to the registry.

**Need to adjust the configuration**

- `params`:
  - `image`:
    - `default`: The target image address built.

Save into a yaml file named `chains.demo-3.pipeline.yaml` and apply it with:

```shell
$ export NAMESPACE=<default>

# create the pipeline resource in the namespace
$ kubectl apply -n $NAMESPACE -f chains.demo-3.pipeline.yaml
```

### Step 3: Run the pipeline to generate the image

This is a PipelineRun resource, which is used to run the pipeline.

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-3-
spec:
  pipelineRef:
    name: chains-demo-3
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**Explanation of YAML fields:**

- `pipelineRef`: The pipeline to run.
  - `name`: The name of the pipeline.
- `taskRunTemplate`: The task run template.
  - `serviceAccountName`: The service account to use for the pipeline.
- `workspaces`: The workspaces for the pipeline.
  - `dockerconfig`: The workspace for Docker configuration.
  - `source`: The workspace for source code.

**Need to adjust the configuration**

- `taskRunTemplate`:
  - `serviceAccountName`: The service account prepared in the previous step [ServiceAccount Configuration](#serviceaccount-configuration).
- `workspaces`:
  - `dockerconfig`:
    - `secret.secretName`: The registry secret prepared in the previous step [Registry Configuration](#registry-configuration).
  - `source`:
    - `volumeClaimTemplate.spec.storageClassName`: The storage class name for the volume claim template.

Save into a yaml file named `chains.demo-3.pipelinerun.yaml` and apply it with:

```shell
$ export NAMESPACE=<default>

# create the pipeline run resource in the namespace
$ kubectl create -n $NAMESPACE -f chains.demo-3.pipelinerun.yaml
```

Wait for the PipelineRun to complete.

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-3-<xxxxx>   True        Succeeded   2m         2m
```

### Step 4: Get the image from the PipelineRun

```shell
# Get the image URI
$ export IMAGE_URI=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.uri}')

# Get the image digest
$ export IMAGE_DIGEST=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.digest}')

# Combine the image URI and digest to form the full image reference
$ export IMAGE=$IMAGE_URI@$IMAGE_DIGEST

# Print the image reference
$ echo $IMAGE

<registry>/test/chains/demo-3:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046
```

This image will be used to verify the source repository.

### Step 5: Verify the source repository with Kyverno

#### Step 5.1: Create a Kyverno policy to allow only images built from specific source repositories to be deployed

> This step requires cluster administrator privileges.

The policy is as follows:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-source-repo-images
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # The credential needs to exist in the namespace where kyverno is deployed
              - registry-credentials

          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |- # <- The public key of the signer
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true
              conditions:
                - all:
                    - key: "{{ source_repo.uri }}"
                      operator: Equals
                      value: "https://github.com/tektoncd/pipeline"
                      message: "The source repository must be equal to https://github.com/tektoncd/pipeline, not {{ source_repo.uri }}"
```

> More details about Kyverno ClusterPolicy, please refer to [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**Explanation of YAML fields:**

- The policy is largely consistent with the one in [Chapter 1: Create a Kyverno policy to allow only signed images to be deployed](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed). Below only introduces the differences.
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`: The slsa provenance type is `https://slsa.dev/provenance/v0.2` or `https://slsa.dev/provenance/v1`.
  - `attestors`: the same as above.
  - `conditions`: The conditions to be verified.
    - `all`: All conditions must be met.
      - `key: "{{ source_repo.uri }}"`: This checks the `source_repo.uri` field in the attestation is equal to `https://github.com/tektoncd/pipeline`.

Save the policy to a yaml file named `kyverno.verify-source-repo-images.yaml` and apply it with:

```shell
$ kubectl apply -f kyverno.verify-source-repo-images.yaml

clusterpolicy.kyverno.io/verify-source-repo-images configured
```

#### Step 5.2: Verify the policy

In the `policy` namespace where the policy is defined, create a Pod to verify the policy.

Use the built image to create a Pod.

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046>

$ kubectl run -n $NAMESPACE built --image=${IMAGE} -- sleep 3600

pod/built created
```

The Pod will be created successfully.

```shell
$ kubectl get pod -n $NAMESPACE built

NAME      READY   STATUS    RESTARTS   AGE
built   1/1     Running   0          10s
```

Change the source repository in the `ClusterPolicy` to another value, and verify again.

```yaml
conditions:
  - all:
      - key: "{{ source_repo.uri }}"
        operator: Equals
        value: "https://github.com/invalid/repo"
        message: "The source repository must be equal to https://github.com/invalid/repo, not {{ source_repo.uri }}"
```

```shell
$ kubectl run -n $NAMESPACE unbuilt --image=${IMAGE} -- sleep 3600
```

Receive the output like this, means the Pod is blocked by the policy.

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unbuilt was blocked due to the following policies

verify-source-repo-images:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-3@sha256:93635f39cb31de5c6988cdf1f10435c41b3fb85570c930d51d41bbadc1a90046
    and predicate https://slsa.dev/provenance/v0.2: The source repository must be equal to
    https://github.com/invalid/repo, not https://github.com/tektoncd/pipeline'
```

### Step 6: Clean up the resources

Delete the Pods created in the previous steps.

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built
```

Delete the policy.

```shell
$ kubectl delete clusterpolicy verify-source-repo-images
```
```
  - `generate-git-clone-results`: 一个脚本，用于模拟克隆代码并将仓库 URL 和提交信息写入结果中。
- `results`
  - `source_repo_ARTIFACT_INPUTS`: 源代码仓库的 URL 和提交信息。
    - `digest`: 源代码仓库的提交 sha。
  - 此格式符合 Tekton Chains，更多详细信息请参见上文中的 [Tekton Chains 类型提示](#tekton-chains-type-hinting)。

### 第 3 步：运行管道以生成镜像

这是一个 PipelineRun 资源，用于运行管道。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-3-
spec:
  pipelineRef:
    name: chains-demo-3
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- 与 [第 1 章：运行管道以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 中相同。

将其保存到名为 `chains.demo-3.pipelinerun.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建管道运行资源
$ kubectl create -n $NAMESPACE -f chains.demo-3.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-3-<xxxxx>   True        Succeeded   2m         2m
```

### 第 4 步：等待管道被签名

等待 PipelineRun 具有 `chains.tekton.dev/signed: "true"` 注释。

```shell
$ export NAMESPACE=<default>
$ export PIPELINERUN_NAME=<chains-demo-3-xxxxx>

$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o yaml | grep "chains.tekton.dev/signed"

    chains.tekton.dev/signed: "true"
```

一旦 PipelineRun 具有 `chains.tekton.dev/signed: "true"` 注释，表示镜像已被签名。

### 第 5 步：从 PipelineRun 获取镜像

```shell
# 获取镜像 URI
$ export IMAGE_URI=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.uri}')

# 获取镜像摘要
$ export IMAGE_DIGEST=$(kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.status.results[?(@.name=="first_image_ARTIFACT_OUTPUTS")].value.digest}')

# 将镜像 URI 和摘要组合成完整的镜像引用
$ export IMAGE=$IMAGE_URI@$IMAGE_DIGEST

# 打印镜像引用
$ echo $IMAGE

<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20
```

此镜像将用于验证代码仓库。

### 第 7 步：（可选）获取 SLSA 来源证明

> **提示：**:
>
> - 如果您对 SLSA 来源证明内容感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 部分获取签名公钥。

```shell
# 禁用 tlog 上传并启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ cosign verify-attestation --key cosign.pub --type slsaprovenance $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出将类似于以下内容，其中包含 SLSA 来源证明。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "subject": [
    {
      "name": "<registry>/test/chains/demo-3:latest",
      "digest": {
        "sha256": "db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20"
      }
    }
  ],
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildConfig": {
      "tasks": null
    },
    "buildType": "tekton.dev/v1beta1/PipelineRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "invocation": {
      "parameters": {
        "image": "<registry>/test/chains/demo-3:latest"
      }
    },
    "materials": [
      {
        "digest": {
          "sha256": "bad5d84ded24307d12cacc9ef37fc38bce90ea5d00501f43b27d0c926be26f19"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/run-script"
      },
      {
        "digest": {
          "sha1": "cccccaaaa0000000000000000000000000000000"
        },
        "uri": "https://github.com/tektoncd/pipeline"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-06T10:28:21Z",
      "buildStartedOn": "2025-06-06T10:27:34Z"
    }
  }
}
```

> 有关 SLSA 来源证明的更多详细信息，请参阅 [SLSA 来源证明](https://slsa.dev/spec/v1.1/provenance)

**字段说明：**

- `predicateType`: 谓词的类型。
- `predicate`:
  - `buildConfig`:
    - `tasks`: 构建的任务。
  - `buildType`: 构建的类型，这里是 `tekton.dev/v1beta1/PipelineRun`。
  - `builder`:
    - `id`: 构建器的 ID，这里是 `https://alauda.io/builders/tekton/v1`。
  - `invocation`:
    - `parameters`: 构建的参数。
  - `materials`: 构建的材料。
    - `uri`:
      - `oci://<registry>/devops/tektoncd/hub/run-script`: 使用的任务镜像。
      - `https://github.com/tektoncd/pipeline`: 任务的源代码仓库。
  - `metadata`: 构建的元数据。
    - `buildFinishedOn`: 构建完成的时间。
    - `buildStartedOn`: 构建开始的时间。

### 第 8 步：使用 Kyverno 验证镜像源仓库限制

证明的内容大致如下，我们将使用 `materials` 字段来验证代码仓库。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildType": "tekton.dev/v1beta1/PipelineRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "materials": [
      {
        "digest": {
          "sha256": "bad5d84ded24307d12cacc9ef37fc38bce90ea5d00501f43b27d0c926be26f19"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/run-script"
      },
      {
        "digest": {
          "sha256": "7a63e6c2d1b4c118e9a974e7850dd3e9321e07feec8302bcbcd16653c512ac59"
        },
        "uri": "http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/run-script/0.1/yaml"
      },
      {
        "digest": {
          "sha256": "8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/buildah"
      },
      {
        "digest": {
          "sha256": "3225653d04c223be85d173747372290058a738427768c5668ddc784bf24de976"
        },
        "uri": "http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/buildah/0.9/yaml"
      },
      {
        "digest": {
          "sha1": "cccccaaaa0000000000000000000000000000000"
        },
        "uri": "https://github.com/tektoncd/pipeline"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-06T10:21:27Z",
      "buildStartedOn": "2025-06-06T10:20:38Z"
    }
  }
}
```

#### 第 8.1 步：创建 Kyverno 策略，仅允许从特定源代码仓库构建的镜像进行部署

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-code-repository-material
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # 凭证需要存在于部署 kyverno 的命名空间中
              - registry-credentials

          attestations:
            - type: https://slsa.dev/provenance/v0.2
              attestors:
                - entries:
                    - keys:
                        publicKeys: |- # <- 签名者的公钥
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true
              conditions:
                - all:
                    - key: "{{ buildType }}"
                      operator: Equals
                      value: "tekton.dev/v1beta1/PipelineRun"
                      message: "buildType 必须等于 tekton.dev/v1beta1/PipelineRun，而不是 {{ buildType }}"

                    - key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "材料必须至少有一个条目以 https://github.com/tektoncd/ 开头，{{ materials }}"
```

> 有关 Kyverno ClusterPolicy 的更多详细信息，请参阅 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明**

- 策略与 [第 1 章：创建 Kyverno 策略，仅允许签名镜像进行部署](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略大致一致。
- `spec.rules[].verifyImages[].attestations[].conditions`: 验证条件。
  - `all`: 所有条件必须满足。
    - `key: "{{ buildType }}"`: buildType 必须等于 `tekton.dev/v1beta1/PipelineRun`。
    - `key: "{{ materials[?starts_with(uri, 'https://github.com/tektoncd/')] | length(@) }}"`: 材料必须至少有一个条目以 `https://github.com/tektoncd/` 开头。

将其保存到名为 `verify-code-repository-material.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl create -f verify-code-repository-material.yaml

clusterpolicy.kyverno.io/verify-code-repository-material created
```

#### 第 8.2 步：验证策略

在定义策略的 `policy` 命名空间中，创建一个 Pod 以验证策略。

使用构建的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-3:latest@sha256:db2607375049e8defa75a8317a53fd71fd3b448aec3c507de7179ded0d4b0f20>

$ kubectl run -n $NAMESPACE built-from-specific-repo --image=${IMAGE} -- sleep 3600

pod/built-from-specific-repo created
```

Pod 将成功创建。

```shell
$ kubectl get pod -n $NAMESPACE built-from-specific-repo

NAME                      READY   STATUS    RESTARTS   AGE
built-from-specific-repo   1/1     Running   0          10s
```

将 `ClusterPolicy` 中的代码仓库更改为其他值 `https://gitlab.com/`，并再次验证。

```yaml
conditions:
  - all:
      - key: "{{ buildType }}"
        operator: Equals
        value: "tekton.dev/v1beta1/PipelineRun"
        message: "buildType 必须等于 tekton.dev/v1beta1/PipelineRun，而不是 {{ buildType }}"

      - key: "{{ materials[?starts_with(uri, 'https://gitlab.com/')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "材料必须至少有一个条目以 https://gitlab.com/ 开头，{{ materials }}"
```

```shell
$ kubectl run -n $NAMESPACE unbuilt-from-specific-repo --image=${IMAGE} -- sleep 3600
```

收到如下输出，表示 Pod 被策略阻止。

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/unbuilt-from-specific-repo was blocked due to the following policies

verify-code-repository-material:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-3:latest and predicate https://slsa.dev/provenance/v0.2:
    材料必须至少有一个条目以 https://gitlab.com/ 开头，
    [{"digest":{"sha256":"bad5d84ded24307d12cacc9ef37fc38bce90ea5d00501f43b27d0c926be26f19"},"uri":"oci://<registry>/devops/tektoncd/hub/run-script"},{"digest":{"sha256":"7a63e6c2d1b4c118e9a974e7850dd3e9321e07feec8302bcbcd16653c512ac59"},"uri":"http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/run-script/0.1/yaml"},{"digest":{"sha256":"8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"},"uri":"oci://<registry>/devops/tektoncd/hub/buildah"},{"digest":{"sha256":"3225653d04c223be85d173747372290058a738427768c5668ddc784bf24de976"},"uri":"http://tekton-hub-api.tekton-pipelines:8000/v1/resource/catalog/task/buildah/0.9/yaml"},{"digest":{"sha1":"cccccaaaa0000000000000000000000000000000"},"uri":"https://github.com/tektoncd/pipeline"}]'
```

### 第 9 步：清理资源

删除前面步骤中创建的 Pods。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE built-from-specific-repo
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-code-repository-material
```

## 第 4 章：防止部署具有严重安全漏洞的镜像

在 ACP (Alauda Container Platform) 中，您可以使用 Tekton Pipeline 构建并扫描镜像以查找漏洞。

具体来说，使用 `trivy` 任务生成漏洞扫描结果，然后使用 `cosign` 上传漏洞扫描结果的证明，最后使用 `kyverno` 验证漏洞扫描结果的证明。

本章逐步解释如何实现上述过程。

### 第 1 步：前提条件

请检查前提条件是否已完成，特别是关于以下部分：

- [注册表配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [获取签名密钥](#get-the-signing-secret)
  - **重要**：这仅出于方便，因此这里使用了 Chains 的全局签名证书。在实际使用中，您可以使用单独的证书来签署镜像漏洞信息。
  - 将密钥导入到执行管道的命名空间中。
- [jq](https://stedolan.github.io/jq/)
  - 以友好的方式呈现证明的内容。

### 第 2 步：创建管道以生成 cosign 漏洞证明

这是一个 Pipeline 资源，用于构建镜像并生成 cosign 漏洞证明。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: chains-demo-4
spec:
  params:
    - default: |-
        echo "生成用于构建镜像的 Dockerfile。"

        cat << 'EOF' > Dockerfile
        FROM ubuntu:latest
        ENV TIME=1
        EOF

        echo -e "\nDockerfile 内容："
        echo "-------------------"
        cat Dockerfile
        echo "-------------------"
        echo -e "\nDockerfile 生成成功！"
      description: 生成用于构建镜像的 Dockerfile 的脚本。
      name: generate-dockerfile
      type: string
    - default: <registry>/test/chains/demo-4:latest
      description: 构建的目标镜像地址
      name: image
      type: string
  results:
    - description: 第一个镜像工件输出
      name: first_image_ARTIFACT_OUTPUTS
      type: object
      value:
        digest: $(tasks.build-image.results.IMAGE_DIGEST)
        uri: $(tasks.build-image.results.IMAGE_URL)
  tasks:
    - name: generate-dockerfile
      params:
        - name: script
          value: $(params.generate-dockerfile)
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: build-image
      params:
        - name: IMAGES
          value:
            - $(params.image)
        - name: TLS_VERIFY
          value: "false"
      runAfter:
        - generate-dockerfile
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: buildah
          - name: version
            value: "0.9"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
    - name: trivy-scanner
      params:
        - name: COMMAND
          value: |-
            set -x

            mkdir -p .git

            # 支持不安全的注册表
            export TRIVY_INSECURE=true

            echo "生成 cyclonedx sbom"
            trivy image --skip-db-update --skip-java-db-update --scanners vuln --format cyclonedx --output .git/sbom-cyclonedx.json $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST)
            cat .git/sbom-cyclonedx.json

            echo "基于 cyclonedx sbom 执行 trivy 扫描漏洞"
            trivy sbom --skip-db-update --skip-java-db-update --format cosign-vuln --output .git/trivy-scan-result.json .git/sbom-cyclonedx.json
            cat .git/trivy-scan-result.json

            echo "基于 cyclonedx sbom 执行 trivy 扫描漏洞并以表格格式输出"
            trivy sbom --skip-db-update --skip-java-db-update --format table .git/sbom-cyclonedx.json
      runAfter:
        - build-image
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: trivy-scanner
          - name: version
            value: "0.4"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
    - name: cosign-uploads
      params:
        - name: COMMAND
          value: |-
            set -x

            export COSIGN_ALLOW_INSECURE_REGISTRY=true
            export COSIGN_TLOG_UPLOAD=false
            export COSIGN_KEY=$(workspaces.signkey.path)/cosign.key

            echo "签署镜像漏洞"
            cosign attest --type vuln --predicate .git/trivy-scan-result.json $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST)

            echo "签署镜像 sbom"
            cosign attest --type cyclonedx --predicate .git/sbom-cyclonedx.json $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST)
      runAfter:
        - trivy-scanner
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: cosign
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
        - name: signkey
          workspace: signkey
  workspaces:
    - name: source
      description: 源代码的工作空间。
    - name: dockerconfig
      description: Docker 配置的工作空间。
    - name: signkey
      description: 用于镜像签名的私钥和密码的工作空间。
```

**YAML 字段说明：**

- 与 [第 1 章：创建管道以生成镜像](#step-2-create-a-pipeline-to-generate-the-image) 中相同，但添加了以下内容：
  - `workspaces`:
    - `signkey`: 用于镜像签名的私钥和密码的工作空间。
  - `tasks`:
    - `trivy-scanner`: 扫描镜像以查找漏洞的任务。
    - `cosign-uploads`: 上传漏洞扫描结果证明的任务。

将其保存到名为 `chains-demo-4.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建管道
$ kubectl create -n $NAMESPACE -f chains-demo-4.yaml

pipeline.tekton.dev/chains-demo-4 created
```

### 第 3 步：运行管道以生成 cosign 漏洞证明

这是一个 PipelineRun 资源，用于运行管道。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-4-
spec:
  pipelineRef:
    name: chains-demo-4
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: signkey
      secret:
        secretName: <signing-secrets>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- 与 [第 1 章：运行管道以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 中相同。下面仅介绍差异。
- `workspaces`
  - `signkey`: 签名密钥的秘密名称。
    - `secret.secretName`: 在前一步 [获取签名密钥](#get-the-signing-secret) 中准备的签名密钥。但是您需要创建一个与管道运行相同命名空间的新密钥。

将其保存到名为 `chains-demo-4.pipelinerun.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建管道运行
$ kubectl create -n $NAMESPACE -f chains-demo-4.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-4-<xxxxx>     True        Succeeded   2m  2m
```

### 第 4 步：从 PipelineRun 获取镜像

> **与 [第 1 章：从 PipelineRun 获取镜像](#step-5-get-the-image-from-the-pipelinerun) 相同**

### 第 5 步：（可选）获取 cosign 漏洞证明

> **提示：**:
>
> - 如果您对 cosign 漏洞证明内容感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 部分获取签名公钥。

```shell
# 禁用 tlog 上传并启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:5e7b466e266633464741b61b9746acd7d02c682d2e976b1674f924aa0dfa2047>

$ cosign verify-attestation --key cosign.pub --type vuln $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出将类似于以下内容，其中包含漏洞扫描结果。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://cosign.sigstore.dev/attestation/vuln/v1",
  "predicate": {
    "scanner": {
      "uri": "pkg:github/aquasecurity/trivy@dev",
      "version": "dev",
      "result": {
        "CreatedAt": "2025-06-07T07:05:30.098889688Z",
        "Metadata": {
          "OS": {
            "Family": "ubuntu",
            "Name": "24.04"
          }
        },
        "Results": [
          {
            "Class": "os-pkgs",
            "Packages": [
              {
                "Arch": "amd64",
                "ID": "coreutils@9.4-3ubuntu6",
                "Identifier": {
                  "BOMRef": "pkg:deb/ubuntu/coreutils@9.4-3ubuntu6?arch=amd64&distro=ubuntu-24.04",
                  "PURL": "pkg:deb/ubuntu/coreutils@9.4-3ubuntu6?arch=amd64&distro=ubuntu-24.04",
                  "UID": "82bb3c93286700bc"
                },
                "Licenses": [
                  "GPL-3.0-or-later",
                  "BSD-4-Clause-UC",
                  "GPL-3.0-only",
                  "ISC",
                  "FSFULLR",
                  "GFDL-1.3-no-invariants-only",
                  "GFDL-1.3-only"
                ],
                "Name": "coreutils"
              }
            ],
            "Vulnerabilities": [
              {
                "CVSS": {
                  "nvd": {
                    "V2Score": 2.1,
                    "V2Vector": "AV:L/AC:L/Au:N/C:N/I:P/A:N",
                    "V3Score": 6.5,
                    "V3Vector": "CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:C/C:N/I:H/A:N"
                  },
                  "redhat": {
                    "V2Score": 6.2,
                    "V2Vector": "AV:L/AC:H/Au:N/C:C/I:C/A:C",
                    "V3Score": 8.6,
                    "V3Vector": "CVSS:3.0/AV:L/AC:L/PR:N/UI:R/S:C/C:H/I:H/A:H"
                  }
                },
                "InstalledVersion": "9.4-3ubuntu6",
                "LastModifiedDate": "2025-04-20T01:37:25.86Z",
                "PkgID": "coreutils@9.4-3ubuntu6",
                "PkgName": "coreutils",
                "PublishedDate": "2017-02-07T15:59:00.333Z",
                "References": [
                  "http://seclists.org/oss-sec/2016/q1/452",
                  "http://www.openwall.com/lists/oss-security/2016/02/28/2",
                  "http://www.openwall.com/lists/oss-security/2016/02/28/3",
                  "https://access.redhat.com/security/cve/CVE-2016-2781",
                  "https://lists.apache.org/thread.html/rf9fa47ab66495c78bb4120b0754dd9531ca2ff0430f6685ac9b07772%40%3Cdev.mina.apache.org%3E",
                  "https://lore.kernel.org/patchwork/patch/793178/",
                  "https://mirrors.edge.kernel.org/pub/linux/utils/util-linux/v2.28/v2.28-ReleaseNotes",
                  "https://nvd.nist.gov/vuln/detail/CVE-2016-2781",
                  "https://www.cve.org/CVERecord?id=CVE-2016-2781"
                ],
                "Severity": "LOW",
                "SeveritySource": "ubuntu",
                "Status": "affected",
                "VendorSeverity": {
                  "azure": 2,
                  "cbl-mariner": 2,
                  "nvd": 2,
                  "redhat": 2,
                  "ubuntu": 1
                },
                "VulnerabilityID": "CVE-2016-2781"
              }
            ]
          }
        ],
        "SchemaVersion": 2
      }
    },
    "metadata": {
      "scanStartedOn": "2025-06-07T07:05:30.104726629Z",
      "scanFinishedOn": "2025-06-07T07:05:30.104726629Z"
    }
  }
}
```

> 有关 cosign 漏洞证明的更多详细信息，请参阅 [cosign 漏洞证明](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)

**字段说明：**

- `predicateType`: 谓词的类型。
- `predicate.scanner`:
  - `uri`: 扫描器的 URI。
  - `version`: 扫描器的版本。
  - `result`: 漏洞扫描的结果。
    - `CreatedAt`: 漏洞扫描完成的时间。
    - `Metadata`:
      - `OS.Family`: 操作系统的家族。
      - `OS.Name`: 操作系统的名称。
    - `Results`: 漏洞扫描的结果。
      - `Class.os-pkgs`: 操作系统包。
      - `Class.lang-pkgs`: 语言包。
      - `Packages`: 镜像的包。
      - `Vulnerabilities.Severity`: 漏洞的严重性。
      - `Vulnerabilities.PkgID`: 漏洞的包 ID。
      - `Vulnerabilities.PkgName`: 漏洞的包名称。
      - `Vulnerabilities.CVSS.nvd`: 漏洞的 NVD CVSS 分数。
      - `Vulnerabilities.CVSS.redhat`: 漏洞的 Red Hat CVSS 分数。

### 第 6 步：使用 Kyverno 验证漏洞扫描结果

#### 第 6.1 步：创建 Kyverno 策略以拒绝具有高风险漏洞的镜像

> 此步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: reject-high-risk-image
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # 凭证需要存在于部署 kyverno 的命名空间中
              - registry-credentials

          attestations:
            - type: https://cosign.sigstore.dev/attestation/vuln/v1
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- 签名者的公钥
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true

              conditions:
                - all:
                    - key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"
                      operator: AllNotIn
                      # 支持的值：UNKNOWN, LOW, MEDIUM, HIGH, CRITICAL
                      value: ["HIGH", "CRITICAL"]
                      message: |
                        镜像包含高风险漏洞，请在继续之前修复它们。
                        严重性级别：{{ scanner.result.Results[].Vulnerabilities[].Severity }}

                    - key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"
                      operator: Equals
                      value: 0
                      message: |
                        镜像包含高风险漏洞，请在继续之前修复它们。
                        高风险漏洞 (CVSS > 1.0)：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].CVSS.redhat.V3Score[] }}。
                        严重性级别：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].Severity[] }}。
                        PkgIDs：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`].PkgID[] }}。
```

> 有关 Kyverno ClusterPolicy 的更多详细信息，请参阅 [Kyverno ClusterPolicy](https://kyverno.io/docs/policy-types/cluster-policy/)

**YAML 字段说明：**

- 策略与 [第 1 章：创建 Kyverno 策略，仅允许签名镜像进行部署](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略大致一致。下面仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`: cosign 漏洞证明的类型是 `https://cosign.sigstore.dev/attestation/vuln/v1`
  - `attestors`: 与上述相同。
  - `conditions`: 要验证的条件。
    - `all`: 所有条件必须满足。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"`: 漏洞的严重性不得为 `HIGH` 或 `CRITICAL`。
      - `key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `1.0`][] | length(@) }}"`: CVSS 分数大于 1.0 的漏洞数量必须为 0。

将策略保存到名为 `kyverno.reject-high-risk-image.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl apply -f kyverno.reject-high-risk-image.yaml

clusterpolicy.kyverno.io/reject-high-risk-image configured
```

#### 第 6.2 步：验证策略

在定义策略的 `policy` 命名空间中，创建一个 Pod 以验证策略。

使用构建的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-4:latest@sha256:0f123204c44969876ed12f40066ccccbfd68361f68c91eb313ac764d59428bef>

$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600
```

如果您的镜像具有高风险漏洞，Pod 将被策略阻止。
收到如下输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/high-risk was blocked due to the following policies

reject-high-risk-image:
  check-image: |
    image attestations verification failed, verifiedCount: 0, requiredCount: 1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed for <registry>/test/chains/demo-4:latest and predicate https://cosign.sigstore.dev/attestation/vuln/v1: 镜像包含高风险漏洞，请在继续之前修复它们。
    高风险漏洞 (CVSS > 1.0)：[8.6,2.7,6.2,5.9,7.5,4.7,7.4,4.7,7.4,4.7,7.4,4.7,7.4,5.9,3.6,3.6,7.3,4.4,6.5,5.4]。
    严重性级别：["LOW","MEDIUM","LOW","LOW","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","MEDIUM","LOW","LOW","LOW","MEDIUM","MEDIUM","MEDIUM","MEDIUM"]。
    PkgIDs：["coreutils@9.4-3ubuntu6","gpgv@2.4.4-2ubuntu17","gpgv@2.4.4-2ubuntu17","libgcrypt20@1.10.3-2build1","liblzma5@5.6.1+really5.4.5-1build0.1","libpam-modules@1.5.3-5ubuntu5.1","libpam-modules@1.5.3-5ubuntu5.1","libpam-modules-bin@1.5.3-5ubuntu5.1","libpam-modules-bin@1.5.3-5ubuntu5.1","libpam-runtime@1.5.3-5ubuntu5.1","libpam-runtime@1.5.3-5ubuntu5.1","libpam0g@1.5.3-5ubuntu5.1","libpam0g@1.5.3-5ubuntu5.1","libssl3t64@3.0.13-0ubuntu3.5","login@1:4.13+dfsg1-4ubuntu3.2","passwd@1:4.13+dfsg1-4ubuntu3.2","perl-base@5.38.2-3.2build2.1","golang.org/x/net@v0.23.0","golang.org/x/net@v0.23.0","stdlib@v1.22.12"].
```

将 `ClusterPolicy` 中的条件更改为允许具有高风险漏洞的镜像，但 CVSS 分数小于 10.0。

```yaml
conditions:
  - all:
      - key: "{{ scanner.result.Results[].Vulnerabilities[].Severity }}"
        operator: AllNotIn
        value: ["CRITICAL"]
        message: |
          镜像包含高风险漏洞，请在继续之前修复它们。
          严重性级别：{{ scanner.result.Results[].Vulnerabilities[].Severity }}

      - key: "{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`][] | length(@) }}"
        operator: Equals
        value: 0
        message: |
          镜像包含高风险漏洞，请在继续之前修复它们。
          高风险漏洞 (CVSS > 10.0)：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].CVSS.redhat.V3Score[] }}。
          严重性级别：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].Severity[] }}。
          PkgIDs：{{ scanner.result.Results[].Vulnerabilities[?CVSS.redhat.V3Score > `10.0`].PkgID[] }}。
```

然后再次创建 Pod 以验证策略。

```shell
$ kubectl run -n $NAMESPACE vuln-image --image=${IMAGE} -- sleep 3600

pod/vuln-image created
```

Pod 将成功创建。

### 第 9 步：清理资源

删除前面步骤中创建的 Pods。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE vuln-image
```

删除策略。

```shell
$ kubectl delete clusterpolicy reject-high-risk-image
```

## 第 5 章：基础镜像允许列表验证

如果我们希望仅允许特定类型的基础镜像进行部署，
我们可以在获取镜像证明后将该信息保存到镜像证明中。

在 [第 4 章](#chapter-4-preventing-deployment-of-images-with-critical-security-vulnerabilities) 中，`cosign-vuln` 格式的证明已经包含基础镜像信息。
但在这里我们将使用不同的方法，使用 `syft` 生成镜像的 SBOM。
SBOM 信息也包含基础镜像信息。

在 ACP (Alauda Container Platform) 中，您可以在 Tekton Pipeline 中使用 `trivy` 或 `syft` 任务生成镜像的 SBOM。
这里我们使用 syft 任务生成 SBOM。

### 第 1 步：前提条件

请检查前提条件是否已完成，特别是关于以下部分：

- [注册表配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [获取签名密钥](#get-the-signing-secret)
  - **重要**：这仅出于方便，因此这里使用了 Chains 的全局签名证书。在实际使用中，您可以使用单独的证书来签署镜像漏洞信息。
  - 将密钥导入到执行管道的命名空间中。
- [jq](https://stedolan.github.io/jq/)
  - 以友好的方式呈现证明的内容。

### 第 2 步：创建管道以生成 SBOM

这是一个 Pipeline 资源，用于构建镜像并生成 SBOM。

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: chains-demo-5
spec:
  params:
    - default: |-
        echo "生成用于构建镜像的 Dockerfile。"

        cat << 'EOF' > Dockerfile
        FROM ubuntu:latest
        ENV TIME=1
        EOF

        echo -e "\nDockerfile 内容："
        echo "-------------------"
        cat Dockerfile
        echo "-------------------"
        echo -e "\nDockerfile 生成成功！"
      description: 生成用于构建镜像的 Dockerfile 的脚本。
      name: generate-dockerfile
      type: string
    - default: <registry>/test/chains/demo-5:latest
      description: 构建的目标镜像地址
      name: image
      type: string
  results:
    - description: 第一个镜像工件输出
      name: first_image_ARTIFACT_OUTPUTS
      type: object
      value:
        digest: $(tasks.build-image.results.IMAGE_DIGEST)
        uri: $(tasks.build-image.results.IMAGE_URL)
  tasks:
    - name: generate-dockerfile
      params:
        - name: script
          value: $(params.generate-dockerfile)
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: run-script
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
    - name: build-image
      params:
        - name: IMAGES
          value:
            - $(params.image)
        - name: TLS_VERIFY
          value: "false"
      runAfter:
        - generate-dockerfile
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: buildah
          - name: version
            value: "0.9"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
    - name: syft-sbom
      params:
        - name: COMMAND
          value: |-
            set -x

            mkdir -p .git

            echo "生成 sbom.json"
            syft scan $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST) -o cyclonedx-json=.git/sbom.json > /dev/null

            echo -e "\n\n"
            cat .git/sbom.json
            echo -e "\n\n"

            echo "生成并上传 sbom 的证明"
            syft attest $(tasks.build-image.results.IMAGE_URL)@$(tasks.build-image.results.IMAGE_DIGEST) -o cyclonedx-json
      runAfter:
        - build-image
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: syft
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
      workspaces:
        - name: source
          workspace: source
        - name: dockerconfig
          workspace: dockerconfig
        - name: signkey
          workspace: signkey
  workspaces:
    - name: source
      description: 源代码的工作空间。
    - name: dockerconfig
      description: Docker 配置的工作空间。
    - name: signkey
      description: 用于镜像签名的私钥和密码的工作空间。
```

**YAML 字段说明：**

- 与 [第 1 章：创建管道以生成镜像](#step-2-create-a-pipeline-to-generate-the-image) 中相同，但添加了以下内容：
  - `workspaces`:
    - `signkey`: 用于镜像签名的私钥和密码的工作空间。
  - `tasks`:
    - `syft-sbom`: 生成镜像的 SBOM 并上传证明的任务。

将其保存到名为 `chains-demo-5.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建管道
$ kubectl create -n $NAMESPACE -f chains-demo-5.yaml

pipeline.tekton.dev/chains-demo-5 created
```

### 第 3 步：运行管道以生成 cosign 漏洞证明

这是一个 PipelineRun 资源，用于运行管道。

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: chains-demo-5-
spec:
  pipelineRef:
    name: chains-demo-5
  taskRunTemplate:
    serviceAccountName: <default>
  workspaces:
    - name: dockerconfig
      secret:
        secretName: <registry-credentials>
    - name: signkey
      secret:
        secretName: <signing-secrets>
    - name: source
      volumeClaimTemplate:
        spec:
          accessModes:
            - ReadWriteOnce
          resources:
            requests:
              storage: 1Gi
          storageClassName: <nfs>
```

**YAML 字段说明：**

- 与 [第 1 章：运行管道以生成镜像](#step-3-run-the-pipeline-to-generate-the-image) 中相同。下面仅介绍差异。
- `workspaces`
  - `signkey`: 签名密钥的秘密名称。
    - `secret.secretName`: 在前一步 [获取签名密钥](#get-the-signing-secret) 中准备的签名密钥。但是您需要创建一个与管道运行相同命名空间的新密钥。

将其保存到名为 `chains-demo-5.pipelinerun.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ export NAMESPACE=<default>

# 在命名空间中创建管道运行
$ kubectl create -n $NAMESPACE -f chains-demo-5.pipelinerun.yaml
```

等待 PipelineRun 完成。

```shell
$ kubectl get pipelinerun -n $NAMESPACE -w

chains-demo-5-<xxxxx>     True        Succeeded   2m  2m
```

### 第 4 步：从 PipelineRun 获取镜像

> **与 [第 1 章：从 PipelineRun 获取镜像](#step-5-get-the-image-from-the-pipelinerun) 相同**

### 第 5 步：（可选）获取 SBOM 证明

> **提示：**:
>
> - 如果您对 SBOM 证明内容感兴趣，可以继续阅读以下内容。

根据 [获取签名公钥](#get-the-signing-public-key) 部分获取签名公钥。

```shell
# 禁用 tlog 上传并启用私有基础设施
$ export COSIGN_TLOG_UPLOAD=false
$ export COSIGN_PRIVATE_INFRASTRUCTURE=true

$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ cosign verify-attestation --key cosign.pub --type cyclonedx $IMAGE | jq -r '.payload | @base64d' | jq -s
```

输出将类似于以下内容，其中包含镜像的组件信息。

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "predicateType": "https://cyclonedx.org/bom",
  "predicate": {
    "$schema": "http://cyclonedx.org/schema/bom-1.6.schema.json",
    "bomFormat": "CycloneDX",
    "components": [
      {
        "bom-ref": "os:ubuntu@24.04",
        "licenses": [
          {
            "license": {
              "name": "GPL"
            }
          }
        ],
        "description": "Ubuntu 24.04.2 LTS",
        "name": "ubuntu",
        "type": "operating-system",
        "version": "24.04"
      }
    ],
    "metadata": {
      "timestamp": "2025-06-07T09:56:05Z",
      "tools": {
        "components": [
          {
            "author": "anchore",
            "name": "syft",
            "type": "application",
            "version": "1.23.1"
          }
        ]
      }
    }
  }
}
```

> 有关 cyclonedx SBOM 证明的更多详细信息，请参阅 [cyclonedx SBOM 证明](https://cyclonedx.org/docs/1.6/json/)

**字段说明：**

- `predicateType`: 谓词的类型。
- `predicate`:
  - `components`: 镜像的组件。
    - `bom-ref`: 组件的 BOM 引用。
    - `licenses`: 组件的许可证。
      - `license.name`: 许可证的名称。
      - `license.id`: 许可证的 ID。
    - `name`: 组件的名称。
    - `type`: 组件的类型。
    - `version`: 组件的版本。
  - `metadata`: 镜像的元数据。
    - `timestamp`: 镜像的时间戳。
    - `tools.components`: 工具的组件。
      - `author`: 工具的作者。
      - `name`: 工具的名称。
      - `type`: 工具的类型。
      - `version`: 工具的版本。

### 第 6 步：验证基础镜像信息

#### 第 6.1 步：创建 Kyverno 策略以验证基础镜像信息

> 此步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-base-image
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # 凭证需要存在于部署 kyverno 的命名空间中
              - registry-credentials

          attestations:
            - type: https://cyclonedx.org/bom
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- 签名者的公钥
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true

              conditions:
                - any:
                    - key: "{{ components[?type=='operating-system'] | [?name=='ubuntu' && (version=='22.04' || version=='24.04')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "操作系统必须是 Ubuntu 22.04 或 24.04，而不是 {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"

                    - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
                      operator: GreaterThan
                      value: 0
                      message: "操作系统必须是 Alpine 3.18 或 3.20，而不是 {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

**YAML 字段说明：**

- 策略与 [第 1 章：创建 Kyverno 策略，仅允许签名镜像进行部署](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略大致一致。下面仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`: cyclonedx SBOM 证明的类型是 `https://cyclonedx.org/bom`
  - `attestors`: 与上述相同。
  - `conditions`: 要验证的条件。
    - `any`: 任何条件必须满足。
      - `key: "{{ components[?type=='operating-system'] | [?name=='ubuntu' && (version=='22.04' || version=='24.04')] | length(@) }}"`: 操作系统必须是 Ubuntu 22.04 或 24.04。
      - `key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"`: 操作系统必须是 Alpine 3.18 或 3.20。

将策略保存到名为 `kyverno.verify-base-image.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl create -f kyverno.verify-base-image.yaml

clusterpolicy.kyverno.io/verify-base-image created
```

#### 第 6.2 步：验证策略

在定义策略的 `policy` 命名空间中，创建一个 Pod 以验证策略。

使用构建的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE base-image --image=${IMAGE} -- sleep 3600
```

如果您的基础镜像是 Ubuntu 22.04 或 24.04，Pod 将成功创建。

将 `ClusterPolicy` 中的条件更改为仅允许 Alpine 3.18 或 3.20。

```yaml
conditions:
  - any:
      - key: "{{ components[?type=='operating-system'] | [?name=='alpine' && (version=='3.18' || version=='3.20')] | length(@) }}"
        operator: GreaterThan
        value: 0
        message: "操作系统必须是 Alpine 3.18 或 3.20，而不是 {{ components[?type=='operating-system'].name[] }} {{ components[?type=='operating-system'].version[] }}"
```

然后创建一个 Pod 以验证策略。

```shell
$ kubectl run -n $NAMESPACE deny-base-image --image=${IMAGE} -- sleep 3600
```

收到如下输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/deny-base-image was blocked due to the following policies

verify-base-image:
  check-image: 'image attestations verification failed, verifiedCount: 0, requiredCount:
    1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed
    for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom:
    操作系统必须是 Alpine 3.18 或 3.20，而不是 ["ubuntu"] ["24.04"]'
```

### 第 7 步：清理资源

删除前面步骤中创建的 Pods。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE base-image
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-base-image
```

## 第 6 章：许可证合规性验证 - 拒绝具有特定许可证类型的镜像

在 ACP (Alauda Container Platform) 中，您可以在 Tekton Pipeline 中使用 `trivy` 或 `syft` 任务生成镜像的 SBOM。

SBOM 包含镜像中每个组件的许可证信息。
我们可以使用 Kyverno 策略拒绝包含特定许可证的镜像。

由于在 [第 5 章](#chapter-5-base-image-allowlist-verification) 中已经为镜像生成了 SBOM，因此我们将不在此创建管道，而是直接使用现有镜像验证此功能。

> 本章基于 [第 5 章](#chapter-5-base-image-allowlist-verification)，仅添加验证镜像许可证信息的逻辑。

### 第 1 步：验证镜像的许可证信息

#### 第 1.1 步：创建 Kyverno 策略以验证组件许可证

> 此步骤需要集群管理员权限。

策略如下：

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-component-licenses
spec:
  webhookConfiguration:
    failurePolicy: Fail
    timeoutSeconds: 30
  background: false
  rules:
    - name: check-image
      match:
        any:
          - resources:
              kinds:
                - Pod
              namespaces:
                - policy
      verifyImages:
        - imageReferences:
            - "*"
            # - "<registry>/test/*"
          skipImageReferences:
            - "ghcr.io/trusted/*"
          failureAction: Enforce
          verifyDigest: false
          required: false
          useCache: false
          imageRegistryCredentials:
            allowInsecureRegistry: true
            secrets:
              # 凭证需要存在于部署 kyverno 的命名空间中
              - registry-credentials

          attestations:
            - type: https://cyclonedx.org/bom
              attestors:
                - entries:
                    - attestor:
                      keys:
                        publicKeys: |- # <- 签名者的公钥
                          -----BEGIN PUBLIC KEY-----
                          MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                          UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                          -----END PUBLIC KEY-----

                        ctlog:
                          ignoreSCT: true

                        rekor:
                          ignoreTlog: true

              conditions:
                - any:
                    # 检查镜像是否包含特定许可证
                    - key: "{{ components[].licenses[].license.id }}"
                      operator: AllNotIn
                      value: ["GPL-3.0-only", "GPL-3.0-or-later"]
                      message: |
                        镜像包含不允许的 GPL 许可证。
                        找到的许可证：{{ components[].licenses[].license.id }}

                    # 检查镜像是否包含特定许可证名称
                    - key: "{{ components[].licenses[].license.name }}"
                      operator: AllNotIn
                      value: ["GPL"]
                      message: |
                        镜像包含不允许的 Expat 许可证。
                        找到的许可证：{{ components[].licenses[].license.name }}
```

**YAML 字段说明：**

- 策略与 [第 1 章：创建 Kyverno 策略，仅允许签名镜像进行部署](#step-71-create-a-kyverno-policy-to-allow-only-signed-images-to-be-deployed) 中的策略大致一致。下面仅介绍差异。
- `spec.rules[0].verifyImages[].attestations[0].conditions`
  - `type`: cyclonedx SBOM 证明的类型是 `https://cyclonedx.org/bom`
  - `attestors`: 与上述相同。
  - `conditions`: 要验证的条件。
    - `any`: 任何条件必须满足。
      - `key: "{{ components[].licenses[].license.id }}"`: 镜像包含不允许的 GPL 许可证。
      - `key: "{{ components[].licenses[].license.name }}"`: 镜像包含不允许的 Expat 许可证。

将策略保存到名为 `kyverno.verify-component-licenses.yaml` 的 yaml 文件中，并使用以下命令应用：

```shell
$ kubectl create -f kyverno.verify-component-licenses.yaml

clusterpolicy.kyverno.io/verify-component-licenses created
```

#### 第 1.2 步：验证策略

在定义策略的 `policy` 命名空间中，创建一个 Pod 以验证策略。

使用构建的镜像创建一个 Pod。

```shell
$ export NAMESPACE=<policy>
$ export IMAGE=<<registry>/test/chains/demo-5:latest@sha256:a6c727554be7f9496e413a789663060cd2e62b3be083954188470a94b66239c7>

$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600
```

如果您的镜像包含 GPL 许可证，Pod 将创建失败。

收到如下输出：

```text
Error from server: admission webhook "mutate.kyverno.svc-fail" denied the request:

resource Pod/policy/high-risk was blocked due to the following policies

verify-component-licenses:
  check-image: |
    image attestations verification failed, verifiedCount: 0, requiredCount: 1, error: .attestations[0].attestors[0].entries[0].keys: attestation checks failed for <registry>/test/chains/demo-5:latest and predicate https://cyclonedx.org/bom: 镜像包含不允许的 GPL 许可证。
    找到的许可证：["GPL-3.0-only","GPL-3.0-or-later","Latex2e"]
    ; 镜像包含不允许的 Expat 许可证。
    找到的许可证：["GPL","LGPL","public-domain"]
```

将许可证限制更改为允许 GPL 许可证。

```yaml
conditions:
  - any:
    - key: "{{ components[].licenses[].license.id }}"
      operator: AllNotIn
      value: ["GPL-8.0-only"]
      message: |
        镜像包含不允许的 GPL 许可证。
        找到的许可证：{{ components[].licenses[].license.id }}

    - key: "{{ components[].licenses[].license.name }}"
      operator: AllNotIn
      value: ["GPL-x"]
      message: |
        镜像包含不允许的 Expat 许可证。
        找到的许可证：{{ components[].licenses[].license.name }}
```

然后创建一个 Pod 以验证策略。

```shell
$ kubectl run -n $NAMESPACE component-licenses --image=${IMAGE} -- sleep 3600

pod/component-licenses created
```

Pod 将成功创建。

### 第 2 步：（可选）验证镜像检查 CVE-2022-42889

> **提示：**:
>
> - 如果您对向策略添加更多条件感兴趣，可以继续阅读以下内容。

CVE-2022-42889 是 Apache Commons Text 库中的一个严重漏洞，可能导致任意代码执行，并发生在版本 1.5 到 1.9 之间。可以通过在 SBOM 中识别 "commons-text" 包及其受影响的版本来检测受影响的包。此策略检查指定在 `imageReferences` 下的镜像的 CycloneDX 格式的证明 SBOM，并在其包含 commons-text 包的版本 1.5-1.9 时拒绝它。

我们只需向 `ClusterPolicy` 添加一个条件，以检查镜像中是否存在 `commons-text` 包。

```yaml
conditions:
  - all:
    - key: "{{ components[?name=='commons-text'].version || 'none' }}"
      operator: AllNotIn
      value: ["1.5","1.6","1.7","1.8","1.9"]
```

这里不进行演示，有兴趣的读者可以自己尝试。

### 第 3 步：清理资源

删除前面步骤中创建的 Pods。

```shell
$ export NAMESPACE=<policy>
$ kubectl delete pod -n $NAMESPACE component-licenses
```

删除策略。

```shell
$ kubectl delete clusterpolicy verify-component-licenses
```

## 第 7 章：（可选）无密钥签名验证

> **提示：**:
>
> - 如果您对无密钥签名验证感兴趣，可以继续阅读以下内容。
> - 本章中的内容需要能够访问公共网络。
> - 但如果您已经部署了私有 Rekor 服务，可以使用私有 Rekor 服务。

虽然 ACP (Alauda Container Platform) 当前不提供部署私有 Rekor 实例的能力，但它确实提供与 Rekor 服务的集成能力。

在这里，我们以公共 Rekor 的集成为例，介绍如何使用这些服务。
如果您已经部署了私有 Rekor 服务，请参考相关文档进行配置。

### 第 1 步：前提条件

请检查前提条件是否已完成，特别是关于以下部分：

- [注册表配置](#registry-configuration)
- [ServiceAccount 配置](#serviceaccount-configuration)
- [获取签名公钥](#get-the-signing-public-key)
- [rekor-cli](https://github.com/sigstore/rekor/releases)
  - 用于验证和与存储在 Rekor 透明日志服务器中的证明进行交互。
- [jq](https://stedolan.github.io/jq/)
  - 以友好的方式呈现签名的内容。

### 第 2 步：配置 Tekton Chains

> 此过程需要平台管理员权限进行配置。

配置 Tekton Chains 的透明日志
$ kubectl patch tektonconfigs.operator.tekton.dev config --type=merge -p='{
  "spec": {
    "chain": {
      "transparency.enabled": true
    }
  }
}'

> 如果您有私有的 Rekor 服务，可以将 `transparency.url` 设置为您的 Rekor 服务器的 URL。
>
> - `transparency.url: "<https://rekor.sigstore.dev>"`

> 有关配置的更多详细信息，请参阅 [Transparency Log](https://tekton.dev/docs/chains/config/#transparency-log)

### 第 3 步：重新运行管道以生成镜像

> **提示：**：
>
> - 由于我们修改了透明日志配置，因此需要在 [第 1 章](#step-3-run-the-pipeline-to-generate-the-image) 中触发新的管道运行。
> - 这将允许 Tekton Chains 为新的镜像和 PipelineRun 生成透明日志条目。

要重新生成并获取镜像，请按照以下步骤操作：

- [第 1 章：运行管道以生成镜像](#step-3-run-the-pipeline-to-generate-the-image)
- [第 1 章：等待管道被签名](#step-4-wait-for-the-pipeline-to-be-signed)

### 第 4 步：获取 rekor 日志索引

从 PipelineRun 的注释中获取 rekor 签名。

```shell
$ export NAMESPACE=<pipeline-namespace>
$ export PIPELINERUN_NAME=<pipelinerun-name>
$ kubectl get pipelinerun -n $NAMESPACE $PIPELINERUN_NAME -o jsonpath='{.metadata.annotations.chains\.tekton\.dev/transparency}'

https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>
```

### 第 5 步：通过 curl 获取 rekor 签名

```shell
$ curl -s "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>" | jq
```

如果您需要查看 rekor 签名的内容，可以执行以下命令：

```shell
$ curl -s "https://rekor.sigstore.dev/api/v1/log/entries?logIndex=<232330257>" | jq -r '.[keys[0]].attestation.data | @base64d' | jq .
```

{
  "_type": "https://in-toto.io/Statement/v0.1",
  "subject": null,
  "predicateType": "https://slsa.dev/provenance/v0.2",
  "predicate": {
    "buildType": "tekton.dev/v1beta1/PipelineRun",
    "builder": {
      "id": "https://alauda.io/builders/tekton/v1"
    },
    "materials": [
      {
        "digest": {
          "sha256": "8d5ea9ecd9b531e798fecd87ca3b64ee1c95e4f2621d09e893c58ed593bfd4c4"
        },
        "uri": "oci://<registry>/devops/tektoncd/hub/buildah"
      }
    ],
    "metadata": {
      "buildFinishedOn": "2025-06-08T03:11:52Z",
      "buildStartedOn": "2025-06-08T03:10:33Z"
    }
  }
}

此内容与镜像中的证明相同，验证了镜像内容的真实性和完整性。证明信息可以从 Rekor 中检索，而无需图像注册表的凭据，使得验证过程更加方便和可访问。

### 第 6 步：通过 rekor-cli 获取 rekor 签名

通过日志索引获取签名

```shell
# 日志索引与 PipelineRun 的注释中的相同
$ rekor-cli get --log-index <232330257> --format json | jq -r .Attestation | jq .
```

通过镜像摘要获取签名

```shell
# 通过镜像摘要获取 uuid
$ rekor-cli search --sha da4885861a8304abad71fcdd569c92daf33422073d1102013a1fed615dfb285a

找到匹配的条目（按 UUID 列出）：
108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab

# 通过 uuid 获取签名
$ rekor-cli get --uuid 108e9186e8c5677a1364e68001a916d3a7316bc2580bd6b5fbbce39a9c62f13282d3e974a6b434ab --format json | jq -r .Attestation | jq .
```

### 第 7 步：在 Kyverno 中验证 rekor

修改 `ClusterPolicy` 的 `keys` 部分以添加 rekor 验证。

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
spec:
  rules:
    - name: check-image
      verifyImages:
        - attestors:
            - count: 1
              entries:
                - keys:
                    publicKeys: |- # <- 签名者的公钥
                      -----BEGIN PUBLIC KEY-----
                      MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFZNGfYwn7+b4uSdEYLKjxWi3xtP3
                      UkR8hQvGrG25r0Ikoq0hI3/tr0m7ecvfM75TKh5jGAlLKSZUJpmCGaTToQ==
                      -----END PUBLIC KEY-----

                    rekor:
                      ignoreTlog: false
                      # url: <https://rekor.sigstore.dev>
                      # # 从 rekor 服务器获取公钥
                      # # curl <https://rekor.sigstore.dev>/api/v1/log/publicKey
                      # pubkey: |-
                      #   -----BEGIN PUBLIC KEY-----
                      #   MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr
                      #   kBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==
                      #   -----END PUBLIC KEY-----
```

**YAML 字段说明：**

- `rekor`: rekor 验证配置。
  - `ignoreTlog`: 是否忽略透明日志。
    - 如果为 `false`，将验证 rekor 服务器。
  - `url`: rekor 服务器的 URL。
    - 公共 rekor 服务器为 `https://rekor.sigstore.dev`。
  - `pubkey`: 签名者的公钥。
    - 您可以从 rekor 服务器获取公钥。
      - `curl <https://rekor.sigstore.dev>/api/v1/log/publicKey`

如果您的镜像未签名，Pod 将被阻止。

```text
来自服务器的错误：admission webhook "mutate.kyverno.svc-fail" 拒绝了请求：

资源 Pod/policy/sign 被以下策略阻止

only-cosign-image-deploy:
  check-image: '未能验证镜像 <registry>/test/chains/demo-1@sha256:e02263e9f7c215cd5f029cf235d625861afa1d0bccdaba141c5f41f19d482ff2>:
    .attestors[0].entries[0].keys: 找不到匹配的签名：透明日志中未找到签名'
```

## 结论

Alauda Container Platform (ACP) 提供了一个全面的解决方案，通过 OpenSSF SLSA 框架实施软件供应链安全。本文探讨了实现安全和可靠软件交付的关键组件和方法：

### 核心安全能力

1. **代码和构建过程安全**
   - 来自可信 git 源的代码库
   - SLSA Provenance 用于构建过程证明
   - 通过签名和验证确保镜像完整性
   - 现代无密钥签名解决方案
   - 构建环境验证和加固

2. **依赖和组件安全**
   - 安全风险评估的漏洞扫描
   - 通过 SBOM 生成的组件清单
   - 许可证合规性验证
   - 第三方依赖验证

3. **分发和部署安全**
   - 使用 Kyverno 的基于策略的验证
   - 灵活的验证机制
   - 自动化的安全策略执行
   - 运行时环境安全控制

### 实施架构

1. **核心组件**
   - Tekton Pipelines：用于管道编排和自动化
   - Tekton Chains：用于 SLSA 合规性和工件签名
   - Kyverno：用于策略执行和验证

2. **支持工具**
   - cosign：用于镜像签名和验证
   - syft/trivy：用于 SBOM 生成和漏洞扫描
   - trivy/grype：用于漏洞扫描

3. **实施过程**
   - 第 1 阶段：证明生成
   - 第 2 阶段：证明验证

### 关键好处

1. **全面的风险缓解**
   - 确保构建过程的完整性和可追溯性
   - 提供全面的漏洞管理
   - 支持现代签名方法，无需密钥管理开销
   - 解决所有主要的供应链安全风险

2. **操作效率**
   - 实现自动化的安全策略执行
   - 减少手动安全检查
   - 简化合规性验证
   - 简化安全管理

3. **实施灵活性**
   - 每个安全功能都有多种工具
   - 可定制的验证规则
   - 与现有 CI/CD 管道集成
   - 适应不同的安全需求

通过实施这些供应链安全措施，组织可以显著改善其软件交付过程，降低安全风险，并确保符合行业标准。该平台的灵活性使团队能够根据特定需求选择最合适的安全控制，同时保持强大和可靠的软件供应链。

## 参考文献

- [SLSA](https://slsa.dev/)
  - [供应链威胁](https://slsa.dev/spec/v1.1/threats-overview)
  - [安全级别](https://slsa.dev/spec/v1.1/levels)
- [Tekton Chains](https://tekton.dev/docs/chains/)
  - [Chains 配置](https://tekton.dev/docs/chains/config/)
  - [SLSA Provenance](https://tekton.dev/docs/chains/slsa-provenance/)
  - [使用 Tekton 和 Tekton Chains 达到 SLSA Level 2](https://tekton.dev/blog/2023/04/19/getting-to-slsa-level-2-with-tekton-and-tekton-chains/)
- [Cosign](https://github.com/sigstore/cosign)
  - [Cosign 签名规范](https://github.com/sigstore/cosign/blob/main/specs/SIGNATURE_SPEC.md)
  - [Cosign 漏洞扫描记录证明规范](https://github.com/sigstore/cosign/blob/main/specs/COSIGN_VULN_ATTESTATION_SPEC.md)
  - [验证 In-Toto 证明](https://docs.sigstore.dev/cosign/verifying/attestation/)
- [Kyverno](https://kyverno.io/)
  - [ClusterPolicy 规范](https://htmlpreview.github.io/?https://github.com/kyverno/kyverno/blob/main/docs/user/crd/index.html)
  - [Kyverno - JMESPath](https://release-1-11-0.kyverno.io/docs/writing-policies/jmespath/)
  - kyverno 提供了一系列 [策略](https://kyverno.io/policies/?policytypes=Security+Tekton+Tekton%2520in%2520CEL+verifyImages)
    - [检查 Tekton TaskRun 漏洞扫描](https://kyverno.io/policies/tekton/verify-tekton-taskrun-vuln-scan/verify-tekton-taskrun-vuln-scan/): 检查高风险漏洞
    - [要求签名的 Tekton 任务](https://kyverno.io/policies/tekton/verify-tekton-taskrun-signatures/verify-tekton-taskrun-signatures/): 要求 Tekton TaskRun 的 TaskRef 中的包的签名信息
    - [要求镜像漏洞扫描](https://kyverno.io/policies/other/require-vulnerability-scan/require-vulnerability-scan/): 要求在 168 小时内提供镜像的漏洞扫描信息
    - [验证镜像检查 CVE-2022-42889](https://kyverno.io/policies/other/verify-image-cve-2022-42889/verify-image-cve-2022-42889/): 要求镜像不含 CVE-2022-42889 漏洞
