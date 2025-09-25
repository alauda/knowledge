---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# How to Use Pipeline to Deploy Inference Service

## Overview

This document demonstrates how to deploy inference services using DevOps Pipeline.

## Prerequisites

Before proceeding with the inference service deployment pipeline, ensure the following prerequisites are met:

1. **Alauda DevOps**: Install `Alauda DevOps next-gen` following the [Alauda DevOps documentation](https://docs.alauda.io/devops). `Alauda DevOps Pipelines` and `Alauda DevOps Connectors` must be installed.

2. **Alauda AI**: It is recommended to deploy Alauda AI for better management of models, training, and inference services. Refer to the [Alauda AI documentation](https://docs.alauda.io/ai/) for installation and configuration details.

3. **GPU Device Plugins**: It is recommended to deploy GPU device plugins such as `Hami` or `NVIDIA GPU Device Plugin` to utilize GPU resources for inference services. Refer to the `Device Management` section in the [Alauda AI documentation](https://docs.alauda.io/ai/) for deployment instructions.


### Configure RBAC

Configure RBAC for the namespace where the `Pipeline` will run. Since `Pipeline Tasks` use the `default` `ServiceAccount` by default, the following script configures permissions for the `ServiceAccount`:

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

Run the script to configure RBAC for the `default` `ServiceAccount`:
```bash
bash prepare_rbac.sh <namespace-name>
```

To use a dedicated `ServiceAccount`, run:
```bash
SA=<service-account-name> bash prepare_rbac.sh <namespace-name>
```

Note:

1. When using a `ServiceAccount` other than `default`, the `ServiceAccount` name must be specified when running pipeline. Refer to the following sections for details.

2. This script requires cluster administrator privileges to create `ClusterRoleBinding` resources.

### Create Pipeline

Follow these steps to create the Pipeline in `Alauda Container Platform`:

1. Navigate to the namespace where the pipeline will run in the `Alauda Container Platform` view.

2. In the left navigation, select `Pipelines` / `Pipelines`, and click the `Create` button on the right side of the opened page.

3. In the Create Pipeline dialog, enter name `deploy-inference-service`, then click the `Confirm` button to enter the pipeline orchestration page.

4. On the pipeline orchestration page, click the `YAML` button in the upper right corner to switch to YAML editing mode, and paste the following pipeline YAML content into the editor.

5. Click the `Create` button in the lower right corner to create the `deploy-inference-service` pipeline.

<details>
<summary>Pipeline: deploy-inference-service</summary>

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: deploy-inference-service
spec:
  params:
    - name: INFERENCE_SERVICE_NAME
      type: string
      description: the name of the inference service
    - name: INFERENCE_SERVICE_DESCRIPTION
      type: string
      description: the description of the inference service
      default: ""
    - name: UPDATE_IF_EXISTS
      type: string
      description: whether to update the   if it already exists
      default: "true"
    - description: name of the model repository
      name: MODEL_REPO
      type: string
    - default: ""
      description: branch of the model repository
      name: MODEL_REPO_BRANCH
      type: string
    - default: ""
      description: tag of the model repository
      name: MODEL_REPO_TAG
      type: string
    - description: serving runtime name, if empty, will use the first runtime with the same class as RUNTIME_CLASS
      name: RUNTIME_NAME
      type: string
      default: ""
    - description: serving runtime class
      name: RUNTIME_CLASS
      type: string
    - description: use ephemeral storage for the InferenceService
      name: EPHIMERAL_STORAGE_SIZE
      type: string
      default: "10Gi"
    - default: ""
      description: use existing pvc for the InferenceService
      name: PVC_NAME
      type: string
    - description: the minimum number of replicas
      name: MIN_REPLICAS
      type: string
      default: "1"
    - description: the maximum number of replicas
      name: MAX_REPLICAS
      type: string
      default: "1"
    - name: ENABLE_SERVERLESS
      type: string
      default: "false"
    - description: request cpu
      name: CPU_REQUEST
      type: string
      default: "1"
    - description: request memory
      name: MEMORY_REQUEST
      type: string
      default: "4Gi"
    - description: limit cpu
      name: CPU_LIMIT
      type: string
      default: "4"
    - description: limit memory
      name: MEMORY_LIMIT
      type: string
      default: "16Gi"
    - default: "1"
      description: Hami NVIDIA GPU allocation - number of GPU cards, leave empty to not allocate GPU
      name: NVIDIA_GPUALLOC
      type: string
    - default: "50"
      description: Hami NVIDIA GPU cores - percentage of compute power per card, range 1-100, leave empty to not configure GPU cores)
      name: NVIDIA_GPUCORES
      type: string
    - default: "4096"
      description: Hami NVIDIA GPU memory - memory usage per card in MiB, leave empty to not configure GPU memory)
      name: NVIDIA_GPUMEM
      type: string
    - default: ""
      description: NVIDIA GPU count - number of GPU cards allocated when using NVIDIA GPU plugin, cannot be used together with Hami parameters, leave empty to not set
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
            - ENABLE_SERVERLESS=$(params.ENABLE_SERVERLESS)
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
            set -exuo pipefail
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
            echo "ENABLE_SERVERLESS: ${ENABLE_SERVERLESS}"
            echo "CPU_REQUEST: ${CPU_REQUEST}"
            echo "MEMORY_REQUEST: ${MEMORY_REQUEST}"
            echo "CPU_LIMIT: ${CPU_LIMIT}"
            echo "MEMORY_LIMIT: ${MEMORY_LIMIT}"
            echo "NVIDIA_GPUALLOC: ${NVIDIA_GPUALLOC}"
            echo "NVIDIA_GPUCORES: ${NVIDIA_GPUCORES}"
            echo "NVIDIA_GPUMEM: ${NVIDIA_GPUMEM}"
            echo "NVIDIA_GPU: ${NVIDIA_GPU}"

            if [ -z "${RUNTIME_NAME}" ] && [ -z "${RUNTIME_CLASS}" ]; then
              echo "ERROR: Either RUNTIME_NAME or RUNTIME_CLASS must be specified"
              exit 1
            fi

            if [ -z "${MODEL_REPO}" ]; then
              echo "ERROR: MODEL_REPO cannot be empty"
              exit 1
            fi

            if [ -n "${MODEL_REPO_TAG}" ] && [ -n "${MODEL_REPO_BRANCH}" ]; then
              echo "ERROR: MODEL_REPO_TAG and MODEL_REPO_BRANCH cannot be set at the same time"
              exit 1
            fi

            cpu_limit="cpu: ${CPU_LIMIT}"
            cpu_request="cpu: ${CPU_REQUEST}"
            if [ -z "${CPU_LIMIT}" ]; then
              echo "CPU limit is empty, not configuring CPU limit!"
              cpu_limit=""
            fi

            if [ -z "$CPU_REQUEST" ]; then
              echo "CPU request is empty, not configuring CPU request!"
              cpu_request=""
            fi

            memory_limit="memory: ${MEMORY_LIMIT}"
            memory_request="memory: ${MEMORY_REQUEST}"
            if [ -z "$MEMORY_LIMIT" ]; then
              echo "Memory limit is empty, not configuring memory limit!"
              memory_limit=""
            fi

            if [ -z "$MEMORY_REQUEST" ]; then
              echo "Memory request is empty, not configuring memory request!"
              memory_request=""
            fi

            nvidia_gpu_alloc_resource="nvidia.com/gpualloc: ${NVIDIA_GPUALLOC}"
            nvidia_gpu_cores_resource="nvidia.com/gpucores: ${NVIDIA_GPUCORES}"
            nvidia_gpu_mem_resource="nvidia.com/gpumem: ${NVIDIA_GPUMEM}"

            if [ -z "$NVIDIA_GPUALLOC" ]; then
              echo "NVIDIA_GPUALLOC is empty, not configuring nvidia.com/gpualloc resource!"
              nvidia_gpu_alloc_resource=""
            fi

            if [ -z "$NVIDIA_GPUCORES" ]; then
              echo "NVIDIA_GPUCORES is empty, not configuring nvidia.com/gpucores resource!"
              nvidia_gpu_cores_resource=""
            fi

            if [ -z "$NVIDIA_GPUMEM" ]; then
              echo "NVIDIA_GPUMEM is empty, not configuring nvidia.com/gpumem resource!"
              nvidia_gpu_mem_resource=""
            fi

            nvidia_gpu="nvidia.com/gpu: ${NVIDIA_GPU}"
            if [ -z "$NVIDIA_GPU" ]; then
              echo "NVIDIA_GPU is empty, not configuring nvidia.com/gpu resource!"
              nvidia_gpu=""
            fi

            if [ -n "$NVIDIA_GPU" ] && ([ -n "$NVIDIA_GPUALLOC" ] || [ -n "$NVIDIA_GPUCORES" ] || [ -n "$NVIDIA_GPUMEM" ]); then
                echo "Cannot use NVIDIA_GPU with Hami resources:"
                echo "NVIDIA_GPU=${NVIDIA_GPU}, NVIDIA_GPUALLOC=${NVIDIA_GPUALLOC}, NVIDIA_GPUCORES=${NVIDIA_GPUCORES}, NVIDIA_GPUMEM=${NVIDIA_GPUMEM}"
                exit 1
            fi

            deploy_model="RawDeployment"
            if [ "${ENABLE_SERVERLESS}" = "true" ]; then
              deploy_model="Serverless"
            fi

            if [ -z "$PVC_NAME" ] && [ -z "${EPHIMERAL_STORAGE_SIZE}" ]; then
              EPHIMERAL_STORAGE_SIZE="10Gi"
              echo "Both PVC_NAME and EPHIMERAL_STORAGE_SIZE are empty, EPHIMERAL_STORAGE_SIZE using default value: ${EPHIMERAL_STORAGE_SIZE}"
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
                echo "GITLAB_BASE_URL is not set"
                exit 1
              fi

              scheme="$(jq -r '.data.MODEL_REPO_GIT_SCHEME' ${config})"
              if [ -z "${scheme}" ]; then
                scheme="https"
              fi
              GITLAB_BASE_URL="${scheme}://${base_url}"

              set +x
              token="$(kubectl get secrets -n ${NAMESPACE} aml-image-builder-secret -o jsonpath='{.data.MODEL_REPO_GIT_TOKEN}' | base64 -d)"
              if [ -z "${token}" ]; then
                echo "GITLAB_TOKEN is not set"
                exit 1
              fi
              GITLAB_TOKEN="${token}"
              set -x
            }

            function get_gitlab_project() {
              local project_id namespace_full_path tag
              local project=/tmp/project.json

              set +x
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects?search_namespaces=true&search=amlmodels" > ${project}
              set -x

              project_id="$(jq -r --arg name "${MODEL_REPO}" '.[] | select(.name == $name) | .id' ${project})"
              if [ -z "${project_id}" ]; then
                echo "can not find project id for repo: ${MODEL_REPO}"
                exit 1
              fi
              GITLAB_PROJECT_ID="${project_id}"

              set +x
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}" > ${project}
              set -x

              namespace_full_path="$(jq -r '.namespace.full_path' ${project})"
              GITLAB_GROUP="$(echo "${namespace_full_path}" | awk -F '/' '{print $1}')"
              GITLAB_SUBGROUP="$(echo "${namespace_full_path}" | awk -F '/' '{for(i=2;i<=NF;i++) printf "%s%s", $i, (i<NF?"/":"")}')"

              GITLAB_DEFAULT_BRANCH="$(jq -r '.default_branch' ${project})"
            }

            function get_gitlab_branch_commit_id() {
              local ref_name="${MODEL_REPO_BRANCH}" commit_id encoded_ref_name
              local branch=/tmp/branch.json

              encoded_ref_name="$(printf '%s' "${ref_name}" | jq -sRr @uri)"

              set +x
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/repository/branches/${encoded_ref_name}" > ${branch}
              set -x

              commit_id="$(jq -r '.commit.id' ${branch})"
              if [ -z "${commit_id}" ] || [ "${commit_id}" = "null" ]; then
                echo "can not find commit id for branch: ${ref_name}"
                cat ${branch}
                exit 1
              fi
              GITLAB_COMMIT_ID="${commit_id}"
            }

            function get_gitlab_tag() {
              local ref_name=$"{MODEL_REPO_TAG}" commit_id encoded_ref_name
              local tag=/tmp/tag.json

              encoded_ref_name="$(printf '%s' "${ref_name}" | jq -sRr @uri)"

              set +x
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/repository/tags/${encoded_ref_name}" > ${tag}
              set -x

              commit_id="$(jq -r '.commit.id' ${tag})"
              if [ -z "${commit_id}" ] || [ "${commit_id}" = "null" ]; then
                echo "can not find tag: ${ref_name}"
                exit 1
              fi
              GITLAB_COMMIT_ID="${commit_id}"
            }

            function fetch_readme() {
              local readme=/tmp/readme.md

              set +x
              curl -k -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "${GITLAB_BASE_URL}/api/v4/projects/${GITLAB_PROJECT_ID}/repository/files/README.md?ref=${GITLAB_COMMIT_ID}" | jq -r '.content' | base64 -d > ${readme}
              set -x

              echo "README.md"
              cat $readme

              PIPELINE_TAG=$(grep '^pipeline_tag:' ${readme} | head -n 1 | sed 's/pipeline_tag:[[:space:]]*//')
              if [ -z ${PIPELINE_TAG} ]; then
                echo "ERROR: cannot find pipeline_tag in README.md"
              fi

              LIBRARY_NAME=$(grep '^library_name:' ${readme} | head -n 1 | sed 's/library_name:[[:space:]]*//')
              if [ -z ${LIBRARY_NAME} ]; then
                echo "ERROR: cannot find library_name in README.md"
              fi
            }

            function get_runtime() {
              local runtime=/tmp/runtime.json
              local supported_frameworks is_supported
              local args command envs runtime_class

              if [ -n "${RUNTIME_NAME}" ]; then
                kubectl get clusterservingruntimes.serving.kserve.io ${RUNTIME_NAME} -o json --ignore-not-found > ${runtime}
                if [ ! -s "${runtime}" ]; then
                  echo "runtime ${RUNTIME_NAME} not found"
                  exit 1
                fi
                runtime_class=$(jq -r '.metadata.labels["cpaas.io/runtime-class"]' ${runtime})
                if [ -z "${RUNTIME_CLASS}" ]; then
                  RUNTIME_CLASS="${runtime_class}"
                else
                  if [ "${RUNTIME_CLASS}" != "${runtime_class}" ]; then
                    echo "runtime ${RUNTIME_NAME} has runtime class ${runtime_class}, but ${RUNTIME_CLASS} is specified"
                    exit 1
                  fi
                fi
              else
                kubectl get clusterservingruntimes.serving.kserve.io -o json -l cpaas.io/runtime-class=${RUNTIME_CLASS} > ${runtime}
                if [ $(jq -r '.items | length' ${runtime}) -eq 0 ]; then
                  echo "runtime with class ${RUNTIME_CLASS} not found"
                  exit 1
                fi
                jq -r '.items[0]' ${runtime} > ${runtime}.tmp && mv ${runtime}.tmp ${runtime}
                RUNTIME_NAME=$(jq -r '.metadata.name' ${runtime})
                echo "use runtime: ${RUNTIME_NAME}"
              fi

              is_supported=$(jq -r --arg framework "${LIBRARY_NAME}" '.spec.supportedModelFormats[] | select(.name == $framework) | .name' ${runtime})
              if [ -z "${is_supported}" ]; then
                echo "LIBRARY_NAME ${LIBRARY_NAME} is not supported by runtime ${RUNTIME_NAME}"
                exit 1
              fi

              args=$(jq -r '.spec.containers[0].args[]? | "      - |-\n        " + .' ${runtime})
              cmds=$(jq -r '.spec.containers[0].command[]? | "      - |-\n        " + .' ${runtime})
              envs=$(jq -r '.spec.containers[0].env[]? | "      - name: " + .name + "\n        value: |-\n          " + (.value // "")' ${runtime})
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
                status=$(jq -r '.status.conditions[] | select(.type == "Ready") | .status' ${inference_service})
                if [ "${status}" = "True" ]; then
                  echo "InferenceService ${INFERENCE_SERVICE_NAME} is ready"
                  echo "Wait for deployments to be ready"
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
                  echo "InferenceService ${INFERENCE_SERVICE_NAME} already exists, please set UPDATE_IF_EXISTS to true to update it"
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
            echo "InferenceService YAML: "
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

### Pipeline Parameters

The pipeline includes the following key parameters that need to be configured:

**Service Parameters:**
- `INFERENCE_SERVICE_NAME`: The name of the InferenceService to be deployed
- `INFERENCE_SERVICE_DESCRIPTION`: The description of the InferenceService (default: "")
- `UPDATE_IF_EXISTS`: Whether to update the InferenceService if it already exists (default: "true")

**Repository Parameters:**
- `MODEL_REPO`: The name of the model repository containing the model
- `MODEL_REPO_BRANCH`: The branch of the model repository to use (default: "")
- `MODEL_REPO_TAG`: The tag of the model repository to use (default: "")

**Runtime Parameters:**
- `RUNTIME_NAME`: The name of the serving runtime to use, if empty, will use the first runtime with the same class as RUNTIME_CLASS (default: "")
- `RUNTIME_CLASS`: The class of the serving runtime

**Storage Parameters:**
- `EPHIMERAL_STORAGE_SIZE`: The size of ephemeral storage for the InferenceService (default: "10Gi", will use default value if both PVC_NAME and EPHIMERAL_STORAGE_SIZE are empty)
- `PVC_NAME`: The name of an existing PVC to use for the InferenceService (default: "", if specified, EPHIMERAL_STORAGE_SIZE will be ignored)

**Replica Parameters:**
- `MIN_REPLICAS`: The minimum number of replicas for the InferenceService (default: "1")
- `MAX_REPLICAS`: The maximum number of replicas for the InferenceService (default: "1")
- `ENABLE_SERVERLESS`: Whether to enable serverless mode for the InferenceService (default: "false")

**Resource Parameters:**
- `CPU_REQUEST`: Request CPU (default: "1", leave empty to not request CPU)
- `MEMORY_REQUEST`: Request memory (default: "4Gi", leave empty to not request memory)
- `CPU_LIMIT`: Limit CPU (default: "4", leave empty to not limit CPU)
- `MEMORY_LIMIT`: Limit memory (default: "16Gi", leave empty to not limit memory)
- `NVIDIA_GPUALLOC`: NVIDIA GPU allocation - number of GPU cards (default: "1", leave empty to not allocate GPU)
- `NVIDIA_GPUCORES`: NVIDIA GPU cores - percentage of compute power per card, range 1-100 (default: "50", leave empty to not configure GPU cores)
- `NVIDIA_GPUMEM`: NVIDIA GPU memory - memory usage per card in MiB (default: "4096", leave empty to not configure GPU memory)
- `NVIDIA_GPU`: NVIDIA GPU count - number of GPU cards allocated when using NVIDIA GPU plugin, cannot be used together with Hami parameters (default: "", leave empty to not set)

### Prepare Model Repository

Before deploying the InferenceService, ensure that the model repository is properly prepared:

1. **Create Model Repository**: In the `Alauda AI` view, switch to the namespace where the pipeline will run. Under `Business view`, navigate to the left sidebar and select `Model Repository`. On the right side of the page, click the `Create Model Repository` button to create a new model repository.

2. **Model Repository Structure**: The repository must include a `README.md` file with at least the following metadata:
     - `pipeline_tag`: Specifies the pipeline tag for the model
     - `library_name`: Specifies the library/framework name for the model

   The `README.md` file can be edited using the `Edit Metadata` feature under the `File Management` tab in the `Model Repository`.

### Trigger Pipeline

Follow these steps to trigger the pipeline:

1. Select the `deploy-inference-service` pipeline and click the `Run` button to open the `Run Pipeline` dialog.

2. In the `Run Pipeline` dialog, enter the pipeline parameters. For parameters with default values, use `Add Execution Parameter` to expose them before setting values.

3. (Optional) After setting the parameters, click `Save as Trigger Template` to save the current parameters as a `Trigger Template`. For subsequent pipeline runs, click on the template listed under `Trigger Templates` in the `Run Pipeline` dialog to automatically set all parameters.

4. If the ServiceAccount for running the pipeline is not `default`, click the `YAML` button in the upper right corner to switch to YAML editing mode, then add `taskRunTemplate.serviceAccountName` to `spec`:
   ```yaml
   spec:
     .... # other content
     taskRunTemplate:
       serviceAccountName: <service-account-name>
   ```
   This configuration can also be saved to the `Trigger Template` for convenient reuse in subsequent runs.

5. After setting the parameters, click the `Run` button to execute the pipeline.


For event-driven pipeline execution, refer to the `Trigger` section in the [Pipelines documentation](https://docs.alauda.io/alauda-devops-pipelines/).


### Checkout PipelineRun status and logs

The execution status and deployment logs can be viewed in the corresponding execution record in `PipelineRuns`. The pipeline will wait for the `InferenceService` to be ready and then wait for the associated deployments to be ready before completing.

### FAQ

#### 1. Pod creation fails due to PSA (Pod Security Admission) restrictions

Since the inference service enables `hostIPC`, it may fail to create Pods due to PSA violations. To resolve this issue, the PSA settings on the Namespace need to be adjusted to privileged mode.

The namespace can be configured with privileged PSA mode by adding the following label:

```bash
kubectl label namespace <namespace-name> pod-security.kubernetes.io/enforce=privileged --overwrite
```

Alternatively, the PSA settings can be modified through the Web UI:

1. In the `Alauda AI` view, switch to the namespace where the pipeline will run
2. Under `Business view`, select `Namespace` from the left navigation and find the namespace that needs to be modified
3. In the `Action` dropdown menu, find and click the `Update Pod Security Admission` button
4. Under `Security Mode`, set the value of `Enforce` to `Privileged`
5. Click the `Update` button to apply the changes