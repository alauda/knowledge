---
id: KB250500009
---
# ACP Deployment Strategies with Argo Rollouts

## Overview

Updating applications in Kubernetes clusters using standard rolling updates can sometimes introduce risks. To mitigate this, advanced deployment strategies like blue/green and canary are widely adopted. Alauda Container Platform is fully compatible with Kubernetes APIs and supports these methods.

### Understanding deployment strategies

#### Blue/green deployment

In a blue/green deployment, the new version is deployed to the inactive Green environment. Once ready, all user traffic is switched instantly from the Blue environment to the Green environment.

#### Canary deployment

Canary deployment introduces the new version gradually to a small subset of users before a full rollout. The new version runs alongside the old. Traffic is slowly shifted to the new version in small increments, allowing monitoring for issues.

### Argo Rollouts introduction

Argo Rollouts is a Kubernetes controller and set of CRDs which provide advanced deployment capabilities such as blue/green, canary, canary analysis, experimentation, and progressive delivery features to Kubernetes.

### Understanding implementation methods

Alauda Container Platform offers several implementation methods for blue/green and canary deployments using Argo Rollouts.

| Chapter | Underlying Mechanism | Traffic Type | Deployment Strategies |
| ------- | -------------------- | ------------ | --------------------- |
| 1       | ALB/Nginx Ingress    | North-south only | Blue/green        |
| 2       | ALB/Nginx Ingress    | North-south only | Canary        |

**Note**: Alternative method leveraging standard Kubernetes `Service` is covered in ACP Deployment Strategies.

#### Method 1: Using ALB or Nginx Ingress with Argo Rollouts to implement blue/green deployment

This method leverages Argo Rollouts with ALB or Nginx Ingress for traffic management:

1. Define a Kubernetes Rollout resource that specifies the desired strategy (blueGreen or canary).
2. The Rollout references a Traffic Manager (ALB/Nginx Ingress) to control traffic flow.
3. Argo Rollouts automatically orchestrates the deployment steps: deploying new pods, waiting, and modifying traffic weights.
4. For blue/green deployments, traffic is instantly switched from the old to new version.

#### Method 2: Using ALB or Nginx Ingress with Argo Rollouts to implement canary deployment

This method leverages Argo Rollouts with ALB or Nginx Ingress for traffic management:

1. Define a Kubernetes Rollout resource that specifies the desired strategy (blueGreen or canary).
2. The Rollout references a Traffic Manager (ALB/Nginx Ingress) to control traffic flow.
3. Argo Rollouts automatically orchestrates the deployment steps: deploying new pods, waiting, and modifying traffic weights.
4. For canary deployments, traffic is gradually shifted based on configured steps and weights.


## Chapter 1. Using ALB or Nginx Ingress with Argo Rollouts for blue/green deployment

In ACP (Alauda Container Platform), Argo Rollouts can automate blue/green deployments using ALB or Nginx Ingress for traffic management. This chapter explains how to implement blue/green deployments with Argo Rollouts.

### Concepts

- **Rollout**: A custom resource definition (CRD) in Kubernetes that replaces standard Deployment resources, enabling advanced deployment control such as blue/green and canary deployments.
- **BlueGreen Strategy**: A deployment strategy where two identical environments (blue and green) exist, with traffic switching between them.
- **WorkloadRef**: A reference to an existing Deployment that Argo Rollouts will manage.

### Prerequisites

1. Alauda Container Platform installed with a working Kubernetes cluster available.
2. Argo Rollouts installed in the cluster.
3. Argo Rollouts kubectl plugin installed.
4. A project to create a namespace in it.
5. A namespace in the cluster where the application will be deployed.
6. `kubectl` command-line tool installed with `kubectl-acp` plugin for authentication with ACP Platform.
7. Authenticated to the cluster using `kubectl acp login` command.


### Initial application deployment

Start by defining the "blue" version of your application. This is the current version that users will access. Here is an example of the blue deployment. The container image version is `hello:1.23.1`, and proper labels are `app=web`.

