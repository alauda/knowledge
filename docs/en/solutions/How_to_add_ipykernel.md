---
products:
   - Alauda AI
kind:
   - Solution
ProductsVersion:
   - 1.5
---
# Add a New ipykernel in JupyterLab

This section describes how to create a new Python virtual environment, register it as a Jupyter ipykernel, and verify that it is available in JupyterLab.

All commands in this section should be executed inside the JupyterLab environment. You can either exec into the JupyterLab Pod using Kubernetes commands, or run the commands directly in the **Terminal** available from the JupyterLab Launcher page.

## Create and Register a New ipykernel

Create a new Python virtual environment:

```bash
python -m venv ~/.venv-testing
```

Activate the virtual environment:

```bash
source ~/.venv-testing/bin/activate
```

Install the required ipykernel package in the virtual environment:

```bash
pip install ipykernel
```

Install and register the ipykernel for this environment:

```bash
python -m ipykernel install \
  --user \
  --name python-testing \
  --display-name "Python (testing)"
```

Verify that the new kernel has been registered:

```bash
jupyter kernelspec list
```

```text
Available kernels:
python3           /.venv/share/jupyter/kernels/python
python-testing    /home/jovyan/.local/share/jupyter/kernels/python-testing
```

## Verify the Kernel in JupyterLab

After the kernel is registered, refresh the JupyterLab page in your browser. On the **Launcher** page, a new card named **Python (testing)** will appear under both the **Notebook** and **Console** sections.

Click the **Python (testing)** card under **Console** to open a new console tab. In the opened tab, run the following Python code to verify the environment:

```python
import sys

print("Python version:", sys.version)
print("Python executable:", sys.executable)
```

If the output shows the Python executable path pointing to the newly created virtual environment, the ipykernel has been configured correctly:

```text
Python version: 3.11.13 (main, ...)
Python executable: /home/jovyan/.venv-testing/bin/python
```
