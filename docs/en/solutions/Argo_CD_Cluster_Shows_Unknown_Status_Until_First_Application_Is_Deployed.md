---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A managed cluster has been registered with the Argo CD instance running on ACP's `gitops` capability — the cluster Secret was created successfully, the registration was acknowledged, the connection check passed at registration time. In the Argo CD UI, however, the cluster's status reads `Unknown`, and the panel carries the message:

```text
Cluster has no applications and is not being monitored
```

Operators reading this for the first time often suspect a connectivity or RBAC failure. There is no failure: this is the documented behavior of Argo CD's lazy cluster monitoring.

## Overview

Argo CD does not poll a registered cluster on a fixed schedule. Polling is **driven by Applications**: a cluster's API server is contacted when there is at least one Argo CD `Application` whose `spec.destination.server` (or `destination.name`) resolves to that cluster. Without any Application targeting the cluster, Argo CD has no work to do against it, and so it does not run the periodic cluster-info refresh that populates the status fields the UI displays.

The result, on a freshly-registered-but-unused cluster, is:

- Connection state in the Secret: present and valid (the registration handshake succeeded).
- Last-seen status in the application controller's cache: empty (no refresh has been driven).
- UI status: `Unknown` plus the "no applications and is not being monitored" message.

This is intentional. The design is to avoid a quadratic background load: in a multi-cluster Argo CD topology, eagerly polling every registered cluster regardless of whether anything is being deployed to it would cost API-server traffic and controller CPU on every cluster, all the time, for no operational benefit. Connectivity is verified at registration time and re-verified the moment an Application starts targeting the cluster; in between, the controller stays quiet.

## Resolution

This is **expected behavior**, not a defect. The status moves to `Successful` (or `Healthy`, depending on the version) automatically once the first Application targeting the cluster is reconciled.

Three appropriate responses, depending on the operator's actual goal:

### If the cluster is intended to receive deployments

Create an Application that targets the cluster — even a small one is enough to unblock the status. Once the Application's first reconcile runs, Argo CD contacts the cluster, populates the cached cluster info (server version, namespaces, etc.), and the UI flips from `Unknown` to a populated state. From that point on the cluster is monitored for as long as at least one Application points at it.

A trivial Application is sufficient if there is no real workload to deploy yet — for example, an Application pointing at a repository that contains a single empty `Namespace` manifest. Apply it, wait one reconcile interval (default 3 minutes), and verify the cluster card in the UI changes state.

### If the cluster is registered but does not yet have any Applications

Leave it alone. The `Unknown` status is the correct readout for "registered, no current activity". It does not indicate a failure and it does not block future Applications from being added — when the first one arrives, the status will populate.

If the operational expectation is that registered clusters should always be reachable (separate from whether they are actively being deployed to), do *not* solve that with Argo CD's cluster status — solve it with an external connectivity check (a periodic `kubectl get --server=<api> --token=<sa-token>` from a probe job, or a more involved liveness check). Argo CD's own cluster status is, by design, a function of whether an Application is driving it.

### If the cluster should *not* remain registered

If the cluster was added by mistake, or is no longer intended as a deployment target, remove its registration so that the empty cluster card stops appearing in the UI. The exact removal mechanism depends on how the cluster was registered (cluster Secret, declarative `Cluster` resource, or `argocd cluster add` CLI invocation), and the same removal channel should be used to take it back out.

### Verification

After taking one of the actions above:

```bash
# list registered clusters and their last-known state
kubectl -n <argocd-namespace> get secrets \
  -l argocd.argoproj.io/secret-type=cluster \
  -o custom-columns=NAME:.metadata.name,SERVER:.data.server,LAST-SEEN:.metadata.annotations
```

(The Secret holds the registration; the application controller's in-memory cache holds the live status. The UI surfaces a join of the two.)

After deploying the first Application:

```bash
kubectl -n <argocd-namespace> get applications.argoproj.io
```

Within one reconcile cycle the Application's `status.health.status` will populate and, by side effect, the cluster the Application points at will move out of `Unknown`.

## Diagnostic Steps

If the cluster status remains `Unknown` even **after** deploying an Application that targets it — that is, the lazy-polling explanation does not fit — then there is a real problem to investigate. Walk the chain:

1. Confirm the Application's `destination` actually resolves to the cluster in question:

   ```bash
   kubectl -n <argocd-namespace> get application <name> \
     -o jsonpath='{.spec.destination}{"\n"}'
   ```

   Either `server: <api-url>` or `name: <cluster-name>` should match the cluster's registered server URL or name. If `name` is used, also verify the corresponding cluster Secret has matching `name`.

2. Verify the registration Secret is present and well-formed:

   ```bash
   kubectl -n <argocd-namespace> get secret \
     -l argocd.argoproj.io/secret-type=cluster \
     -o name
   kubectl -n <argocd-namespace> get secret <cluster-secret-name> \
     -o jsonpath='{.data.server}' | base64 -d
   ```

   The decoded `server` must be the API URL the application controller will actually reach.

3. Inspect the application controller's logs for the specific cluster URL — connection errors here are the actual failure mode (TLS, RBAC, network) hiding behind the `Unknown` UI state:

   ```bash
   kubectl -n <argocd-namespace> logs deploy/argocd-application-controller \
     | grep -E '<cluster-server-fragment>' | tail -50
   ```

   Common failure signatures: `x509: certificate signed by unknown authority` (CA missing from the cluster Secret), `the server has asked for the client to provide credentials` (token expired or wrong ServiceAccount), connection-refused / timeout (network reachability).

4. From the Argo CD application-controller pod itself, confirm direct reachability:

   ```bash
   kubectl -n <argocd-namespace> exec deploy/argocd-application-controller -- \
     wget -O- --no-check-certificate <cluster-server-url>/version
   ```

   A response containing `gitVersion: vX.Y.Z` confirms the controller can reach the API. A timeout or TLS error here is the real failure to chase down.

If all four steps look healthy and the status is still `Unknown` after the Application's first reconcile interval, restarting the application controller is the conventional last step — it forces a cache re-population:

```bash
kubectl -n <argocd-namespace> rollout restart deploy/argocd-application-controller
```

If the status comes back populated after the restart, the controller's cache had a stale entry; if it does not, return to step 3 and treat it as a connectivity problem rather than a UI problem.
