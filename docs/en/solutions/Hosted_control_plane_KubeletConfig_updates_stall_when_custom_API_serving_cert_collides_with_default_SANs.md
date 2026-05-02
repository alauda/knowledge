---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A KubeletConfig change is rolled into a hosted-control-plane (HCP)
NodePool but never reaches the worker nodes. The NodePool's status
reports a payload-generation failure:

```text
failed to generate payload:
  error getting ignition payload:
  machine-config-server configmap is out of date,
  waiting for update <hash-a> != <hash-b>
```

The HostedCluster resource itself shows a `ReconciliationSucceeded:
False` condition with a long message about API server SAN conflicts:

```text
configuration is invalid:
  custom serving cert: Invalid value: [...]:
  conflicting DNS names found in KAS SANs.
```

The kubelet on each worker therefore continues running on the previous
configuration and there is no obvious way to push the change through
short of intervention.

## Root Cause

The HostedCluster resource exposes a knob to attach a custom serving
certificate to the hosted cluster's kube-apiserver
(`spec.configuration.apiServer.servingCerts`). The custom cert lists
its own DNS Subject Alternative Names (SANs) — typically the public-
facing API hostname for the hosted cluster, e.g.
`api.hostedcluster.example.com`.

The control-plane operator that reconciles the kube-apiserver also
adds a fixed set of internal SANs that the in-cluster components rely
on to authenticate to the API: `localhost`, `kubernetes`,
`kubernetes.default`, the cluster service DNS names, the in-namespace
service-CA names, the per-cluster `api.<name>.hypershift.local`
internal name, and so on.

If the custom serving cert's SAN list overlaps with one of those
defaults — say the operator-side default also includes the same
external hostname through a different cert path — the operator's SAN
validation rejects the configuration as inconsistent. The reconcile
of the kube-apiserver pod stalls on `Invalid configuration`.

The downstream effect cascades: the ignition server (which builds the
boot payload for new and updated NodePool nodes) needs the kube-
apiserver to be reconciled before it can refresh the
`machine-config-server` ConfigMap. With the kube-apiserver stuck,
ignition cannot build a fresh payload, and the NodePool's reconcile
loop reports `machine-config-server configmap is out of date` until
the SAN conflict is resolved.

## Resolution

Remove the custom serving certificate configuration so the operator
falls back to its default SAN set:

```bash
kubectl patch hostedcluster <name> -n <hosted-cluster-ns> \
  --type=json \
  -p='[{"op":"remove","path":"/spec/configuration/apiServer/servingCerts"}]'
```

After the patch:

1. The operator clears the `Invalid configuration` condition on the
   HostedCluster.
2. The kube-apiserver pods in the hosted-control-plane namespace
   restart automatically with the operator-managed serving cert.
3. The ignition server refreshes `machine-config-server` and produces
   a payload that includes the pending KubeletConfig change.
4. The NodePool drains the affected nodes and reapplies the new
   payload. Each node restarts with the updated kubelet configuration.

If the custom hostname genuinely needs to be served by the kube-
apiserver (for example because external clients call the API by a
public hostname different from the operator default), re-introduce
the custom cert with a SAN list that does **not** overlap any of the
operator's reserved entries. The operator publishes the reserved set
in the HostedCluster's invalid-configuration message — copy that list
out, build the custom cert with only the additional public hostnames
that are not already in it, and re-apply.

A safer pattern long-term is to keep the kube-apiserver on the
operator-managed cert and front the public hostname with a separate
ingress / load-balancer layer that terminates TLS with the custom cert
and forwards to the apiserver as an internal client. That decouples
the apiserver's SAN list from the public-facing certificate set
entirely.

## Diagnostic Steps

1. Confirm the symptom in the NodePool:

   ```bash
   kubectl get nodepool <name> -n <hosted-cluster-ns> -o yaml \
     | yq '.status'
   ```

   The `failed to generate payload: ... machine-config-server configmap is
   out of date` message is the giveaway.

2. Inspect the HostedCluster's conditions:

   ```bash
   kubectl get hostedcluster <name> -n <hosted-cluster-ns> -o yaml \
     | yq '.status.conditions'
   ```

   Look for `ReconciliationSucceeded: False` with a message about SAN
   conflicts.

3. Inspect the ignition-server pod log for the "machine-config-server
   configmap is out of date" line:

   ```bash
   kubectl logs -l app=ignition-server -n <hosted-control-plane-ns> \
     --tail=200
   ```

4. Apply the patch to remove the custom serving cert and watch the
   apiserver pods restart:

   ```bash
   kubectl get pods -n <hosted-control-plane-ns> -l app=kube-apiserver -w
   ```

5. Confirm the NodePool resumes its update and nodes drain / reboot
   with the new payload:

   ```bash
   kubectl get nodes -L node.kubernetes.io/instance-type
   kubectl get nodepool <name> -n <hosted-cluster-ns> -w
   ```
