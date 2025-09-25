# Alauda AI 1.3 (AML 1.3) Notebook Model Fine-tuning and Training General Solution

## Background

Model fine-tuning and training often require adapting to different model structures, hardware devices, and appropriate parallel training methods. Alauda AI Notebook provides a comprehensive approach, from model development to training task submission and management, and experiment tracking, helping model and algorithm engineers quickly adapt and complete the entire model fine-tuning and training process.

Alauda AI Notebook creates a Notebook/VSCode (CodeServer) container environment for development and debugging in a user namespace. Multiple Notebook/VSCode instances can be created within a namespace to preserve environments for different users and development tasks. Notebooks can request only CPU resources for development and cluster task submission, using the cluster's GPU resources to run tasks. GPU resources can also be requested for Notebooks, allowing tasks such as training and fine-tuning to be completed directly within the Notebook, regardless of the distributed model.

In addition, you can use the platform's built-in `MLFlow` to record various metrics for each model fine-tuning training session, making it easier to compare multiple experiments and select the final model.

We use [VolcanoJob](https://volcano.sh/en/docs/vcjob/), the Kubernetes-native resource manager, to submit cluster tasks using Notebooks. The Volcano scheduler supports queues, priorities, and various scheduling policies, facilitating more efficient cluster task scheduling and improving resource utilization.

This solution uses the [LLaMA-Factory](https://github.com/hiyouga/LLaMA-Factory) tool to launch fine-tuning and training tasks. However, for larger-scale model fine-tuning and training scenarios requiring parallel methods like Tensor Parallelism, Context Parallelism, and Expert Parallelism to train larger models, it may be necessary to use other tools, build custom fine-tuning runtime images, and modify the task launch script to adapt to different tools and models. For more detailed LLaMA-Factory usage and parameter configuration, please refer to: [https://llamafactory.readthedocs.io/en/latest/index.html](https://llamafactory.readthedocs.io/en/latest/index.html)

## Scope

* This solution is applicable to Alauda AI 1.3 (AML 1.3) and later.
* This solution is applicable to x86/64 CPU and NVIDIA GPU scenarios.
* Fine-tuning and training of LLM models. If you need to train other types of models (such as Yolov5), you will need to use different images, startup scripts, datasets, etc.
* NPU scenarios require building a suitable runtime image based on this solution to be compatible.

## Preparation

* You must first deploy the Kubeflow plugin to enable Notebook support.
* Turn on the "experimental" feature, or install `MLFlow` plugin.

## LLM Model Fine-tuning Steps

### Creating a Notebook/VSCode Instance

From the navigation bar, go to Advanced - Notebook and create or apply an existing Notebook. Note that it is recommended that the Notebook only use CPU resources. Submitting a cluster task from within the Notebook will request GPU resources within the cluster to improve resource utilization.

* Click "New Notebook" to enter the creation page.
* Configure the Notebook instance:
  * Name
  * Image: You can start directly using the built-in Notebook image. You can also build a custom image based on the base Notebook image provided by Alauda. Select "Custom Image" and enter the image address.
  * Container CPU and memory requirements. Expand "Advanced Options" to configure higher CPU and memory limits.
  * GPU: Select the GPU resources to use. You can specify a full GPU or virtual GPU solution.
  * Workspace Volume: The default storage volume (PVC) used for the Notebook directory. If not specified, a storage volume is automatically created for the current notebook. You can also click the drop-down button to configure the storage volume information.
  * Data Volume: Mount one or more additional storage volumes within the Notebook. For example, if your dataset or model is stored on another storage volume, you can mount additional volumes.
  * Configuration Item: You can leave this option unselected.
  * Shared Memory: Enable this option if you want to use features such as multi-GPU communication within the Notebook. Otherwise, do not enable it.

### Preparing the Model

Refer to the Alauda AI online documentation for detailed steps on how to upload a model using the notebook.

### Preparing the Model Output Location

Create an empty model in the model repository to store the output model. When configuring the fine-tuning output location, enter the model's Git repository URL.

### Preparing the Dataset

Push the sample identity dataset: [identity-alauda-main.zip](../../assets/identity-alauda-main.zip) to the dataset repository. This dataset is used to fine-tune the LLM to answer user questions such as "Who are you?"

1. First, create an empty dataset repository under "Datasets" - "Dataset Repository".
2. Upload the zip file to the notebook, unzip it, then navigate to the dataset directory. Use git lfs to push the dataset to the dataset repository's Git URL. The steps are similar to uploading the model. For details, refer to the Alauda AI online documentation.
3. After the push is complete, refresh the dataset page and you should see that the file has been successfully uploaded in the "File Management" tab.

If you wish to import a dataset in a different format, you must save the dataset in a format compatible with Huggingface datasets (see: [https://huggingface.co/docs/datasets/repository_structure](https://huggingface.co/docs/datasets/repository_structure), [https://huggingface.co/docs/datasets/create_dataset](https://huggingface.co/docs/datasets/create_dataset)). Then, modify the `README.md` file in the dataset repository to provide a metadata description for the dataset. For example:


<details>

<summary>Sample README.md</summary>

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

Among them:

* `task_categories`: Specifies the fine-tuning and training task types for this dataset.
* `dataset_info`: Configures the dataset's feature columns, label columns, and other information.
* `configs`: Configures one or more "configs." Each configuration specifies how the dataset is sliced ​​and other information when using that configuration.

> **Note:** The dataset format must be correctly recognized and read by the fine-tuning framework to be used in subsequent fine-tuning tasks. The following examples illustrate two common LLM fine-tuning dataset formats:

#### Huggingface dataset format

You can use the following code to check whether the dataset directory format can be correctly loaded by `datasets`:

```python
import datasets

ds_infos = datasets.get_dataset_infos(<dataset directory>)
ds = datasets.load_dataset(<dataset directory>）
print(ds_infos)
print(ds)
```

#### LLaMA-Factory Format

If you use the LLaMA-Factory tool in the examples to complete training, the dataset format must conform to the LLaMA-Factory format. Reference: [https://llamafactory.readthedocs.io/en/latest/getting_started/data_preparation.html](https://llamafactory.readthedocs.io/en/latest/getting_started/data_preparation.html)


### Prepare to Fine-tune the Training Runtime Image

Use the following `Dockerfile` to build the training image. If you wish to use a different training framework, such as YOLOv5, you may need to customize the image and install the required dependencies within it.

After building the image, you need to upload it to the Docker registry of the Alauda AI platform cluster and configure it in the following tasks.

> **Note:** The `git lfs` command is required within the image to download and upload the model and dataset files.

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

### Creating and Fine-tuning the VolcanoJob Task

In Notebook, create the YAML file for the task submission. Refer to the following example:

<details>

<summary>VolcanoJob YAML File</summary>

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
    # The workspace PVC where the task runs (temporary PVC)
    - mountPath: "/mnt/workspace"
      volumeClaim:
        accessModes: [ "ReadWriteOnce" ]
        storageClassName: "sc-topolvm"
        resources:
          requests:
            storage: 5Gi
  tasks:
    - name: "train"
      # The number of parallel replicas. For distributed training tasks, you can specify replicas > 2
      replicas: 1
      template:
        metadata:
          name: train
        spec:
          restartPolicy: Never
          # Mount the shm device to provide the shared memory space required for multi-card communication.
          volumes:
            - emptyDir:
                medium: Memory
                # Here you can adjust the size of the shared memory used
                sizeLimit: 2Gi
              name: dshm
            # PVC for storing models and datasets.
            # In distributed training tasks (with >= 2 replicas), ensure that you use the appropriate storage type for caching large models:
            # 1. Network storage, such as NFS or Ceph: Simply mount the network storage. Note that multiple containers may access this network storage simultaneously, resulting in high concurrent traffic. Furthermore, reading large model files may be slower than reading them locally (depending on the network storage's performance).
            # 2. Local storage, such as topolvm or local-storage: Use `kserve local model cache` to pre-cache the model file on each node before mounting this PVC. Training tasks cannot cache each local PVC.
            - name: models-cache
              persistentVolumeClaim:
                claimName: sft-qwen3-volume
          initContainers:
            - name: prepare
              image: 152-231-registry.alauda.cn:60070/mlops/finetune-runtime:v0.0.0-fix.38.11.g5f759a05-add-trainer-img
              imagePullPolicy: IfNotPresent
              env:
              # Change BASE_MODEL_URL to the base model address, DATASET_URL to the dataset address
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
                # Download base model
                gitauth="${GIT_USER}:${GIT_TOKEN}"
                BASE_MODEL_URL_NO_HTTPS="${BASE_MODEL_URL//https:\/\/}"
                if [ -d ${BASE_MODEL_NAME} ]; then
                    echo "${BASE_MODEL_NAME} dir already exists, skip downloading"
                    (cd ${BASE_MODEL_NAME} && git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull)
                else
                    GIT_LFS_SKIP_SMUDGE=1 git -c http.sslVerify=false -c lfs.activitytimeout=36000 clone "https://${gitauth}@${BASE_MODEL_URL_NO_HTTPS}"
                    (cd ${BASE_MODEL_NAME} && git -c http.sslVerify=false -c lfs.activitytimeout=36000 lfs pull)
                fi
                # Download dataset
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
            # Runtime environment image. You can refer to src/llm/Dockerfile to build a similar image. This typically includes runtimes such as cuda, transformers, pytorch, datasets, evaluate, and git lfs.
            - image: 152-231-registry.alauda.cn:60070/mlops/finetune-runtime:v0.0.0-fix.38.11.g5f759a05-add-trainer-img
              imagePullPolicy: IfNotPresent
              name: train
              volumeMounts:
                - mountPath: /dev/shm
                  name: dshm
                - name: models-cache
                  mountPath: /mnt/models
              env:
                # Modify BASE_MODEL_URL to the base model address, DATASET_URL to the dataset address, and OUTPUT_MODEL_URL to the output model address
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
 
                # Run training
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
 
                # Merge LoRA adapters
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
                # push merged model to model repo
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
                # Ensure that there are sufficient resources to run fine tuning. If GPU is required, apply for the corresponding GPU/vGPU resources.
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

In the YAML file for the above task, modify the following content to correctly submit the task in the environment.

1. Task image: Contains the dependencies required for task execution.
2. Locations of the original model, dataset, and output model for the task:
  1. `BASE_MODEL_URL`: Change to the Git URL of the prepared model.
  2. `DATASET_URL`: Change to the Git URL of the prepared dataset `identity-alauda`.
  3. `OUTPUT_MODEL_URL`: Create an empty model in the model repository to store the output model, and then enter the Git URL of this model.
3. Required resources for the task, including:
  1. PVC in the workspace: This is used to store the original model (if training is being performed, the original model/pretrained model is not required), the dataset, and training checkpoints.
    1. Manually specifying a PVC: After the task is executed, the PVC is retained. This method is useful if you want to retain the workspace and reuse the original model in the next task, verify checkpoints, and so on.
    2. Temporary PVC: After the task is executed, the PVC is automatically deleted to free up space.
  2. Shared Memory: For multi-GPU/distributed training tasks, it is recommended to allocate at least 4 Gi of shared memory.
  3. CPU, memory, and GPU resources required for the task (based on the GPU device plugin deployed in the cluster).
4. Task Execution Script:
  1. The example script above includes caching the model from the model repository to the PVC, caching the training dataset to the PVC, and pushing the model to the new model repository after fine-tuning. If you need to modify the execution script, you can also include these steps.
  2. The example script uses the `LLaMA-Factory` tool to launch the fine-tuning task, which can handle most LLM fine-tuning training scenarios.
5. Task Hyperparameters: In the example above, the task hyperparameters are defined directly in the startup script. You can also use environment variables to read hyperparameters that may be adjusted repeatedly, making it easier to run and configure multiple times.

After completing the configuration, open a terminal in Notebook and execute: `kubectl create -f vcjob_sft.yaml` to submit the `VolcanoJob` task to the cluster.

### Viewing and Managing Task Status

In the Notebook terminal

1. Run `kubectl get vcjob` to view the task list, then `kubectl get vcjob <task name>` to view the status of the `VolcanoJob` task.
2. Run `kubectl get pod` to view the pod status, and `kubectl logs <pod name>` to view the task logs. Note that for distributed tasks, multiple pods may exist.
3. If the pod is not created, run `kubectl describe vcjob <task name>` or `kubectl get podgroups` to view the Volcano podgroup. You can also check the `Volcano` scheduling information to determine if the scheduling issue is due to insufficient resources, an inability to mount a PVC, or other scheduling issues.
4. After the task successfully executes, the fine-tuned model will be automatically pushed to the model repository. Note that the task will automatically generate a repository branch for push based on the time. When using the output model, be sure to select the correct version.

Run `kubectl delete vcjob <task name>` to delete the task.

### Experiment Tracking and Comparison

In the fine-tuning example task above, we used the LLaMA-Factory tool to launch the fine-tuning task and added `report_to: mlflow` to the task configuration. This automatically outputs training metrics to the mlflow server. After the task completes, we can find the experiment tracking records under Alauda AI - "Advanced" - "MLFlow" and compare multiple executions. For example, we can compare the loss convergence of multiple experiments.

### Launching the Inference Service Using the Fine-tuned Model

After the fine-tuning task completes, the model is automatically pushed to the model repository. You can use the fine-tuned model to launch the inference service and access it.

> **Note:** In the example task above, the LoRA partial fine-tuning method was used. Before uploading the model, the LoRA adapter was merged with the original model. This allows the output model to be directly published to the inference service. ***Direct publishing is not currently supported on the platform if only the LoRA adapter is available. ***

The specific steps are as follows:

1. Go to AI > Model Repository, find the fine-tuned output model, go to Model Details > File Management > Modify Source Data, select "Text Classification" for Task Type, and "Transformers" for Framework.
2. After completing the first step, click the "Publish Inference Service" button.
3. On the Publish Inference Service page, configure the inference service to use the vllm inference runtime (select the CUDA version based on the supported drivers in the cluster), complete other PVC, resource, GPU configurations, and click "Publish."
4. After the inference service starts, click the "Experience" button in the upper-right corner of the inference service page to experience a conversation with the model. (Note: Models that include the `chat_template` configuration only have conversational capabilities.)

## Adapt Non-Nvidia GPUs

When using a non-Nvidia GPU environment, you can follow the common steps below to fine-tune models, launch training tasks, and manage them in AML Notebook.

> **Note:** The following methods can also be reused for scenarios such as large model pre-training and small model training. These are general steps for converting a vendor solution to Notebook + VolcanoJob.

### Preparation

1. Prerequisite: The vendor GPU driver and Kubernetes device plugin have been deployed in the cluster. The devices can be accessed within the pod created by Kubernetes.
  1. Note: You will need to know the vendor GPU resource name and the total number of device resources in the cluster to facilitate subsequent task submission.
  2. For example, for Huawei NPUs, you can apply for an NPU card using: `huawei.com/Ascend910:1`.
2. Obtain the vendor-provided solution documentation and materials for fine-tuning on the current vendor's GPU. This typically includes:
  1. **Solution documentation and steps**. This can be done on Kubernetes or in a container using Docker Run.
  2. **Image to run the fine-tuning**. For example, the vendor provides a fine-tuning solution using `LLaMA-Factory` and a corresponding `LLaMA-Factory` image (which may be included in the image).
  3. **Model to run the fine-tuning**. Typically, vendor devices support a range of models. Use models that the device supports or the models provided in the vendor solution.
  4. **Training data**. Use the sample data provided in the vendor solution documentation or construct your own dataset in the same format.
  5. **Task launch command and parameters**. For example, the `LLaMA-Factory` framework fine-tuning solution uses the `llamafactory-cli` command to launch the fine-tuning task and configure various parameters, including task hyperparameters, in a YAML file.


### Verifying the Original Vendor Solution (Optional)

To ensure the correct execution of the vendor solution and reduce subsequent troubleshooting, you can first run it completely according to the vendor solution to verify that it works correctly.

This step can be skipped. However, if issues with task execution arise later, you can return to this step to verify that the original solution is the problem.

### Converting the Vendor Solution to Run as a Kubernetes Job/Deployment (Optional)

If the vendor solution is already running as a Kubernetes job/deployment/pod, you can skip this step.

If the vendor solution uses a container execution method, such as `docker run`, you can first use a simple Kubernetes job to verify that the solution runs correctly in a Kubernetes environment where the vendor device plugin is deployed.

> **Note:** This step can rule out issues with volcano jobs being unable to schedule vendor GPU devices, so it can be verified separately.

Reference:

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
        image: <Image used by the vendor to fine-tune training solutions>
        command: ["Task start command", "Parameter 1", "Parameter 2"]
      restartPolicy: Never
  # Note: If it is a distributed task, you can also specify the parallelism of distributed training by modifying parallelism, completions.
  completions: 1
  parallelism: 1
```

### Modify the vendor solution to run as a volcano job

Refer to the following YAML definition

<details>

<summary>VolcanoJob YAML File</summary>

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
    # The workspace PVC where the task runs (temporary PVC)
    - mountPath: "/mnt/workspace"
      volumeClaim:
        accessModes: [ "ReadWriteOnce" ]
        storageClassName: "sc-topolvm"
        resources:
          requests:
            storage: 5Gi
  tasks:
    - name: "train"
      # The number of parallel replicas. For distributed training tasks, you can specify replicas >= 2
      replicas: 1
      template:
        metadata:
          name: train
        spec:
          restartPolicy: Never
          # Mount the shm device to provide the shared memory space required for multi-card communication.
          volumes:
            - emptyDir:
                medium: Memory
                # Here you can adjust the size of the shared memory used
                sizeLimit: 2Gi
              name: dshm
            # PVC for storing models and datasets.
            # In distributed training tasks (with >= 2 replicas), ensure that you use the appropriate storage type for caching large models:
            # 1. Network storage, such as NFS or Ceph: Simply mount the network storage. Note that multiple containers may access this network storage simultaneously, resulting in high concurrent traffic. Furthermore, reading large model files may be slower than reading them locally (depending on the network storage's performance).
            # 2. Local storage, such as topolvm or local-storage: Use `kserve local model cache` to pre-cache the model file on each node before mounting this PVC. Training tasks cannot cache each local PVC.
            - name: models-cache
              persistentVolumeClaim:
                claimName: sft-qwen3-volume
          containers:
            # Run the environment image.
            - image: <Specify the image used by the vendor's solution or customize the image on site>
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
                # add command lines to start the task below
                # ...
              resources:
                # Ensure that there are sufficient resources to run fine tuning. If GPU is required, apply for the corresponding GPU/vGPU resources.
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

### Experiment Tracking and Comparison

Some fine-tuning/training frameworks automatically record experiment progress to various experiment tracking services. For example, the LLaMA-Factory and Transformers frameworks can specify recording of experiment progress to services such as mlflow and wandb. Depending on your deployment, you can configure the following environment variables:

* `MLFLOW_TRACKING_URI`: The URL of the mlflow tracking server.
* `MLFLOW_EXPERIMENT_NAME`: The experiment name, typically using a namespace name. This distinguishes a group of tasks.

The framework also specifies the recording destination. For example, `LLaMA-Factory` requires specifying `report_to: mlflow` in the task parameter configuration YAML file.

After a training task begins, you can find the corresponding task in the Alauda AI - "Advanced" - MLFlow interface and view the curves of each recorded metric in "Metrics" or the parameter configuration for each execution. You can also compare multiple experiments.

## Summary

Using the Alauda AI Notebook development environment, you can quickly submit fine-tuning and training tasks to a cluster using YAML and command-line tools, and manage the execution status of these tasks. This approach allows you to quickly develop and customize model fine-tuning and training steps, enabling operations such as LLM SFT, preference alignment, traditional model training, and multiple experimental comparisons.