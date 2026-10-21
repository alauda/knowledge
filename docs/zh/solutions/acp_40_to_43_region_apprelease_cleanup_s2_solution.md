---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - 4.3.3
weight: 10
queries:
  - >-
    How do I remove a stale region AppRelease after upgrading ACP from 4.0 to
    4.3?
  - ACP 4.3.3 region AppRelease cleanup
  - helm.sh/resource-policy keep region AppRelease
id: KB261000033
sourceSHA: 5d061893e21ed91898b6a1481eb5cd6b08a8c15595e6bc3f127bca280980becb
---

# 在将 ACP 从 4.0 升级到 4.3 后删除残留的区域 AppRelease

## 问题

在将 Alauda Container Platform (ACP) 从 4.0 升级到 4.3 后，升级工作流可能会在集群中留下历史的 `cpaas-system/region` AppRelease。该 AppRelease 包含了升级后的平台仍然需要的资源和不再需要的资源。因此，在没有保护所需资源的情况下删除 AppRelease 可能会移除必须保留的平台资源。

此问题适用于 ACP 4.3.3。ACP 4.3.4 及更高版本包含修复，不需要此清理操作。

## 环境

- 升级路径：ACP 4.0 到 ACP 4.3。
- 受影响的目标版本：ACP 4.3.0 到 4.3.3。
- 修复的目标版本：ACP 4.3.4 及更高版本。
- 升级已完成，且 `cpaas-system/base` AppRelease 健康。
- 残留的 AppRelease 名为 `region`，位于 `cpaas-system` 命名空间中。

## 解决方案

解决方案分为四个阶段：

1. 使用辅助脚本检查资源清单。
2. 将 `helm.sh/resource-policy=keep` 添加到必须保留的 11 个资源中。
3. 手动删除 `region` AppRelease，并确认其已被删除。
4. 从保留的资源中移除临时的 `keep` 注释。

辅助脚本管理注释并执行只读检查。它不会删除 AppRelease。AppRelease 的删除必须是一个明确的、经过人工审核的操作。

:::danger
删除 `cpaas-system/region` 是不可逆的集群操作。如果 `base` AppRelease 不健康、受保护的资源缺失，或 `region` AppRelease 已在删除中，请勿继续。
:::

### 先决条件

在开始之前准备以下项目：

- 一个可以连接到目标 `global` 集群的 kubeconfig。
- 执行主机上安装有 `kubectl` 和 Bash。
- 具有读取和注释列出资源的权限，以及删除 AppRelease 的集群管理员权限。
- 将辅助脚本保存为 `region-apprelease-keep-helper.sh`，并放在当前目录中。

从保存脚本的目录运行辅助脚本。如果集群使用非默认的 `kubectl` 命令，请设置 `KUBECTL`。

### 要保留的资源

在删除 `region` AppRelease 后，以下 11 个资源必须保留：

| 类型                       | 命名空间      | 名称                   |
| -------------------------- | -------------- | ---------------------- |
| `Namespace`                | -              | `argocd`               |
| `Namespace`                | -              | `data-services-system` |
| `Namespace`                | -              | `kubevirt`             |
| `Namespace`                | -              | `metallb-system`       |
| `Namespace`                | -              | `minio-system`         |
| `Namespace`                | -              | `nativestor-system`    |
| `Namespace`                | -              | `rook-ceph`            |
| `ConfigMap`                | `cpaas-system` | `etcd-backup`          |
| `ConfigMap`                | `kube-public`  | `global-info`          |
| `AdvancedCronJob`          | `cpaas-system` | `etcd-backup-default`  |
| `ClusterAlaudaFeatureGate` | -              | `loadbalancer-service` |

`frontend`、`zeus`、Ingress、ServiceAccount 和 RBAC 资源不在保留集合中。`alauda-cluster-base-jobs` ServiceAccount、ClusterRole 和 ClusterRoleBinding 由升级挂钩 Job 使用，并不是 `etcd-backup-default` 的运行时依赖。保留它们会在集群中留下不必要的高权限 RBAC。

