---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.12"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Calico ipipMode reverts, Felix metrics off, bandwidth annotation breaks Pods, systemd-udevd loops on calico_tmp on ACP

## Issue

On a cluster that uses Calico as the CNI, a configuration change does not behave as expected:

- `ipipMode` on the `IPPool` `default-ipv4-ippool` is changed from `Always` to `CrossSubnet` and flips back to `Always`.
- Felix monitoring shows no data and the Felix metrics port is not listening.
- New workloads cannot get an address because the default Calico BGP subnet has no free addresses, and other subnets are being considered.
- A Deployment stops starting Pods after a Calico bandwidth annotation was added to it.
- Node load is high because `systemd-udevd` keeps trying to configure the interfaces `calico_tmp_A` and `calico_tmp_B`.

Related articles: "Pod traffic fails on Calico because of an IPPool destination, MTU, firewall, BGP sessions or IPv6 routes on ACP".

## Root Cause

### Cause 1: ipipMode CrossSubnet reverts to Always until the Subnet and the IPPool match

The platform keeps a `Subnet` object and a Calico `IPPool` object with the same name (for example `default-ipv4-ippool`). The two have to stay consistent; otherwise the controller can overwrite one with the other, and the console can show a value different from the dataplane. Changing only the `IPPool` to `ipipMode: CrossSubnet` while the `Subnet` still says `Always` is the inconsistency that gets overwritten. The exact revert path was not confirmed.

### Cause 2: Felix Prometheus metrics are off because prometheusMetricsEnabled is not set

The Felix configuration has no `prometheusMetricsEnabled` setting, which means Felix metrics are disabled, so the metrics port is not listening and monitoring has nothing to scrape. Felix serves metrics on TCP `9091` when enabled; the endpoint is protected only by a self-signed certificate and has no authentication.

### Cause 3: the default Calico BGP subnet has no free addresses

New workloads cannot get an address from the default subnet because it is full. Placing business workloads on other subnets that still have free addresses restores allocation. Traffic between those subnets works without extra network policy.

### Cause 4: Pods fail after a Calico bandwidth annotation was added

A bandwidth annotation from the open-source Calico procedure (for example `kubernetes.io/ingress-bandwidth`) was added to the Pod template. Rate limiting did not work, and when a Pod was rebuilt the qdisc rules of the previous Pod had not been cleaned up, so the new Pod failed on a conflict between several qdiscs on one interface. The platform currently provides no supported method for Calico Pod bandwidth limiting.

### Cause 5: systemd-udevd loops on calico_tmp_A and calico_tmp_B

Calico XDP creates the temporary interfaces `calico_tmp_A` and `calico_tmp_B` and destroys them immediately. The host's `systemd-udevd` tries to configure each one, fails because it is already gone, and retries, which drives the node load up. XDP is an acceleration feature and disabling it has no functional impact. It is on by default in current versions and cannot be turned off at deployment time.

## Resolution

### Cause 1: ipipMode CrossSubnet reverts to Always until the Subnet and the IPPool match

Set the same values on both objects in one change.

> **Warning:** Changing `ipipMode` reprograms encapsulation and can reset cross-subnet tunnels while Felix applies the pool. Only when an `ipipMode: CrossSubnet` edit returns to `Always`. Save both objects first; restoring them is the rollback.

```bash
kubectl get subnet default-ipv4-ippool -o yaml > /root/subnet-default-ipv4-ippool.before.yaml
kubectl get ippools.crd.projectcalico.org default-ipv4-ippool -o yaml > /root/ippool-default-ipv4-ippool.before.yaml
kubectl edit ippools.crd.projectcalico.org default-ipv4-ippool
kubectl edit subnet default-ipv4-ippool
```

Set these values where the fields exist:

```yaml
ipipMode: CrossSubnet
vxlanMode: Never
```

If the `Subnet` uses a different key for the IPIP mode, change that key so its value matches the `IPPool`; do not add a parallel key.

### Cause 2: Felix Prometheus metrics are off because prometheusMetricsEnabled is not set

