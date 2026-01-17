---
kind:
   - Solution
products:
  - Alauda Application Services
ProductsVersion:
   - 4.x
---

# How to Deploy and Use Konveyor

## Overview

Konveyor is a CNCF (Cloud Native Computing Foundation) project that provides a modular platform for application modernization. It supports the entire lifecycle of modernization: discovery, assessment, analysis, and execution. This guide covers deploying the Konveyor Hub (Tackle) platform and its core components.

## Prerequisites

- Kubernetes cluster with kubectl access
- StorageClass that supports ReadWriteMany (RWX) access mode
- StorageClass for RWO volumes (for databases)
- (Optional) LoadBalancer or Ingress Controller for external access

## Install Konveyor Operator

Download the Konveyor Operator plugin from [Alauda Cloud Console](https://cloud.alauda.io/) Marketplace, and according [Upload Packages](https://docs.alauda.io/container_platform/4.2/extend/upload_package.html) to upload the plugin to cluster.

## Deploy Konveyor Hub (Tackle)

### Create Tackle Instance

Deploy the Tackle platform by creating a Tackle CR. The Tackle instance must be deployed in the same namespace as the konveyor-operator.

```yaml
cat << EOF | kubectl create -f -
apiVersion: tackle.konveyor.io/v1alpha1
kind: Tackle
metadata:
  name: tackle
  namespace: konveyor-tackle
spec:
  feature_auth_required: true
  feature_isolate_namespace: true
  feature_analysis_archiver: true
  hub_database_volume_size: 5Gi
  hub_bucket_volume_size: 100Gi
  rwx_supported: true
  hub_bucket_storage_class: nfs        # Replace with your RWX StorageClass
  rwo_storage_class: sc-topolvm         # Replace with your RWO StorageClass
  cache_storage_class: nfs
  cache_data_volume_size: 100Gi
EOF
```

### Verify Deployment

Check the status of the pods in the `konveyor-tackle` namespace:

```bash
kubectl get pods -n konveyor-tackle
```

Ensure all pods are in `Running` or `Completed` state before proceeding.

> [!WARNING]
> The Tackle instance must be deployed in the same namespace as the `konveyor-operator`. If you deploy it in a different namespace, some resources created by the operator (such as PersistentVolumeClaims, ConfigMaps, Secrets, and ServiceAccounts) might not be automatically deleted when the Tackle custom resource is removed. In that case, you must manually clean up these resources in the affected namespaces, for example:
>
> ```bash
> # Delete common resources labeled for the Tackle instance
> kubectl delete pvc,configmap,secret,sa -l app.kubernetes.io/instance=tackle -n konveyor-tackle
> ```

### Configuration Options

| Name | Default | Description |
| --- | --- | --- |
| `spec.feature_auth_required` | `true` | Enable Keycloak authentication (set `false` for single user/no auth) |
| `spec.feature_isolate_namespace` | `true` | Enable namespace isolation via network policies |
| `spec.feature_analysis_archiver` | `true` | Automatically archive old analysis reports when a new one is created |
| `spec.rwx_supported` | `true` | Whether RWX volumes are supported in the cluster |
| `spec.hub_database_volume_size` | `5Gi` | Size requested for Hub database volume |
| `spec.hub_bucket_volume_size` | `100Gi` | Size requested for Hub bucket volume |
| `spec.keycloak_database_data_volume_size` | `1Gi` | Size requested for Keycloak DB volume |
| `spec.cache_data_volume_size` | `100Gi` | Size requested for Tackle Cache volume |
| `spec.cache_storage_class` | N/A | StorageClass requested for Tackle Cache volume |
| `spec.hub_bucket_storage_class` | N/A | StorageClass requested for Tackle Hub Bucket volume (RWX) |
| `spec.rwo_storage_class` | N/A | StorageClass requested for RWO database volumes |

## Access Tackle UI

### Quick Access via Port-Forward

1. Set up port forwarding:

   ```bash
   kubectl -n konveyor-tackle port-forward service/tackle-ui 8080:8080
   ```

2. Open [http://127.0.0.1:8080](http://127.0.0.1:8080) in your browser.

### Initialize Admin Account

The built-in Keycloak generates a random password on startup. This is the Keycloak root password, stored in the `tackle-keycloak-sso` secret.

1. Retrieve Keycloak admin credentials:

   ```bash
   # Get username (default: admin)
   kubectl -n konveyor-tackle get secret tackle-keycloak-sso -o jsonpath='{.data.username}' | base64 -d
   
   # Get password
   kubectl -n konveyor-tackle get secret tackle-keycloak-sso -o jsonpath='{.data.password}' | base64 -d
   ```

2. Login to Keycloak admin console at [http://127.0.0.1:8080/auth/admin/](http://127.0.0.1:8080/auth/admin/)

3. Reset the Tackle admin password:
   - Select the **tackle** Realm from the dropdown (not Master Realm)
   - Click **Users** in the left menu
   - Find and select the **admin** user
   - Click the **Credentials** tab
   - Enter a new password (e.g., `admin@123`)
   - Disable **Temporary** toggle
   - Click **Reset Password**

4. Login to Tackle at [http://127.0.0.1:8080](http://127.0.0.1:8080) using the admin user and new password.

### Secure Access via Ingress (Production)

Port-forward is only for temporary access. For production, configure Ingress with TLS.

#### Ingress Prerequisites

- A domain name (e.g., `tackle.example.com`)
- LoadBalancer service deployed (see [ALB deployment guide](https://docs.alauda.io/container_platform/4.1/configure/networking/how_to/alb/deploy_alb.html))
- cert-manager installed

#### Create TLS Certificate

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: tackle-ssl-cert
  namespace: konveyor-tackle
spec:
  commonName: tackle.example.com
  dnsNames:
    - tackle.example.com
  issuerRef:
    kind: ClusterIssuer
    name: cpaas-ca              # Replace with your Issuer
  secretName: tackle-tls-secret
  usages:
    - server auth
    - client auth
```

#### Create Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: HTTP
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
  name: tackle-ui-tls-ingress
  namespace: konveyor-tackle
spec:
  ingressClassName: nginx    # Replace with your Ingress Class
  rules:
    - host: tackle.example.com
      http:
        paths:
          - backend:
              service:
                name: tackle-ui
                port:
                  number: 8080
            path: /
            pathType: Prefix
  tls:
    - hosts:
        - tackle.example.com
      secretName: tackle-tls-secret
```

> [!NOTE]
> Replace `tackle.example.com` with your actual domain.

Access Tackle at `https://tackle.example.com`.

## Enable KAI (Konveyor AI)

KAI uses AI services to provide AI-powered code migration assistance. It supports multiple providers and models.

### Supported Providers and Models

| Provider (`kai_llm_provider`) | Model (`kai_llm_model`) |
| --- | --- |
| `openai` | `gpt-4`, `gpt-4o`, `gpt-4o-mini`, `gpt-3.5-turbo` |
| `azure_openai` | `gpt-4`, `gpt-35-turbo` |
| `bedrock` | `anthropic.claude-3-5-sonnet-20241022-v2:0`, `meta.llama3-1-70b-instruct-v1:0` |
| `google` | `gemini-2.0-flash-exp`, `gemini-1.5-pro` |
| `ollama` | `llama3.1`, `codellama`, `mistral` |
| `groq` | `llama-3.1-70b-versatile`, `mixtral-8x7b-32768` |
| `anthropic` | `claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307` |

### Enable KAI in Tackle

1. Update the Tackle configuration:

   ```yaml
   apiVersion: tackle.konveyor.io/v1alpha1
   kind: Tackle
   metadata:
     name: tackle
     namespace: konveyor-tackle
   spec:
     kai_solution_server_enabled: true
     kai_llm_provider: openai              # Choose your provider
     kai_llm_model: gpt-4o-mini            # Choose your model
   ```

2. Create API credentials secret:

   **For OpenAI:**

   ```bash
   kubectl create secret generic kai-api-keys -n konveyor-tackle \
     --from-literal=OPENAI_API_BASE='https://api.openai.com/v1' \
     --from-literal=OPENAI_API_KEY='<YOUR_OPENAI_KEY>'
   ```

   **For Google:**

   ```bash
   kubectl create secret generic kai-api-keys -n konveyor-tackle \
     --from-literal=GOOGLE_API_KEY='<YOUR_GOOGLE_API_KEY>'
   ```

3. Force the operator to reconcile and pick up the new credentials:

   ```bash
   kubectl patch tackle tackle -n konveyor-tackle --type=merge -p \
     '{"metadata":{"annotations":{"konveyor.io/force-reconcile":"'"$(date +%s)"'"}}}'
   ```

## Konveyor Components Overview

Konveyor provides a modular architecture for application modernization:

| Component | Description |
| --- | --- |
| **Konveyor Hub** | Central control plane providing unified application inventory, assessment module (risk evaluation), and analysis module (static code analysis). Implements RBAC with Administrator, Architect, and Migrator roles. |
| **Kantra & Analyzer-LSP** | CLI tool for offline static analysis. Analyzer-LSP integrates into IDEs (VSCode) via Language Server Protocol for real-time migration issue detection. |
| **Konveyor AI (KAI)** | RAG-based AI assistant for automated code remediation. Uses Solved Incident Store for context-aware code patch generation. |
| **Move2Kube** | Automates conversion from Cloud Foundry/OpenShift to Kubernetes. Three phases: Collect, Plan, Transform. Generates Dockerfiles, K8s manifests, Helm Charts, and Tekton Pipelines. |
| **Forklift** | VM migration tool for moving VMs from VMware vSphere, oVirt, or OpenStack to KubeVirt. |
| **Crane** | Kubernetes-to-Kubernetes migration tool for cluster upgrades or cross-distribution migrations. Handles PV data sync with Restic or VolSync. |

## Reference

- [Konveyor Official Documentation](https://konveyor.io/docs/konveyor/)
- [Konveyor Admin Tasks](https://konveyor.io/docs/konveyor/admintasks/)
- [Konveyor Operator Repository](https://github.com/konveyor/operator)
