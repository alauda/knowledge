---
kind:
   - Solution
products:
  - Alauda DevOps
ProductsVersion:
   - 4.0,4.1
id: KB251000010
---

# Automating Harbor Robot Credentials Sync and Token Rotation per Namespace in K8S using the Harbor Robot Account Generator Plugin

## Introduction

### What is Harbor Robot Account Generator

In a K8S cluster, to pull private images, we need to configure a `Secret` in the K8S cluster, bind this Secret to a Service Account (SA), or specify the `imagePullSecrets` field when creating a Workload. In enterprises, with the expansion of team sizes, the number of namespaces to be managed will increase. For different teams, we also hope that the permissions of the credentials used in each team's namespace are limited and controllable. At the same time, if the credentials are leaked, the associated risks should be small enough.

`Harbor Robot Account Generator` was created to address these issues.

### Compatible Harbor Versions

- Harbor >= v2.12

### Function Overview

- Automatically create corresponding Projects on Harbor based on Namespace information.
- Automatically create robot accounts on Harbor Projects, and use the credentials of the robot accounts to create K8S Secrets for image pulling in the corresponding K8S Namespace.
- Regularly refresh the credentials of the robot accounts and synchronize them to the Secrets of the Namespace.
- Attach the created Secrets to the `imagePullSecret` of the Service Account.

For more information, please refer to:

