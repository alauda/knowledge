---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 1.5
---
# Add a New ipykernel in JupyterLab

This document explains how to create a new Python virtual environment, register it as a Jupyter ipykernel, and verify that it is available in JupyterLab.

All commands in this guide should be executed **inside the JupyterLab environment**. You can either exec into the JupyterLab Pod using Kubernetes commands, or run the commands directly from the **Terminal** available on the JupyterLab Launcher page.

## Download an Additional Python Version (Optional)

The built-in Python version in JupyterLab is **Python 3.11**. If you need a virtual environment based on a different Python version, it is recommended to download a **prebuilt standalone Python distribution** instead of compiling Python manually or installing system packages.

In this guide, we use **python-build-standalone**, which provides a *clean, dependency-free, precompiled Python binary for Linux*. This approach does not rely on system libraries, does not require root privileges. It is well-suited for containerized or restricted environments such as JupyterLab.

The following example shows how to install **Python 3.10** using a python-build-standalone release:

```bash
# Create a directory
mkdir -p ~/python310_static && cd ~/python310_static

# Download a prebuilt Python 3.10 archive (recent 2024 build)
curl -L https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz | tar -xz

# Verify the Python version (expected output: Python 3.10.13)
~/python310_static/python/bin/python3 --version

# Create a virtual environment using Python 3.10
~/python310_static/python/bin/python3 -m venv ~/.venv-py310
```

## Create and Register a New ipykernel

First, create a new Python virtual environment:

```bash
python -m venv ~/.venv-testing

# If you installed Python 3.10 in the previous section, use:
~/python310_static/python/bin/python3 -m venv ~/.venv-py310
```

Activate the virtual environment:

```bash
source ~/.venv-testing/bin/activate

# If you are using the Python 3.10 virtual environment:
source ~/.venv-py310/bin/activate
```

Install the required `ipykernel` package into the virtual environment:

```bash
pip install ipykernel -i https://pypi.tuna.tsinghua.edu.cn/simple
```

Register this virtual environment as a Jupyter kernel:

```bash
python -m ipykernel install \
  --user \
  --name python-testing \
  --display-name "Python (testing)"
```

Verify that the new kernel has been registered successfully:

```bash
jupyter kernelspec list
```

Example output:

```text
Available kernels:
python3           /home/jovyan/.venv/share/jupyter/kernels/python
python-testing    /home/jovyan/.local/share/jupyter/kernels/python-testing
```

## Verify the Kernel in JupyterLab

After registering the kernel, refresh the JupyterLab page in your browser.

On the **Launcher** page, a new card named **Python (testing)** will appear under both the **Notebook** and **Console** sections.

Click **Python (testing)** under **Console** to open a new console tab, then run the following code to verify that the kernel is using the correct environment:

```python
import sys

print("Python version:", sys.version)
print("Python executable:", sys.executable)
```

If the output shows the Python executable path pointing to the newly created virtual environment, the ipykernel has been configured correctly. For example:

```text
Python version: 3.11.13 (main, ...)
Python executable: /home/jovyan/.venv-testing/bin/python
```
