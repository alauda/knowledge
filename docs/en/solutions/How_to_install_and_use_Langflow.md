---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
id: KB1762309013-4C37
---
# Langflow

## Overview

Langflow is an open-source low-code tool for visually building and deploying AI agents and workflows. It provides a drag-and-drop editor to quickly create, test, and iterate AI applications. Langflow is built on Python and includes a FastAPI backend and a React-based visual editor. It supports SQLite by default and recommends PostgreSQL in production.

It contains the following main components:
- **Frontend Interface**: React-based visual editor with drag-and-drop flow building and real-time testing
- **Backend Service**: FastAPI-based web service providing REST API and MCP (Model Context Protocol) support
- **Database**: Supports SQLite (default) and PostgreSQL (recommended for production)

## Core Concepts

Langflow is built around several core concepts: **Flows** (visual workflows organizing AI logic), **Components** (reusable functional units), **Agents** (intelligent agents with tool calling and reasoning capabilities), and **API/MCP** integration (REST API and Model Context Protocol support).

Langflow provides a drag-and-drop visual interface for building AI applications with real-time testing capabilities and an extensive template library. It supports multiple LLM providers, embedding models, and vector databases, enabling flexible multi-model configurations. The platform offers both IDE mode for development and runtime mode for production deployment, making it suitable for both experimentation and enterprise use.