An example deployment YAML file for the blue version is as follows:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: hello:1.23.1
        ports:
        - containerPort: 80
```

Save into a yaml file named `web-deployment.yaml` and apply it with:

```shell
kubectl apply -f web-deployment.yaml
```

The deployment needs a `Service` that exposes the blue deployment. This service will forward traffic to the blue pods based on matching labels. Initially, the service selector targets pods labeled with `app=web`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

Save into a yaml file named `web-service.yaml` and apply it with:

```shell
kubectl apply -f web-service.yaml
```

### Blue/green deployment procedure

#### Step 1: Creating the Rollout

Create a `Rollout` resource from Argo Rollouts with `BlueGreen` strategy:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rollout-bluegreen
spec:
  replicas: 2
  revisionHistoryLimit: 2
  selector:
    matchLabels:
      app: web
  workloadRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
    scaleDown: onsuccess
  strategy:
    blueGreen:
      activeService: web
      autoPromotionEnabled: false
```

Save into a yaml file named `rollout.yaml` and apply it with:

```shell
kubectl apply -f rollout.yaml
```

**Explanation of YAML fields:**

- `spec.selector`: Label selector for pods. Existing ReplicaSets whose pods are selected by this will be the ones affected by this rollout. It must match the pod template's labels.

- `workloadRef`: Specifies the workload reference and scale down strategy to apply the rollouts.
  - `scaleDown`: Specifies if the workload (Deployment) is scaled down after migrating to Rollout. The possible options are:
    - "never": the Deployment is not scaled down.
    - "onsuccess": the Deployment is scaled down after the Rollout becomes healthy.
    - "progressively": as the Rollout is scaled up the Deployment is scaled down. If the Rollout fails the Deployment will be scaled back up.

- `strategy`: The rollout strategy, supports `BlueGreen` and `Canary` strategies.
  - `blueGreen`: The `BlueGreen` rollout strategy definition.
    - `activeService`: Specifies the service to update with the new template hash at time of promotion. This field is mandatory for the blueGreen update strategy.
    - `autoPromotionEnabled`: Disables automated promotion of the new stack by pausing the rollout immediately before the promotion. If omitted, the default behavior is to promote the new stack as soon as the ReplicaSets are completely ready/available. Rollouts can be resumed using: `kubectl argo rollouts promote ROLLOUT`

This sets up the rollouts for the deployment with `BlueGreen` strategy.

#### Step 2: Verifying the Rollouts

After the `Rollout` was created, the Argo Rollouts will create a new ReplicaSet with same template of the deployment. While the pods of new ReplicaSet is healthy, the deployment is scaled down to 0.

Use the following command to ensure the pods are running properly:

```shell
$ kubectl argo rollouts get rollout rollout-bluegreen
Name:            rollout-bluegreen
Namespace:       default
Status:          ✔ Healthy
Strategy:        BlueGreen
Images:          hello:1.23.1 (stable, active)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                           KIND        STATUS     AGE  INFO
⟳ rollout-bluegreen                            Rollout     ✔ Healthy  95s
└──# revision:1
   └──⧉ rollout-bluegreen-595d4567cc           ReplicaSet  ✔ Healthy  18s  stable,active
      ├──□ rollout-bluegreen-595d4567cc-mc769  Pod         ✔ Running  8s   ready:1/1
      └──□ rollout-bluegreen-595d4567cc-zdc5x  Pod         ✔ Running  8s   ready:1/1
```

The service `web` will forward traffic to the pods created by rollouts. Use this command:

```shell
kubectl describe service web | grep Endpoints
```

#### Step 3: Preparing Green Deployment

Next, prepare the new version of the application as the green deployment. Update the deployment `web` with the new image version (e.g., `hello:1.23.2`).

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: hello:1.23.2
        ports:
        - containerPort: 80
