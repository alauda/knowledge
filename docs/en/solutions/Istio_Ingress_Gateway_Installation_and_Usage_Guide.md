---
id: KB250500022
products: 
   - Alauda Service Mesh
kind:
   - Solution
---
# Istio Ingress Gateway Installation and Usage Guide

## Overview

This guide will walk you through the process of deploying and using the Istio Ingress Gateway on your business cluster.

The Istio Ingress Gateway runs as an Envoy proxy at the edge of the mesh, providing fine-grained control over traffic entering the mesh with richer functionality and flexibility.

## Prerequisites

- A business cluster with a service mesh deployed.
- An external load balancer that supports LoadBalancer type Services.
- An HTTP test service (such as httpbin) prepared as the target for Ingress traffic.

## Installation Steps

### Install Istio Ingress Gateway

Use the `GatewayDeploy` resource to install the Istio Ingress Gateway.

Execute the following command on the business cluster (configure the gateway parameters first) to install a LoadBalancer type Istio Ingress Gateway:

```bash
# Project name for the gateway deployment
export GATEWAY_PROJECT=""
# Namespace for the gateway deployment
export GATEWAY_NAMESPACE=""
# Gateway name
export GATEWAY_NAME=""
# Create the gateway
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
    # Enable access logging
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
      # Gateway port configuration
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
    # Number of gateway instances
    replicas: 1
  revision: 1-22
  type: ingress
EOF
```

### Verify Deployment Status

Run the following command, and when the `STATUS` shows `Running`, the deployment is successful:

```bash
kubectl -n ${GATEWAY_NAMESPACE} get po -l istio=${GATEWAY_NAMESPACE}-${GATEWAY_NAME}
# Example output:
NAME                               READY   STATUS    RESTARTS   AGE
${GATEWAY_NAME}-84699f6c89-9sjnc   1/1     Running   0          21h
```

Run the following command, and when `EXTERNAL-IP` is assigned a valid IP, the gateway is accessible:

```bash
kubectl -n ${GATEWAY_NAMESPACE} get svc ${GATEWAY_NAME}
# Example output:
NAME              TYPE           CLUSTER-IP   EXTERNAL-IP   PORT(S)                      AGE
${GATEWAY_NAME}   LoadBalancer   10.4.49.33   1.2.3.4       80:32204/TCP,443:31994/TCP   21h
```

## Using the Ingress Gateway as the Cluster Traffic Entry

An ingress `Gateway` describes a load balancer operating at the edge of the mesh that receives incoming HTTP/TCP connections. It configures exposed ports, protocols, etc. but, unlike [Kubernetes Ingress Resources](https://kubernetes.io/docs/concepts/services-networking/ingress/), does not include any traffic routing configuration. Traffic routing for ingress traffic is instead configured using routing rules, exactly in the same way as for internal service requests.

### Configure Ingress Gateway

Execute the following command on the business cluster to create a `Gateway`:

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: httpbin-ingress-gateway
  namespace: ${GATEWAY_NAMESPACE}
spec:
  # The selector should match the labels of the Ingress Gateway Pod.
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

If you want to configure an HTTPS ingress gateway as a security gateway to proxy HTTPS traffic (TLS termination), you need to configure TLS certificates.

First, create a TLS secret in the same namespace as your gateway. For example:

```bash
kubectl create -n ${GATEWAY_NAMESPACE} secret tls <credential-name> \
  --key=<key-file> \
  --cert=<cert-file>
```

Next, apply a `Gateway` resource that listens on port 443 with TLS termination:

```bash
kubectl apply -f - <<EOF
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: httpbin-ingress-gateway-tls
  namespace: ${GATEWAY_NAMESPACE}
spec:
  # The selector should match the labels of the Ingress Gateway Pod.
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

This configures the ingress gateway to terminate TLS for host `httpbin.example.com` using the `<credential-name>` secret.

### Configure Routing

Execute the following command on the business cluster to configure the routing for ingress traffic:

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
  - ${GATEWAY_NAMESPACE}/httpbin-ingress-gateway # namespace and name of the Istio Gateway resource
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

### Test Ingress Service Access

Use the curl tool to test access to the httpbin service:

```bash
# Get the access address
export INGRESS_HOST=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export INGRESS_PORT=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.spec.ports[?(@.name=="http-80")].port}')
# curl request
curl -s -I -HHost:httpbin.example.com "http://$INGRESS_HOST:$INGRESS_PORT/status/200"
# Example output:
...
HTTP/1.1 200 OK
...
server: istio-envoy
...
```

**Note**: This command uses the `-H` flag to set the _Host_ HTTP header to `httpbin.example.com`. This is needed because your ingress `Gateway` is configured to handle `httpbin.example.com`, but in your test environment you have no DNS binding for that host and are simply sending your request to the ingress IP.

## Ingress Gateway HTTPS Passthrough

**Note**:

- Unlike HTTPRoute (which operates at layer 7 and supports fine-grained matching based on request header, path, method, etc.), TLSRoute (which operates at layer 4 and does not have access to decrypted packet content) currently only supports routing based on **port** and **SNI Host**.
- If you need to use both TLS termination (as a security gateway) and TLS passthrough (for services accessed via HTTPS), you can add multiple HTTPS ports to a single gateway or deploy two ingress gateways configured separately.

This example describes how to configure HTTPS ingress access to an HTTPS service, i.e., configure an ingress gateway to perform SNI passthrough, instead of TLS termination on incoming requests.

### Configure Ingress Gateway

Execute the following command on the business cluster to create a `Gateway`:

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
    # Replace with your actual domain
    - my-service.example.com
EOF
```

### Configure Routing

Execute the following command on the business cluster to configure the HTTPS passthrough routing:

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

### Test Ingress Service Access

Use the curl tool to test the HTTPS passthrough service:

```bash
# Get the access address
export INGRESS_HOST=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export SECURE_INGRESS_PORT=$(kubectl -n "${GATEWAY_NAMESPACE}" get service "${GATEWAY_NAME}" -o jsonpath='{.spec.ports[?(@.name=="https-443")].port}')
# curl request
curl -v --resolve "my-service.example.com:$SECURE_INGRESS_PORT:$INGRESS_HOST" --cacert my.crt "https://my-service.example.com:$SECURE_INGRESS_PORT"
```

If the curl command returns a successful response from the HTTPS service, or if the original service testing method confirms success, then the HTTPS passthrough configuration is working correctly.
