---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.3.3
weight: 10
queries:
  - "How do I remove a stale region AppRelease after upgrading ACP from 4.0 to 4.3?"
  - "ACP 4.3.3 region AppRelease cleanup"
  - "helm.sh/resource-policy keep region AppRelease"
---

# ACP 4.0 to 4.3 Upgrade Leaves the region AppRelease Behind (S2 Solution)

## Issue

After upgrading Alauda Container Platform (ACP) from 4.0 to 4.3, the upgrade workflow can leave the historical `cpaas-system/region` AppRelease in the cluster. The AppRelease contains both resources that the upgraded platform still needs and resources that are no longer required. Deleting the AppRelease without protecting the required resources can therefore remove platform resources that must remain available.

This issue applies through ACP 4.3.3. ACP 4.3.4 and later include the fix and do not require this cleanup procedure.

## Environment

- Upgrade path: ACP 4.0 to ACP 4.3.
- Affected target versions: ACP 4.3.0 through 4.3.3.
- Fixed target version: ACP 4.3.4 and later.
- The upgrade has completed and the `cpaas-system/base` AppRelease is healthy.
- The residual AppRelease is named `region` in the `cpaas-system` namespace.

## Resolution

The resolution has four phases:

1. Use the helper script to inspect the resource inventory.
2. Add `helm.sh/resource-policy=keep` to the 11 resources that must remain.
3. Manually delete the `region` AppRelease and confirm that it is gone.
4. Remove the temporary `keep` annotation from the retained resources.

The helper script manages annotations and performs read-only checks. It does not delete the AppRelease. The AppRelease deletion must remain an explicit, manually reviewed operation.

:::danger
Deleting `cpaas-system/region` is an irreversible cluster operation. Do not continue if the `base` AppRelease is not healthy, if a protected resource is missing, or if the `region` AppRelease is already being deleted.
:::

### Prerequisites

Prepare the following items before starting:

- A kubeconfig that can connect to the target `global` cluster.
- `kubectl` and Bash on the execution host.
- Cluster-administrator permissions to read and annotate the listed resources and to delete an AppRelease.
- The helper script saved as `region-apprelease-keep-helper.sh` in the current directory.

Run the helper script from the directory where you saved it. Set `KUBECTL` if the cluster uses a non-default `kubectl` command.

### Resources to Retain

The following 11 resources must remain after the `region` AppRelease is deleted:

| Kind | Namespace | Name |
| --- | --- | --- |
| `Namespace` | - | `argocd` |
| `Namespace` | - | `data-services-system` |
| `Namespace` | - | `kubevirt` |
| `Namespace` | - | `metallb-system` |
| `Namespace` | - | `minio-system` |
| `Namespace` | - | `nativestor-system` |
| `Namespace` | - | `rook-ceph` |
| `ConfigMap` | `cpaas-system` | `etcd-backup` |
| `ConfigMap` | `kube-public` | `global-info` |
| `AdvancedCronJob` | `cpaas-system` | `etcd-backup-default` |
| `ClusterAlaudaFeatureGate` | - | `loadbalancer-service` |

The `frontend`, `zeus`, Ingress, ServiceAccount, and RBAC resources are not in the retention set. The `alauda-cluster-base-jobs` ServiceAccount, ClusterRole, and ClusterRoleBinding are used by the upgrade hook Job and are not runtime dependencies of `etcd-backup-default`. Retaining them leaves unnecessary high-privilege RBAC in the cluster.

### Helper Script

Save the following script as `region-apprelease-keep-helper.sh` and make it executable. The inventory is derived from the `region` AppRelease in `alauda-cluster-base v4.0.23`; do not reuse it for another upgrade path or version.

