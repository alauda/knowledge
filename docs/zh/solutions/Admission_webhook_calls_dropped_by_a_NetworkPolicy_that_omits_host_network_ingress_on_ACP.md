---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - '4.1.0,4.2.x'
id: KB260500642
sourceSHA: 1e010b058dacbe256c491535168b1ad3703a14393aed3e9ff3504c86ef552449
---

# 被省略 host-network 入口的 NetworkPolicy 拒绝的 Admission webhook 调用

## 问题

在 Alauda 容器平台 (Kubernetes v1.34.5, kube-ovn CNI) 上，注册的 admission webhook 在其命名空间中引入 NetworkPolicy 后停止从控制平面访问。kube-apiserver 通过 HTTPS 调用 admission webhooks，将 admission review POST 到 webhook 的服务端点 `https://<service>.<namespace>.svc:443`。当 webhook 命名空间携带一个 allow-same-namespace 的 NetworkPolicy，但没有允许来自 host-network 源的入口策略时，kube-apiserver 的 webhook 调用在到达 webhook pod 之前被拒绝。

## 根本原因

kube-apiserver 作为一个 host-network pod 在控制平面节点上运行，因此其 admission-webhook 请求源自节点的主机网络，而不是来自集群 pod CIDR 中的地址。在 kube-ovn 中，host-network 到 pod 的流量由 CNI 进行 SNAT，因此入口流量到达 webhook pod 时，呈现 CNI 的内部 SNAT（join/transit）子网地址作为其源，而不是原始节点 IP——这就是为什么匹配的 NetworkPolicy 规则必须允许该内部子网，而不是节点的主地址。webhook 命名空间中的 NetworkPolicy 控制哪些源被允许向 webhook pod 发送入口流量，kube-ovn 通过将其转换为 OVN ACLs 来强制执行 `networking.k8s.io/v1` NetworkPolicy。因此，allow-same-namespace-only 策略仅匹配同一命名空间的 pod 源，并静默拒绝 host-network apiserver 的入口流量，从而中断 webhook 调用。

## 解决方案

向 webhook 的命名空间添加一个 NetworkPolicy，明确允许来自主机网络的入口流量，以便 kube-apiserver 源能够到达 webhook pod。由于 kube-ovn 将该源呈现为其内部 host-to-pod SNAT 子网（join/transit 子网），而不是可以标签选择的命名空间，因此 host-network 入口规则必须选择那些具有覆盖该子网的 `ipBlock.cidr` 的源，而不是命名空间标签选择器。确切的 CIDR 是集群特定的，应根据 CNI 的子网配置进行确认（例如，`kubectl get subnet`）；下面的示例使用了 `100.64.0.0/16` 的 join 子网。以下策略保持同一命名空间的允许，并为该子网添加了一个 host-network 入口规则：

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-apiserver-to-webhook
  namespace: cert-manager
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector: {}
    - from:
        - ipBlock:
            cidr: 100.64.0.0/16
```

将策略应用于 webhook 命名空间：

```bash
kubectl apply -f allow-apiserver-to-webhook.yaml
```

一旦 kube-ovn 程序化相应的 OVN ACLs，host-network apiserver 的入口流量将被允许，admission webhook 调用将再次到达 webhook pod。如果集群的 join/SNAT 子网与示例不同，或者控制平面节点的 SNAT 地址超出该范围，请扩大 `ipBlock.cidr` 以覆盖这些 apiserver 实例作为其源所呈现的内部子网。

## 诊断步骤

列出 webhook 命名空间中的 NetworkPolicies，以确认是否存在或缺少 host-network 入口策略：

```bash
kubectl get networkpolicy -n cert-manager
```

检查策略入口规则，以确认它们是否覆盖 host-network 源；设置为 allow-same-namespace-only 的规则如果没有针对节点或 join 子网的 `ipBlock`，则是导致 apiserver 调用被拒绝的配置：

```bash
kubectl get networkpolicy -n cert-manager -o yaml
```

确认 webhook 的 clientConfig 指向集群内的 HTTPS 服务，以便 apiserver 的 HTTPS POST 目标与 NetworkPolicy 必须允许的内容匹配：

```bash
kubectl get validatingwebhookconfiguration -o yaml
```
