---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# nfd-master CrashLoopBackOff after upgrade — stale operand image in NFD CR
## Issue

After upgrading the platform's Node Feature Discovery (NFD) operator, the `nfd-master` pod enters `CrashLoopBackOff` (or restarts repeatedly with growing restart count). Other NFD components — `nfd-worker` and `nfd-master` from before the upgrade — were healthy until the operator update.

```text
NAME                          READY   STATUS    RESTARTS   AGE
nfd-master-64567865b9-7vd4d   0/1     Running   1828       6d
```

Pod events on the master show `ProbeError` repeatedly:

```text
Warning  ProbeError  62s (x46708 over 5d11h)  kubelet
  Startup probe error: Get "http://172.21.128.58:8080/healthz":
    dial tcp 172.21.128.58:8080: connect: connection refused
```

The master's own log shows the application binding to a different port than the probe targets:

```text
"metrics server starting" port=":8081"
"gRPC health server serving" port=8082
```

## Root Cause

The NFD CR (`NodeFeatureDiscovery`) carries an explicit `spec.operand.image` field. In older operator releases, this field was required and pinned the operand image (the master / worker binary). The newer operator builds derive the operand image from the operator itself and no longer need an explicit override — `spec.operand.image` is now optional.

When the operator is upgraded but the CR still carries the old `spec.operand.image`, the new operator deploys the **old** master binary while configuring it with the **new** probe contract. The new contract expects the master's HTTP `/healthz` endpoint on port `8080`; the old binary serves metrics on `8081` and a gRPC health endpoint on `8082`. The probe targets `8080`, which the old binary never opens, and the kubelet kills the pod after the startup probe fails.

The fix is to remove the override from the CR and let the operator pick the correct operand image automatically.

## Resolution

Edit the `NodeFeatureDiscovery` CR and drop the `spec.operand.image` line. Because the operator may also have written a stale `status` block from before the upgrade, the cleanest path is to back the CR up, delete it, edit the backup, and re-apply.

1. Find and back up the CR:

   ```bash
   NFD_NS=<nfd-operator-namespace>
   kubectl -n "$NFD_NS" get nodefeaturediscovery
   kubectl -n "$NFD_NS" get nodefeaturediscovery -o yaml > nfd-cr-backup.yaml
   ```

2. Delete the live CR:

   ```bash
   kubectl -n "$NFD_NS" delete nodefeaturediscovery <name>
   ```

3. Edit `nfd-cr-backup.yaml`. Remove:

   - the entire `status:` block (it is operator-owned runtime data),
   - the `spec.operand.image:` line (so the operator chooses the image).

   What remains under `spec.operand` may be empty (`{}`) or carry only non-image overrides such as `imagePullPolicy` or `servicePort`:

   ```yaml
   apiVersion: nfd.k8s-sigs.io/v1
   kind: NodeFeatureDiscovery
   metadata:
     name: nfd-cr
     namespace: <nfd-operator-namespace>
   spec:
     operand: {}
   ```

4. Apply the cleaned CR:

   ```bash
   kubectl apply -f nfd-cr-backup.yaml
   ```

5. Watch the `nfd-master` Deployment roll out. The new pod should pull the operator-bundled image and pass the startup probe within a couple of minutes:

   ```bash
   kubectl -n "$NFD_NS" rollout status deploy/nfd-master
   kubectl -n "$NFD_NS" get pod -l app=nfd-master
   ```

## Diagnostic Steps

1. Confirm the pod's failing probe matches a port the application is not opening — the canonical breadcrumb of this issue:

   ```bash
   kubectl -n "$NFD_NS" get events --field-selector reason=ProbeError | grep nfd-master
   kubectl -n "$NFD_NS" logs deploy/nfd-master --tail=50 | grep -E 'port|server'
   ```

   Probe `:8080`, application logging `port=:8081` and `port=8082` is the fingerprint.

2. Inspect the running pod spec for the image the operator deployed:

   ```bash
   kubectl -n "$NFD_NS" get pod -l app=nfd-master -o jsonpath='{.items[0].spec.containers[0].image}'
   ```

   An image SHA / tag that matches what is pinned in the CR (rather than what the operator's bundle carries) confirms the override is in effect.

3. Inspect the CR for the override; either of the following lines indicates a stale pin:

   ```bash
   kubectl -n "$NFD_NS" get nodefeaturediscovery <name> -o jsonpath='{.spec.operand.image}'
   ```

4. After the fix, confirm the operator and operand are now from the same release:

   ```bash
   kubectl -n "$NFD_NS" get deploy nfd-master -o jsonpath='{.spec.template.spec.containers[0].image}'
   kubectl -n "$NFD_NS" get deploy nfd-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```

   Matching version tags (or matching upstream digests) is the success signal.
