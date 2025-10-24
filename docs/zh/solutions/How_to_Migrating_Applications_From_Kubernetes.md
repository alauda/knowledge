---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - '3.x,4.x'
ID: KB250900014
id: KB1761295416-3095
sourceSHA: 1e9c3269b4d67e5fdf2bf2b8c10849c9f04b47084fd22e1092ccce3605264a5a
---

# 从 Kubernetes 迁移应用到 ACP

## 概述

本指南描述了如何将应用从标准 Kubernetes 集群迁移到 Alauda Container Platform (ACP)，同时重用现有的 Kubernetes 清单（YAML 文件）。

## 环境信息

ACP 与标准 Kubernetes API 高度兼容。大多数常见工作负载（Deployments、Services、ConfigMaps、Secrets、StatefulSets、DaemonSets）可以直接部署到 ACP，几乎无需修改。

## 先决条件

- **Alauda Container Platform 环境**：您已经拥有一个账户（如 LDAP），并可以登录到 ACP。
- **项目和命名空间**：目标项目和命名空间已在 ACP 中创建并分配了权限。
- **Ingress Nginx**：ingress-nginx 控制器已在 ACP 中部署。
- **Istio 和 Gateway**：Istio 已在 ACP 上部署，并为应用创建了 Gateway。
- **所需工具**：
  - [kubectl
    CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/)
    （已配置为连接到 ACP 集群）。
- **容器注册表访问**：确认应用镜像已推送到 ACP 镜像库，并且用户有权限拉取它们。

## 迁移过程

ACP 支持直接应用现有的 Kubernetes YAML 清单，无需转换，从而简化迁移。

### 1. 获取您的应用清单

准备定义您应用组件的 Kubernetes YAML 文件（Deployments、Services、Ingress 等）。\
在原 Kubernetes 集群的主节点上，运行以下命令以使用 kubectl 导出 YAML：

```bash
# 从源集群导出 Deployment
kubectl get deployment <your-app-deployment> -n <source-namespace> -o yaml > yaml-path/deployment.yaml

# 导出 Service
kubectl get svc <your-app-service> -n <source-namespace> -o yaml > yaml-path/service.yaml

# 同样导出 ConfigMap、Secret、StatefulSet 等
kubectl get configmap <your-app-configmap> -n <source-namespace> -o yaml > yaml-path/configmap.yaml
```

### 2. 审查依赖关系

如果您的应用依赖于自定义资源定义（CRDs）或操作器（数据库、消息队列等），请确保这些 CRDs/操作器已在 ACP 集群中安装。同时验证目标命名空间是否存在。

### 3. 更改镜像注册表地址

在 YAML 文件中更新 `spec.containers[*].image` 指向您的 ACP 注册表：

```yaml
containers:
  - name: <my-app>
    image: <registry.company.com/project/my-app:1.0.0>
```

### 4. 在 ACP 上部署资源

在 ACP 集群的主节点上应用 Kubernetes 资源（此阶段跳过 Ingress/VirtualService）：

```bash
kubectl apply -f yaml-path/deployment.yaml -n <target-namespace>
kubectl apply -f yaml-path/service.yaml -n <target-namespace>
# 其他资源同样
```

您也可以应用整个目录：

```bash
kubectl apply -f yaml-path/ -n <target-namespace>
```

### 5. 暴露您的服务

迁移后，使用 Istio Gateway 或 Ingress Nginx 暴露服务。

#### 1. 使用 Istio Gateway

VirtualService 定义了流量如何路由到服务：

```yaml
# virtualservice.yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  labels:
    cpaas.io/gw-name: <istio-gateway-name>
    cpaas.io/gw-ns: <istio-gateway-namespace>
  name: <your-app-name>
  namespace: <your-app-namespace>
spec:
  gateways:
    - <istio-gateway-namespace>/<istio-gateway-name>
  hosts:
    - "<your-app-domain>" # 必须与 Gateway 主机匹配
  tls:
    - match:
        - port: 443
          sniHosts:
            - <your-app-domain>
      route:
        - destination:
            host: <your-app-servicename>.<your-app-namespace>.svc.cluster.local
            port:
              number: 8443
          weight: 100
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: <your-app-name>
  namespace: <your-app-namespace>
spec:
  host: <your-app-servicename>.<your-app-namespace>.svc.cluster.local
  trafficPolicy:
    loadBalancer:
      simple: RANDOM
```

应用配置：

```bash
kubectl apply -f virtualservice.yaml -n <your-app-namespace>
```

#### 2. 使用 Ingress Nginx

Ingress 定义了请求如何路由到服务：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  annotations:
    nginx.ingress.kubernetes.io/backend-protocol: HTTPS
    nginx.ingress.kubernetes.io/load-balance: round_robin
    nginx.ingress.kubernetes.io/ssl-passthrough: "true"
  name: <your-app-name>
  namespace: <your-app-namespace>
spec:
  ingressClassName: <your-ingress-nginx-class-name>
  rules:
    - host: <your-app-domain>
      http:
        paths:
          - backend:
              service:
                name: <your-app-servicename>
                port:
                  number: 8443
            path: /
            pathType: Prefix
  tls:
    - hosts:
        - <your-app-domain>
```

应用配置：

```bash
kubectl apply -f ingress.yaml -n <your-app-namespace>
```

### 6. 验证资源

检查您的应用的 Pods、Services 和 VirtualService 是否正常运行：

```bash
# 检查 Deployments
kubectl get deployments -n <your-namespace>
# 示例输出：
# NAME         READY   UP-TO-DATE   AVAILABLE   AGE
# my-app       3/3     3            3           5m

# 检查 Pods
kubectl get pods -n <your-namespace>
# 示例输出：
# NAME                          READY   STATUS    RESTARTS   AGE
# my-app-5f9d7b6b9f-abc12       1/1     Running   0          5m
# my-app-5f9d7b6b9f-def34       1/1     Running   0          5m
# my-app-5f9d7b6b9f-ghi56       1/1     Running   0          5m

# 检查 Services
kubectl get svc -n <your-namespace>
# 示例输出：
# NAME        TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
# my-app      ClusterIP   1.1.1.1       <none>        8443/TCP   5m

# 检查 VirtualService（如果使用 Istio）
kubectl get virtualservice -n <your-namespace>
# 示例输出：
# NAME       GATEWAYS                          HOSTS                   AGE
# my-app     ["ns/gateway-name"]               ["myapp.example.com"]   2m
```

确保所有 Pods 的 READY=1/1 和 STATUS=Running，Services 具有正确的端口，VirtualService 或 Ingress 显示为已创建。

## \[相关信息]

- [如何迁移应用程序从 OCP](https://cloud.alauda.io/knowledges#solutions/How_to_Migrating_Applications_From_OCP.html)