- [Quick Start](#quick-start)


## Installation \{#installation}

### Prerequisites

1.  Prepare an operations machine running Windows, Linux, or macOS that can access the platform. Linux is recommended; the following instructions use Linux as an example.
2.  Ensure the operations machine has network access to the `platform`.
3.  Download the cluster plugin package and save it to your working directory on the operations machine.

:::info
Search for "Harbor Robot Account Generator" in the Alauda Cloud Marketplace to find the cluster plugin package.
:::

### Obtaining the Upload Tool

Navigate to `Platform Management` -> `Marketplace` -> `Upload Packages` to download the upload tool. After downloading, grant execute permissions to the binary.

### Uploading the Cluster Plugin

> Whether you are importing a new cluster plugin or updating an existing one, you can use the `upload tool` with the same commands.

Run the following command in your working directory:

```bash
./violet push \
    <plugin-package> \
    --platform-address <platform-address> \
    --platform-username <platform-username> \
    --platform-password <platform-password> \
    --clusters <clusters>
```

For more details on the `violet push` command, refer to the [violet push documentation](https://docs.alauda.io/container_platform/4.0/ui/cli_tools/index.html).

### Installing the Cluster Plugin

After uploading the Cluster Plugin, go to `Platform Management` -> `Marketplace` -> `Cluster Plugin`, switch to the target cluster, and deploy the corresponding Cluster Plugin.

### Uninstalling the Cluster Plugin

To uninstall the cluster plugin, navigate to **Platform Management** → **Marketplace** → **Cluster Plugin**, switch to the target cluster, and uninstall the corresponding Cluster Plugin.


## Quick Start \{#quick-start}

This document will help you quickly understand and use Harbor Robot Account Generator to generate Harbor robot account credentials in the specified k8s namespace, allowing Pods to pull images with minimal permissions and periodically refresh these credentials.

### Estimated Reading Time

10-15 minutes

### Prerequisites

- A Kubernetes cluster with the following components installed:
  - Harbor Robot Account Generator
  - Three namespaces created in the cluster: `team`, `team-ns1`, `team-ns2`
  - The `team` namespace contains the label `cpaas.io/inner-namespace`, with the value `team`
- A properly functioning Harbor

### Overview of the Procedure

| No | Procedure                      | Description                                        |
| -- | ------------------------------ | -------------------------------------------------- |
| 1  | Configure Harbor Address Information   | Configure the Harbor address, username, password, etc.                 |
| 2  | Create HarborRobotBinding Resource | Create the configuration to synchronize the robot account               |
| 3  | Verify the Result              | Automatically create the Project in Harbor and verify that the robot account and credentials are as expected |

### Steps

#### Step 1: Configure Harbor Connection Information

In order for the cluster to access Harbor and call the Harbor API, we need to configure the connection information for Harbor. We will specify this information through a Secret.

```
cat << 'EOF' | kubectl apply -f -
kind: Secret
apiVersion: v1
metadata:
  name: harbor
  namespace: harbor-robot-gen-system
  annotations:
    # When automatically creating Harbor Project, use the label: cpaas.io/inner-namespace on the namespace as the name of the Harbor Project
    harbor-robot-gen/projectFieldsPath: "{.metadata.labels.cpaas\\.io/inner-namespace}"
  labels:
    harbor-robot-gen: "true" # Mark this Secret as available for Harbor Robot Gen
type: kubernetes.io/opaque
stringData:
  username: api-user # Username used to call the Harbor API
  password: api-password # Password used to call the Harbor API
  url: https://harbor.example.com # The address of Harbor
EOF
```

Due to the current design of Harbor, only Harbor administrators have the permission to create Projects, so the user specified here must be an administrator.

For more information on configuring Harbor connection information, please refer to [Harbor Connection Information Configuration](#harbor-connection-information-configuration).

#### Step 2: Create HarborRobotBinding Resource

Assuming we want the k8s namespaces named `team-ns1` and `team-ns2` to access the Harbor Project named `team` in Harbor. (Make sure the k8s namespaces are created in advance)

We need to create the following `HarborRobotBinding` resource:

``` shell
cat << EOF | kubectl apply -f -
apiVersion: harbor-robot-gen.alaudadevops.alauda.io/v1alpha1
kind: HarborRobotBinding
metadata:
  name: harbor-secret-for-team
spec:
  # The k8s namespaces where the secret will be created
  namespaces:
    names:
    - team-ns1
    - team-ns2
  generatedSecret:
    name: harbor-secret-for-team.robot  # The name of the Secret generated in the cluster
  serviceAccount:
    name: default # Automatically bind the secret to the imagePullSecrets field of the default service account

  harbor:
    project: team # The expected name of the project in Harbor to access
    robot:
      access: # Permissions of the automatically created Robot
      - action: pull
        resource: repository
    secret: # Harbor configuration information, as configured in Step 1
      name: harbor
      namespace: harbor-robot-gen-system

  refreshInterval: 6h # Refresh time for Robot credentials
EOF
```

For more information about HarborRobotBinding configuration, please refer to [HarborRobotBinding Configuration](#harborrobotbinding).

#### Step 3: Verify the Result

1. Check if the Harbor Project named `team` was automatically generated in Harbor.

2. Check if a robot account named `robot$team+harbor-secret-for-team-xxxx` was generated under the `team` project in Harbor.

3. Check if the status of HarborRobotBinding is Ready=True

```bash
$ kubectl get HarborRobotBinding -A

NAME                     READY   LASTREFRESHTIME        NEXTREFRESHTIME        AGE
harbor-secret-for-team   True    2025-05-15T10:33:41Z   2025-05-15T16:33:41Z   20h
```

4. Check if a Secret named `harbor-secret-for-team.robot` was created in the target namespace

```bash
$ kubectl get secret -n <namespace>

NAME                                   TYPE                             DATA   AGE
harbor-secret-for-team.robot           kubernetes.io/dockerconfigjson   1      20h
```

5. Check whether the imagePullSecrets of the service account in the target namespace automatically includes the above Secret

```bash
$ kubectl get sa default -n <namespace> -o yaml

apiVersion: v1
imagePullSecrets:
- name: harbor-secret-for-team.robot
kind: ServiceAccount
metadata:
  name: default
```

6. Create a Pod in the target namespace and confirm whether it can pull the image normally.

```bash
cat << EOF | kubectl apply -f -
kind: Pod
apiVersion: v1
metadata:
  name: test-pod
  namespace: <namespace>
spec:
  containers:
  - name: test
    image: <your-image-address-in-team-project>
    imagePullPolicy: Always
    command: ["sleep"]
    args: ["3600"]
EOF
```

At this point, you have successfully used `Harbor Robot Account Generator` to automatically create the team Project on Harbor and generate a K8S Secret with only `pull repository` permission, which can access the Harbor Project named `team` in the `team-ns1` and `team-ns2` namespaces. Additionally, this credential will be automatically refreshed every 6 hours.

### How It Works

- `Harbor Robot Account Generator` checks for credentials in the system that have the label `harbor-robot-gen: "true"`, reading the value of the annotation `harbor-robot-gen/projectFieldsPath` configured on the credential. This value is a JsonPath. When traversing the current cluster's k8s namespaces, it uses this JsonPath to access the specific field values on the namespace as the names for the Harbor Projects to be created, completing the creation of the Harbor Projects in Harbor.
- After creating the `HarborRobotBinding`, `Harbor Robot Gen` will create robot accounts on the specified Harbor Project. Simultaneously, within the specified k8s namespace scope, it creates k8s Secrets using the credentials of the robot account and binds them to the specified service account. The credentials of the robot account will be periodically refreshed according to the specified refresh cycle, and the latest credentials will be synchronized to k8s.

### More Information

- [Harbor Connection Information Configuration](#harbor-connection-information-configuration)
- [Configuration to Automatically Generate Harbor Projects](#configuring-the-name-used-when-automatically-generating-harbor-projects)
- [HarborRobotBinding Configuration](#harborrobotbinding)
- [Using in Harbor Disaster Recovery Failover](#using-harbor-robot-gen-in-harbor-disaster-recovery-failover)

## HarborRobotBinding \{#harborrobotbinding}

### Overview

`HarborRobotBinding` is a cluster-level resource that primarily defines the namespaces in Kubernetes for which we expect to automatically generate credentials for Harbor robot accounts. It also specifies the permissions with which these robot accounts can access the Harbor project.

- Scope of target namespaces
- Accessible Harbor projects for robot account generation and the associated permissions
- Refresh interval for the robot account credentials
- Name of the generated Kubernetes Secret and the name of the expected bound Service Account (SA)

### Expected Kubernetes Namespace Scope for Automatic Secret Generation

Specify the expected namespaces for automatically generating Kubernetes secrets through `spec.namespaces`. Typically, this scope represents namespaces with the same type of Harbor access permissions, such as all namespaces for a team.

- Specifying the scope via names

```yaml
spec:
  namespaces:
    names:
    - default
    - dev-ns1
```

- Specifying the scope via a selector; the data structure of the selector can refer to [K8S LabelSelector](https://pkg.go.dev/k8s.io/apimachinery@v0.33.0/pkg/apis/meta/v1#LabelSelector)

```yaml
spec:
  namespaces:
    selector:
      matchLabels:
        goharbor.io/project: team-1
```

When both names and selector are specified, the union will be taken. If both names and selector are empty, the target namespaces are considered empty.

### Harbor Configuration

#### Using Harbor Connection Configuration

Specify this using `spec.harbor.secret`. The format of the secret can be referenced in [Harbor Connection Configuration](#harbor-connection-information-configuration)

```yaml
spec:
  harbor:
    secret:
      name: harbor
      namespace: harbor-robot-gen-system
```

#### Projects and Permissions for Robot Accounts

Specify under which Harbor project the robot account should be created via `spec.harbor.project` and define the robot's permissions using `spec.harbor.robot`.

```yaml
spec:
  harbor:
    project: team
    robot:
      access:
      - action: pull
        resource: repository
```

Among them, the parameter configuration for `harbor.robot.access[].action` and `harbor.robot.access[].resource` can be referenced in the Harbor official API documentation when creating robot accounts.

#### Refresh Interval for Robot Account Credentials

```yaml
spec:
  refreshInterval: 6h
```

#### Name of the Generated Kubernetes Secret and Expected Bound Service Account Name

Use `spec.generatedSecret` to specify the name of the generated Kubernetes Secret. Please avoid naming conflicts with existing secrets in the namespace. The type of the secret is `kubernetes.io/dockerconfigjson`. Use `spec.serviceAccount` to specify the name of the bound Service Account; if empty, only the Secret will be generated.

```yaml
apiVersion: harbor-robot-gen.alaudadevops.alauda.io/v1alpha1
kind: HarborRobotBinding
metadata:
  name: harbor-for-team
spec:
  generatedSecret:
    name: harbor-for-team.robot
  serviceAccount:
    name: default
```

### Example

The following resource will:

- Generate a robot account with only repository pull permissions under the Harbor project named `team`.
- Synchronize the credentials of the robot account to all namespaces containing the label `goharbor.io/project: team-1`, creating a secret of type dockerconfigjson.
- Attach the secret to the `imagePullSecrets` field of the default service account in the corresponding namespaces.
- Refresh the credentials every 6 hours.

```yaml
apiVersion: harbor-robot-gen.alaudadevops.alauda.io/v1alpha1
kind: HarborRobotBinding
metadata:
  name: harbor-for-team
spec:
  generatedSecret:
    name: harbor-for-team.robot
  serviceAccount:
    name: default
  namespaces:
    selector:
      matchLabels:
        goharbor.io/project: team-1

  harbor:
    project: team
    robot:
      access:
      - action: pull
        resource: repository
    secret:
      name: harbor
      namespace: harbor-robot-gen-system
  refreshInterval: 6h
```

## Harbor Connection Information Configuration \{#harbor-connection-information-configuration}

To enable the cluster to access Harbor and invoke Harbor's API, we need to configure the connection information for Harbor.

We specify this information through a Secret.

The Secret type is `kubernetes.io/opaque` and mainly contains the following information:

- Marks that the current Secret will be provided for Harbor Robot Account Generator use
- Connection information such as address/username/password
- Fields used when automatically generating Harbor Projects

### Marking the Current Secret for Harbor Robot Account Generator

Mark the current Secret for Harbor Robot Account Generator use through the following Label in the Secret:

```yaml
metadata:
  labels:
    harbor-robot-gen: "true"
```

### Connection Information Including Address/Username/Password

The Data in the Secret must include the following fields:

- `url`: The address of Harbor, for example [https://harbor.example.com](https://harbor.example.com)
- `username`: The username required to access Harbor, e.g., user1
- `password`: The password required to access Harbor, e.g., pass1

Please note that due to the current design of Harbor, only Harbor administrators have the permission to create Projects, so the user specified here must be an administrator.

Please note that due to the issue in the current Harbor version 2.12 [where robot accounts cannot manage robot accounts](https://github.com/goharbor/harbor/issues/21922), the user here cannot be a robot account. It is advisable to create a separate user specifically for `Harbor Robot Account Generator`.

### Configuring the Name Used When Automatically Generating Harbor Projects \{#configuring-the-name-used-when-automatically-generating-harbor-projects}

If you expect to automatically generate a Harbor Project on Harbor, you can define the name of the Harbor Project by using the `harbor-robot-gen/projectFieldsPath` annotation. Its value is a [kubectl style JSONPath template](https://kubernetes.io/docs/reference/kubectl/jsonpath/)

At runtime, it will traverse all Namespaces in the cluster and use the value of the specified JSONPath field as the name of the Harbor Project.

For example, the following indicates that the annotation named `goharbor.io/project` in the Namespace will be used as the name of the Harbor Project:

```yaml
metadata:
  annotations:
    harbor-robot-gen/projectFieldsPath: "{.metadata.annotations.goharbor\.io/project}"
```

#### More Examples of Using JSONPath for Harbor Project Naming

| JSONPath | Description |
| --- | --- |
| `{.metadata.name}` | Use the Namespace name as the Harbor Project name. The Harbor Project will correspond one-to-one with the cluster Namespace. |
| `{.metadata.labels.cpaas\.io/inner-namespace}` | In ACP clusters, Namespaces with the same project will contain this label. This means the ACP project name will be used as the Harbor Project name, and all ACP projects will each have a Harbor Project with the same name. |
| `{.metadata.annotations.goharbor\.io/project}` | Use the value of the `goharbor.io/project` annotation on the Namespace as the Harbor Project name. |

> **Note:**
> Please use an appropriate JSONPath to specify the Harbor Project name. Avoid having too many Namespaces with different value, which may lead to the creation of too many Projects in Harbor. Also, the system will NOT automatically clean up Harbor Projects that were generated; you need to clean them up manually if necessary.


### Advanced Configuration

#### Multiple Access Address Configuration

When your Harbor registry is accessible through multiple addresses, you may need to generate `Image Pull Secrets` for alternative endpoints when using HarborRobotBinding. This can be achieved using the `url.alias` configuration.

**Configuration Parameters:**

- `url.alias`: Alternative access address for the Harbor registry (e.g., `https://harbor.example.com` as an alias for `https://harbor-1.example.com`)
- `url.alias.policy`: Policy determining when to generate secrets for the alias address
  * `IfIPEqual`: Generate an `Image Pull Secret` for `url.alias` only when the resolved IP addresses of `url.alias` and `url` are identical
  * `Always`: Always generate an `Image Pull Secret` for `url.alias` regardless of IP resolution
- `url.alias.check.interval`: Interval for policy evaluation checks, specified in [Go duration format](https://pkg.go.dev/time#ParseDuration) (e.g., `2m`). Default: `1m`
- `url.alias.ips`: List of IP addresses to match against the resolved IP addresses of `url.alias`. If not set, the `IfIPEqual` policy will take effect when the alias address is the same as the `url`. if set, the `IfIPEqual` policy will take effect when the resolved IP addresses of `url.alias` are contained in the list. Multiple IP addresses are separated by commas.

**Behavior:**
The `Image Pull Secret` generated for `url.alias` contains identical credentials to the primary `url` secret, with only the registry address differing.

**Use Case:**
The `url.alias.policy: IfIPEqual` configuration is particularly well-suited for Harbor disaster recovery scenarios implementing DNS-based failover. For comprehensive implementation guidance, see [Harbor Disaster Recovery Scenario Usage](#using-harbor-robot-gen-in-harbor-disaster-recovery-failover)

### Examples

**Example 1**

``` yaml
kind: Secret
apiVersion: v1
metadata:
  name: harbor
  namespace: harbor-robot-gen-system
  annotations:
    "harbor-robot-gen/projectFieldsPath": '{.metadata.annotations.goharbor\.io/project}'
  labels:
    harbor-robot-gen: "true"
type: kubernetes.io/opaque
stringData:
  username: user1
  password: pass1
  url: https://harbor-1.example.com
```

**Example 2**

``` yaml
kind: Secret
apiVersion: v1
metadata:
  name: harbor
  namespace: harbor-robot-gen-system
  annotations:
    "harbor-robot-gen/projectFieldsPath": '{.metadata.annotations.goharbor\.io/project}'
  labels:
    harbor-robot-gen: "true"
type: kubernetes.io/opaque
stringData:
  username: user1
  password: pass1
  url: https://harbor-1.example.com
  url.alias: https://harbor.example.com
  url.alias.policy: IfIPEqual # When the IP address resolved from url.alias and url are the same, generate an `Image Pull Secret` for `url.alias`. Default is IfIPEqual
  url.alias.check.interval: 2m # The interval for checking the policy, using [golang duration](https://pkg.go.dev/time#ParseDuration) format, for example `2m`. Default is 1m.
```

**Example 3**

``` yaml
kind: Secret
apiVersion: v1
metadata:
  name: harbor
  namespace: harbor-robot-gen-system
  annotations:
    "harbor-robot-gen/projectFieldsPath": '{.metadata.annotations.goharbor\.io/project}'
  labels:
    harbor-robot-gen: "true"
type: kubernetes.io/opaque
stringData:
  username: user1
  password: pass1
  url: https://harbor-1.example.com
  url.alias: https://harbor.example.com
  url.alias.policy: IfIPEqual
  url.alias.ips: 192.168.1.1,192.168.1.2 # if harbor.example.com is resolved to 192.168.1.1 or 192.168.1.2, generate an `Image Pull Secret` for `url.alias`.
  url.alias.check.interval: 2m

```

## Using Harbor Robot Account Generator in Harbor Disaster Recovery Failover \{#using-harbor-robot-gen-in-harbor-disaster-recovery-failover}

In a Harbor disaster recovery scenario, you may have two Harbor instances (primary and secondary) with DNS switching implemented to achieve Harbor failover between primary and secondary sites.

For example, consider the following architecture:

- Harbor 1 and Harbor 2 synchronize images to ensure image consistency
- harbor.example.com uses DNS to point to either Harbor 1 or Harbor 2
- Business clusters access the image registry through harbor.example.com

``` mermaid
graph BT
    Cluster[K8S Cluster<br/>&lpar;HarborRobotBinding&rpar;]
    H0[harbor.example.com<br/>&lpar;DNS Switching&rpar;]
    H1[Harbor 1 Service<br/>harbor-1.example.com]
    H2[Harbor 2 Service<br/>harbor-2.example.com]

    Cluster --> H0
    H0 --> H1
    H0 -.-> H2
```

This document describes how to use Harbor Robot Account Generator in clusters, ensuring that when DNS switching occurs, the cluster can use credentials generated by Harbor Robot Account Generator to pull images normally.

### Prerequisites

- Kubernetes Cluster
- `Harbor Robot Account Generator` installed in the cluster
- Harbor 1 and Harbor 2 prepared, accessible via harbor-1.example.com and harbor-2.example.com respectively
- Domain name harbor.example.com prepared and Harbor configured so that after DNS switching, both Harbor 1 and Harbor 2 can be accessed through harbor.example.com

### Overview

**Process Overview**

| No. | Operation Step | Description |
|-----|----------------|-------------|
| 1 | Prepare and Apply Harbor Secret | Prepare Harbor secret to connect to Harbor |
| 2 | Apply HarborRobotBinding Resources | Create HarborRobotBinding resources for both Harbor instances |
| 3 | Verify Image Pulling | Create Pod to verify image pulling functionality |
| 4 | Switch DNS to Verify Image Pulling | Switch DNS and verify image pulling continues to work |

**Key Configurations**

- Use the `url.alias` capability in [Harbor Secret](#harbor-connection-information-configuration) configuration to specify access aliases for Harbor 1 and Harbor 2
- Use HarborRobotBinding resources to generate Image Pull Secrets for both Harbor 1 and Harbor 2

### Steps to Operate

#### Step 1: Prepare and Apply Harbor Secret

To enable the cluster to access Harbor and invoke Harbor APIs, we need to configure the connection information for Harbor. We will specify this information through a Secret.

Prepare Harbor Secret for Harbor 1:

``` bash
cat << 'EOF' | kubectl apply -f -
kind: Secret
apiVersion: v1
metadata:
  name: harbor1
  namespace: harbor-robot-gen-system
  annotations:
    "harbor-robot-gen/projectFieldsPath": '{.metadata.labels.cpaas\.io/inner-namespace}'
  labels:
    harbor-robot-gen: "true"
type: kubernetes.io/opaque
stringData:
  username: user1
  password: pass1
  url: https://harbor-1.example.com
  url.alias: https://harbor.example.com
  url.alias.policy: IfIPEqual
EOF
```

Prepare Harbor Secret for Harbor 2:

```bash
cat << 'EOF' | kubectl apply -f -
kind: Secret
apiVersion: v1
metadata:
  name: harbor2
  namespace: harbor-robot-gen-system
  annotations:
    "harbor-robot-gen/projectFieldsPath": '{.metadata.labels.cpaas\.io/inner-namespace}'
  labels:
    harbor-robot-gen: "true"
type: kubernetes.io/opaque
stringData:
  username: user1
  password: pass1
  url: https://harbor-2.example.com
  url.alias: https://harbor.example.com
  url.alias.policy: IfIPEqual
EOF
```

We specify the `url.alias` as `https://harbor.example.com` and `url.alias.policy` as `IfIPEqual`, so `HarborRobotBinding` will generate an alias secret using `url.alias` when the resolved IP addresses are equal to those of `url`.

For more information about `url.alias` configuration, please refer to [Harbor Connection Information Configuration](#harbor-connection-information-configuration).

#### Step 2: Apply HarborRobotBinding Resources

We need to create `HarborRobotBinding` resources for both Harbor 1 and Harbor 2, enabling us to generate image pull secrets for pulling from harbor-1.example.com and harbor-2.example.com respectively. According to the configuration in Step 1, it will also generate image pull secrets for pulling from harbor.example.com, which are copied from the Harbor 1 image pull secrets.

`HarborRobotBinding` for harbor-1.example.com:

``` bash
cat << EOF | kubectl apply -f -
apiVersion: harbor-robot-gen.alaudadevops.alauda.io/v1alpha1
kind: HarborRobotBinding
metadata:
  name: harbor1-for-team1
spec:
  generatedSecret:
    name: harbor1-for-team1.robot
  serviceAccount:
    name: default
  namespaces:
    names:
    - team1-demo
  harbor:
    project: team1
    robot:
      access:
      - action: pull
        resource: repository
    secret:
      name: harbor1
      namespace: harbor-robot-gen-system
  refreshInterval: 1h
EOF
```

`HarborRobotBinding` for harbor-2.example.com:

```bash
cat << EOF | kubectl apply -f -
apiVersion: harbor-robot-gen.alaudadevops.alauda.io/v1alpha1
kind: HarborRobotBinding
metadata:
  name: harbor2-for-team1
spec:
  generatedSecret:
    name: harbor2-for-team1.robot # Note: Avoid name conflicts with the Harbor 1 HarborRobotBinding generated secret name
  serviceAccount:
    name: default
  namespaces:
    names:
    - team1-demo
  harbor:
    project: team1
    robot:
      access:
      - action: pull
        resource: repository
    secret:
      name: harbor2
      namespace: harbor-robot-gen-system
  refreshInterval: 1h
EOF
```

After applying the configurations, we can verify that both HarborRobotBinding resources have been created successfully:

```
$ kubectl get harborrobotbinding
NAME                  READY   LASTREFRESHTIME        NEXTREFRESHTIME        AGE
harbor1-for-team1     True    2025-06-19T05:28:12Z   2025-06-19T06:28:12Z   4h
harbor2-for-team1     True    2025-06-19T05:28:12Z   2025-06-19T06:28:12Z   4h
```

Wait a few seconds for the secrets to be generated:

```bash
$ kubectl get secret -n team1-demo

NAME                              TYPE                             DATA   AGE
harbor1-team1.robot             kubernetes.io/dockerconfigjson   1      4h1m
harbor1-team1.robot.alias       kubernetes.io/dockerconfigjson   1      4h
harbor2-team1.robot             kubernetes.io/dockerconfigjson   1      4h1m
```

Since harbor.example.com currently resolves to the same IP as harbor-1.example.com, the secret named `harbor1-for-team1.robot.alias` is generated.

We can verify that the secret `harbor1-for-team1.robot.alias` uses the registry address `https://harbor.example.com` while the remaining data is identical to the `harbor1-for-team1.robot` secret:

```
$ kubectl get secret -n team1-demo harbor1-for-team1.robot.alias -ojsonpath='{ .data.\.dockerconfigjson }' | base64 -d

{"auths":{"https://harbor.example.com":{"auth":"cm9ibxxxxx==","password":"sFM0Hxxxxxhwau","username":"robot$xxxxx"}}}

$ kubectl get secret -n team1-demo harbor1-for-team1.robot -ojsonpath='{ .data.\.dockerconfigjson }' | base64 -d

{"auths":{"https://harbor-1.example.com":{"auth":"cm9ibxxxxx==","password":"sFM0Hxxxxxhwau","username":"robot$xxxxx"}}}
```

The default ServiceAccount now includes the secrets `harbor1-for-team1.robot`, `harbor2-for-team1.robot`, and `harbor1-for-team1.robot.alias`:

```bash
$ kubectl get sa -n team1-demo default -oyaml

apiVersion: v1
imagePullSecrets:
- name: harbor1-for-team1.robot
- name: harbor2-for-team1.robot
- name: harbor1-for-team1.robot.alias
kind: ServiceAccount
metadata:
  name: default
  namespace: team1-demo
```

Now we can pull images from harbor-1.example.com using the `harbor1-for-team1.robot` secret, from harbor-2.example.com using the `harbor2-for-team1.robot` secret, and from harbor.example.com using the `harbor1-for-team1.robot.alias` secret. Let's verify this functionality.

#### Step 3: Verify Image Pulling

Create Pods to test image pulling functionality:

**Note:** Ensure that both `harbor-1.example.com` and `harbor-2.example.com` have an image named `team1/busybox:stable`.

```bash
kubectl run demo --image-pull-policy=Always --image=harbor.example.com/team1/busybox:stable -n team1-demo -- sleep 3600
kubectl run demo1 --image-pull-policy=Always --image=harbor-1.example.com/team1/busybox:stable -n team1-demo -- sleep 3600
kubectl run demo2 --image-pull-policy=Always --image=harbor-2.example.com/team1/busybox:stable -n team1-demo -- sleep 3600
```

Verify that all pods are running successfully.

#### Step 4: Switch DNS to Verify Image Pulling

Now, switch the DNS record for `harbor.example.com` to point to the IP address of `harbor-2.example.com`. Wait a few minutes (the exact time depends on your TTL settings in the DNS server), and you should see the following secrets in the namespace:

```bash
$ kubectl get secret -n team1-demo

NAME                              TYPE                             DATA   AGE
harbor1-for-team1.robot           kubernetes.io/dockerconfigjson   1      4h1m
harbor2-for-team1.robot           kubernetes.io/dockerconfigjson   1      4h1m
harbor2-for-team1.robot.alias     kubernetes.io/dockerconfigjson   1      4h
```

Verify the secret contents:

```bash
$ kubectl get secret -n team1-demo harbor2-for-team1.robot -ojsonpath='{ .data.\.dockerconfigjson }' | base64 -d

{"auths":{"https://harbor-2.example.com":{"auth":"cm9ibxxxxx==","password":"sFM0Hxxxxxhwau","username":"robot$xxxxx"}}}

$ kubectl get secret -n team1-demo harbor2-for-team1.robot.alias -ojsonpath='{ .data.\.dockerconfigjson }' | base64 -d

{"auths":{"https://harbor.example.com":{"auth":"cm9ibxxxxx==","password":"sFM0Hxxxxxhwau","username":"robot$xxxxx"}}}
```

The image pull secrets in the ServiceAccount have also changed:

```bash
$ kubectl get sa -n team1-demo default -oyaml

apiVersion: v1
imagePullSecrets:
- name: harbor1-for-team1.robot
- name: harbor2-for-team1.robot
- name: harbor2-for-team1.robot.alias
kind: ServiceAccount
metadata:
  name: default
  namespace: team1-demo
```

Now we can use `harbor2-for-team1.robot.alias` to pull images from `harbor.example.com`. Let's verify this:

```bash
kubectl run demo --image-pull-policy=Always --image=harbor.example.com/team1/busybox:stable -n team1-demo -- sleep 3600
kubectl run demo2 --image-pull-policy=Always --image=harbor-2.example.com/team1/busybox:stable -n team1-demo -- sleep 3600
```

After creating the pods, you should see all pods running successfully.

### Summary

Through the above process, we have successfully demonstrated how to use Harbor Robot Account Generator in a Harbor disaster recovery scenario with DNS switching to pull images from both primary and secondary Harbor instances.

This solution provides a robust foundation for Harbor disaster recovery implementations while maintaining operational simplicity.

### Related Documentation

- [Harbor Connection Information Configuration](#harbor-connection-information-configuration)
- [Understanding HarborRobotBinding](#harborrobotbinding)