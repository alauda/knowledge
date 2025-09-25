---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 1.4
---

# Turn on experimental features in Alauda AI 1.4

> **NOTE:**
> Some of the plugins for Alauda AI only supports x86_64(amd64) CPU architecture, experimental features currently does not support other CPU archs like arm64.


## Prerequisites

* ACP and AML are already installed.
* Deploy ASM if ASM is not installed in above step.
* Prepare a running MySQL service. Note that the "Kubeflow Pipeline" plugin only supports MySQL version == 5.7, so you can choose from the following deployment methods:
  - **Option 1:** Use ACP Data Service to deploy  a MySQL MGR instance (MySQL version>=8.0), and use this service in the "AmlCluster" configuration below. The "Kubeflow Pipeline" can choose to use the builtin MySQL service( Kubeflow pipeline does NOT supports MySQL version >= 8.0) 
  - **Option 2:** Use ACP Data Service to deploy a MySQL PXC instance (MySQL version == 5.7), and use this service both in "AmlCluster" config and "Kubeflow Pipeline"
  - Connect to other existing MySQL services.
* Prepare a PostgreSQL service for MLFlow
* **Optional**: Prepare a MinIO object storage service for "Kubeflow Pipeline". Or you can choose to use the builtin single-instance MinIO service (do NOT support HA).


## Setup oauth2-proxy settings for istio:  

Run the below command in `global` cluser to get the CA cert first:

```bash
crt=$(kubectl get secret -n cpaas-system dex.tls -o jsonpath='{.data.tls\.crt}')
echo -n $crt | base64 -d
```

Goto "Administrator - Clusters - Resources", select `global` cluster in the upper header, then find and edit the resource "ServiceMesh", then add below contents under "spec" section (for servicemesh v2, please ask for help)

NOTE: If `spec.values.pilot.jwksResolverExtraRootCA` is already set when deploying other applications, you can setup `spec.meshConfig.extensionProviders` only for Kubeflow. Do **NOT** delete already existed configurations of `spec.meshConfig.extensionProviders`.

<details>

<summary>ServiceMesh</summary>

```yaml
overlays:
  - kind: IstioOperator
    patches:
      - path: spec.values.pilot.env.PILOT_JWT_PUB_KEY_REFRESH_INTERVAL
        value: 1m
      - path: spec.values.pilot.jwksResolverExtraRootCA
        value: |
          -----BEGIN CERTIFICATE-----
          MIIDKzCCAhOgAwIBAgIRAK9C9PuDXtYFvybudWQkN4UwDQYJKoZIhvcNAQELBQAw
          EDEOMAwGA1UEChMFY3BhYXMwHhcNMjUwMzEwMDkxODAzWhcNMzUwMzA4MDkxODAz
          WjASMRAwDgYDVQQKEwdrdWJlLWNhMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
          CgKCAQEAmChGjtwWOPvj0Ca3TkuPxxx6jg4oDTAPqyowT2pcaVeNhFwoMmCCkFXm
          7brFKXCc7IE1kHq5dbRCn+UwCA46g7zvz8b7SY/0qRymwTlYqRILDZacwWHUSJSD
          cDyK297V+Ig5oIno6fTa2FWSJBqyxqivZ3lzf1XpsiwSPPXol+LclUne0fDiM98C
          dBQWKDYadwlcluuPUHULthA3OjcKGpmyV7cyTHPcRjBSmkAmuL0bQhbWhkB8G9oe
          4cp2joo/qVsSzeUepkHeTD9PPk1AZ59FE8DDgL0FRREE7vou6g7fbOZL98pC4ldg
          ZIY/EB5v38uR6J25uzLPFSf75vbwHwIDAQABo34wfDAOBgNVHQ8BAf8EBAMCBaAw
          DAYDVR0TAQH/BAIwADAfBgNVHSMEGDAWgBQk8E8JWyAANbALLaeAxZ17adgq/TA7
          BgNVHREENDAyggVjcGFhc4ILZXhhbXBsZS5jb22HBH8AAAGHEAAAAAAAAAAAAAAA
          AAAAAAGHBMCoq/MwDQYJKoZIhvcNAQELBQADggEBAIXo0V2jMeRd4cw5p3FWoFno
          VWno7Cy7ENvVjgfQymcWbGi6fXWvkDBUPCmqv5bosUVyAOJ/p92g861nCAo3jxoZ
          voCTDN4xU+t0xs2hMTKHsSB7v3n18rBtqcVpUvm1it/NyeOU4HiYfPTPkRVugGf4
          gtYknrU6Skt9BkiNy+2Jcsb6V3mAJ5GQzbT0qPL1vKWkBB9oCbjMwJggsW+TdKgY
          KJuII0m6JNDUlKLCazLL8OvXq84Nu+cJ6QaNOT0gBRIWSPA+UbAsibbFnf0VOeeU
          WforZLredR6GKc2qMdKdcW4G+8fRSWcx0gEIRquoQH1P7yIEJ3xOGoxQfIRVpls=
          -----END CERTIFICATE-----
      - path: spec.meshConfig.extensionProviders
        value:
          envoyExtAuthzHttp:
            headersToDownstreamOnDeny:
              - content-type
              - set-cookie
            headersToUpstreamOnAllow:
              - authorization
              - path
              - x-auth-request-user
              - x-auth-request-email
              - x-auth-request-access-token
            includeAdditionalHeadersInCheck:
              X-Auth-Request-Redirect: http://%REQ(Host)%%REQ(:PATH)%
            includeRequestHeadersInCheck:
              - authorization
              - cookie
              - accept
            port: "80"
            service: oauth2-proxy.kubeflow-oauth2-proxy.svc.cluster.local
          name: oauth2-proxy-kubeflow
```

