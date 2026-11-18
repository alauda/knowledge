---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.16"
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Calico Pods get no address: disabled default IPPool, Raven fixed IP mismatch, reserved IPs or deleted raven on ACP

## Issue

On a Calico cluster, Pods cannot get an address, or a subnet question comes up:

- A Pod (for example a Kafka instance Pod) stays in `Init` because Calico allocates nothing from the default IPPool `default-ipv4-ippool`.
- A fixed-IP Deployment loops on one address because the Raven IP status and Calico IPAM disagree.
- Someone wants to reserve part of a Calico subnet so it is never allocated.
- The `raven` Deployment was deleted by mistake.

On Calico clusters, `raven` is the platform component that converts platform `Subnet` resources into Calico `IPPool` objects and maintains the platform IP objects.

Related articles: "Kube-OVN Pods fail with AddressOutOfRange, AddressConflict or no address allocated on ACP"; "Multus secondary networks: unexpected end of JSON input, duplicated addresses or several addresses on one NIC on ACP".

## Root Cause

### Cause 1: the default Calico IPPool is disabled

`kubectl get ippools.crd.projectcalico.org default-ipv4-ippool -o yaml` shows `disabled: true` in the spec (next to `blockSize: 26`, `ipipMode: Always`, `natOutgoing: true`, `vxlanMode: Never`). Calico allocates nothing from a disabled pool, so Pods that depend on it wait in `Init`.

### Cause 2: the Raven fixed IP stays empty while Calico IPAM still holds the address

A Calico overlay Deployment with more pinned addresses than ready replicas leaves one Pod requesting an address that another Pod already has. Raven does not write the occupancy back and does not repair an existing IP object, so the CNI keeps selecting the address that Calico IPAM considers taken. A restart of the controller does not clear it; the repair is in a later 4.2.x release.

### Cause 3: a Calico subnet cannot reserve part of its addresses

There is no setting for reserved IPs on a Calico subnet. Excluding part of a Calico container subnet from allocation cannot be done by configuration; this is a product limitation.

### Cause 4: the raven Deployment was deleted

`raven` exports Calico subnet metrics such as `subnet_available_ip_count` and `subnet_used_ip_count` on port `10660` at `/metrics`, and it creates and deletes Calico `IPPool` objects to match the platform `Subnet` resources. While it is missing, those metrics stop and subnet-to-IPPool synchronization stops, which affects Pod creation and deletion. The platform records manual changes to `raven` (for example its resource limits) as a ResourcePatch (`rpch`) object, and a leftover `rpch` keeps the platform from restoring the default Deployment.

## Resolution

### Cause 1: the default Calico IPPool is disabled

Remove the `disabled` field.

> **Warning:** Re-enabling the pool lets every new Pod draw addresses from it again; if it was disabled on purpose to drain it, this undoes that plan. Only when no other pool is meant to serve these Pods. Save the object first; setting `disabled: true` again is the rollback.

```bash
kubectl get ippools.crd.projectcalico.org -o custom-columns='NAME:.metadata.name,CIDR:.spec.cidr,DISABLED:.spec.disabled'
kubectl get ippools.crd.projectcalico.org default-ipv4-ippool -o yaml > /root/ippool-default.before.yaml
kubectl patch ippools.crd.projectcalico.org default-ipv4-ippool --type=json -p='[{"op":"remove","path":"/spec/disabled"}]'
```

If a platform `Subnet` with the same name manages the pool, check that object as well, so the field is not set back.

### Cause 2: the Raven fixed IP stays empty while Calico IPAM still holds the address

Until the release with the fix, stop requesting the address that Calico still holds: remove it from the workload's fixed-IP list, or scale the Deployment down so only Pods with a consistent address remain.

> **Warning:** Editing the fixed-IP list recreates Pods and drops the addresses you remove. Do not delete Calico IPAM blocks by hand; that can free an address a live Pod uses. Restoring the saved Deployment is the rollback and brings the conflict back.

```bash
kubectl get ip -A | grep <stuck-address>
kubectl get deploy <deploy> -n <namespace> -o yaml > /root/deploy.before.yaml
kubectl edit deploy <deploy> -n <namespace>
```

An IP object whose `containerID`, `nodeName` and `podName` are all empty, with `resource already exists` from the CNI, is a different case that a `raven` restart does fix; see "Kube-OVN fixed IP occupied or not released: held by another Pod, node down, duplicate entry or RollingUpdate on ACP".

### Cause 3: a Calico subnet cannot reserve part of its addresses

No configuration exists. Keep addresses that must not be allocated outside the Calico subnet's CIDR when planning it, or raise the requirement through the product channel.

### Cause 4: the raven Deployment was deleted

Delete the `rpch` objects that belong to `raven`; the platform then recreates the Deployment with its default specification.

> **Warning:** Deleting the `rpch` drops every manual change recorded for `raven`, such as raised limits. Save it first and reapply the change to the recreated Deployment if you still need it.

```bash
kubectl get rpch -A | grep raven
kubectl -n <rpch-namespace> get rpch <raven-rpch> -o yaml > /root/raven-rpch.before.yaml
kubectl -n <rpch-namespace> delete rpch <raven-rpch>
kubectl -n kube-system get deploy raven
```

## Diagnostic Steps

```bash
kubectl get ippools.crd.projectcalico.org -o yaml | grep -E 'name:|cidr:|disabled:'
kubectl -n kube-system get deploy raven
kubectl get ip -A | grep <address>
kubectl -n kube-system get ds calico-node -o wide
```

- A pool (normally `default-ipv4-ippool`) with `disabled: true` and Pods waiting in `Init`: Cause 1.
- A fixed-IP Deployment whose Raven IP object and Calico allocation disagree on one address: Cause 2. Compare the two before deleting anything.
- A request to reserve addresses in a Calico subnet: Cause 3.
- No `raven` Deployment in `kube-system`: Cause 4.
