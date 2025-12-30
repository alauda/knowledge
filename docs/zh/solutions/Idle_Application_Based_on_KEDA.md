---
kind:
  - Solution
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.x
id: KB251200008
sourceSHA: 6032a62978f2ebd8fc5f4e3a5ffb74a9dbf7ac1d7df2f067b4cd9e38937c369a
---

# 基于流量的闲置应用解决方案

## 概述

基于流量的闲置应用解决方案是一种创新的云原生技术，能够根据应用的 HTTP 流量自动调整资源分配。该解决方案基于 KEDA（Kubernetes 事件驱动的自动扩缩容）[HTTP 附加组件项目](https://github.com/kedacore/http-add-on)构建，提供以下核心功能：

### 介绍

核心特性：

- **从零自动扩展**：在 HTTP 请求到达时自动从零副本启动应用
- **智能缩减至零**：在无流量期间自动将应用缩减至零副本，节省资源成本
- **零请求丢失**：通过智能缓冲机制确保应用启动期间没有请求丢失
- **快速冷启动**：优化的启动过程确保快速响应流量峰值

适用场景：

- 流量波动的 Web 服务
- 内部工具和监控面板应用
- 批处理作业的 API 前端
- 开发和测试环境的资源优化

### 核心架构组件

以下图是默认提供的最常见架构：
![KEDA Http Add-on 架构](../../en/assets/keda-http-add-on-arch.png)

组件职责：

1. **拦截器**：
   - 接收并代理所有传入的 HTTP 流量
   - 在应用启动期间缓冲请求
   - 根据 Host 头将请求路由到正确的后端服务
   - 收集请求队列指标
2. **外部扩展器**：
   - 向 KEDA 暴露与 HTTP 相关的指标
   - 根据配置的阈值触发扩展事件
   - 监控应用的就绪状态
3. **KEDA-HTTP Operator**：
   - 管理 `HTTPScaledObject` 自定义资源
   - 在组件之间同步配置
   - 维护系统健康状态
4. **KEDA**：
   - 基于外部指标驱动 `HPA`
   - 支持多个事件源和指标源
   - 提供统一的自动扩缩容引擎

## 安装与实践

### 安装 KEDA

请按照 [如何安装 KEDA Operator](/solutions/How_to_Install_KEDA_Operator.md) 在您的业务集群中安装 KEDA。

### 安装 HTTP 附加组件

请按照 [安装 KEDA HTTP 附加组件](https://github.com/kedacore/http-add-on/blob/main/docs/install.md) 在您的业务集群中安装 HTTP 附加组件。

### 应用示例

创建示例应用：

```bash
kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-nginx
spec:
  replicas: 0  # 从零副本开始
  selector:
    matchLabels:
      app: app-nginx
  template:
    metadata:
      labels:
        app: app-nginx
    spec:
      containers:
      - name: app
        image: nginx:latest
        ports:
        - containerPort: 80
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: app-nginx
spec:
  ports:
  - port: 80
    targetPort: 80
  selector:
    app: app-nginx
EOF
```

配置自动扩缩容：

```bash
kubectl apply -f - <<EOF
apiVersion: http.keda.sh/v1alpha1
kind: HTTPScaledObject
metadata:
  name: app-nginx-scaler
spec:
    hosts:
      - app.nginx.com
    pathPrefixes:
      - /nginx
    scaleTargetRef:
      name: app-nginx
      kind: Deployment
      apiVersion: apps/v1
      service: app-nginx
      port: 80
    replicas:
      min: 0
      max: 5
    scaledownPeriod: 300
    scalingMetric:
      requestRate:
        granularity: 1s
        targetValue: 100
        window: 1m
EOF
```

## 从零扩展

### 实践步骤

1. 验证初始状态：
   ```bash
   kubectl get deployment app-nginx
   ```
2. 获取访问地址：
   ```bash
   kubectl get svc -n keda keda-add-ons-http-interceptor-proxy
   ```
3. 发送测试请求以触发扩展：
   ```bash
   # 发送 HTTP 请求以触发扩展
   # 此处，您必须向 /nginx 端点发送请求，Host 头为：app.nginx.com，与 HTTPScaledObject cr 的设置相同
   curl -H "Host: app.nginx.com" http://<service-ip>:8080/nginx

   # 或使用负载测试工具
   hey -n 100 -c 10 -H "Host: app.nginx.com" http://<service-ip>:8080/nginx
   ```
4. 监控扩展过程：
   ```bash
   # 实时监控 Pod 创建
   kubectl get pods -l app=app-nginx -w

   # 检查 HPA 状态
   kubectl get hpa -w

   # 查看详细日志
   kubectl logs -f deployment/keda-add-ons-http-interceptor -n keda
   ```

### 从零扩展过程

![KEDA Http Add-on 从零扩展](../../en/assets/keda-http-add-on-scale-from-zero.svg)

## 缩减至零

### 实践步骤

1. 观察运行状态：
   ```bash
   # 确认应用正在运行
   kubectl get deployment app-nginx
   # 输出应显示 READY 1/1 或更多

   kubectl get pods -l app=app-nginx
   # 查看正在运行的 Pods
   ```
2. 停止流量生成：
   ```bash
   # 停止所有负载测试工具
   # 等待系统检测到无流量状态
   ```
3. 监控缩减过程：
   ```bash
   # 观察 HPA 状态
   kubectl get hpa -w

   # 检查副本是否缩减至零
   kubectl get deployment app-nginx -w
   # 输出应显示 0/0 副本
   ```
4. 验证缩减结果：
   ```bash
   # 等待后，确认缩减完成
   kubectl get deployment app-nginx
   # 输出应显示 READY 0/0

   kubectl get pods -l app=app-nginx
   # 应显示未找到资源
   ```

### 缩减至零过程

![KEDA Http Add-on 缩减至零](../../en/assets/keda-http-add-on-scale-to-zero.svg)

## 结论

基于 KEDA HTTP 附加组件的流量驱动闲置应用解决方案为现代云原生环境带来了显著价值：

1. 终极成本优化：通过将闲置应用缩减至零来最大化成本效率
2. 智能弹性扩展：根据实际流量自动调整，无需人工干预
3. 高可用性保障：通过请求缓冲机制确保零请求丢失
4. 简单易用：标准的 Kubernetes 原生体验，学习曲线低