</details>

## Deploy plugins

Download the following plugin artifacts and push these plugins to ACP platform.

* Workspace: Backend controller of AML workspace.
  * NOTE: package will be uploaded later.
* KubeflowBase: Base components of Kubeflow. After installing this plugin, a "Kubeflow" menu entry should appear in AML nav bar.
  * [http://package-minio.alauda.cn:9199/packages/kfbase/v1.10/kfbase.amd64.v1.10.5.tgz](http://package-minio.alauda.cn:9199/packages/kfbase/v1.10/kfbase.amd64.v1.10.5.tgz)
* Kubeflow Pipeline: Supports developing, running, monitoring kubeflow pipelines. ( Default using argo as kubeflow pipeline backend)
  * [http://package-minio.alauda.cn:9199/packages/kfp/v1.10/kfp.amd64.v1.10.5.tgz](http://package-minio.alauda.cn:9199/packages/kfp/v1.10/kfp.amd64.v1.10.5.tgz)
* Kubeflow Training Operator: Manager training jobs of various deep learning frameworks like PytorchJob, TensorflowJob, MPIJob
  * [http://package-minio.alauda.cn:9199/packages/kftraining/v1.10/kftraining.amd64.v1.10.5.tgz](http://package-minio.alauda.cn:9199/packages/kftraining/v1.10/kftraining.amd64.v1.10.5.tgz)
* MLFlow: MLFlow tracking server to track training experiments. After installing this plugin, a "MLFlow" menu entry should appear in AML nav bar.  
  * [http://package-minio.alauda.cn:9199/packages/mlflow/v3.1/mlflow.amd64.v3.1.3.tgz](http://package-minio.alauda.cn:9199/packages/mlflow/v3.1/mlflow.amd64.v3.1.3.tgz)
* Volcano: Schedule training jobs using various scheduler plugins including Gang-Scheduling, Binpack etc.
  * [http://package-minio.alauda.cn:9199/packages/volcano/v1.12/volcano.amd64.v1.12.1.tgz](http://package-minio.alauda.cn:9199/packages/volcano/v1.12/volcano.amd64.v1.12.1.tgz)


```bash
# Note: replace yout platform addr, username, password and clsuter name.
violet push --platform-address="https://192.168.171.123" --platform-username="admin@cpaas.io" '--platform-password=07Apples@' --clusters=g1-c1-gpu http://prod-minio.alauda.cn/aml/aml-packages/v0.0.0-beta.2.g00624748/kubeflow-v0.0.0-beta.2.g00624748.all-in-one.tgz 
```

Go to "Administrator - Marketplace - Upload Packages", then switch to tab "Cluster Plugins", find the plugins uploaded, and verify that versions of those plugins are correctly synced.

Then go to "Administrator - Marketplace - Cluster Plugins", find these plugins, and click the "..." button on the right, then click "Install". Fill in the form if the plugin requires some setup, then click "Install" to install the "Cluster Plugin" into current cluster.

> **NOTE:** These cluster plugins can be installed on a single cluster. If you need to use them in different clusters, you may need to install them again in another cluster.

> **NOTE:** While installing Kubeflow Training Operator plugin, if you want to enable volcano scheduling feature, you need to install volcano plugin before installing Kubeflow Training Operator.

### Notes when setup KubeflowBase plugin

#### Create istio ingress gateway as the kubeflow web entrypoint

Create a istio ingress gateway instance under "Administrator" view of Alauda Service Mesh. Use NodePort to access the gateway service. Then find the pod of the gateway and copy the label like "istio: wy-kubeflow-gw-kubeflow-gw" to fill in the form when installing KubeflowBase.

#### Setup dex redirect URI

Run `kubectl -n cpaas-system edit configmap dex-configmap` in the `global` cluster, and add the field in the `redirectURI` :

```yaml
redirectURIs:
- ...
# Add the following line of configuration. Note: the redirect address must be consistent with oidcRedirectURL in step 3:
- https://192.168.139.133:30665/oauth2/callback
```

#### Create Kubeflow User and bind to a namespace

Before logging into Kubeflow for the first time, you need to bind an ACP user to a namespace. In the following example, you can create the namespace `kubeflow-admin-cpaas-io` and bind the user `admin@cpaas.io` as its owner.

> **NOTE:** If this profile resource has already been deployed when deploying the AML, you can skip this step.

```yaml
apiVersion: kubeflow.org/v1beta1
kind: Profile
metadata:
  name: kubeflow-admin-cpaas-io
spec:
  owner:
    kind: User
    name: "admin@cpaas.io"
```

#### Fix the issue of not being able to select the kubeflow-admin-cpaas-io namespace

If you have already deployed AML, created the kubeflow-admin-cpaas-io namespace, and created the Profile resource in the previous step, but you still cannot select a namespace, refer to the following resources to create a role binding for your account.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: user-admin-cpaas-io-clusterrole-admin
  namespace: kubeflow-admin-cpaas-io
  annotations:
    role: admin
    user: "admin@cpaas.io"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: kubeflow-admin
subjects:
  - apiGroup: rbac.authorization.k8s.io
    kind: User
    name: "admin@cpaas.io"
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: user-admin-cpaas-io-clusterrole-admin
  namespace: kubeflow-admin-cpaas-io
  annotations:
    role: admin
    user: "admin@cpaas.io"
spec:
  rules:
    - from:
        - source:
            ## for more information see the KFAM code:
            ## https://github.com/kubeflow/kubeflow/blob/v1.8.0/components/access-management/kfam/bindings.go#L79-L110
            principals:
              ## required for kubeflow notebooks
              ## TEMPLATE: "cluster.local/ns/<ISTIO_GATEWAY_NAMESPACE>/sa/<ISTIO_GATEWAY_SERVICE_ACCOUNT>"
              - "cluster.local/ns/istio-system/sa/istio-ingressgateway-service-account"
 
              ## required for kubeflow pipelines
              ## TEMPLATE: "cluster.local/ns/<KUBEFLOW_NAMESPACE>/sa/<KFP_UI_SERVICE_ACCOUNT>"
              - "cluster.local/ns/kubeflow/sa/ml-pipeline-ui"
      when:
        - key: request.headers[kubeflow-userid]
          values:
            - "admin@cpaas.io"
```

### Notes when setup Kubeflow Pipeline plugin

When fill in the form when installing Kubeflow pipeline plugin, you can use an external MySQL service or Minio service, or choose to use the built-in services. Be ware that:

* Builtin MySQL and Minio services are single pod service, which may sufur from single point of failure.
* When using an external MySQL service, the MySQL service must be of version "MySQL 5.7". If there's no such service, use the built-in MySQL.

### Notes when setup MLFlow plugin

You need to setup a PostgreSQL service, and fill in the pgHost, pgPort, pgUsername, pgPassword values. MySQL is NOT supported any more (after mlflow >= v3.1.1).

### Upload Images

You need to upload some images that AML will use for some experimental features. Download below images and upload to current ACP image registry:

```
build-harbor.alauda.cn/mlops/llm-trainer:v1.4.3
build-harbor.alauda.cn/mlops/buildkit-gitlfs:v0.13-rootless-aml
build-harbor.alauda.cn/mlops/buildkit:v0.15.2-aml
```

> **IMPORTANT**: after upload [build-harbor.alauda.cn/mlops/llm-trainer:v1.4.3](http://build-harbor.alauda.cn/mlops/llm-trainer:v1.4.3) , you need to check out the actual image address and tag Alauda AI is using by running: `kubectl -n kubeflow get cm aml-image-builder-config -o yaml  | grep llm-trainer` , then add the tag used in the configmap and point to the uploaded image, e.g. `nerdctl tag your.registry.com/mlops/llm-trainer:v1.4.3 your.registry.com/mlops/llm-trainer:v1.4.2-rc.1.ge47ab59d` 


## Turn on experimental features on AML UI

Goto "Administrator - Clusters - Resources", select the **CURRENT** cluster, then update `AmlCluster` resource: `default`, add the following fields:

```yaml
spec:
  values:
    experimentalFeatures:
      datasets: true # Open Datasets
      imageBuilder: true # Open Image Builder
      tuneModels: true # Open Finetune and Train
    global:
      mysql:
        database: aml # db name
        host: 10.4.158.198 # dataset host
        passwordSecretRef:
          name: aml-mysql-root-token  # kubectl create secret generic aml-mysql-root-token --from-literal="password=07Apples@" -n cpaas-system
          namespace: cpaas-system
        port: 3306 # db port
        user: root # db user
```

Goto "Administrator - Clusters - Resources", select the **CURRENT** cluster, then update `Aml` resource `default-aml` add the following fields. Set to actual values that the current cluster supports.

```yaml
spec:
  values:
    amlService:
      trainingPVCSize: 10Gi
      trainingPVCStorageClass: sc-topolvm
      notebookStorageClass: sc-topolvm
```

Restart the aml-api-deploy component by running this command: `kubectl -n kubeflow rollout restart deploy aml-api-deploy`

If you use the fine-tuning and training functions, please update the `aml-image-builder-config` configmap under the corresponding ns:

```yaml
apiVersion: v1
data:
  ...
  MODEL_REPO_BUILDER_DB_DB: aml # db name
  MODEL_REPO_BUILDER_DB_HOST: mysql.kubeflow #db host
  MODEL_REPO_BUILDER_DB_PORT: "3306" # db port
  MODEL_REPO_BUILDER_DB_USER: root # db user
kind: ConfigMap
metadata:
  name: aml-image-builder-config
  namespace: {your-ns}
```

and aml-image-builder-secret secret:

```yaml
apiVersion: v1
data:
  ...
  MODEL_REPO_BUILDER_DB_PASSWORD: ""  # db password
kind: Secret
metadata:
  name: aml-image-builder-secret
  namespace: {your-ns}
type: Opaque
```

### Turn off experimental features and uninstall plugins

1. To turn off experimental featurs, just Goto "Administrator - Clusters - Resources", select the **CURRENT** cluster, then update `AmlCluster` resource: `default`, delete following lines that added before:

```yaml
spec:
  values:
    # delete below lines
    experimentalFeatures:
      datasets: true
      imageBuilder: true
      tuneModels: true
```

2. To uninstall plugins installed for Alauda AI, Goto "Administrator" - "Market Place" - "Cluster Plugins", find below plugins, and if it is installed already you can click "..." on the right, and click "uninstall". Note you should delete these plugins in the order listed below:

  1. MLFlow
  2. Kubeflow Training Operator
  3. Kubeflow Pipelines
  4. Kubeflow Base

3. In most cases, you do NOT need to uninstall volcano plugin, since it's a just basic "low-level" component that does not affect any other components. Keep volcano installation, you'll be able to restore the fine-tunning, training job status if you want to install Alauda AI back again. Yet you can still be able to uninstall volcano under "Cluster Plugin", at your own risk.

### Upgrading from Alauda AI 1.3 (1.3~1.4) with experimental features

After upgrading AML from 1.3 to 1.4, and the previous 1.3 installation was deployed with experimental features, you need to follow these steps to uninstall previous versions of plugins and upgrade them to plugins for Alauda AI 1.4.

> **WARNING:** this operation will delete older versions of Kubeflow, volcano and MLFlow and instances created using these components including notebooks, tensorboards, mlflow experiment records (which may cause the tracking charts in "Fine Tunning" job will be lost). If you need to backup the data and restore them in the new version, please check below steps for detail.

#### Backup data used by notebooks, tensorboards, mlflow and MySQL

1. Notebooks
  1. Just keep those PVCs created before under user namespaces. Do NOT delete them during the update nor the user namespaces.
  2. **NOTE:** if you have previous running notebooks and have installed extra dependencies like using `pip install`  , when the notebook is recreated in the new version, those dependencies will be lost, you need to re-install them again.
2. Tensorboards
    1. Same as above, keep the PVCs and user namespaces.
3. MLFlow
    1. **NOTE:** mlflow for Alauda AI 1.4 will change to use PostgreSQL as tracking server database. You have to do below steps to backup mlflow data if the data is important.
    2. you can use this tool [https://github.com/mlflow/mlflow-export-import](https://github.com/mlflow/mlflow-export-import) to export the current data from mlflow trancking server, then import into the new version.
    3. **NOTE:** that Alauda AI 1.3 comes with mlflow 2.6.0, and Alauda AI 1.4 upgraded mlflow to v3.1.1. So make sure the exported data can be imported to this new version.
4. If you have already performed `Turn on all features in Alauda AI 1.3` steps here to turn on experimental features in Alauda AI 1.3. You'll have a MySQL database instance. If this MySQL instance is some standalone service (not installed by Alauda AI or kubeflow plugin), you can then reuse this instance and keep the records after the upgrade. To make sure, the data will not be lost, you'll need to backup the database manually (e.g. [https://stackoverflow.com/questions/8725646/backing-up-mysql-db-from-the-command-line](https://stackoverflow.com/questions/8725646/backing-up-mysql-db-from-the-command-line)) or use features provided by Alauda Data Service.

#### Delete Notebook, Tensorboard instances (optional)

You can optionally delete existing Notebook and Tensorboard instances. Then re-create them after the upgrade.

> **NOTE:** if you choose to keep Notebook and Tensorboards instances, after the upgrade, these "old" instances might not work properly. You can do this on your own risk.


#### Wait all fine-tunning and training jobs finish

If there are fine-tunning, training jobs still running in the cluster, you need to wait them to become finish. And do NOT create new jobs during the upgrade progress.

> **NOTE:** after uninstallation of previous "kubeflow plugin", all volcano jobs (vcjob for short) resource will be deleted. So job status, pod logs will be deleted. But since fine-tunning jobs are finished, the job records will be saved in the MySQL database. If you have done backup MySQL database, or just reusing the same standalone MySQL instance, all the job records should be available after upgrade.

But be aware that the actual "job" k8s resource is lost after deletion.

#### Upgrade Alauda AI from 1.3 to 1.4

You can do a general upgrade to upgrade Alauda AI from 1.3 to 1.4 after you've done backup, deletion steps above.

#### Uninstall kubeflow chart plugin

At "Alauda Container Platform" - Select the namespace where kubeflow for Alauda AI 1.3 was installed - "Applications" - "Applications", find the Kubeflow plugin deployment, and select "..." - "Delete". Wait until it complete.

#### Install plugins of Alauda AI 1.4 with the following order

Go from the beginning of this documentation for more details of install plugins for Alauda AI 1.4

1. kfbase: Kubeflow Base
2. kfp: Kubeflow Pipelines
3. volcano
4. kftraining: Kubeflow Training Operator
5. MLFlow

#### Check experimental feature swich and MySQL connection

Check the "AmlCluster" Resouce under "Administrator - Clusters - Resources" (select current cluster on the top bar). check the resource YAML code already have those settings mentioned in [Turn on experimental features](#turn-on-experimental-features-on-aml-ui). If you are using the same MySQL instance, check if the fine-tunning jobs records are still available. If not you may need to go to MySQL instance to check if the data is available or restore the database backup.

If experimental features is not enabled in previous Alauda AI 1.3 installation, you need to go the document from the beginning enable experimental features.

Goto "Administrator - Clusters - Resources", select the \*\*CURRENT\*\* cluster, then update "AmlCluster" resource: "default", check the following fields are up to date:

```yaml
spec:
  values:
    experimentalFeatures:
      datasets: true # Open Datasets
      imageBuilder: true # Open Image Builder
      tuneModels: true # Open Finetune and Train
    global:
      mysql:
        database: aml # db name
        host: 10.4.158.198 # dataset host
        passwordSecretRef:
          name: aml-mysql-root-token  # kubectl create secret generic aml-mysql-root-token --from-literal="password=07Apples@" -n cpaas-system
          namespace: cpaas-system
        port: 3306 # db port
        user: root # db user
```

#### Create Kubeflow Profile to enable user namespace accessing to the Kubeflow component (e.g. Notebooks)

Goto [Create Kubeflow User](#create-kubeflow-user-and-bind-to-a-namespace) to create profiles for kubeflow users to access kubeflow components.

If the profiles are already created and not deleted, it should be available after the new kubeflow plugin installed.

If you have previous undeleted notebook instances, you should still be able to access the previous notebook instance from "Alauda AI" - "Advanced" - "Kubeflow" - "Notebooks".


#### Test if experimental features works

1. login as Alauda AI user (with namespace authorized), check the left nav bar have below entrances:
  1. Dataset
  2. Model Optimization
  3. Advanced:
      1. Kubeflow
      2. MLFlow
2. Check if dataset can be cached and previewed
3. Create a simple fine-tunning job to see if the job can successfully run
4. Create a simple image build job for an existing model
5. Check if notebook instances (if there are any) can be accessed from "Advanced" - "Kubeflow" - "Notebooks"
6. Check if mlflow web ui can be accessed
