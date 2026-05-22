---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Import Kafka Resources Created From the Management View

:::info Applicable Versions
ACP 3.12.x.
:::

## Introduction

Older Kafka instances may have been created directly from the Strimzi management view. In ACP 3.12, the business view expects RDS-layer custom resources. Use the `rdskafka-sync` tool to generate RDS resources from existing Strimzi resources and import Kafka clusters, topics, and users into the business view.

The import updates the managed Kafka resources and can restart the Kafka instance. Run the check phase first and review the generated YAML before accepting the sync.

## Prerequisites

- Cluster administrator access to the target Kubernetes cluster.
- Existing Kafka resources created from the management view.
- Access to the `rdskafka-sync` image.
- A backup or rollback plan for the Kafka instance.

## Quick Upgrade Workflow

### 1. Check Import Readiness

For Docker-based environments:

```bash
docker run -it --rm \
  -v ~/.kube/config:/root/.kube/config \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  ./bin/check.sh
```

For containerd-based environments:

```bash
ctr run --rm \
  --mount type=bind,src=/root/.kube,dst=/root/.kube,options=rbind:rw \
  --net-host \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  sh ./bin/check.sh
```

`Ready` means the resources can be imported. `Not Ready` means at least one resource failed validation; review the output and fix the reported cause before continuing.

### 2. Run the Import

For Docker:

```bash
docker run -it --rm \
  -v ~/.kube/config:/root/.kube/config \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  ./bin/sync.sh
```

For containerd:

```bash
ctr run --rm \
  --mount type=bind,src=/root/.kube,dst=/root/.kube,options=rbind:rw \
  --net-host \
  build-harbor.alauda.cn/middleware/rdskafka-sync:1.0 \
  sh ./bin/sync.sh
```

If the command completes without errors, the imported resource names are printed. Contact operations if any resource fails to import.

## Using the CLI Directly

### Check Resources

```bash
./rdskafka-sync check cluster
./rdskafka-sync check cluster -n <namespace>
./rdskafka-sync check topic -n <namespace>
./rdskafka-sync check user -n <namespace>
```

The check output includes these fields:

| Field | Meaning |
| --- | --- |
| `NAMESPACE` | Namespace of the resource. |
| `RDSNAME` | RDS resource name. Empty means only the management-view resource exists and needs import. |
| `CLUSTERNAME` | Management-view Kafka resource name. |
| `VALIDATE` | Whether the resource passed import validation. Only `true` can be imported. |
| `REASON` | Validation failure reason. Empty when validation succeeds. |

### Sync Resources

```bash
./rdskafka-sync sync cluster <name> -n <namespace>
./rdskafka-sync sync topic <name> -n <namespace>
./rdskafka-sync sync user <name> -n <namespace>
./rdskafka-sync sync cluster -n <namespace>
./rdskafka-sync sync topic -n <namespace>
./rdskafka-sync sync user -n <namespace>
```

Force sync skips confirmation and must be used carefully:

```bash
./rdskafka-sync sync cluster <name> -n <namespace> -f
```

## Validation Rules

The tool validates whether resources can be safely imported. Common validation failures include:

- The Kafka instance does not use PVC-based storage.
- The resource is being deleted.
- The resource is not in a ready state.
- Kafka topic or cluster config values use non-string values such as booleans or integers. The RDS operator expects string config values.

Imported topics always include the required RDS config keys. If the management-view topic did not define them, default values are added:

```properties
retention.ms=604800000
max.message.bytes=1048576
```

## Important Considerations

- Importing a Kafka cluster can restart the Kafka instance.
- Review the generated RDS YAML and the resulting Strimzi YAML before confirming the operation.
- Convert config values to strings before import.
- Run the check command immediately before sync so the validation output matches the current cluster state.