For detailed information about core concepts, features, and usage, please refer to the [official documentation](https://docs.langflow.org/).

## Documentation and References

- **Official Documentation**: [https://docs.langflow.org/](https://docs.langflow.org/)
- **GitHub Repository**: [https://github.com/langflow-ai/langflow](https://github.com/langflow-ai/langflow)

# Langflow Deployment Guide

This section provides detailed instructions on how to deploy Langflow to a Kubernetes cluster and common configuration parameters.

## Publishing

Download the Langflow installation file: `langflow-operator.alpha.ALL.v1.10.1.tgz`

Use the violet command to publish to the platform repository:
```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password langflow-operator.alpha.ALL.v1.10.1.tgz
```

Starting with v1.10.1, Langflow is packaged as an OLM `OperatorBundle` (chart-wrap of the upstream `langflow-ai/langflow-helm-charts/langflow-ide` chart), not a raw Helm chart. Installation goes through OperatorHub and a `Langflow` custom resource, not the Applications / Catalog picker.

## Prerequisites

Before installing Langflow, the target workload cluster must have:

- **A default StorageClass** — Langflow's backend uses SQLite by default, backed by an RWO PVC that requests the cluster's default StorageClass. Without a default, `data-langflow-service-0` will stay `Pending` and the backend pod cannot schedule. Set one with:

  ```bash
  kubectl get sc
  kubectl patch sc <name> -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
  ```

  If you want to pin a specific StorageClass instead of relying on the cluster default, set `spec.langflow.backend.sqlite.volume.existingStorageClassName` on the `Langflow` custom resource (see [Configure Storage](#1-configure-storage)).

- **(Optional, for Gateway API external access)** Envoy Gateway installed on the cluster with a `GatewayClass` whose `controllerName` contains `envoy`. Without one, users can only reach Langflow via `kubectl port-forward` or by opening a NodePort/LoadBalancer Service manually.

## Deployment

### Prepare Storage

Langflow uses SQLite by default with an RWO PVC (1Gi). For production, PostgreSQL is recommended (see [Configure Database](#2-configure-database)). The cluster must have a default StorageClass or the user must set `existingStorageClassName` explicitly.

### Prepare Database (Optional)

#### Using SQLite (Default)

SQLite is Langflow's default database:
- Data is stored in an RWO PVC (`data-langflow-service-0`, 1Gi default)
- Simple, no additional infrastructure
- Only supports single-instance backend (StatefulSet replicas = 1)

#### Using PostgreSQL (Recommended for production)

Production environments strongly recommend PostgreSQL:

- Provision a PostgreSQL instance via `Data Services` PostgreSQL Operator, or use any external PostgreSQL reachable from the cluster.
- Create a dedicated database and user with `CREATE`/`CONNECT` privileges. The Langflow backend will run Alembic migrations against it at first startup.

**Note**:
- PostgreSQL version 12 or higher is recommended
- Ensure network connectivity from the Langflow namespace to the PostgreSQL instance
- Store the password in a Kubernetes `Secret` and reference it via `secretKeyRef` (see [Configure Database](#2-configure-database))

### Install Operator + Create Langflow

1. In `Alauda Container Platform`, open `OperatorHub` and search for `Langflow`. Install `Langflow` from the `platform` catalog source (defaults: channel `alpha`, install mode `AllNamespaces`).

2. Wait for the CSV `langflow-operator.v1.10.1` to reach `Succeeded`.

3. Create a namespace for the Langflow instance (default suggestion: `langflow-system`).

4. Apply a `Langflow` custom resource in that namespace. Minimal form:

   ```yaml
   apiVersion: langflow-operator.alauda.io/v1
   kind: Langflow
   metadata:
     name: langflow
     namespace: langflow-system
   spec: {}
   ```

   Empty `spec: {}` uses the chart's defaults (SQLite on the cluster default StorageClass, IDE mode, ClusterIP Services, no Ingress). To customize, add fields under `spec.langflow.*` per the sections below — the wrap CR spec mirrors the upstream chart's `values.yaml` structure. See the upstream [`values.yaml`](https://github.com/langflow-ai/langflow-helm-charts/blob/langflow-ide-0.1.2/charts/langflow-ide/values.yaml) for the full field list.

## Configuration

Users can edit the `Langflow` custom resource's `spec.langflow.*` fields to customize the deployment. The wrap CR spec mirrors the upstream `langflow-ide` chart's `values.yaml` structure. The main configurations to focus on are as follows.

### 1. Configure Storage

#### 1.1 Configure SQLite Storage (Default)

The StorageClass and volume size can be specified by adding the following configuration:

```yaml
spec:
  langflow:
    backend:
      sqlite:
        volume:
          existingStorageClassName: <sc-name>    # Cluster StorageClass name; leave "default" to use the cluster default
          size: 1Gi                              # PVC size
```

**Note**:
- `existingStorageClassName: "default"` is a magic string in the chart that means "use the cluster's default StorageClass" (i.e. the SC annotated `storageclass.kubernetes.io/is-default-class: "true"`). Set an explicit SC name to override.
- When using SQLite, only single-instance backend is supported (StatefulSet replicas = 1).

### 2. Configure Database

#### 2.1 Enable PostgreSQL

PostgreSQL access information can be configured by setting the following fields:

```yaml
spec:
  langflow:
    backend:
      externalDatabase:
        enabled: true                            # Enable external database
        driver: {value: "postgresql"}
        host: {value: <postgres-host>}           # PostgreSQL host (Service DNS or external address)
        port: {value: "5432"}
        database: {value: langflow}              # Target database (must exist before backend starts)
        user: {value: langflow}
        password:
          valueFrom:
            secretKeyRef:
              name: postgres-secret              # Secret holding the password
              key: password
```

The chart runs a small startup shim inside the backend container that reads these `LF_CHART_EXTERNALDB_*` env vars and composes them into `LANGFLOW_DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>`, overriding the sqlite default. Verified by connecting to the target PostgreSQL after backend startup: Langflow creates its full schema (`alembic_version`, `flow`, `apikey`, `folder`, `message`, etc.) via Alembic and populates it with the built-in starter projects.

**Note**: With SQLite, only single-instance backend is supported. Multi-instance backend requires PostgreSQL, but the current chart still ships `replicas: 1` for the backend StatefulSet — scale explicitly if you need HA.

### 3. Configure External Access

The upstream chart creates only two `ClusterIP` Services by default:

- `langflow-service` on port 8080 — frontend (React IDE served by nginx)
- `langflow-service-backend` on port 7860 — backend (FastAPI + `/api/v1/*`)

The frontend nginx also reverse-proxies `/api`, `/health` and `/health_check` to the backend, so **routing all external traffic to `langflow-service:8080` gives users both the SPA and the backend API through the same entry point**.

**Recommended path: Gateway API (Envoy Gateway)**

The chart-wrap ships an example under `components/langflow/examples/gateway-httproute.example.yaml` (in the `oss-operator-factory` repo). Cluster operators apply an `EnvoyProxy` + `Gateway` once per cluster; users add an `HTTPRoute` in the Langflow namespace pointing at `langflow-service:8080`. A single rule with one backend covers everything — no path-prefix split needed.

Minimal HTTPRoute example (assuming a Gateway `langflow-gw` already exists):

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: langflow
  namespace: <langflow-ns>
spec:
  parentRefs:
    - {group: gateway.networking.k8s.io, kind: Gateway, name: langflow-gw, namespace: <gw-ns>}
  hostnames: [<host>]
  rules:
    - matches: [{path: {type: PathPrefix, value: "/"}}]
      backendRefs:
        - {name: langflow-service, port: 8080}
```

**Alternative: upstream chart Ingress**

The chart also exposes an Ingress block (default off). Enable via the wrap CR:

```yaml
spec:
  langflow:
    ingress:
      enabled: true
      hosts:
        - host: langflow.example.com
          paths: [{path: /, pathType: Prefix}]
      tls:
        - {secretName: langflow-tls, hosts: [langflow.example.com]}
```

Notes:
- The chart's default `ingress.enabled: false` is intentional in the wrap — pre-opening Ingress would fail on clusters with no matching ingress class or DNS.
- OAuth2 Proxy is **not** part of the upstream chart. If SSO is required, deploy an OAuth2 Proxy (or platform SSO) as a separate Deployment in front of the Langflow Service; the wrap does not manage its lifecycle. This is the same pattern used for other chart-wrap components on the platform.

### 4. Configure Authentication and User Management (Optional)

The upstream community chart does not expose a structured `auth` field. Instead, Langflow authentication is controlled by environment variables set on the backend container. Set them under `spec.langflow.backend.env`:

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_AUTO_LOGIN
          value: "false"                       # Disable auto-login (default: true)
        - name: LANGFLOW_SUPERUSER
          valueFrom:
            secretKeyRef: {name: langflow-superuser, key: username}
        - name: LANGFLOW_SUPERUSER_PASSWORD
          valueFrom:
            secretKeyRef: {name: langflow-superuser, key: password}
        - name: LANGFLOW_NEW_USER_IS_ACTIVE
          value: "false"                       # New users require superuser activation (default: false)
        - name: LANGFLOW_ENABLE_SUPERUSER_CLI
          value: "false"                       # Disable CLI superuser bootstrap
```

Verified behavior with `LANGFLOW_AUTO_LOGIN=false`:

- `GET /api/v1/auto_login` returns **403** (auto-login disabled).
- `POST /api/v1/login` with the correct superuser credentials returns **200** with an `access_token`.
- `POST /api/v1/login` with wrong credentials returns **401**.
- Protected endpoints (e.g. `GET /api/v1/all`) return **200** with a valid Bearer token and **403** without.

Notes:
- With `LANGFLOW_AUTO_LOGIN=false`, self-registration is not supported. New users must be added by the superuser via `/admin`; if `LANGFLOW_NEW_USER_IS_ACTIVE=false`, the superuser must activate the account before login is allowed.
- The superuser credentials are only consumed on **first startup**. Once written into the database (SQLite or PostgreSQL), changing the env vars alone does not rotate them — the credential update must go through Langflow's admin UI or a DB migration.
- Access/refresh token expiration are controlled by `LANGFLOW_ACCESS_TOKEN_EXPIRE_SECONDS` / `LANGFLOW_REFRESH_TOKEN_EXPIRE_SECONDS` (defaults are conservative; adjust only if required).

### 5. Single Sign-On (SSO)

The upstream `langflow-ide` chart **does not include an OAuth2 Proxy sidecar or Deployment**. If SSO is required, deploy an OAuth2 Proxy (or the platform's existing SSO gateway) as a separate workload in front of the Langflow frontend Service — this is outside the wrap CR's control surface and follows the same pattern used by other chart-wrap components on the platform. Configure the OAuth2 Proxy to point at `langflow-service:8080` as its upstream, and set `LANGFLOW_AUTO_LOGIN=false` on the backend so the proxy is the sole authentication entry point.

### 6. Configure Runtime Mode (Backend-Only)

Runtime mode drops the React IDE frontend and runs only the backend REST API. This is the recommended deployment shape for production API-serving scenarios.

#### 6.1 Enable Runtime Mode

Two fields together enable full runtime mode:

- `spec.langflow.backend.backendOnly: true` — starts the backend with `--backend-only` (backend is already the default in the current chart, but keep this explicit).
- `spec.langflow.frontend.enabled: false` — the chart skips the frontend Deployment entirely (verified: `kubectl get deploy -n <ns>` returns 0 resources; only the backend StatefulSet remains).

Optionally auto-import flows from a PVC or ConfigMap:

```yaml
spec:
  langflow:
    backend:
      backendOnly: true
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: "/app/flows"
      volumes:
        - name: flows
          persistentVolumeClaim: {claimName: langflow-flows-pvc}
      volumeMounts:
        - name: flows
          mountPath: /app/flows
    frontend:
      enabled: false
```

When enabling `LANGFLOW_LOAD_FLOWS_PATH`, keep `LANGFLOW_AUTO_LOGIN=true` (auto-login mode) — this is a Langflow constraint: user-owned auto-imported flows require the auto-login default user to be present.

## Access Address

### 1. Access via Gateway API (recommended)

When the Gateway API path from [Configure External Access](#3-configure-external-access) is applied, the assigned NodePort or LoadBalancer address of the Gateway's data-plane Service is the entry point. Example:

```bash
# Discover the envoy data-plane Service's NodePort (or LoadBalancer address)
kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=langflow-gw

# Reach Langflow through any cluster node's IP + that NodePort
curl http://<any-node-ip>:<nodePort>/health_check
# Or open http://<any-node-ip>:<nodePort>/ in a browser to see the Langflow IDE
```

### 2. Access via In-Cluster Port-Forward (development only)

```bash
kubectl port-forward -n <langflow-ns> svc/langflow-service 8080:8080
# open http://localhost:8080/
```

### 3. Access via Ingress

If Ingress was enabled via `spec.langflow.ingress.enabled=true`, use the configured hostname (DNS resolution and TLS certificate must be prepared by the cluster operator).

# Langflow Quickstart

For a quickstart guide, please refer to the official documentation: [https://docs.langflow.org/get-started-quickstart](https://docs.langflow.org/get-started-quickstart)

# Production Environment Recommendations

This section provides practical recommendations and optimization configurations for using Langflow in production environments.

## 1. Import Existing Flows via ConfigMap

In production environments, existing Flow files can be imported into Langflow through Kubernetes ConfigMap.

### 1.1 Create ConfigMap with Flow JSON

First, create a ConfigMap containing Flow JSON files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: langflow-flows
  namespace: <Langflow namespace>
data:
  project1.json: |
    <JSON content>
```

### 1.2 Mount ConfigMap to the backend container

Add the ConfigMap as a volume and expose the mount path through `LANGFLOW_LOAD_FLOWS_PATH`. The upstream chart appends any user-provided volumes/volumeMounts to those it ships by default:

```yaml
spec:
  langflow:
    backend:
      volumes:
        - name: flows
          configMap: {name: langflow-flows}
      volumeMounts:
        - name: flows
          mountPath: /app/flows
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: /app/flows
```

### 1.3 Auto Import

After the backend restarts, Langflow scans `LANGFLOW_LOAD_FLOWS_PATH` and auto-imports every `*.json` file in it as a Flow. Since flow ownership is tied to a user, the auto-import mode requires `LANGFLOW_AUTO_LOGIN=true` (the default) — the imported flows are attached to the built-in default user. With authentication enabled (`LANGFLOW_AUTO_LOGIN=false`), user-owned imports are not supported by the upstream chart; use the REST API (`POST /api/v1/flows/` with a Bearer token) instead.

## 2. Using Models

In production environments, models can be loaded and used in two ways: calling remote models via API or loading local models via volume mount. Choose the appropriate approach based on your specific requirements.

### 2.1 Calling Remote Models

This approach is suitable for scenarios where:
- Models have significant resource requirements
- Models need to be shared across multiple services
- Independent scaling and resource management are required
- Model version management and updates need to be handled separately

Remote models can be either self-deployed model services or third-party model services provided by vendors. To use remote models in Langflow, in the flow editor, use API-based model components (e.g., OpenAI, Custom API, etc.) to connect to the model service endpoint by configuring the API base URL and authentication credentials.

### 2.2 Loading Local Models

This approach is suitable for scenarios where:
- Models have low resource overhead (e.g., embedding models)
- Model size and resource consumption are manageable within the Langflow container
- Direct file access to models is required

#### 2.2.1 Mount Model Files via Volume

Store model files in persistent volumes and provide them to the Langflow backend container through additional volumes/volumeMounts:

```yaml
spec:
  langflow:
    backend:
      volumes:
        - name: models
          persistentVolumeClaim: {claimName: langflow-models-pvc}
      volumeMounts:
        - name: models
          mountPath: /opt/models
```

#### 2.2.2 Upload Models

Users can use the `kubectl cp` command to upload models to the Langflow container, as shown in the following example:

```bash
kubectl cp <local model path> -n <Langflow namespace> <Langflow Pod name>:/opt/models
```

#### 2.2.3 Configure Local Models in Components

In Langflow's flow editor, when using corresponding model components, the local model access path can be configured as `/opt/models`.

## 3. Add Additional Python Dependencies

In production environments, when using custom components, additional Python packages may need to be installed. This can be done as follows:

### 3.1 Mount Dependencies via PVC

Mount a directory using PVC to store additional Python packages:

```yaml
spec:
  langflow:
    backend:
      volumes:
        - name: python-packages
          persistentVolumeClaim: {claimName: langflow-packages-pvc}
      volumeMounts:
        - name: python-packages
          mountPath: /opt/python-packages
      env:
        - name: PYTHONPATH
          value: "/opt/python-packages"
```

### 3.2 Install Dependencies

When installing dependency packages, use the `pip --target` parameter to install packages to the PVC-mounted directory:

```bash
# Execute in container, install package to PVC-mounted directory
pip install --target /opt/python-packages package-name

# Or install from requirements.txt
pip install --target /opt/python-packages -r requirements.txt
```

## 4. Pass Global Variables via Environment Variables

Flow component configurations often need different values in different environments. Langflow's global variables feature allows separating these environment-specific values from Flow definitions. The values of Global Variables can be loaded from environment variables.

### 4.1 Configure Environment Variables

Add environment variables under `spec.langflow.backend.env` as shown:

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT
          value: VAR1,VAR2,VAR3                # Comma-separated list of env-var names Langflow will surface as Global Variables
        - name: VAR1
          value: xxx                           # Plain literal
        - name: VAR2
          valueFrom:
            configMapKeyRef:
              name: langflow-configs
              key: var2                        # From ConfigMap
        - name: VAR3
          valueFrom:
            secretKeyRef:
              name: langflow-secrets
              key: var3                        # From Secret (recommended for sensitive values)
```

Verified: with `LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT=MY_PLAIN_VAR,MY_SECRET_KEY` on the wrap CR, `GET /api/v1/variables/` returns both entries with `type: Credential`, ready to be referenced from flow components.

### 4.2 Use Global Variables in Flows

In Langflow's flow editor:

1. Go to the **Settings** page
2. In the **Global Variables** section, add global variables and set their values
3. Reference these global variables in component configurations
4. When exporting Flows, **must** select "Save with my API keys", otherwise Global Variables configuration may not be included in the exported JSON file

## 5. Optimization Recommendations

To improve performance, security, and stability in production environments, the following optimization configurations are recommended:

### 5.1 Disable Usage Tracking

Langflow collects usage data by default. In production environments, this feature can be disabled to protect privacy and reduce network requests:

```yaml
spec:
  langflow:
    backend:
      env:
        - name: DO_NOT_TRACK
          value: "true"
```

### 5.2 Disable Transaction Logs

Langflow records the input, output, and execution log of each component to the database (visible in the IDE's Logs panel). Disabling reduces database write pressure:

```yaml
spec:
  langflow:
    backend:
      env:
        - name: LANGFLOW_TRANSACTIONS_STORAGE_ENABLED
          value: "false"
```

### 5.3 Set Worker Process Count

```yaml
spec:
  langflow:
    backend:
      numWorkers: 1                            # gunicorn worker count (default: 1)
```

### 5.4 Configure Resource Limits

It is recommended to configure appropriate resource limits for the backend and frontend containers separately. Sample values (adjust to your workload):

```yaml
spec:
  langflow:
    backend:
      resources:
        requests: {cpu: "2", memory: "4Gi"}
        limits:   {cpu: "4", memory: "8Gi"}
    frontend:
      resources:
        requests: {cpu: "0.3", memory: "512Mi"}
```

### 5.5 Use API Keys

Langflow supports `x-api-key`-based authentication for REST requests. Two ways to create a key:

1. **Via the IDE (Settings → Langflow API Keys)**: click "Add New" and give the key a name; Langflow returns the key value once (store it immediately).
2. **Via REST**: `POST /api/v1/api_key/` with a Bearer token in `Authorization`:
   ```bash
   curl -X POST http://<langflow>/api/v1/api_key/ \
     -H "Authorization: Bearer <access-token>" \
     -H "Content-Type: application/json" \
     -d '{"name":"my-key"}'
   ```
   The response body contains `api_key` — record it.

Use the key by sending `x-api-key: <API Key>` on subsequent requests:
- Valid key → `200`
- Missing / wrong key → `403`

Verified with the e2e smoke H probe on 4.3-x86: creating a key + hitting `/api/v1/all` with the valid key returns 200 with the full component catalog; hitting the same endpoint with a wrong key returns 403.

### 5.6 Disable UI

See [Configure Runtime Mode](#6-configure-runtime-mode-backend-only) — set both `backend.backendOnly=true` and `frontend.enabled=false` to actually drop the frontend Deployment.

### 5.7 Reference Official Documentation

For more detailed information about publishing flows and production best practices, please refer to the official Langflow documentation:

- **Publishing Concepts**: [https://docs.langflow.org/concepts-publish](https://docs.langflow.org/concepts-publish)
- **Production Best Practices**: [https://docs.langflow.org/deployment-prod-best-practices](https://docs.langflow.org/deployment-prod-best-practices)
