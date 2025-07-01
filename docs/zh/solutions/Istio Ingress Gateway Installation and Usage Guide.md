---
id: KB250500022
products:
  - Alauda Service Mesh
kind:
  - Solution
sourceSHA: ba79b97e7ac8ce7aebe29021b0a07f158f667cbfba07488c7cdadc9effd61d8b
---

# Istio Ingress Gateway 安装与使用指南

## 概述

本指南将引导您在业务集群上部署和使用 Istio Ingress Gateway。

Istio Ingress Gateway 作为 Envoy 代理运行在网格的边缘，提供对进入网格的流量的细粒度控制，具有更丰富的功能和灵活性。

## 先决条件

- 已部署服务网格的业务集群。
- 支持 LoadBalancer 类型服务的外部负载均衡器。
- 准备好的 HTTP 测试服务（如 httpbin），作为 Ingress 流量的目标。

## 安装步骤

### 安装 Istio Ingress Gateway

使用 `GatewayDeploy` 资源安装 Istio Ingress Gateway。

在业务集群上执行以下命令（首先配置网关参数）以安装 LoadBalancer 类型的 Istio Ingress Gateway：

```bash
# 网关部署的项目名称
export GATEWAY_PROJECT=""
# 网关部署的命名空间
export GATEWAY_NAMESPACE=""
# 网关名称
export GATEWAY_NAME=""
# 创建网关
kubectl apply -f - <<EOF
apiVersion: asm.alauda.io/v1alpha1
kind: GatewayDeploy
metadata:
  annotations:
    cpaas.io/display-name: ''
  labels:
    asm.cpaas.io/owner-role: custom
    asm.cpaas.io/gateway-type: ingress
    cpaas.io/project: ${GATEWAY_PROJECT}
    asm.cpaas.io/active-since: v3.13
  name: ${GATEWAY_NAME}
  namespace: ${GATEWAY_NAMESPACE}
spec:
  global:
    podStrategy: required
  accessLogging:
    # 启用访问日志
    enabled: false
  k8s:
    nodeSelector:
      kubernetes.io/os:
      - linux
    resources:
      requests:
        cpu: '0.25'
        memory: 128Mi
      limits:
        cpu: '2'
        memory: 1024Mi
    service:
      type: LoadBalancer
      # 网关端口配置
      ports:
        http:
          data:
          - items:
            - protocol: HTTP
              targetPort: 8080
              port: 80
            name: http-80
        https:
          data:
          - items:
            - protocol: HTTPS
              targetPort: 8443
              port: 443
            name: https-443
    tolerations:
    - effect: NoSchedule
      key: node-role.kubernetes.io/control-plane
      operator: Exists
    - effect: NoSchedule
      key: node-role.kubernetes.io/master
      operator: Exists
    # 网关实例数量
    replicas: 1
  revision: 1-22
  type: ingress
EOF
```

### 验证部署状态

运行以下命令，当 `STATUS` 显示为 `Running` 时，表示部署成功：

```bash
kubectl -n ${GATEWAY_NAMESPACE} get po -l istio=${GATEWAY_NAMESPACE}-${GATEWAY_NAME}
# 示例输出：
NAME                               READY   STATUS    RESTARTS   AGE
${GATEWAY_NAME}-84699f6c89-9sjnc   1/1     Running   0          21h
```

运行以下命令，当 `EXTERNAL-IP` 被分配一个有效 IP 时，网关可访问：

```bash
kubectl -n ${GATEWAY_NAMESPACE} get svc ${GATEWAY_NAME}
# 示例输出：
NAME              TYPE           CLUSTER-IP   EXTERNAL-IP   PORT(S)                      AGE
${GATEWAY_NAME}   LoadBalancer   10.4.49.33   1.2.3.4       80:32204/TCP,443:31994/TCP   21h
```

## 使用 Ingress Gateway 作为集群流量入口

