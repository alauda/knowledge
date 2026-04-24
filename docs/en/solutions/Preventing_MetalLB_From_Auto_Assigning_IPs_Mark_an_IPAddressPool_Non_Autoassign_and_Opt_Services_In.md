---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A cluster running MetalLB to back `Service` objects of type `LoadBalancer` is auto-handing out external IPs from the default `IPAddressPool` to every new LoadBalancer service — including services the administrator did not intend to expose externally. Specific symptoms reported on ACP:

- A freshly created `Service` with `spec.type: LoadBalancer` (for example, a storage-backend S3 endpoint, a metrics exporter, or a diagnostic proxy) immediately acquires a public-facing IP from the configured pool.
- The pool has a finite range (e.g., 254 addresses on a /24); a few accidental services consume the supply and block later, legitimate requests that also need external IPs.
- Routes on the accidentally-exposed services are now reachable from whatever segment the pool serves, widening the blast radius of any misconfiguration on the backing workload.

The administrator wants MetalLB to hand out IPs **only** to services that have been explicitly marked. Everything else — even LoadBalancer-type services — should stay at `Pending` until the annotation is added.

## Root Cause

`IPAddressPool` is the MetalLB CR that carries the list of external IPs the cluster may hand out. Its default behaviour is defined by `.spec.autoAssign`:

- `autoAssign: true` (the default if the field is omitted): MetalLB's controller scans every `Service` of type `LoadBalancer` that does not already have an external IP and picks one from the first pool whose `autoAssign` is true. This is fast and frictionless at small scale but opens the door to accidental exposure.
- `autoAssign: false`: MetalLB ignores the pool unless a service explicitly requests it via the `metallb.universe.tf/address-pool` annotation.

The remediation is to flip the pool's `autoAssign` to `false` and, for every service that should be exposed, add the opt-in annotation. The opt-in model makes external exposure an explicit decision rather than a default.

Secondary consequence: services that were already assigned an IP before the flip keep that IP. They are not re-evaluated. To clear them, the administrator needs to force a re-allocation (by temporarily changing the service type and back, or by patching `.status.loadBalancer` directly).

## Resolution

### Step 1 — identify the cluster's MetalLB pools

```bash
kubectl get ipaddresspool -A -o=custom-columns='NS:.metadata.namespace,NAME:.metadata.name,CIDRS:.spec.addresses,AUTO:.spec.autoAssign'
```

Example output:

```
NS              NAME        CIDRS                  AUTO
metallb-system  default     [192.168.10.0/24]      <none>      # means true
metallb-system  vip-lb      [10.20.30.100-…110]    false
```

The `default` pool with `autoAssign` unset (= true) is the one handing out IPs unasked.

### Step 2 — set `autoAssign: false` on the shared pool

Patch the pool so MetalLB stops volunteering IPs:

```bash
NS=metallb-system
POOL=default
kubectl -n "$NS" patch ipaddresspool "$POOL" --type=merge -p '{"spec":{"autoAssign":false}}'
```

Verify:

```bash
kubectl -n "$NS" get ipaddresspool "$POOL" -o=yaml | yq '.spec.autoAssign'
# Expected output: false
```

New LoadBalancer services created from this point on, without the opt-in annotation, will remain with `externalIP: <pending>` until someone opts them in.

### Step 3 — opt specific services in

For services that **should** expose an external IP, add the annotation at creation time (preferred) or after the fact via `kubectl annotate`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app
  namespace: my-team
  annotations:
    metallb.universe.tf/address-pool: default       # name of the pool
    # Optionally pin a specific IP from the pool:
    # metallb.universe.tf/loadBalancerIPs: 192.168.10.42
spec:
  type: LoadBalancer
  selector: {app: my-app}
  ports:
    - port: 80
      targetPort: 8080
```

Or on an existing service:

```bash
kubectl -n my-team annotate service my-app \
  metallb.universe.tf/address-pool=default --overwrite
```

MetalLB's controller picks up the annotation on its next reconcile (typically within seconds) and allocates an IP.

### Step 4 — reclaim IPs from services that were auto-assigned before the flip

Setting `autoAssign: false` does not retroactively release IPs already allocated. Enumerate the current allocations:

```bash
kubectl get service -A -o=json | \
  jq -r '.items[] | select(.spec.type=="LoadBalancer" and .status.loadBalancer.ingress) |
    "\(.metadata.namespace)/\(.metadata.name)\t\(.status.loadBalancer.ingress[0].ip)"'
