---
products:
   - Alauda Container Platform
kind:
   - Solution
ProductsVersion:
   - 4.x
id: 虚位以待
---

# How to Install Crossplane

## Overview
Crossplane is a control plane framework for platform engineering. Crossplane lets you build control planes to manage your cloud native software. It lets you design the APIs and abstractions that your users use to interact with your control planes.

Crossplane has a rich ecosystem of extensions that make building a control plane faster and easier. It’s built on Kubernetes, so it works with all the Kubernetes tools you already use.

Crossplane’s key value is that it unlocks the benefits of building your own Kubernetes custom resources without having to write controllers for them.

Official Documentation:
- **Main Documentation**: [https://www.crossplane.io/](https://www.crossplane.io/)

# Installation

## Upload
Download the crossplane installation file: `crossplane-ALL.2.x.tgz`

Download the latest version of the `violet` tool.
Use the `violet` command to publish to the platform repository:
```bash
violet push --platform-address=<platform-access-address> --platform-username=<platform-admin-name> --platform-password=<platform-admin-password> crossplane-ALL.2.x.tgz
```
Parameter description:
* `--platform-address`: ACP Platform address.
* `--platform-username`: ACP Platform administrator username.
* `--platform-password`: ACP Platform administrator password.

After the `violet` command execution is complete, navigate to the details page of [public-charts] at [Administrator] -> [Marketplace] -> [Chart Repositories]. You will see the listed Crossplane chart.

## Install

### Prerequisites
- Navigate to [Projects] page, click `Create Project` button.
- Provide the following information:
  - Name: `crossplane`
  - Cluster: Select the cluster where Crossplane will be installed.
- Click `Create Project` button to create the project.
- Navigate to [Projects] -> [Namespace] page, click `Create Namespace` button.
- Provide the following information:
  - Cluster: Select the cluster where Crossplane will be installed.
  - Namespace: `crossplane-system`
- Click `Create` button to create the namespace.

### Install Crossplane
To install Crossplane, follow the steps below:
- Navigate to the details page of the Crossplane chart at [Administrator] -> [Marketplace] -> [Chart Repositories].
- Click [Deploy Template] to install Crossplane chart.
- Provide the following information:
   - Name: `crossplane`
   - Project: `crossplane`
   - Namespace: `crossplane-system`
   - Chart Version: `2.x.x`
   - Custom Values:
    ```yaml
    replicas: 2
    image:
      repository: <platform-registry-address>/3rdparty/crossplane/crossplane
    ```
    (Replace <platform-registry-address> with your actual registry address. The platform registry address can be obtained from the `global` cluster details page at: [Administrator] -> [Clusters] -> [Clusters] -> [global])

- Click [Deploy] to start the installation.
- After the installation is complete, you can verify the installation by running the following command:
    ```bash
    $ kubectl get pods -n crossplane-system
    NAME                                       READY   STATUS    RESTARTS   AGE
    crossplane-6d67f8cd9d-g2gjw                1/1     Running   0          26m
    crossplane-rbac-manager-86d9b5cf9f-2vc4s   1/1     Running   0          26m
    ```
If the installation is successful, you will see the Crossplane components running in the `crossplane-system` namespace.

### Feature flags
Crossplane introduces new features behind feature flags. By default alpha features are off. Crossplane enables beta features by default. To enable a feature flag, set the args value in the Helm chart. Available feature flags can be directly found by running crossplane core start --help, or refer to the Crossplane documentation [feature-flags](https://docs.crossplane.io/latest/get-started/install/#feature-flags).


## Uninstall Crossplane
To uninstall Crossplane, follow the steps below:
- Navigate to the details page of the `crossplane` application at [Alauda Container Platform] -> [Applications] -> [Applications].
- Click [Actions] -> [Delete] to start the uninstallation.
- After the uninstallation is complete, you can verify the uninstallation by running the following command:
    ```bash
    $ kubectl get pods -n crossplane-system
    No resources found in crossplane-system namespace.
    ```
