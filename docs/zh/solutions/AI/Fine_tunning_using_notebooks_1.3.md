---
id: KB1763720171-E802
sourceSHA: 4be5ba8b8bf58ec2f95b1d47c09b8527c44d18e6e7836f8b22e94c747fbe9c3e
---

# Alauda AI 1.3 (AML 1.3) Notebook 模型微调与训练通用解决方案

## 背景

模型微调和训练通常需要适应不同的模型结构、硬件设备和适当的并行训练方法。Alauda AI Notebook 提供了一个全面的方法，从模型开发到训练任务提交和管理，再到实验跟踪，帮助模型和算法工程师快速适应并完成整个模型微调和训练过程。

Alauda AI Notebook 为开发和调试创建了一个 Notebook/VSCode (CodeServer) 容器环境，位于用户命名空间内。可以在一个命名空间内创建多个 Notebook/VSCode 实例，以保留不同用户和开发任务的环境。Notebook 可以仅请求 CPU 资源进行开发和集群任务提交，使用集群的 GPU 资源来运行任务。也可以为 Notebook 请求 GPU 资源，使得训练和微调等任务能够直接在 Notebook 内完成，而不受分布式模型的限制。

此外，您可以使用平台内置的 `MLFlow` 记录每个模型微调训练会话的各种指标，从而更容易比较多个实验并选择最终模型。