```

**Explanation of YAML fields:**

- Identical to the original deployment, with the exception of:
  - `containers.image`: Updated to new image version.

Apply it with:

```shell
kubectl apply -f web-deployment.yaml
```

This sets up the new application version for testing.

The rollouts will create a new Replicaset to manage the green pods, and the traffic still forward to the blue pods. Use the following command to verify:

```shell
$ kubectl argo rollouts get rollout rollout-bluegreen
Name:            rollout-bluegreen
Namespace:       default
Status:          ॥ Paused
Message:         BlueGreenPause
Strategy:        BlueGreen
Images:          hello:1.23.1 (stable, active)
                 hello:1.23.2
Replicas:
  Desired:       2
  Current:       4
  Updated:       2
  Ready:         2
  Available:     2

NAME                                           KIND        STATUS     AGE  INFO
⟳ rollout-bluegreen                            Rollout     ॥ Paused   14m
├──# revision:2
│  └──⧉ rollout-bluegreen-776b688d57           ReplicaSet  ✔ Healthy  24s
│     ├──□ rollout-bluegreen-776b688d57-kxr66  Pod         ✔ Running  23s  ready:1/1
│     └──□ rollout-bluegreen-776b688d57-vv7t7  Pod         ✔ Running  23s  ready:1/1
└──# revision:1
   └──⧉ rollout-bluegreen-595d4567cc           ReplicaSet  ✔ Healthy  12m  stable,active
      ├──□ rollout-bluegreen-595d4567cc-mc769  Pod         ✔ Running  12m  ready:1/1
      └──□ rollout-bluegreen-595d4567cc-zdc5x  Pod         ✔ Running  12m  ready:1/1
```

Currently, there are 4 pods running, with blue and green version. And the active service is the blue version, the rollout process is paused.

If you use helm chart to deploy the application, use helm tool to upgrade the application to the green version.

#### Step 4: Promoting the Rollout to Green

When the green version is ready, promote the rollout to switch traffic to the green pods. Use the following command:

```shell
kubectl argo rollouts promote rollout-bluegreen
```

To Verify if the rollout is completed:

```shell
kubectl argo rollouts get rollout rollout-bluegreen
Name:            rollout-bluegreen
Namespace:       default
Status:          ✔ Healthy
Strategy:        BlueGreen
Images:          hello:1.23.2 (stable, active)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                           KIND        STATUS         AGE   INFO
⟳ rollout-bluegreen                            Rollout     ✔ Healthy      3h2m
├──# revision:2
│  └──⧉ rollout-bluegreen-776b688d57           ReplicaSet  ✔ Healthy      168m  stable,active
│     ├──□ rollout-bluegreen-776b688d57-kxr66  Pod         ✔ Running      168m  ready:1/1
│     └──□ rollout-bluegreen-776b688d57-vv7t7  Pod         ✔ Running      168m  ready:1/1
└──# revision:1
   └──⧉ rollout-bluegreen-595d4567cc           ReplicaSet  • ScaledDown   3h1m
      ├──□ rollout-bluegreen-595d4567cc-mc769  Pod         ◌ Terminating  3h    ready:1/1
      └──□ rollout-bluegreen-595d4567cc-zdc5x  Pod         ◌ Terminating  3h    ready:1/1
```

If the active `Images` is updated to `hello:1.23.2`, and the blue ReplicaSet is scaled down to 0, that means the rollout is completed.


## Chapter 2. Using ALB or Nginx Ingress with Argo Rollouts for canary deployment

In ACP (Alauda Container Platform), Argo Rollouts can automate canary deployments using ALB or Nginx Ingress for traffic management. This chapter explains how to implement canary deployments with Argo Rollouts and Gateway API.

### Concepts

- **Rollout**: A custom resource definition (CRD) in Kubernetes that replaces standard Deployment resources.
- **Canary Strategy**: A deployment strategy where traffic is gradually shifted from the stable version to the new version.
- **Gateway API**: A Kubernetes API that provides a way to configure L4/L7 traffic routing.
- **HTTPRoute**: A Gateway API resource that defines how HTTP traffic is routed to services.

### Prerequisites

1. Alauda Container Platform installed with a working Kubernetes cluster available.
2. Argo Rollouts with Gateway API plugin installed in the cluster.
3. Argo Rollouts kubectl plugin installed.
4. ALB deployed in the cluster and allocated to the project.
5. A project to create a namespace in it.
6. A namespace in the cluster where the application will be deployed.
7. `kubectl` command-line tool installed with `kubectl-acp` plugin for authentication with ACP Platform.
8. Authenticated to the cluster using `kubectl acp login` command.

### Initial application deployment

Start by defining the "stable" version of your application. This is the current version that users will access. Here is an example of the stable deployment. The container image version is `hello:1.23.1`, and proper labels are `app=web`.

An example deployment YAML file for the stable version is as follows:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: web
        image: hello:1.23.1
        ports:
        - containerPort: 80
```

