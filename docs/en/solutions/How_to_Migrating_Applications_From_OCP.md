---
products:
  - Alauda Container Platform
kind:
  - Solution
---

# How to Migrating Applications from OpenShift

This guide provides detailed instructions for migrating applications from OpenShift Container Platform (OCP) to Alauda Container Platform (ACP) using pre-prepared OCP manifests and a combination of custom tools (`oc-convert`, `template2helm`) .

## Prerequisites

- **Alauda Container Platform environment**: Ensure you have an account (e.g., LDAP) and access to ACP.
- **Project and namespaces**: Pre-created projects and namespaces in ACP with appropriate permissions.
- **OCP application manifests**: Pre-prepared YAML files for OCP templates (e.g., `DeploymentConfig`, `Route`, `Service`, `HorizontalPodAutoscaler`).
- **How to replace the OCP Route**:

  - **Ingress Nginx**: Deploy the ingress-nginx controller in advance.
  - **Istio and gateway**: Deploy Istio on ACP and set up a gateway for the application.

- **Required tools**:
  - `oc-convert`: ACP-proprietary tool for converting OCP-specific resources e.g. `DeploymentConfig` and `Route` templates to Kubernetes resources e.g. `Deployment` and networking resources.
  - `template2helm`: ACP-proprietary tool for transforming OCP templates into Helm charts.
  - [Helm CLI](https://helm.sh/docs/intro/install/): For rendering Kubernetes YAML manifests.
  - [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/): For interacting with the ACP cluster.
- **Container registry access**: Before performing the application migration, you need to ensure that the application images have been pushed to the ACP image repository and that users have permission to access them.

## Migrating OCP YAML to Helm Chart

Before you deploy applications to ACP, you need to migrate application OCP YAML to Helm Chart. This is a one-time conversion process. After this initial step, you no longer need to repeat the conversion for subsequent application releases. Instead, for every new release to our ACP platform, you can directly use standard Helm commands to render the Kubernetes YAML from the chart and deploy it. This significantly streamlines your continuous deployment process.

The migration process is divided into the following steps:

1. Analyzing the OCP application manifests
2. Preparing for migration
3. Converting OCP-specific resources
4. Transforming OCP templates to Helm charts
5. Generating and validate Kubernetes resources
6. Deploying the application to ACP
7. Verifying and optimize the deployment

### 1. Analyzing the OCP application manifests

Review the pre-prepared OCP manifests to understand the application’s structure, dependencies, and configuration.

Assume your application has the following manifests:

- `deploymentconfig.yaml`: Defines the application’s `DeploymentConfig`.
- `route.yaml`: Specifies the OCP `Route` for external access.
- `service.yaml`: Describes the `Service` for internal communication.
- `hpa.yaml` (optional): Configures the `HorizontalPodAutoscaler` for scaling.
- `configmap.yaml`: Stores non-sensitive configuration data, such as application settings or environment variables, that can be mounted as volumes or passed to pods.
- `secret.yaml`: Manages sensitive information, such as passwords, API keys, or certificates, securely stored and mounted to pods for application use.

Analyze the manifests and document:

- **Runtime requirements**: Container images referenced in the `DeploymentConfig`.
- **Resource requirements**: CPU, memory, and storage specifications.
- **Service bindings**: Connections to databases, message queues, or external services.
- **Networking**: Routes, domains, and external traffic patterns.
- **Environment variables**: Configuration settings and secrets defined in the `DeploymentConfig`.

### 2. Preparing for migration

Place the pre-prepared manifests in a migration directory:

```bash
mkdir ocp-yaml
cp /path/to/ocp/yaml/*.yaml ocp-yaml/
```

Confirm that all necessary manifests are present and valid:

```bash
ls ocp-yaml/
# Expected output: deploymentconfig.yaml  hpa.yaml  route.yaml  service.yaml  secret.yaml  configmap.yaml
```

### 3. Converting OCP-specific resources

Use `oc-convert` to transform OCP-specific resources (e.g., `DeploymentConfig`, `Route`) into Kubernetes-compatible resources.

The `oc-convert` command supports the following flags:

- `-i, --input <string>`
  Specifies the path to an OpenShift Template file or directory. Can be a relative or absolute path.

- `-o, --output <string>`
  Defines the path where the converted template file will be saved.

- `--gateway <string>`
  Specifies the Istio Gateway in the format `gw-namespace/gw-name`, where `gatewaynamespace` and `gatewayname` are concatenated with a `/`. Convert route to Istio Gateway resources.

- `--ingress <string>`

  Specifies the Ingress Nginx class name, with nginx as the default. Convert route to Ingress resource. Cannot use both --gateway and --ingress flags simultaneously.

The `oc-convert` tool performs the following transformations:

- Converts `DeploymentConfig` to `Deployment` by:
  - Adjusting `spec.selector` to Kubernetes standards.
  - Modifying `spec.strategy` to use Kubernetes rolling updates or recreate strategies.
  - Removing OCP-specific `spec.template.triggers`.
- If use `--gateway` , will converts `Route` to Istio-compatible resources (e.g., `VirtualService`, `DestinationfRule`) for ACP networking.
- If use `--ingress`, will converts `Route` to IngressNginx-compatible resources (e.g., `Ingress`) for ACP networking.

#### 1. Use Ingress Nginx

```shell
# Convert route to Ingress
oc-convert --input ocp-yaml/ --output output.yaml --ingress <ingress-class-name>
```

The output (`output.yaml`) is a consolidated template containing all converted resources. Inspect `output.yaml` to ensure all resources are correctly transformed:

```yaml
# cat output.yaml

kind: Template
apiVersion: v1
parameters:
- name: SERVICE_FULLNAME
  description: The full name of the service
  required: true
- name: ...
metadata: {}
objects:
- apiVersion: v1
  kind: Deployment
  metadata:
    ...
  spec:
    ...
- apiVersion: autoscaling/v2
  kind: HorizontalPodAutoscaler
  ...
- apiVersion: networking.k8s.io/v1
  kind: Ingress
  ...
```

Verify:

- `DeploymentConfig` is replaced with `Deployment`.
- `Route` is replaced with `Ingress` :

  ```yaml
  - apiVersion: networking.k8s.io/v1
    kind: Ingress
    metadata:
      annotations:
        nginx.ingress.kubernetes.io/backend-protocol: HTTPS
        nginx.ingress.kubernetes.io/load-balance: round_robin
        nginx.ingress.kubernetes.io/ssl-passthrough: "true"
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      ingressClassName: ${NGINX_INGRESS_NAME}
      rules:
        - host: ${APP_DOMAIN}
          http:
            paths:
              - backend:
                  service:
                    name: ${SERVICE_FULLNAME}
                    port:
                      number: 8443
                path: /
                pathType: Prefix
      tls:
        - hosts:
            - ${APP_DOMAIN}
  ```

#### 2. Use Istio Gateway

```shell
# Convert route to Istio Gateway
oc-convert --input ocp-yaml/ --output output.yaml --gateway
```

Verify:

- `DeploymentConfig` is replaced with `Deployment`.
- `Route` is replaced with `VirtualService` and `DestinationRule` :

  ```
  - apiVersion: networking.istio.io/v1
    kind: VirtualService
    metadata:
      labels:
        cpaas.io/gw-name: ${ISTIO_GATEWAY_NAME}
        cpaas.io/gw-ns: ${ISTIO_GATEWAY_NAMESPACE}
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      gateways:
      - ${ISTIO_GATEWAY_NAMESPACE}/${ISTIO_GATEWAY_NAME}
        hosts:
        - ${APP_DOMAIN}
        tls:
        - match:
            - port: 443
              sniHosts:
                - ${APP_DOMAIN}
              route:
            - destination:
                host: ${SERVICE_FULLNAME}.${NAMESPACE}.svc.cluster.local
                port:
                  number: 8443
              weight: 100
  - apiVersion: v1
    kind: DestinationRule
    metadata:
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      host: ${SERVICE_FULLNAME}.${NAMESPACE}.svc.cluster.local
      trafficPolicy:
        loadBalancer:
          simple: RANDOM   # ROUND_ROBIN
  ```

- Other resources (e.g., `Service`, `HorizontalPodAutoscaler`) remain compatible.

### 4. Change image registry address

Change the image registry address to ACP registry address. Update the spec.containers[*].image field in your Deployment, StatefulSet, Pod, and other resource definitions.

### 5. Transforming OCP templates to Helm Charts

Use `template2helm` to convert the unified template into a Helm chart.

```bash
# Convert the unified template to a Helm chart
template2helm convert -t output.yaml
```

This command generates a directory (`output/`: same name with the output.yaml) containing the Helm chart structure, including:

- `Chart.yaml`: Metadata for the Helm chart.
- `values.yaml`: Default configuration values.
- `templates/`: Kubernetes resource templates.
- `charts/`: Dependencies (if any).

Review and modify the generated Helm chart:

```bash
ls output
# Expected output: Chart.yaml  values.yaml  templates/

tree output
# example output dir
output
├── Chart.yaml
├── templates
│   ├── configmap.yaml
│   ├── deployment.yaml
│   ├── destinationrule.yaml
│   ├── horizontalpodautoscaler.yaml
│   ├── secret.yaml
│   ├── service.yaml
│   └── virtualservice.yaml
└── values.yaml
```

Now you have migrated OCP YAML file to ACP application chart, and you can save this chart in your code repository for the subsequent application releases.

## Deploying applications from Helm Chart

Following the initial Helm Chart conversion, you may release applications via your CI/CD pipelines. The pipeline can use the helm template command, providing updated parameters. This command renders the Kubernetes YAML files. Then uses kubectl apply with this rendered YAML to perform the application update.

### 1. Rendering Kubernetes YAML from Chart

Use Helm to generate the final Kubernetes manifests of the application:

```bash
# Use the helm template command in the output directory
cd output

# Use the --set parameter to update variables and preview
helm template . \
  --set BASE_IMAGE_VERSION=<your-registry-url> \
  --set NAMESPACE=<your-namespace> \
  --set SERVICE_FULLNAME=<your-service-name> > rendered.yaml
```

If you want to just update one resource of the application, you could just render only one YAML file.

```bash
# Preview a specific YAML file
helm template . \
  --set BASE_IMAGE_VERSION=<your-registry-url> \
  --set NAMESPACE=<your-namespace> \
  --set SERVICE_FULLNAME=<your-service-name> \
  -s templates/deployment.yaml > rendered.yaml  # Preview deployment.yaml
```

Validate the generated YAML for correctness:

```bash
# log in to ACP
kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name>

# Dry-run to check for errors
kubectl apply --dry-run=client -f rendered.yaml
```

Review `rendered.yaml` to ensure:

- Correct image references.
- Proper namespace scoping.
- Valid Istio `VirtualService` and `DestinationRule` configurations.
- Appropriate resource limits and security contexts.

### 2. Deploying the application to Alauda Container Platform

Deploy the rendered manifests:

```bash
# Apply the resources
kubectl apply -f rendered.yaml
```

Check the status of the deployed resources:

```bash
# Check deployments
kubectl get deployments -n <your-namespace>

# Check pods
kubectl get pods -n <your-namespace>

# Check services
kubectl get svc -n <your-namespace>

# Check virtualservice
kubectl get virtualservice -n <your-namespace>
```

## Conclusion

Migrating from OCP to ACP using pre-prepared manifests, `oc-convert`, `template2helm`, and Helm simplifies the transition from OCP-specific resources to Kubernetes-native deployments. By following this guide, you can efficiently migrate applications while leveraging ACP’s advanced features, such as Istio-based networking and Argo Rollouts for deployment strategies.

For additional support, consult the Alauda Container Platform documentation or contact the ACP support team.
