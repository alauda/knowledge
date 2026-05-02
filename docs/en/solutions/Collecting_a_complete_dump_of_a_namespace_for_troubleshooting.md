---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

When a workload in a single namespace misbehaves, support engineers usually need a snapshot of every resource in that namespace plus all container logs, packaged in one file. The cluster-wide diagnostic bundle (`inspection` collector, `kubectl cluster-info dump`) is too coarse — it overwhelms the responder with platform internals — and `kubectl get -A` is too narrow because it loses non-namespaced context (events, RBAC bindings, storage). The need is for a per-namespace dump that captures resource manifests, recent events, and previous + current container logs in one transferable archive.

## Resolution

For application-namespace troubleshooting, run a portable shell loop that walks every namespaced API resource and every pod's container logs, then compresses the result. The loop relies only on `kubectl` and the cluster's discovery API, so it works against any conformant cluster:

```bash
#!/bin/bash
# kubectl-nsdump <namespace>
# Collects manifests, events and container logs for one namespace.
set -eu
NS=${1:?usage: $0 <namespace>}
KCTL="kubectl -n $NS"

if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
  echo "namespace $NS does not exist" >&2
  exit 1
fi

if [ "$($KCTL auth can-i get pods)" != "yes" ]; then
  echo "current user cannot read pods in $NS" >&2
  exit 1
fi

DEST="${NS}-$(date +%Y%m%d-%H%M%S).txt.gz"
echo "collecting dump for $NS into $DEST"

{
  set -x
  date
  kubectl version --short
  kubectl whoami 2>/dev/null || $KCTL auth whoami -o yaml
  $KCTL get all -o wide
  kubectl get namespace "$NS" -o yaml

  # Walk every namespaced resource type the discovery API exposes,
  # comma-joining names so the API receives one request per verb.
  RESOURCES=$(kubectl api-resources --namespaced --verbs=list -o name | paste -sd,)
  $KCTL get --ignore-not-found "$RESOURCES" -o wide
  $KCTL get --ignore-not-found "$RESOURCES" -o yaml

  # Events, sorted by absolute timestamp instead of "5m ago" relative form.
  $KCTL get events -o custom-columns=\
'LAST:.lastTimestamp,FIRST:.firstTimestamp,COUNT:.count,'\
'NAME:.metadata.name,KIND:.involvedObject.kind,'\
'SUBOBJECT:.involvedObject.fieldPath,TYPE:.type,REASON:.reason,'\
'SOURCE:.source.component,MESSAGE:.message'

  # Per-pod, per-container logs (current + previous instance if any).
  for pod in $($KCTL get pod -o name); do
    for c in $($KCTL get "$pod" \
      --template='{{range .spec.containers}}{{.name}} {{end}}'); do
      $KCTL logs "$pod" -c "$c" --timestamps || true
      $KCTL logs "$pod" -c "$c" --timestamps --previous || true
    done
  done

  # If the caller has cluster-read scope, also capture topology context
  # that influences scheduling and storage of this namespace.
  if [ "$(kubectl auth can-i get nodes)" = "yes" ]; then
    kubectl get node -o wide
    kubectl get node -o yaml
    kubectl describe node
    kubectl get clusterrolebinding -o yaml
    kubectl get storageclass -o wide
    kubectl get storageclass -o yaml
    kubectl get pv -o wide
    kubectl get pv -o yaml
    kubectl get csr -o wide || true
    kubectl get pods -A -o wide
  fi
  date
} 2>&1 | gzip > "$DEST"

echo "dump written to $DEST"
```

Run it as the same user reproducing the problem so RBAC errors mirror the original failure mode. The output archive is plain text; `zless`, `zgrep` and `zcat` work on it directly without expanding to disk.

The script intentionally batches the resource list into one comma-joined `kubectl get` per verb — issuing one request per resource type would cost dozens of API calls and can trigger rate-limit responses from the apiserver. Search the gzipped output with `zgrep '^secret|^kind: Secret'` rather than re-running the script with a different filter.

For cluster-wide problems (apiserver, scheduler, ingress controllers, CNI), the per-namespace dump is the wrong tool. Use the platform's built-in `inspection` collector or its equivalent diagnostic-bundle CR — those bundle node, etcd, control-plane and operator state in one pass.

## Diagnostic Steps

If the script aborts on a specific resource type, identify which type triggered the failure:

```bash
kubectl api-resources --namespaced --verbs=list -o name | while read r; do
  echo "--- $r ---"
  kubectl -n "$NS" get --ignore-not-found "$r" -o name | head -3
done
```

A 405 or 403 on a particular type points at a CRD with restricted access; either grant `get`/`list` to the executing service account or remove that resource from the loop.

If the resulting archive is unexpectedly small for a long-lived namespace, container logs were probably truncated on a recent pod restart. Re-run the dump immediately after reproducing the problem and pin the relevant pods with `kubectl debug` if a longer collection window is needed.

If the customer cannot send the archive over their normal channel, attach it to a `ConfigMap` and let support pull it through the platform's existing log-export pipeline:

```bash
kubectl -n "$NS" create configmap nsdump-$(date +%s) \
  --from-file="$DEST"
```

This avoids out-of-band file transfer and preserves audit trail through the cluster's audit log.
