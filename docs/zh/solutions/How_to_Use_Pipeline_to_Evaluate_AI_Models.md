---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 4.x
id: KB1763720171-28D7
sourceSHA: b18a53914b82429144b8722d83e732e5afc49fc78e5d97eaf58b04ce2773b1a6
---

# 如何使用管道评估 AI 模型

## 概述

本文档演示了如何使用 DevOps 管道评估 AI 模型。以 YOLOv5 模型为例，说明评估工作流。这里呈现的整体框架可以适用于评估其他模型，只需对输入参数、执行脚本和评估代码进行调整。

## 先决条件

在继续进行 AI 模型评估管道之前，请确保满足以下先决条件：

1. **Alauda DevOps**：按照 [Alauda DevOps 文档](https://docs.alauda.io/devops) 安装 `Alauda DevOps next-gen`。必须安装 `Alauda DevOps Pipelines` 和 `Alauda DevOps Connectors`。

2. **Volcano**：安装 `Volcano` 集群插件，以启用 AI 工作负载的 GPU 调度和资源管理。

3. **Evidently**：按照 [Evidently 安装文档](How_to_Install_and_use_Evidently.md) 安装 Evidently UI。Evidently 用于模型评估结果的可视化和监控。

4. **所需的代码库**：准备：
   - 一个 Git 代码库，用于存储模型代码和验证数据集。
   - 一个容器镜像注册表，用于存储评估镜像。

5. **Alauda AI**：建议部署 Alauda AI，以更好地管理模型、训练和推理服务。有关安装和配置的详细信息，请参阅 [Alauda AI 文档](https://docs.alauda.io/ai/)。

6. **GPU 设备插件**：建议部署 GPU 设备插件，如 `HAMi` 或 `NVIDIA GPU Device Plugin`，以利用 GPU 资源进行 AI 评估。有关部署说明，请参阅 [Alauda AI 文档](https://docs.alauda.io/ai/) 中的 `设备管理` 部分。

### 准备模型代码库

从 YOLOv5 代码库的 [yolov5 v7.0](https://github.com/ultralytics/yolov5) 克隆代码。主要要求是必须有 `val.py` 脚本可用于模型评估。

### 准备待评估模型

待评估的模型来自 `yolov5-training` 管道的输出。有关如何训练模型并获取训练模型文件的详细信息，请参阅 **如何使用管道训练 AI 模型**。

### 准备验证数据集

从 [val2017.zip](http://images.cocodataset.org/zips/val2017.zip) 下载验证图像，并从 [annotations_trainval2017.zip](http://images.cocodataset.org/annotations/annotations_trainval2017.zip) 下载注释信息。

目录结构应为：

```text
images/
  val2017/           # val2017.zip 解压后的内容
annotations/         # annotations_trainval2017.zip 解压后的内容
val2017.txt          # coco.yaml 引用的文件，使用以下命令生成：
                     # for i in $(ls images/val2017); do echo "../datasets/coco/images/val2017/$i"; done > val2017.txt
```

由于 `*.json` 和 `*.jpg` 文件是大型二进制文件，建议使用 Git LFS 来管理它们：

```bash
git lfs track "*.json" "*.jpg"
```

### 准备评估镜像

以下 Dockerfile 可用于构建评估镜像。用户可以使用此 Dockerfile 编译自己的评估镜像：

<details>

<summary>Dockerfile </summary>

```dockerfile
FROM nvcr.io/nvidia/pytorch:24.12-py3

# 可选，修改 apt 源
#RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.ustc.edu.cn@g' /etc/apt/sources.list && \
#    sed -i 's/security.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list &&

RUN apt-get update && \
    export DEBIAN_FRONTEND=noninteractive && \
    apt-get install -yq --no-install-recommends git git-lfs unzip curl ffmpeg libfreetype6-dev && \
    apt clean && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /root/.config/Ultralytics && \
    curl -fsSL https://ultralytics.com/assets/Arial.ttf -o /root/.config/Ultralytics/Arial.ttf && \
    curl -fsSL https://ultralytics.com/assets/Arial.Unicode.ttf -o /root/.config/Ultralytics/Arial.Unicode.ttf

# 可选，添加 "-i https://pypi.tuna.tsinghua.edu.cn/simple" 到 pip install 参数以从代理源下载。

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

### 配置 RBAC

为将运行 `Pipeline` 的命名空间配置 RBAC。由于 `Pipeline Tasks` 默认使用 `default` `ServiceAccount`，以下脚本配置 `ServiceAccount` 的权限：

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

运行脚本以为 `default` `ServiceAccount` 配置 RBAC：

```bash
bash prepare_rbac.sh <namespace-name>
```

要使用专用的 `ServiceAccount`，请运行：

```bash
SA=<service-account-name> bash prepare_rbac.sh <namespace-name>
```

注意：

1. 当使用非 `default` 的 `ServiceAccount` 时，必须在运行管道时指定 `ServiceAccount` 名称。有关详细信息，请参阅以下部分。

2. 如果在执行过程中遇到权限问题，请联系平台管理员以执行脚本。

### 创建管道

按照以下步骤在 `Alauda Container Platform` 中创建管道：

1. 在 `Alauda Container Platform` 视图中导航到将运行管道的命名空间。

2. 在左侧导航中选择 `Pipelines` / `Pipelines`，然后单击打开页面右侧的 `Create` 按钮。

3. 在创建管道对话框中，输入名称 `yolov5-evaluating`，然后单击 `Confirm` 按钮以进入管道编排页面。

4. 在管道编排页面，单击右上角的 `YAML` 按钮切换到 YAML 编辑模式，并将以下管道 YAML 内容粘贴到编辑器中。

5. 单击右下角的 `Create` 按钮以创建 `yolov5-evaluating` 管道。

<details>
<summary>管道：yolov5-evaluating</summary>

```yaml
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: yolov5-evaluating
spec:
  params:
    - description: 包含 YOLOv5 代码和 val.py 脚本的模型代码库的 Git URL
      name: MODEL_REPO_URL
      type: string
    - default: ""
      description: 要使用的模型代码库的分支
      name: MODEL_REPO_BRANCH
      type: string
    - description: 包含验证图像和注释的数据集代码库的 Git URL
      name: DATASET_REPO_URL
      type: string
    - default: ""
      description: 要使用的数据集代码库的分支
      name: DATASET_REPO_BRANCH
      type: string
    - default: "/mnt/workspace/datasets/coco"
      description: 数据集在容器中挂载的目录路径
      name: DATASET_DIR
      type: string
    - default: "/mnt/workspace/datasets/coco/annotations/instances_val2017.json"
      description: 验证的 COCO 注释 JSON 文件路径
      name: ANNOTATION_JSON
      type: string
    - description: 包含待评估训练模型的代码库的 Git URL
      name: OUTPUT_MODEL_REPO_URL
      type: string
    - default: ""
      description: 要使用的输出模型代码库的分支
      name: OUTPUT_MODEL_REPO_BRANCH
      type: string
    - default: "1/model.torchscript"
      description: 输出模型代码库中训练模型文件的相对路径
      name: OUTPUT_MODEL_PATH
      type: string
    - description: 包含 Git 凭据的 Kubernetes 秘密的名称（GIT_USER 和 GIT_TOKEN 键）
      name: GIT_CREDENTIAL_SECRET_NAME
      type: string
    - description: 模型评估作业的容器镜像
      name: EVALUATING_IMAGE
      type: string
    - description: 评估作业的临时存储大小
      name: TEMPORARY_STORAGE_SIZE
      type: string
      default: "5Gi"
    - description: 评估作业的 CPU 请求
      name: CPU_REQUEST
      type: string
      default: "1"
    - description: 评估作业的内存请求
      name: MEMORY_REQUEST
      type: string
      default: "8Gi"
    - description: 评估作业的 CPU 限制
      name: CPU_LIMIT
      type: string
      default: "8"
    - description: 评估作业的内存限制
      name: MEMORY_LIMIT
      type: string
      default: "20Gi"
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
    - description: 模型评估的图像大小（宽度和高度，以像素为单位）
      name: EVALUATE_ARG_IMAGE_SIZE
      type: string
      default: "640"
    - description: 模型评估的批处理大小
      name: EVALUATE_ARG_BATCH_SIZE
      type: string
      default: "16"
    - description: 数据集配置 YAML 文件的路径
      name: EVALUATE_ARG_DATA
      type: string
      default: "coco.yaml"
    - description: 训练模型权重文件的路径
      name: EVALUATE_ARG_WEIGHTS
      type: string
      default: "models/model.torchscript"
    - description: 数据加载的工作线程数量
      name: EVALUATE_ARG_WORKERS
      type: string
      default: "0"
    - description: 用于评估的设备，多个设备用逗号分隔（例如 "0,1,2,3"），设置为 "cpu" 以使用 CPU
      name: EVALUATE_ARG_DEVICE
      type: string
      default: "0"
    - name: EVIDENTLY_ENDPOINT
      description: 用于上传评估报告的 Evidently UI 服务端点 URL
      type: string
    - name: EVIDENTLY_PROJECT_NAME
      description: 用于存储评估报告的 Evidently 项目名称
      type: string
      default: ""
    - name: EVIDENTLY_API_KEY
      description: 访问 Evidently 工作区的 API 密钥
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
            - EVIDENTLY_PROJECT_NAME=$(params.EVALUATE_ARG_PROJECT_NAME)
            - EVIDENTLY_API_KEY=$(params.EVIDENTLY_API_KEY)
        - name: script
          value: |-
            set -euo pipefail
            export "$@"

            if [ -z "$MODEL_REPO_URL" ]; then
              echo "模型代码库 URL 不能为空"
              exit 1
            fi

            if [ -z "$DATASET_REPO_URL" ]; then
              echo "数据集代码库 URL 不能为空"
              exit 1
            fi

            if [ -z "$OUTPUT_MODEL_REPO_URL" ]; then
              echo "输出模型代码库 URL 不能为空"
              exit 1
            fi

            if [ -z "$DATASET_DIR" ]; then
              echo "数据集目录不能为空"
              exit 1
            fi

            if [ -z "$GIT_CREDENTIAL_SECRET_NAME" ]; then
              echo "Git 凭据不能为空"
              exit 1
            fi

            if [ -z "$EVALUATING_IMAGE" ]; then
              echo "评估镜像不能为空"
              exit 1
            fi

            if [ -z "$TEMPORARY_STORAGE_SIZE" ]; then
              TEMPORARY_STORAGE_SIZE="5Gi"
              echo "临时存储大小为空，使用默认存储大小：$TEMPORARY_STORAGE_SIZE"
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
                echo "不能同时使用 NVIDIA_GPU 和 HAMi 资源："
                echo "NVIDIA_GPU=${NVIDIA_GPU}, NVIDIA_GPUALLOC=${NVIDIA_GPUALLOC}, NVIDIA_GPUCORES=${NVIDIA_GPUCORES}, NVIDIA_GPUMEM=${NVIDIA_GPUMEM}"
                exit 1
            fi

            if [ -z "$EVALUATE_ARG_IMAGE_SIZE" ]; then
              EVALUATE_ARG_IMAGE_SIZE="640"
              echo "评估参数图像大小为空，使用默认值：$EVALUATE_ARG_IMAGE_SIZE"
            fi

            if [ -z "$EVALUATE_ARG_BATCH_SIZE" ]; then
              EVALUATE_ARG_BATCH_SIZE="16"
              echo "评估参数批处理大小为空，使用默认值：$EVALUATE_ARG_BATCH_SIZE"
            fi

            if [ -z "$EVALUATE_ARG_DATA" ]; then
              EVALUATE_ARG_DATA="coco.yaml"
              echo "评估参数数据为空，使用默认值：$EVALUATE_ARG_DATA"
            fi

            if [ -z "$EVALUATE_ARG_WEIGHTS" ]; then
              EVALUATE_ARG_WEIGHTS="models/model.torchscript"
              echo "评估参数权重为空，使用默认值：$EVALUATE_ARG_WEIGHTS"
            fi

            if [ -z "$EVALUATE_ARG_WORKERS" ]; then
              EVALUATE_ARG_WORKERS="0"
              echo "评估参数工作线程为空，使用默认值：$EVALUATE_ARG_WORKERS"
            fi

            if [ -z "$EVALUATE_ARG_DEVICE" ]; then
              EVALUATE_ARG_DEVICE="0"
              echo "评估参数设备为空，使用默认值：$EVALUATE_ARG_DEVICE"
            fi

            if [ -z "$EVIDENTLY_ENDPOINT" ]; then
              echo "Evidently 端点为空，不配置 Evidently 端点！"
              EVIDENTLY_ENDPOINT=""
            else
              if [[ ! "$EVIDENTLY_ENDPOINT" =~ ^https?:// ]]; then
                echo "错误：Evidently 端点必须以 https:// 或 http:// 开头，得到：$EVIDENTLY_ENDPOINT"
                exit 1
              fi
            fi

            if [ -z "$EVIDENTLY_PROJECT_NAME" ]; then
              EVIDENTLY_PROJECT_NAME=$(context.pipelineRun.namespace)
              echo "Evidently 项目名称为空，使用命名空间作为项目名称"
            fi

            echo "模型代码库 URL: $MODEL_REPO_URL ${MODEL_REPO_BRANCH}"
            echo "数据集代码库 URL: $DATASET_REPO_URL ${DATASET_REPO_BRANCH}"
            echo "输出模型代码库 URL: $OUTPUT_MODEL_REPO_URL ${OUTPUT_MODEL_REPO_BRANCH} ${OUTPUT_MODEL_PATH}"
            echo "评估镜像: $EVALUATING_IMAGE"
            echo "临时存储大小: $TEMPORARY_STORAGE_SIZE"
            echo "CPU 请求: $CPU_REQUEST"
            echo "内存请求: $MEMORY_REQUEST"
            echo "CPU 限制: $CPU_LIMIT"
            echo "内存限制: $MEMORY_LIMIT"
            echo "NVIDIA GPU 分配: $NVIDIA_GPUALLOC"
            echo "NVIDIA GPU 核心: $NVIDIA_GPUCORES"
            echo "NVIDIA GPU 内存: $NVIDIA_GPUMEM"
            echo "NVIDIA GPU: $NVIDIA_GPU"
            echo "评估参数图像大小: $EVALUATE_ARG_IMAGE_SIZE"
            echo "评估参数批处理大小: $EVALUATE_ARG_BATCH_SIZE"
            echo "评估参数数据: $EVALUATE_ARG_DATA"
            echo "评估参数权重: $EVALUATE_ARG_WEIGHTS"
            echo "评估参数工作线程: $EVALUATE_ARG_WORKERS"
            echo "评估参数设备: $EVALUATE_ARG_DEVICE"
            echo "Evidently 端点: $EVIDENTLY_ENDPOINT"
            echo "Evidently 项目名称: $EVIDENTLY_PROJECT_NAME"
            echo "Evidently api 密钥: [已隐藏]"

            EVIDENTLY_PROJECT_ID=""

            function prepare_evidently_project() {
              local project='/tmp/projects.json'
              local project_id=""

              if ! curl -s "${EVIDENTLY_ENDPOINT}/api/projects/search/${EVIDENTLY_PROJECT_NAME}" \
                       -H "Evidently-secret: ${EVIDENTLY_API_KEY}" \
                       -o ${project}; then
                echo "错误：搜索项目失败"
                exit 1
              fi

              project_id=$(jq -r --arg name "${EVIDENTLY_PROJECT_NAME}" '.[] | select(.name == $name) | .id' ${project} 2>/dev/null)

              if [ -z "${project_id}" ] || [ "${project_id}" = "null" ]; then
                echo "未找到项目，创建新项目：${EVIDENTLY_PROJECT_NAME}"
                if ! curl -s -X POST "${EVIDENTLY_ENDPOINT}/api/projects" \
                         -H "Evidently-secret: ${EVIDENTLY_API_KEY}" \
                         -H "Content-Type: application/json" \
                         -d "{\"name\": \"${EVIDENTLY_PROJECT_NAME}\"}" \
                         -o ${project}; then
                  echo "错误：创建项目失败"
                  exit 1
                fi
                project_id=$(cat ${project})
              fi

              if [ -z "${project_id}" ] || [ "${project_id}" = "null" ]; then
                echo "错误：获取项目 ID 失败"
                exit 1
              fi

              EVIDENTLY_PROJECT_ID="${project_id}"
              echo "Evidently 项目 ID: $EVIDENTLY_PROJECT_ID"
            }

            if [ -n "$EVIDENTLY_ENDPOINT" ]; then
              prepare_evidently_project
            fi

            name=$(context.pipelineRun.name)
            echo "Volcano 作业名称: $name"

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
                            echo \"当前目录已经是一个 git 仓库，拉取最新更改\"
                            if [ -n \"\$branch\" ]; then
                              echo \"切换到分支：\$branch\"
                              git checkout \$branch
                            fi

                            config_safe_directory \"\$(pwd)\"
                            git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull
                          else
                            echo \"克隆仓库到当前目录\"
                            if [ -n \"\$branch\" ]; then
                              echo \"克隆分支：\$branch\"
                              GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone -b \$branch \"\$clone_url\" .
                            else
                              GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone \"\$clone_url\" .
                            fi
                            if [ -d .git ]; then
                              echo \"确认 git 仓库，执行 lfs pull\"
                              config_safe_directory \"\$(pwd)\"
                              git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull
                            else
                              echo \"错误：克隆后未找到 .git 目录\"
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
                            echo \"错误：未找到预测文件：\${SAVE_JSON}\"
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

                        echo \"列出模型文件...\"
                        ls /mnt/workspace/model
                        echo \"列出数据集文件...\"
                        ls ${DATASET_DIR}

                        echo \"初始化任务成功完成\"

                        evaluate

                        if [ -z "$EVIDENTLY_ENDPOINT" ]; then
                          echo \"Evidently 端点为空，跳过 Evidently 评估\"
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
                            print('生成 COCO 评估报告...')

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
                                print(f'上传报告到 Evidently 工作区：{endpoint}')
                                workspace = RemoteWorkspace(
                                    base_url=endpoint,
                                    secret=api_key
                                )
                                snapshot_ref = workspace.add_run(project_id, report, include_data=False)
                                print(f'报告上传成功，ID: {snapshot_ref.id}')
                                print(f'报告 URL: {snapshot_ref.url}')
                                save_dashboard(workspace, project_id)
                                return True
                            except Exception as e:
                                print(f'上传到 Evidently 工作区时出错：{e}')
                                return False

                        def save_dashboard(workspace, project_id):
                            ap_metrics = []
                            ar_metrics = []
                            for i, column in enumerate(mAPColumns):
                                ap_metrics.append(PanelMetric(legend=mAPDisplayNames[i], metric='coco_eval_metric', metric_labels={'column': column}))
                            for i, column in enumerate(mARColumns):
                                ar_metrics.append(PanelMetric(legend=mARDisplayNames[i], metric='coco_eval_metric', metric_labels={'column': column}))
                            pannels = [
                                DashboardPanelPlot(title='COCO 平均精度', subtitle='maxDets=100', values=ap_metrics, size='full', plot_params={'plot_type': 'line'}),
                                DashboardPanelPlot(title='COCO 平均召回率', subtitle='IoU=0.50:0.95', values=ar_metrics, size='full', plot_params={'plot_type': 'line'}),
                            ]
                            project = workspace.get_project(project_id)
                            existing_panels = project.dashboard.model().panels
                            existing_titles = [panel.title for panel in existing_panels]
                            for panel in pannels:
                                if panel.title not in existing_titles:
                                    project.dashboard.add_panel(panel)
                                else:
                                    print(f'面板 {panel.title} 已存在')
                            return

                        def main():
                            pred_json = os.environ.get('SAVE_JSON', '')
                            anno_json = os.environ.get('ANNO_JSON', '')
                            endpoint = os.environ.get('EVIDENTLY_ENDPOINT', '')
                            api_key = os.environ.get('EVIDENTLY_API_KEY', '')
                            project_id = os.environ.get('EVIDENTLY_PROJECT_ID', '')

                            coco_report = generate_coco_report(anno_json, pred_json)

                            if not endpoint:
                                print('警告：Evidently 端点为空，跳过上传到 Evidently 工作区')
                                return

                            upload_success = upload_to_evidently_workspace(coco_report, endpoint, api_key, project_id)
                            if upload_success:
                                print('成功：成功将 COCO 评估报告上传到 Evidently 工作区')
                            else:
                                print('警告：报告上传失败，请检查配置')

                        if __name__ == '__main__':
                            main()
                        EOF

                        echo \"\"
                        echo \"运行 Evidently 分析...\"
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
            echo "Volcano 作业 YAML: "
            cat /tmp/job.yaml
            echo "创建 Volcano 作业"

            kubectl create -f /tmp/job.yaml
            kubectl get -f /tmp/job.yaml

            function wait_job() {
              echo "等待作业完成..."
              while true; do
                local job_status=$(kubectl get jobs.batch.volcano.sh ${name} -o jsonpath='{.status.state.phase}')
                if [ "$job_status" = "Pending" ]; then
                  echo "等待 Volcano 作业 ${name} 启动..."
                  sleep 5
                  continue
                fi
                echo "Volcano 作业 ${name} 状态: $job_status"
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
                echo "Pod ${pod_name} 正在等待，等待中..."
                sleep 5
                continue
              fi
              if [ "$pod_status" != "Running" ]; then
                break
              fi
              sleep 5
            done

            echo ""
            echo "--- Pod ${pod_name} 日志完成，状态: ${pod_status} ---"
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
                    "description": "平均精度，IoU=0.50:0.95 area=all maxDets=100",
                    "value": ${mAP_0_5_0_95}
                  },
                  {
                    "metric": "mAP_0_5",
                    "description": "平均精度，IoU=0.50 area=all maxDets=100",
                    "value": ${mAP_0_5}
                  },
                  {
                    "metric": "mAP_0_75",
                    "description": "平均精度，IoU=0.75 area=all maxDets=100",
                    "value": ${mAP_0_75}
                  },
                  {
                    "metric": "mAP_small",
                    "description": "平均精度，IoU=0.50:0.95 area=small maxDets=100",
                    "value": ${mAP_small}
                  },
                  {
                    "metric": "mAP_medium",
                    "description": "平均精度，IoU=0.50:0.95 area=medium maxDets=100",
                    "value": ${mAP_medium}
                  },
                  {
                    "metric": "mAP_large",
                    "description": "平均精度，IoU=0.50:0.95 area=large maxDets=100",
                    "value": ${mAP_large}
                  },
                  {
                    "metric": "mAR_1",
                    "description": "平均召回率，IoU=0.50:0.95 area=all maxDets=1",
                    "value": ${mAR_1}
                  },
                  {
                    "metric": "mAR_10",
                    "description": "平均召回率，IoU=0.50:0.95 area=all maxDets=10",
                    "value": ${mAR_10}
                  },
                  {
                    "metric": "mAR_100",
                    "description": "平均召回率，IoU=0.50:0.95 area=all maxDets=100",
                    "value": ${mAR_100}
                  },
                  {
                    "metric": "mAR_small",
                    "description": "平均召回率，IoU=0.50:0.95 area=small maxDets=100",
                    "value": ${mAR_small}
                  },
                  {
                    "metric": "mAR_medium",
                    "description": "平均召回率，IoU=0.50:0.95 area=medium maxDets=100",
                    "value": ${mAR_medium}
                  },
                  {
                    "metric": "mAR_large",
                    "description": "平均召回率，IoU=0.50:0.95 area=large maxDets=100",
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

### 管道参数

管道包括以下需要配置的关键参数：

**代码库参数：**

- `MODEL_REPO_URL`：包含 YOLOv5 代码和 val.py 脚本的模型代码库的 Git URL
- `MODEL_REPO_BRANCH`：要使用的模型代码库的分支（可选）
- `DATASET_REPO_URL`：包含验证图像和注释的数据集代码库的 Git URL
- `DATASET_REPO_BRANCH`：要使用的数据集代码库的分支（可选）
- `OUTPUT_MODEL_REPO_URL`：包含待评估训练模型的代码库的 Git URL
- `OUTPUT_MODEL_REPO_BRANCH`：要使用的输出模型代码库的分支（可选）
- `OUTPUT_MODEL_PATH`：输出模型代码库中训练模型文件的相对路径（默认值："1/model.torchscript"）
- `GIT_CREDENTIAL_SECRET_NAME`：包含 Git 凭据的 Kubernetes 秘密的名称（GIT_USER 和 GIT_TOKEN 键）

**评估参数：**

- `EVALUATING_IMAGE`：模型评估作业的容器镜像
- `EVALUATE_ARG_IMAGE_SIZE`：模型评估的图像大小（宽度和高度，以像素为单位）（默认值："640"）
- `EVALUATE_ARG_BATCH_SIZE`：模型评估的批处理大小（默认值："16"）
- `EVALUATE_ARG_DATA`：数据集配置 YAML 文件的路径（默认值："coco.yaml"）
- `EVALUATE_ARG_WEIGHTS`：训练模型权重文件的路径（默认值："models/model.torchscript"）
- `EVALUATE_ARG_WORKERS`：数据加载的工作线程数量（默认值："0"）
- `EVALUATE_ARG_DEVICE`：用于评估的设备，多个设备用逗号分隔（例如 "0,1,2,3"），设置为 "cpu" 以使用 CPU（默认值："0"）

有关 YOLOv5 评估参数配置的更多信息，请参阅 [YOLOv5 验证文档](https://docs.ultralytics.com/modes/val/)。

**Evidently 参数：**

- `EVIDENTLY_ENDPOINT`：用于上传评估报告的 Evidently UI 服务端点 URL
- `EVIDENTLY_PROJECT_NAME`：用于存储评估报告的 Evidently 项目名称（默认值：如果未指定，则使用命名空间）
- `EVIDENTLY_API_KEY`：访问 Evidently 工作区的 API 密钥

**资源参数：**

- `TEMPORARY_STORAGE_SIZE`：评估作业的临时存储大小（默认值："5Gi"）
- `CPU_REQUEST`：评估作业的 CPU 请求（默认值："1"，留空则不请求 CPU）
- `MEMORY_REQUEST`：评估作业的内存请求（默认值："8Gi"，留空则不请求内存）
- `CPU_LIMIT`：评估作业的 CPU 限制（默认值："8"，留空则不限制 CPU）
- `MEMORY_LIMIT`：评估作业的内存限制（默认值："20Gi"，留空则不限制内存）
- `NVIDIA_GPUALLOC`：HAMi NVIDIA GPU 分配 - GPU 卡数量（默认值："1"，留空则不分配 GPU）
- `NVIDIA_GPUCORES`：HAMi NVIDIA GPU 核心 - 每张卡的计算能力百分比，范围 1-100（默认值："50"，留空则不配置 GPU 核心）
- `NVIDIA_GPUMEM`：HAMi NVIDIA GPU 内存 - 每张卡的内存使用量（MiB）（默认值："4096"，留空则不配置 GPU 内存）
- `NVIDIA_GPU`：NVIDIA GPU 数量 - 使用 NVIDIA GPU 插件时分配的 GPU 卡数量，不能与 HAMi 参数一起使用（默认值："", 留空则不设置）

### 触发管道

按照以下步骤触发管道：

1. 选择 `yolov5-evaluating` 管道并单击 `Run` 按钮以打开 `Run Pipeline` 对话框。

2. 在 `Run Pipeline` 对话框中，输入管道参数。对于具有默认值的参数，使用 `Add Execution Parameter` 先暴露它们，然后再设置值。

3. （可选）设置参数后，单击 `Save as Trigger Template` 将当前参数保存为 `Trigger Template`。对于后续的管道运行，单击 `Run Pipeline` 对话框中列出的模板，以自动设置所有参数。

4. 如果运行管道的 ServiceAccount 不是 `default`，请单击右上角的 `YAML` 按钮切换到 YAML 编辑模式，然后将 `taskRunTemplate.serviceAccountName` 添加到 `spec`：
   ```yaml
   spec:
     .... # 其他内容
     taskRunTemplate:
       serviceAccountName: <service-account-name>
   ```
   此配置也可以保存到 `Trigger Template` 中，以便在后续运行中方便重用。

5. 设置参数后，单击 `Run` 按钮以执行管道。

6. 管道在后台创建一个 VolcanoJob，运行 YOLOv5 的 `val.py` 脚本。`val.py` 脚本在验证数据集上验证模型，生成 `xxx_predictions.json`，然后使用 `COCOeval` 将检测结果与真实注释进行比较，生成评估结果。这些评估结果随后上传到 `Evidently`。

7. 执行成功后，可以在 `Evidently` 项目中查看 `Report` 和 `Dashboard`。评估结果和 `Evidently Report` 访问地址可以在管道运行结果的 `Result` 选项卡中找到。

有关事件驱动的管道执行，请参阅 [Pipelines 文档](https://docs.alauda.io/alauda-devops-pipelines/) 中的 `Trigger` 部分。

**注意**：当管道运行时，它会创建一个与 `PipelineRun` 通过 `OwnerReference` 关联的 `VolcanoJob`。当 `PipelineRun` 被删除时，关联的 `VolcanoJob` 及其相关资源（如 `PodGroup` 和 `Pods`）将被级联删除。有关 `VolcanoJob` 的更多信息，请参阅 [VolcanoJob 文档](https://volcano.sh/en/docs/vcjob/)。

### 检查 PipelineRun 状态和日志

可以在相应的执行记录中查看执行状态和评估日志。
