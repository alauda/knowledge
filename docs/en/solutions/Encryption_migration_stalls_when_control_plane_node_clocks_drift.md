---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

The cluster's apiserver and controller-manager operators sit in a degraded state for hours or days, never advancing. The conditions point at encryption-key migration:

```text
kube-apiserver         True True  False  221d
  EncryptionMigrationControllerProgressing:
  migrating resources to a new write key: [core/configmaps core/secrets]

kube-controller-manager True False True  221d
  GarbageCollectorDegraded: error querying alerts: client_error: 403
```

A symptomatic clue: one of the apiserver pods reports an unreasonable `AGE` (long uptime measured in days while the others report 0 or vice versa, or one carries an `<unknown>` age):

```text
kube-apiserver-master-0  5/5 Running 0 34h
kube-apiserver-master-1  5/5 Running 0 34h
kube-apiserver-master-2  5/5 Running 0 <invalid>
```

The migration controller wants to re-encrypt every Secret and ConfigMap with the new write key, but it cannot finish — the controller depends on a quorum view across the apiserver replicas, and the cluster's clocks are not aligned tightly enough for the leader-election leases to behave correctly.

## Root Cause

Encryption-at-rest key rotation runs in two phases: write the new key into the encryption config so every new write uses it, then walk every existing object of the affected resource types and re-write each so the on-disk record is encrypted with the new key. The walk is leader-elected and progress-tracked across the apiserver replicas — each leader must hold a renewal lease and persist the migration cursor on every batch.

Lease durations are computed in wall-clock seconds. When two control-plane nodes' clocks drift more than a few seconds apart (NTP misconfigured, chrony service down, virtualised host's hardware clock skewed against the hypervisor), the leases observed by one apiserver expire from another's perspective, the leader changes mid-batch, the cursor gets reset, and the migration goes back to its start. Visible symptom: the migration condition stays `Progressing` indefinitely; the operator status reports the same resources being migrated repeatedly.

The off-clock node also produces the spurious pod-age display: `kubectl` computes age from `metadata.creationTimestamp` minus the local apiserver's clock, so a backwards-drifted apiserver returns negative ages that render as `<unknown>` or absurd values.

## Resolution

Restore tight clock synchronisation across every control-plane node. The migration controller resumes once leases stop flapping; no manual intervention to the encryption config is needed.

### Step 1 — confirm the drift

Read each control-plane node's wall clock through a debug pod:

```bash
for NODE in $(kubectl get nodes -l node-role.kubernetes.io/control-plane -o name); do
  echo "------ ${NODE} ------"
  kubectl debug "$NODE" -q -- chroot /host date -u +%FT%TZ
done
```

A spread of more than ~1 second between any two nodes is enough to destabilise leader election. Multi-second spreads guarantee the encryption migration won't finish.

### Step 2 — diagnose the time service on the offending node

The platform's standard time service is `chronyd` on each node. Inspect its tracking state:

```bash
NODE=master-2.lab.example.com
kubectl debug node/"$NODE" -q -- chroot /host bash -c '
  systemctl status chronyd --no-pager | head -10
  chronyc sources -v
  chronyc tracking
'
```

Failure modes to look for:

- **`No suitable source for synchronisation`** — chrony cannot reach any of its configured time sources. Network rule blocks UDP 123, or the upstream NTP servers are dead.
- **`Selected source is unsynchronised`** — chrony picked a source but that source itself isn't reliable. Need a better-quality upstream.
- **`System clock wrong by N seconds`** with N > 1 — chrony has not stepped the clock yet (it tries to slew, which is gradual). On long drifts, force a step.

### Step 3 — fix and re-step the clock

If the upstream NTP source is unreachable, fix network egress or pick a working source. If chrony is healthy but the clock simply hasn't stepped yet, force it:

```bash
kubectl debug node/"$NODE" -q -- chroot /host bash -c '
  chronyc -a makestep
  date -u +%FT%TZ
'
```

For chrony configurations baked into the node image via the platform's `MachineConfig`-equivalent, edit the configuration through the platform's node-config CR (do **not** hand-edit `/etc/chrony.conf` on the live node — the controller reverts it):

```yaml
apiVersion: machineconfiguration.alauda.io/v1
kind: MachineConfig
metadata:
  name: 99-control-plane-chrony
  labels:
    machineconfiguration.alauda.io/role: control-plane
spec:
  config:
    ignition:
      version: 3.2.0
    storage:
      files:
        - path: /etc/chrony.conf
          mode: 0644
          overwrite: true
          contents:
            source: data:text/plain;charset=utf-8;base64,<BASE64_OF_CHRONY_CONF>
```

The body should contain trustworthy upstream sources reachable from the cluster's network:

```text
server time-a.example.com iburst
server time-b.example.com iburst
makestep 1.0 3
rtcsync
keyfile /etc/chrony.keys
leapsectz right/UTC
logdir /var/log/chrony
```

After the rolling apply lands on every control-plane node, re-check Step 1 — the spread should drop to sub-second.

### Step 4 — confirm the encryption migration completes

Once the clocks settle, the migration controller's leader holds its lease through a full batch and the cursor advances. Watch the operator condition flip:

```bash
kubectl get clusteroperator kube-apiserver -o yaml \
  | yq '.status.conditions[] | select(.type == "Progressing") | {status, reason, message}'
```

A `status: "False"` with `reason: AsExpected` confirms the migration finished. The Secrets and ConfigMaps are now encrypted with the new write key on disk.

The pod-age display normalises once the apiserver's local clock is back in sync — the apparent oddity in `kubectl get pod` output disappears with no other intervention.

## Diagnostic Steps

If clocks look fine but the migration still stalls, look at the operator's controller log directly:

```bash
APISRV_NS=cpaas-kube-apiserver-operator
kubectl -n "$APISRV_NS" logs deploy/kube-apiserver-operator --tail=500 \
  | grep -E 'EncryptionMigration|migration|cursor'
```

Repeated `lost leadership; restarting` lines in close succession point back at clock drift even when `date` looks aligned at one moment — the spread can be transient (a chrony slew that overshoots). Run `chronyc tracking` on every control-plane node and look for non-zero `system time` offsets greater than a few hundred milliseconds.

If the controller log shows `error: failed to update encryption config: ...` instead of leader-election churn, the underlying issue is different — the encryption-config Secret cannot be written. Check whether etcd has free space and whether any admission webhook is intercepting writes to the operator's namespace.

For the GarbageCollectorDegraded condition's `403`, that is a downstream symptom: the GC controller polls Alertmanager to suppress alerts during normal operations, and a 403 from Alertmanager is unrelated to the encryption migration. Investigate the cluster's monitoring stack permissions separately if it persists after the migration completes.

For deeper visibility into NTP behaviour over time, capture chrony's measurement history during the next drift event:

```bash
kubectl debug node/"$NODE" -q -- chroot /host bash -c '
  chronyc -a allow
  chronyc -a sourcestats
'
```

A high `Std Dev` on the upstream sources indicates lossy or congested links to the NTP servers. Move chrony to closer or higher-stratum sources to reduce variability.
