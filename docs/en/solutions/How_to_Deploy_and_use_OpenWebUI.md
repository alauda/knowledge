products:
- Alauda AI
  kind:
- Solution
  ProductsVersion:
- 4.x
---

# OpenWebUI

## Overview
OpenWebUI is an open-source AI Web interface that supports docking with multiple OpenAI protocol-compatible inference backends (such as vLLM, MLServer, XInference, etc.) through a unified entry point. It is used for scenarios such as text generation, multimodal input, and voice input. It provides an extensible external tool mechanism to facilitate the integration of retrieval, function calling, and third-party services. It is suitable for deployment in containers locally or in the cloud, supporting persistent data and Ingress-based HTTPS access.

## Basic Features
- **Conversation & Text Generation**: Support system prompts, adjustable parameters (temperature, length, etc.), and session management.
- **Multimodal & Voice**: Images/documents as context, voice input/transcription (dependent on backend capabilities).
- **External Tool Extension**: Can call retrieval, databases, HTTP APIs, etc., to build tool-enhanced workflows.
- **Data & Security**: Sessions and configurations can be persisted; can integrate with authentication, rate limiting, logging/monitoring.

## Backend Integration
- **Protocol Compatibility**: Support OpenAI API style backends (such as vLLM, MLServer, XInference, TGI, etc.).
- **Connection Parameters**: Base URL (e.g., `http(s)://{backend}/v1`), API Key, model name, and default inference parameters.
- **Multiple Backends**: configured in the UI, allowing switching between different inference service backends.

## Deployment Scheme
Create the following resources in order. In this case, choose an independent `open-webui-ns` namespace. You can choose an available namespace as needed.

### Namespace
```bash
kubectl create ns open-webui-ns
```

### Create the specific deployment
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    app: open-webui
  name: open-webui
  namespace: open-webui-ns
spec:
  replicas: 1
  selector:
    matchLabels:
      app: open-webui
  template:
    metadata:
      labels:
        app: open-webui
    spec:  
      volumes:
      - name: webui-data
        emptyDir: {}
      containers:
      - image: ghcr.io/open-webui/open-webui
        name: open-webui
        ports:
        - containerPort: 8080
        env:
        - name: ENABLE_DIRECT_CONNECTIONS
          value: "true"
        - name: OPENAI_API_BASE_URL
          value: http://example-predictor/v1
        - name: PORT
          value: "8080"
        volumeMounts:
          - name: webui-data
            mountPath: /app/backend/data
        resources:
          requests:
            cpu: 1000m
            memory: 128Mi
          limits: 
            cpu: 2000m
            memory: 1Gi
```

## Important environment values

Relative environment values should be configured.

### ENABLE_DIRECT_CONNECTIONS
* Set to true to enable external connections.
* Purpose: Allows adding additional external inference service backends within OpenWebUI.

### OPENAI_API_BASE_URL
* Specifies the default inference service endpoint.
* If OpenWebUI and the inference service are deployed in the same cluster, use the service’s internal cluster address.
* For the address details, refer to: **AML Business View / Inference Service / Inference Service Details / Access Method**.
* Value format: `{{Cluster Internal URL}}/v1`.


### Verification
```bash
kubectl get deployment open-webui -n open-webui-ns -w
```
Wait until the deployment status is `1/1 Ready`.

## Access OpenWebUI

### 1. View OpenWebUI via NodePort Service
Create the following resource:

```yaml
apiVersion: v1
kind: Service
metadata:
  labels:
    app: open-webui
  name: svc-open-webui
  namespace: open-webui-ns
spec:
  type: NodePort
  ports:
  - port: 8080
    protocol: TCP
    targetPort: 8080
  selector:
    app: open-webui
```
Check the relevant port and node IP to access the page.

### 2. Initial Settings
When accessing OpenWebUI for the first time, you need to register. Choose a strong password for the administrator account.

### 3. Add Inference Service
Go to **Settings -> Connections -> Add Connection**.
Here you will be required to add the inference service address.
You can obtain the cluster external access methods via **AML Business View / Inference Service / Inference Service Details / Access Method**.
Fill it in afterwards. Please use the cluster **external** access method.
In the **Add Connection** popup, fill in:
`{{Cluster External URL}}/v1`

Click the icon on the right to verify connectivity. After success, click save. Return to the chat page to select the existing inference service for use.

### 4. Use Inference Service
Enter the chat page, select the uploaded inference service, and explore more features, such as:
- Voice input
- Multimodal input
- External tools
