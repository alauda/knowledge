---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.x,4.x
ID: KB250900014
---

# Migrating Applications from Kubernetes to ACP

## Overview

This guide describes how to migrate applications from a standard
Kubernetes cluster to Alauda Container Platform (ACP) while reusing
existing Kubernetes manifests (YAML files).

## Environment Information

ACP is highly compatible with standard Kubernetes APIs. Most common
workloads (Deployments, Services, ConfigMaps, Secrets, StatefulSets,
DaemonSets) can be deployed directly to ACP with little or no
modification.

## Prerequisites

- **Alauda Container Platform environment**: You already have an
  account (such as LDAP) and can log in to ACP.
- **Projects and namespaces**: Target projects and namespaces have
  been created in ACP and permissions assigned.
- **Ingress Nginx**: The ingress-nginx controller is already deployed
  in ACP.
- **Istio and Gateway**: Istio has been deployed on ACP and a Gateway
  for the application created.
- **Required tools**:
  - [kubectl
    CLI](https://kubectl.docs.kubernetes.io/installation/kubectl/)
    (configured to connect to the ACP cluster).
- **Container registry access**: Confirm that application images have
  been pushed to the ACP image repository and that users have
  permission to pull them.

## Migration Process

ACP supports directly applying existing Kubernetes YAML manifests
without conversion, simplifying migration.

### 1. Obtaining your application manifests

Prepare the Kubernetes YAML files defining your application's components
(Deployments, Services, Ingress, etc.).\
On the master node of the original Kubernetes cluster, run the following command to export YAMLs with kubectl:

```bash
# Export Deployment from the source cluster
kubectl get deployment <your-app-deployment> -n <source-namespace> -o yaml > yaml-path/deployment.yaml

# Export Service
kubectl get svc <your-app-service> -n <source-namespace> -o yaml > yaml-path/service.yaml

# Similarly export ConfigMap, Secret, StatefulSet, etc.
kubectl get configmap <your-app-configmap> -n <source-namespace> -o yaml > yaml-path/configmap.yaml
```

### 2. Reviewing dependencies

If your application depends on Custom Resource Definitions (CRDs) or
Operators (databases, message queues, etc.), ensure those CRDs/Operators
are installed in the ACP cluster. Also verify that the target namespace
exists.

### 3. Change image registry address

In the YAML files update `spec.containers[*].image` to point to your ACP
registry:

```yaml
containers:
  - name: <my-app>
    image: <registry.company.com/project/my-app:1.0.0>
```

### 4. Deploying the resources on ACP

On the master node of the ACP cluster and apply Kubernetes resources (skip
Ingress/VirtualService at this stage):

```bash
kubectl apply -f yaml-path/deployment.yaml -n <target-namespace>
kubectl apply -f yaml-path/service.yaml -n <target-namespace>
# Other resources similarly
```

You can also apply a whole directory:

```bash
kubectl apply -f yaml-path/ -n <target-namespace>
```

### 5. Expose your services

After migration expose services using an Istio Gateway or Ingress Nginx.

#### 1. Use Istio Gateway

VirtualService defines how traffic is routed to services:

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
    - "<your-app-domain>" # Must match the Gateway hosts
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

Apply configuration:

```bash
kubectl apply -f virtualservice.yaml -n <your-app-namespace>
```

#### 2. Use Ingress Nginx

Ingress defines how requests are routed to services:

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

Apply configuration:

```bash
kubectl apply -f ingress.yaml -n <your-app-namespace>
```

### 6. Verifying the resources

Check that your application's Pods, Services and VirtualService are
running correctly:

```bash
# Check Deployments
kubectl get deployments -n <your-namespace>
# Example output:
# NAME         READY   UP-TO-DATE   AVAILABLE   AGE
# my-app       3/3     3            3           5m

# Check Pods
kubectl get pods -n <your-namespace>
# Example output:
# NAME                          READY   STATUS    RESTARTS   AGE
# my-app-5f9d7b6b9f-abc12       1/1     Running   0          5m
# my-app-5f9d7b6b9f-def34       1/1     Running   0          5m
# my-app-5f9d7b6b9f-ghi56       1/1     Running   0          5m

# Check Services
kubectl get svc -n <your-namespace>
# Example output:
# NAME        TYPE        CLUSTER-IP     EXTERNAL-IP   PORT(S)    AGE
# my-app      ClusterIP   1.1.1.1       <none>        8443/TCP   5m

# Check VirtualService (if using Istio)
kubectl get virtualservice -n <your-namespace>
# Example output:
# NAME       GATEWAYS                          HOSTS                   AGE
# my-app     ["ns/gateway-name"]               ["myapp.example.com"]   2m
```

Ensure all Pods have READY=1/1 and STATUS=Running, Services have correct
ports, and VirtualService or Ingress shows as created.

## [Related Information]

- [How_to_Migrating_Applications_From_OCP](https://cloud.alauda.io/knowledges#solutions/How_to_Migrating_Applications_From_OCP.html)
