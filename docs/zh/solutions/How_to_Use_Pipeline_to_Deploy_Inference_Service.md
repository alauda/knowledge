---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1763720171-5D07
sourceSHA: fe05d046abde3e98c3e8d98f293a0d5a606c9d355312d3d451b4fc91f521a1a9
---

# 如何使用管道部署推理服务

## 概述

本文档演示了如何使用 DevOps 管道部署推理服务。

## 前提条件

在继续进行推理服务部署管道之前，请确保满足以下前提条件：

1. **Alauda DevOps**：按照 [Alauda DevOps 文档](https://docs.alauda.io/devops) 安装 `Alauda DevOps next-gen`。必须安装 `Alauda DevOps Pipelines` 和 `Alauda DevOps Connectors`。

2. **Alauda AI**：建议部署 Alauda AI 以更好地管理模型、训练和推理服务。有关安装和配置的详细信息，请参阅 [Alauda AI 文档](https://docs.alauda.io/ai/)。

3. **GPU 设备插件**：建议部署 GPU 设备插件，如 `HAMi` 或 `NVIDIA GPU Device Plugin`，以利用 GPU 资源进行推理服务。有关部署说明，请参阅 [Alauda AI 文档](https://docs.alauda.io/ai/) 中的 `设备管理` 部分。

### 配置 RBAC

为将要运行 `Pipeline` 的命名空间配置 RBAC。由于 `Pipeline Tasks` 默认使用 `default` `ServiceAccount`，以下脚本配置 `ServiceAccount` 的权限：

<details>

<summary>prepare_rbac.sh</summary>

```bash
#!/bin/bash

NS=$1
SA=${SA:-"default"}
NAME="deploy-model"

if [ -z "$(kubectl get serviceaccount "${SA}" -n "${NS}" --ignore-not-found)" ]; then
    kubectl create serviceaccount "${SA}" -n "${NS}"
fi

cat <<EOF | kubectl apply -f -
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: "${NAME}"
  namespace: "${NS}"
rules:
- apiGroups:
  - ""
  resources:
  - configmaps
  - secrets
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - apps
  resources:
  - deployments
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - serving.kserve.io
  resources:
  - inferenceservices
  verbs:
  - get
  - list
  - watch
  - create
  - update
  - patch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: "${NAME}"
  namespace: "${NS}"
subjects:
- kind: ServiceAccount
  name: "${SA}"
  namespace: "${NS}"
roleRef:
  kind: Role
  name: "${NAME}"
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: "${NS}.${NAME}.clusterservingruntime-view"
subjects:
- kind: ServiceAccount
  name: "${SA}"
  namespace: "${NS}"
roleRef:
  kind: ClusterRole
  name: clusterservingruntimes.serving.kserve.io-v1alpha1-view
  apiGroup: rbac.authorization.k8s.io
EOF

```

</details>

运行脚本以配置 `default` `ServiceAccount` 的 RBAC：

```bash
bash prepare_rbac.sh <namespace-name>
```

要使用专用的 `ServiceAccount`，请运行：

```bash
SA=<service-account-name> bash prepare_rbac.sh <namespace-name>
```

注意：

1. 使用 `default` 以外的 `ServiceAccount` 时，必须在运行管道时指定 `ServiceAccount` 名称。有关详细信息，请参阅以下部分。

2. 此脚本需要集群管理员权限以创建 `ClusterRoleBinding` 资源。

### 创建管道

按照以下步骤在 `Alauda Container Platform` 中创建管道：

1. 在 `Alauda Container Platform` 视图中导航到将要运行管道的命名空间。

2. 在左侧导航中选择 `Pipelines` / `Pipelines`，然后单击打开页面右侧的 `Create` 按钮。

3. 在创建管道对话框中，输入名称 `deploy-inference-service`，然后单击 `Confirm` 按钮进入管道编排页面。

4. 在管道编排页面，单击右上角的 `YAML` 按钮切换到 YAML 编辑模式，并将以下管道 YAML 内容粘贴到编辑器中。

5. 单击右下角的 `Create` 按钮以创建 `deploy-inference-service` 管道。

<details>
<summary>管道：deploy-inference-service</summary>

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: deploy-inference-service
spec:
  params:
    - name: INFERENCE_SERVICE_NAME
      type: string
      description: 要部署的 InferenceService 的名称
    - name: INFERENCE_SERVICE_DESCRIPTION
      type: string
      description: InferenceService 的描述
      default: ""
    - name: UPDATE_IF_EXISTS
      type: string
      description: 如果 InferenceService 已存在，是否更新
      default: "true"
    - description: 包含模型的模型仓库的名称
      name: MODEL_REPO
      type: string
    - default: ""
      description: 要使用的模型仓库的分支
      name: MODEL_REPO_BRANCH
      type: string
    - default: ""
      description: 要使用的模型仓库的标签
      name: MODEL_REPO_TAG
      type: string
    - description: 要使用的服务运行时的名称，如果为空，将使用与 RUNTIME_CLASS 相同类的第一个运行时
      name: RUNTIME_NAME
      type: string
      default: ""
    - description: 服务运行时的类
      name: RUNTIME_CLASS
      type: string
    - description: InferenceService 的临时存储大小
      name: EPHIMERAL_STORAGE_SIZE
      type: string
      default: "10Gi"
    - default: ""
      description: 要用于 InferenceService 的现有 PVC 的名称
      name: PVC_NAME
      type: string
    - description: InferenceService 的最小副本数，应 >= 0
      name: MIN_REPLICAS
      type: string
      default: "1"
    - description: InferenceService 的最大副本数，应 >= MIN_REPLICAS
      name: MAX_REPLICAS
      type: string
      default: "1"
    - description: InferenceService 的 CPU 请求
      name: CPU_REQUEST
      type: string
      default: "1"
    - description: InferenceService 的内存请求
      name: MEMORY_REQUEST
      type: string
      default: "4Gi"
    - description: InferenceService 的 CPU 限制
      name: CPU_LIMIT
      type: string
      default: "4"
    - description: InferenceService 的内存限制
      name: MEMORY_LIMIT
      type: string
      default: "16Gi"
    - default: "1"
      description: HAMi NVIDIA GPU 分配 - GPU 卡数量，留空则不分配 GPU
      name: NVIDIA_GPUALLOC
      type: string
    - default: "50"
      description: HAMi NVIDIA GPU 核心 - 每张卡的计算能力百分比，范围 1-100，留空则不配置 GPU 核心
      name: NVIDIA_GPUCORES
      type: string
    - default: "4096"
      description: HAMi NVIDIA GPU 内存 - 每张卡的内存使用量（MiB），留空则不配置 GPU 内存
      name: NVIDIA_GPUMEM
      type: string
    - default: ""
      description: NVIDIA GPU 数量 - 使用 NVIDIA GPU 插件时分配的 GPU 卡数量，不能与 HAMi 参数一起使用，留空则不设置
      name: NVIDIA_GPU
      type: string
  results:
    - description: ""
      name: RESULT
      type: string
      value: $(tasks.deploy-inference-service.results.string-result)
  tasks:
    - name: deploy-inference-service
      params:
        - name: args
          value:
            - INFERENCE_SERVICE_NAME=$(params.INFERENCE_SERVICE_NAME)
            - INFERENCE_SERVICE_DESCRIPTION=$(params.INFERENCE_SERVICE_DESCRIPTION)
            - UPDATE_IF_EXISTS=$(params.UPDATE_IF_EXISTS)
            - MODEL_REPO=$(params.MODEL_REPO)
            - MODEL_REPO_BRANCH=$(params.MODEL_REPO_BRANCH)
            - MODEL_REPO_TAG=$(params.MODEL_REPO_TAG)
            - RUNTIME_NAME=$(params.RUNTIME_NAME)
            - RUNTIME_CLASS=$(params.RUNTIME_CLASS)
            - EPHIMERAL_STORAGE_SIZE=$(params.EPHIMERAL_STORAGE_SIZE)
            - PVC_NAME=$(params.PVC_NAME)
            - MIN_REPLICAS=$(params.MIN_REPLICAS)
            - MAX_REPLICAS=$(params.MAX_REPLICAS)
            - CPU_REQUEST=$(params.CPU_REQUEST)
            - MEMORY_REQUEST=$(params.MEMORY_REQUEST)
            - CPU_LIMIT=$(params.CPU_LIMIT)
            - MEMORY_LIMIT=$(params.MEMORY_LIMIT)
            - NVIDIA_GPUALLOC=$(params.NVIDIA_GPUALLOC)
            - NVIDIA_GPUCORES=$(params.NVIDIA_GPUCORES)
            - NVIDIA_GPUMEM=$(params.NVIDIA_GPUMEM)
            - NVIDIA_GPU=$(params.NVIDIA_GPU)
            - NAMESPACE=$(context.pipelineRun.namespace)
        - name: script
          value: |-
            set -euo pipefail
            export "$@"

            echo "INFERENCE_SERVICE_NAME: ${INFERENCE_SERVICE_NAME}"
            echo "INFERENCE_SERVICE_DESCRIPTION: ${INFERENCE_SERVICE_DESCRIPTION}"
            echo "UPDATE_IF_EXISTS: ${UPDATE_IF_EXISTS}"
            echo "MODEL_REPO: ${MODEL_REPO}"
            echo "MODEL_REPO_BRANCH: ${MODEL_REPO_BRANCH}"
            echo "MODEL_REPO_TAG: ${MODEL_REPO_TAG}"
            echo "RUNTIME_NAME: ${RUNTIME_NAME}"
            echo "RUNTIME_CLASS: ${RUNTIME_CLASS}"
            echo "EPHIMERAL_STORAGE_SIZE: ${EPHIMERAL_STORAGE_SIZE}"
            echo "PVC_NAME: ${PVC_NAME}"
            echo "MIN_REPLICAS: ${MIN_REPLICAS}"
            echo "MAX_REPLICAS: ${MAX_REPLICAS}"
            echo "CPU_REQUEST: ${CPU_REQUEST}"
            echo "MEMORY_REQUEST: ${MEMORY_REQUEST}"
            echo "CPU_LIMIT: ${CPU_LIMIT}"
            echo "MEMORY_LIMIT: ${MEMORY_LIMIT}"
            echo "NVIDIA_GPUALLOC: ${NVIDIA_GPUALLOC}"
            echo "NVIDIA_GPUCORES: ${NVIDIA_GPUCORES}"
            echo "NVIDIA_GPUMEM: ${NVIDIA_GPUMEM}"
            echo "NVIDIA_GPU: ${NVIDIA_GPU}"

            if [ -z "${RUNTIME_NAME}" ] && [ -z "${RUNTIME_CLASS}" ]; then
              echo "错误：必须指定 RUNTIME_NAME 或 RUNTIME_CLASS"
              exit 1
            fi

            if [ -z "${MODEL_REPO}" ]; then
              echo "错误：MODEL_REPO 不能为空"
              exit 1
            fi

            if [ -n "${MODEL_REPO_TAG}" ] && [ -n "${MODEL_REPO_BRANCH}" ]; then
              echo "错误：MODEL_REPO_TAG 和 MODEL_REPO_BRANCH 不能同时设置"
              exit 1
            fi

            cpu_limit="cpu: ${CPU_LIMIT}"
            cpu_request="cpu: ${CPU_REQUEST}"
            if [ -z "${CPU_LIMIT}" ]; then
              echo "CPU 限制为空，不配置 CPU 限制！"
              cpu_limit=""
            fi

            if [ -z "$CPU_REQUEST" ]; then
              echo "CPU 请求为空，不配置 CPU 请求！"
              cpu_request=""
            fi

            memory_limit="memory: ${MEMORY_LIMIT}"
            memory_request="memory: ${MEMORY_REQUEST}"
            if [ -z "$MEMORY_LIMIT" ]; then
              echo "内存限制为空，不配置内存限制！"
              memory_limit=""
            fi

            if [ -z "$MEMORY_REQUEST" ]; then
              echo "内存请求为空，不配置内存请求！"
              memory_request=""
            fi

            nvidia_gpu_alloc_resource="nvidia.com/gpualloc: ${NVIDIA_GPUALLOC}"
            nvidia_gpu_cores_resource="nvidia.com/gpucores: ${NVIDIA_GPUCORES}"
            nvidia_gpu_mem_resource="nvidia.com/gpumem: ${NVIDIA_GPUMEM}"

            if [ -z "$NVIDIA_GPUALLOC" ]; then
              echo "NVIDIA_GPUALLOC 为空，不配置 nvidia.com/gpualloc 资源！"
              nvidia_gpu_alloc_resource=""
            fi

            if [ -z "$NVIDIA_GPUCORES" ]; then
              echo "NVIDIA_GPUCORES 为空，不配置 nvidia.com/gpucores 资源！"
              nvidia_gpu_cores_resource=""
            fi

            if [ -z "$NVIDIA_GPUMEM" ]; then
              echo "NVIDIA_GPUMEM 为空，不配置 nvidia.com/gpumem 资源！"
              nvidia_gpu_mem_resource=""
            fi

            nvidia_gpu="nvidia.com/gpu: ${NVIDIA_GPU}"
            if [ -z "$NVIDIA_GPU" ]; then
              echo "NVIDIA_GPU 为空，不配置 nvidia.com/gpu 资源！"
              nvidia_gpu=""
            fi

            if [ -n "$NVIDIA_GPU" ] && ([ -n "$NVIDIA_GPUALLOC" ] || [ -n "$NVIDIA_GPUCORES" ] || [ -n "$NVIDIA_GPUMEM" ]); then
              echo "错误：不能将 NVIDIA_GPU 与 HAMi 资源一起使用"
              echo "NVIDIA_GPU=${NVIDIA_GPU}, NVIDIA_GPUALLOC=${NVIDIA_GPUALLOC}, NVIDIA_GPUCORES=${NVIDIA_GPUCORES}, NVIDIA_GPUMEM=${NVIDIA_GPUMEM}"
              exit 1
            fi

            if [ "$MIN_REPLICAS" -lt "0" ]; then
              echo "错误：MIN_REPLICAS($MIN_REPLICAS) 不应小于 0"
              exit 1
            fi

            if [ "$MAX_REPLICAS" -lt "$MIN_REPLICAS" ]; then
              echo "错误：MAX_REPLICAS($MAX_REPLICAS) 不应小于 MIN_REPLICAS($MIN_REPLICAS)"
              exit 1
            fi

            deploy_model="Serverless"
            if [ "$MIN_REPLICAS" -eq "$MAX_REPLICAS" ]; then
              deploy_model="RawDeployment"
            fi

            if [ -z "$PVC_NAME" ] && [ -z "${EPHIMERAL_STORAGE_SIZE}" ]; then
              EPHIMERAL_STORAGE_SIZE="10Gi"
              echo "PVC_NAME 和 EPHIMERAL_STORAGE_SIZE 都为空，EPHIMERAL_STORAGE_SIZE 使用默认值：${EPHIMERAL_STORAGE_SIZE}"
            fi

            ephemeral_storage="ephemeral-storage: ${EPHIMERAL_STORAGE_SIZE}"
            pvc_name=""
            if [ -n "${PVC_NAME}" ]; then
              pvc_name="storage-initializer-pvc-name: \"${PVC_NAME}\""
              ephemeral_storage=""
            fi

            GITLAB_BASE_URL=""
            GITLAB_TOKEN=""
            GITLAB_PROJECT_ID=""
            GITLAB_COMMIT_ID=""
            GITLAB_SUBGROUP=""
            GITLAB_GROUP=""
            GITLAB_DEFAULT_BRANCH=""
            PIPELINE_TAG=""
            LIBRARY_NAME=""
            RUNTIME_ARGS=""
            RUNTIME_COMMAND=""
            RUNTIME_ENVS=""
            EXTRA_METADATA=""
            SERVICE_URL=""

            function prepare_gitlab() {
              local base_url scheme token
              local config=/tmp/config.json

              kubectl get configmaps -n ${NAMESPACE} aml-image-builder-config -o json > ${config}

              base_url="$(jq -r '.data.MODEL_REPO_GIT_BASE' ${config})"
              if [ -z "${base_url}" ]; then
                echo "GITLAB_BASE_URL 未设置"
                exit 1
              fi

              scheme="$(jq -r '.data.MODEL_REPO_GIT_SCHEME' ${config})"
              if [ -z "${scheme}" ]; then
                scheme="https"
              fi
              GITLAB_BASE_URL="${scheme}://${base_url}"

              token="$(kubectl get secrets -n ${NAMESPACE} aml-image-builder-secret -o jsonpath='{.data.MODEL_REPO_GIT_TOKEN}' | base64 -d)"
              if [ -z "${token}" ]; then
                echo "GITLAB_TOKEN 未设置"
                exit 1
              fi
              GITLAB_TOKEN="${token}"
            }

            function get_gitlab_project() {
              local project_id namespace_full_path tag
              local project=/tmp/project.json

              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects?search_namespaces=true&search=amlmodels" > ${project}
              project_id="$(jq -r --arg name "${MODEL_REPO}" '.[] | select(.name == $name) | .id' ${project} 2>/dev/null || echo "")"
              if [ -z "${project_id}" ]; then
                echo "无法找到仓库: ${MODEL_REPO} 的项目 ID"
                exit 1
              fi
              GITLAB_PROJECT_ID="${project_id}"

              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}" > ${project}
              namespace_full_path="$(jq -r '.namespace.full_path' ${project})"
              GITLAB_GROUP="$(echo "${namespace_full_path}" | awk -F '/' '{print $1}')"
              GITLAB_SUBGROUP="$(echo "${namespace_full_path}" | awk -F '/' '{for(i=2;i<=NF;i++) printf "%s%s", $i, (i<NF?"/":"")}')"

              GITLAB_DEFAULT_BRANCH="$(jq -r '.default_branch' ${project})"
            }

            function get_gitlab_branch_commit_id() {
              local ref_name="${MODEL_REPO_BRANCH}" commit_id encoded_ref_name
              local branch=/tmp/branch.json

              encoded_ref_name="$(printf '%s' "${ref_name}" | jq -sRr @uri)"
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/repository/branches/${encoded_ref_name}" > ${branch}

              commit_id="$(jq -r '.commit.id' ${branch})"
              if [ -z "${commit_id}" ] || [ "${commit_id}" = "null" ]; then
                echo "无法找到分支: ${ref_name} 的提交 ID"
                cat ${branch}
                exit 1
              fi
              GITLAB_COMMIT_ID="${commit_id}"
            }

            function get_gitlab_tag() {
              local ref_name="${MODEL_REPO_TAG}" commit_id encoded_ref_name
              local tag=/tmp/tag.json

              encoded_ref_name="$(printf '%s' "${ref_name}" | jq -sRr @uri)"
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/repository/tags/${encoded_ref_name}" > ${tag}

              commit_id="$(jq -r '.commit.id' ${tag})"
              if [ -z "${commit_id}" ] || [ "${commit_id}" = "null" ]; then
                echo "无法找到标签: ${ref_name}"
                exit 1
              fi
              GITLAB_COMMIT_ID="${commit_id}"
            }

            function fetch_readme() {
              local readme=/tmp/readme.md

              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/repository/files/README.md?ref=${GITLAB_COMMIT_ID}" | jq -r '.content' | base64 -d > ${readme}
              echo "README.md"
              cat $readme
              if [ ! -s "$readme" ]; then
                echo "错误：README.md 为空"
                exit 1
              fi

              PIPELINE_TAG=$(grep '^pipeline_tag:' ${readme} 2>/dev/null | head -n 1 | sed 's/pipeline_tag:[[:space:]]*//' || echo "")
              if [ -z "${PIPELINE_TAG}" ]; then
                echo "错误：无法在 README.md 中找到 pipeline_tag"
                exit 1
              fi
              LIBRARY_NAME=$(grep '^library_name:' ${readme} 2>/dev/null | head -n 1 | sed 's/library_name:[[:space:]]*//' || echo "")
              if [ -z "${LIBRARY_NAME}" ]; then
                echo "错误：无法在 README.md 中找到 library_name"
                exit 1
              fi
            }

            function get_runtime() {
              local runtime=/tmp/runtime.json
              local supported_frameworks is_supported
              local args command envs runtime_class

              if [ -n "${RUNTIME_NAME}" ]; then
                kubectl get clusterservingruntimes.serving.kserve.io ${RUNTIME_NAME} -o json --ignore-not-found > ${runtime}
                if [ ! -s "${runtime}" ]; then
                  echo "运行时 ${RUNTIME_NAME} 未找到"
                  exit 1
                fi
                runtime_class=$(jq -r '.metadata.labels["cpaas.io/runtime-class"]' ${runtime})
                if [ -z "${RUNTIME_CLASS}" ]; then
                  RUNTIME_CLASS="${runtime_class}"
                else
                  if [ "${RUNTIME_CLASS}" != "${runtime_class}" ]; then
                    echo "运行时 ${RUNTIME_NAME} 的运行时类为 ${runtime_class}，但指定的是 ${RUNTIME_CLASS}"
                    exit 1
                  fi
                fi
              else
                kubectl get clusterservingruntimes.serving.kserve.io -o json -l cpaas.io/runtime-class=${RUNTIME_CLASS} > ${runtime}
                if [ $(jq -r '.items | length' ${runtime}) -eq 0 ]; then
                  echo "未找到类为 ${RUNTIME_CLASS} 的运行时"
                  exit 1
                fi
                jq -r '.items[0]' ${runtime} > ${runtime}.tmp && mv ${runtime}.tmp ${runtime}
                RUNTIME_NAME=$(jq -r '.metadata.name' ${runtime})
                echo "使用运行时: ${RUNTIME_NAME}"
              fi

              is_supported=$(jq -r --arg framework "${LIBRARY_NAME}" '.spec.supportedModelFormats[] | select(.name == $framework) | .name' ${runtime} 2>/dev/null || echo "")
              if [ -z "${is_supported}" ]; then
                echo "LIBRARY_NAME ${LIBRARY_NAME} 不被运行时 ${RUNTIME_NAME} 支持"
                exit 1
              fi

              args=$(jq -r '.spec.containers[0].args[]? | "      - |-\n        " + .' ${runtime} 2>/dev/null || echo "")
              cmds=$(jq -r '.spec.containers[0].command[]? | "      - |-\n        " + .' ${runtime} 2>/dev/null || echo "")
              envs=$(jq -r '.spec.containers[0].env[]? | "      - name: " + .name + "\n        value: |-\n          " + (.value // "")' ${runtime} 2>/dev/null || echo "")
              if [ -n "${args}" ]; then
                RUNTIME_ARGS="
                  args:
            ${args}"
              fi
              if [ -n "${cmds}" ]; then
                RUNTIME_COMMAND="
                  command:
            ${cmds}"
              fi
              if [ -n "${envs}" ]; then
                RUNTIME_ENVS="
                  env:
            ${envs}"
              fi
            }

            function wait_for_inference_service() {
              local inference_service=/tmp/inference-service.json
              local in_cluster_endpoint="http://${INFERENCE_SERVICE_NAME}-predictor.${NAMESPACE}.svc.cluster.local" out_cluster_endpoint
              while true; do
                kubectl get inferenceservices.serving.kserve.io ${INFERENCE_SERVICE_NAME} -n ${NAMESPACE} -o json > ${inference_service}
                jq -r '.status' ${inference_service}
                out_cluster_endpoint=$(jq -r '.status.url' ${inference_service})
                cat <<EOF > $(results.string-result.path)
            {
              "IN_CLUSTER_ENDPOINT": "${in_cluster_endpoint}",
              "OUT_CLUSTER_ENDPOINT": "${out_cluster_endpoint}"
            }
            EOF
                status=$(jq -r '.status.conditions[] | select(.type == "Ready") | .status' ${inference_service} 2>/dev/null || echo "")
                if [ "${status}" = "True" ]; then
                  echo "InferenceService ${INFERENCE_SERVICE_NAME} 已就绪"
                  echo "等待部署就绪"
                  kubectl rollout status deployments.apps -n ${NAMESPACE} -l serving.kserve.io/inferenceservice=${INFERENCE_SERVICE_NAME}
                  break
                fi
                sleep 10
              done
            }

            function prepare_extra_metadata() {
              local inference_service="/tmp/inference-service.json"
              kubectl get inferenceservices.serving.kserve.io ${INFERENCE_SERVICE_NAME} -n ${NAMESPACE} -o json --ignore-not-found > ${inference_service}
              if [ "${UPDATE_IF_EXISTS}" != "true" ]; then
                if [ -s "${inference_service}" ]; then
                  echo "InferenceService ${INFERENCE_SERVICE_NAME} 已存在，请将 UPDATE_IF_EXISTS 设置为 true 以更新它"
                  exit 1
                fi
              else
                if [ -s "${inference_service}" ]; then
                  local resource_version uid
                  resource_version=$(jq -r '.metadata.resourceVersion' ${inference_service})
                  uid=$(jq -r '.metadata.uid' ${inference_service})
                  EXTRA_METADATA="
              resourceVersion: '${resource_version}'
              uid: ${uid}"
                fi
              fi
            }

            prepare_gitlab
            get_gitlab_project

            if [ -z "${MODEL_REPO_BRANCH}" ] && [ -z "${MODEL_REPO_TAG}" ]; then
              MODEL_REPO_BRANCH="${GITLAB_DEFAULT_BRANCH}"
            fi

            git_tag_commit=""
            if [ -n "${MODEL_REPO_TAG}" ]; then
              get_gitlab_tag
              git_tag_commit="${MODEL_REPO_TAG}"
            else
              get_gitlab_branch_commit_id
              git_tag_commit="${GITLAB_COMMIT_ID}"
            fi

            fetch_readme
            get_runtime
            prepare_extra_metadata

            cat <<EOF > /tmp/inference-service.yaml
            apiVersion: serving.kserve.io/v1beta1
            kind: InferenceService
            metadata:
              annotations:
                aml-model-repo: "${MODEL_REPO}"
                aml-model-repo-branch: "${MODEL_REPO_BRANCH}"
                aml-model-repo-id: "${GITLAB_PROJECT_ID}"
                aml-model-repo-tag-commit: "${git_tag_commit}"
                aml-pipeline-tag: "${PIPELINE_TAG}"
                cpaas.io/description: |-
                  ${INFERENCE_SERVICE_DESCRIPTION}
                serving.knative.dev/progress-deadline: 2400s
                serving.kserve.io/deploymentMode: ${deploy_model}
                ${pvc_name}
              labels:
                aml-model-group: "${GITLAB_GROUP}"
                aml-model-repo: "${MODEL_REPO}"
                aml-model-subgroup: "${GITLAB_SUBGROUP}"
                aml-pipeline-tag: "${PIPELINE_TAG}"
                aml.cpaas.io/runtime-type: ${RUNTIME_CLASS}
                service.subdomain: ${INFERENCE_SERVICE_NAME}-${GITLAB_GROUP}
              name: ${INFERENCE_SERVICE_NAME}
              namespace: ${NAMESPACE}
              ${EXTRA_METADATA}
            spec:
              predictor:
                minReplicas: ${MIN_REPLICAS}
                maxReplicas: ${MAX_REPLICAS}
                hostIPC: true
                model:
                  modelFormat:
                    name: ${LIBRARY_NAME}
                  protocolVersion: v2
                  resources:
                    requests:
                      ${cpu_request}
                      ${memory_request}
                    limits:
                      ${cpu_limit}
                      ${memory_limit}
                      ${nvidia_gpu_alloc_resource}
                      ${nvidia_gpu_cores_resource}
                      ${nvidia_gpu_mem_resource}
                      ${nvidia_gpu}
                      ${ephemeral_storage}
                  ${RUNTIME_COMMAND}
                  ${RUNTIME_ENVS}
                  ${RUNTIME_ARGS}
                  storageUri: hf://${NAMESPACE}/${MODEL_REPO}:${git_tag_commit}
                  runtime: ${RUNTIME_NAME}
                  name: kserve-container
            EOF
            echo "推理服务 YAML: "
            cat /tmp/inference-service.yaml

            kubectl apply -f /tmp/inference-service.yaml

            wait_for_inference_service
      taskRef:
        params:
          - name: kind
            value: task
          - name: catalog
            value: catalog
          - name: name
            value: kubectl
          - name: version
            value: "0.1"
        resolver: hub
      timeout: 30m0s
  finally: []
```

</details>

### 管道参数

管道包括以下需要配置的关键参数：

**服务参数：**

- `INFERENCE_SERVICE_NAME`：要部署的 InferenceService 的名称
- `INFERENCE_SERVICE_DESCRIPTION`：InferenceService 的描述（默认值：""）
- `UPDATE_IF_EXISTS`：如果 InferenceService 已存在，是否更新（默认值："true"）

**仓库参数：**

- `MODEL_REPO`：包含模型的模型仓库的名称（必需）
- `MODEL_REPO_BRANCH`：要使用的模型仓库的分支（默认值：""，不能与 MODEL_REPO_TAG 同时设置）
- `MODEL_REPO_TAG`：要使用的模型仓库的标签（默认值：""，不能与 MODEL_REPO_BRANCH 同时设置）

**运行时参数：**

- `RUNTIME_NAME`：要使用的服务运行时的名称，如果为空，将使用与 RUNTIME_CLASS 相同类的第一个运行时（默认值：""）
- `RUNTIME_CLASS`：服务运行时的类（如果 RUNTIME_NAME 为空，则必需）

**存储参数：**

- `EPHIMERAL_STORAGE_SIZE`：推理服务的临时存储大小（默认值："10Gi"，如果 PVC_NAME 和 EPHIMERAL_STORAGE_SIZE 都为空，将使用默认值）
- `PVC_NAME`：要用于推理服务的现有 PVC 的名称（默认值：""，如果指定，将忽略 EPHIMERAL_STORAGE_SIZE）

**副本参数：**

- `MIN_REPLICAS`：推理服务的最小副本数（默认值："1"，必须 >= 0）
- `MAX_REPLICAS`：推理服务的最大副本数（默认值："1"，必须 >= MIN_REPLICAS）

**注意**：部署模式根据副本配置自动确定：

- 如果 `MIN_REPLICAS` 等于 `MAX_REPLICAS`，服务将使用 `RawDeployment` 模式
- 如果 `MIN_REPLICAS` 与 `MAX_REPLICAS` 不同，服务将使用 `Serverless` 模式

**资源参数：**

- `CPU_REQUEST`：请求 CPU（默认值："1"，留空则不请求 CPU）
- `MEMORY_REQUEST`：请求内存（默认值："4Gi"，留空则不请求内存）
- `CPU_LIMIT`：限制 CPU（默认值："4"，留空则不限制 CPU）
- `MEMORY_LIMIT`：限制内存（默认值："16Gi"，留空则不限制内存）
- `NVIDIA_GPUALLOC`：NVIDIA GPU 分配 - GPU 卡数量（默认值："1"，留空则不分配 GPU）
- `NVIDIA_GPUCORES`：NVIDIA GPU 核心 - 每张卡的计算能力百分比，范围 1-100（默认值："50"，留空则不配置 GPU 核心）
- `NVIDIA_GPUMEM`：NVIDIA GPU 内存 - 每张卡的内存使用量（MiB）（默认值："4096"，留空则不配置 GPU 内存）
- `NVIDIA_GPU`：NVIDIA GPU 数量 - 使用 NVIDIA GPU 插件时分配的 GPU 卡数量，不能与 HAMi 参数（NVIDIA_GPUALLOC、NVIDIA_GPUCORES、NVIDIA_GPUMEM）一起使用（默认值：""，留空则不设置）

### 准备模型仓库

在部署推理服务之前，请确保模型仓库已正确准备：

1. **创建模型仓库**：在 `Alauda AI` 视图中，切换到将要运行管道的命名空间。在 `业务视图` 下，导航到左侧边栏并选择 `模型仓库`。在页面右侧，单击 `创建模型仓库` 按钮以创建新的模型仓库。

2. **模型仓库结构**：仓库必须包含一个 `README.md` 文件，至少包含以下元数据：

   - `pipeline_tag`：指定模型的管道标签
   - `library_name`：指定模型的库/框架名称

   可以使用 `模型仓库` 中的 `编辑元数据` 功能编辑 `README.md` 文件。

### 触发管道

按照以下步骤触发管道：

1. 选择 `deploy-inference-service` 管道并单击 `Run` 按钮以打开 `Run Pipeline` 对话框。

2. 在 `Run Pipeline` 对话框中，输入管道参数。对于具有默认值的参数，请使用 `Add Execution Parameter` 先暴露它们，然后再设置值。

3. （可选）设置参数后，单击 `Save as Trigger Template` 将当前参数保存为 `Trigger Template`。对于后续的管道运行，请单击 `Run Pipeline` 对话框中列出的模板，以自动设置所有参数。

4. 如果运行管道的 ServiceAccount 不是 `default`，请单击右上角的 `YAML` 按钮切换到 YAML 编辑模式，然后将 `taskRunTemplate.serviceAccountName` 添加到 `spec`：
   ```yaml
   spec:
     .... # 其他内容
     taskRunTemplate:
       serviceAccountName: <service-account-name>
   ```
   此配置也可以保存到 `Trigger Template` 中，以便在后续运行中方便重用。

5. 设置参数后，单击 `Run` 按钮以执行管道。

有关事件驱动管道执行的更多信息，请参阅 [Pipelines 文档](https://docs.alauda.io/alauda-devops-pipelines/) 中的 `Trigger` 部分。

### 检查 PipelineRun 状态和日志

可以在 `PipelineRuns` 中查看相应执行记录的执行状态和部署日志。管道将在 `InferenceService` 准备就绪后，等待相关部署准备就绪，然后完成。

### 常见问题解答

#### 1. Pod 创建因 PSA（Pod Security Admission）限制而失败

由于推理服务启用了 `hostIPC`，可能会因 PSA 违规而无法创建 Pods。要解决此问题，需要将命名空间上的 PSA 设置调整为特权模式。

可以通过添加以下标签将命名空间配置为特权 PSA 模式：

```bash
kubectl label namespace <namespace-name> pod-security.kubernetes.io/enforce=privileged --overwrite
```

或者，可以通过 Web UI 修改 PSA 设置：

1. 在 `Alauda AI` 视图中，切换到将要运行管道的命名空间
2. 在 `业务视图` 下，从左侧导航中选择 `Namespace`，找到需要修改的命名空间
3. 在 `Action` 下拉菜单中，找到并单击 `Update Pod Security Admission` 按钮
4. 在 `Security Mode` 下，将 `Enforce` 的值设置为 `Privileged`
5. 单击 `Update` 按钮以应用更改
