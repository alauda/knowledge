---
products:
   - Alauda Container Platform
kind:
   - Solution
---

# How to Deploy Platform Components on Selected Nodes

## Issue

Platform components are required to run on dedicated nodes to isolate them from application workloads, enabling differentiated resource allocation and operational assurance for different types of workloads.

## Environment

v4.0.x

## Resolution

### 1. Add the following labels to the selected nodes

```yaml
cpaas-system-alb: ""
node-role.kubernetes.io/cpaas-system: "true"
```

Execute the following command on the workload cluster:
```shell
kubectl label nodes NODE_NAME cpaas-system-alb="" node-role.kubernetes.io/cpaas-system=true
```

### 2. Modify ConfigMap cluster-module-config

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

If an external load balancer is used to proxy port 11780, the backend server configuration of the external load balancer must also be updated to include the new nodes.

### 5. Verification

Execute the following command on the workload cluster to verify that Pods have been rescheduled to the specified nodes:

```shell
kubectl get pods -n cpaas-system -o wide
kubectl get pods -n cert-manager -o wide
```

Output example is shown below. Please ensure the values in the NODE column are as expected.

```shell
NAME                                       READY   STATUS    RESTARTS   AGE    IP           NODE             NOMINATED NODE   READINESS GATES
cert-manager-697748f676-lslwc              1/1     Running   0          6d2h   10.3.241.4   192.168.137.44   <none>           <none>
cert-manager-cainjector-86c5cddcf4-vct7k   1/1     Running   0          6d2h   10.3.241.3   192.168.137.44   <none>           <none>
cert-manager-webhook-b84f578c4-vzsdd       1/1     Running   0          6d2h   10.3.241.2   192.168.137.44   <none>           <none>
```