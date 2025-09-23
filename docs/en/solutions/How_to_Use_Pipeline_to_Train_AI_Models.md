---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---
# How to Use Pipeline to Train AI Models

## Overview

This document demonstrates how to train AI models using DevOps Pipeline. The YOLOv5 model is used as an example to illustrate the training workflow. The overall framework presented here can be adapted for training other models as well, requiring only adjustments to input parameters, execution scripts, and training code.


## Prerequisites

Before proceeding with the AI model training pipeline, ensure the following prerequisites are met:

1. **Alauda DevOps**: Install `Alauda DevOps next-gen` following the [Alauda DevOps documentation](https://docs.alauda.io/devops). `Alauda DevOps Pipelines` and `Alauda DevOps Connectors` must be installed.

2. **Volcano**: Install the `Volcano` cluster plugin to enable GPU scheduling and resource management for AI workloads.

3. **Required Repositories**: Prepare:
   - A Git repository for storing models and datasets.
   - A container image registry for storing the trainer image.

4. **Alauda AI**: It is recommended to deploy Alauda AI for better management of models, training, and inference services. Refer to the [Alauda AI documentation](https://docs.alauda.io/ai/) for installation and configuration details.

5. **GPU Device Plugins**: It is recommended to deploy GPU device plugins such as `Hami` or `NVIDIA GPU Device Plugin` to utilize GPU resources for AI training. Refer to the `Device Management` section in the [Alauda AI documentation](https://docs.alauda.io/ai/) for deployment instructions.


### Prepare Model Repository

Clone the code from the [yolov5 v7.0](https://github.com/ultralytics/yolov5) of the YOLOv5 repository. Since the example below uses the YOLOv5n pretrained model, download the model from [yolov5n.pt](https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.pt) and place it in the `models/` directory of the repository.

Users can use other models as needed and adjust the `TRAIN_ARG_WEIGHTS` parameter in the pipeline accordingly.

Note: Since `*.pt` files are large binary files, consider using `git lfs track models/yolov5n.pt` to manage them with Git LFS.


### Prepare Dataset Repository

Users can download the dataset from [coco128.zip](https://github.com/ultralytics/assets/releases/download/v0.0.0/coco128.zip) and commit it to the Git repository. Similarly, for image files in the dataset, consider using Git LFS to manage them, for example: `git lfs track images/train2017/*.jpg`


### Prepare Trainer Image

The following Dockerfile can be used to build the training image. Users can compile their own training image using this Dockerfile:

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

# optional, add "-i https://pypi.tuna.tsinghua.edu.cn/simple" to pip install arguments to download from a proxy source.

RUN curl -o /tmp/requirements.txt https://raw.githubusercontent.com/ultralytics/yolov5/refs/tags/v7.0/requirements.txt && \
    pip install --no-cache-dir -U pip && \
    pip install --no-cache-dir -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

RUN pip install --no-cache-dir "Pillow==9.5.0" "numpy<2.0.0" "opencv-python<4.12.0"

RUN mkdir -p /root/.config/Ultralytics && \
    curl -fsSL https://ultralytics.com/assets/Arial.ttf -o /root/.config/Ultralytics/Arial.ttf && \
    curl -fsSL https://ultralytics.com/assets/Arial.Unicode.ttf -o /root/.config/Ultralytics/Arial.Unicode.ttf

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
NAME=yolov5-training

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
  - ""
  resources:
  - services
  verbs:
  - get
  - create
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

2. If permission issues are encountered during execution, contact the platform administrator to execute the script for you.

### Create Pipeline

Follow these steps to create the Pipeline in `Alauda Container Platform`:

1. Navigate to the namespace where the pipeline will run in the `Alauda Container Platform` view.

2. In the left navigation, select `Pipelines` / `Pipelines`, and click the `Create` button on the right side of the opened page.

3. In the Create Pipeline dialog, enter name `yolov5-training`, then click the `Confirm` button to enter the pipeline orchestration page.

4. On the pipeline orchestration page, click the `YAML` button in the upper right corner to switch to YAML editing mode, and paste the following pipeline YAML content into the editor.

5. Click the `Create` button in the lower right corner to create the `yolov5-training` pipeline.

<details>
<summary>Pipeline: yolov5-training</summary>

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: yolov5-training
spec:
  params:
    - description: git url of the model repo
      name: MODEL_REPO_URL
      type: string
    - default: ""
      description: branch of the model repo
      name: MODEL_REPO_BRANCH
      type: string
    - description: git url of the dataset repo
      name: DATASET_REPO_URL
      type: string
    - default: ""
      description: branch of the dataset repo
      name: DATASET_REPO_BRANCH
      type: string
    - default: "/mnt/workspace/datasets/coco128"
      description: dataset dir
      name: DATASET_DIR
      type: string
    - description: git url of the output model repo
      name: OUTPUT_MODEL_REPO_URL
      type: string
    - default: ""
      description: branch of the output model repo
      name: OUTPUT_MODEL_REPO_BRANCH
      type: string
    - description: name of the git credential secret
      name: GIT_CREDENTIAL_SECRET_NAME
      type: string
    - description: image of the training job
      name: TRAINING_IMAGE
      type: string
    - description: storage size
      name: TEMPORARY_STORAGE_SIZE
      type: string
      default: "5Gi"
    - description: number of replicas
      name: REPLICAS
      type: string
      default: "1"
    - description: shared memory limit size
      name: SHARE_MEMORY_LIMIT_SIZE
      type: string
      default: "2Gi"
    - description: request cpu
      name: CPU_REQUEST
      type: string
      default: "1"
    - description: request memory
      name: MEMORY_REQUEST
      type: string
      default: "8Gi"
    - description: limit cpu
      name: CPU_LIMIT
      type: string
      default: "8"
    - description: limit memory
      name: MEMORY_LIMIT
      type: string
      default: "20Gi"
    - default: "1"
      description:  Hami NVIDIA GPU allocation - number of GPU cards, leave empty to not allocate GPU
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
    - description: train arg image size
      name: TRAIN_ARG_IMAGE_SIZE
      type: string
      default: "640"
    - description: train arg batch size
      name: TRAIN_ARG_BATCH_SIZE
      type: string
      default: "16"
    - description: train arg epochs
      name: TRAIN_ARG_EPOCHS
      type: string
      default: "3"
    - description: train arg data
      name: TRAIN_ARG_DATA
      type: string
      default: "coco128.yaml"
    - description: train arg weights
      name: TRAIN_ARG_WEIGHTS
      type: string
      default: "models/yolov5n.pt"
    - description: train arg worker
      name: TRAIN_ARG_WORKERS
      type: string
      default: "0"
    - description: train arg device, multiple devices split by comma, such as "0,1,2,3", set "cpu" to use cpu
      name: TRAIN_ARG_DEVICE
      type: string
      default: "0"
  results:
    - description: ""
      name: RESULT
      type: string
      value: $(tasks.create-job.results.object-result.message)
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
            - OUTPUT_MODEL_REPO_URL=$(params.OUTPUT_MODEL_REPO_URL)
            - OUTPUT_MODEL_REPO_BRANCH=$(params.OUTPUT_MODEL_REPO_BRANCH)
            - GIT_CREDENTIAL_SECRET_NAME=$(params.GIT_CREDENTIAL_SECRET_NAME)
            - TRAINING_IMAGE=$(params.TRAINING_IMAGE)
            - TEMPORARY_STORAGE_SIZE=$(params.TEMPORARY_STORAGE_SIZE)
            - REPLICAS=$(params.REPLICAS)
            - SHARE_MEMORY_LIMIT_SIZE=$(params.SHARE_MEMORY_LIMIT_SIZE)
            - CPU_REQUEST=$(params.CPU_REQUEST)
            - MEMORY_REQUEST=$(params.MEMORY_REQUEST)
            - CPU_LIMIT=$(params.CPU_LIMIT)
            - MEMORY_LIMIT=$(params.MEMORY_LIMIT)
            - NVIDIA_GPUALLOC=$(params.NVIDIA_GPUALLOC)
            - NVIDIA_GPUCORES=$(params.NVIDIA_GPUCORES)
            - NVIDIA_GPUMEM=$(params.NVIDIA_GPUMEM)
            - NVIDIA_GPU=$(params.NVIDIA_GPU)
            - TRAIN_ARG_IMAGE_SIZE=$(params.TRAIN_ARG_IMAGE_SIZE)
            - TRAIN_ARG_BATCH_SIZE=$(params.TRAIN_ARG_BATCH_SIZE)
            - TRAIN_ARG_EPOCHS=$(params.TRAIN_ARG_EPOCHS)
            - TRAIN_ARG_DATA=$(params.TRAIN_ARG_DATA)
            - TRAIN_ARG_WEIGHTS=$(params.TRAIN_ARG_WEIGHTS)
            - TRAIN_ARG_WORKERS=$(params.TRAIN_ARG_WORKERS)
            - TRAIN_ARG_DEVICE=$(params.TRAIN_ARG_DEVICE)
        - name: script
          value: |-
            set -e
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

            if [ -z "$TRAINING_IMAGE" ]; then
              echo "Training image cannot be empty"
              exit 1
            fi

            if [ -z "$REPLICAS" ]; then
              REPLICAS="1"
              echo "Replicas is empty, using default replicas: $REPLICAS"
            fi

            if [ -z "$TEMPORARY_STORAGE_SIZE" ]; then
              TEMPORARY_STORAGE_SIZE="5Gi"
              echo "Temporary storage size is empty, using default storage size: $TEMPORARY_STORAGE_SIZE"
            fi

            if [ -z "$SHARE_MEMORY_LIMIT_SIZE" ]; then
              SHARE_MEMORY_LIMIT_SIZE="2Gi"
              echo "Shared memory limit size is empty, using default shared memory limit size: $SHARE_MEMORY_LIMIT_SIZE"
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

            if [ -z "$OUTPUT_MODEL_REPO_BRANCH" ]; then
              OUTPUT_MODEL_REPO_BRANCH="sft-$(date +'%Y%m%d-%H%M%S')"
              echo "Output model repository branch is empty, using generated branch: $OUTPUT_MODEL_REPO_BRANCH"
            fi

            if [ -z "$TRAIN_ARG_IMAGE_SIZE" ]; then
              TRAIN_ARG_IMAGE_SIZE="640"
              echo "Training argument image size is empty, using default value: $TRAIN_ARG_IMAGE_SIZE"
            fi

            if [ -z "$TRAIN_ARG_BATCH_SIZE" ]; then
              TRAIN_ARG_BATCH_SIZE="16"
              echo "Training argument batch size is empty, using default value: $TRAIN_ARG_BATCH_SIZE"
            fi

            if [ -z "$TRAIN_ARG_EPOCHS" ]; then
              TRAIN_ARG_EPOCHS="3"
              echo "Training argument epochs is empty, using default value: $TRAIN_ARG_EPOCHS"
            fi

            if [ -z "$TRAIN_ARG_DATA" ]; then
              TRAIN_ARG_DATA="coco128.yaml"
              echo "Training argument data is empty, using default value: $TRAIN_ARG_DATA"
            fi


            if [ -z "$TRAIN_ARG_WEIGHTS" ]; then
              TRAIN_ARG_WEIGHTS="models/yolov5n.pt"
              echo "Training argument weights is empty, using default value: $TRAIN_ARG_WEIGHTS"
            fi

            if [ -z "$TRAIN_ARG_WORKERS" ]; then
              TRAIN_ARG_WORKERS="0"
              echo "Training argument worker is empty, using default value: $TRAIN_ARG_WORKERS"
            fi

            if [ -z "$TRAIN_ARG_DEVICE" ]; then
              TRAIN_ARG_DEVICE="0"
              echo "Training argument device is empty, using default value: $TRAIN_ARG_DEVICE"
            fi

            if [ "$TRAIN_ARG_DEVICE" = "cpu" ]; then
              REPLICAS="1"
              echo "Training argument device is cpu, setting REPLICAS to 1"
            fi


            echo "Model repository URL: $MODEL_REPO_URL ${MODEL_REPO_BRANCH}"
            echo "Dataset repository URL: $DATASET_REPO_URL ${DATASET_REPO_BRANCH}"
            echo "Output model repository URL: $OUTPUT_MODEL_REPO_URL ${OUTPUT_MODEL_REPO_BRANCH}"
            echo "Training image: $TRAINING_IMAGE"
            echo "Replicas: $REPLICAS"
            echo "Temporary Storage size: $TEMPORARY_STORAGE_SIZE"
            echo "Shared memory limit size: $SHARE_MEMORY_LIMIT_SIZE"
            echo "CPU request: $CPU_REQUEST"
            echo "Memory request: $MEMORY_REQUEST"
            echo "CPU limit: $CPU_LIMIT"
            echo "Memory limit: $MEMORY_LIMIT"
            echo "NVIDIA GPU allocation: $NVIDIA_GPUALLOC"
            echo "NVIDIA GPU cores: $NVIDIA_GPUCORES"
            echo "NVIDIA GPU memory: $NVIDIA_GPUMEM"
            echo "NVIDIA GPU: $NVIDIA_GPU"
            echo "Training argument image size: $TRAIN_ARG_IMAGE_SIZE"
            echo "Training argument batch size: $TRAIN_ARG_BATCH_SIZE"
            echo "Training argument epochs: $TRAIN_ARG_EPOCHS"
            echo "Training argument data: $TRAIN_ARG_DATA"
            echo "Training argument weights: $TRAIN_ARG_WEIGHTS"
            echo "Training argument worker: $TRAIN_ARG_WORKERS"
            echo "Training argument device: $TRAIN_ARG_DEVICE"

            cat <<EOF > $(results.object-result.path)
            {
              "message": "{\n\
              \"OUTPUT_MODEL_REPO\": {\n\
                \"URL\": \"${OUTPUT_MODEL_REPO_URL}\",\n\
                \"BRANCH\": \"${OUTPUT_MODEL_REPO_BRANCH}\"\n\
              }\n\
            }"
            }
            EOF

            name=$(context.pipelineRun.name)
            master_port="12345"
            echo "Volcano Job Name: $name"

            OUTPUT_MODEL_NAME=$(basename ${OUTPUT_MODEL_REPO_URL})

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
                              set +x
                              GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone -b \$branch \"\$clone_url\" .
                              set -x
                            else
                              set +x
                              GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone \"\$clone_url\" .
                              set -x
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

                        function git_push() {
                          local url=\$1
                          local name=\$(basename \$url)
                          local branch_name=\"${OUTPUT_MODEL_REPO_BRANCH}\"

                          echo \"Pushing to repository: \$url\"
                          echo \"Branch: \$branch_name\"

                          # Initialize git repository
                          git init

                          config_safe_directory \"\$(pwd)\"

                          # Check if branch already exists
                          if git show-ref --verify --quiet refs/heads/\$branch_name; then
                            echo \"Branch \$branch_name already exists, switching to it\"
                            git checkout \$branch_name
                          else
                            echo \"Creating new branch \$branch_name\"
                            git checkout -b \$branch_name
                          fi

                          git lfs track *.pt
                          git add .
                          git -c user.name='AMLSystemUser' -c user.email='aml_admin@cpaas.io' commit -am \"fine tune push auto commit\"

                          # Push to remote repository
                          local push_url=\$(build_git_url \"\$url\")
                          set +x
                          git -c http.sslVerify=false -c lfs.activitytimeout=36000 push -u \"\$push_url\" \"\$branch_name\"
                          set -x

                          echo \"Successfully pushed to \$url on branch \$branch_name\"
                        }

                        function train() {
                          cd /mnt/workspace/model
                          config_safe_directory \"\$(pwd)\"
                          if [ ${REPLICAS} -gt 1 ]; then
                            torchrun --nproc_per_node=1 --nnodes=${REPLICAS} --node_rank=\${TASK_INDEX} --master_addr=\${MASTER_ADDR} --master_port=${master_port} \
                                     train.py --name exp --exist-ok --img ${TRAIN_ARG_IMAGE_SIZE} --batch ${TRAIN_ARG_BATCH_SIZE} --epochs ${TRAIN_ARG_EPOCHS} --data ${TRAIN_ARG_DATA} --weights ${TRAIN_ARG_WEIGHTS} --workers ${TRAIN_ARG_WORKERS} --device ${TRAIN_ARG_DEVICE}
                          else
                            python train.py --name exp --exist-ok --img ${TRAIN_ARG_IMAGE_SIZE} --batch ${TRAIN_ARG_BATCH_SIZE} --epochs ${TRAIN_ARG_EPOCHS} --data ${TRAIN_ARG_DATA} --weights ${TRAIN_ARG_WEIGHTS} --workers ${TRAIN_ARG_WORKERS} --device ${TRAIN_ARG_DEVICE}
                          fi
                        }

                        function export_model() {
                          cd /mnt/workspace/model
                          if [ -f /mnt/workspace/model/runs/train/exp/weights/best.pt ]; then
                            # will output runs/train/exp/best.torchscript
                            python export.py --weights /mnt/workspace/model/runs/train/exp/weights/best.pt --include torchscript
                          else
                            echo \"output model /mnt/workspace/model/runs/train/exp/weights/best.pt not found\"
                          fi

                          cd /mnt/workspace/model/modeldir
                          mkdir 1
                          cp ../runs/train/exp/weights/best.torchscript ./1/model.pt
                          touch README.md
                          cp ../runs/train/exp/hyp.yaml .
                          cp ../runs/train/exp/opt.yaml .
                          cp ../runs/train/exp/results.csv .

                          # define yolov5 inference triton config file
                          cat <<EOL > config.pbtxt
                        name: \"${OUTPUT_MODEL_NAME}\"
                        platform: \"pytorch_libtorch\"
                        max_batch_size: 8

                        input [
                        {
                        name: \"images\"
                        data_type: \"TYPE_FP32\"
                        dims: [3,${TRAIN_ARG_IMAGE_SIZE},${TRAIN_ARG_IMAGE_SIZE}]
                        }
                        ]
                        output [
                        {
                        name: \"output0\"
                        data_type: \"TYPE_FP32\"
                        dims: [-1,-1,-1]
                        }
                        ]
                        EOL
                        }

                        mkdir -p /mnt/workspace/model
                        cd /mnt/workspace/model
                        git_clone \"${MODEL_REPO_URL}\" \"${MODEL_REPO_BRANCH}\"

                        mkdir -p ${DATASET_DIR}
                        cd ${DATASET_DIR}
                        git_clone \"${DATASET_REPO_URL}\" \"${DATASET_REPO_BRANCH}\"

                        rm -rf runs/train/exp*

                        echo \"Listing model files...\"
                        ls /mnt/workspace/model
                        echo \"Listing dataset files...\"
                        ls ${DATASET_DIR}

                        echo \"Init task completed successfully\"

                        train

                        if [ \"$REPLICAS\" -le 1 ] || [ \"\${TASK_INDEX}\" -eq 0 ]; then
                          mkdir -p /mnt/workspace/model/modeldir
                          export_model

                          cd /mnt/workspace/model/modeldir
                          git_push \"${OUTPUT_MODEL_REPO_URL}\"
                        else
                          echo \"skip export model and push\"
                        fi
            "
            if [ "$REPLICAS" -gt 1 ];  then
              cat <<EOF > /tmp/svc.yaml
            ---
            apiVersion: v1
            kind: Service
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
              ports:
              - port: ${master_port}
                protocol: TCP
                targetPort: ${master_port}
              selector:
                volcano.sh/job-name: ${name}
                volcano.sh/task-index: "0"
            EOF
              echo "Service YAML: "
              cat /tmp/svc.yaml
              echo "create Service"

              kubectl create -f /tmp/svc.yaml
              kubectl get -f /tmp/svc.yaml
            fi

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
              - name: "train"
                replicas: ${REPLICAS}
                minAvailable: ${REPLICAS}
                template:
                  metadata:
                    name: train
                  spec:
                    restartPolicy: Never
                    volumes:
                    - emptyDir:
                        medium: Memory
                        sizeLimit: "${SHARE_MEMORY_LIMIT_SIZE}"
                      name: shm
                    - emptyDir:
                        sizeLimit: ${TEMPORARY_STORAGE_SIZE}
                      name: workspace
                    containers:
                    - image: "${TRAINING_IMAGE}"
                      imagePullPolicy: IfNotPresent
                      name: train
                      env:
                      - name: MLFLOW_TRACKING_URI
                        value: "http://mlflow-tracking-server.aml-system.svc.cluster.local:5000"
                      - name: MLFLOW_EXPERIMENT_NAME
                        value: kubeflow-admin-cpaas-io
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
                      - name: shm
                        mountPath: /dev/shm
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
                  sleep 1
                fi
                echo "Volcano Job ${name} status: $job_status"
                printf '"%s",' $(seq 0 $((REPLICAS-1))) | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/' > $(results.array-result.path)
                break
              done
            }
            wait_job
            function get_pod_image() {
              local pod_name="$(context.pipelineRun.name)-create-job-pod"
              local namespace="$(context.pipelineRun.namespace)"
              local pod_image=$(kubectl get pod -n ${namespace} ${pod_name} -o jsonpath='{.spec.containers[0].image}')
              echo -n "${pod_image}" > $(results.string-result.path)
            }
            get_pod_image
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
      timeout: 720h0m0s
    - name: logs
      matrix:
        params:
          - name: index
            value: $(tasks.create-job.results.array-result)
      runAfter:
        - create-job
      taskSpec:
        params:
          - name: index
            type: string
        steps:
          - computeResources:
              limits:
                cpu: "1"
                memory: 1Gi
              requests:
                cpu: 100m
                memory: 128Mi
            image: $(tasks.create-job.results.string-result)
            name: log
            script: |
              #!/bin/sh

              pod_name="$(context.pipelineRun.name)-train-$(params.index)"
              namespace="$(context.pipelineRun.namespace)"
              pod_status=""

              while true; do
                kubectl logs -n ${namespace} ${pod_name} -f
                pod_status=$(kubectl get pod -n ${namespace} ${pod_name} -o jsonpath='{.status.phase}' --ignore-not-found)
                if [ -z "$pod_status" ]; then
                  continue
                fi
                if [ "$pod_status" = "Pending" ]; then
                  echo "Pod ${pod_name} is pending, waiting..."
                  sleep 1
                  continue
                fi
                if [ "$pod_status" != "Running" ]; then
                  break
                fi
                sleep 1
              done

              echo ""
              echo "--- Pod ${pod_name} logs completed, status: ${pod_status} ---"
              if [ "$pod_status" != "Succeeded" ]; then
                exit 1
              fi
            securityContext:
              runAsNonRoot: true
      timeout: 720h0m0s
  finally: []
```

</details>

### Pipeline Parameters

The pipeline includes the following key parameters that need to be configured:

**Repository Parameters:**
- `MODEL_REPO_URL`: Git URL of the model repository
- `MODEL_REPO_BRANCH`: Branch of the model repository (optional)
- `DATASET_REPO_URL`: Git URL of the dataset repository
- `DATASET_REPO_BRANCH`: Branch of the dataset repository (optional)
- `OUTPUT_MODEL_REPO_URL`: Git URL of the output model repository
- `OUTPUT_MODEL_REPO_BRANCH`: Branch of the output model repository (optional, auto-generated if not specified)
- `GIT_CREDENTIAL_SECRET_NAME`: Secret name of the git credential secret (requires `GIT_USER` and `GIT_TOKEN` keys, where `GIT_USER` stores the git username and `GIT_TOKEN` stores the git password or access token)

**Training Parameters:**
- `TRAINING_IMAGE`: Container image for the training job
- `TRAIN_ARG_IMAGE_SIZE`: Training argument image size (default: "640")
- `TRAIN_ARG_BATCH_SIZE`: Training argument batch size (default: "16")
- `TRAIN_ARG_EPOCHS`: Training argument epochs (default: "3")
- `TRAIN_ARG_DATA`: Training argument data file (default: "coco128.yaml")
- `TRAIN_ARG_WEIGHTS`: Training argument weights (default: "models/yolov5n.pt")
- `TRAIN_ARG_WORKERS`: Training argument worker (default: "0")
- `TRAIN_ARG_DEVICE`: Training device, multiple devices separated by comma (default: "0")

For more information about YOLOv5 training parameter configuration, refer to the [YOLOv5 training settings documentation](https://docs.ultralytics.com/yolov5/tutorials/tips_for_best_training_results/#training-settings).


**Resource Parameters:**
- `TEMPORARY_STORAGE_SIZE`: Temporary storage size (default: "5Gi")
- `REPLICAS`: Number of replicas (default: "1", distributed training will be enabled if greater than 1)
- `CPU_REQUEST`: Request CPU (default: "1", leave empty to not request CPU)
- `MEMORY_REQUEST`: Request memory (default: "8Gi", leave empty to not request memory)
- `CPU_LIMIT`: Limit CPU (default: "8", leave empty to not limit CPU)
- `MEMORY_LIMIT`: Limit memory (default: "20Gi", leave empty to not limit memory)
- `NVIDIA_GPUALLOC`: NVIDIA GPU allocation - number of GPU cards (default: "1", leave empty to not allocate GPU)
- `NVIDIA_GPUCORES`: NVIDIA GPU cores - percentage of compute power per card, range 1-100 (default: "50", leave empty to not configure GPU cores)
- `NVIDIA_GPUMEM`: NVIDIA GPU memory - memory usage per card in MiB (default: "4096", leave empty to not configure GPU memory)
- `NVIDIA_GPU`: NVIDIA GPU count - number of GPU cards allocated when using NVIDIA GPU plugin, cannot be used together with Hami parameters (default: "", leave empty to not set)


### Trigger Pipeline

Follow these steps to trigger the pipeline:

1. Select the `yolov5-training` pipeline and click the `Run` button to open the `Run Pipeline` dialog.

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

**Note**: When the pipeline runs, it creates a `VolcanoJob` that is associated with the `PipelineRun` through `OwnerReference`. When the `PipelineRun` is deleted, the associated `VolcanoJob` and its related resources (such as `PodGroup` and `Pods`) will be cascadingly deleted. For more information about `VolcanoJob`, refer to the [VolcanoJob documentation](https://volcano.sh/en/docs/vcjob/).


### Checkout PipelineRun status and logs

The execution status and training logs can be viewed in the corresponding execution record in `PipelineRuns`.
