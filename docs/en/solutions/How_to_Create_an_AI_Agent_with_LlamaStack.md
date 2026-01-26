---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 4.x
---

# How To Create AI Agent with Llama Stack

## Overview

Llama Stack is a framework for building and running AI agents with tools. It provides a server-based architecture that enables developers to create agents that can interact with users, access external tools, and perform complex reasoning tasks. This guide provides a quickstart example for creating an AI Agent using Llama Stack.

## Prerequisites

- Python 3.12 or higher version environment (if not satisfied, refer to FAQ section for Python installation instructions)
- Llama Stack Server installed and running (see notebook for installation and startup instructions)
  - For deploying Llama Stack Server on Kubernetes, refer to the [Deploy Llama Stack Server via Operator](#deploy-llama-stack-server-via-operator) section
- Access to a Notebook environment (e.g., Jupyter Notebook, JupyterLab, or similar)
- Python environment with `llama-stack-client` and required dependencies installed
- API key for the LLM provider (e.g., DeepSeek API key)

## Deploy Llama Stack Server via Operator

This section describes how to deploy Llama Stack Server on Kubernetes using the Llama Stack Operator.

### Upload Operator

Download the Llama Stack Operator installation file (e.g., `llama-stack-operator.alpha.ALL.v0.6.0.tgz`).

Use the violet command to publish to the platform repository:

```bash
violet push --platform-address=platform-access-address --platform-username=platform-admin --platform-password=platform-admin-password llama-stack-operator.alpha.ALL.v0.6.0.tgz
```

### Install Operator

1. Go to the `Administrator` view in the Alauda Container Platform.

2. In the left navigation, select `Marketplace` / `Operator Hub`.

3. In the right panel, find `Llama Stack Operator` and click `Install`.

4. Keep all parameters as default and complete the installation.

### Deploy Llama Stack Server

After the operator is installed, deploy Llama Stack Server by creating a `LlamaStackDistribution` custom resource:

```yaml
apiVersion: llamastack.io/v1alpha1
kind: LlamaStackDistribution
metadata:
  annotations:
    cpaas.io/display-name: ""
  name: demo
  namespace: default
spec:
  network:
    exposeRoute: false                             # Whether to expose the route externally
  replicas: 1                                      # Number of server replicas
  server:
    containerSpec:
      env:
        - name: VLLM_URL
          value: " https://api.deepseek.com/v1"    # URL of the LLM API provider
        - name: VLLM_MAX_TOKENS
          value: "8192"                            # Maximum output tokens (DeepSeek Chat supports up to 8K)
        - name: VLLM_API_TOKEN
          value: XXX                               # API authentication token
      name: llama-stack
      port: 8321
    distribution:
      name: starter                                # Distribution name (options: starter, postgres-demo, meta-reference-gpu)
    storage:
      mountPath: /home/lls/.lls
      size: 20Gi
```

After deployment, the Llama Stack Server will be available within the cluster. The access URL is displayed in `status.serviceURL`, for example:

```yaml
status:
  serviceURL: http://demo-service.default.svc.cluster.local:8321
```

## Quickstart

A simple example of creating an AI Agent with Llama Stack is available here: [llama_stack_quickstart.ipynb](/llama-stack/llama_stack_quickstart.ipynb). The configuration file [llama_stack_config.yaml](/llama-stack/llama_stack_config.yaml) is also required. Download both files and upload them to a Notebook environment to run.

The notebook demonstrates:
- Llama Stack Server installation and configuration
- Server startup and connection setup
- Tool definition using the `@client_tool` decorator (weather query tool example)
- Client connection to Llama Stack Server
- Model selection and Agent creation with tools and instructions
- Agent execution with session management and streaming responses
- Result handling and display

## FAQ

### How to prepare Python 3.12 in Notebook

1. Download the pre-compiled python installation package:

```bash
wget -O /tmp/python312.tar.gz https://github.com/astral-sh/python-build-standalone/releases/download/20260114/cpython-3.12.12+20260114-x86_64-unknown-linux-gnu-install_only.tar.gz
```

2. Extract with:

```bash
tar -xzf /tmp/python312.tar.gz -C ~/python312 --strip-components=1
```

3. Register ipykernel:

```bash
~/python312/bin/python -m ipykernel install --user --name python312 --display-name "Python 3.12"
```

4. Switch kernel in the notebook page

**Note**: When executing python and pip commands directly in the notebook page, the default python will still be used. You need to specify the full path to use the python312 version commands.

## Additional Resources

For more resources on developing AI Agents with Llama Stack, see:

- [Llama Stack Documentation](https://llamastack.github.io/docs) - The official Llama Stack documentation covering all usage-related topics, API providers, and core concepts.
- [Llama Stack Core Concepts](https://llamastack.github.io/docs/concepts) - Deep dive into Llama Stack architecture, API stability, and resource management.
- [Llama Stack GitHub Repository](https://github.com/llamastack/llama-stack) - Source code, example applications, distribution configurations, and how to add new API providers.
- [Llama Stack Example Apps](https://github.com/llamastack/llama-stack-apps/) - Official examples demonstrating how to use Llama Stack in various scenarios.