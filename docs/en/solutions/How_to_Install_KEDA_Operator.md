---
kind:
   - How To
products:
  - Alauda Container Platform
ProductsVersion:
   - 4.x
id: none
---

# How to Install KEDA Operator

## Overview
**KEDA** is a Kubernetes-based Event Driven Autoscaler. [Home Page](https://keda.sh/). With KEDA, you can drive the scaling of any container in Kubernetes based on the number of events needing to be processed.

### Introduction
KEDA is a single-purpose and lightweight component that can be added into any Kubernetes cluster. KEDA works alongside standard Kubernetes components like the [Horizontal Pod Autoscaler](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/) and can extend functionality without overwriting or duplication. With KEDA, you can explicitly map the apps you want to use event-driven scale, with other apps continuing to function. This makes KEDA a flexible and safe option to run alongside any number of any other Kubernetes applications or frameworks.

See the official documentation for more details: [Keda Documentation](https://keda.sh/docs/)

### Advantages

**Core advantages of KEDA:**

- **Autoscaling Made Simple:** Bring rich scaling to every workload in your Kubernetes cluster.
- **Event-driven:** Intelligently scale your event-driven application.
- **Built-in Scalers:** Catalog of 70+ built-in scalers for various cloud platforms, databases, messaging systems, telemetry systems, CI/CD, and more.
- **Multiple Workload Types:** Support for variety of workload types such as deployments, jobs & custom resources with **/scale** sub-resource.
- **Reduce environmental impact:** Build sustainable platforms by optimizing workload scheduling and scale-to-zero.
- **Extensible:** Bring-your-own or use community-maintained scalers.
- **Vendor-Agnostic:** Support for triggers across variety of cloud providers & products.
- **Azure Functions Support:** Run and scale your Azure Functions on Kubernetes in production workloads.

### How KEDA works
KEDA monitors external event sources and adjusts your app's resources based on the demand. Its main components work together to make this possible:

1. **KEDA Operator** keeps track of event sources and changes the number of app instances up or down, depending on the demand.
2. **Metrics Server** provides external metrics to Kubernetes' HPA so it can make scaling decisions.
3. **Scalers** connect to event sources like message queues or databases, pulling data on current usage or load.
4. **Custom Resource Definitions (CRDs)**define how your apps should scale based on triggers like queue length or API request rates.

In simple terms, KEDA listens to what's happening outside Kubernetes, fetches the data it needs, and scales your apps accordingly. It's efficient and integrates well with Kubernetes to handle scaling dynamically.

#### KEDA Custom Resource Definitions (CRDs)

KEDA uses **Custom Resource Definitions (CRDs)** to manage scaling behavior:

- **ScaledObject**: Links your app (like a Deployment or StatefulSet) to an external event source, defining how scaling works.
- **ScaledJob**: Handles batch processing tasks by scaling Jobs based on external metrics.
- **TriggerAuthentication**: Provides secure ways to access event sources, supporting methods like environment variables or cloud-specific credentials.

These CRDs give you control over scaling while keeping your apps secure and responsive to demand.

**ScaledObject Example**:

The following example targets CPU utilization of entire pod. If the pod has multiple containers, it will be sum of all the containers in it.
```yaml
kind: ScaledObject
metadata:
  name: cpu-scaledobject
  namespace: <your-namespace>
spec:
  scaleTargetRef:
    name: <your-deployment>
  triggers:
  - type: cpu
    metricType: Utilization # Allowed types are 'Utilization' or 'AverageValue'
    metadata:
      value: "50"
```

## Installation

### Upload KEDA Operator package
Download the KEDA installation file: `keda.stable.*.tgz`

Download the latest version of the `violet` tool.
Use the `violet` command to publish to the platform repository:
```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password=<platform-admin-password> keda.stable.*.tgz
```
Parameter description:
* `--platform-address`: ACP Platform address.
* `--platform-username`: ACP Platform administrator username.
* `--platform-password`: ACP Platform administrator password.

### Installing via Command Line

#### Installing KEDA Operator
Create namespace for KEDA operator if it does not exist:
```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: "keda"
EOF
```

Run the following command to install KEDA Operator in your target cluster:
```bash
kubectl apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  annotations:
    cpaas.io/target-namespaces: ""
  labels:
    catalog: platform
  name: keda
  namespace: keda
spec:
  channel: stable
  installPlanApproval: Automatic
  name: keda
  source: custom
  sourceNamespace: cpaas-system
  startingCSV: keda.v2.17.2
EOF
```
Configuration Parameters:

| **Parameter**   | **Recommended Configuration**       |
| :------- | :------------------------------------------|
| **metadata.name**   | `keda`: The Subscription name is set to **keda**.   |
| **metadata.namespace**   | `keda`: The Subscription namespace is set to **keda**.   |
| **spec.channel** | `stable`: The default Channel is set to **stable**.                          |
| **spec.installPlanApproval** | `Automatic`: The **Upgrade** action will be executed automatically. |
| **spec.name** | `keda`: The operator package name, must be **keda**.  |
| **spec.source** | `custom`: The catalog source of keda operator, must be **custom**.   |
| **spec.sourceNamespace** | `cpaas-system`: The namespace of catalog source, must be **cpaas-system**.   |
| **spec.startingCSV** | `keda.v2.17.2`: The starting CSV name of keda operator.   |

#### Creating the KedaController instance

Create KedaController resource named keda in namespace keda:
```bash
kubectl apply -f - <<EOF
apiVersion: keda.sh/v1alpha1
kind: KedaController
metadata:
  name: keda
  namespace: keda
spec:
  admissionWebhooks:
    logEncoder: console
    logLevel: info
  metricsServer:
    logLevel: "0"
  operator:
    logEncoder: console
    logLevel: info
  serviceAccount: null
  watchNamespace: ""
EOF
```

### Installing via Web Console

#### Installing KEDA Operator

1. Log in, and navigate to the **Administrator** page.
2. Click **Marketplace** > **OperatorHub**.
3. Find the **KEDA** operator, click **Install**, and enter the **Install** page.

Configuration Parameters:

| **Parameter**   | **Recommended Configuration**       |
| :------- | :------------------------------------------|
| **Channel**   | `stable`: The default Channel is set to **stable**.   |
| **Version**   | Please select the latest version.|
| **Installation Mode** | `Cluster`: A single Operator is shared across all namespaces in the cluster for instance creation and management, resulting in lower resource usage.                          |
| **Installation Location** | `Recommended`: It will be created automatically if it does not exist. |
| **Upgrade Strategy** | Please select the `Auto`. <ul><li>the **Upgrade** action will be executed automatically.</li></ul> |

4. On the **Install** page, select default configuration, click **Install**, and complete the installation of the **KEDA** Operator.

#### Creating the KedaController instance

1. Click on **Marketplace** > **OperatorHub**.

2. Find the installed **KEDA** operator, navigate to **All Instances**.

3. Click **Create Instance** button, and click **KedaController** card in the resource area.

4. On the parameter configuration page for the instance, you may use the default configuration unless there are specific requirements.

5. Click **Create**.

### Verification

After the instance is successfully created, wait for a few minutes, then checking if the KEDA components is already running with the command:

```bash
kubectl get pods -n keda -w
NAME                                     READY   STATUS    RESTARTS      AGE
keda-admission-56f9d8f45b-f67fg          1/1     Running   0             1h
keda-metrics-apiserver-7989cf4c9-9ljzt   1/1     Running   0             1h
keda-olm-operator-58f695f5fd-p2kh4       1/1     Running   0             1h
keda-operator-5c779f7f7-8b6h5            1/1     Running   0             1h
```

### Additional Scenarios

#### Integrating ACP Log Collector

- Ensure **ACP Log Collector Plugin** is installed in target cluster. Refer to <ExternalSiteLink name="logs" href="/install_log.html#install-alauda-container-platform-log-collector-plugin" children="Install Alauda Container Platform Log Collector Plugin" />。.
- Enable the **Platform** logging switch when installing the **ACP Log Collector Plugin**.
- Use the following command to add label to the **keda** namespace:
    ```bash
    kubectl label namespace keda cpaas.io/product=Container-Platform --overwrite
    ```

### Uninstalling KEDA Operator

#### Removing the KedaController instance
```bash
kubectl delete kedacontroller keda -n keda
```

#### Uninstalling KEDA Operator via CLI
```bash
kubectl delete subscription keda -n keda
```

#### Uninstalling KEDA Operator via Web Console

To uninstall KEDA Operator, click on **Marketplace** > **OperatorHub**, select installed operator **KEDA**, and click **Uninstall**.