Save into a yaml file named `web-deployment.yaml` and apply it with:

```shell
kubectl apply -f web-deployment.yaml
```

The deployment needs a `Service` that exposes the stable deployment. This service will forward traffic to the stable pods based on matching labels. Initially, the service selector targets pods labeled with `app=web`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-stable
spec:
  selector:
    app: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

Save into a yaml file named `web-stable-service.yaml` and apply it with:

```shell
kubectl apply -f web-stable-service.yaml
```

Next, create a Gateway to expose the service. Using `example.com` as an example domain to access the service, create a `Gateway` to expose the service with the domain:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: default
spec:
  gatewayClassName: exclusive-gateway
  listeners:
  - allowedRoutes:
      namespaces:
        from: All
    name: gateway-metric
    port: 11782
    protocol: TCP
  - allowedRoutes:
      namespaces:
        from: All
    hostname: example.com
    name: web
    port: 80
    protocol: HTTP
```

The gateway will be allocated an external IP address, get the IP address from the `status.addresses` of type `IPAddress` in the gateway resource.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: default
# ... other fields omitted for brevity
status:
  addresses:
  - type: IPAddress
    value: 192.168.134.30
```

Configure the domain in your DNS server to resolve the domain to the IP address of the gateway. Verify the DNS resolution with the command:

```shell
nslookup example.com
Server:         192.168.16.19
Address:        192.168.16.19#53

Non-authoritative answer:
Name:   example.com
Address: 192.168.134.30
```

It should return the address of the gateway.

Now create an `HTTPRoute` to route the traffic to the service. This will connect the `Gateway` to the `Service` and route the traffic to the pods of stable version:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web
spec:
  hostnames:
  - example.com
  parentRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: default
    namespace: default
    sectionName: web
  rules:
  - backendRefs:
    - group: ""
      kind: Service
      name: web-stable
      namespace: default
      port: 80
      weight: 100
    matches:
    - path:
        type: PathPrefix
        value: /
```

Use the command:

```shell
kubectl apply -f httproute.yaml
```

### Canary deployment procedure

#### Step 1: Creating the Canary Service

Create a Kubernetes `Service` that exposes the canary deployment. This service will forward traffic to the pods of canary version based on matching labels. Initially, the service selector targets pods labeled with `app=web`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-canary
spec:
  selector:
    app: web
  ports:
  - protocol: TCP
    port: 80
    targetPort: 80
```

Apply it using:

```shell
kubectl apply -f web-canary-service.yaml
```

   This allows external access to the canary deployment.

#### Step 2: Updating HTTPRoute

Update the `HTTPRoute` to add the canary version:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web
spec:
  hostnames:
  - example.com
  parentRefs:
  - group: gateway.networking.k8s.io
    kind: Gateway
    name: default
    namespace: default
    sectionName: web
  rules:
  - backendRefs:
    - group: ""
      kind: Service
      name: web-canary
      namespace: default
      port: 80
      weight: 0
    - group: ""
      kind: Service
      name: web-stable
      namespace: default
      port: 80
      weight: 100
    matches:
    - path:
        type: PathPrefix
        value: /
