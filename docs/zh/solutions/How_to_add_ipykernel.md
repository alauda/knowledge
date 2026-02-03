---
products:
  - Alauda AI
kind:
  - Solution
ProductsVersion:
  - 1.5
id: KB260200003
sourceSHA: 9c12e214a59bf15e3394d346dc38c890a79c375be3e9b82856d21267ce1859d0
---

# 在 JupyterLab 中添加新的 ipykernel

本文档解释了如何创建一个新的 Python 虚拟环境，将其注册为 Jupyter ipykernel，并验证它在 JupyterLab 中是否可用。

本指南中的所有命令应在 **JupyterLab 环境** 内执行。您可以使用 Kubernetes 命令进入 JupyterLab Pod，或直接从 JupyterLab 启动页面上的 **终端** 运行命令。

## 下载额外的 Python 版本（可选）

JupyterLab 中内置的 Python 版本是 **Python 3.11**。如果您需要基于不同 Python 版本的虚拟环境，建议下载 **预构建的独立 Python 发行版**，而不是手动编译 Python 或安装系统软件包。

在本指南中，我们使用 **python-build-standalone**，它提供了一个 *干净、无依赖、预编译的 Linux Python 二进制文件*。这种方法不依赖于系统库，不需要 root 权限。非常适合容器化或受限环境，如 JupyterLab。

以下示例演示如何使用 python-build-standalone 版本安装 **Python 3.10**：

```bash
# 创建一个目录
mkdir -p ~/python310_static && cd ~/python310_static

# 下载预构建的 Python 3.10 压缩包（最近的 2024 构建）
curl -L https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-unknown-linux-gnu-install_only.tar.gz | tar -xz

# 验证 Python 版本（预期输出：Python 3.10.13）
~/python310_static/python/bin/python3 --version

# 使用 Python 3.10 创建虚拟环境
~/python310_static/python/bin/python3 -m venv ~/.venv-py310
```

## 创建并注册新的 ipykernel

首先，创建一个新的 Python 虚拟环境：

```bash
python -m venv ~/.venv-testing

# 如果您在前一部分安装了 Python 3.10，请使用：
~/python310_static/python/bin/python3 -m venv ~/.venv-py310
```

激活虚拟环境：

```bash
source ~/.venv-testing/bin/activate

# 如果您使用的是 Python 3.10 虚拟环境：
source ~/.venv-py310/bin/activate
```

在虚拟环境中安装所需的 `ipykernel` 包：

```bash
pip install ipykernel -i https://pypi.tuna.tsinghua.edu.cn/simple
```

将此虚拟环境注册为 Jupyter 内核：

```bash
python -m ipykernel install \
  --user \
  --name python-testing \
  --display-name "Python (testing)"
```

验证新内核是否已成功注册：

```bash
jupyter kernelspec list
```

示例输出：

```text
可用内核：
python3           /home/jovyan/.venv/share/jupyter/kernels/python
python-testing    /home/jovyan/.local/share/jupyter/kernels/python-testing
```

## 在 JupyterLab 中验证内核

注册内核后，请在浏览器中刷新 JupyterLab 页面。

在 **启动器** 页面上，**Notebook** 和 **控制台** 部分下将出现一个名为 **Python (testing)** 的新卡片。

点击 **控制台** 下的 **Python (testing)** 以打开一个新的控制台标签，然后运行以下代码以验证内核是否使用正确的环境：

```python
import sys

print("Python version:", sys.version)
print("Python executable:", sys.executable)
```

如果输出显示 Python 可执行文件路径指向新创建的虚拟环境，则 ipykernel 配置正确。例如：

```text
Python version: 3.11.13 (main, ...)
Python executable: /home/jovyan/.venv-testing/bin/python
```
