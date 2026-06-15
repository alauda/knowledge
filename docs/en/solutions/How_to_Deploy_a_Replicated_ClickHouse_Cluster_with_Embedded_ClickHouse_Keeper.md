---
kind:
   - How To
products:
   - Alauda Container Platform
   - Alauda Application Services
ProductsVersion:
   - 4.2.x
---
# How to Deploy a Replicated ClickHouse Cluster with Embedded ClickHouse Keeper

## Purpose

This document explains how to deploy a replicated ClickHouse cluster that uses ClickHouse Keeper instead of an external ZooKeeper ensemble, using the ClickHouse Operator on Alauda Container Platform. Keeper runs embedded inside each ClickHouse Pod, so no separate coordination workload needs to be deployed or operated.

This topology is well suited for log storage scenarios where a small replicated cluster and minimal operational footprint are the priority.

The procedure covers:

- Choosing a coordination topology (external ZooKeeper, standalone Keeper, or embedded Keeper).
- Deploying a `ClickHouseInstallation` with embedded Keeper.
- Verifying the Keeper quorum and table replication.
- Recommended ClickHouse settings for log storage workloads.

## Environment

- Alauda Container Platform 4.2 or later
- ClickHouse Operator shipped with the platform — the `clickhouse-operator` component (validated with image `clickhouse-operator:v4.2.3` on ACP 4.2)
- ClickHouse Server 23.x or later (ClickHouse Keeper is bundled in the server image; validated with 25.x)
- Cluster access via `kubectl`

## Resolution

### 1. Overview

Replicated tables (`ReplicatedMergeTree` family) and `ON CLUSTER` DDL in ClickHouse require a coordination service. ClickHouse Keeper is the ZooKeeper-compatible replacement implemented inside ClickHouse itself: it speaks the ZooKeeper client protocol, uses Raft instead of ZAB, and can run in the same process or Pod as the ClickHouse server.

Three topologies are possible on Kubernetes:

| Topology | Description | Trade-offs |
|----------|-------------|------------|
| External ZooKeeper | A separate ZooKeeper StatefulSet (3 nodes); the `ClickHouseInstallation` points at `zookeeper:2181` | Mature and battle-tested, but one more stateful workload to operate |
| Standalone Keeper | A separate ClickHouse Keeper StatefulSet (3 nodes); the `ClickHouseInstallation` points at `keeper:9181` | Resource isolation between Keeper and ClickHouse, but still two workloads, and the Keeper manifests are managed manually |
| Embedded Keeper (this document) | Every ClickHouse Pod also runs a Keeper Raft member; the `ClickHouseInstallation` points at its own Keeper Service | One workload only; Keeper shares Pod resources with ClickHouse and scaling of the two is coupled |

> **Note on operator-managed Keeper:** newer versions of the upstream Altinity operator introduce a `ClickHouseKeeperInstallation` (CHK) custom resource with its own controller. The ClickHouse Operator shipped with this platform version does not include that controller, and the CHK CRD is not installed — `kubectl api-resources --api-group=clickhouse-keeper.altinity.com` returns no resources. Keeper therefore cannot be deployed as an operator-managed CR; use the embedded topology described here (or a standalone StatefulSet) instead. The only Keeper-related field the operator consumes is `spec.configuration.zookeeper`, which works unchanged against Keeper because the client protocol is ZooKeeper-compatible.

How the embedded topology works:

- The cluster layout is 1 shard × 3 replicas, so the 3 ClickHouse Pods form a 3-member Keeper quorum (an odd member count that tolerates the loss of one node).
- A static `keeper_config.xml` fragment is injected into every shard through the `ClickHouseInstallation` `files` mechanism.
- The dynamic part of the Keeper configuration — `server_id` and the `raft_configuration` member list — depends on the Pod identity, so it is generated at Pod start by an init container and pulled in through `include_from`.
- A dedicated headless Service exposes the Keeper client port (9181), and `spec.configuration.zookeeper.nodes` points at that Service.

### 2. Prerequisites

| Item | Description | Example |
|------|-------------|---------|
| Namespace | Namespace for the ClickHouse cluster | `<namespace>` |
| ClickHouseInstallation name | Name of the CHI resource | `<chi-name>` |
| ClickHouse cluster name | Cluster name inside the CHI spec | `<cluster-name>` |
| ClickHouse image | Server image (Keeper is included) | `<clickhouse-image>` |
| StorageClass | StorageClass for data volumes | `<storage-class>` |
| Storage size | PVC size per replica | `<storage-size>` |

