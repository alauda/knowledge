---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A hosted-control-plane (HCP) cluster running its worker nodes as KubeVirt
guest VMs on a management cluster loses access to its web console after
one of the guest worker nodes is restarted. The guest VM comes back
`Ready` and pods running on it work correctly, but external traffic to
the hosted cluster's console (and other ingress-fronted endpoints) does
not route through the restarted node.

## Root Cause

The HCP-on-KubeVirt topology exposes the hosted cluster's ingress traffic
through a passthrough Service on the management cluster — typically named
`default-ingress-passthrough-service-<hash>` — that fronts the guest
worker VMs as backends. Each guest VM is represented by an
`EndpointSlice` entry on the management cluster.

When a guest VM restarts, the EndpointSlice for that VM transiently
flips its `endpoints[].conditions.ready` to `false`. The management
cluster's ingress controller drops the VM from the backend pool while
`ready: false` is in effect — correct behaviour for a load balancer.
After the VM finishes booting, the controller responsible for the
EndpointSlice should mark the entry `ready: true` again so the ingress
re-adds the backend.

In the affected configurations the EndpointSlice stays at `ready:
false` indefinitely after the VM is back up. The ingress on the
management cluster therefore keeps the VM out of the backend pool, and
external traffic that lands on that VM's NodePort path returns no
response. Because the hosted cluster's console is fronted by the same
ingress chain, it goes unreachable from outside even though the
in-cluster path to the console is healthy.

The class of bug is in the HCP+KubeVirt provider's reconciliation of
EndpointSlice readiness after a guest-VM restart: the reconciler does
not re-mark the slice ready when the VM finishes booting.

## Resolution

Manually create a parallel EndpointSlice that pins the affected guest
VM's IP into the same Service. The custom slice is reconciled by
`kube-controller-manager` and not by the buggy reconciler, so the
backend re-appears immediately:

```yaml
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: default-ingress-workaround-<vm-name>
  namespace: <hosted-cluster-ns>
  labels:
    kubernetes.io/service-name: default-ingress-passthrough-service-<hash>
addressType: IPv4
endpoints:
  - addresses:
      - <vm-ip>      # the guest VM's IP on the management cluster
    conditions:
      ready: true
      serving: true
      terminating: false
ports:
  - name: https-443
    port: <nodeport>     # NodePort the hosted cluster exposes on the VM
    protocol: TCP
```

Three substitutions to make:

1. `<vm-ip>` — the IP address of the affected guest worker VM. List with
   `kubectl get vmi -n <hosted-cluster-ns> -o wide`.
2. `<hash>` — the hash suffix of the existing
   `default-ingress-passthrough-service-*` Service in the hosted-cluster
   namespace. Find with `kubectl get svc -n <hosted-cluster-ns>`.
3. `<nodeport>` — the NodePort the hosted cluster exposes for the
   ingress traffic. Read it from the same Service.

Apply with `kubectl apply -f endpointslice-workaround.yaml`. The
ingress controller picks the new slice up on its next reconcile and
re-adds the VM as a backend; the console becomes reachable again.

The workaround is safe to leave in place across further restarts —
each manual slice is keyed on the VM name and the IP is stable across
graceful reboots. If the VM is permanently removed, delete the
matching slice. Once the upstream HCP+KubeVirt bug is fixed in a
future release the manual slices become unnecessary and can be
deleted.

## Diagnostic Steps

1. Confirm the guest VMs themselves are healthy:

   ```bash
   kubectl get vmi -n <hosted-cluster-ns>
   ```

   All entries should be `Running` with a non-empty IP.

2. Inspect the EndpointSlices fronting the passthrough Service:

   ```bash
   kubectl get endpointslice -n <hosted-cluster-ns> \
     -o custom-columns=NAME:.metadata.name,IP:.endpoints[0].addresses[0],READY:.endpoints[0].conditions.ready \
     | grep default-ingress
   ```

   An entry with `READY=false` for a VM that is `Running` confirms the
   stale-readiness bug.

3. Verify the in-cluster path is healthy by curl-ing the hosted
   cluster's console Service from a debug pod inside the hosted
   cluster — a 200 response confirms the issue is purely in the
   external ingress path.

4. Apply the workaround EndpointSlice and re-test the external URL.
   The console should respond within a few seconds of the slice
   becoming visible to the ingress controller.

5. After the upstream fix is rolled out, restart a worker VM and
   confirm the original passthrough EndpointSlice transitions back
   through `ready: false → ready: true` on its own. At that point
   delete the workaround slices.
