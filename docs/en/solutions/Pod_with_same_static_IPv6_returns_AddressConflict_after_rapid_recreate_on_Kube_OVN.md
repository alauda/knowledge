---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Pod with same static IPv6 returns AddressConflict after rapid recreate on Kube-OVN

## Issue

On Alauda Container Platform with the default Kube-OVN cluster CNI (`registry.alauda.cn:60080/acp/kube-ovn:v1.15.11`, daemonset `kube-system/kube-ovn-cni` plus `Deployment kube-system/kube-ovn-controller`), a workload whose pod template pins a static IPv6 address via the Kube-OVN annotations `ovn.kubernetes.io/logical_switch=<subnet>` and `ovn.kubernetes.io/ip_address="<v4>,<v6>"` cannot be safely rescheduled by a `Deployment` when its existing pod is deleted. The new pod, owned by the same `ReplicaSet`, is scheduled immediately on the same node and asks Kube-OVN's IPAM for the same static address while the previous pod's allocation has not yet been released. Kube-OVN rejects the request and the new pod stays in `ContainerCreating` until the old allocation drains.

Two warning events are observed on the new pod in this window — first `FailedCreatePodSandBox` from the kubelet's CRI plugin call, then `AcquireAddressFailed` from the Kube-OVN controller:

```text
Warning   FailedCreatePodSandBox   pod/dad-pinned-v6-<rs>-<hash>   Failed to create pod sandbox: rpc error: code = Unknown
  desc = failed to setup network for sandbox "...": plugin type="kube-ovn" failed (add): RPC failed; request ip return 500
  no address allocated to pod <ns>/dad-pinned-v6-<rs>-<hash> provider ovn, please see kube-ovn-controller logs to find errors
Warning   AcquireAddressFailed     pod/dad-pinned-v6-<rs>-<hash>   AddressConflict
```

This is the Kube-OVN surface of the same underlying race: a pod that is owned by a `Deployment` (or any controller backed by a `ReplicaSet`) is replaced before its previous IPAM record has been released, and the new replica that requests the same pinned static address loses. The collision is caught at IPAM allocation time by Kube-OVN, before the kernel inside the pod netns ever sees the address.

## Root Cause

A `Deployment` does not provide an "at most one" guarantee for a given pod template. The `apps/v1` Deployment schema served by kube-apiserver on this platform exposes `spec.strategy.type` as the enum `Recreate | RollingUpdate`, default `RollingUpdate`, and its `Recreate` value carries the description "Kill all existing pods before creating new ones" — that promise applies only when a new Deployment revision triggers a controller-driven rollout. When a single pod is removed outside of a rollout (manual `kubectl delete pod`, eviction, node-level termination), the lifecycle is owned by the `ReplicaSet` controller, which schedules a replacement immediately rather than waiting for the deleted pod's termination to complete.

A `StatefulSet`, by contrast, gives an "at most one per ordinal" guarantee. The `apps/v1` StatefulSet schema on this platform exposes `spec.podManagementPolicy` as the enum `OrderedReady | Parallel`, default `OrderedReady`, with the description: "pods are created in increasing order (pod-0, then pod-1, etc) and the controller will wait until each pod is ready before continuing. When scaling down, the pods are removed in the opposite order". `spec.updateStrategy.type` is the enum `OnDelete | RollingUpdate`, default `RollingUpdate`. Together this makes ordinal `N` exist at most once at any moment: the controller waits for the terminating pod of ordinal `N` to be removed before creating its replacement, and that gap is what gives Kube-OVN's IPAM time to release the previous allocation before the new pod requests the same static address.

On the IPAM side, Kube-OVN exposes IPv6 as a first-class subnet protocol — the `subnets.kubeovn.io` CRD declares `spec.protocol` as the enum `IPv4 | IPv6 | Dual` and notes it is "Immutable after creation", and `ips.kubeovn.io` carries a dedicated `spec.v6IpAddress` field separate from `spec.v4IpAddress`. A user pins a per-pod static IPv4 + IPv6 by binding the pod template to a `Dual`-stack (or `IPv6`) subnet via `ovn.kubernetes.io/logical_switch` and `ovn.kubernetes.io/ip_address="<v4>,<v6>"`. Once the new pod is admitted, `ip -6 addr show eth0` inside the pod netns shows the requested address with `scope global` and neither the kernel `tentative` nor the `dadfailed` flag — Kube-OVN gates the collision at IPAM allocation time, so the kernel-side Duplicate Address Detection state never has to recover.

## Resolution