```bash
export NAMESPACE="<namespace>"
export CHI_NAME="<chi-name>"
export CLUSTER_NAME="<cluster-name>"
```

The ClickHouse Operator must already be installed and watching the target namespace.

### 3. Create the Keeper client Service

Replicas reach the Keeper quorum through a headless Service that selects all ready ClickHouse Pods of this installation. The `clickhouse.altinity.com/role: keeper` label is added to the Pods by the pod template in the next step.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: ${CHI_NAME}-keeper
  namespace: ${NAMESPACE}
spec:
  clusterIP: None
  type: ClusterIP
  ports:
    - name: keeper
      port: 9181
      protocol: TCP
      targetPort: 9181
  selector:
    clickhouse.altinity.com/chi: ${CHI_NAME}
    clickhouse.altinity.com/namespace: ${NAMESPACE}
    clickhouse.altinity.com/ready: "yes"
    clickhouse.altinity.com/role: keeper
```

### 4. Deploy the ClickHouseInstallation

The manifest below deploys 1 shard × 3 replicas with embedded Keeper. Key points are explained after the manifest.

```yaml
apiVersion: "clickhouse.altinity.com/v1"
kind: "ClickHouseInstallation"
metadata:
  name: ${CHI_NAME}
  namespace: ${NAMESPACE}