```bash
#!/usr/bin/env bash

set -euo pipefail

KUBECTL=${KUBECTL:-kubectl}
KEEP_KEY=helm.sh/resource-policy

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

die() {
  log "ERROR: $*"
  return 1
}

require_kubectl() {
  command -v "$KUBECTL" >/dev/null 2>&1 ||
    die "required command not found: $KUBECTL"
}

# Resource list captured from the region AppRelease (alauda-cluster-base v4.0.23).
# Fields: action|kind|namespace|name. A dash means cluster-scoped.
region_resources() {
  cat <<'EOF'
protect|Namespace|-|argocd
protect|Namespace|-|data-services-system
protect|Namespace|-|kubevirt
protect|Namespace|-|metallb-system
protect|Namespace|-|minio-system
protect|Namespace|-|nativestor-system
protect|Namespace|-|rook-ceph
delete|ServiceAccount|cpaas-system|zeus
delete|ServiceAccount|cpaas-system|frontend
delete|ServiceAccount|cpaas-system|operator-migration
delete|ConfigMap|cpaas-system|global-values
protect|ConfigMap|cpaas-system|etcd-backup
protect|ConfigMap|kube-public|global-info
delete|ConfigMap|cpaas-system|image-loader
delete|ConfigMap|cpaas-system|update-containerd-config
delete|ConfigMap|cpaas-system|upgrade-sysctl
delete|ClusterRole|-|zeus
delete|ClusterRole|-|cpaas:frontend
delete|ClusterRole|-|operator-migration
delete|ClusterRoleBinding|-|cpass:zeus
delete|ClusterRoleBinding|-|cpaas:frontend
delete|ClusterRoleBinding|-|operator-migration
delete|Role|cpaas-system|cpaas:frontend
delete|RoleBinding|cpaas-system|cpaas:frontend
delete|Service|cpaas-system|zeus
delete|Service|cpaas-system|frontend
delete|DaemonSet|cpaas-system|zeus
delete|Deployment|cpaas-system|frontend
delete|Ingress|cpaas-system|console-plugins-ingress
delete|Ingress|cpaas-system|machine-provider-ingress
protect|AdvancedCronJob|cpaas-system|etcd-backup-default
delete|Certificate|cpaas-system|cpaas-system
protect|ClusterAlaudaFeatureGate|-|loadbalancer-service
delete|ServiceAccount|cpaas-system|alauda-cluster-base-jobs
delete|ClusterRole|-|cpaas:alauda-cluster-base-jobs
delete|ClusterRoleBinding|-|cpaas:alauda-cluster-base-jobs
delete|Job|cpaas-system|remove-psp
delete|Job|cpaas-system|patch-etcd-backup-annotation
delete|Job|cpaas-system|update-etcd-backup
delete|Job|cpaas-system|update-storage-ns
delete|BroadcastJob|cpaas-system|update-containerd-config
delete|BroadcastJob|cpaas-system|upgrade-sysctl
EOF
}

ordered_resources() {
  region_resources | awk -F'|' '
    $1 == "protect" { protected[++protect_count] = $0; next }
    { removable[++remove_count] = $0 }
    END {
      for (i = 1; i <= protect_count; i++) print protected[i]
      for (i = 1; i <= remove_count; i++) print removable[i]
    }
  '
}

format_table() {
  awk -F'\t' '
    {
      rows[NR] = $0
      columns = NF
      for (i = 1; i <= NF; i++)
        if (length($i) > width[i]) width[i] = length($i)
    }
    END {
      for (row = 1; row <= NR; row++) {
        split(rows[row], values, FS)
        for (column = 1; column < columns; column++)
          printf "%-*s  ", width[column], values[column]
        print values[columns]
      }
    }
  '
}

kubectl_get() {
  local kind=$1 namespace=$2 name=$3 output=$4
  if [[ "$namespace" == "-" ]]; then
    "$KUBECTL" get "$kind" "$name" --ignore-not-found -o "$output"
  else
    "$KUBECTL" -n "$namespace" get "$kind" "$name" --ignore-not-found -o "$output"
  fi
}

object_state() {
  local output
  output=$(kubectl_get "$1" "$2" "$3" \
    'jsonpath={.metadata.name}{"|"}{.metadata.annotations.helm\.sh/resource-policy}')
  if [[ -z "$output" ]]; then
    printf 'no|\n'
  else
    printf 'yes|%s\n' "${output#*|}"
  fi
}

annotate_resource() {
  local kind=$1 namespace=$2 name=$3 operation=$4 annotation
  if [[ "$operation" == "keep" ]]; then
    annotation="$KEEP_KEY=keep"
  else
    annotation="$KEEP_KEY-"
  fi

  if [[ "$namespace" == "-" ]]; then
    "$KUBECTL" annotate "$kind" "$name" "$annotation" --overwrite >/dev/null
  else
    "$KUBECTL" -n "$namespace" annotate "$kind" "$name" \
      "$annotation" --overwrite >/dev/null
  fi
}

apply_inventory() {
  local mode=$1 action kind namespace name state exists value changed=0 operation
  local total
  total=$(region_resources | wc -l)
  log "$mode: checking $total region resources"
  while IFS='|' read -r action kind namespace name; do
    state=$(object_state "$kind" "$namespace" "$name")
    exists=${state%%|*}
    value=${state#*|}
    [[ "$exists" == "yes" ]] || continue

    if [[ "$mode" == "keep" ]]; then
      if [[ "$action" == "protect" && "$value" != "keep" ]]; then
        operation=keep
      elif [[ "$action" == "delete" && "$value" == "keep" ]]; then
        operation=remove
      else
        continue
      fi
    elif [[ "$action" == "protect" && "$value" == "keep" ]]; then
      operation=remove
    else
      continue
    fi
    log "$mode: $operation $kind/$namespace/$name"
    annotate_resource "$kind" "$namespace" "$name" "$operation"
    changed=$((changed + 1))
  done < <(ordered_resources)
  log "$mode updated $changed resources"
}

keep_phase() {
  require_kubectl
  apply_inventory keep
}

check_phase() {
  require_kubectl
  {
    printf 'ACTION\tKIND\tNAMESPACE\tNAME\tEXISTS\tKEEP\n'
    local action kind namespace name state exists value keep
    while IFS='|' read -r action kind namespace name; do
      state=$(object_state "$kind" "$namespace" "$name")
      exists=${state%%|*}
      value=${state#*|}
      if [[ "$exists" == "no" ]]; then
        keep=-
      elif [[ "$value" == "keep" ]]; then
        keep=yes
      else
        keep=no
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$action" "$kind" "$namespace" "$name" "$exists" "$keep"
    done < <(ordered_resources)
  } | format_table
}

unkeep_phase() {
  require_kubectl
  apply_inventory unkeep
}

usage() {
  cat >&2 <<EOF
Usage:
  $0 keep
  $0 check
  $0 unkeep
EOF
}

main() {
  [[ $# -eq 1 ]] || { usage; return 2; }
  case "$1" in
    keep) keep_phase ;;
    check) check_phase ;;
    unkeep) unkeep_phase ;;
    *) usage; return 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
```

