---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# How to Use Pipeline to Evaluate AI Models

## Overview

This document demonstrates how to evaluate AI models using DevOps Pipeline. The YOLOv5 model is used as an example to illustrate the evaluation workflow. The overall framework presented here can be adapted for evaluating other models as well, requiring only adjustments to input parameters, execution scripts, and evaluation code.


## Prerequisites

Before proceeding with the AI model evaluation pipeline, ensure the following prerequisites are met:

1. **Alauda DevOps**: Install `Alauda DevOps next-gen` following the [Alauda DevOps documentation](https://docs.alauda.io/devops). `Alauda DevOps Pipelines` and `Alauda DevOps Connectors` must be installed.

2. **Volcano**: Install the `Volcano` cluster plugin to enable GPU scheduling and resource management for AI workloads.


3. **Evidently**: Install Evidently UI following the [Evidently installation documentation](How_to_Install_and_use_Evidently.md). Evidently is used for model evaluation result visualization and monitoring.

4. **Required Repositories**: Prepare:
   - A Git repository for storing model code and validation datasets.
   - A container image registry for storing the evaluation image.

5. **Alauda AI**: It is recommended to deploy Alauda AI for better management of models, training, and inference services. Refer to the [Alauda AI documentation](https://docs.alauda.io/ai/) for installation and configuration details.

6. **GPU Device Plugins**: It is recommended to deploy GPU device plugins such as `HAMi` or `NVIDIA GPU Device Plugin` to utilize GPU resources for AI evaluation. Refer to the `Device Management` section in the [Alauda AI documentation](https://docs.alauda.io/ai/) for deployment instructions.


### Prepare Model Repository

Clone the code from the [yolov5 v7.0](https://github.com/ultralytics/yolov5) of the YOLOv5 repository. The main requirement is to have the `val.py` script available for model evaluation.

### Prepare the Model to be Evaluated

The model to be evaluated comes from the output of the `yolov5-training` pipeline. Refer to the **How to Use Pipeline to Train AI Models** for details on how to train models and obtain the trained model files.

### Prepare Validation Dataset

Download the validation images from [val2017.zip](http://images.cocodataset.org/zips/val2017.zip) and the annotation information from [annotations_trainval2017.zip](http://images.cocodataset.org/annotations/annotations_trainval2017.zip).

The directory structure should be:

```text
images/
  val2017/           # val2017.zip extracted content
annotations/         # annotations_trainval2017.zip extracted content
val2017.txt          # File referenced by coco.yaml, generated with the following command:
                     # for i in $(ls images/val2017); do echo "../datasets/coco/images/val2017/$i"; done > val2017.txt
```

Since `*.json` and `*.jpg` files are large binary files, consider using Git LFS to manage them:

```bash
git lfs track "*.json" "*.jpg"
```

### Prepare Evaluation Image

The following Dockerfile can be used to build the evaluation image. Users can compile their own evaluation image using this Dockerfile:

<details>

<summary>Dockerfile </summary>

```dockerfile
FROM nvcr.io/nvidia/pytorch:24.12-py3

# optional, change apt source
#RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.ustc.edu.cn@g' /etc/apt/sources.list && \
#    sed -i 's/security.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list &&

RUN apt-get update && \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get install -yq --no-install-recommends git git-lfs unzip curl ffmpeg libfreetype6-dev && \
    apt clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /root/.config/Ultralytics && \
    curl -fsSL https://ultralytics.com/assets/Arial.ttf -o /root/.config/Ultralytics/Arial.ttf && \
    curl -fsSL https://ultralytics.com/assets/Arial.Unicode.ttf -o /root/.config/Ultralytics/Arial.Unicode.ttf

# optional, add "-i https://pypi.tuna.tsinghua.edu.cn/simple" to pip install arguments to download from a proxy source.

RUN pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir \
      "Pillow==9.5.0" \
      "numpy<2.0.0" \
      "opencv-python<4.12.0" \
      "numpy>=1.18.5" \
      "PyYAML>=5.3.1" \
      "matplotlib>=3.2.2" \
      "pandas>=1.1.4" \
      "scipy>=1.4.1" \
      "requests>=2.23.0" \
      "psutil" \
      "pycocotools>=2.0" \
      "seaborn>=0.11.0" \
      "gitpython>=3.1.0" \
      "evidently==0.7.14"
```

</details>

### Configure RBAC

Configure RBAC for the namespace where the `Pipeline` will run. Since `Pipeline Tasks` use the `default` `ServiceAccount` by default, the following script configures permissions for the `ServiceAccount`:

<details>

<summary>prepare_rbac.sh</summary>

```bash
#!/bin/bash

NS=$1
SA=${SA:-"default"}
NAME="yolov5-evaluating"

if [ -z "$(kubectl get serviceaccount ${SA} -n ${NS} --ignore-not-found)" ]; then
    kubectl create serviceaccount ${SA} -n ${NS}
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
  - pods
  - pods/log
  verbs:
  - get
  - list
  - watch
- apiGroups:
  - batch.volcano.sh
  resources:
  - jobs
  verbs:
  - get
  - list
  - watch
  - create
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

2. If permission issues are encountered during execution, contact the platform administrator to execute the script.

### Create Pipeline

Follow these steps to create the Pipeline in `Alauda Container Platform`:

1. Navigate to the namespace where the pipeline will run in the `Alauda Container Platform` view.

2. In the left navigation, select `Pipelines` / `Pipelines`, and click the `Create` button on the right side of the opened page.

3. In the Create Pipeline dialog, enter name `yolov5-evaluating`, then click the `Confirm` button to enter the pipeline orchestration page.

4. On the pipeline orchestration page, click the `YAML` button in the upper right corner to switch to YAML editing mode, and paste the following pipeline YAML content into the editor.

5. Click the `Create` button in the lower right corner to create the `yolov5-evaluating` pipeline.

<details>
<summary>Pipeline: yolov5-evaluating</summary>

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: yolov5-evaluating
spec:
  params:
    - description: The Git URL of the model repository containing the YOLOv5 code and val.py script
      name: MODEL_REPO_URL
      type: string
    - default: ""
      description: The branch of the model repository to use
      name: MODEL_REPO_BRANCH
      type: string
    - description: The Git URL of the dataset repository containing validation images and annotations
      name: DATASET_REPO_URL
      type: string
    - default: ""
      description: The branch of the dataset repository to use
      name: DATASET_REPO_BRANCH
      type: string
    - default: "/mnt/workspace/datasets/coco"
      description: The directory path where the dataset is mounted in the container
      name: DATASET_DIR
      type: string
    - default: "/mnt/workspace/datasets/coco/annotations/instances_val2017.json"
      description: The path to the COCO annotation JSON file for validation
      name: ANNOTATION_JSON
      type: string
    - description: The Git URL of the repository containing the trained model to be evaluated
      name: OUTPUT_MODEL_REPO_URL
      type: string
    - default: ""
      description: The branch of the output model repository to use
      name: OUTPUT_MODEL_REPO_BRANCH
      type: string
    - default: "1/model.torchscript"
      description: The relative path to the trained model file within the output model repository
      name: OUTPUT_MODEL_PATH
      type: string
    - description: The name of the Kubernetes secret containing Git credentials (GIT_USER and GIT_TOKEN keys)
      name: GIT_CREDENTIAL_SECRET_NAME
      type: string
    - description: The container image for the model evaluation job
      name: EVALUATING_IMAGE
      type: string
    - description: The size of temporary storage for the evaluation job
      name: TEMPORARY_STORAGE_SIZE
      type: string
      default: "5Gi"
    - description: The CPU request for the evaluation job
      name: CPU_REQUEST
      type: string
      default: "1"
    - description: The memory request for the evaluation job
      name: MEMORY_REQUEST
      type: string
      default: "8Gi"
    - description: The CPU limit for the evaluation job
      name: CPU_LIMIT
      type: string
      default: "8"
    - description: The memory limit for the evaluation job
      name: MEMORY_LIMIT
      type: string
      default: "20Gi"
    - default: "1"
      description: HAMi NVIDIA GPU allocation - number of GPU cards, leave empty to not allocate GPU
      name: NVIDIA_GPUALLOC
      type: string
    - default: "50"
      description: HAMi NVIDIA GPU cores - percentage of compute power per card, range 1-100, leave empty to not configure GPU cores)
      name: NVIDIA_GPUCORES
      type: string
    - default: "4096"
      description: HAMi NVIDIA GPU memory - memory usage per card in MiB, leave empty to not configure GPU memory)
      name: NVIDIA_GPUMEM
      type: string
    - default: ""
      description: NVIDIA GPU count - number of GPU cards allocated when using NVIDIA GPU plugin, cannot be used together with HAMi parameters, leave empty to not set
      name: NVIDIA_GPU
      type: string
    - description: The image size for model evaluation (width and height in pixels)
      name: EVALUATE_ARG_IMAGE_SIZE
      type: string
      default: "640"
    - description: The batch size for model evaluation
      name: EVALUATE_ARG_BATCH_SIZE
      type: string
      default: "16"
    - description: The path to the dataset configuration YAML file
      name: EVALUATE_ARG_DATA
      type: string
      default: "coco.yaml"
    - description: The path to the trained model weights file
      name: EVALUATE_ARG_WEIGHTS
      type: string
      default: "models/model.torchscript"
    - description: The number of worker threads for data loading
      name: EVALUATE_ARG_WORKERS
      type: string
      default: "0"
    - description: The device(s) to use for evaluation, multiple devices separated by comma (e.g., "0,1,2,3"), set "cpu" to use CPU
      name: EVALUATE_ARG_DEVICE
      type: string
      default: "0"
    - name: EVIDENTLY_ENDPOINT
      description: The Evidently UI service endpoint URL for uploading evaluation reports
      type: string
    - name: EVIDENTLY_PROJECT_NAME
      description: The name of the Evidently project to store evaluation reports
      type: string
      default: ""
    - name: EVIDENTLY_API_KEY
      description: The API key for accessing the Evidently workspace
      type: string
      default: ""
  results:
    - description: ""
      name: ReportURL
      type: string
      value: $(tasks.log.results.string-result)
  tasks:
    - name: create-job
      params:
        - name: args
          value:
            - MODEL_REPO_URL=$(params.MODEL_REPO_URL)
            - MODEL_REPO_BRANCH=$(params.MODEL_REPO_BRANCH)
            - DATASET_REPO_URL=$(params.DATASET_REPO_URL)
            - DATASET_REPO_BRANCH=$(params.DATASET_REPO_BRANCH)
            - DATASET_DIR=$(params.DATASET_DIR)
            - ANNOTATION_JSON=$(params.ANNOTATION_JSON)
            - OUTPUT_MODEL_REPO_URL=$(params.OUTPUT_MODEL_REPO_URL)
            - OUTPUT_MODEL_REPO_BRANCH=$(params.OUTPUT_MODEL_REPO_BRANCH)
            - OUTPUT_MODEL_PATH=$(params.OUTPUT_MODEL_PATH)
            - GIT_CREDENTIAL_SECRET_NAME=$(params.GIT_CREDENTIAL_SECRET_NAME)
            - EVALUATING_IMAGE=$(params.EVALUATING_IMAGE)
            - TEMPORARY_STORAGE_SIZE=$(params.TEMPORARY_STORAGE_SIZE)
            - CPU_REQUEST=$(params.CPU_REQUEST)
            - MEMORY_REQUEST=$(params.MEMORY_REQUEST)
            - CPU_LIMIT=$(params.CPU_LIMIT)
            - MEMORY_LIMIT=$(params.MEMORY_LIMIT)
            - NVIDIA_GPUALLOC=$(params.NVIDIA_GPUALLOC)
            - NVIDIA_GPUCORES=$(params.NVIDIA_GPUCORES)
            - NVIDIA_GPUMEM=$(params.NVIDIA_GPUMEM)
            - NVIDIA_GPU=$(params.NVIDIA_GPU)
            - EVALUATE_ARG_IMAGE_SIZE=$(params.EVALUATE_ARG_IMAGE_SIZE)
            - EVALUATE_ARG_BATCH_SIZE=$(params.EVALUATE_ARG_BATCH_SIZE)
            - EVALUATE_ARG_DATA=$(params.EVALUATE_ARG_DATA)
            - EVALUATE_ARG_WEIGHTS=$(params.EVALUATE_ARG_WEIGHTS)
            - EVALUATE_ARG_WORKERS=$(params.EVALUATE_ARG_WORKERS)
            - EVALUATE_ARG_DEVICE=$(params.EVALUATE_ARG_DEVICE)
            - EVIDENTLY_ENDPOINT=$(params.EVIDENTLY_ENDPOINT)
            - EVIDENTLY_PROJECT_NAME=$(params.EVIDENTLY_PROJECT_NAME)
            - EVIDENTLY_API_KEY=$(params.EVIDENTLY_API_KEY)
        - name: script
          value: |-
            set -euo pipefail
            export "$@"

            if [ -z "$MODEL_REPO_URL" ]; then
              echo "Model repository URL cannot be empty"
              exit 1
            fi

            if [ -z "$DATASET_REPO_URL" ]; then
              echo "Dataset repository URL cannot be empty"
              exit 1
            fi

            if [ -z "$OUTPUT_MODEL_REPO_URL" ]; then
              echo "Output model repository URL cannot be empty"
              exit 1
            fi

            if [ -z "$DATASET_DIR" ]; then
              echo "Dataset directory cannot be empty"
              exit 1
            fi

            if [ -z "$GIT_CREDENTIAL_SECRET_NAME" ]; then
              echo "Git credentials cannot be empty"
              exit 1
            fi

            if [ -z "$EVALUATING_IMAGE" ]; then
              echo "Evaluation image cannot be empty"
              exit 1
            fi

            if [ -z "$TEMPORARY_STORAGE_SIZE" ]; then
              TEMPORARY_STORAGE_SIZE="5Gi"
              echo "Temporary storage size is empty, using default storage size: $TEMPORARY_STORAGE_SIZE"
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
                echo "Cannot use NVIDIA_GPU with HAMi resources:"
                echo "NVIDIA_GPU=${NVIDIA_GPU}, NVIDIA_GPUALLOC=${NVIDIA_GPUALLOC}, NVIDIA_GPUCORES=${NVIDIA_GPUCORES}, NVIDIA_GPUMEM=${NVIDIA_GPUMEM}"
                exit 1
            fi

            if [ -z "$EVALUATE_ARG_IMAGE_SIZE" ]; then
              EVALUATE_ARG_IMAGE_SIZE="640"
              echo "Evaluation argument image size is empty, using default value: $EVALUATE_ARG_IMAGE_SIZE"
            fi

            if [ -z "$EVALUATE_ARG_BATCH_SIZE" ]; then
              EVALUATE_ARG_BATCH_SIZE="16"
              echo "Evaluation argument batch size is empty, using default value: $EVALUATE_ARG_BATCH_SIZE"
            fi

            if [ -z "$EVALUATE_ARG_DATA" ]; then
              EVALUATE_ARG_DATA="coco.yaml"
              echo "Evaluation argument data is empty, using default value: $EVALUATE_ARG_DATA"
            fi

            if [ -z "$EVALUATE_ARG_WEIGHTS" ]; then
              EVALUATE_ARG_WEIGHTS="models/model.torchscript"
              echo "Evaluation argument weights is empty, using default value: $EVALUATE_ARG_WEIGHTS"
            fi

            if [ -z "$EVALUATE_ARG_WORKERS" ]; then
              EVALUATE_ARG_WORKERS="0"
              echo "Evaluation argument worker is empty, using default value: $EVALUATE_ARG_WORKERS"
            fi

            if [ -z "$EVALUATE_ARG_DEVICE" ]; then
              EVALUATE_ARG_DEVICE="0"
              echo "Evaluation argument device is empty, using default value: $EVALUATE_ARG_DEVICE"
            fi

            if [ -z "$EVIDENTLY_ENDPOINT" ]; then
              echo "Evidently endpoint is empty, not configuring evidently endpoint!"
              EVIDENTLY_ENDPOINT=""
            else
              if [[ ! "$EVIDENTLY_ENDPOINT" =~ ^https?:// ]]; then
                echo "ERROR: Evidently endpoint must start with https:// or http://, got: $EVIDENTLY_ENDPOINT"
                exit 1
              fi
            fi

            if [ -z "$EVIDENTLY_PROJECT_NAME" ]; then
              EVIDENTLY_PROJECT_NAME=$(context.pipelineRun.namespace)
              echo "Evidently project name is empty, use namespace as project name"
            fi

            echo "Model repository URL: $MODEL_REPO_URL ${MODEL_REPO_BRANCH}"
            echo "Dataset repository URL: $DATASET_REPO_URL ${DATASET_REPO_BRANCH}"
            echo "Output model repository URL: $OUTPUT_MODEL_REPO_URL ${OUTPUT_MODEL_REPO_BRANCH} ${OUTPUT_MODEL_PATH}"
            echo "Evaluation image: $EVALUATING_IMAGE"
            echo "Temporary Storage size: $TEMPORARY_STORAGE_SIZE"
            echo "CPU request: $CPU_REQUEST"
            echo "Memory request: $MEMORY_REQUEST"
            echo "CPU limit: $CPU_LIMIT"
            echo "Memory limit: $MEMORY_LIMIT"
            echo "NVIDIA GPU allocation: $NVIDIA_GPUALLOC"
            echo "NVIDIA GPU cores: $NVIDIA_GPUCORES"
            echo "NVIDIA GPU memory: $NVIDIA_GPUMEM"
            echo "NVIDIA GPU: $NVIDIA_GPU"
            echo "Evaluation argument image size: $EVALUATE_ARG_IMAGE_SIZE"
            echo "Evaluation argument batch size: $EVALUATE_ARG_BATCH_SIZE"
            echo "Evaluation argument data: $EVALUATE_ARG_DATA"
            echo "Evaluation argument weights: $EVALUATE_ARG_WEIGHTS"
            echo "Evaluation argument worker: $EVALUATE_ARG_WORKERS"
            echo "Evaluation argument device: $EVALUATE_ARG_DEVICE"
            echo "Evidently endpoint: $EVIDENTLY_ENDPOINT"
            echo "Evidently project name: $EVIDENTLY_PROJECT_NAME"
            echo "Evidently api key: [REDACTED]"

            EVIDENTLY_PROJECT_ID=""

            function prepare_evidently_project() {
              local project='/tmp/projects.json'
              local project_id=""

              if ! curl -s "${EVIDENTLY_ENDPOINT}/api/projects/search/${EVIDENTLY_PROJECT_NAME}" \
                       -H "Evidently-secret: ${EVIDENTLY_API_KEY}" \
                       -o ${project}; then
                echo "ERROR: Failed to search projects"
                exit 1
              fi

              project_id=$(jq -r --arg name "${EVIDENTLY_PROJECT_NAME}" '.[] | select(.name == $name) | .id' ${project} 2>/dev/null)

              if [ -z "${project_id}" ] || [ "${project_id}" = "null" ]; then
                echo "Project not found, creating new project: ${EVIDENTLY_PROJECT_NAME}"
                if ! curl -s -X POST "${EVIDENTLY_ENDPOINT}/api/projects" \
                         -H "Evidently-secret: ${EVIDENTLY_API_KEY}" \
                         -H "Content-Type: application/json" \
                         -d "{\"name\": \"${EVIDENTLY_PROJECT_NAME}\"}" \
                         -o ${project}; then
                  echo "ERROR: Failed to create project"
                  exit 1
                fi
                project_id=$(cat ${project})
              fi

              if [ -z "${project_id}" ] || [ "${project_id}" = "null" ]; then
                echo "ERROR: Failed to get project ID"
                exit 1
              fi

              EVIDENTLY_PROJECT_ID="${project_id}"
              echo "Evidently project ID: $EVIDENTLY_PROJECT_ID"
            }

            if [ -n "$EVIDENTLY_ENDPOINT" ]; then
              prepare_evidently_project
            fi

            name=$(context.pipelineRun.name)
            echo "Volcano Job Name: $name"

            MODEL_NAME=$(basename ${EVALUATE_ARG_WEIGHTS} | sed 's/\.[^.]*$//')

            COMMAND="
                        set -euo pipefail
                        function url_encode() {
                          local input=\"\$1\"
                          printf '%s' \"\$input\" | sed 's/%/%25/g; s/:/%3A/g; s/@/%40/g; s/ /%20/g'
                        }

                        function build_git_url() {
                          local url=\"\$1\"
                          local encoded_user=\$(url_encode \"\$GIT_USER\")
                          local encoded_token=\$(url_encode \"\$GIT_TOKEN\")
                          local url_no_https=\"\${url#https://}\"
                          echo \"https://\${encoded_user}:\${encoded_token}@\$url_no_https\"
                        }

                        function config_safe_directory() {
                          local dir=\$1
                          git config --global --add safe.directory \"\$dir\"
                        }

                        function git_clone() {
                          local url=\$1
                          local branch=\$2
                          local name=\$(basename \$url)

                          local clone_url=\$(build_git_url \"\$url\")

                          branch=\${branch#refs/heads/}

                          if [ -d .git ]; then
                            echo \"Current directory is already a git repository, pulling latest changes\"
                            if [ -n \"\$branch\" ]; then
                              echo \"Switching to branch: \$branch\"
                              git checkout \$branch
                            fi

                            config_safe_directory \"\$(pwd)\"
                            git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull
                          else
                            echo \"Cloning repository to current directory\"
                            if [ -n \"\$branch\" ]; then
                              echo \"Cloning branch: \$branch\"
                              GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone -b \$branch \"\$clone_url\" .
                            else
                              GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone \"\$clone_url\" .
                            fi
                            if [ -d .git ]; then
                              echo \"Git repository confirmed, executing lfs pull\"
                              config_safe_directory \"\$(pwd)\"
                              git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull
                            else
                              echo \"Error: .git directory not found after clone\"
                              exit 1
                            fi
                          fi
                        }

                        export SAVE_JSON=\"/mnt/workspace/model/runs/val/exp/${MODEL_NAME}_predictions.json\"
                        export ANNO_JSON=\"${ANNOTATION_JSON}\"

                        function evaluate() {
                          cd /mnt/workspace/model
                          config_safe_directory \"\$(pwd)\"
                          python val.py --name exp --exist-ok --save-json --img ${EVALUATE_ARG_IMAGE_SIZE} --batch ${EVALUATE_ARG_BATCH_SIZE} --data ${EVALUATE_ARG_DATA} --weights ${EVALUATE_ARG_WEIGHTS} --workers ${EVALUATE_ARG_WORKERS} --device ${EVALUATE_ARG_DEVICE}
                          if [ ! -f \${SAVE_JSON} ]; then
                            echo \"ERROR: Prediction file not found: \${SAVE_JSON}\"
                            exit 1
                          fi
                        }

                        mkdir -p /mnt/workspace/model
                        cd /mnt/workspace/model
                        git_clone \"${MODEL_REPO_URL}\" \"${MODEL_REPO_BRANCH}\"

                        mkdir -p ${DATASET_DIR}
                        cd ${DATASET_DIR}
                        git_clone \"${DATASET_REPO_URL}\" \"${DATASET_REPO_BRANCH}\"

                        mkdir -p /mnt/workspace/output
                        cd /mnt/workspace/output
                        git_clone \"${OUTPUT_MODEL_REPO_URL}\" \"${OUTPUT_MODEL_REPO_BRANCH}\"

                        cp -f "/mnt/workspace/output/${OUTPUT_MODEL_PATH}" "/mnt/workspace/model/${EVALUATE_ARG_WEIGHTS}"

                        rm -rf runs/val/exp*

                        echo \"Listing model files...\"
                        ls /mnt/workspace/model
                        echo \"Listing dataset files...\"
                        ls ${DATASET_DIR}

                        echo \"Init task completed successfully\"

                        evaluate

                        if [ -z "$EVIDENTLY_ENDPOINT" ]; then
                          echo \"Evidently endpoint is empty, skip evidently evaluation\"
                          exit 0
                        fi

                        export EVIDENTLY_ENDPOINT=\"${EVIDENTLY_ENDPOINT}\"
                        export EVIDENTLY_PROJECT_NAME=\"${EVIDENTLY_PROJECT_NAME}\"
                        export EVIDENTLY_API_KEY=\"${EVIDENTLY_API_KEY}\"
                        export EVIDENTLY_PROJECT_ID=\"${EVIDENTLY_PROJECT_ID}\"
                        export PIPELINE_RUN_NAME=\"$(context.pipelineRun.name)\"
                        export PIPELINE_RUN_NAMESPACE=\"$(context.pipelineRun.namespace)\"
                        export MODEL_REPO_URL=\"${MODEL_REPO_URL}\"
                        export MODEL_REPO_BRANCH=\"${MODEL_REPO_BRANCH}\"
                        export DATASET_REPO_URL=\"${DATASET_REPO_URL}\"
                        export DATASET_REPO_BRANCH=\"${DATASET_REPO_BRANCH}\"
                        export OUTPUT_MODEL_REPO_URL=\"${OUTPUT_MODEL_REPO_URL}\"
                        export OUTPUT_MODEL_REPO_BRANCH=\"${OUTPUT_MODEL_REPO_BRANCH}\"

                        cat <<EOF > /mnt/workspace/model/save_to_evidently.py
                        import os, pandas
                        from evidently import Report
                        from evidently.core.metric_types import SingleValueMetric, SingleValueCalculation
                        from evidently.ui.workspace import RemoteWorkspace
                        from evidently.sdk.models import PanelMetric
                        from evidently.sdk.panels import DashboardPanelPlot
                        from pycocotools.coco import COCO
                        from pycocotools.cocoeval import COCOeval

                        mAPColumns=('mAP_0_5_0_95', 'mAP_0_5', 'mAP_0_75', 'mAP_small', 'mAP_medium', 'mAP_large')
                        mARColumns=('mAR_1', 'mAR_10', 'mAR_100', 'mAR_small', 'mAR_medium', 'mAR_large')
                        mAPDisplayNames=(
                            'IoU=0.50:0.95 area=all',
                            'IoU=0.50 area=all',
                            'IoU=0.75 area=all',
                            'IoU=0.50:0.95 area=small',
                            'IoU=0.50:0.95 area=medium',
                            'IoU=0.50:0.95 area=large',
                        )
                        mARDisplayNames=(
                            'area=all maxDets=1',
                            'area=all maxDets=10',
                            'area=all maxDets=100',
                            'area=small maxDets=100',
                            'area=medium maxDets=100',
                            'area=large maxDets=100',
                        )

                        def coco_eval(anno_json, pred_json):
                            anno = COCO(anno_json)
                            pred = anno.loadRes(pred_json)
                            eval = COCOeval(anno, pred, 'bbox')
                            eval.evaluate()
                            eval.accumulate()
                            eval.summarize()
                            result = {}
                            for i, column in enumerate(mAPColumns + mARColumns):
                                result[column] = float(eval.stats[i])
                            result['timestamp'] = pandas.Timestamp.now()
                            return pandas.DataFrame([result])

                        class CocoEvalMetric(SingleValueMetric):
                            column: str
                            display_name: str

                            class Config:
                                type_alias = 'evidently:metric_v2:coco_eval_metric'

                        class CocoEvalMetricImplementation(SingleValueCalculation[CocoEvalMetric]):
                            def calculate(self, context, current_data, reference_data):
                                series_data = current_data.column(self.metric.column).data
                                value = float(series_data.iloc[0]) if len(series_data) > 0 else 0.0
                                return self.result(value=value)

                            def display_name(self) -> str:
                                return self.metric.display_name

                        def generate_coco_report(anno_json, pred_json):
                            print('Generating COCO evaluation report...')

                            metrics = []
                            for i, column in enumerate(mAPColumns):
                                metrics.append(CocoEvalMetric(column=column, display_name='AP: maxDets=100 ' + mAPDisplayNames[i]))
                            for i, column in enumerate(mARColumns):
                                metrics.append(CocoEvalMetric(column=column, display_name='AR: IoU=0.50:0.95 ' + mARDisplayNames[i]))

                            results = coco_eval(anno_json, pred_json)
                            for column in mAPColumns + mARColumns:
                                value = results[column].iloc[0]
                                print(f'{column}: {value:.4f}')

                            report = Report(metrics=metrics, metadata={
                                'pipeline_run_name': os.environ.get('PIPELINE_RUN_NAME', ''),
                                'pipeline_run_namespace': os.environ.get('PIPELINE_RUN_NAMESPACE', ''),
                                'model_repo_url': os.environ.get('MODEL_REPO_URL', ''),
                                'model_repo_branch': os.environ.get('MODEL_REPO_BRANCH', ''),
                                'dataset_repo_url': os.environ.get('DATASET_REPO_URL', ''),
                                'dataset_repo_branch': os.environ.get('DATASET_REPO_BRANCH', ''),
                            })

                            snapshot = report.run(reference_data=None, current_data=results)
                            return snapshot

                        def upload_to_evidently_workspace(report, endpoint, api_key, project_id):
                            try:
                                print(f'Uploading report to Evidently workspace: {endpoint}')
                                workspace = RemoteWorkspace(
                                    base_url=endpoint,
                                    secret=api_key
                                )
                                snapshot_ref = workspace.add_run(project_id, report, include_data=False)
                                print(f'Report uploaded successfully with ID: {snapshot_ref.id}')
                                print(f'Report URL: {snapshot_ref.url}')
                                save_dashboard(workspace, project_id)
                                return True
                            except Exception as e:
                                print(f'Error uploading to Evidently workspace: {e}')
                                return False

                        def save_dashboard(workspace, project_id):
                            ap_metrics = []
                            ar_metrics = []
                            for i, column in enumerate(mAPColumns):
                                ap_metrics.append(PanelMetric(legend=mAPDisplayNames[i], metric='coco_eval_metric', metric_labels={'column': column}))
                            for i, column in enumerate(mARColumns):
                                ar_metrics.append(PanelMetric(legend=mARDisplayNames[i], metric='coco_eval_metric', metric_labels={'column': column}))
                            pannels = [
                                DashboardPanelPlot(title='COCO Average Precision', subtitle='maxDets=100', values=ap_metrics, size='full', plot_params={'plot_type': 'line'}),
                                DashboardPanelPlot(title='COCO Average Recall', subtitle='IoU=0.50:0.95', values=ar_metrics, size='full', plot_params={'plot_type': 'line'}),
                            ]
                            project = workspace.get_project(project_id)
                            existing_panels = project.dashboard.model().panels
                            existing_titles = [panel.title for panel in existing_panels]
                            for panel in pannels:
                                if panel.title not in existing_titles:
                                    project.dashboard.add_panel(panel)
                                else:
                                    print(f'Panel {panel.title} already exists')
                            return

                        def main():
                            pred_json = os.environ.get('SAVE_JSON', '')
                            anno_json = os.environ.get('ANNO_JSON', '')
                            endpoint = os.environ.get('EVIDENTLY_ENDPOINT', '')
                            api_key = os.environ.get('EVIDENTLY_API_KEY', '')
                            project_id = os.environ.get('EVIDENTLY_PROJECT_ID', '')

                            coco_report = generate_coco_report(anno_json, pred_json)

                            if not endpoint:
                                print('WARNING: Evidently endpoint is empty, skip uploading to Evidently workspace')
                                return

                            upload_success = upload_to_evidently_workspace(coco_report, endpoint, api_key, project_id)
                            if upload_success:
                                print('SUCCESS: Successfully uploaded COCO evaluation report to Evidently workspace')
                            else:
                                print('WARNING: Report upload failed, please check configuration')

                        if __name__ == '__main__':
                            main()
                        EOF

                        echo \"\"
                        echo \"Running Evidently analysis...\"
                        python save_to_evidently.py
            "

            cat <<EOF > /tmp/job.yaml
            ---
            apiVersion: batch.volcano.sh/v1alpha1
            kind: Job
            metadata:
              name: "${name}"
              ownerReferences:
              - apiVersion: tekton.dev/v1
                kind: PipelineRun
                name: "${name}"
                uid: $(context.pipelineRun.uid)
                controller: true
                blockOwnerDeletion: true
            spec:
              minAvailable: 1
              schedulerName: volcano
              maxRetry: 1
              queue: default
              tasks:
              - name: evaluate
                replicas: 1
                minAvailable: 1
                template:
                  metadata:
                    name: evaluate
                  spec:
                    restartPolicy: Never
                    volumes:
                    - emptyDir:
                        sizeLimit: ${TEMPORARY_STORAGE_SIZE}
                      name: workspace
                    containers:
                    - image: "${EVALUATING_IMAGE}"
                      imagePullPolicy: IfNotPresent
                      name: evaluate
                      env:
                      - name: GIT_USER
                        valueFrom:
                          secretKeyRef:
                            name: "${GIT_CREDENTIAL_SECRET_NAME}"
                            key: GIT_USER
                      - name: GIT_TOKEN
                        valueFrom:
                          secretKeyRef:
                            name: "${GIT_CREDENTIAL_SECRET_NAME}"
                            key: GIT_TOKEN
                      - name: TASK_INDEX
                        valueFrom:
                          fieldRef:
                            fieldPath: metadata.annotations['volcano.sh/task-index']
                      - name: MASTER_ADDR
                        value: ${name}.$(context.pipelineRun.namespace).svc
                      command:
                      - bash
                      - -c
                      - |
                        ${COMMAND}
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
                      volumeMounts:
                      - name: workspace
                        mountPath: /mnt/workspace
            EOF
            echo "Volcano Job YAML: "
            cat /tmp/job.yaml
            echo "create Volcano Job"

            kubectl create -f /tmp/job.yaml
            kubectl get -f /tmp/job.yaml

            function wait_job() {
              echo "Waiting for job to complete..."
              while true; do
                local job_status=$(kubectl get jobs.batch.volcano.sh ${name} -o jsonpath='{.status.state.phase}')
                if [ "$job_status" = "Pending" ]; then
                  echo "Waiting for Volcano Job ${name} to start..."
                  sleep 5
                  continue
                fi
                echo "Volcano Job ${name} status: $job_status"
                break
              done
            }
            wait_job
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
    - name: log
      runAfter:
        - create-job
      params:
        - name: script
          value: |-
            export "$@"

            pod_name="$(context.pipelineRun.name)-evaluate-0"
            namespace="$(context.pipelineRun.namespace)"
            pod_status=""

            while true; do
              kubectl logs -n ${namespace} ${pod_name} -f || true
              pod_status=$(kubectl get pod -n ${namespace} ${pod_name} -o jsonpath='{.status.phase}' --ignore-not-found)
              if [ -z "$pod_status" ]; then
                continue
              fi
              if [ "$pod_status" = "Pending" ]; then
                echo "Pod ${pod_name} is pending, waiting..."
                sleep 5
                continue
              fi
              if [ "$pod_status" != "Running" ]; then
                break
              fi
              sleep 5
            done

            echo ""
            echo "--- Pod ${pod_name} logs completed, status: ${pod_status} ---"
            if [ "$pod_status" != "Succeeded" ]; then
              exit 1
            else
              kubectl logs -n ${namespace} ${pod_name} > /tmp/report.log
              report_url=$(grep -E '^Report URL:' /tmp/report.log | awk '{print $3}')
              mAP_0_5_0_95=$(grep -E '^mAP_0_5_0_95:' /tmp/report.log | awk '{print $2}')
              mAP_0_5=$(grep -E '^mAP_0_5:' /tmp/report.log | awk '{print $2}')
              mAP_0_75=$(grep -E '^mAP_0_75:' /tmp/report.log | awk '{print $2}')
              mAP_small=$(grep -E '^mAP_small:' /tmp/report.log | awk '{print $2}')
              mAP_medium=$(grep -E '^mAP_medium:' /tmp/report.log | awk '{print $2}')
              mAP_large=$(grep -E '^mAP_large:' /tmp/report.log | awk '{print $2}')
              mAR_1=$(grep -E '^mAR_1:' /tmp/report.log | awk '{print $2}')
              mAR_10=$(grep -E '^mAR_10:' /tmp/report.log | awk '{print $2}')
              mAR_100=$(grep -E '^mAR_100:' /tmp/report.log | awk '{print $2}')
              mAR_small=$(grep -E '^mAR_small:' /tmp/report.log | awk '{print $2}')
              mAR_medium=$(grep -E '^mAR_medium:' /tmp/report.log | awk '{print $2}')
              mAR_large=$(grep -E '^mAR_large:' /tmp/report.log | awk '{print $2}')
              cat <<EOF > $(results.string-result.path)
              {
                "ReportURL": "${report_url}",
                "Results": [
                  {
                    "metric": "mAP_0_5_0_95",
                    "description": "Average Precision, IoU=0.50:0.95 area=all maxDets=100",
                    "value": ${mAP_0_5_0_95}
                  },
                  {
                    "metric": "mAP_0_5",
                    "description": "Average Precision, IoU=0.50 area=all maxDets=100",
                    "value": ${mAP_0_5}
                  },
                  {
                    "metric": "mAP_0_75",
                    "description": "Average Precision, IoU=0.75 area=all maxDets=100",
                    "value": ${mAP_0_75}
                  },
                  {
                    "metric": "mAP_small",
                    "description": "Average Precision, IoU=0.50:0.95 area=small maxDets=100",
                    "value": ${mAP_small}
                  },
                  {
                    "metric": "mAP_medium",
                    "description": "Average Precision, IoU=0.50:0.95 area=medium maxDets=100",
                    "value": ${mAP_medium}
                  },
                  {
                    "metric": "mAP_large",
                    "description": "Average Precision, IoU=0.50:0.95 area=large maxDets=100",
                    "value": ${mAP_large}
                  },
                  {
                    "metric": "mAR_1",
                    "description": "Average Recall, IoU=0.50:0.95 area=all maxDets=1",
                    "value": ${mAR_1}
                  },
                  {
                    "metric": "mAR_10",
                    "description": "Average Recall, IoU=0.50:0.95 area=all maxDets=10",
                    "value": ${mAR_10}
                  },
                  {
                    "metric": "mAR_100",
                    "description": "Average Recall, IoU=0.50:0.95 area=all maxDets=100",
                    "value": ${mAR_100}
                  },
                  {
                    "metric": "mAR_small",
                    "description": "Average Recall, IoU=0.50:0.95 area=small maxDets=100",
                    "value": ${mAR_small}
                  },
                  {
                    "metric": "mAR_medium",
                    "description": "Average Recall, IoU=0.50:0.95 area=medium maxDets=100",
                    "value": ${mAR_medium}
                  },
                  {
                    "metric": "mAR_large",
                    "description": "Average Recall, IoU=0.50:0.95 area=large maxDets=100",
                    "value": ${mAR_large}
                  }
                ]
              }
            EOF
            fi
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
      timeout: 60m0s
  finally: []
```

</details>

### Pipeline Parameters

The pipeline includes the following key parameters that need to be configured:

**Repository Parameters:**
- `MODEL_REPO_URL`: The Git URL of the model repository containing the YOLOv5 code and val.py script
- `MODEL_REPO_BRANCH`: The branch of the model repository to use (optional)
- `DATASET_REPO_URL`: The Git URL of the dataset repository containing validation images and annotations
- `DATASET_REPO_BRANCH`: The branch of the dataset repository to use (optional)
- `OUTPUT_MODEL_REPO_URL`: The Git URL of the repository containing the trained model to be evaluated
- `OUTPUT_MODEL_REPO_BRANCH`: The branch of the output model repository to use (optional)
- `OUTPUT_MODEL_PATH`: The relative path to the trained model file within the output model repository (default: "1/model.torchscript")
- `GIT_CREDENTIAL_SECRET_NAME`: The name of the Kubernetes secret containing Git credentials (GIT_USER and GIT_TOKEN keys)

**Evaluation Parameters:**
- `EVALUATING_IMAGE`: The container image for the model evaluation job
- `EVALUATE_ARG_IMAGE_SIZE`: The image size for model evaluation (width and height in pixels) (default: "640")
- `EVALUATE_ARG_BATCH_SIZE`: The batch size for model evaluation (default: "16")
- `EVALUATE_ARG_DATA`: The path to the dataset configuration YAML file (default: "coco.yaml")
- `EVALUATE_ARG_WEIGHTS`: The path to the trained model weights file (default: "models/model.torchscript")
- `EVALUATE_ARG_WORKERS`: The number of worker threads for data loading (default: "0")
- `EVALUATE_ARG_DEVICE`: The device(s) to use for evaluation, multiple devices separated by comma (e.g., "0,1,2,3"), set "cpu" to use CPU (default: "0")

For more information about YOLOv5 evaluation parameter configuration, refer to the [YOLOv5 validation documentation](https://docs.ultralytics.com/modes/val/).

**Evidently Parameters:**
- `EVIDENTLY_ENDPOINT`: The Evidently UI service endpoint URL for uploading evaluation reports
- `EVIDENTLY_PROJECT_NAME`: The name of the Evidently project to store evaluation reports (default: uses namespace if not specified)
- `EVIDENTLY_API_KEY`: The API key for accessing the Evidently workspace

**Resource Parameters:**
- `TEMPORARY_STORAGE_SIZE`: The size of temporary storage for the evaluation job (default: "5Gi")
- `CPU_REQUEST`: The CPU request for the evaluation job (default: "1", leave empty to not request CPU)
- `MEMORY_REQUEST`: The memory request for the evaluation job (default: "8Gi", leave empty to not request memory)
- `CPU_LIMIT`: The CPU limit for the evaluation job (default: "8", leave empty to not limit CPU)
- `MEMORY_LIMIT`: The memory limit for the evaluation job (default: "20Gi", leave empty to not limit memory)
- `NVIDIA_GPUALLOC`: HAMi NVIDIA GPU allocation - number of GPU cards (default: "1", leave empty to not allocate GPU)
- `NVIDIA_GPUCORES`: HAMi NVIDIA GPU cores - percentage of compute power per card, range 1-100 (default: "50", leave empty to not configure GPU cores)
- `NVIDIA_GPUMEM`: HAMi NVIDIA GPU memory - memory usage per card in MiB (default: "4096", leave empty to not configure GPU memory)
- `NVIDIA_GPU`: NVIDIA GPU count - number of GPU cards allocated when using NVIDIA GPU plugin, cannot be used together with HAMi parameters (default: "", leave empty to not set)


### Trigger Pipeline

Follow these steps to trigger the pipeline:

1. Select the `yolov5-evaluating` pipeline and click the `Run` button to open the `Run Pipeline` dialog.

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

6. The pipeline creates a VolcanoJob in the background that runs YOLOv5's `val.py` script. The `val.py` script validates the model on the validation dataset, generates `xxx_predictions.json`, and then uses `COCOeval` to compare the detection results with the ground truth annotations, producing evaluation results. These evaluation results are then uploaded to `Evidently`.

7. After successful execution, the `Report` and `Dashboard` can be viewed in the `Evidently` project. The evaluation results and `Evidently Report` access address can be found in the `Result` tab of the pipeline run results.


For event-driven pipeline execution, refer to the `Trigger` section in the [Pipelines documentation](https://docs.alauda.io/alauda-devops-pipelines/).

**Note**: When the pipeline runs, it creates a `VolcanoJob` that is associated with the `PipelineRun` through `OwnerReference`. When the `PipelineRun` is deleted, the associated `VolcanoJob` and its related resources (such as `PodGroup` and `Pods`) will be cascadingly deleted. For more information about `VolcanoJob`, refer to the [VolcanoJob documentation](https://volcano.sh/en/docs/vcjob/).


### Checkout PipelineRun status and logs

The execution status and evaluation logs can be viewed in the corresponding execution record in `PipelineRuns`.