Ingress `Gateway` 描述了一个在网格边缘操作的负载均衡器，接收传入的 HTTP/TCP 连接。它配置暴露的端口、协议等，但与 [Kubernetes Ingress 资源](https://kubernetes.io/docs/concepts/services-networking/ingress/) 不同，不包括任何流量路由配置。Ingress 流量的路由配置是通过路由规则进行的，方式与内部服务请求完全相同。

### 配置 Ingress Gateway

在业务集群上执行以下命令以创建 `Gateway`：

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: httpbin-ingress-gateway
  namespace: ${GATEWAY_NAMESPACE}
spec:
  # 选择器应与 Ingress Gateway Pod 的标签匹配。
  selector:
    istio: ${GATEWAY_NAMESPACE}-${GATEWAY_NAME}
  servers:
  - port:
      number: 80
      name: http
      protocol: HTTP
    hosts:
    - "httpbin.example.com"
EOF
```

如果您想将 HTTPS Ingress Gateway 配置为代理 HTTPS 流量的安全网关（TLS 终止），则需要配置 TLS 证书。

首先，在与您的网关相同的命名空间中创建一个 TLS 秘密。例如：

```bash
kubectl create -n ${GATEWAY_NAMESPACE} secret tls <credential-name> \
  --key=<key-file> \
  --cert=<cert-file>
```

接下来，应用一个监听 443 端口并进行 TLS 终止的 `Gateway` 资源：

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: httpbin-ingress-gateway-tls
  namespace: ${GATEWAY_NAMESPACE}
spec:
  # 选择器应与 Ingress Gateway Pod 的标签匹配。
  selector:
    istio: ${GATEWAY_NAMESPACE}-${GATEWAY_NAME}
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: SIMPLE
      credentialName: <credential-name>
    hosts:
    - "httpbin.example.com"
EOF
```

这将配置 Ingress Gateway 为主机 `httpbin.example.com` 使用 `<credential-name>` 秘密进行 TLS 终止。

### 配置路由

在业务集群上执行以下命令以配置 Ingress 流量的路由：

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: httpbin
  namespace: ${GATEWAY_NAMESPACE}
spec:
  hosts:
  - "httpbin.example.com"
  gateways:
  - ${GATEWAY_NAMESPACE}/httpbin-ingress-gateway # Istio Gateway 资源的命名空间和名称
  http:
  - match:
    - uri:
        prefix: /status
    - uri:
        prefix: /delay
    route:
    - destination:
        port:
          number: 8000
        host: httpbin.my-namespace.svc.cluster.local
EOF
```

### 测试 Ingress 服务访问

使用 curl 工具测试对 httpbin 服务的访问：

```bash
# 获取访问地址
export INGRESS_HOST=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export INGRESS_PORT=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.spec.ports[?(@.name=="http-80")].port}')
# curl 请求
curl -s -I -HHost:httpbin.example.com "http://$INGRESS_HOST:$INGRESS_PORT/status/200"
# 示例输出：
...
HTTP/1.1 200 OK
...
server: istio-envoy
...
```

**注意**：此命令使用 `-H` 标志将 *Host* HTTP 头设置为 `httpbin.example.com`。这是必要的，因为您的 Ingress `Gateway` 被配置为处理 `httpbin.example.com`，但在您的测试环境中没有该主机的 DNS 绑定，只是将请求发送到 Ingress IP。

## Ingress Gateway HTTPS 透传

**注意**：

- 与 HTTPRoute（在第 7 层操作并支持基于请求头、路径、方法等的细粒度匹配）不同，TLSRoute（在第 4 层操作并无法访问解密的包内容）目前仅支持基于 **端口** 和 **SNI 主机** 的路由。
- 如果您需要同时使用 TLS 终止（作为安全网关）和 TLS 透传（用于通过 HTTPS 访问的服务），可以向单个网关添加多个 HTTPS 端口，或分别部署两个配置不同的 Ingress Gateway。

本示例描述了如何配置对 HTTPS 服务的 HTTPS Ingress 访问，即配置 Ingress Gateway 执行 SNI 透传，而不是对传入请求进行 TLS 终止。

### 配置 Ingress Gateway

在业务集群上执行以下命令以创建 `Gateway`：

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: tls-passthrough-gateway
  namespace: ${GATEWAY_NAMESPACE}
spec:
  selector:
    istio: ${GATEWAY_NAMESPACE}-${GATEWAY_NAME}
  servers:
  - port:
      number: 443
      name: https
      protocol: HTTPS
    tls:
      mode: PASSTHROUGH
    hosts:
    # 替换为您的实际域名
    - my-service.example.com
EOF
```

### 配置路由

在业务集群上执行以下命令以配置 HTTPS 透传路由：

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: my-https-service
  namespace: my-namespace
spec:
  hosts:
  - my-service.example.com
  gateways:
  - ${GATEWAY_NAMESPACE}/tls-passthrough-gateway
  tls:
  - match:
    - port: 443
      sniHosts:
      - my-service.example.com
    route:
    - destination:
        host: my-https-service.my-namespace.svc.cluster.local
        port:
          number: 443
EOF
```

### 测试 Ingress 服务访问

使用 curl 工具测试 HTTPS 透传服务：

```bash
# 获取访问地址
export INGRESS_HOST=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export SECURE_INGRESS_PORT=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.spec.ports[?(@.name=="https-443")].port}')
# curl 请求
curl -v --resolve "my-service.example.com:$SECURE_INGRESS_PORT:$INGRESS_HOST" --cacert my.crt "https://my-service.example.com:$SECURE_INGRESS_PORT"
```

如果 curl 命令返回 HTTPS 服务的成功响应，或者原始服务测试方法确认成功，则 HTTPS 透传配置正常工作。
