---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
---

# Checking cluster health using kubectl on ACP

## Issue

Operators of an Alauda Container Platform 4.3.x cluster (Kubernetes server `v1.34.5`, Ubuntu 22.04.1 LTS nodes with `containerd://2.2.1-5`) need a short, reproducible set of `kubectl` checks to confirm that nodes are registered and Ready, that no CertificateSigningRequest objects are pending, and that the etcd quorum is healthy. The commands below produce the headline columns an administrator scans first when triaging a control-plane incident or before a maintenance window [ev:c3][ev:c4].

## Diagnostic Steps

List every node registered with the cluster along with its `STATUS`, `ROLES`, `AGE`, and kubelet `VERSION` columns [ev:c3]:

```bash
kubectl get nodes
```

```text
NAME              STATUS   ROLES                                   AGE   VERSION
<control-plane>   Ready    control-plane,cpaas-system,master       12d   v1.34.5
```

On ACP, the `ROLES` column carries the platform-specific `cpaas-system` role in addition to the upstream `control-plane` / `master` roles [ev:c3].

Append `-o wide` to add the `INTERNAL-IP`, `EXTERNAL-IP`, `OS-IMAGE`, `KERNEL-VERSION`, and `CONTAINER-RUNTIME` columns. On this cluster the `OS-IMAGE` column reports `Ubuntu 22.04.1 LTS` and the container runtime on these nodes is `containerd://2.2.1-5` [ev:c4]:

```bash
kubectl get nodes -o wide
```

```text
NAME              STATUS  ...  INTERNAL-IP       EXTERNAL-IP  OS-IMAGE             KERNEL-VERSION      CONTAINER-RUNTIME
<control-plane>   Ready   ...  192.168.135.152   <none>       Ubuntu 22.04.1 LTS   5.15.0-56-generic   containerd://2.2.1-5
```

A healthy cluster has no CertificateSigningRequest objects sitting in `Pending` status. On a steady-state ACP cluster the query typically returns `No resources found`, which is the expected healthy reading [ev:c8]:

```bash
kubectl get csr
```

```text
No resources found
```

Inspect the etcd database size on every endpoint. On ACP, the etcd member runs as a static pod named `etcd-<control-plane-ip>` in the `kube-system` namespace, and `etcdctl` is available inside that pod; the etcd pod is reached via `kubectl exec` and the client runs with the static-pod's own PKI mounts. The `endpoint status --cluster -w table` form prints the `ENDPOINT`, `ID`, `VERSION`, `DB SIZE`, `IS LEADER`, `IS LEARNER`, `RAFT TERM`, `RAFT INDEX`, `RAFT APPLIED INDEX`, and `ERRORS` columns. On a 12-day-old single-control-plane cluster the `DB SIZE` column reads `163 MB`, well under the 1 GiB threshold that is treated as a warning sign even though it is not by itself an error, and `VERSION` reports `3.5.28` [ev:c10]:

```bash
kubectl exec -n kube-system etcd-<control-plane-ip> -- \
  etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt \
          --cert=/etc/kubernetes/pki/etcd/server.crt \
          --key=/etc/kubernetes/pki/etcd/server.key \
          endpoint status --cluster -w table
```

```text
+------------------------------+------------------+---------+---------+-----------+...
|           ENDPOINT           |        ID        | VERSION | DB SIZE | IS LEADER |...
+------------------------------+------------------+---------+---------+-----------+...
| https://<control-plane-ip>:2379 | xxxxxxxxxxxxxxxx |  3.5.28 |  163 MB |   true    |...
+------------------------------+------------------+---------+---------+-----------+...
```

Check per-endpoint health and round-trip latency with the matching `endpoint health` form. The table columns are `ENDPOINT`, `HEALTH`, `TOOK`, and `ERROR`; the `HEALTH` column reading `true` is the pass/fail signal. The `TOOK` value is a single round-trip timing, not a hard threshold — what matters for health is that `HEALTH` is `true` and that `TOOK` stays in the low-millisecond range and is stable across repeated checks, rather than any specific cutoff. On this lab single-control-plane cluster `TOOK` was observed at `11.739462ms`; treat that as an example data point, not a limit (single-digit-millisecond values are common, and a transiently higher reading on an otherwise-healthy endpoint is not by itself a problem) [ev:c11]:

```bash
kubectl exec -n kube-system etcd-<control-plane-ip> -- \
  etcdctl --cacert=/etc/kubernetes/pki/etcd/ca.crt \
          --cert=/etc/kubernetes/pki/etcd/server.crt \
          --key=/etc/kubernetes/pki/etcd/server.key \
          endpoint health --cluster -w table
```

```text
+------------------------------+--------+---------------+-------+
|           ENDPOINT           | HEALTH |     TOOK      | ERROR |
+------------------------------+--------+---------------+-------+
| https://<control-plane-ip>:2379 |  true  | 11.739462ms   |       |
+------------------------------+--------+---------------+-------+
```

The legacy `kubectl get componentstatus` query is also still served by Kubernetes `v1.34.5`'s apiserver and returns the `scheduler`, `controller-manager`, and `etcd-0` rows with `STATUS`, `MESSAGE`, and `ERROR` columns; the apiserver prints `Warning: v1 ComponentStatus is deprecated in v1.19+` first because the API is marked for eventual removal. On a single-control-plane host the `scheduler` and `controller-manager` rows frequently show `Unhealthy` with a `127.0.0.1:10259: connect: connection refused`-style message, because their `/healthz` endpoints bind to `127.0.0.1` inside the static-pod's host network and are not reachable from outside the kubelet host; the `etcd-0` row meanwhile reports `Healthy` [ev:c12]:

```bash
kubectl get componentstatus
```

```text
Warning: v1 ComponentStatus is deprecated in v1.19+
NAME                 STATUS      MESSAGE                                                                  ERROR
scheduler            Unhealthy   Get "https://127.0.0.1:10259/healthz": dial tcp 127.0.0.1:10259: connect: connection refused
controller-manager   Unhealthy   Get "https://127.0.0.1:10257/healthz": ...
etcd-0               Healthy     ok
```

## Resolution

Use the `kubectl get nodes` / `kubectl get nodes -o wide` / `kubectl get csr` / `kubectl exec -n kube-system etcd-<control-plane-ip> -- etcdctl ... endpoint status|health --cluster -w table` sequence above as the standing cluster-health smoke test on ACP 4.3.x. Treat the `STATUS` column on nodes, the absence of `Pending` rows in `kubectl get csr`, the etcd `DB SIZE` staying under 1 GiB, and every etcd endpoint's `HEALTH` column reading `true` as the green-light signals; investigate any deviation before further changes [ev:c3][ev:c8][ev:c10][ev:c11]. The deprecated `kubectl get componentstatus` output is still informative for the etcd row but should not be relied on for the scheduler and controller-manager rows on a control plane whose `/healthz` listeners bind to `127.0.0.1`; those rows are expected to read `Unhealthy` from off-host and do not by themselves indicate a broken control plane [ev:c12].
