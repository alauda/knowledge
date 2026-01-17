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

- Llama Stack Server installed and running (see notebook for installation and startup instructions)
  - For deploying Llama Stack Server on Kubernetes, refer to the [Kubernetes Deployment Guide](https://llamastack.github.io/docs/deploying/kubernetes_deployment)
- Access to a Notebook environment (e.g., Jupyter Notebook, JupyterLab, or similar)
- Python environment with `llama-stack-client` and required dependencies installed
- API key for the LLM provider (e.g., DeepSeek API key)

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

## Additional Resources

For more resources on developing AI Agents with Llama Stack, see:

- [Llama Stack Documentation](https://llamastack.github.io/docs) - The official Llama Stack documentation covering all usage-related topics, API providers, and core concepts.
- [Llama Stack Core Concepts](https://llamastack.github.io/docs/concepts) - Deep dive into Llama Stack architecture, API stability, and resource management.
- [Llama Stack GitHub Repository](https://github.com/llamastack/llama-stack) - Source code, example applications, distribution configurations, and how to add new API providers.
- [Llama Stack Example Apps](https://github.com/llamastack/llama-stack-apps/) - Official examples demonstrating how to use Llama Stack in various scenarios.