### 1. Prepare the Script and Confirm the Inventory

Make the script executable and confirm that the `base` and `region` AppReleases exist:

```bash
chmod +x ./region-apprelease-keep-helper.sh
kubectl -n cpaas-system get apprelease base region
./region-apprelease-keep-helper.sh check
```

The `check` command lists all 42 resources. Protected resources appear first and each row reports whether the object exists and whether its `helm.sh/resource-policy` annotation is `keep`.

Confirm that `base` is healthy and `region` exists. Stop if any protected resource is missing.

### 2. Add Protection and Recheck

Add the temporary annotation and inspect the result:

```bash
./region-apprelease-keep-helper.sh keep
./region-apprelease-keep-helper.sh check
```

For every existing protected resource, confirm `EXISTS=yes` and `KEEP=yes`. Existing resources marked for deletion must show `KEEP=no`; the script removes an unexpected `keep` annotation from those resources.

### 3. Delete the `region` AppRelease Manually

After the protected-resource check passes, delete the AppRelease explicitly:

```bash
kubectl -n cpaas-system delete apprelease region
kubectl -n cpaas-system get apprelease region
```

The second command must return `NotFound`. Do not run `unkeep` while deletion is still in progress or if any protected resource is not healthy.

### 4. Remove the Temporary Protection and Recheck

Confirm that the retained resources survived the deletion, then remove the temporary annotations:

```bash
./region-apprelease-keep-helper.sh check
./region-apprelease-keep-helper.sh unkeep
./region-apprelease-keep-helper.sh check
```

Before `unkeep`, the 11 protected resources must still show `EXISTS=yes` and `KEEP=yes`. After `unkeep`, they must still exist and show `KEEP=no`.

## Exception Handling

- If AppRelease deletion fails or remains in progress, keep the annotations and investigate the deletion before continuing.
- If any protected resource is missing or abnormal, stop and determine why before deleting the AppRelease or removing annotations.
- The `keep`, `check`, and `unkeep` operations are repeatable. The script changes only resources in its inventory.
- The inventory is specific to the `region` AppRelease from `alauda-cluster-base v4.0.23`. Do not use it for another upgrade path or version.

## Acceptance Criteria

The cleanup is complete when all of the following conditions hold:

- `cpaas-system/region` no longer exists.
- All 11 protected resources still exist and no longer have `helm.sh/resource-policy=keep`.
- The `frontend`, `zeus`, Ingress, and region hook ServiceAccount/RBAC resources have been removed with the `region` AppRelease.
- `cpaas-system/etcd-backup-default` and `cpaas-system/etcd-backup` still exist.
