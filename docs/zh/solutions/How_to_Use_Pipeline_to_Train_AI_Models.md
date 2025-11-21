---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1763720171-F5B4
sourceSHA: 6dd518f7f02a37452521ded1ba655889f2c6707843f5ec0a2a8925bc795bbd86
---

# 如何使用管道训练 AI 模型

## 概述

本文档演示了如何使用 DevOps 管道训练 AI 模型。以 YOLOv5 模型为例，说明训练工作流。这里呈现的整体框架可以适用于训练其他模型，只需调整输入参数、执行脚本和训练代码。

## 先决条件

在继续进行 AI 模型训练管道之前，请确保满足以下先决条件：

1. **Alauda DevOps**：按照 [Alauda DevOps 文档](https://docs.alauda.io/devops) 安装 `Alauda DevOps next-gen`。必须安装 `Alauda DevOps Pipelines` 和 `Alauda DevOps Connectors`。

2. **Volcano**：安装 `Volcano` 集群插件，以启用 AI 工作负载的 GPU 调度和资源管理。

3. **所需的代码库**：准备：
   - 一个用于存储模型和数据集的 Git 代码库。
   - 一个用于存储训练器镜像的容器镜像注册表。

4. **Alauda AI**：建议部署 Alauda AI，以更好地管理模型、训练和推理服务。有关安装和配置的详细信息，请参阅 [Alauda AI 文档](https://docs.alauda.io/ai/)。

5. **GPU 设备插件**：建议部署 GPU 设备插件，如 `HAMi` 或 `NVIDIA GPU Device Plugin`，以利用 GPU 资源进行 AI 训练。有关部署说明，请参阅 [Alauda AI 文档](https://docs.alauda.io/ai/) 中的 `设备管理` 部分。

### 准备模型代码库

从 YOLOv5 代码库的 [yolov5 v7.0](https://github.com/ultralytics/yolov5) 克隆代码。由于下面的示例使用 YOLOv5n 预训练模型，请从 [yolov5n.pt](https://github.com/ultralytics/yolov5/releases/download/v7.0/yolov5n.pt) 下载模型，并将其放置在代码库的 `models/` 目录中。

用户可以根据需要使用其他模型，并相应地调整管道中的 `TRAIN_ARG_WEIGHTS` 参数。

注意：由于 `*.pt` 文件是大型二进制文件，请考虑使用 `git lfs track models/yolov5n.pt` 通过 Git LFS 管理它们。

### 准备数据集代码库

用户可以从 [coco128.zip](https://github.com/ultralytics/assets/releases/download/v0.0.0/coco128.zip) 下载数据集，并将其提交到 Git 代码库。同样，对于数据集中的图像文件，请考虑使用 Git LFS 进行管理，例如：`git lfs track images/train2017/*.jpg`

### 准备训练器镜像

以下 Dockerfile 可用于构建训练镜像。用户可以使用此 Dockerfile 编译自己的训练镜像：

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

### 配置 RBAC

为将要运行 `Pipeline` 的命名空间配置 RBAC。由于 `Pipeline Tasks` 默认使用 `default` `ServiceAccount`，以下脚本配置 `ServiceAccount` 的权限：

<details>

<summary>prepare_rbac.sh</summary>

```bash
#!/bin/bash

NS=$1
SA=${SA:-"default"}
NAME="yolov5-training"

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
  - tekton.dev
  resources:
  - taskruns
  verbs:
  - get
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

运行脚本以为 `default` `ServiceAccount` 配置 RBAC：

```bash
bash prepare_rbac.sh <namespace-name>
```

要使用专用的 `ServiceAccount`，请运行：

```bash
SA=<service-account-name> bash prepare_rbac.sh <namespace-name>
```

注意：

1. 当使用 `ServiceAccount` 时，必须在运行管道时指定 `ServiceAccount` 名称。有关详细信息，请参阅以下部分。

2. 如果在执行过程中遇到权限问题，请联系平台管理员为您执行脚本。

### 创建管道

按照以下步骤在 `Alauda Container Platform` 中创建管道：

1. 在 `Alauda Container Platform` 视图中导航到将要运行管道的命名空间。

2. 在左侧导航中选择 `Pipelines` / `Pipelines`，然后单击打开页面右侧的 `Create` 按钮。

3. 在创建管道对话框中，输入名称 `yolov5-training`，然后单击 `Confirm` 按钮进入管道编排页面。

4. 在管道编排页面，单击右上角的 `YAML` 按钮切换到 YAML 编辑模式，并将以下管道 YAML 内容粘贴到编辑器中。

5. 单击右下角的 `Create` 按钮以创建 `yolov5-training` 管道。

<details>
<summary>管道：yolov5-training</summary>

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
                echo "Cannot use NVIDIA_GPU with HAMi resources:"
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

                        function git_push() {
                          local url=\$1
                          local name=\$(basename \$url)
                          local branch=\"${OUTPUT_MODEL_REPO_BRANCH}\"

                          branch=\${branch#refs/heads/}

                          echo \"Pushing to repository: \$url\"
                          echo \"Branch: \$branch\"

                          # Initialize git repository
                          git init

                          config_safe_directory \"\$(pwd)\"

                          # Check if branch already exists
                          if git show-ref --verify --quiet refs/heads/\$branch; then
                            echo \"Branch \$branch already exists, switching to it\"
                            git checkout \$branch
                          else
                            echo \"Creating new branch \$branch\"
                            git checkout -b \$branch
                          fi

                          git lfs track *.torchscript
                          git add .
                          git -c user.name='AMLSystemUser' -c user.email='aml_admin@cpaas.io' commit -am \"fine tune push auto commit\"

                          # Push to remote repository
                          local push_url=\$(build_git_url \"\$url\")
                          git -c http.sslVerify=false -c lfs.activitytimeout=36000 push -u \"\$push_url\" \"\$branch\"
                          echo \"Successfully pushed to \$url on branch \$branch\"
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
                            echo \"Error: output model /mnt/workspace/model/runs/train/exp/weights/best.pt not found\"
                            exit 1
                          fi

                          cd /mnt/workspace/model/modeldir
                          mkdir 1
                          cp ../runs/train/exp/weights/best.torchscript ./1/model.torchscript
                          touch README.md
                          cp ../runs/train/exp/hyp.yaml .
                          cp ../runs/train/exp/opt.yaml .
                          cp ../runs/train/exp/results.csv .

                          # define yolov5 inference triton config file
                          cat <<EOL > config.pbtxt
                        name: \"${OUTPUT_MODEL_NAME}\"
                        platform: \"pytorch_libtorch\"
                        max_batch_size: 8
                        default_model_filename: \"model.torchscript\"

                        input [
                        {
                        name: \"images\"
                        data_type: TYPE_FP32
                        dims: [3,${TRAIN_ARG_IMAGE_SIZE},${TRAIN_ARG_IMAGE_SIZE}]
                        }
                        ]
                        output [
                        {
                        name: \"output0\"
                        data_type: TYPE_FP32
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

            function get_image() {
              local taskrun_name="$(context.pipelineRun.name)-create-job"
              local namespace="$(context.pipelineRun.namespace)"
              local image=$(kubectl get taskruns.tekton.dev -n ${namespace} ${taskrun_name} -o jsonpath='{.status.taskSpec.steps[0].image}')
              echo -n "${image}" > $(results.string-result.path)
            }

            get_image

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
                  sleep 5
                  continue
                fi
                echo "Volcano Job ${name} status: $job_status"
                printf '"%s",' $(seq 0 $((REPLICAS-1))) | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/' > $(results.array-result.path)
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
              fi
            securityContext:
              runAsNonRoot: true
      timeout: 720h0m0s
  finally: []
```

</details>

### 管道参数

管道包括以下需要配置的关键参数：

**代码库参数：**

- `MODEL_REPO_URL`：模型代码库的 Git URL
- `MODEL_REPO_BRANCH`：模型代码库的分支（可选）
- `DATASET_REPO_URL`：数据集代码库的 Git URL
- `DATASET_REPO_BRANCH`：数据集代码库的分支（可选）
- `OUTPUT_MODEL_REPO_URL`：输出模型代码库的 Git URL
- `OUTPUT_MODEL_REPO_BRANCH`：输出模型代码库的分支（可选，如果未指定则自动生成）
- `GIT_CREDENTIAL_SECRET_NAME`：Git 凭证秘密的名称（需要 `GIT_USER` 和 `GIT_TOKEN` 键，其中 `GIT_USER` 存储 Git 用户名，`GIT_TOKEN` 存储 Git 密码或访问令牌）

**训练参数：**

- `TRAINING_IMAGE`：训练作业的容器镜像
- `TRAIN_ARG_IMAGE_SIZE`：训练参数图像大小（默认："640"）
- `TRAIN_ARG_BATCH_SIZE`：训练参数批量大小（默认："16"）
- `TRAIN_ARG_EPOCHS`：训练参数轮数（默认："3"）
- `TRAIN_ARG_DATA`：训练参数数据文件（默认："coco128.yaml"）
- `TRAIN_ARG_WEIGHTS`：训练参数权重（默认："models/yolov5n.pt"）
- `TRAIN_ARG_WORKERS`：训练参数工作线程（默认："0"）
- `TRAIN_ARG_DEVICE`：训练设备，多个设备用逗号分隔（默认："0"）

有关 YOLOv5 训练参数配置的更多信息，请参阅 [YOLOv5 训练设置文档](https://docs.ultralytics.com/yolov5/tutorials/tips_for_best_training_results/#training-settings)。

**资源参数：**

- `TEMPORARY_STORAGE_SIZE`：临时存储大小（默认："5Gi"）
- `REPLICAS`：副本数量（默认："1"，如果大于 1，则启用分布式训练）
- `CPU_REQUEST`：请求 CPU（默认："1"，留空则不请求 CPU）
- `MEMORY_REQUEST`：请求内存（默认："8Gi"，留空则不请求内存）
- `CPU_LIMIT`：限制 CPU（默认："8"，留空则不限制 CPU）
- `MEMORY_LIMIT`：限制内存（默认："20Gi"，留空则不限制内存）
- `NVIDIA_GPUALLOC`：NVIDIA GPU 分配 - GPU 卡数量（默认："1"，留空则不分配 GPU）
- `NVIDIA_GPUCORES`：NVIDIA GPU 核心 - 每张卡的计算能力百分比，范围 1-100（默认："50"，留空则不配置 GPU 核心）
- `NVIDIA_GPUMEM`：NVIDIA GPU 内存 - 每张卡的内存使用量（以 MiB 为单位，默认："4096"，留空则不配置 GPU 内存）
- `NVIDIA_GPU`：NVIDIA GPU 数量 - 使用 NVIDIA GPU 插件时分配的 GPU 卡数量，不能与 HAMi 参数一起使用（默认："", 留空则不设置）

### 触发管道

按照以下步骤触发管道：

1. 选择 `yolov5-training` 管道并单击 `Run` 按钮以打开 `Run Pipeline` 对话框。

2. 在 `Run Pipeline` 对话框中，输入管道参数。对于具有默认值的参数，使用 `Add Execution Parameter` 先暴露它们，然后再设置值。

3. （可选）设置参数后，单击 `Save as Trigger Template` 将当前参数保存为 `Trigger Template`。在后续的管道运行中，单击 `Run Pipeline` 对话框中列出的模板，以自动设置所有参数。

4. 如果运行管道的 ServiceAccount 不是 `default`，请单击右上角的 `YAML` 按钮切换到 YAML 编辑模式，然后将 `taskRunTemplate.serviceAccountName` 添加到 `spec` 中：
   ```yaml
   spec:
     .... # 其他内容
     taskRunTemplate:
       serviceAccountName: <service-account-name>
   ```
   此配置也可以保存到 `Trigger Template` 中，以便在后续运行中方便重用。

5. 设置参数后，单击 `Run` 按钮以执行管道。

有关事件驱动管道执行的信息，请参阅 [Pipelines 文档](https://docs.alauda.io/alauda-devops-pipelines/) 中的 `Trigger` 部分。

**注意**：当管道运行时，它会创建一个与 `PipelineRun` 通过 `OwnerReference` 关联的 `VolcanoJob`。当 `PipelineRun` 被删除时，相关的 `VolcanoJob` 及其相关资源（如 `PodGroup` 和 `Pods`）将被级联删除。有关 `VolcanoJob` 的更多信息，请参阅 [VolcanoJob 文档](https://volcano.sh/en/docs/vcjob/)。

### 检查 PipelineRun 状态和日志

可以在 `PipelineRuns` 的相应执行记录中查看执行状态和训练日志。
