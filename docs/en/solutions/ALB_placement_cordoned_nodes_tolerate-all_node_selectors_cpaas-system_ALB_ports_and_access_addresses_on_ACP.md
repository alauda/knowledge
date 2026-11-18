---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.1"
  - "4.2"
---

# ALB placement: cordoned nodes, tolerate-all, node selectors, cpaas-system ALB ports and access addresses on ACP

## Issue

Questions and failures about where an Alauda Load Balancer (ALB) runs and how it is reached:

- The masters were cordoned with `kubectl cordon`, and the ALB Pods (or other `cpaas-system` Pods) can no longer be scheduled there, so they fail to restart during an upgrade or after a VM restart. Tolerations added to the ALB Deployment disappear right after saving.
- How to move an ALB to other nodes, and how to find the port mappings of an ALB before its VIP is replaced.
- Business ports are wanted on the `cpaas-system` ALB on the masters, or a new ALB should take port 443 on the global masters.
- The access IP of a container-network ALB was changed, or a second one added, and the address does not answer.
- Whether several business ALBs in one cluster conflict when they all use 80, 443 or the same ports, and whether more ALBs can be added.
- Edits to the `alb2` resource of the `cpaas-system` ALB (for example `networkMode`) are reverted, and the monitoring dashboard of the business cluster does not display correctly.

Every ALB Deployment is generated from its `alb2` resource (`crd.alauda.io/v2beta1`), so changes go on the `alb2` object. On a business cluster, the ALB named `cpaas-system` in namespace `cpaas-system` is the platform's own ALB.

## Root Cause

### Cause 1: ALB Pods cannot be scheduled onto cordoned nodes, and Deployment edits are reverted

`kubectl cordon` marks a node `unschedulable: true`, represented as the taint `node.kubernetes.io/unschedulable:NoSchedule`. The ALB Pods do not tolerate it, and tolerations typed into the generated Deployment are reverted by the controller that owns it. The annotation `tolerate-all: "true"` on the `alb2` resource makes the ALB Pods tolerate all taints, including the cordon taint; the change shows on the Pods, not in the Deployment YAML. An annotation named `tolerate` has no effect.

### Cause 2: the ALB has to run on different nodes

The ALB node selector decides which nodes run ALB Pods. Moving the ALB also moves the address that the VIP or external load balancer must forward to; for the `cpaas-system` ALB, the platform VIP forwarding must change too. A single-instance ALB reached through a node's own IP needs its **Access Address** changed; a high-availability ALB behind a VIP keeps the VIP and changes the VIP's backend members. Updating the load balancer does not affect short connections but interrupts long connections in progress.

### Cause 3: the cpaas-system ALB is reserved for platform traffic

The `cpaas-system` ALB is a platform-exclusive resource that forwards only platform traffic and cannot be delegated to business users. A platform upgrade syncs its configuration and overwrites custom changes, so ports added to it are lost and can conflict with platform traffic. On the global cluster, port 443 of the three masters is used for platform access and must not be changed, so a new ALB must not be scheduled onto those nodes.

### Cause 4: a container-network ALB does not take a changed or added access IP

For a container-network ALB, the access address comes from its `LoadBalancer` Service (`<alb-name>-lb-<suffix>` in `cpaas-system`). The existing address cannot be edited, and added addresses do not take effect: `telnet <original-address> <port>` connects while `telnet <added-address> <port>` hangs at `Trying ...`, and the Service `EXTERNAL-IP` lists only the original address. Changing or adding access addresses is supported only for host-network ALBs, which accept several access addresses (domain names or IPs), each a separate entry; a domain entered there must resolve to the load balancer's VIP.

### Cause 5: several business ALBs using the same ports do not conflict

Host-network ALB instances of one cluster cannot be deployed on the same node (the console does not allow it), so each instance serves its ports on different nodes. Container-network ALBs do not occupy node ports. More ALB instances can be added on demand as long as the cluster has the resources.

### Cause 6: the cpaas-system alb2 is rendered by a chart and edits are reconciled back

The `alb2` of the `cpaas-system` ALB is rendered by the chart release `alauda-alb2` (chart `acp/chart-alauda-alb2`), so a direct change such as `networkMode` is reconciled back after saving. The values must be set through the chart's `valuesOverride`. A business cluster whose `cpaas-system` ALB was not in host network mode also had a monitoring dashboard that did not display correctly; it displayed normally after the same `valuesOverride` was applied. The link between the two was not confirmed.

## Resolution

### Cause 1: ALB Pods cannot be scheduled onto cordoned nodes, and Deployment edits are reverted

Add the annotation to the `alb2` resource, then check the Pods.

> **Warning:** With `tolerate-all`, taints and the unschedulable mark no longer keep ALB Pods off any node; only the node selector limits placement. The change rolls the ALB Pods. Only when the node selector already restricts the ALB to the intended nodes and more than one replica is Ready. Roll back with `kubectl -n cpaas-system annotate alb2 <alb-name> tolerate-all-`.

