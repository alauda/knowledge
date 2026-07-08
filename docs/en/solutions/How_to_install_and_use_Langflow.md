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

Starting with v1.10.1, Langflow is installed via `OperatorHub` and a `Langflow` custom resource, not from the Applications / Catalog form.

## Deployment

### Prepare Storage

Langflow uses SQLite by default with an RWO PVC (1Gi). For production, PostgreSQL is recommended (see [Configure Database](#2-configure-database)). The StorageClass for the SQLite PVC is configured under `spec.langflow.backend.sqlite.volume` — see [Configure Storage](#1-configure-storage) for details.

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

   Empty `spec: {}` uses defaults (SQLite on the cluster default StorageClass, IDE mode, ClusterIP Services only). To customize, add fields under `spec.langflow.*` per the sections below.

## Configuration

The `Langflow` custom resource's `spec.langflow.*` fields customize the deployment. The main configurations to focus on are as follows.

> **⚠ Array fields REPLACE chart defaults, they do not append.**
> When you set `spec.langflow.backend.volumes` (or `.volumeMounts`), the chart drops its own default `tmp` / `data` / `db` / `flows` `emptyDir` volumes and uses only what you provide. If you add a custom volume without re-declaring the defaults, the backend container will crash on startup with `FileNotFoundError: No usable temporary directory found in ['/tmp', '/var/tmp', '/usr/tmp', '/app']` (the Langflow entrypoint imports `dill`, which calls `tempfile.gettempdir()` — `readOnlyRootFilesystem: true` means `/tmp` must be a writable volume).
>
> If you customize `volumes` or `volumeMounts`, keep the four chart-default entries alongside your additions. Suggested minimal boilerplate:
>
> ```yaml
> spec:
>   langflow:
>     backend:
>       volumes:
>         - {name: langflow-tmp, emptyDir: {}}   # /tmp        — required (readOnly root FS)
>         - {name: app-data,     emptyDir: {}}   # /app/data   — chart default
>         - {name: app-db,       emptyDir: {}}   # /app/db     — chart default
>         - {name: app-flows,    emptyDir: {}}   # /app/flows  — chart default
>         # ... your additions below
>       volumeMounts:
>         - {name: langflow-tmp, mountPath: /tmp}
>         - {name: app-data,     mountPath: /app/data}
>         - {name: app-db,       mountPath: /app/db}
>         - {name: app-flows,    mountPath: /app/flows}
>         # ... your additions below
> ```
>
> Sections below that add custom `volumes` (ConfigMap flow import, local models, Python deps) omit this boilerplate for brevity — remember to include it. This trap was caught live on ACP 4.3 during doc validation.

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

Langflow creates only two `ClusterIP` Services by default:

- `langflow-service` on port 8080 — frontend (React IDE served by nginx)
- `langflow-service-backend` on port 7860 — backend (FastAPI + `/api/v1/*`)

The frontend nginx also reverse-proxies `/api`, `/health` and `/health_check` to the backend, so **routing all external traffic to `langflow-service:8080` gives users both the IDE and the backend API through the same entry point**.

External access is provided via Gateway API (Envoy Gateway). Apply the three resources below in the same namespace as your `Langflow` custom resource. Adjust the `gatewayClassName` (`envoy-gateway-system-aieg` is the default on Alauda Container Platform 4.3+) and the `hostname` to match your environment.

```yaml
# ── 1) EnvoyProxy: expose the data plane via NodePort (or LoadBalancer if available). ────
apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyProxy
metadata:
  name: langflow-proxy
  namespace: <langflow-ns>
spec:
  logging: {level: {default: warn}}
  provider:
    type: Kubernetes
    kubernetes:
      envoyService:
        type: NodePort              # change to LoadBalancer if the cluster has one
        externalTrafficPolicy: Cluster
---
# ── 2) Gateway: HTTP listener; add an HTTPS listener with a cert Secret for TLS. ─────────
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: langflow-gw
  namespace: <langflow-ns>
spec:
  gatewayClassName: envoy-gateway-system-aieg
  infrastructure:
    parametersRef:
      group: gateway.envoyproxy.io
      kind: EnvoyProxy
      name: langflow-proxy
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes: {namespaces: {from: Same}}
---
# ── 3) HTTPRoute: all paths → langflow-service:8080; nginx fans out /api* to backend. ────
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: langflow
  namespace: <langflow-ns>
spec:
  parentRefs:
    - {group: gateway.networking.k8s.io, kind: Gateway, name: langflow-gw}
  # hostnames: [langflow.example.com]           # optional; omit to accept any Host
  rules:
    - matches: [{path: {type: PathPrefix, value: "/"}}]
      backendRefs:
        - {name: langflow-service, port: 8080}
```

After apply, wait for the `Gateway` to reach `PROGRAMMED=True`, then find the NodePort that Envoy Gateway allocated:

```bash
kubectl get gateway langflow-gw -n <langflow-ns>
kubectl get svc -A -l gateway.envoyproxy.io/owning-gateway-name=langflow-gw
```

The NodePort service in the output is the entry point — reach Langflow at `http://<any-node-ip>:<nodePort>/`.

If you added an HTTPS listener with a certificate `Secret` in a different namespace, you'll also need a `ReferenceGrant` from the Gateway's namespace to the certificate's namespace.

### 4. Configure Authentication and User Management (Optional)

Langflow authentication is controlled by environment variables on the backend container. Set them under `spec.langflow.backend.env`:

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

**Verify the login flow in a browser**:

1. **Open the Langflow URL in a fresh browser tab** — use an Incognito / Private window, or clear the site's cookies first (DevTools → Application → Cookies → delete `access_token_lf`, `refresh_token_lf`, `apikey_tkn_lflw`). Without this step, previously issued auto-login cookies keep working until they expire, and the browser walks straight into the IDE as if authentication were still off.
2. **The page should show a login form** instead of loading the IDE directly.
3. **Log in with the superuser credentials** you set in `LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`. You should land in the IDE with your username shown in the top-right menu; entering a wrong password should keep you on the login page with an error message.

Notes:

- Self-registration is not supported when `LANGFLOW_AUTO_LOGIN=false`. New users must be added by the superuser from the admin page; if `LANGFLOW_NEW_USER_IS_ACTIVE=false`, the superuser must also activate each new account before the user can log in.
- The superuser credentials are consumed on **first startup only**. Once written into the database, changing the env vars alone does not rotate the password — update it through Langflow's admin UI instead. Rotating requires either editing the existing user or wiping the database and restarting.
- Access/refresh token expiration are controlled by `LANGFLOW_ACCESS_TOKEN_EXPIRE_SECONDS` (default 30 days) and `LANGFLOW_REFRESH_TOKEN_EXPIRE_SECONDS` (default 60 days). For production, shorter values are recommended:
  ```yaml
  env:
    - {name: LANGFLOW_ACCESS_TOKEN_EXPIRE_SECONDS,  value: "3600"}     # 1 hour
    - {name: LANGFLOW_REFRESH_TOKEN_EXPIRE_SECONDS, value: "604800"}   # 7 days
  ```

### 5. Configure Runtime Mode (Backend-Only)

Runtime mode drops the React IDE frontend and runs only the backend REST API. This is the recommended deployment shape for production API-serving scenarios.

#### 5.1 Enable Runtime Mode

Two fields together enable full runtime mode:

- `spec.langflow.backend.backendOnly: true` — starts the backend with `--backend-only` (backend is already the default in the current chart, but keep this explicit).
- `spec.langflow.frontend.enabled: false` — the chart skips the frontend Deployment entirely (verified: `kubectl get deploy -n <ns>` returns 0 resources; only the backend StatefulSet remains).

Optionally auto-import flows from a PVC or ConfigMap. **Remember the [chart-defaults boilerplate](#configuration)** — mount the flows source under a distinct path (`/app/loaded-flows`) so it doesn't collide with the chart's own `/app/flows` `emptyDir`:

```yaml
spec:
  langflow:
    backend:
      backendOnly: true
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: "/app/loaded-flows"
      volumes:
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        - name: loaded-flows
          persistentVolumeClaim: {claimName: langflow-flows-pvc}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
        - name: loaded-flows
          mountPath: /app/loaded-flows
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

Add the ConfigMap as a volume and expose the mount path through `LANGFLOW_LOAD_FLOWS_PATH`. **Remember the "array replaces defaults" rule** — the four chart-default entries (`langflow-tmp` / `app-data` / `app-db` / `app-flows`) below the custom ConfigMap entry must stay in place:

```yaml
spec:
  langflow:
    backend:
      volumes:
        # chart defaults — required, do not omit
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        # additional flows source
        - name: loaded-flows
          configMap: {name: langflow-flows}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
        - name: loaded-flows
          mountPath: /app/loaded-flows
      env:
        - name: LANGFLOW_LOAD_FLOWS_PATH
          value: /app/loaded-flows
```

Verified on ACP 4.3: with the above CR, restarting the backend caused Langflow to auto-import the `hello-world.json` file from the ConfigMap; `GET /api/v1/flows/` returns 34 flows (33 built-in starter projects + 1 imported).

### 1.3 Auto Import

After the backend restarts, Langflow scans `LANGFLOW_LOAD_FLOWS_PATH` and auto-imports every `*.json` file in it as a Flow. Since flow ownership is tied to a user, the auto-import mode requires `LANGFLOW_AUTO_LOGIN=true` (the default) — the imported flows are attached to the built-in default user. With authentication enabled (`LANGFLOW_AUTO_LOGIN=false`), user-owned imports are not supported; use the REST API (`POST /api/v1/flows/` with a Bearer token) instead.

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

Store model files in persistent volumes and provide them to the Langflow backend container through additional volumes/volumeMounts. **Remember the [chart-defaults boilerplate](#configuration)** — the four `emptyDir` entries must be included:

```yaml
spec:
  langflow:
    backend:
      volumes:
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        - name: models
          persistentVolumeClaim: {claimName: langflow-models-pvc}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
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

Mount a directory using PVC to store additional Python packages. **Remember the [chart-defaults boilerplate](#configuration)**:

```yaml
spec:
  langflow:
    backend:
      volumes:
        - {name: langflow-tmp, emptyDir: {}}
        - {name: app-data,     emptyDir: {}}
        - {name: app-db,       emptyDir: {}}
        - {name: app-flows,    emptyDir: {}}
        - name: python-packages
          persistentVolumeClaim: {claimName: langflow-packages-pvc}
      volumeMounts:
        - {name: langflow-tmp, mountPath: /tmp}
        - {name: app-data,     mountPath: /app/data}
        - {name: app-db,       mountPath: /app/db}
        - {name: app-flows,    mountPath: /app/flows}
        - name: python-packages
          mountPath: /opt/python-packages
      env:
        - name: PYTHONPATH
          value: "/opt/python-packages"
```

Verified on ACP 4.3: pod is Ready, `env` shows `PYTHONPATH=/opt/python-packages`, mount visible at that path.

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

Verified: with `LANGFLOW_VARIABLES_TO_GET_FROM_ENVIRONMENT=MY_PLAIN_VAR,MY_SECRET_KEY` on the `Langflow` custom resource, `GET /api/v1/variables/` returns both entries with `type: Credential`, ready to be referenced from flow components.

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
