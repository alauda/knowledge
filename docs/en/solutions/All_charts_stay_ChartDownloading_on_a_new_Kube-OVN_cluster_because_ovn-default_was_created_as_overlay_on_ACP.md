---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.2.x
  - 4.3.x
---

# All charts stay ChartDownloading on a new Kube-OVN cluster because ovn-default was created as overlay on ACP

Related articles: [Node, API and VIP access lost after creating a Kube-OVN ProviderNetwork or underlay subnet on ACP](Node_API_and_VIP_access_lost_after_creating_a_Kube-OVN_ProviderNetwork_or_underlay_subnet_on_ACP.md); [Kube-OVN underlay Pods fail with resolve MAC address timeout or bridge network InitOVSBridgeFailed on ACP](Kube-OVN_underlay_Pods_fail_with_resolve_MAC_address_timeout_or_bridge_network_InitOVSBridgeFailed_on_ACP.md).

## Issue

On a newly added cluster that was planned with a Kube-OVN underlay network, CoreDNS and the other platform components are never installed. `kubectl get ars -A` shows every AppRelease in `cpaas-system` (`alauda-alb2`, `cni-kube-ovn`, `coredns`, `prometheus`, `region` and others) in `ChartDownloading`, and `kubectl get rpch` returns `No resources found`. Describing one AppRelease shows:

```text
ChartDownloadFailed  [1/1] failed to download chart acp/chart-csi-driver-nfs-v3.18.3, err: failed to do request: Head "http://<registry>:60080/v2/acp/chart-csi-driver-nfs/manifests/v3.18.3": dial tcp <registry>:60080: connect: connection timed out
```

At the same time:

- `telnet` and `curl -v http://<registry>:60080/v2` from the cluster nodes succeed (the answer is `Client sent an HTTP request to an HTTPS server.`), and every Pod is `Running`.
- Restarting `sentry` has no effect. Its log has no download error, only `too many processors, process later ... MaxConcurrentProcessors=10 CurrentProcessors=10`.
- OVN logs show nothing abnormal.

## Root Cause

### Cause 1: ovn-default was created as an overlay subnet although the cluster was planned as underlay

The `ovn-default` subnet was meant to be underlay but was configured as overlay: `kubectl get subnet` shows `ovn-default` with `NAT` `true` and no VLAN. In this network design the Pods could not reach the registry on that path, so every chart download from inside the cluster timed out, while the nodes, which use the host network, could reach it. From inside the `sentry` Pod:

```text
curl: (28) Failed to connect to <registry> port 60080 after 130152 ms: Could not connect to server
```

A subnet that references a VLAN is an underlay subnet; one without a VLAN is an overlay subnet.

## Resolution

### Cause 1: ovn-default was created as an overlay subnet although the cluster was planned as underlay

1. Confirm the signature: the node `curl` answers, the `curl` from `sentry` fails, and `ovn-default` has no VLAN although the cluster was planned as underlay (see Diagnostic Steps).

2. Redeploy the cluster with `ovn-default` as an underlay subnet (with the planned VLAN, gateway and NIC).

   > **Warning:** Redeploying deletes the cluster and everything running on it, and it cannot be undone. Only when the cluster is newly added and has no business workloads yet, and the signature in step 1 is confirmed. If the `curl` from `sentry` works, or `ovn-default` already has the intended type, this is not the fault: look at DNS resolution of the registry address and the `sentry` component instead, which also leave charts in `ChartDownloading`.

3. After the redeploy, test from a Pod on the underlay subnet to the registry and to the global cluster's platform address. A firewall between the underlay subnet and the global cluster can still block that path; open it on the network side.

## Diagnostic Steps

1. List the AppReleases stuck in download and read the error:

   ```bash
   kubectl get ars -A | grep -i chartdownloading
   kubectl -n cpaas-system describe ars <ars-name> | grep -A2 ChartDownloadFailed
   ```

2. Compare the node path with the Pod path to the registry. The node should answer; a timeout from `sentry` matches this issue:

   ```bash
   curl -v --max-time 10 http://<registry>:60080/v2/
   kubectl -n cpaas-system get pod | grep sentry
   kubectl -n cpaas-system exec <sentry-pod> -- curl -v --max-time 10 http://<registry>:60080/v2/
   ```

3. Check the type of `ovn-default`. An empty `vlan` with `nat=true` on a cluster planned as underlay confirms the cause:

   ```bash
   kubectl get subnet ovn-default -o jsonpath='vlan={.spec.vlan} provider={.spec.provider} nat={.spec.natOutgoing}{"\n"}'
   ```
