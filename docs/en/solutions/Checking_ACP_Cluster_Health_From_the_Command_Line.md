---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Routine health checks on an ACP cluster — before a change window, during an incident, or as the first pass after a page — benefit from a short CLI sequence that covers the usual fault lines: API server reachability, node readiness, platform operators, node-pool state, pending CSRs, and the etcd control plane. The goal is to answer "is anything obviously wrong?" in under a minute without having to open the web console.

## Resolution

Run the commands below in order on any host with a `kubeconfig` for the cluster. Each section gives the command, what a healthy output looks like, and what the common failure shapes mean.

### 1. Client and server versions

```bash
kubectl version
```

Expected: the `Server Version` is populated and the `Client Version` GitVersion is the same major/minor or one version newer than the server. A blank `Server Version` block means the CLI could not reach the API — check `kubeconfig` and network path before continuing.

### 2. Node status

```bash
kubectl get nodes -o wide
```

Every node should be `Ready`. Common non-healthy states and what they mean:

- `NotReady` — the kubelet has stopped reporting; check the node's kubelet service and network path to the API server.
- `Ready,SchedulingDisabled` — the node was `kubectl cordon`'d, usually during a maintenance window; nothing new will schedule there until `kubectl uncordon`.
- Version skew between nodes — normal during a rolling upgrade; flag it only if the upgrade is not supposed to be in progress.

### 3. Platform operator / controller state

ACP ships a set of platform operators that reconcile the core cluster services (networking, storage, logging, monitoring, and so on). List their custom resources and look for ones whose `Available` is anything other than `True` or whose `Degraded` is not `False`:

```bash
kubectl get csv -A                            # operator subscriptions
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
kubectl get deploy -A -o wide | awk 'NR==1 || $5 != $4'
```

Any non-Running pods in a platform-owned namespace, or a Deployment whose `AVAILABLE` count is lower than `DESIRED`, is a starting point for deeper investigation. The relevant namespaces depend on what is installed on the cluster — common ones include `cluster-logging`, `cluster-monitoring`, `cluster-networking`, `cert-manager`, the virtualization operator namespace, and the GitOps / DevOps namespaces.

### 4. Node-pool / machine configuration state

ACP manages node configuration through the `configure/clusters/nodes` surface (and the **Immutable Infrastructure** extension where installed). The cluster keeps a set of node pools and reports on how many nodes have reconciled the current rendered configuration. The exact CRD name depends on the release; common shapes are:

```bash
# Current ACP releases (inspect which CRD the cluster actually ships):
kubectl api-resources | grep -iE 'nodeconfig|machineconfig|nodepool'

# Then list pool state against the discovered CRD name, e.g.:
kubectl get nodeconfigpool
# or
kubectl get machineconfigpool
```

A healthy pool reports `UPDATED=True`, `UPDATING=False`, `DEGRADED=False` and `MACHINECOUNT == READYMACHINECOUNT == UPDATEDMACHINECOUNT`. A pool stuck on `UPDATING=True` for longer than a single node reboot usually has a stuck drain (a pod with a restrictive PDB, an unresponsive finalizer) or a failing bootstrap on one node — inspect events on the pool and logs on the holdout node.

### 5. Pending CSRs

A healthy cluster has no `Pending` CertificateSigningRequests:

```bash
kubectl get csr
```

`Pending` CSRs typically accumulate when:

- A new node is joining and waiting for the kubelet-serving CSR to be approved.
- Serving certificates for existing nodes are rotating and the auto-approver is not installed or is degraded.

Only approve CSRs after verifying the originating node identity — blanket-approving pending CSRs is a privilege-escalation path.

### 6. etcd size and health

The etcd control plane runs as a static set of pods. Inspect cluster members, per-endpoint DB size, and latency:

```bash
ETCD_NS=$(kubectl get pods -A -l app=etcd -o jsonpath='{.items[0].metadata.namespace}')
ETCD_POD=$(kubectl -n $ETCD_NS get pods -l app=etcd \
           --field-selector='status.phase==Running' \
           -o jsonpath='{.items[0].metadata.name}')

kubectl -n $ETCD_NS exec -c etcd $ETCD_POD -- \
  etcdctl endpoint status --cluster -w table

kubectl -n $ETCD_NS exec -c etcd $ETCD_POD -- \
  etcdctl endpoint health --cluster -w table
```

Thresholds:

- DB size above **1 GiB** is a yellow flag — not a failure, but investigate why (leftover Events, a high-churn CRD, failed defrag after a compaction pass).
- Endpoint `latency` above **10 ms** is a red flag — look for disk contention on the control-plane node, a slow remote-storage-backed etcd data volume, or a very high write QPS from a misbehaving controller.

Compact and defrag when the database has grown above the guideline size:

```bash
kubectl -n $ETCD_NS exec -c etcd $ETCD_POD -- etcdctl defrag --cluster
```

Defrag blocks writes per-endpoint, so do it one member at a time during a quiet window.

### 7. API-server headroom

A quick sanity check on API server load — high-rate 429s or a slow API under a steady request rate is a separate class of problem:

```bash
kubectl top node 2>/dev/null          # requires metrics-server
kubectl get --raw=/readyz?verbose | tail
```

`/readyz` returns a per-check list; every line should end in `ok`. Any `[-]...failed` line is the specific sub-subsystem to investigate next (etcd read/write, admission, leader election, and so on).

## Diagnostic Steps

When the commands above surface a red flag, the standard next step is to look at the offending component's events and pod logs in that namespace:

```bash
kubectl -n <ns> get events --sort-by='.lastTimestamp' | tail -20
kubectl -n <ns> describe pod <pod>
kubectl -n <ns> logs <pod> -c <container> --tail=200
```

For a node that is `NotReady`, drop to the node over a debug pod and inspect kubelet:

```bash
kubectl debug node/<node-name> -- chroot /host \
  journalctl -u kubelet --since=-30m --no-pager | tail -100
```

For a degraded node-pool reconcile, fetch the pool object's `.status.conditions` — the `Message` field usually names the single node that is blocking progress:

```bash
kubectl get <pool-crd>/<pool-name> -o yaml | sed -n '/conditions:/,/^[a-z]/p'
```

When in doubt, pair the CLI output above with the cluster's own event stream:

```bash
kubectl get events -A \
  --field-selector=type!=Normal \
  --sort-by='.lastTimestamp' | tail -40
```

A clean Warning-level event tail across the whole cluster is the strongest single-line indicator that the current state is as healthy as the individual checks suggest.
</content>
</invoke>