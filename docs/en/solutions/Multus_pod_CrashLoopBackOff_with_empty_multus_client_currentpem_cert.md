---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Multus pod CrashLoopBackOff with empty multus-client-current.pem cert
## Issue

A single Multus daemon pod on one node sits in `CrashLoopBackOff` while every other node's Multus pod is healthy. New pods scheduled to the affected node stick in `ContainerCreating` because they cannot satisfy the Multus readiness contract. Per-node DaemonSets that depend on Multus (`network-metrics-daemon`, secondary-CNI plugin pods) also fail to come up on the same node.

The Multus pod log shows the daemon panicking at startup while loading its per-node client certificate:

```text
[verbose] multus-daemon started
[verbose] Readiness Indicator file check
[verbose] Readiness Indicator file check done!
certificate_store.go:130] Loading cert/key pair from "/etc/cni/multus/certs/multus-client-current.pem".
[error] failed to initialize the certificate manager:
        could not convert data from "/etc/cni/multus/certs/multus-client-current.pem"
        into cert/key pair: tls: failed to find any PEM data in certificate input
[panic] failed to start the multus thick-plugin listener: failed to create the server:
        error getting perNodeClient: failed to initialize the certificate manager
```

The error says the PEM file is empty or unparseable.

## Root Cause

The Multus thick-plugin daemon authenticates to the cluster apiserver with a per-node TLS client certificate that the kubelet certificate-rotation flow keeps refreshed. The current credential is the symlink `/etc/cni/multus/certs/multus-client-current.pem` → `multus-client-<timestamp>.pem`. When the node is offline for longer than the certificate's renewal window — typical after a long power-off, a maintenance reboot loop, or a cordoned node parked for days — the rotation controller writes a placeholder file at the next timestamp slot **before** the actual signing completes, then fails to fill it with PEM bytes. The symlink ends up pointing at a zero-byte file.

On boot, the Multus daemon dereferences the symlink, finds zero bytes where the certificate should be, and panics — the daemon has no fallback path because every API call needs an authenticated client.

Tracked upstream as a Multus thick-plugin certificate-rotation race; the recovery is symptomatic until the upstream fix lands in the platform's Multus build.

## Resolution

Delete the empty PEM file (and its symlink target) on the affected node, then let the Multus pod restart. The certificate manager will request a fresh cert on next start, the apiserver signs it, and the daemon comes up clean.

```bash
NODE=worker-1.lab.example.com

kubectl debug node/"$NODE" -it -- chroot /host bash <<'EOF'
cd /etc/cni/multus/certs
ls -ltrh | tail -5
# Confirm the current symlink and that its target is empty:
readlink multus-client-current.pem
TARGET=$(readlink multus-client-current.pem)
[[ -s "$TARGET" ]] && echo "WARNING: $TARGET is not empty — re-check before deleting" && exit 1
rm -f "$TARGET"
EOF
```

The script refuses to delete a non-empty PEM (a safety net — if the certificate is intact, the panic is from a different cause and deleting it would force an unnecessary re-issue).

After deletion, restart the affected Multus pod so the daemon re-runs its certificate-store initialiser:

```bash
kubectl -n cpaas-multus get pod -o wide \
  | grep -E "$NODE.*multus" \
  | awk '{print $1}' \
  | xargs -r kubectl -n cpaas-multus delete pod
```

The replacement pod requests a new cert from the apiserver, writes it to a fresh `multus-client-<new-timestamp>.pem`, repoints the `multus-client-current.pem` symlink, and reports `Running 1/1`. Pods that were stuck in `ContainerCreating` start to progress within a few seconds.

If multiple nodes hit the same condition simultaneously (cluster-wide reboot, prolonged shutdown of a worker pool), loop over the offenders:

```bash
for n in $(kubectl get pod -n cpaas-multus -o wide \
            | awk '/CrashLoopBackOff/ {print $7}' | sort -u); do
  echo "fixing $n"
  kubectl debug node/"$n" -it -- chroot /host bash <<'EOF'
cd /etc/cni/multus/certs
TARGET=$(readlink multus-client-current.pem)
[[ -s "$TARGET" ]] || rm -f "$TARGET"
EOF
  kubectl -n cpaas-multus delete pod -l app=multus --field-selector=spec.nodeName="$n"
done
```

## Diagnostic Steps

Confirm the symlink's target is the zero-byte PEM:

```bash
kubectl debug node/"$NODE" -it -- chroot /host bash -c '
  cd /etc/cni/multus/certs
  ls -ltrh | tail -5
  T=$(readlink multus-client-current.pem)
  echo "target: $T"
  echo "size:   $(stat -c%s "$T") bytes"
'
```

A `size: 0 bytes` line confirms this article applies. Any other size (a non-empty file that still fails parsing) usually means corruption, not a rotation race — capture the file for forensic before deleting:

```bash
kubectl debug node/"$NODE" -it -- chroot /host \
  bash -c 'cat /etc/cni/multus/certs/multus-client-current.pem' \
  > /tmp/multus-client-current.pem.broken
openssl x509 -in /tmp/multus-client-current.pem.broken -noout -text || true
```

If `openssl x509` reports `unable to load certificate` on a non-zero file, the workaround still applies — delete and let rotation re-sign — but it is worth filing the file with platform support so the underlying cause can be investigated.

To verify rotation is healthy after recovery, watch the cert directory for a fresh write within the next few rotation cycles:

```bash
kubectl debug node/"$NODE" -it -- chroot /host \
  bash -c 'ls -ltrh /etc/cni/multus/certs/ | tail -5'
```

A non-zero `multus-client-<recent-timestamp>.pem` and a working symlink to it confirms the daemon is back in the rotation loop.

If the node still produces empty PEM files after the workaround, the kubelet cert path is misconfigured. Inspect the kubelet's bootstrap client and confirm it can sign CSRs:

```bash
kubectl debug node/"$NODE" -it -- chroot /host \
  bash -c 'journalctl -u kubelet --since "1 hour ago" | grep -E "csr|cert"'
```

A pattern of CSR creation followed by a 4xx from the apiserver points at a broader certificate-signer problem (kubelet client CA rotation, signer permission gap), not the Multus-specific race — escalate to the cluster's certificate operator team.