```

Apply it using:

```shell
kubectl apply -f httproute.yaml
```

#### Step 3: Creating the Rollout

Next, create the `Rollout` resource from Argo Rollouts with `Canary` strategy:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: rollout-canary
spec:
  minReadySeconds: 30
  replicas: 2
  revisionHistoryLimit: 3
  selector:
    matchLabels:
      app: web
  strategy:
    canary:
      canaryService: web-canary
      maxSurge: 25%
      maxUnavailable: 0
      stableService: web-stable
      steps:
      - setWeight: 50
      - pause: {}
      - setWeight: 100
      trafficRouting:
        plugins:
          argoproj-labs/gatewayAPI:
            httpRoute: web
            namespace: default
  workloadRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
    scaleDown: onsuccess
```

Apply it with:

```shell
kubectl apply -f rollout.yaml
```

This sets up the rollouts for the deployment with `Canary` strategy. It will set weight to 50 initially, and wait for the promoting. The 50% of the traffic will forward to the canary service. After promoting the rollout, the weight will be set to 100, and 100% of the traffic will forward to the canary service. Finally, the canary service will become the stable service.

#### Step 4: Verifying the Rollouts

After the `Rollout` was created, the Argo Rollouts will create a new ReplicaSet with same template of the deployment. While the pods of new ReplicaSet is healthy, the deployment is scaled down to 0.

Use the following command to ensure the pods are running properly:

```shell
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-canary
Namespace:       default
Status:          ✔ Healthy
Strategy:        Canary
  Step:          9/9
  SetWeight:     100
  ActualWeight:  100
Images:          hello:1.23.1 (stable)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                      KIND        STATUS     AGE  INFO
⟳ rollout-canary                            Rollout     ✔ Healthy  32s
└──# revision:1
   └──⧉ rollout-canary-5c9d79697b           ReplicaSet  ✔ Healthy  32s  stable
      ├──□ rollout-canary-5c9d79697b-fh78d  Pod         ✔ Running  32s  ready:1/1
      └──□ rollout-canary-5c9d79697b-rrbtj  Pod         ✔ Running  32s  ready:1/1
```

#### Step 5: Preparing Canary Deployment

Next, prepare the new version of the application as the green deployment. Update the deployment `web` with the new image version (e.g., `hello:1.23.2`). Use the command:

```shell
kubectl patch deployment web -p '{"spec":{"template":{"spec":{"containers":[{"name":"web","image":"hello:1.23.2"}]}}}}'
```

This sets up the new application version for testing.

The rollouts will create a new Replicaset to manage the canary pods, and the 50% traffic will forward to the canary pods. Use the following command to verify:

```shell
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-canary
Namespace:       default
Status:          ॥ Paused
Message:         CanaryPauseStep
Strategy:        Canary
  Step:          1/3
  SetWeight:     50
  ActualWeight:  50
Images:          hello:1.23.1 (stable)
                 hello:1.23.2 (canary)
Replicas:
  Desired:       2
  Current:       3
  Updated:       1
  Ready:         3
  Available:     3

NAME                                      KIND        STATUS     AGE  INFO
⟳ rollout-canary                            Rollout     ॥ Paused   95s
├──# revision:2
│  └──⧉ rollout-canary-5898765588           ReplicaSet  ✔ Healthy  46s  canary
│     └──□ rollout-canary-5898765588-ls5jk  Pod         ✔ Running  45s  ready:1/1
└──# revision:1
   └──⧉ rollout-canary-5c9d79697b           ReplicaSet  ✔ Healthy  95s  stable
      ├──□ rollout-canary-5c9d79697b-fk269  Pod         ✔ Running  94s  ready:1/1
      └──□ rollout-canary-5c9d79697b-wkmcn  Pod         ✔ Running  94s  ready:1/1
```

 Currently, there are 3 pods running, with stable and canary version. And the weight is 50, 50% of the traffic will forward to the canary service. The rollout process is paused to wait for the promoting.

If you use helm chart to deploy the application, use helm tool to upgrade the application to the canary version.

Accessing `http://example.com`, the 50% traffic will forward to the canary service. You should have different response from the URL.

#### 5.6. Promoting the Rollout

When the canary version is tested ok, you could promote the rollout to switch all traffic to the canary pods. Use the following command:

```shell
kubectl argo rollouts promote rollout-canary
```

