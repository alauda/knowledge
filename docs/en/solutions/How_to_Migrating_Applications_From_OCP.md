---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.18.x,4.x
id: KB250900012
---

# Migrate the application from OCP(OpenShift Container Platform) to ACP(Alauda Container Platform)

## Overview

This document provides detailed instructions for migrating applications from OpenShift Container Platform (OCP) to Alauda Container Platform (ACP) using pre-prepared OCP manifests and a combination of custom tools (`oc-convert`, `template2helm`).

## Environment Information

Alauda Container Platform:3.18.x,4.x

OCP Versions: 4.10 - 4.14

## Prerequisites

- **Alauda Container Platform Environment**: An available ACP account (e.g., LDAP) with access permissions.
- **Projects and Namespaces**: Pre-created projects and namespaces in ACP with appropriate permissions.
- **OCP Application Manifests**: Pre-prepared YAML files for OCP templates (e.g., `DeploymentConfig`, `Route`, `Service`, `HorizontalPodAutoscaler`).
- **OCP Route Replacement Strategy**:
  - **Ingress Nginx**: The ingress-nginx controller must be deployed in advance.
  - **Istio and Gateway**: Istio must be deployed on ACP, and a Gateway must be configured for the application.
- **Required Tools**:
  - `oc-convert`: A proprietary ACP tool for converting OCP-specific resources (e.g., `DeploymentConfig` and `Route` templates) into Kubernetes resources (e.g., `Deployment` and networking resources).
  - `template2helm`: A proprietary ACP tool for transforming OCP templates into Helm charts.
  - [Helm CLI](https://helm.sh/docs/intro/install/): For rendering Kubernetes YAML manifests.
  - [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/): For interacting with the ACP cluster.
- **Container Image Registry Access**: Application images must be pushed to the ACP image registry, and users must have permission to access them.

## Migrating OCP YAML to a Helm Chart

Before deploying applications to ACP, OCP YAML files must be migrated to a Helm Chart. This is a one-time conversion process. After this initial step, subsequent application releases do not require repeating the conversion. For every new release on the ACP platform, standard Helm commands can be used directly to render Kubernetes YAML from the chart and deploy it, streamlining the continuous deployment process.

The migration process is divided into the following steps:

1.  Analyzing the OCP application manifests
2.  Preparing the migration environment
3.  Converting OCP-specific resources
4.  Transforming OCP templates to Helm charts
5.  Generating and validating Kubernetes resources
6.  Deploying the application to ACP
7.  Verifying and optimizing the deployment

### 1. Analyzing OCP Application Manifests

Review the pre-prepared OCP manifests to understand the application’s structure, dependencies, and configuration.

Assume the application includes the following manifests:

- `deploymentconfig.yaml`: Defines the application’s `DeploymentConfig`.
- `route.yaml`: Specifies the OCP `Route` for external access.
- `service.yaml`: Describes the `Service` for internal communication.
- `hpa.yaml` (optional): Configures the `HorizontalPodAutoscaler` for scaling.
- `configmap.yaml`: Stores non-sensitive configuration data, such as application settings or environment variables, that can be mounted as volumes or passed to pods.
- `secret.yaml`: Manages sensitive information, such as passwords, API keys, or certificates, which are securely stored and mounted into pods for application use.

Analyze the manifests and document the following:

- **Runtime Requirements**: Container images referenced in the `DeploymentConfig`.
- **Resource Requirements**: CPU, memory, and storage specifications.
- **Service Bindings**: Connections to databases, message queues, or external services.
- **Networking**: Routes, domains, and external traffic patterns.
- **Environment Variables**: Configuration settings and secrets defined in the `DeploymentConfig`.

### 2. Preparing the Migration Environment

Place the pre-prepared manifests into a migration directory:

```bash
mkdir ocp-yaml
cp /path/to/ocp/yaml/*.yaml ocp-yaml/
```

Confirm that all necessary manifests are present and valid:

```bash
ls ocp-yaml/
# Expected output: deploymentconfig.yaml  hpa.yaml  route.yaml  service.yaml  secret.yaml  configmap.yaml
cat ocp-yaml/*.yaml

# example:
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "The full name of the service."
    required: true
  - name: SERVICE_NAME
    description: "The name of the service."
    required: true
  - name: VERSION
    description: "The version of this current service."
    required: true
  - name: REGISTRY
    description: "The registry to pull the docker image."
    required: true
  - name: APP_PROFILE
    description: "The Environment of the Deployment."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
  - name: ENV_DOMAIN
    description: "The domain of the respective environment."
    required: true
  - name: BASE_IMAGE_VERSION
    description: "image version"
    required: true
  - name: CM_VALUE
    description: "configmap name"
    required: true
  - name: OCP_CLUSTER_URL
    description: "cluster URI name"
    required: false
metadata:
  name: ${SERVICE_FULLNAME}
  labels:
    app: ${SERVICE_FULLNAME}
    name: ${SERVICE_FULLNAME}
objects:
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapvar
      namespace: ${NAMESPACE}
    data:
      module.xml: |
        hello,module.xml
      mariadb-java-client-3.5.1.jar: |
        hello,mariadb
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapfile
      namespace: ${NAMESPACE}
    data:
      module.xml: |
        hello,module.xml
      mariadb-java-client-3.5.1.jar: |
        hello,mariadb
  - apiVersion: v1
    data:
      nginx.conf: |
        events {
        }

        http {
          log_format main '$remote_addr - $remote_user [$time_local]  $status '
          '"$request" $body_bytes_sent "$http_referer" '
          '"$http_user_agent" "$http_x_forwarded_for"';
          access_log /var/log/nginx/access.log main;
          error_log  /var/log/nginx/error.log;

          server {
            listen 8443 ssl;

            root /usr/share/nginx/html;
            #index index.html;
            index 50x.html;

            server_name nginx.example.com;
            ssl_certificate /etc/nginx-server-certs/tls.crt;
            ssl_certificate_key /etc/nginx-server-certs/tls.key;
          }
        }
    kind: ConfigMap
    metadata:
      name: nginx-configmap
      namespace: ${NAMESPACE}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "The full name of the service."
    required: true
  - name: SERVICE_NAME
    description: "The name of the service."
    required: true
  - name: VERSION
    description: "The version of this current service."
    required: true
  - name: REGISTRY
    description: "The registry to pull the docker image."
    required: true
  - name: APP_PROFILE
    description: "The Environment of the Deployment."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
  - name: ENV_DOMAIN
    description: "The domain of the respective environment."
    required: true
  - name: BASE_IMAGE_VERSION
    description: "image version"
    required: true
  - name: CM_VALUE
    description: "configmap name"
    required: true
  - name: OCP_CLUSTER_URL
    description: "cluster URI name"
    required: false
metadata:
  name: ${SERVICE_FULLNAME}
  labels:
    app: ${SERVICE_FULLNAME}
    name: ${SERVICE_FULLNAME}
objects:
  - apiVersion: v1
    kind: DeploymentConfig
    metadata:
      name: ${SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
      labels:
        app: ${SERVICE_FULLNAME}
        name: ${SERVICE_FULLNAME}
    spec:
      replicas: 1
      selector:
        app: ${SERVICE_FULLNAME}
        deploymentconfig: ${SERVICE_FULLNAME}
      triggers:
        - type: "ConfigChange"
      strategy:
        type: Rolling
      template:
        metadata:
          labels:
            app: ${SERVICE_FULLNAME}
            deploymentconfig: ${SERVICE_FULLNAME}
        spec:
          containers:
            - env:
                - name: APP_PROFILE
                  value: ${APP_PROFILE}
                - name: CLUSTER_NAME
                  value: ${OCP_CLUSTER_URL}
                - name: service_name
                  value: ${SERVICE_FULLNAME}
              image: ${BASE_IMAGE_VERSION}
              imagePullPolicy: Always
              name: ${SERVICE_NAME}
              volumeMounts:
                - name: appconfig
                  mountPath: "/opt/eap/modules/org/mariadb/jdbc/main/module.xml"
                  subPath: module.xml
                - name: appconfig
                  mountPath: "/opt/eap/modules/org/mariadb/jdbc/main/mariadb-java-client-3.5.1.jar"
                  subPath: mariadb-java-client-3.5.1.jar
                - name: nginx-config
                  mountPath: /etc/nginx
                  readOnly: true
                - name: nginx-server-certs
                  mountPath: /etc/nginx-server-certs
                  readOnly: true
              ports:
                - containerPort: 8443
                  protocol: TCP
              resources:
                limits:
                  cpu: 2000m
                  memory: 4096Mi
                requests:
                  cpu: 2000m
                  memory: 4096Mi
              envFrom:
                - configMapRef:
                    name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapvar
                - secretRef:
                    name: ${NAMESPACE}-${APP_PROFILE}-secretvar
              readinessProbe:
                tcpSocket:
                  port: 8443
                initialDelaySeconds: 30
                timeoutSeconds: 2
                periodSeconds: 15
                successThreshold: 1
                failureThreshold: 3
              livenessProbe:
                tcpSocket:
                  port: 8443
                initialDelaySeconds: 30
                timeoutSeconds: 2
                periodSeconds: 15
                successThreshold: 1
                failureThreshold: 6
              startupProbe:
                tcpSocket:
                  port: 8443
                initialDelaySeconds: 30
                timeoutSeconds: 2
                periodSeconds: 15
                successThreshold: 1
                failureThreshold: 6
          volumes:
            - name: appconfig
              configMap:
                name: ${NAMESPACE}-${APP_PROFILE}-${CM_VALUE}-configmapfile
            - name: appjks
              secret:
                secretName: ${NAMESPACE}-${APP_PROFILE}-retail-secret
            - name: nginx-config
              configMap:
                name: nginx-configmap
            - name: nginx-server-certs
              secret:
                secretName: nginx-server-certs
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "The full name of the service."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
metadata: {}
objects:
  - kind: HorizontalPodAutoscaler
    apiVersion: autoscaling/v2
    metadata:
      name: ${SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
    spec:
      scaleTargetRef:
        apiVersion: apps.openshift.io/v1
        kind: DeploymentConfig
        name: ${SERVICE_FULLNAME}
      minReplicas: 1
      maxReplicas: 8
      metrics:
        - resource:
            name: memory
            target:
              type: Utilization
              averageUtilization: 80
          type: Resource
        - resource:
            name: cpu
            target:
              type: Utilization
              averageUtilization: 80
          type: Resource
---
kind: Template
apiVersion: v1
parameters:
  - name: GREEN_SERVICE_FULLNAME
    description: "The full name of the service in green route"
    required: true
  - name: SERVICE_FULLNAME
    description: "The full name of the service"
    required: true
  - name: WILDCARD_DNS
    description: "DNS of the Cluster"
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
objects:
  - kind: Route
    apiVersion: v1
    metadata:
      labels:
        app: ${GREEN_SERVICE_FULLNAME}
      name: ${GREEN_SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
      annotations:
        haproxy.router.openshift.io/balance: roundrobin
    spec:
      host: ${GREEN_SERVICE_FULLNAME}-${NAMESPACE}.${WILDCARD_DNS}
      port:
        targetPort: 8443-tcp
      tls:
        termination: passthrough
      to:
        kind: Service
        name: ${SERVICE_FULLNAME}
    status: {}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_NAME
    description: "The full name of the service in route."
    required: true
  - name: SERVICE_FULLNAME
    description: "The full name of the service in route."
    required: true
  - name: APP_DOMAIN
    description: "The evironment of this service."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
objects:
  - kind: Route
    apiVersion: v1
    metadata:
      labels:
        app: ${SERVICE_NAME}
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
      annotations:
        haproxy.router.openshift.io/balance: random
        haproxy.router.openshift.io/disable_cookies: "true"
    spec:
      host: ${APP_DOMAIN}
      port:
        targetPort: 8443-tcp
      tls:
        termination: passthrough
      to:
        kind: Service
        name: ${SERVICE_FULLNAME}
    status: {}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "The full name of the service."
    required: true
  - name: SERVICE_NAME
    description: "The name of the service."
    required: true
  - name: APP_PROFILE
    description: "The Environment of the Deployment."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
  - name: ENV_DOMAIN
    description: "The domain of the respective environment."
    required: true
  - name: HOST
    description: "The host of the domain"
    required: true
metadata:
  name: ${SERVICE_FULLNAME}
  labels:
    app: ${SERVICE_FULLNAME}
    name: ${SERVICE_FULLNAME}
objects:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-secretvar
      namespace: ${NAMESPACE}
    type: Opaque
    data:
      secretvar: aGVsbG8= # Base64 encoded "hello"
  - apiVersion: v1
    kind: Secret
    metadata:
      name: ${NAMESPACE}-${APP_PROFILE}-retail-secret
      namespace: ${NAMESPACE}
    type: Opaque
    data:
      ${HOST}.${ENV_DOMAIN}.jks: aGVsbG8= # Base64 encoded "hello"
  - apiVersion: v1
    data:
      tls.crt: "example"
      tls.key: "example"
    kind: Secret
    metadata:
      name: nginx-server-certs
      namespace: ${NAMESPACE}
    type: kubernetes.io/tls
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "The full name of the service."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
objects:
  - kind: Service
    apiVersion: v1
    metadata:
      annotations:
        openshift.io/generated-by: OpenShiftWebConsole
      labels:
        app: ${SERVICE_FULLNAME}
      name: ${SERVICE_FULLNAME}-1
      namespace: ${NAMESPACE}
    spec:
      ports:
        - name: 8443-tcp
          port: 8443
          protocol: TCP
          targetPort: 8443
        - name: metrics
          port: 9990
          protocol: TCP
          targetPort: 9990
      selector:
        app: ${SERVICE_FULLNAME}
        deploymentconfig: ${SERVICE_FULLNAME}
      sessionAffinity: None
      type: ClusterIP
    status:
      loadBalancer: {}
---
kind: Template
apiVersion: v1
parameters:
  - name: SERVICE_FULLNAME
    description: "The full name of the service."
    required: true
  - name: NAMESPACE
    description: "The version of this current name space."
    required: true
objects:
  - kind: Service
    apiVersion: v1
    metadata:
      annotations:
        openshift.io/generated-by: OpenShiftWebConsole
      labels:
        app: ${SERVICE_FULLNAME}
      name: ${SERVICE_FULLNAME}
      namespace: ${NAMESPACE}
    spec:
      ports:
        - name: 8443-tcp
          port: 8446
          protocol: TCP
          targetPort: 8443
        - name: metrics
          port: 9990
          protocol: TCP
          targetPort: 9990
      selector:
        app: ${SERVICE_FULLNAME}
        deploymentconfig: ${SERVICE_FULLNAME}
      sessionAffinity: None
      type: ClusterIP
    status:
      loadBalancer: {}

```

### 3. Converting OCP-Specific Resources

Use `oc-convert` to transform OCP-specific resources (e.g., `DeploymentConfig`, `Route`) into Kubernetes-compatible resources.

The `oc-convert` command supports the following flags:

- `-i, --input <string>`
  Specifies the path to an OpenShift Template file or directory. Can be a relative or absolute path.

- `-o, --output <string>`
  Defines the path where the converted template file will be saved.

- `--gateway <string>`
  Specifies the Istio Gateway in the format `gw-namespace/gw-name`. This option converts a Route to Istio Gateway resources.

- `--ingress <string>`
  Specifies the Ingress Nginx class name, with `nginx` as the default. This option converts a Route to an Ingress resource. The `--gateway` and `--ingress` flags cannot be used simultaneously.

The `oc-convert` tool performs the following transformations:

- Converts `DeploymentConfig` to `Deployment` by:
  - Adjusting `spec.selector` to comply with Kubernetes standards.
  - Modifying `spec.strategy` to use Kubernetes rolling updates or recreate strategies.
  - Removing OCP-specific `spec.template.triggers`.
- If `--gateway` is used, it converts `Route` to Istio-compatible resources (e.g., `VirtualService`, `DestinationRule`).
- If `--ingress` is used, it converts `Route` to Ingress-Nginx-compatible resources (e.g., `Ingress`).

#### Scenario 1: Using Ingress Nginx

```shell
# Convert Route to Ingress
oc-convert --input ocp-yaml/ --output output.yaml --ingress <ingress-class-name>
```

The output file (`output.yaml`) is a consolidated template containing all converted resources. Inspect `output.yaml` to ensure all resources are correctly transformed:

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
- apiVersion: apps/v1
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

- `DeploymentConfig` has been replaced with `Deployment`.
- `Route` has been replaced with `Ingress`:

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

#### Scenario 2: Using Istio Gateway

```shell
# Convert Route to Istio Gateway
oc-convert --input ocp-yaml/ --output output.yaml --gateway
```

Verify:

- `DeploymentConfig` has been replaced with `Deployment`.
- `Route` has been replaced with `VirtualService` and `DestinationRule`:

  ```yaml
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
  - apiVersion: networking.istio.io/v1
    kind: DestinationRule
    metadata:
      name: ${SERVICE_NAME}
      namespace: ${NAMESPACE}
    spec:
      host: ${SERVICE_FULLNAME}.${NAMESPACE}.svc.cluster.local
      trafficPolicy:
        loadBalancer:
          simple: RANDOM # or ROUND_ROBIN
  ```

- Other resources (e.g., `Service`, `HorizontalPodAutoscaler`) remain compatible.

### 4. Transforming OCP Templates to Helm Charts

Use `template2helm` to convert the consolidated template into a Helm chart.

```bash
# Convert the consolidated template to a Helm chart
template2helm convert -t output.yaml
```

This command generates an `output/` directory (with the same name as the `output.yaml` file), which contains the Helm chart structure:

- `Chart.yaml`: Metadata for the Helm chart.
- `values.yaml`: Default configuration values.
- `templates/`: Kubernetes resource templates.
- `charts/`: Dependencies (if any).

Review and, if necessary, modify the generated Helm chart:

```bash
ls output
# Expected output: Chart.yaml  values.yaml  templates/

tree output
# Example output directory
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

At this point, the OCP YAML files have been successfully migrated to an ACP application Chart. This Chart should be saved in a code repository for subsequent application releases.

## Deploying Applications from a Helm Chart

After the initial Helm Chart conversion, subsequent application releases can be managed via CI/CD pipelines. The pipeline can use the `helm template` command with updated parameters to render the Kubernetes YAML files, and then use `kubectl apply` with the rendered YAML to perform the application update.

### 1. Rendering Kubernetes YAML from the Chart

Use Helm to generate the final Kubernetes manifests for the application:

```bash
# Navigate into the output directory
cd output

# Use the --set parameter to update variables and preview
helm template . \
  --set BASE_IMAGE_VERSION=<your-registry-url> \
  --set NAMESPACE=<your-namespace> \
  --set SERVICE_FULLNAME=<your-service-name> > rendered.yaml
```

To update only a single resource of the application, render only its corresponding YAML file:

```bash
# Preview a specific YAML file
helm template . \
  --set BASE_IMAGE_VERSION=<your-registry-url> \
  --set NAMESPACE=<your-namespace> \
  --set SERVICE_FULLNAME=<your-service-name> \
  -s templates/deployment.yaml > rendered.yaml  # Preview deployment.yaml only
```

Validate the correctness of the generated YAML:

```bash
# Log in to ACP
kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name>

# Use dry-run to check for errors
kubectl apply --dry-run=client -f rendered.yaml
```

Review `rendered.yaml` to ensure:

- Correct image references.
- Correct namespace scoping.
- Valid Istio `VirtualService` and `DestinationRule` configurations.
- Appropriate resource limits and security contexts.

### 2. Deploying the Application to Alauda Container Platform

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

# Check virtualservices
kubectl get virtualservice -n <your-namespace>
```

## Conclusion

By using pre-prepared manifests and the `oc-convert`, `template2helm`, and Helm tools, the migration from OCP to ACP is simplified, enabling a smooth transition from OCP-specific resources to Kubernetes-native deployments. Following this guide allows for an efficient application migration while leveraging ACP’s advanced features, such as Istio-based networking and Argo Rollouts for deployment strategies.

For additional support, consult the Alauda Container Platform documentation or contact the ACP support team.
