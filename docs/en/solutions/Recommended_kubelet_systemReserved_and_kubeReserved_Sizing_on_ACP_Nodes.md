---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Recommended kubelet systemReserved and kubeReserved Sizing on ACP Nodes
## Issue

How much CPU and memory should be reserved for the system and Kubernetes
daemons on an ACP node, and where on ACP is `systemReserved` /
`kubeReserved` actually configured?

## Root Cause

`systemReserved` and `kubeReserved` are stock upstream kubelet settings.
The kubelet subtracts them (and `evictionHard`) from node capacity to
compute `Allocatable`:

```text
Allocatable = Capacity − systemReserved − kubeReserved − evictionHard
```

ACP does not change this formula. What differs is where the values
live:

- **microOS-based clusters** — use the **Alauda Container Platform
  Machine Configuration** plugin (`ModulePlugin/machine-config`).
- **non-microOS clusters** (general-purpose Linux distros) — edit
  `/var/lib/kubelet/config.yaml` on each node directly; the plugin is
  not applicable.

The ACP installer's default on Ubuntu 22.04 (verified on
`installer-v4.3.0-online`, k8s `v1.34.5`, 8 vCPU / 16 GiB worker) is a
modest test-fleet baseline:

```yaml
systemReserved:  { cpu: 100m, memory: 902Mi }
kubeReserved:    { cpu: 100m, memory: 902Mi }
evictionHard:    { memory.available: 100Mi, nodefs.available: 10%, ... }
```

→ `Allocatable: cpu 7800m, memory 14434848Ki`.

For real workload nodes these defaults are usually too tight; size
empirically from observed steady-state load.

## Resolution

### Non-microOS (direct kubelet edit)

```bash
sudo $EDITOR /var/lib/kubelet/config.yaml
```

Set, for example:

```yaml
systemReserved:
  cpu: 500m
  memory: 2Gi
kubeReserved:
  cpu: 200m
  memory: 2Gi
```

Apply per node, one at a time:

```bash
sudo systemctl restart kubelet
kubectl get node <name> -o jsonpath='{.status.allocatable}{"\n"}'
```

Do not restart all kubelets simultaneously — a fleet-wide flap can
briefly break control-plane reachability.

### microOS (Machine Configuration plugin)

On microOS, ACP ships `ModulePlugin/machine-config` which renders
kubelet config and handles per-node rollout. The plugin's CR shape is
product-specific; consult ACP docs for the plugin before editing. This
path was not exercised on the test cluster (Ubuntu, no `cpins`
instance for `machine-config`).

## Diagnostic Steps

```bash
kubectl get node <name> -o jsonpath='{.status.allocatable}{"\n"}{.status.capacity}{"\n"}'
sudo cat /var/lib/kubelet/config.yaml | grep -A2 -E 'systemReserved|kubeReserved|evictionHard'
```

Verify `Allocatable.memory ≈ Capacity.memory − systemReserved.memory −
kubeReserved.memory − evictionHard.memory.available`. If the edit
didn't take effect, the kubelet was likely not restarted.