Replace the workload's `Deployment` with a `StatefulSet` whenever the workload requires a pinned static IPv6 (or IPv4) per pod. The StatefulSet's default `podManagementPolicy=OrderedReady` and default `updateStrategy.type=RollingUpdate` keep the per-ordinal "at most one" guarantee that lets Kube-OVN's IPAM release the previous allocation before the new pod requests the same address.

A minimal StatefulSet that pins a static IPv4 + IPv6 on Kube-OVN — verified on Alauda Container Platform `v4.3.22`, Kubernetes `v1.34.5-1`, Kube-OVN `v1.15.11` — looks like the following. Pin the workload to one node with `nodeSelector` so the rapid-restart path stays observable; the `ovn.kubernetes.io/logical_switch` annotation must name the `Subnet` CR that defines the IPv6 (or Dual) CIDR, and the `ovn.kubernetes.io/ip_address` annotation lists the static IPv4 and IPv6 separated by a comma:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: dad-pinned-sts
  namespace: dad-test
spec:
  serviceName: dad-pinned-sts
  replicas: 1
  selector:
    matchLabels:
      app: dad-pinned-sts
  template:
    metadata:
      labels:
        app: dad-pinned-sts
      annotations:
        ovn.kubernetes.io/logical_switch: dad-test-v6
        ovn.kubernetes.io/ip_address: "10.99.0.30,fd00:dad:7132::30"
    spec:
      nodeSelector:
        kubernetes.io/hostname: "<worker-node>"
      terminationGracePeriodSeconds: 5
      containers:
        - name: net
          image: registry.alauda.cn:60080/3rdparty/kubectl:v4.3.3
          command: ["sh","-c","sleep 36000"]
```

The backing `Subnet` is a Kube-OVN Dual-stack subnet that contains the pinned addresses and is scoped to the workload's namespace:

```yaml
apiVersion: kubeovn.io/v1
kind: Subnet
metadata:
  name: dad-test-v6
spec:
  protocol: Dual
  cidrBlock: "10.99.0.0/24,fd00:dad:7132::/64"
  excludeIps:
    - "10.99.0.1"
    - "fd00:dad:7132::1"
  gateway: "10.99.0.1,fd00:dad:7132::1"
  gatewayType: distributed
  natOutgoing: false
  namespaces:
    - dad-test
```

After applying both manifests, force-delete the StatefulSet's pod and the replacement keeps the same ordinal name and is allocated the same static IPv4 + IPv6 without an `AddressConflict` event; once the new pod is `Running`, `kubectl exec dad-pinned-sts-0 -- ip -6 addr show eth0` reports the requested address with `scope global` and no `tentative` or `dadfailed` flag.

## Diagnostic Steps

Confirm the workload owner type and what address it is asking for. The pod's controller is visible in `metadata.ownerReferences`; if the chain leads to a `Deployment` via a `ReplicaSet`, the manual-delete path schedules an immediate replacement on the same node (verified on this platform — the replacement was scheduled at `t+0s` and reached `Running` after roughly eight seconds with the same pinned `10.99.0.20,fd00:dad:7132::20`). The pinned address itself is on the pod template under `metadata.annotations` — read `ovn.kubernetes.io/ip_address` and `ovn.kubernetes.io/logical_switch` from the pod spec to see which subnet is being targeted.

Read the events on the pending pod to confirm the failure is Kube-OVN IPAM and not something else. The collision surfaces as the pair of warnings shown in the `## Issue` section: a `FailedCreatePodSandBox` from the CRI side and an `AcquireAddressFailed AddressConflict` from the Kube-OVN controller. The `request ip return 500 no address allocated to pod ... provider ovn` substring is the marker that the new pod is racing the previous allocation — distinct from "no addresses left" (which is a subnet-exhaustion error, not a collision).

Confirm the IPv6 path is structurally available. The active Kube-OVN `Subnet` should report `spec.protocol=IPv6` or `spec.protocol=Dual`; the field is declared by the CRD as immutable after creation, so the workload's subnet must be defined that way from the start. The pod's allocated IPv6 (when allocation succeeds) is also visible on the corresponding `ips.kubeovn.io` object's `spec.v6IpAddress` field.

Once the workload has been moved to a `StatefulSet`, validate the at-most-one-per-ordinal lifecycle by force-deleting the running pod and watching the same ordinal name come back. The replacement keeps the same name and the same pinned static IPv4 + IPv6, and the recreate cycle finishes without any `AcquireAddressFailed` event — verified on this platform with the StatefulSet `dad-pinned-sts` pinning `10.99.0.30,fd00:dad:7132::30`, where the new pod reached `Running` after roughly nine seconds and `ip -6 addr show eth0` inside it reported `inet6 fd00:dad:7132::30/64 scope global` with no `tentative` or `dadfailed` flag.
