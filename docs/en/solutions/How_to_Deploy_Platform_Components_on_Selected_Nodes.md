---
products:
   - Alauda Container Platform
kind:
   - Solution
---

# How to Deploy Platform Components on Selected Nodes

## Issue

Some customers require platform components to run on dedicated nodes to isolate them from application workloads, enabling differentiated resource allocation and operational assurance for different types of workloads.

## Environment

Supported Platform Version: v4.0.x

## Resolution

### 1. Add the following labels to the specified nodes

```yaml
cpaas-system-alb: ""
node-role.kubernetes.io/cpaas-system: "true"
```

Execute the following command on the workload cluster:
```shell
kubectl label nodes NODE_NAME cpaas-system-alb="" node-role.kubernetes.io/cpaas-system=true
```

### 2. Modify cluster-module-config

Change the content of platformNodeSelector under globalConfig and platformConfig to '{"node-role.kubernetes.io/cpaas-system": "true"}'

Execute the following command on the global cluster:
```shell
kubectl edit configmaps -n cpaas-system cluster-module-config
```

Reference the following content for modification:
```yaml
---
apiVersion: v1
data:
  config.yaml: |
    globalConfig: |
      global:
        ......

# CHANGE the following content
        <<- if (and .IsGlobal .PlatformNodeSelector) >>
        nodeSelector:
          <<- range $key, $val := .PlatformNodeSelector >>
            << $key >>: << $val | quote >>
          <<- end >>
        <<- else >>
        nodeSelector: {}
        <<- end >>
# TO:
        nodeSelector:
          "node-role.kubernetes.io/cpaas-system": "true"
# END
        ......

    platformConfig: |
      global:
        ......
# CHANGE the following content
        <<- if (and .IsGlobal .PlatformNodeSelector) >>
        nodeSelector:
          <<- range $key, $val := .PlatformNodeSelector >>
            << $key >>: << $val | quote >>
          <<- end >>
        <<- end >>
# TO:
        nodeSelector:
          "node-role.kubernetes.io/cpaas-system": "true"
# END
    ......
```

### 3. Wait for all components on workload clusters to update completely

Check the status on the workload cluster using the following command:

```shell
kubectl get appreleases -n cpaas-system -w
```

### 4. Reschedule alb

Usually, the alb label will be added to control plane nodes. Remove the label from control plane nodes on the workload cluster using the following command:

```shell
kubectl label nodes NODE_NAME cpaas-system-alb-
```

Restart all alb Pods on the workload cluster using the following command:

```shell
kubectl delete pods -n cpaas-system -l service_name=alb2-cpaas-system
```

Note: Users may need to modify the external load balancer connected to alb to forward port 11780 to the new nodes.

### 5. Verification

Execute the following command on the workload cluster to verify that Pods have been rescheduled to the specified nodes:

```shell
kubectl get pods -n cpaas-system -o wide
kubectl get pods -n cert-manager -o wide
```