### 辅助脚本

将以下脚本保存为 `region-apprelease-keep-helper.sh` 并使其可执行。清单源自 `alauda-cluster-base v4.0.23` 中的 `region` AppRelease；请勿将其用于其他升级路径或版本。

```bash
#!/usr/bin/env bash

set -euo pipefail

KUBECTL=${KUBECTL:-kubectl}
KEEP_KEY=helm.sh/resource-policy

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

die() {
  log "错误: $*"
  return 1
}

require_kubectl() {
  command -v "$KUBECTL" >/dev/null 2>&1 ||
    die "未找到所需命令: $KUBECTL"
}

# 从区域 AppRelease (alauda-cluster-base v4.0.23) 捕获的资源列表。
# 字段: action|kind|namespace|name。破折号表示集群范围。
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
  log "$mode: 正在检查 $total 区域资源"
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
  log "$mode 更新了 $changed 个资源"
}

keep_phase() {
  require_kubectl
  apply_inventory keep
}

check_phase() {
  require_kubectl
  {
    printf '操作\t类型\t命名空间\t名称\t存在\t保留\n'
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
用法：
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

### 1. 准备脚本并确认清单

使脚本可执行并确认 `base` 和 `region` AppRelease 存在：

```bash
chmod +x ./region-apprelease-keep-helper.sh
kubectl -n cpaas-system get apprelease base region
./region-apprelease-keep-helper.sh check
```

`check` 命令列出所有 42 个资源。受保护的资源首先出现，每一行报告对象是否存在及其 `helm.sh/resource-policy` 注释是否为 `keep`。

确认 `base` 健康且 `region` 存在。如果任何受保护的资源缺失，请停止。

### 2. 添加保护并重新检查

添加临时注释并检查结果：

```bash
./region-apprelease-keep-helper.sh keep
./region-apprelease-keep-helper.sh check
```

对于每个现有的受保护资源，确认 `EXISTS=yes` 和 `KEEP=yes`。标记为删除的现有资源必须显示 `KEEP=no`；脚本会从这些资源中移除意外的 `keep` 注释。

### 3. 手动删除 `region` AppRelease

在受保护资源检查通过后，显式删除 AppRelease：

```bash
kubectl -n cpaas-system delete apprelease region
kubectl -n cpaas-system get apprelease region
```

第二个命令必须返回 `NotFound`。在删除仍在进行中或任何受保护资源不健康时，请勿运行 `unkeep`。

### 4. 移除临时保护并重新检查

确认保留的资源在删除后仍然存在，然后移除临时注释：

```bash
./region-apprelease-keep-helper.sh check
./region-apprelease-keep-helper.sh unkeep
./region-apprelease-keep-helper.sh check
```

在 `unkeep` 之前，11 个受保护资源必须仍显示 `EXISTS=yes` 和 `KEEP=yes`。在 `unkeep` 之后，它们必须仍然存在并显示 `KEEP=no`。

## 异常处理

- 如果 AppRelease 删除失败或仍在进行中，请保留注释并调查删除情况，然后再继续。
- 如果任何受保护资源缺失或异常，请停止并确定原因，然后再删除 AppRelease 或移除注释。
- `keep`、`check` 和 `unkeep` 操作是可重复的。脚本仅更改其清单中的资源。
- 清单特定于 `alauda-cluster-base v4.0.23` 的 `region` AppRelease。请勿将其用于其他升级路径或版本。

## 验收标准

当以下所有条件成立时，清理工作完成：

- `cpaas-system/region` 不再存在。
- 所有 11 个受保护资源仍然存在，并且不再具有 `helm.sh/resource-policy=keep`。
- `frontend`、`zeus`、Ingress 和区域挂钩 ServiceAccount/RBAC 资源已随 `region` AppRelease 被移除。
- `cpaas-system/etcd-backup-default` 和 `cpaas-system/etcd-backup` 仍然存在。