```bash
kubectl -n cpaas-system get alb2
kubectl -n cpaas-system annotate alb2 <alb-name> tolerate-all="true" --overwrite
kubectl -n cpaas-system get pods -l service_name=alb2-<alb-name> -o jsonpath='{range .items[*]}{.metadata.name} {.spec.tolerations}{"\n"}{end}'
```

A toleration with `operator: Exists` and no key confirms it. The same annotation lets the `cpaas-system` ALB return to cordoned masters by itself after a VM restart or an upgrade. Where the annotation is not wanted, `uncordon` the masters during the upgrade, wait for the Pods to start, and `cordon` them again.

### Cause 2: the ALB has to run on different nodes

Change the node selector under `spec.config` of the `alb2` (console: **Platform Management > Network Management > Load Balancers**, open the ALB, **Update**), and update the VIP or external load balancer pool in the same change:

```yaml
spec:
  config:
    nodeSelector:
      ingress: "true"
```

> **Warning:** When the Pods move, the old nodes stop answering on the ALB ports and long connections are interrupted. The new nodes must carry the label and already be members of the VIP or load balancer pool (or clients must be ready for the new **Access Address**). Do it in a maintenance window. Restoring the previous selector is the rollback.

```bash
kubectl label node <new-node> <selector-key>=<selector-value>
kubectl -n cpaas-system get alb2 <alb-name> -o yaml | grep -n -A3 nodeSelector
kubectl get ft -A
```

The ports configured on an ALB are Frontend (`ft`) resources; `kubectl get ft -A` lists the port mappings before a move or a VIP replacement.

### Cause 3: the cpaas-system ALB is reserved for platform traffic

Create a separate ALB for the business component, on the same master nodes and behind the same VIP if needed, with high-numbered ports the platform ALB does not use. Leave the `cpaas-system` ALB unchanged. On the global cluster, do not schedule new ALBs onto the three masters.

### Cause 4: a container-network ALB does not take a changed or added access IP

To keep a given VIP, use an ALB in host network mode: create it with host networking and enter the address (and any additional ones, each as a separate entry) in the access address field (**Network Configuration**, network mode host network, **Add** under the access address list). A container-network ALB cannot be switched in place; plan a new ALB with the same listeners and rules.

### Cause 5: several business ALBs using the same ports do not conflict

No change is needed. Give each host-network ALB its own nodes through its node selector, and point each VIP or DNS name at the nodes of its own ALB. Check capacity before adding another ALB:

```bash
kubectl get alb2 -A
kubectl describe node <candidate-node> | grep -A8 'Allocated resources'
```

### Cause 6: the cpaas-system alb2 is rendered by a chart and edits are reconciled back

On the global cluster, edit the ALB `minfo` of the target business cluster and set the values under `spec.valuesOverride`, keeping the `version` the `minfo` already shows. The same `valuesOverride` can be set on the ALB's `ars` (AppRelease `alauda-alb2`).

```yaml
spec:
  valuesOverride:
    acp/chart-alauda-alb2:
      networkMode: host
      nodeSelector:
        cpaas-system-alb: ""
  version: <current-version>
```

> **Warning:** Changing `networkMode` or `nodeSelector` redeploys the `cpaas-system` ALB, interrupting platform traffic through it while its Pods move; host network mode needs its ports free on the selected nodes. The nodes must carry the `cpaas-system-alb` label. Save the `minfo` YAML; restoring the saved `valuesOverride` is the rollback.

```bash
kubectl get minfo | grep -i alb
kubectl get minfo <alb-minfo-name> -o yaml > /tmp/<alb-minfo-name>.yaml
kubectl edit minfo <alb-minfo-name>
kubectl get node -l cpaas-system-alb
```

## Diagnostic Steps

1. Why ALB Pods are Pending:

   ```bash
   kubectl -n cpaas-system describe pod <pending-alb-pod> | grep -A5 Events
   kubectl get nodes -o custom-columns=NAME:.metadata.name,UNSCHEDULABLE:.spec.unschedulable,TAINTS:.spec.taints
   ```

   `untolerated taint {node.kubernetes.io/unschedulable: }`: Cause 1.

2. Network mode and access address of an ALB; for a container-network ALB, the `EXTERNAL-IP` of its Service is the address that works (Cause 4):

   ```bash
   kubectl -n cpaas-system get pods -l service_name=alb2-<alb-name> -o jsonpath='{range .items[*]}{.metadata.name} hostNetwork={.spec.hostNetwork}{"\n"}{end}'
   kubectl -n cpaas-system get svc | grep <alb-name>-lb
   ```

3. Ports and placement of every ALB (Causes 2 and 5):

   ```bash
   kubectl get ft -A
   kubectl get pods -A -o wide | grep -E 'alb'
   ```

4. A reverted change on the `cpaas-system` ALB (Cause 6):

   ```bash
   kubectl get minfo <alb-minfo-name> -o jsonpath='{.spec.valuesOverride}{"\n"}'
   kubectl -n cpaas-system get alb2 cpaas-system -o yaml | grep -n -E 'networkMode|nodeSelector'
   ```

For external load balancer pool members that must match ALB placement, see "External load balancer in front of ALB: stalls, pool members, client IP, health checks and 503 on ACP".
