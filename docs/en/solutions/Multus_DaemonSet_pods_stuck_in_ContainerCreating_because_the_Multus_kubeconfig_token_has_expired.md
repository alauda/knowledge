---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Pods on the cluster fail to come up with `FailedCreatePodSandBox` events that point at the Multus CNI plugin returning `Unauthorized`:

```text
plugin type="multus" name="multus-cni-network" failed (add):
  Multus: [<ns>/<pod>/<id>]: error getting pod: Unauthorized
```

The Multus DaemonSet pods are themselves stuck `ContainerCreating` for the same reason. Other pods on the affected nodes can't initialise networking because Multus never finishes its setup, and the cascade leaves several namespaces in a broken state until the Multus pods come back.

## Root Cause

Multus runs as a DaemonSet and ships its CNI binary to the host. When the kubelet invokes the CNI binary it reads `/etc/cni/net.d/multus.d/multus.kubeconfig` and uses the bearer token in that file to call the Kubernetes API for pod metadata, network attachment definitions, and so on. The kubeconfig is generated once when the Multus pod first lands on the node and is bound to a ServiceAccount-issued token.

If the token is short-lived (BoundServiceAccount tokens default to one hour or one year depending on the issuer) and the rotation flow on the node breaks — for example the rotator was removed, the node was paused for longer than the token lifetime, or the cluster's TokenRequest API expired the token before the renewal cycle ran — the cached `multus.kubeconfig` ends up with an expired token. From then on every CNI invocation hits an `Unauthorized` from the API and the network never comes up.

This is unusual on a steady-state cluster because the renewer normally refreshes the token well before it expires. The path to the failure mode is almost always external: a long node downtime, a custom kubeconfig that was issued with a non-renewable token, or a node that came back online after the previous token's expiry window closed.

## Resolution

Issue a fresh, long-lived token bound to the Multus ServiceAccount and write it onto every node's Multus kubeconfig. The token request below uses a one-year duration; pick a value that matches the cluster's secret rotation policy.

Mint the token (the namespace and ServiceAccount names match what the Multus DaemonSet uses):

```bash
kubectl -n kube-system create token multus --duration=8760h
```

Capture the output and replace the `token:` field in the Multus kubeconfig on every affected node. From a debug pod on each node:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  sh -c "cp /host/etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig{,.bak} && \
         sed -i 's|token: .*|token: <new-token>|' \
            /host/etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig"
```

Once the kubeconfig is updated, the next CNI invocation succeeds and pods that were stuck on the node start initialising. The Multus pod itself will re-read the file on next restart; if it stays `ContainerCreating`, delete it so the DaemonSet recreates it:

```bash
kubectl -n kube-system delete pod -l app=multus \
  --field-selector spec.nodeName=<node>
```

For a permanent fix, audit how the Multus kubeconfig is regenerated on the node:

- The Multus DaemonSet usually mounts a ServiceAccount projection that the in-pod entrypoint converts into the on-host kubeconfig at startup. If that path is short-circuited by a custom DaemonSet manifest, restore the upstream initContainer.
- If the cluster runs nodes that may sit offline for longer than the token lifetime, increase the token's `expirationSeconds` (or use a non-expiring service account secret of type `kubernetes.io/service-account-token`) so the dormant nodes have a valid token when they come back.

## Diagnostic Steps

Confirm the failure mode by reading the cached token and decoding its expiry. From a debug pod on the affected node:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  sh -c "cat /host/etc/kubernetes/cni/net.d/multus.d/multus.kubeconfig | grep token"
```

Decode the JWT payload to see when the token expires (the `exp` field is a Unix timestamp):

```bash
echo "<token>" | cut -d '.' -f2 | base64 -d 2>/dev/null | jq -r '.exp'
date -d @<exp-value>
```

If the date is in the past, the token is expired and the failure cause is confirmed.

Verify the freshly-issued token is accepted by the API server:

```bash
TOKEN=<new-token>
kubectl --token="$TOKEN" --server=https://kubernetes.default get pods -A --limit=1
```

A clean response (no `Unauthorized`) means the token works; the next step is propagating it to the nodes.

After the node-level kubeconfig has been updated, watch new pods schedule and look for the Multus error to disappear from kubelet events:

```bash
kubectl get events -A --field-selector reason=FailedCreatePodSandBox \
  --watch | grep -i multus
```

Silence on this stream after the kubeconfig update is the signal that all nodes are back in service.