spec:
  configuration:
    zookeeper:
      nodes:
        - host: ${CHI_NAME}-keeper
          port: 9181
    clusters:
      - name: ${CLUSTER_NAME}
        templates:
          podTemplate: pod-template
          dataVolumeClaimTemplate: data-volumeclaim-template
        layout:
          shardsCount: 1
          replicasCount: 3
          shards:
            - files:
                keeper_config.xml: |
                  <clickhouse>
                      <include_from>/tmp/clickhouse/keeper_dynamic_configuration.xml</include_from>
                      <keeper_server incl="keeper_server">
                          <path>/var/lib/clickhouse-keeper</path>
                          <tcp_port>9181</tcp_port>
                          <four_letter_word_white_list>*</four_letter_word_white_list>
                          <coordination_settings>
                              <raft_logs_level>information</raft_logs_level>
                          </coordination_settings>
                      </keeper_server>
                  </clickhouse>
    settings:
      # Keep system tables bounded; without TTLs they grow indefinitely.
      asynchronous_metric_log/database: system
      asynchronous_metric_log/table: asynchronous_metric_log
      asynchronous_metric_log/ttl: "event_date + INTERVAL 7 DAY DELETE"
      metric_log/database: system
      metric_log/table: metric_log
      metric_log/ttl: "event_date + INTERVAL 7 DAY DELETE"
      trace_log/database: system
      trace_log/table: trace_log
      trace_log/ttl: "event_date + INTERVAL 7 DAY DELETE"
    profiles:
      default/max_execution_time: 120
      default/allow_unrestricted_reads_from_keeper: "1"
  defaults:
    templates:
      podTemplate: pod-template
      dataVolumeClaimTemplate: data-volumeclaim-template
  templates:
    podTemplates:
      - name: pod-template
        podDistribution:
          - scope: Shard
            topologyKey: kubernetes.io/hostname
            type: ShardAntiAffinity
        metadata:
          labels:
            clickhouse.altinity.com/role: keeper
        spec:
          containers:
            - name: clickhouse
              image: <clickhouse-image>
              env:
                - name: RAFT_PORT
                  value: "9444"
              ports:
                - name: http
                  containerPort: 8123
                - name: client
                  containerPort: 9000
                - name: interserver
                  containerPort: 9009
                - name: ch-keeper
                  containerPort: 9181
                - name: raft
                  containerPort: 9444
              volumeMounts:
                - name: data-volumeclaim-template
                  mountPath: /var/lib/clickhouse
                - name: keeper-dynamic-config
                  mountPath: /tmp/clickhouse
              readinessProbe:
                tcpSocket:
                  port: 9444
                initialDelaySeconds: 10
                timeoutSeconds: 5
                periodSeconds: 10
                failureThreshold: 3
          initContainers:
            - name: keeper-config-initializer
              image: <clickhouse-image>
              env:
                - name: RAFT_PORT
                  value: "9444"
                - name: SHARDS_COUNT
                  value: "1"
                - name: REPLICAS_COUNT
                  value: "3"
              command:
                - /bin/bash
                - -c
                - |
                  set -euo pipefail
                  OUT="/tmp/config/keeper_dynamic_configuration.xml"

                  HOST=$(hostname -s)
                  DOMAIN=$(hostname -d)
                  # StatefulSet Pod hostname: <chi>-<cluster>-<shard>-<replica>-<ordinal>
                  if [[ $HOST =~ (.*)-([0-9]+)-([0-9]+)-([0-9]+)$ ]]; then
                      SHARD=${BASH_REMATCH[2]}
                      REPLICA=${BASH_REMATCH[3]}
                  else
                      echo "Failed to parse shard/replica from hostname $HOST"; exit 1
                  fi
                  # Pod FQDN domain: <chi>-<cluster>-<shard>-<replica>.<namespace>.svc.<zone>
                  if [[ $DOMAIN =~ ^(.*)-([0-9]+)-([0-9]+)\.(.*)$ ]]; then
                      DOMAIN_NAME=${BASH_REMATCH[1]}
                      DOMAIN_SUFFIX=.${BASH_REMATCH[4]}
                  else
                      echo "Failed to parse domain $DOMAIN"; exit 1
                  fi

                  MY_ID=$((SHARD * REPLICAS_COUNT + REPLICA + 1))
                  KEEPER_ID=1
                  {
                    echo "<clickhouse>"
                    echo "  <keeper_server>"
                    echo "    <server_id>${MY_ID}</server_id>"
                    echo "    <raft_configuration>"
                    for (( i=0; i<SHARDS_COUNT; i++ )); do
                        for (( j=0; j<REPLICAS_COUNT; j++ )); do
                            echo "      <server>"
                            echo "        <id>${KEEPER_ID}</id>"
                            echo "        <hostname>${DOMAIN_NAME}-${i}-${j}${DOMAIN_SUFFIX}</hostname>"
                            echo "        <port>${RAFT_PORT}</port>"
                            echo "      </server>"
                            KEEPER_ID=$((KEEPER_ID + 1))
                        done
                    done
                    echo "    </raft_configuration>"
                    echo "  </keeper_server>"
                    echo "</clickhouse>"
                  } > "$OUT"
                  echo "Keeper dynamic configuration generated for server_id=${MY_ID}"
              volumeMounts:
                - name: keeper-dynamic-config
                  mountPath: /tmp/config
          volumes:
            - name: keeper-dynamic-config
              emptyDir:
                medium: Memory
    serviceTemplates:
      - name: replica-service-template
        spec:
          type: ClusterIP
          ports:
            - name: http
              port: 8123
            - name: tcp
              port: 9000
            - name: interserver
              port: 9009
            - name: clickhouse-keeper
              port: 9181
            - name: raft
              port: 9444
    volumeClaimTemplates:
      - name: data-volumeclaim-template
        spec:
          accessModes:
            - ReadWriteOnce
          storageClassName: <storage-class>
          resources:
            requests:
              storage: <storage-size>
```

Key points:

- **Quorum and layout.** `shardsCount: 1` and `replicasCount: 3` produce 3 Pods, each a Keeper Raft member. Keep an odd member count; 3 members tolerate one failure. If you add shards, every replica of every shard joins the quorum, and the `server_id` formula `SHARD * REPLICAS_COUNT + REPLICA + 1` stays unique as long as `REPLICAS_COUNT` in the init container matches the real layout.
- **Static vs dynamic Keeper config.** The static part (`tcp_port`, data `path`, coordination settings) is injected per shard through `layout.shards[].files`. The identity-dependent part (`server_id`, `raft_configuration`) is generated by the init container into an in-memory `emptyDir` and merged via `include_from`. Replica changes therefore require only updating `REPLICAS_COUNT`, not editing the static fragment.
- **Coordination endpoint.** `spec.configuration.zookeeper.nodes` points at the Keeper Service on port 9181. The operator renders this into the server `zookeeper` configuration; ClickHouse does not need to know whether the backend is ZooKeeper or Keeper.
- **Anti-affinity.** `ShardAntiAffinity` on `kubernetes.io/hostname` spreads the replicas (and therefore the Keeper members) across nodes, so a single node failure cannot break the quorum.
- **Readiness.** The readiness probe checks the Raft port (9444), so a Pod only becomes ready after its Keeper member is up.
- **Per-replica Service ports.** The replica Service template exposes 9181 and 9444 in addition to the ClickHouse ports, so quorum members can reach each other through their per-replica DNS names.

Apply the manifests:

```bash
kubectl apply -n "$NAMESPACE" -f keeper-service.yaml
kubectl apply -n "$NAMESPACE" -f chi.yaml
```

### 5. Verify the Keeper quorum

Wait until the CHI reaches `Completed`:

```bash
kubectl -n "$NAMESPACE" get clickhouseinstallation "$CHI_NAME" -w
```

Check the quorum with the `mntr` four-letter command on any Pod (this is why `four_letter_word_white_list` is enabled):

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  bash -c 'exec 3<>/dev/tcp/localhost/9181; printf mntr >&3; cat <&3' | egrep 'zk_server_state|zk_synced_followers'
```