我们使用 [VolcanoJob](https://volcano.sh/en/docs/vcjob/) 作为 Kubernetes 原生资源管理器，通过 Notebook 提交集群任务。Volcano 调度器支持队列、优先级和各种调度策略，促进更高效的集群任务调度，提高资源利用率。

本解决方案使用 [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory) 工具来启动微调和训练任务。然而，对于需要并行方法（如张量并行、上下文并行和专家并行）来训练更大模型的大规模模型微调和训练场景，可能需要使用其他工具，构建自定义微调运行时镜像，并修改任务启动脚本以适应不同的工具和模型。有关 LLaMA-Factory 的更详细用法和参数配置，请参考：<https://llamafactory.readthedocs.io/en/latest/index.html>

## 范围

- 本解决方案适用于 Alauda AI 1.3 (AML 1.3) 及更高版本。
- 本解决方案适用于 x86/64 CPU 和 NVIDIA GPU 场景。
- LLM 模型的微调和训练。如果需要训练其他类型的模型（如 Yolov5），则需要使用不同的镜像、启动脚本、数据集等。
- NPU 场景需要基于本解决方案构建合适的运行时镜像以兼容。

## 准备工作

- 您必须首先部署 Kubeflow 插件以启用 Notebook 支持。
- 开启“实验性”功能，或安装 `MLFlow` 插件。

## LLM 模型微调步骤

### 创建 Notebook/VSCode 实例

从导航栏中，转到高级 - Notebook 并创建或申请现有 Notebook。请注意，建议 Notebook 仅使用 CPU 资源。从 Notebook 内提交集群任务将请求集群内的 GPU 资源以提高资源利用率。

- 点击“新建 Notebook”进入创建页面。
- 配置 Notebook 实例：
  - 名称
  - 镜像：您可以直接使用内置的 Notebook 镜像。您也可以基于 Alauda 提供的基础 Notebook 镜像构建自定义镜像。选择“自定义镜像”并输入镜像地址。
  - 容器 CPU 和内存要求。展开“高级选项”以配置更高的 CPU 和内存限制。
  - GPU：选择要使用的 GPU 资源。您可以指定完整的 GPU 或虚拟 GPU 解决方案。
  - 工作区卷：Notebook 目录使用的默认存储卷（PVC）。如果未指定，将为当前 Notebook 自动创建存储卷。您还可以点击下拉按钮配置存储卷信息。
  - 数据卷：在 Notebook 内挂载一个或多个额外的存储卷。例如，如果您的数据集或模型存储在另一个存储卷上，您可以挂载额外的卷。
  - 配置项：您可以将此选项保持未选中状态。
  - 共享内存：如果您希望在 Notebook 内使用多 GPU 通信等功能，请启用此选项。否则，请勿启用。

### 准备模型

请参考 Alauda AI 在线文档，了解如何使用 Notebook 上传模型的详细步骤。

### 准备模型输出位置

在模型库中创建一个空模型以存储输出模型。在配置微调输出位置时，输入模型的 Git 仓库 URL。

### 准备数据集

下载并推送示例身份数据集（文件位于 `docs/en/assets/identity-alauda-main.zip`）到数据集库。此数据集用于微调 LLM，以回答用户问题，例如“你是谁？”

1. 首先，在“数据集” - “数据集库”下创建一个空的数据集库。
2. 将 zip 文件上传到 Notebook，解压缩，然后导航到数据集目录。使用 git lfs 将数据集推送到数据集库的 Git URL。步骤与上传模型类似。有关详细信息，请参考 Alauda AI 在线文档。
3. 推送完成后，刷新数据集页面，您应该会看到在“文件管理”选项卡中成功上传了文件。

如果您希望导入不同格式的数据集，必须将数据集保存为与 Huggingface 数据集兼容的格式（见：<https://huggingface.co/docs/datasets/repository_structure>, <https://huggingface.co/docs/datasets/create_dataset>）。然后，修改数据集库中的 `README.md` 文件，以提供数据集的元数据描述。例如：

<details>

<summary>示例 README.md</summary>

```
---
task_categories:
  - text-classification
  - text-generation
dataset_info:
  config_name: default
  features:
    - name: instruction
      dtype: string
    - name: input
      dtype: string
    - name: output
      dtype: string
    - name: system
      dtype: string
configs:
- config_name: default
  data_files:
  - split: train
    path: "identity_alauda.jsonl"
---
 
Alauda Identity dataset for instruction fine tunning.
```

</details>

其中：

- `task_categories`：指定此数据集的微调和训练任务类型。
- `dataset_info`：配置数据集的特征列、标签列和其他信息。
- `configs`：配置一个或多个“configs”。每个配置指定在使用该配置时数据集的切片方式和其他信息。

> **注意：** 数据集格式必须被微调框架正确识别和读取，以便在后续微调任务中使用。以下示例说明了两种常见的 LLM 微调数据集格式：

#### Huggingface 数据集格式

您可以使用以下代码检查数据集目录格式是否可以被 `datasets` 正确加载：

```python
import datasets

ds_infos = datasets.get_dataset_infos(<dataset directory>)
ds = datasets.load_dataset(<dataset directory>）
print(ds_infos)
print(ds)
```

#### LLaMA-Factory 格式

如果您在示例中使用 LLaMA-Factory 工具完成训练，则数据集格式必须符合 LLaMA-Factory 格式。参考：<https://llamafactory.readthedocs.io/en/latest/getting_started/data_preparation.html>

### 准备微调训练运行时镜像

使用以下 `Dockerfile` 构建训练镜像。如果您希望使用不同的训练框架，例如 YOLOv5，可能需要自定义镜像并在其中安装所需的依赖项。

构建镜像后，您需要将其上传到 Alauda AI 平台集群的 Docker 注册表，并在后续任务中进行配置。

> **注意：** 镜像内需要使用 `git lfs` 命令来下载和上传模型和数据集文件。

<details>

<summary>Dockerfile</summary>

```dockerfile
FROM nvcr.io/nvidia/pytorch:24.12-py3

RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.ustc.edu.cn@g' /etc/apt/sources.list && \
sed -i 's/security.ubuntu.com/mirrors.ustc.edu.cn/g' /etc/apt/sources.list && \
apt-get update && \
export DEBIAN_FRONTEND=noninteractive && \
apt-get install -yq --no-install-recommends git git-lfs unzip curl ffmpeg && \
apt clean && rm -rf /var/lib/apt/lists/*

RUN cd /opt && \
git clone --depth 1 https://github.com/hiyouga/LLaMA-Factory.git && \
cd LLaMA-Factory && \
pip install --no-cache-dir -e ".[torch,metrics,deepspeed,awq,modelscope]" -i https://pypi.tuna.tsinghua.edu.cn/simple && \
pip install --no-cache-dir "transformers==4.51.1" "tokenizers==0.21.1" -i https://pypi.tuna.tsinghua.edu.cn/simple

RUN apt-get update && apt-get install -y default-libmysqlclient-dev build-essential pkg-config && \
pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -U pip setuptools && \
pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple \
"sqlalchemy==2.0.30" "pymysql==1.1.1" "loguru==0.7.2" "mysqlclient==2.2.7" "mlflow"
WORKDIR /opt
```

</details>

### 创建并微调 VolcanoJob 任务

在 Notebook 中，创建任务提交的 YAML 文件。参考以下示例：

<details>

<summary>VolcanoJob YAML 文件</summary>

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  generateName: vcjob-sft-qwen3-
spec:
  minAvailable: 1
  schedulerName: volcano
  maxRetry: 1
  queue: default
  volumes:
    # 任务运行的工作区 PVC（临时 PVC）
    - mountPath: "/mnt/workspace"
      volumeClaim:
        accessModes: [ "ReadWriteOnce" ]
        storageClassName: "sc-topolvm"
        resources:
          requests:
            storage: 5Gi
  tasks:
    - name: "train"
      # 并行副本的数量。对于分布式训练任务，您可以指定副本 > 2
      replicas: 1
      template:
        metadata:
          name: train
        spec:
          restartPolicy: Never
          # 挂载 shm 设备以提供多卡通信所需的共享内存空间。
          volumes:
            - emptyDir:
                medium: Memory
                # 在这里您可以调整共享内存的大小
                sizeLimit: 2Gi
              name: dshm
            # 存储模型和数据集的 PVC。
            # 在分布式训练任务中（副本 >= 2），确保使用适当的存储类型来缓存大型模型：
            # 1. 网络存储，例如 NFS 或 Ceph：只需挂载网络存储。请注意，多个容器可能同时访问此网络存储，导致高并发流量。此外，读取大型模型文件的速度可能比本地读取慢（取决于网络存储的性能）。
            # 2. 本地存储，例如 topolvm 或 local-storage：在挂载此 PVC 之前，使用 `kserve local model cache` 在每个节点上预缓存模型文件。训练任务无法缓存每个本地 PVC。
            - name: models-cache
              persistentVolumeClaim:
                claimName: sft-qwen3-volume
          initContainers:
            - name: prepare
              image: 152-231-registry.alauda.cn:60070/mlops/finetune-runtime:v0.0.0-fix.38.11.g5f759a05-add-trainer-img
              imagePullPolicy: IfNotPresent
              env:
              # 将 BASE_MODEL_URL 更改为基础模型地址，将 DATASET_URL 更改为数据集地址
              - name: BASE_MODEL_URL
                value: "https://aml-gitlab.alaudatech.net/kubeflow-admin-cpaas-io/amlmodels/Qwen3-0.6B"
              - name: DATASET_URL
                value: "https://aml-gitlab.alaudatech.net/kubeflow-admin-cpaas-io/amlmodels/wy-sft-dataset"
              - name: GIT_USER
                valueFrom:
                  secretKeyRef:
                    name: aml-image-builder-secret
                    key: MODEL_REPO_GIT_USER
              - name: GIT_TOKEN
                valueFrom:
                  secretKeyRef:
                    name: aml-image-builder-secret
                    key: MODEL_REPO_GIT_TOKEN
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 2
                  memory: 4Gi
              volumeMounts:
                - name: models-cache
                  mountPath: /mnt/models
              command:
              - /bin/bash
              - -c
              - |
                set -ex
                cd /mnt/models
                BASE_MODEL_NAME=$(basename ${BASE_MODEL_URL})
                # 下载基础模型
                gitauth="${GIT_USER}:${GIT_TOKEN}"
                BASE_MODEL_URL_NO_HTTPS="${BASE_MODEL_URL//https:\/\/}"
                if [ -d ${BASE_MODEL_NAME} ]; then
                    echo "${BASE_MODEL_NAME} dir already exists, skip downloading"
                    (cd ${BASE_MODEL_NAME} && git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull)
                else
                    GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone "https://${gitauth}@${BASE_MODEL_URL_NO_HTTPS}"
                    (cd ${BASE_MODEL_NAME} && git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull)
                fi
                # 下载数据集
                DATASET_NAME=$(basename ${DATASET_URL})
                DATASET_URL_NO_HTTPS="${DATASET_URL//https:\/\/}"
 
                rm -rf ${DATASET_NAME}
                rm -rf data
                 
                if [ -d ${DATASET_NAME} ]; then
                    echo "dataset ${DATASET_NAME} already exists skipping download"
                else
                    git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone "https://${gitauth}@${DATASET_URL_NO_HTTPS}"
                fi
                echo "listing files under /mnt/models ..."
                ls /mnt/models
                echo "listing model files ..."
                ls ${BASE_MODEL_NAME}
                echo "listing dataset files ..."
                ls ${DATASET_NAME}
          containers:
            # 运行环境镜像。您可以参考 src/llm/Dockerfile 构建类似的镜像。通常包括 cuda、transformers、pytorch、datasets、evaluate 和 git lfs 等运行时。
            - image: 152-231-registry.alauda.cn:60070/mlops/finetune-runtime:v0.0.0-fix.38.11.g5f759a05-add-trainer-img
              imagePullPolicy: IfNotPresent
              name: train
              volumeMounts:
                - mountPath: /dev/shm
                  name: dshm
                - name: models-cache
                  mountPath: /mnt/models
              env:
                # 将 BASE_MODEL_URL 更改为基础模型地址，将 DATASET_URL 更改为数据集地址，将 OUTPUT_MODEL_URL 更改为输出模型地址
                - name: BASE_MODEL_URL
                  value: "https://aml-gitlab.alaudatech.net/kubeflow-admin-cpaas-io/amlmodels/Qwen3-0.6B"
                - name: DATASET_URL
                  value: "https://aml-gitlab.alaudatech.net/kubeflow-admin-cpaas-io/amlmodels/wy-sft-dataset"
                - name: OUTPUT_MODEL_URL
                  value: "https://aml-gitlab.alaudatech.net/kubeflow-admin-cpaas-io/amlmodels/wy-sft-output"
                - name: GIT_USER
                  valueFrom:
                    secretKeyRef:
                      name: aml-image-builder-secret
                      key: MODEL_REPO_GIT_USER
                - name: GIT_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: aml-image-builder-secret
                      key: MODEL_REPO_GIT_TOKEN
                - name: MLFLOW_TRACKING_URI
                  value: "http://mlflow-tracking-server.aml-system.svc.cluster.local:5000"
                - name: MLFLOW_EXPERIMENT_NAME
                  value: kubeflow-admin-cpaas-io
              command:
              - bash
              - -c
              - |
                set -ex
                echo "job workers list: ${VC_WORKER_HOSTS}"
                if [ "${VC_WORKER_HOSTS}" != "" ]; then
                    export N_RANKS=$(echo "${VC_WORKER_HOSTS}" |awk -F',' '{print NF}')
                    export RANK=$VC_TASK_INDEX
                    export MASTER_HOST=$(echo "${VC_WORKER_HOSTS}" |awk -F',' '{print $1}')
                    export RANK=$RANK
                    export WORLD_SIZE=$N_RANKS
                    export NNODES=$N_RANKS
                    export NODE_RANK=$RANK
                    export MASTER_ADDR=${MASTER_HOST}
                    export MASTER_PORT="8888"
                else
                    export N_RANKS=1
                    export RANK=0
                    export MASTER_HOST=""
                fi
 
                cd /mnt/workspace
                BASE_MODEL_NAME=$(basename ${BASE_MODEL_URL})
                DATASET_NAME=$(basename ${DATASET_URL})
 
                cat >lf-sft.yaml <<EOL
                model_name_or_path: /mnt/models/${BASE_MODEL_NAME}
   
                stage: sft
                do_train: true
                finetuning_type: lora
                lora_target: all
                lora_rank: 8
                lora_alpha: 16
                lora_dropout: 0.1
   
                dataset: identity_alauda
                dataset_dir: /mnt/models/${DATASET_NAME}
                template: qwen
                cutoff_len: 1024
                max_samples: 1000
                overwrite_cache: true
                preprocessing_num_workers: 8
   
                output_dir: output_models
                logging_steps: 10
                save_steps: 500
                plot_loss: true
                overwrite_output_dir: true
   
                # global batch size: 8
                per_device_train_batch_size: 2
                gradient_accumulation_steps: 2
                learning_rate: 2.0e-4
                num_train_epochs: 4.0
                bf16: false
                fp16: true
                ddp_timeout: 180000000
   
                val_size: 0.1
                per_device_eval_batch_size: 1
                eval_strategy: steps
                eval_steps: 500
                report_to: mlflow
                EOL
 
                # 运行训练
                if [ "${NNODES}" -gt 1 ]; then
                    echo "deepspeed: ds-z3-config.json" >> lf-sft.yaml
                    FORCE_TORCHRUN=1 llamafactory-cli train lf-sft.yaml
                else
                    unset NNODES
                    unset NODE_RANK
                    unset MASTER_ADDR
                    unset MASTER_PORT
                    llamafactory-cli train lf-sft.yaml
                fi
 
                # 合并 LoRA 适配器
                cat >lf-merge-config.yaml <<EOL
                model_name_or_path: /mnt/models/${BASE_MODEL_NAME}
                adapter_name_or_path: output_models
                template: qwen
                finetuning_type: lora
   
                ### export
                export_dir: output_models_merged
                export_size: 4
                export_device: cpu
                export_legacy_format: false
                EOL
                   
                llamafactory-cli export lf-merge-config.yaml
                # 将合并后的模型推送到模型库
                gitauth="${GIT_USER}:${GIT_TOKEN}"
                cd /mnt/workspace/output_models_merged
                OUTPUT_MODEL_NO_HTTPS="${OUTPUT_MODEL_URL//https:\/\/}"
                PUSH_URL="https://${gitauth}@${OUTPUT_MODEL_NO_HTTPS}"
                push_branch=$(date +'%Y%m%d-%H%M%S')
 
                git init
                git checkout -b sft-${push_branch}
                git lfs track *.safetensors
                git add .
                git -c user.name='AMLSystemUser' -c user.email='aml_admin@cpaas.io' commit -am "fine tune push auto commit"
                git -c http.sslVerify=false -c lfs.activitytimeout=36000 push -u ${PUSH_URL} sft-${push_branch}
              resources:
                # 确保有足够的资源来运行微调。如果需要 GPU，请申请相应的 GPU/vGPU 资源。
                requests:
                  cpu: "1"
                  memory: "8Gi"
                limits:
                  cpu: "8"
                  memory: "16Gi"
                  nvidia.com/gpualloc: "1"
                  nvidia.com/gpucores: "50"
                  nvidia.com/gpumem: "8192"
```

</details>

在上述任务的 YAML 文件中，修改以下内容以正确提交任务：

1. 任务镜像：包含任务执行所需的依赖项。
2. 任务的原始模型、数据集和输出模型的位置：
3. `BASE_MODEL_URL`：更改为准备好的模型的 Git URL。
4. `DATASET_URL`：更改为准备好的数据集 `identity-alauda` 的 Git URL。
5. `OUTPUT_MODEL_URL`：在模型库中创建一个空模型以存储输出模型，然后输入该模型的 Git URL。
6. 任务所需的资源，包括：
7. 工作区中的 PVC：用于存储原始模型（如果正在进行训练，则不需要原始模型/预训练模型）、数据集和训练检查点。
   1. 手动指定 PVC：任务执行后，PVC 被保留。如果您希望保留工作区并在下一个任务中重用原始模型、验证检查点等，这种方法很有用。
   2. 临时 PVC：任务执行后，PVC 会自动删除以释放空间。
8. 共享内存：对于多 GPU/分布式训练任务，建议分配至少 4 Gi 的共享内存。
9. 任务所需的 CPU、内存和 GPU 资源（基于集群中部署的 GPU 设备插件）。
10. 任务执行脚本：
11. 上述示例脚本包括从模型库缓存模型到 PVC、将训练数据集缓存到 PVC，以及微调后将模型推送到新的模型库。如果您需要修改执行脚本，也可以包含这些步骤。
12. 示例脚本使用 `LLaMA-Factory` 工具启动微调任务，可以处理大多数 LLM 微调训练场景。
13. 任务超参数：在上述示例中，任务超参数直接在启动脚本中定义。您也可以使用环境变量读取可能反复调整的超参数，使得多次运行和配置更容易。

完成配置后，在 Notebook 中打开终端并执行：`kubectl create -f vcjob_sft.yaml` 将 `VolcanoJob` 任务提交到集群。

### 查看和管理任务状态

在 Notebook 终端中

1. 运行 `kubectl get vcjob` 查看任务列表，然后运行 `kubectl get vcjob <task name>` 查看 `VolcanoJob` 任务的状态。
2. 运行 `kubectl get pod` 查看 pod 状态，运行 `kubectl logs <pod name>` 查看任务日志。请注意，对于分布式任务，可能存在多个 pod。
3. 如果 pod 未创建，运行 `kubectl describe vcjob <task name>` 或 `kubectl get podgroups` 查看 Volcano podgroup。您还可以检查 `Volcano` 调度信息，以确定调度问题是否由于资源不足、无法挂载 PVC 或其他调度问题。
4. 任务成功执行后，微调后的模型将自动推送到模型库。请注意，任务将根据时间自动生成一个用于推送的仓库分支。在使用输出模型时，请确保选择正确的版本。

运行 `kubectl delete vcjob <task name>` 删除任务。

### 实验跟踪与比较

在上述微调示例任务中，我们使用 LLaMA-Factory 工具启动微调任务，并在任务配置中添加了 `report_to: mlflow`。这将自动将训练指标输出到 mlflow 服务器。任务完成后，我们可以在 Alauda AI - “高级” - “MLFlow” 下找到实验跟踪记录，并比较多个执行。例如，我们可以比较多个实验的损失收敛情况。

### 使用微调后的模型启动推理服务

微调任务完成后，模型将自动推送到模型库。您可以使用微调后的模型启动推理服务并进行访问。

> **注意：** 在上述示例任务中，使用了 LoRA 部分微调方法。在上传模型之前，LoRA 适配器已与原始模型合并。这允许输出模型直接发布到推理服务。 \*\*\*如果仅有 LoRA 适配器，当前平台不支持直接发布。 \*\*\*

具体步骤如下：

1. 转到 AI > 模型库，找到微调后的输出模型，转到模型详情 > 文件管理 > 修改源数据，选择“文本分类”作为任务类型，选择“Transformers”作为框架。
2. 完成第一步后，点击“发布推理服务”按钮。
3. 在发布推理服务页面，配置推理服务以使用 vllm 推理运行时（根据集群中支持的驱动程序选择 CUDA 版本），完成其他 PVC、资源、GPU 配置，然后点击“发布”。
4. 推理服务启动后，点击推理服务页面右上角的“体验”按钮，与模型进行对话。（注意：包含 `chat_template` 配置的模型仅具备对话能力。）

## 适应非 NVIDIA GPU

在使用非 NVIDIA GPU 环境时，您可以遵循以下常见步骤来微调模型、启动训练任务并在 AML Notebook 中管理它们。

> **注意：** 以下方法也可以重用于大型模型预训练和小型模型训练等场景。这些是将供应商解决方案转换为 Notebook + VolcanoJob 的通用步骤。

### 准备工作

1. 前提条件：供应商 GPU 驱动程序和 Kubernetes 设备插件已在集群中部署。设备可以在 Kubernetes 创建的 pod 内访问。
2. 注意：您需要知道供应商 GPU 资源名称和集群中设备资源的总数，以便于后续任务提交。
3. 例如，对于华为 NPU，您可以使用：`huawei.com/Ascend910:1` 申请 NPU 卡。
4. 获取供应商提供的解决方案文档和在当前供应商 GPU 上进行微调的材料。这通常包括：
5. **解决方案文档和步骤**。这可以在 Kubernetes 上或使用 Docker Run 在容器中完成。
6. **运行微调的镜像**。例如，供应商提供了使用 `LLaMA-Factory` 的微调解决方案和相应的 `LLaMA-Factory` 镜像（可能包含在镜像中）。
7. **运行微调的模型**。通常，供应商设备支持一系列模型。使用设备支持的模型或供应商解决方案中提供的模型。
8. **训练数据**。使用供应商解决方案文档中提供的示例数据，或以相同格式构建自己的数据集。
9. **任务启动命令和参数**。例如，`LLaMA-Factory` 框架微调解决方案使用 `llamafactory-cli` 命令启动微调任务，并在 YAML 文件中配置各种参数，包括任务超参数。

### 验证原始供应商解决方案（可选）

为了确保供应商解决方案的正确执行并减少后续故障排除，您可以首先完全按照供应商解决方案运行它，以验证其是否正常工作。

此步骤可以跳过。但是，如果后续任务执行出现问题，您可以返回此步骤以验证原始解决方案是否存在问题。

### 将供应商解决方案转换为 Kubernetes Job/Deployment 运行（可选）

如果供应商解决方案已经作为 Kubernetes job/deployment/pod 运行，则可以跳过此步骤。

如果供应商解决方案使用容器执行方法，例如 `docker run`，您可以首先使用简单的 Kubernetes job 验证该解决方案是否在部署了供应商设备插件的 Kubernetes 环境中正确运行。

> **注意：** 此步骤可以排除 Volcano job 无法调度供应商 GPU 设备的问题，因此可以单独验证。

参考：

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: custom-gpu-ft-job
spec:
  template:
    spec:
      containers:
      - name: train
        image: <供应商用于微调训练解决方案的镜像>
        command: ["任务启动命令", "参数 1", "参数 2"]
      restartPolicy: Never
  # 注意：如果是分布式任务，您还可以通过修改 parallelism、completions 指定分布式训练的并行性。
  completions: 1
  parallelism: 1
```

### 修改供应商解决方案以作为 Volcano job 运行

参考以下 YAML 定义

<details>

<summary>VolcanoJob YAML 文件</summary>

```yaml
apiVersion: batch.volcano.sh/v1alpha1
kind: Job
metadata:
  generateName: vcjob-sft-
spec:
  minAvailable: 1
  schedulerName: volcano
  maxRetry: 1
  queue: default
  volumes:
    # 任务运行的工作区 PVC（临时 PVC）
    - mountPath: "/mnt/workspace"
      volumeClaim:
        accessModes: [ "ReadWriteOnce" ]
        storageClassName: "sc-topolvm"
        resources:
          requests:
            storage: 5Gi
  tasks:
    - name: "train"
      # 并行副本的数量。对于分布式训练任务，您可以指定副本 >= 2
      replicas: 1
      template:
        metadata:
          name: train
        spec:
          restartPolicy: Never
          # 挂载 shm 设备以提供多卡通信所需的共享内存空间。
          volumes:
            - emptyDir:
                medium: Memory
                # 在这里您可以调整共享内存的大小
                sizeLimit: 2Gi
              name: dshm
            # 存储模型和数据集的 PVC。
            # 在分布式训练任务中（副本 >= 2），确保使用适当的存储类型来缓存大型模型：
            # 1. 网络存储，例如 NFS 或 Ceph：只需挂载网络存储。请注意，多个容器可能同时访问此网络存储，导致高并发流量。此外，读取大型模型文件的速度可能比本地读取慢（取决于网络存储的性能）。
            # 2. 本地存储，例如 topolvm 或 local-storage：在挂载此 PVC 之前，使用 `kserve local model cache` 在每个节点上预缓存模型文件。训练任务无法缓存每个本地 PVC。
            - name: models-cache
              persistentVolumeClaim:
                claimName: sft-qwen3-volume
          containers:
            # 运行环境镜像。
            - image: <指定供应商解决方案使用的镜像或现场自定义的镜像>
              imagePullPolicy: IfNotPresent
              name: train
              volumeMounts:
                - mountPath: /dev/shm
                  name: dshm
                - name: models-cache
                  mountPath: /mnt/models
              env:
                - name: MLFLOW_TRACKING_URI
                  value: "http://mlflow-tracking-server.aml-system.svc.cluster.local:5000"
                - name: MLFLOW_EXPERIMENT_NAME
                  value: kubeflow-admin-cpaas-io
              command:
              - bash
              - -c
              - |
                set -ex
                echo "job workers list: ${VC_WORKER_HOSTS}"
                # 在下面添加启动任务的命令行
                # ...
              resources:
                # 确保有足够的资源来运行微调。如果 GPU 是必需的，请申请相应的 GPU/vGPU 资源。
                requests:
                  cpu: "1"
                  memory: "8Gi"
                limits:
                  cpu: "8"
                  memory: "16Gi"
                  nvidia.com/gpualloc: "1"
                  nvidia.com/gpucores: "50"
                  nvidia.com/gpumem: "8192"
```

</details>

### 实验跟踪与比较

一些微调/训练框架会自动记录实验进度到各种实验跟踪服务。例如，LLaMA-Factory 和 Transformers 框架可以指定将实验进度记录到 mlflow 和 wandb 等服务。根据您的部署，您可以配置以下环境变量：

- `MLFLOW_TRACKING_URI`：mlflow 跟踪服务器的 URL。
- `MLFLOW_EXPERIMENT_NAME`：实验名称，通常使用命名空间名称。这区分了一组任务。

框架还指定了记录目的地。例如，`LLaMA-Factory` 需要在任务参数配置 YAML 文件中指定 `report_to: mlflow`。

训练任务开始后，您可以在 Alauda AI - “高级” - MLFlow 界面中找到相应的任务，并查看“指标”中的每个记录指标的曲线或每次执行的参数配置。您还可以比较多个实验。

## 总结

使用 Alauda AI Notebook 开发环境，您可以快速使用 YAML 和命令行工具将微调和训练任务提交到集群，并管理这些任务的执行状态。这种方法使您能够快速开发和定制模型微调和训练步骤，实现 LLM SFT、偏好对齐、传统模型训练和多个实验比较等操作。
