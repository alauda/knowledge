---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Prevent MetalLB from auto-assigning IPs by marking an IPAddressPool non-autoassign

## Issue

MetalLB ships on Alauda Container Platform as the `metallb` ModulePlugin (default channel v4.4.1; release-4.3 branch tag v4.3.9 of chart `acp/chart-alauda-metallb-plugin`) and as the `metallb-operator` OperatorBundle (CSV `metallb-operator.v0.15.1-alauda.20260506053547` (rebuild stamp), upstream MetalLB v0.15.1). Both install paths embed the upstream controller image `build-harbor.alauda.cn/3rdparty/metallb/controller:v4.3.6-v0.15.1`, so the IP allocator follows upstream MetalLB. By default, MetalLB allocates an external IP from any configured pool to every Service of type LoadBalancer that does not carry an explicit address-pool annotation.

In environments where a pool must exist for use by selected workloads only — for example, a reserved range for a specific application or tenant — the default behavior is undesirable: any new LoadBalancer Service in the cluster can claim an address from the reserved range. The goal is to keep the pool defined but stop MetalLB from drawing from it unless a Service explicitly requests it.

## Resolution

Set `spec.autoAssign: false` on the IPAddressPool that should not be used for unannotated Services. The IPAddressPool CRD on the cluster is `metallb.io/v1beta1`; the resource lives in `metallb-system`, with `spec.addresses` carrying a list of CIDR prefixes or explicit start-end IP ranges and `spec.autoAssign` as a boolean (default `true`, described on the CRD as "flag used to prevent MetalLB from automatic allocation for a pool").

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: reserved-pool
  namespace: metallb-system
spec:
  addresses:
    - 10.0.0.200-10.0.0.220
  autoAssign: false
```

Workloads that should still receive an IP from the reserved pool request it explicitly by annotating their Service with `metallb.universe.tf/address-pool=<poolName>`. The annotation directs the MetalLB controller to allocate the Service's external IP from the named pool, including pools that have `autoAssign: false`.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: app-with-reserved-ip
  namespace: app-ns
  annotations:
    metallb.universe.tf/address-pool: reserved-pool
spec:
  type: LoadBalancer
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

IPs already allocated by MetalLB before the pool was flipped to `autoAssign: false` remain bound to their existing Services — flipping the flag does not retroactively release in-use allocations. To release a previously-allocated external IP, patch the Service's `spec.type` from `LoadBalancer` to `ClusterIP`; MetalLB then frees the IP, and the Service can be patched back to `LoadBalancer` once the pool is configured the way it should be.

```bash
kubectl -n <namespace> patch svc <service> -p '{"spec":{"type":"ClusterIP"}}'
```

## Diagnostic Steps

Confirm the pool is in place and is no longer auto-assigning. A LoadBalancer Service that does not carry the `metallb.universe.tf/address-pool` annotation is expected to remain with `EXTERNAL-IP` reported as `<pending>` if no other auto-assignable pool is available, signalling that the controller declined to draw from the non-autoassign pool.

```bash
kubectl -n metallb-system get ipaddresspool
kubectl -n metallb-system get ipaddresspool reserved-pool -o jsonpath='{.spec.autoAssign}{"\n"}'
kubectl get svc -A -o wide
```
