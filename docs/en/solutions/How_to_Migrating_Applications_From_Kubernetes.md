---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x,4.x
---

# Migrating Applications from Kubernetes to ACP

## Overview

This document provides a streamlined procedure for migrating applications from a standard Kubernetes cluster to Alauda Container Platform (ACP) using existing Kubernetes manifests.

## Environment Information

ACP is designed to be highly compatible with standard Kubernetes APIs. In most cases, existing Kubernetes resource manifests (YAML files) for workloads such as Deployments, Services, ConfigMaps, Secrets, StatefulSets, and DaemonSets can be applied to ACP with minimal or no modification.

## Prerequisites

- **Alauda Container Platform environment**: Ensure you have an account (e.g., LDAP) and access to ACP.
- **Project and namespaces**: Pre-created projects and namespaces in ACP with appropriate permissions.
- **Ingress Nginx**: Deploy the ingress-nginx controller in advance.
- **Istio and gateway**: Deploy Istio on ACP and create a gateway for the application.
- **Required tools**:
  - [Kubectl CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/): For interacting with the ACP cluster.
- **Container registry access**: Before initiating the application migration, ensure that the application images have been pushed to the ACP image repository and that users have permission to access them.

## Migration Process

Applications can be deployed directly using existing Kubernetes YAML manifests. No prior conversion of the manifests is required, which simplifies the migration procedure.

### 1. Obtaining your application manifests

Prepare the Kubernetes YAML files that define your application's components (Deployments, Services, Ingresses, etc.).

### 2. Reviewing dependencies

If your application relies on specific Custom Resource Definitions (CRDs) or Operators (e.g., for databases, messaging queues), ensure these are installed or available on your ACP cluster. Additionally, verify the project and namespace where you want to deploy your application are already created.

### 3. Change image registry address

Update the image registry addresses in your manifests to point to the ACP registry. Update the spec.containers[*].image field in your Deployment, StatefulSet, Pod, and other resource definitions.

### 4. Deploying the resources on ACP

Log in to ACP and apply the Kubernetes resources (excluding Ingress at this stage).

```bash
kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name>

kubectl apply -f /yaml-path/deployment.yaml
kubectl apply -f /yaml-path/service.yaml
# and other resources
```

### 5. Expose your services

Next, expose the migrated services using an Istio gateway.

#### 1. Use Istio Gateway

A VirtualService specifies how requests are routed to services within the service mesh.

```yaml
# virtualservice.yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  labels:
    cpaas.io/gw-name: <istio-gateway-name>
    cpaas.io/gw-ns: <istio-gateway-namespaces>
  name: <your-app-name>
  namespace: <your-app-namespace>
spec:
  gateways:
    - <istio-gateway-namespaces>/<istio-gateway-name>
  hosts:
    - "<your-app-domain>" # Must match the Gateway's hosts
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

Apply the VirtualService:

```Bash
kubectl apply -f virtualservice.yaml -n <your-target-namespace>
```

#### 2. Use Ingress Nginx

An Ingress specifies how requests are routed to services.

```yaml
- apiVersion: networking.k8s.io/v1
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

Apply the Ingress:

```Bash
kubectl apply -f ingress.yaml -n <your-target-namespace>
```

### 6. Verifying the resources

Verify that the application's pods and other resources are running as expected.

```bash
# Check deployments
kubectl get deployments -n <your-namespace>

# Check pods
kubectl get pods -n <your-namespace>

# Check services
kubectl get svc -n <your-namespace>

# Check virtualservice
kubectl get virtualservice -n <your-namespace>

```