Enable Felix metrics on the `calico-node` DaemonSet.

> **Warning:** The DaemonSet rolls and `calico-node` restarts on every node, which can briefly disturb container networking. Enabling the variable exposes the unauthenticated metrics endpoint on TCP `9091` on every node, so enable it only where a scraper needs it. Roll back by setting the variable to `false`, as described in "Disable Calico Node Metrics Port".

```bash
kubectl -n kube-system get ds calico-node -o jsonpath='{.spec.template.spec.containers[*].name}{"\n"}'
kubectl -n kube-system set env ds/calico-node -c calico-node FELIX_PROMETHEUSMETRICSENABLED=true
kubectl -n kube-system rollout status ds/calico-node
ss -lnt | grep 9091 || true
```

### Cause 3: the default Calico BGP subnet has no free addresses

Place new business workloads on a subnet that still has free addresses, using the subnet assignment the cluster already uses for business workloads, then confirm the new Pod address falls in that CIDR. Check the pools before moving any system namespace; this change concerns business workloads only, not `kube-system` or `cpaas-system`.

```bash
kubectl get ippools.crd.projectcalico.org -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidr,DISABLED:.spec.disabled'
kubectl get subnet
kubectl -n <namespace> get pod -o wide
```

### Cause 4: Pods fail after a Calico bandwidth annotation was added

Remove the bandwidth annotations from the Pod template and let the Pods be recreated.

> **Warning:** Editing the Pod template rolls the Deployment. Putting the annotation back brings the qdisc conflict back.

```bash
kubectl -n <namespace> get deploy <deploy> -o jsonpath='{.spec.template.metadata.annotations}{"\n"}'
kubectl -n <namespace> patch deploy <deploy> --type=json -p='[{"op":"remove","path":"/spec/template/metadata/annotations/kubernetes.io~1ingress-bandwidth"}]'
```

`~1` encodes the `/` in the key. Repeat the patch for each bandwidth key the template has (for example `kubernetes.io/egress-bandwidth`). If Pods still fail afterwards, restarting kubelet and the container runtime on the node is the next step to have the stale qdiscs cleaned up; that restart affects every Pod on the node.

### Cause 5: systemd-udevd loops on calico_tmp_A and calico_tmp_B

Disable XDP on `calico-node`, then check that the temporary interfaces stop appearing. Analyzing `systemd-udevd` on the host is the alternative.

> **Warning:** The change restarts every `calico-node` Pod, which affects workloads; do it in a maintenance window. Roll back by restoring the saved DaemonSet or unsetting the variable.

```bash
kubectl -n kube-system get ds calico-node -o yaml > /root/calico-node.before-xdp.yaml
kubectl -n kube-system set env ds/calico-node -c calico-node FELIX_XDPENABLED=false
kubectl -n kube-system rollout status ds/calico-node
ip link show | grep calico_tmp || true
```

## Diagnostic Steps

1. Compare the `Subnet` and the `IPPool` of the same name:

   ```bash
   kubectl get subnet default-ipv4-ippool -o yaml | grep -iE 'ipip|vxlan'
   kubectl get ippools.crd.projectcalico.org default-ipv4-ippool -o yaml | grep -iE 'ipipMode|vxlanMode'
   ```

   Different values: Cause 1.

2. Check whether Felix metrics are enabled:

   ```bash
   kubectl -n kube-system get ds calico-node -o yaml | grep -i -A1 PROMETHEUS
   ss -lnt | grep 9091 || echo "9091 not listening"
   ```

   No `FELIX_PROMETHEUSMETRICSENABLED=true` and nothing listening on `9091`: Cause 2.

3. Allocation failures with the default subnet full: Cause 3.

4. Pod failures that start with a bandwidth annotation, with several qdiscs on the interface:

   ```bash
   tc qdisc show | head
   ```

   Cause 4.

5. `systemd-udevd` busy on the temporary interfaces:

   ```bash
   journalctl -u systemd-udevd --since '-10 min' | grep calico_tmp | tail
   ```

   Cause 5.