```

Decide per service: keep, release, or re-allocate to a different pool.

To release an IP from a service that should no longer be externally exposed, the simplest path is to change the service to `ClusterIP` and back:

```bash
NS=<ns>
SVC=<svc>
kubectl -n "$NS" patch service "$SVC" --type=merge -p '{"spec":{"type":"ClusterIP"}}'
# Wait for MetalLB's controller to notice (usually seconds):
sleep 5
kubectl -n "$NS" patch service "$SVC" --type=merge -p '{"spec":{"type":"LoadBalancer"}}'
# Without the opt-in annotation, the service now stays pending.
```

For services that should remain LoadBalancer and stay on their current IP, do nothing — the IP is preserved as long as the service object is not deleted.

For services that should move to a different pool:

```bash
kubectl -n "$NS" annotate service "$SVC" \
  metallb.universe.tf/address-pool=<target-pool> --overwrite

# Force reallocation: briefly flip to ClusterIP and back:
kubectl -n "$NS" patch service "$SVC" --type=merge -p '{"spec":{"type":"ClusterIP"}}'
sleep 3
kubectl -n "$NS" patch service "$SVC" --type=merge -p '{"spec":{"type":"LoadBalancer"}}'
```

### Step 5 — codify the policy

Silent defaults drift back. Add a governance step so the opt-in model survives future pool additions:

- Use a Kyverno / Gatekeeper policy that rejects `IPAddressPool` objects with `autoAssign: true` (or unset) unless they carry a specific "opt-in-auto" label.
- Use the same policy engine to reject a `Service` of type `LoadBalancer` that has no `metallb.universe.tf/address-pool` annotation, with a clear message pointing the author at the standard pool name.

Example Kyverno snippet:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: loadbalancer-requires-pool-annotation
spec:
  validationFailureAction: enforce
  rules:
    - name: require-metallb-annotation
      match:
        resources:
          kinds: [Service]
      preconditions:
        all:
          - key: "{{ request.object.spec.type }}"
            operator: Equals
            value: LoadBalancer
      validate:
        message: "LoadBalancer Services must set annotation metallb.universe.tf/address-pool"
        pattern:
          metadata:
            annotations:
              metallb.universe.tf/address-pool: "?*"
```

### Step 6 — verify end-to-end

Create a test service without the annotation and confirm it stays pending:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: lb-optin-test
  namespace: default
spec:
  type: LoadBalancer
  ports: [{port: 80}]
  selector: {app: nonexistent}
EOF

kubectl -n default get service lb-optin-test
# Expected:
# NAME           TYPE           EXTERNAL-IP   PORT(S)
# lb-optin-test  LoadBalancer   <pending>     80/TCP
```

Then annotate and confirm it takes an IP:

```bash
kubectl -n default annotate service lb-optin-test \
  metallb.universe.tf/address-pool=default

kubectl -n default get service lb-optin-test -w
# EXTERNAL-IP transitions from <pending> to an IP from the pool within seconds.
```

Clean up:

```bash
kubectl -n default delete service lb-optin-test
```

## Diagnostic Steps

Confirm the pool's current auto-assign behaviour:

```bash
kubectl -n metallb-system get ipaddresspool -o=custom-columns='NAME:.metadata.name,AUTO:.spec.autoAssign,CIDRS:.spec.addresses'
```

Any row with `AUTO: <none>` or `AUTO: true` still hands out IPs silently.

For each LoadBalancer service, read which pool (if any) its IP came from:

```bash
kubectl get service -A -o=json | jq -r '
  .items[] | select(.spec.type=="LoadBalancer") |
  {
    ns:   .metadata.namespace,
    name: .metadata.name,
    ip:   (.status.loadBalancer.ingress[0].ip // "pending"),
    pool: (.metadata.annotations["metallb.universe.tf/address-pool"] // "auto-assigned")
  }' | jq -s .
```

Services with `pool: auto-assigned` are the ones that bypassed your opt-in intent.

Check the MetalLB controller's decision log for the specific service:

```bash
kubectl -n metallb-system logs deploy/metallb-controller | grep <service-name>
```

Lines like `assigning IP … from pool default` confirm auto-assignment happened (relevant when investigating historical allocations that predate the flip).

If the cluster is out of pool addresses altogether, the controller logs `no IP available in pool` — distinct from the opt-in case. The remedy is different (grow the pool, not toggle autoAssign).
