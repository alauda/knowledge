---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Hosted Control Plane on KubeVirt Rejects Dual-Stack with "KubeVirt is not one of the supported platforms"
## Issue

Provisioning a Hosted Control Plane (HCP) whose worker nodes run as KubeVirt VMs on the hosting cluster, with dual-stack (IPv4 + IPv6) cluster networking, fails at the cluster-network-operator stage. The hosted cluster's Cluster Network Operator refuses the dual-stack config and reports:

```text
Dual-Stack is not supported
```

or, more specifically from the CNO logs:

```text
KubeVirt is not one of the supported platforms for dual stack
(BareMetal, None, OpenStack, VSphere)
```

The hosted `HostedControlPlane` and `NodePool` resources reach `Available=False`, the worker VMs may or may not come up (depending on how early the failure happens), and the hosted cluster never finishes bootstrapping.

## Root Cause

The hosted cluster's Cluster Network Operator (CNO) validates the requested cluster network shape against a hardcoded allowlist of `platformType` values that are explicitly marked as dual-stack-ready. On the release trains currently deployed, that allowlist contains `BareMetal`, `None`, `OpenStack`, and `VSphere`. The `KubeVirt` platform type — which is what HCP uses when worker nodes live as VMs on the hosting cluster — is missing from the allowlist even though the underlying network plumbing (Kube-OVN / OVN-Kubernetes + KubeVirt VM NICs) is capable of routing dual-stack traffic.

This is a pure admission-time gate, not a real capability gap. The CNO sees `platformType: KubeVirt` in the `HostedCluster` / `infrastructure` object, fails the allowlist check, and refuses to materialize dual-stack network config for the hosted cluster. There is no user-visible YAML that works around the gate — the allowlist is in CNO code, not in a CRD field.

A downstream fix adds `KubeVirt` to the dual-stack allowlist, with the fix scheduled across multiple minor lines of the platform release trains. Once the hosting cluster is running a release that ships the patched CNO, deploying an HCP-on-KubeVirt cluster with dual-stack networking succeeds end-to-end.

## Resolution

### Preferred: use a platform release that includes the fix

Upgrade the hosting cluster (the cluster that runs the platform Hosted Control Plane operator and hosts the KubeVirt worker VMs) to a platform release that includes the `KubeVirt` entry in the CNO dual-stack allowlist. After the upgrade, provision the `HostedCluster` as usual with dual-stack `clusterNetwork` and `serviceNetwork` entries; the hosted cluster's CNO accepts the configuration.

Consult the platform release-notes for the minor line in use to identify the first point release that carries the fix. The fix is backported across multiple active minor lines, so staying on the current minor is usually sufficient — a full minor upgrade is not required.

### Workaround while on a pre-fix release

No configuration workaround exists to bypass the admission gate; the `platformType: KubeVirt` value is fixed by the architecture of the deployment. The options are:

- Deploy the HCP cluster with a **single-stack** `clusterNetwork` (either IPv4-only or IPv6-only) and defer dual-stack until the patched CNO is available. Single-stack deployments are unaffected.
- Host the worker nodes on an allowlisted platform (BareMetal / OpenStack / VSphere) if workloads truly need dual-stack now; the trade-off is giving up KubeVirt-backed workers.
- Schedule the hosting-cluster upgrade before deploying the hosted cluster, so the first provisioning attempt is already on the patched CNO.

### Service Network considerations

When the hosted cluster is finally provisioned with dual-stack, the `HostedCluster.spec.networking.serviceNetwork` and `clusterNetwork` arrays should carry both address families in the expected order (IPv4 first, IPv6 second, matching the default cluster IPv4-primary posture). Example shape:

```yaml
apiVersion: hosted-control-plane.alauda.io/v1beta1
kind: HostedCluster
metadata:
  name: <hosted-cluster-name>
spec:
  platform:
    type: KubeVirt
  networking:
    clusterNetwork:
      - cidr: 10.132.0.0/14
        hostPrefix: 23
      - cidr: fd01::/48
        hostPrefix: 64
    serviceNetwork:
      - cidr: 172.31.0.0/16
      - cidr: fd02::/112
```

Do not edit `HostedCluster.spec.networking` in place after the hosted cluster is provisioned — the CNO does not reconcile address-family changes post-install. Delete and re-create the hosted cluster if the initial provisioning was single-stack.

### OSS fallback

On a plain upstream stack (HyperShift operator + KubeVirt on a vanilla Kubernetes host cluster), the same gate exists in the CNO code that ships with the HyperShift release. Pulling a HyperShift build that includes the `KubeVirt` allowlist entry (the upstream bug fix corresponding to the downstream patch) resolves it. Until that build is in use, the same workarounds (single-stack, or different worker platform) apply.

## Diagnostic Steps

Confirm the rejection source before attributing the failure to anything else in the hosted cluster's bootstrap.

1. Check `HostedCluster` and `HostedControlPlane` status for the CNO-level message:

   ```bash
   kubectl get hostedcluster <name> -n <hcp-ns> \
     -o jsonpath='{.status.conditions}' | jq .
   kubectl get hostedcontrolplane -n <hcp-ns> \
     -o jsonpath='{.items[0].status.conditions}' | jq .
   ```

   Look for conditions like `ValidConfiguration=False` with a message mentioning `dual stack` and `supported platforms`.

2. Read the hosted cluster's CNO logs (the CNO runs in the hosted cluster's control-plane namespace on the management cluster):

   ```bash
   kubectl -n <hcp-ns> logs deploy/cluster-network-operator --tail=300 \
     | grep -Ei 'dual[- ]stack|KubeVirt|supported platforms'
   ```

   The literal message `KubeVirt is not one of the supported platforms for dual stack (BareMetal, None, OpenStack, VSphere)` confirms the admission-list root cause.

3. Confirm the declared `platformType` is indeed `KubeVirt`:

   ```bash
   kubectl get hostedcluster <name> -n <hcp-ns> \
     -o jsonpath='{.spec.platform.type}{"\n"}'
   ```

4. Re-provision as single-stack to verify the gate is the only blocker. Create a minimal `HostedCluster` whose `clusterNetwork` and `serviceNetwork` each contain only a single IPv4 entry. If that cluster reaches `Available=True`, dual-stack is the only failing dimension — wait for the patched CNO release before re-attempting dual-stack, rather than rotating other config values.

5. Once the hosting cluster is on a patched release, verify the CNO build includes the allowlist change by tailing the CNO logs during HCP provisioning — the "KubeVirt is not supported" message will be absent, and the CNO will reconcile dual-stack resources without rejection.