To Verify if the rollout is completed:

```shell
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-canary
Namespace:       default
Status:          ✔ Healthy
Strategy:        Canary
  Step:          3/3
  SetWeight:     100
  ActualWeight:  100
Images:          hello:1.23.2 (stable)
Replicas:
  Desired:       2
  Current:       2
  Updated:       2
  Ready:         2
  Available:     2

NAME                                      KIND        STATUS         AGE    INFO
⟳ rollout-canary                            Rollout     ✔ Healthy      8m42s
├──# revision:2
│  └──⧉ rollout-canary-5898765588           ReplicaSet  ✔ Healthy      7m53s  stable
│     ├──□ rollout-canary-5898765588-ls5jk  Pod         ✔ Running      7m52s  ready:1/1
│     └──□ rollout-canary-5898765588-dkfwg  Pod         ✔ Running      68s    ready:1/1
└──# revision:1
   └──⧉ rollout-canary-5c9d79697b           ReplicaSet  • ScaledDown   8m42s
      ├──□ rollout-canary-5c9d79697b-fk269  Pod         ◌ Terminating  8m41s  ready:1/1
      └──□ rollout-canary-5c9d79697b-wkmcn  Pod         ◌ Terminating  8m41s  ready:1/1
```

If the stable `Images` is updated to `hello:1.23.2`, and the ReplicaSet of revision 1 is scaled down to 0, that means the rollout is completed.

Accessing `http://example.com`, the 100% traffic will forward to the canary service.

#### 5.7. Aborting the Rollout (Optional)

If you found the canary version has some problems during rollout process, you can abort the process to switch all traffic to the stable service. Use the command:

```shell
kubectl argo rollouts abort rollout-canary
```

To verify the results:

```yaml
kubectl argo rollouts get rollout rollout-canary
Name:            rollout-demo
Namespace:       default
Status:          ✖ Degraded
Message:         RolloutAborted: Rollout aborted update to revision 3
Strategy:        Canary
  Step:          0/3
  SetWeight:     0
  ActualWeight:  0
Images:          hello:1.23.1 (stable)
Replicas:
  Desired:       2
  Current:       2
  Updated:       0
  Ready:         2
  Available:     2

NAME                                      KIND        STATUS        AGE  INFO
⟳ rollout-canary                            Rollout     ✖ Degraded    18m
├──# revision:3
│  └──⧉ rollout-canary-5c9d79697b           ReplicaSet  • ScaledDown  18m  canary,delay:passed
└──# revision:2
   └──⧉ rollout-canary-5898765588           ReplicaSet  ✔ Healthy     17m  stable
      ├──□ rollout-canary-5898765588-ls5jk  Pod         ✔ Running     17m  ready:1/1
      └──□ rollout-canary-5898765588-dkfwg  Pod         ✔ Running     10m  ready:1/1
```

Accessing `http://example.com`, the 100% traffic will forward to the stable service.

## Conclusion

Alauda Container Platform (ACP) provides multiple strategies for implementing blue/green and canary deployments with Argo Rollouts, each with its own advantages and use cases. This document has explored two distinct methods:

1. **Using ALB or Nginx Ingress with Argo Rollouts for blue/green deployment**:
   - Leverages Argo Rollouts to automate the deployment process
   - Provides zero-downtime deployments with instant traffic switching
   - Suitable for north-south (external) traffic
   - Offers full control over the promotion process
   - Simplifies the transition between application versions

2. **Using ALB or Nginx Ingress with Argo Rollouts for canary deployment**:
   - Enables gradual traffic shifting through Gateway API
   - Provides fine-grained control over traffic percentages
   - Allows for testing new versions with limited user exposure
   - Supports both automatic and manual promotion
   - Reduces risk by incrementally exposing users to new versions

Alauda Container Platform's flexibility allows you to choose the most appropriate deployment strategy based on your specific requirements, ensuring reliable and efficient application updates with minimal risk and downtime. By implementing these progressive delivery strategies, organizations can significantly improve their deployment processes, reduce the risk of failed deployments, and deliver new features to users more confidently.