Expected output: one Pod reports `zk_server_state  leader` with `zk_synced_followers  2`; the other two report `follower`.

Confirm ClickHouse can reach the coordination service:

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "SELECT * FROM system.zookeeper WHERE path = '/'"
```

### 6. Verify replication

Create a replicated table across the cluster, write on one replica, and read on another:

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- clickhouse-client -q "
CREATE TABLE default.keeper_smoke ON CLUSTER '${CLUSTER_NAME}'
(ts DateTime, msg String)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{cluster}/{shard}/default/keeper_smoke', '{replica}')
ORDER BY ts"

kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "INSERT INTO default.keeper_smoke VALUES (now(), 'hello')"

kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-1-0 -c clickhouse -- \
  clickhouse-client -q "SELECT count() FROM default.keeper_smoke"
```

The count on the second replica must be `1`. Also confirm replica health:

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "SELECT database, table, is_readonly, absolute_delay FROM system.replicas"
```

`is_readonly` must be `0` and `absolute_delay` close to `0`. Clean up the smoke-test table afterwards:

```bash
kubectl -n "$NAMESPACE" exec chi-${CHI_NAME}-${CLUSTER_NAME}-0-0-0 -c clickhouse -- \
  clickhouse-client -q "DROP TABLE default.keeper_smoke ON CLUSTER '${CLUSTER_NAME}' SYNC"
```

### 7. Recommended settings for log storage workloads

The manifest above already includes the settings that matter most for log storage. Rationale and additional options:

| Setting | Recommendation | Why |
|---------|----------------|-----|
| `asynchronous_metric_log/ttl`, `metric_log/ttl`, `trace_log/ttl` | 7-day `DELETE` TTL | Self-observability system tables grow indefinitely by default and will eventually fill the data volume |
| `default/max_execution_time` | 120 seconds | Prevents a single slow query from starving ingestion on a small cluster |
| `default/allow_unrestricted_reads_from_keeper` | `1` (optional) | Allows broad `system.zookeeper` reads for troubleshooting; low risk |
| `default/max_parallel_replicas` | Match replica count (optional) | Can accelerate reads on a single-shard, multi-replica layout |
| Table TTLs on log tables | Per-category retention (e.g. `event_date + INTERVAL 7 DAY DELETE`) | Retention is the primary capacity control for log data |
| Quotas (`interval/duration`, `interval/queries`) | Optional guardrail | Caps runaway query volume per user |

Constraints and trade-offs of the embedded topology:

- Keeper shares CPU, memory, and disk I/O with the ClickHouse server. Size the Pod resources for both, and keep the Keeper data path (`/var/lib/clickhouse-keeper`) on the same persistent volume.
- Replica count and quorum size are coupled. Do not scale replicas to an even number or below 3, and keep `REPLICAS_COUNT` in the init container in sync with the layout.
- Rolling restarts restart Keeper members together with ClickHouse. The default `maxUnavailable` behavior of the operator (one host at a time) keeps the quorum alive; do not force parallel restarts.

If you need Keeper and ClickHouse to scale independently, or you run many ClickHouse installations against a shared coordination service, deploy a standalone 3-node Keeper (or ZooKeeper) StatefulSet instead and point `spec.configuration.zookeeper.nodes` at it; everything else in this document stays the same.
