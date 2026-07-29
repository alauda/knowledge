---
products:
  - Alauda Application Services
kind:
  - Solutions
---

# Redis Cluster and Sentinel Performance Testing Guide

## Purpose and scope

This guide defines a reproducible, customer-executable method for measuring Redis data-plane throughput, latency, and resource use on Kubernetes. It covers:

- **Redis Cluster mode**: three or more primary shards, optionally with replicas. The load generator must use `redis-benchmark --cluster` so requests reach all hash slots.
- **Redis Sentinel mode**: one writable primary with replicas and Sentinel processes. Benchmark the read-write data Service on port `6379`, not the Sentinel Service on port `26379`.

Run this procedure only against a dedicated test instance. It issues writes and can consume all assigned CPU, memory, network, and storage bandwidth. It does not test failover; run failover as a separate workload because a topology change invalidates a steady-state throughput result.

There is no hardware-independent "best" result. Define the workload, durability policy, topology, and latency objective before testing. Compare only runs in which these inputs are identical, as required by the [Redis benchmarking guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/).

Use one of two access-path profiles and never merge their results:

- **In-cluster capacity profile (recommended)**: run the load Pod in the Redis cluster and connect through the ClusterIP Service. This follows the current Redis Operator suite and removes external load-balancer/wide area network (WAN) capacity from the Redis result.
- **External end-to-end profile**: run the same open-source client image from the customer-selected source cluster or host through NodePort or LoadBalancer. This follows the cross-cluster capability of the earlier validation suite. Record the client location, access type, round-trip latency, packet loss, and every network hop. For Cluster mode, every node address announced by Cluster discovery must be reachable from the load generator; reaching only the seed endpoint is insufficient.

## Test design

Use the following workload matrix for both Cluster and Sentinel.

Redis Database (RDB) persistence, Append Only File (AOF) persistence, and a non-persistent cache are the three profiles. Select a product parameter template first, keep it unchanged for the baseline run, and then change only one tuning axis at a time. The value-size, pipeline, command, and keyspace rows reproduce the Redis Operator performance suite and earlier validation cases.

| Axis | Standard values | Purpose |
|---|---|---|
| Parameter template | RDB persistence; AOF persistence; no persistence (cache) | Quantifies durability and replication cost separately using shipped product baselines |
| Value size (`-d`) | `512` bytes; `4096` bytes (4 KiB) | Matches the latest performance e2e matrix for small and medium values |
| Pipeline (`-P`) | `1`, `16` | `1` measures non-pipelined behavior; `16` measures a throughput-oriented workload |
| Commands (`-t`) | `set,get` | Produces separate write and read results |
| Random keyspace (`-r`) | `100000` | Avoids benchmarking a single hot key |
| Redis I/O threads | Selected-template baseline (`io-threads=4`, threaded reads disabled), followed by a CPU-specific sweep | Quantifies socket I/O and protocol-processing scalability without mixing it with other tuning |

### Select a product parameter template

This procedure uses the shipped Redis 7.2 templates as its only parameter baseline. In the Redis create form, choose Redis 7.2 and the topology first. Under **Parameter Templates** in the English interface or **参数模板** in the Chinese interface, select the exact identifier that matches both. The identifier displayed in the selector is `metadata.name` and is the same in both languages; only the description is localized. The bilingual profile names below describe the intent and are not alternative resource names.

| Profile name (中文 / English) | Redis 7.2 Sentinel | Redis 7.2 Cluster |
|---|---|---|
| RDB 持久化 / RDB persistence | `system-rdb-redis-7.2-sentinel` | `system-rdb-redis-7.2-cluster` |
| 无持久化（缓存） / No persistence (cache) | `system-diskless-redis-7.2-sentinel` | `system-diskless-redis-7.2-cluster` |
| AOF 持久化 / AOF persistence | `system-aof-redis-7.2-sentinel` | `system-aof-redis-7.2-cluster` |

The product selects the corresponding RDB template by default. Select the AOF or no-persistence template explicitly when that is the intended scenario. Some package revisions contain `RBD` in the localized RDB description; this is a description typo. Use the `...rdb...` identifier shown above. This guide uses the canonical term **RDB**.

The shipped Redis 7.2 templates establish these test baselines:

| Profile | Effective persistence settings | Intended use |
|---|---|---|
| RDB persistence | `appendonly=no`; `save="60 10000 300 100 600 1"` | Snapshot-based persistence; possible data loss since the last completed snapshot |
| AOF persistence | `appendonly=yes`; `appendfsync=everysec`; `save=""` | AOF durability/throughput balance |
| No persistence (cache) | `appendonly=no`; `save=""`; `repl-diskless-sync=yes`; `repl-backlog-size=50mb` | Cache workloads that can tolerate data loss |

All listed templates leave `maxmemory` unset and set `maxmemory-policy=noeviction`, `repl-diskless-sync=yes`, `io-threads=4`, and `io-threads-do-reads=no`. With this combination, the Operator generates `maxmemory` as 80% of the Redis data container's memory limit. This is Operator behavior, not the native Redis default. Because installed package revisions can differ, export the installed template and verify the effective configuration rather than reproducing these values manually.

For Sentinel topology, template selection also supplies Sentinel-process parameters. Keep them unchanged during a data-plane throughput comparison; Sentinel processes do not serve the benchmark traffic, and failover testing is outside this steady-state procedure.

The no-persistence profile is not "diskless persistence": it disables local persistence and uses diskless synchronization only for replication. Use it only when the application can tolerate data loss. Redis documents the durability and performance trade-offs of RDB, AOF, and no persistence in [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

List and export the installed templates before testing. Discover the namespace instead of assuming one:

```bash
kubectl get paramtemplate.middleware.alauda.io -A \
  -l component=redis,support_version=7.2

TEMPLATE_NS=replace-with-template-namespace
TEMPLATE=system-rdb-redis-7.2-cluster
kubectl -n "${TEMPLATE_NS}" get paramtemplate.middleware.alauda.io \
  "${TEMPLATE}" -o yaml > "paramtemplate-${TEMPLATE}.yaml"
```

### Other Redis versions

Template identifiers, supported parameters, defaults, persistence behavior, and apply strategies can differ by Redis and product package version. For any version other than 7.2, select a template whose labels match that exact version and topology, export the installed `ParamTemplate`, and build a separately named test matrix from its effective values. Do not reuse the Redis 7.2 identifiers or assume that its resource, storage, persistence, or I/O-thread defaults apply.

## Prerequisites

Prepare the following before the test window:

- A Kubernetes cluster with the Redis Operator installed and a qualified `StorageClass` for RDB and AOF profiles.
- The Redis 7.2 system `ParamTemplate` resources installed for the topology under test.
- A namespace dedicated to the test, for example `redis-perf`.
- Product-console permission to create Redis instances and select parameter templates, plus `kubectl` access that can create the load Pod and read Redis resources and metrics. Install `jq` for producing allowlisted evidence exports.
- A Redis password Secret with key `password`. Reuse the instance Secret or create it from a protected file; never place the password in a manifest or report:

  ```bash
  kubectl -n redis-perf create secret generic redis-perf-auth \
    --from-file=password=/secure/path/redis-password
  ```

  The protected file must contain only the password bytes, without an unintended trailing newline. The current Redis admission policy requires 8-32 allowed characters and rejects passwords that do not include letters, digits, and a special character. Confirm the installed rule with `kubectl explain redis.spec.passwordSecret --api-version=middleware.alauda.io/v1` because package revisions can differ.

  Use a distinct password Secret for each fresh Redis instance. The current Operator can attach the supplied Secret to an instance-owned `RedisUser`; deleting the instance then removes that Secret through Kubernetes ownership. Before creating the next matrix instance, create its new Secret and recreate the load-generator Pod so its projected volume references the new name. Do not assume that a Secret shared with a deleted instance will remain available.

- An approved [Redis Docker Official Image](https://hub.docker.com/_/redis/) containing `redis-benchmark` and `redis-cli`. Match the server major/minor version where practical, mirror the exact image into the customer registry for an air-gapped cluster, and record its immutable digest. Do not use an Alauda-internal load-generator image.
- Metrics Server for sampled Pod CPU/memory, or Prometheus for time-series CPU, memory, network, storage, and Redis exporter metrics.

Before applying examples, confirm the installed schema with:

```bash
kubectl explain redis.spec --api-version=middleware.alauda.io/v1
```

### Qualify the StorageClass

Use one of these storage profiles and report it explicitly:

- **Performance-ceiling profile**: prefer low-latency local block storage backed by dedicated SSD or NVMe media. An installed TopoLVM-backed class such as `sc-topolvm` is a suitable candidate, but the name alone is not a performance guarantee: [TopoLVM](https://github.com/topolvm/topolvm) provisions local Logical Volume Manager (LVM) volumes, so verify its device class and physical media. For topology-constrained local storage, use `volumeBindingMode: WaitForFirstConsumer` so volume provisioning follows Pod scheduling constraints, as described in [Kubernetes Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/). Because local volumes are tied to nodes, this profile does not prove cross-node recovery behavior; test recovery separately with the intended production storage.
- **Production-representative profile**: use the exact production `StorageClass`, even when it is slower, and report the result as end-to-end production storage performance rather than the Redis ceiling. Never compare this result directly with the local-block profile.

Do not use Network File System (NFS), other network-attached storage, or CephFS for the performance-ceiling profile. Redis explicitly warns against placing RDB or AOF files on NFS or network-attached storage because the storage path can add uncontrolled network latency and bandwidth contention. Do not group all Ceph storage under the same rule: Ceph block storage is distributed block storage rather than a shared file system. Its network, replication, recovery, and quality-of-service settings can still dominate latency, so use Ceph block storage only for the production-representative profile or after storage qualification demonstrates sufficient headroom. See [Redis benchmark factors](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/) and [Ceph architecture](https://docs.ceph.com/en/latest/architecture/).

Before deploying Redis, qualify a disposable volume with the same `StorageClass`, capacity, filesystem, and node type. Record 4 KiB random-write operation rate, sequential write throughput, and synchronous-write latency percentiles. There is no universal pass threshold: the volume must meet the customer's storage service objective and retain headroom at the Redis peak without throttling, prolonged queueing, recovery traffic, or unrelated I/O. A storage-saturated run measures the storage path, not the Redis performance ceiling.

## Record the environment before testing

Create a run directory and capture facts that affect comparability. Do not export Secrets.

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="redis-perf-${RUN_ID}"
mkdir -p "${OUT}"

kubectl version -o yaml > "${OUT}/kubernetes-version.yaml"
kubectl get nodes -o wide > "${OUT}/nodes.txt"
kubectl get nodes -o json > "${OUT}/nodes.json"
kubectl get storageclass -o yaml > "${OUT}/storageclasses.yaml"
kubectl -n redis-perf get redis,pod,svc,pvc -o wide > "${OUT}/placement.txt"
kubectl -n redis-perf get pvc -o yaml > "${OUT}/persistent-volume-claims.yaml"

SC_NAME=sc-topolvm  # Example; replace with the selected StorageClass.
kubectl get storageclass "${SC_NAME}" -o yaml \
  > "${OUT}/storageclass-${SC_NAME}.yaml"

TEMPLATE_NS=replace-with-template-namespace
TEMPLATE=replace-with-selected-template-identifier
kubectl -n "${TEMPLATE_NS}" get paramtemplate.middleware.alauda.io \
  "${TEMPLATE}" -o yaml > "${OUT}/paramtemplate-${TEMPLATE}.yaml"
```

Also record the Redis Operator version, Redis server version, image IDs, node CPU model and frequency policy, network link speed, StorageClass/Container Storage Interface (CSI) implementation, volume performance class, service mesh status, and test time zone. Redis recommends isolated hardware, stable CPU frequency, known client/server network latency, and no unrelated storage I/O for reproducible results. Verify `vm.overcommit_memory=1` and Transparent Huge Pages are disabled on Redis nodes according to [Redis administration guidance](https://redis.io/docs/latest/operate/oss_and_stack/management/admin/); platform administrators must apply host changes through the supported node-management process.

## Configure Redis instances

Create each test instance through the product console so the selected system template is applied through the supported workflow:

1. Choose Redis 7.2 and select **Cluster** or **Sentinel** topology.
2. Select the exact **Parameter Templates / 参数模板** identifier from the table above. Do this before manually changing Redis parameters.
3. The listed system templates assign limits of `4` CPU and `8Gi` memory to each Redis server, matching the standard capacity profile. Confirm those values after selection and set requests equal to limits where the form exposes both. Configure three primary shards and one replica per primary for Cluster, or one primary, one replica, and three Sentinel processes for Sentinel. Treat any resource or topology change as a separately named profile.
4. For RDB or AOF, choose the qualified `StorageClass` for the declared performance-ceiling or production-representative profile. For both topologies, the shipped templates prefill `24Gi` for RDB and `32Gi` for AOF. Treat these values as minimum starting capacities, calculate the requirement as described below, and use the larger value. The no-persistence templates do not require persistent data storage.
5. Enable the Redis exporter. Expand **Parameters / 参数配置** and verify `appendonly`, `appendfsync`, `save`, `maxmemory`, `maxmemory-policy`, `repl-diskless-sync`, `io-threads`, and `io-threads-do-reads` against the exported template. An empty template value for `maxmemory` is intentional; verify the Operator-derived effective value after creation.
6. After correcting resource and storage capacity for the target dataset, create the baseline with the Redis parameters unchanged. For a tuned comparison, start again from the same template and change only the documented target parameter. If the installed platform supports customer-owned templates, save the tuned copy under a new name; never edit the shipped system template in place.

Template selection materializes the template values into the Redis instance configuration; the Redis custom resource does not retain a template-name reference. Therefore, the report must preserve both the exact exported `ParamTemplate` and the resulting Redis custom resource. Do not invent a `spec.paramTemplate` field for automation.

### Set persistent volume capacity for the standard matrix

Do not require the test operator to infer capacity from observed persistent volume claim (PVC) usage. Calculate it before deployment from the test matrix. Use the same per-Pod calculation for Sentinel and Cluster: Sentinel data nodes hold the complete dataset, while applying the complete-workload allowance to every Cluster data Pod avoids relying on perfectly even slot or key distribution.

Let `N` be the number of `SET` requests per measured point, `K` the random keyspace, `D` the value size in bytes, and `S` the number of `SET` passes retained since the last successful AOF rewrite. `GET` and pipeline depth do not increase persistent data volume.

```text
RDB calculated peak = 2 * K * D
  # Existing RDB plus the temporary RDB created by BGSAVE.

AOF calculated peak = (S * N + 2 * K) * D
  # Retained SET passes, the existing compacted dataset,
  # and the new base file created by BGREWRITEAOF.

required capacity = ceil_Gi(max(template capacity, calculated peak * safety factor))
```

`ceil_Gi` means round up to the next whole GiB expressed as a Kubernetes `Gi` value.

Use a safety factor of `1.5` for the bounded standard matrix when the command mix is `SET,GET`, `S` is known, and AOF housekeeping completes between points. Use `2.0` when key lengths or command framing differ materially, the number of retained writes is less predictable, or the test intentionally continues writing during persistence work. For write commands other than `SET`, first replace `S * N * D` with that workload's maximum serialized write volume; increasing the factor alone does not correct an invalid payload model. These factors are this guide's engineering safety policy, not Redis-defined constants. If the write volume cannot be bounded, stop and define a maximum duration or request count; no finite percentage can prevent an indefinitely growing AOF from filling its volume.

For the standard matrix (`N=1,000,000`, `K=100,000`, `S=1`), the calculation is:

| Persistence | Value size | Calculated peak | Peak × `1.5` | Template minimum | Provision per data Pod |
|---|---:|---:|---:|---:|---:|
| RDB | 512 B | 0.095 GiB | 0.143 GiB | 24Gi | **24Gi** |
| RDB | 4096 B | 0.763 GiB | 1.145 GiB | 24Gi | **24Gi** |
| AOF | 512 B | 0.572 GiB | 0.858 GiB | 32Gi | **32Gi** |
| AOF | 4096 B | 4.578 GiB | 6.867 GiB | 32Gi | **32Gi** |

The resulting Kubernetes-requested capacity for the standard topology is:

| Topology | Redis data Pods | RDB total | AOF total |
|---|---:|---:|---:|
| Sentinel: one primary + one replica | 2 | **48Gi** | **64Gi** |
| Cluster: three primaries + one replica per primary | 6 | **144Gi** | **192Gi** |

The standard matrix fits within the template capacities because it has a bounded keyspace, one million requests, and one retained AOF pass. This does not make `24Gi` or `32Gi` generally sufficient. For example, with `N=10,000,000`, `K=100,000`, `D=4096`, and `S=1`, the AOF calculated peak is `38.910 GiB`; applying `1.5` requires `59Gi` after rounding up. Round further when the storage class supports only fixed allocation increments.

Redis serialization, AOF protocol framing, key names, and other files are not included in the payload-only peak. The safety factor provides space for these items and for variation around the bounded test. Redis writes a temporary RDB before replacing the old file. Redis 7.2 multipart AOF retains the current file set while rewrite creates a new base and continues accepting writes, which is why both generations are included before applying the factor.

Use a fresh instance for every parameter-template, value-size, pipeline, and Redis I/O-thread scenario, as the Operator performance suite does. During a client-concurrency sweep on an AOF instance, either recreate the instance for every measured point or run `BGREWRITEAOF` after warm-up and after each point, wait for `aof_rewrite_in_progress:0`, and require `aof_last_bgrewrite_status:ok` before continuing. Run this housekeeping outside the measured interval.

If `-n`, `-r`, `-d`, or `S` changes, recompute the capacity before creating the instance. Do not reuse the standard values for the earlier 5-30-million-request Ares cases or a customer workload without recalculation. Multiply the per-Pod result by two for the standard Sentinel topology or by six for the standard three-primary, one-replica-per-primary Cluster topology to obtain total Kubernetes-requested capacity. Storage-system replication, thin-provisioning reserve, and filesystem overhead are additional. For local block storage, every eligible node must have enough allocatable local capacity for the Redis data Pods that can be scheduled there. Provision the calculated capacity before testing; do not resize a PVC during a measured run.

Wait for `.status.phase` to become `Ready`, then verify Pod placement:

```bash
kubectl -n redis-perf wait --for=jsonpath='{.status.phase}'=Ready \
  redis/replace-with-instance-name --timeout=30m
kubectl -n redis-perf get pod -o wide
```

For valid results, place the load generator on a node that does not host a Redis server. Spread Sentinel data nodes across hosts. Cluster placement is shard-aware, so always record the actual node of every primary and replica rather than assuming separation.

### Redis configuration rules

- For the unchanged Redis 7.2 template baseline, leave `maxmemory` empty. Because the templates set `maxmemory-policy=noeviction`, the Operator writes an effective `maxmemory` equal to 80% of the Redis data container memory limit. The standard `8Gi` limit therefore produces approximately `6.4Gi` of `maxmemory`. Confirm the exact byte value with `CONFIG GET maxmemory` on every data Pod; do not report the empty template field as an unlimited Redis configuration.
- The remaining 20% is process headroom, not additional dataset capacity. It must absorb replication/AOF buffers, allocator fragmentation, client buffers, and copy-on-write pages during RDB save or AOF rewrite. Redis warns that a write-heavy background save can temporarily require substantially more memory. If this headroom is insufficient under the target workload, increase the container limit and rerun the resource profile instead of raising `maxmemory` toward the limit without evidence.
- An explicit `maxmemory` overrides the Operator-derived value and is a separately named tuning profile. In the current Operator implementation, leaving `maxmemory` empty with a configured policy other than `noeviction` derives 70% of the memory limit instead of 80%. Therefore, a `maxmemory-policy` comparison must either pin the same explicit `maxmemory` in every candidate or report that usable dataset capacity also changed.
- Keep `maxmemory-policy: noeviction` for a capacity test. An out-of-memory write then fails visibly instead of silently replacing keys and making the workload incomparable. If production uses eviction, run an additional profile with the production policy.
- Do not remove replicas merely to inflate throughput. Sentinel with zero replicas no longer represents its high-availability purpose; each Cluster shard/replica count must match production.
- Keep the selected template unchanged for the baseline: the listed Redis 7.2 templates use `io-threads=4` and `io-threads-do-reads=no`. Do not change `hz`, backlog, persistence, or kernel settings in the same comparison; change one setting at a time and retain before/after evidence.
- Keep the selected `StorageClass` and storage profile constant across a comparison. Do not present results from NFS, other network-attached storage, or CephFS as a Redis performance ceiling. Treat Ceph block storage or other network block storage as production-representative unless its qualification evidence shows that it retains headroom throughout the run.

### Tune Redis I/O threads

Redis 7.2 can use I/O threads for client socket work, while command execution remains mostly on the main thread. `io-threads` counts the main thread: `1` means the normal single-threaded I/O path. Values greater than `1` offload socket writes. Set `io-threads-do-reads=yes` only as a separate profile to also offload socket reads and protocol parsing; the Redis 7.2 reference configuration says threaded reads usually provide little benefit. Redis 7.2 also states that threaded I/O does not work with TLS. Override the template to `io-threads=1` for a TLS profile and record that deviation.

Use the CPU available to the Redis container, not the Kubernetes node's total CPU count. Always measure the unchanged product-template value of `4` first. The following controlled sweeps include both the product baseline and upstream comparison points; they are not universal optimums:

| Redis version | Redis container CPU | Product baseline | Controlled `io-threads` sweep | `io-threads-do-reads` |
|---|---:|---|---|---|
| 7.2 | 4 vCPU | `4` | `1`, `2`, `3`, `4` | `no` first; test `yes` separately |
| 7.2 | 8 vCPU | `4` after copying the template | `1`, `4`, `6` | `no` first; test `yes` separately |

For other CPU allocations, retain `4` as the template-baseline result, then compare `1` and gradually increasing values that leave CPU headroom. Changing from 4 to 8 vCPU is a separate resource profile; do not merge those results. Do not set more I/O threads than the Redis container can run without sustained CPU throttling. Guaranteed quality of service (QoS) requires equal CPU and memory requests and limits for every container in the Pod. Dedicated CPUs additionally require the cluster's CPU Manager static policy and an integer Guaranteed CPU request; record whether that policy is active.

Use the parameter editor to apply one candidate to a new copy of the selected template. For example, keep the first pair for the baseline and use the second pair only for a separately named 4-vCPU comparison:

```text
# Unchanged product-template baseline
io-threads 4
io-threads-do-reads no

# Example comparison profile; all other template values remain unchanged
io-threads 3
io-threads-do-reads no
```

The product `ParamDefinition` classifies both keys as `RestartApply`. Use a fresh instance for the cleanest comparison, or allow the managed restart to finish, wait for `Ready`, and confirm that all expected primaries and replicas have returned before loading data. Verify the effective values on every Redis data Pod with the collection helper below; a mixed value across nodes invalidates the run.

Calibrate the load generator before comparing server candidates. Redis 7.2 recommends running `redis-benchmark` in threaded mode when evaluating I/O threads. Set client `--threads` high enough that the client retains CPU and network headroom at the largest server candidate, then hold the client setting constant across the `io-threads` comparison. The load-generator thread count and the server I/O thread count are different parameters and must be reported separately.

For each candidate, repeat the client-concurrency sweep. Select the setting with the highest reproducible throughput that still meets the agreed p99 latency, error-rate, replication-lag, and CPU-throttling limits. Stop increasing threads when throughput no longer improves materially or latency/throttling worsens; retaining only the highest one-off result is not a valid tuning decision.

## Prepare an open-source load generator

Use the official Redis image on a dedicated load-generator node. The following reusable Pod reads the password from a Secret volume. Replace the image with the exact mirrored image and update the anti-affinity instance name for each topology. If a dedicated node is unavailable, remove the selector/toleration but treat any client/server co-location as an invalid run.

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: redis-perf-client
  namespace: redis-perf
  labels:
    app.kubernetes.io/name: redis-perf-client
spec:
  restartPolicy: Never
  nodeSelector:
    redis-perf/loadgen: "true"
  tolerations:
    - key: redis-perf/loadgen
      operator: Equal
      value: "true"
      effect: NoSchedule
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              middleware.instance/name: redis-perf-cluster
          topologyKey: kubernetes.io/hostname
  containers:
    - name: client
      image: redis:7.2.15
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "while true; do sleep 3600; done"]
      resources:
        requests: {cpu: "8", memory: 8Gi}
        limits: {cpu: "8", memory: 8Gi}
      volumeMounts:
        - name: auth
          mountPath: /auth
          readOnly: true
  volumes:
    - name: auth
      secret:
        secretName: redis-perf-auth
```

In an isolated test cluster, reserve a node before applying the Pod:

```bash
kubectl label node replace-with-loadgen-node redis-perf/loadgen=true
kubectl taint node replace-with-loadgen-node redis-perf/loadgen=true:NoSchedule
kubectl apply -f redis-perf-client.yaml
kubectl -n redis-perf wait --for=condition=Ready pod/redis-perf-client --timeout=10m
kubectl -n redis-perf exec redis-perf-client -- redis-benchmark --version \
  | tee "${OUT}/redis-benchmark-version.txt"
kubectl -n redis-perf exec redis-perf-client -- redis-benchmark --help \
  > "${OUT}/redis-benchmark-help.txt"
```

Use only options shown by the exact client binary. In particular, the Redis 7.2.15
binary does not expose `-e`; preserve benchmark standard error and collect Redis
`INFO errorstats` and rejected-connection counters instead of copying that option
from documentation for a different client version.

## Validate connectivity and topology

Use the Service name reported by the Redis custom resource. The data port is `6379` for both topologies.

```bash
NS=redis-perf
REDIS_NAME=redis-perf-cluster
SERVICE="$(kubectl -n "${NS}" get redis "${REDIS_NAME}" \
  -o jsonpath='{.status.serviceName}')"
HOST="${SERVICE}.${NS}.svc"

kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
  redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" PING
' sh "${HOST}"
```

Expected result: `PONG`. For Cluster, also require `cluster_state:ok`, all `16384` slots assigned, and zero `cluster_slots_pfail`/`cluster_slots_fail`:

```bash
kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
  redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" CLUSTER INFO
' sh "${HOST}" | tee "${OUT}/cluster-info-before.txt"
```

Before load, also require the expected replicas to be connected, no initial synchronization in progress, and no RDB save or AOF rewrite in progress. Record an intentional background persistence operation as part of the scenario instead of allowing it to occur in only one compared run.

For Sentinel, use the Redis read-write Service for load. Separately query the Sentinel Service and record `SENTINEL MASTER`, `SENTINEL REPLICAS`, `SENTINEL SENTINELS`, and `SENTINEL CKQUORUM` output. The monitored master name and Sentinel Service are deployment-specific; obtain them from the instance status/services rather than assuming a name. The [Redis Sentinel documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/) defines these commands and health fields.

## Run the benchmark

The command below accepts topology and load parameters as positional arguments. The password is read inside the Pod and is not stored in the manifest or report. Because `redis-benchmark` accepts authentication through `-a`, the password is present in that process's arguments while the test runs; restrict Pod exec/debug permissions, do not enable shell tracing, and delete the client Pod after evidence collection.

```bash
ARCH=cluster          # cluster or sentinel
CLIENTS=100
REQUESTS=1000000
DATA_SIZE=512
PIPELINE=1
THREADS=4            # redis-benchmark client threads, not Redis io-threads
KEYSPACE=100000
RESULT_ID="${ARCH}-d${DATA_SIZE}-p${PIPELINE}-c${CLIENTS}"
RAW_OUTPUT="${OUT}/${RESULT_ID}.raw.txt"
CSV_OUTPUT="${OUT}/${RESULT_ID}.csv"

set -o pipefail
kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
  arch="$1"; host="$2"; clients="$3"; requests="$4"
  data_size="$5"; pipeline="$6"; threads="$7"; keyspace="$8"
  set -- redis-benchmark -h "$host" -p 6379 \
    -a "$(cat /auth/password)" \
    -c "$clients" -n "$requests" -d "$data_size" \
    -P "$pipeline" --threads "$threads" -r "$keyspace" \
    -t set,get --csv
  if [ "$arch" = cluster ]; then set -- "$@" --cluster; fi
  "$@"
' sh "${ARCH}" "${HOST}" "${CLIENTS}" "${REQUESTS}" \
  "${DATA_SIZE}" "${PIPELINE}" "${THREADS}" "${KEYSPACE}" \
  | tee "${RAW_OUTPUT}"

# Redis 7.2.15 Cluster mode prints node-discovery lines before the quoted CSV rows.
# Preserve the raw evidence and create a machine-readable CSV containing only those rows.
awk '/^"/ {print}' "${RAW_OUTPUT}" > "${CSV_OUTPUT}"
test "$(wc -l < "${CSV_OUTPUT}")" -ge 3
```

`redis-benchmark` parameters:

| Parameter | Meaning and selection rule |
|---|---|
| `-c` | Parallel connections. Start at `50` (the community default) or `100` (the Operator suite default), then increase. Earlier internal validation used `200` for Cluster and `1000` for Sentinel as high-concurrency reference points. |
| `-n` | Requests per selected operation. Use `1,000,000` for a quick measured run. Earlier internal validation used 5-30 million depending on topology/value size. Increase it until the measurement contains enough monitoring samples and reaches steady state. |
| `-d` | `SET`/`GET` value size in bytes. Use `512` and `4096` (4 KiB) for the standard matrix. Add separately named sizes when the application's payload distribution differs. |
| `-P` | Pipeline depth. `1` is no pipelining; `16` is the standard throughput-oriented point. Use the application's average pipeline depth for a production-realistic test. Never compare `P=1` and `P=16` as if they were the same workload. |
| `--threads` | Load-generator threads, independent of Redis `io-threads`. Begin with `4`; increase only if the client Pod is CPU-bound before Redis. Earlier internal reference values were `16` for Cluster and `8` for Sentinel. During a server I/O-thread sweep, provision enough client threads for the largest candidate and then hold this value constant. |
| `-r` | Random keyspace. `100000` is the implemented baseline; enlarge it when the real dataset has a larger working set. |
| `-t` | Commands to test. `set,get` is the standard comparison. Add a separate scenario for the application's actual command mix; do not mix incomparable command sets in one result table. |
| `--cluster` | Required for Redis Cluster so the tool discovers and routes across Cluster nodes. Omit for Sentinel. All announced Cluster node addresses must be reachable from the client Pod. |
| `--csv` | Requests CSV-formatted result rows. Redis 7.2.15 Cluster mode also writes node-discovery text to standard output, so preserve the raw file and extract the quoted rows as shown above. Output fields can differ between client versions; mark unavailable latency percentiles as `N/A`, never as zero. |

If an Access Control List (ACL) username is required, add `--user <username>` while continuing to read the password from the Secret. For TLS-enabled instances, mount the approved certificate authority (CA) and client certificate Secrets and use the TLS flags supported by the exact `redis-benchmark --help` output; record TLS as a separate test profile because it changes CPU and latency.

## Find the saturation point

Use a controlled sweep; do not jump directly to the largest client count.

1. Run a short connectivity/warm-up pass. Do not include it in the report.
2. Measure `P=1` with `c=50`, then `100`, `200`, `400`, continuing upward while throughput rises and the load generator has spare CPU/network capacity.
3. At every point, inspect `SET`/`GET` requests per second, p99 latency, errors, Redis CPU, client CPU, CPU throttling, network throughput, memory, and persistence activity.
4. When more clients no longer produce a material throughput increase, or latency/errors grow rapidly, repeat the last stable point and the first overloaded point. The last reproducible point that meets the agreed latency/error objective is the usable capacity; the highest reproducible, error-free throughput regardless of latency is the throughput ceiling. Report both when they differ.
5. If the client Pod reaches its CPU limit or network limit while Redis still has headroom, raise client resources or use multiple client Pods. Redis explicitly warns that the benchmark client can become the bottleneck before the server.
6. Repeat the sweep with `P=16` only when the application can pipeline, or to document the protocol throughput ceiling. Keep it separate from the non-pipelined result.
7. For Cluster, inspect each shard. A single hot shard, unequal key distribution, unreachable announced address, or client-side bottleneck is not Cluster saturation. For Sentinel, additional replicas do not add write capacity; they add replication work and must remain in the production-representative topology.

Repeat runs until results are reproducible and retain all runs. Do not report only the best sample.

## Collect monitoring data

### Kubernetes resource metrics

The Operator test harness samples the standard `metrics.k8s.io` API every five seconds and records maximum/average CPU and memory. Metrics Server does not provide network, storage, or historical series; use Prometheus for those metrics.

```bash
kubectl -n redis-perf top pod --containers
kubectl get --raw '/apis/metrics.k8s.io/v1beta1/namespaces/redis-perf/pods' \
  > "${OUT}/pod-metrics.json"
```

Export range data covering at least the benchmark start/end time. Adapt label selectors to the installed monitoring stack:

```text
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="redis-perf",container!=""}[5m]))
sum by (pod) (container_memory_working_set_bytes{namespace="redis-perf",container!=""})
sum by (pod) (rate(container_network_receive_bytes_total{namespace="redis-perf"}[5m]))
sum by (pod) (rate(container_network_transmit_bytes_total{namespace="redis-perf"}[5m]))
```

The `rate()` range must contain multiple scrape samples. Use `[5m]` when the
installed monitoring interval is 60 seconds; a `[1m]` range can return no data.
Adjust the range when the installed interval differs, and record both values in
the report.

Calculate utilization against declared container limits with a ratio of sums:

```text
100 *
sum(rate(container_cpu_usage_seconds_total{namespace="redis-perf",container="redis"}[5m]))
/
sum(max by (namespace,pod,container,resource,unit) (
  kube_pod_container_resource_limits{namespace="redis-perf",container="redis",resource="cpu",unit="core"}
))

100 *
sum(container_memory_working_set_bytes{namespace="redis-perf",container="redis"})
/
sum(max by (namespace,pod,container,resource,unit) (
  kube_pod_container_resource_limits{namespace="redis-perf",container="redis",resource="memory",unit="byte"}
))
```

Use the load-generator container selector in separate queries. Do not average
per-Pod percentages because differently sized Pods would receive equal weight.
Label these results **CPU limit utilization** and **memory limit utilization**;
they are not node utilization, CPU request utilization, Redis `maxmemory`
utilization, or Redis resident set size (RSS). If the Redis limit is not
explicitly configured, the product derives `maxmemory` as 80% of the container
memory limit, but the Kubernetes working set can still differ from Redis
`used_memory` and `maxmemory` because it includes process and allocator overhead.

Export client and Redis server Pods separately. Include CPU throttling if exposed, volume latency, storage input/output operation rate, throughput, queue depth, and throttling from CSI, the storage platform, or the node exporter. For Ceph block storage, also record whether recovery, rebalancing, or client quality-of-service limits were active. Include node CPU utilization/frequency, node memory pressure, packet drops/retransmits, and Pod restart/out-of-memory events. Counter metrics require `rate()`/`increase()` rather than direct subtraction, as described by [Prometheus metric guidance](https://prometheus.io/docs/practices/instrumentation/).

### Redis metrics

Capture `INFO` before and after every measured run. For Cluster, collect it from every primary and replica, not only the seed Service. Redis `INFO` fields vary by version; preserve unknown fields and mark unavailable fields as `N/A`.

The following helper discovers only Pods containing the Redis server container and writes one file per node. Run it once with `PHASE=before` and again with `PHASE=after`:

```bash
PHASE=before
kubectl -n "${NS}" get pod -o json \
  | jq -r --arg name "${REDIS_NAME}" '
      .items[]
      | select(.metadata.labels["middleware.instance/name"] == $name)
      | select(any(.spec.containers[]; .name == "redis"))
      | [.metadata.name, .status.podIP]
      | @tsv
    ' \
  | while IFS=$'\t' read -r NODE_NAME NODE_IP; do
      kubectl -n "${NS}" exec redis-perf-client -- sh -eu -c '
        for section in server clients memory stats persistence replication cpu commandstats latencystats errorstats keyspace; do
          echo "INFO ${section}"
          redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" INFO "${section}"
        done
        for key in save appendonly appendfsync maxmemory maxmemory-policy repl-diskless-sync io-threads io-threads-do-reads hz; do
          echo "CONFIG GET ${key}"
          redis-cli -h "$1" -p 6379 -a "$(cat /auth/password)" CONFIG GET "${key}"
        done
      ' sh "${NODE_IP}" \
        > "${OUT}/redis-info-${PHASE}-${NODE_NAME}.txt"
    done
```

Required sections and fields include:

- `server`: Redis version, mode, uptime, allocator, input/output thread state.
- `clients`: connected/blocked clients and `maxclients`.
- `memory`: `used_memory`, `used_memory_rss`, peak memory, fragmentation, `maxmemory`, policy, and non-evictable buffer memory.
- `stats`: instantaneous/total operations, input/output bytes, rejected connections, evicted/expired keys, keyspace hits/misses, replication sync counters, `total_reads_processed`, `total_writes_processed`, `io_threaded_reads_processed`, and `io_threaded_writes_processed`.
- `persistence`: `rdb_bgsave_in_progress`, `rdb_last_bgsave_status`, `rdb_last_bgsave_time_sec`, `aof_current_size`, `aof_base_size`, `aof_rewrite_in_progress`, `aof_last_bgrewrite_status`, `aof_last_rewrite_time_sec`, and `aof_delayed_fsync` when present.
- `replication`: role, connected replicas, replication offsets, backlog, and link state.
- `cpu`, `commandstats`, `latencystats`, `errorstats`, and `keyspace`.
- Cluster: `CLUSTER INFO` and `CLUSTER NODES` from each node.
- Sentinel: `SENTINEL MASTER`, `REPLICAS`, `SENTINELS`, and `CKQUORUM`.

When the product Redis exporter is enabled, export the metrics already used by the shipped dashboard, including:

```text
redis_commands_processed_total
redis_commands_duration_seconds_total
redis_connected_clients
redis_blocked_clients
redis_memory_used_bytes
redis_memory_used_rss_bytes
redis_memory_used_peak_bytes
redis_keyspace_hits_total
redis_keyspace_misses_total
redis_evicted_keys_total
redis_net_input_bytes_total
redis_net_output_bytes_total
redis_rdb_bgsave_in_progress
redis_rdb_last_bgsave_duration_sec
redis_aof_rewrite_in_progress
redis_aof_last_rewrite_duration_sec
redis_slowlog_length
```

Record the raw exporter output or Prometheus range-query result, not screenshots alone. The [Redis `INFO` reference](https://redis.io/docs/latest/commands/info/) defines the server-side fields and their version boundaries.

The shipped Redis `ServiceMonitor` applies a metric-relabel allowlist. A metric
such as `redis_up` can therefore exist on the raw exporter endpoint without being
stored by Prometheus. Use Prometheus target health or its generated `up` series to
verify scraping, and query the allowlisted Redis metrics above to verify data
retention. Do not assume that every raw exporter metric is retained.

### Kubernetes evidence

After each scenario, append the following without collecting Secret objects:

```bash
kubectl -n redis-perf get redis "${REDIS_NAME}" -o json \
  | jq '{
      apiVersion, kind,
      metadata: {name: .metadata.name, namespace: .metadata.namespace},
      spec: (.spec | {
        version, arch, resources, persistent, persistentSize, replicas,
        affinityPolicy, nodeSelector, tolerations, enableTLS, customConfig
      }),
      status: (.status | {phase, serviceName, lastShardCount, lastVersion})
    }' \
  > "${OUT}/${REDIS_NAME}.json"
kubectl -n redis-perf get pod -o wide \
  > "${OUT}/pods-after.txt"
kubectl -n redis-perf get events --sort-by=.lastTimestamp \
  > "${OUT}/events.txt"
kubectl -n redis-perf get pod redis-perf-client \
  -o jsonpath='{.status.containerStatuses[0].imageID}{"\n"}' \
  > "${OUT}/loadgen-image-id.txt"
```

On failure, also export Redis Pod logs, `kubectl describe` output, volume and `StorageClass` details, and the load-generator output. Redact customer identifiers, addresses, and credentials before sharing the bundle.

## Report format and validity checks

Produce JSON or CSV for automation and Markdown/PDF for customer review. One report row represents one topology + Redis version + parameter-template identifier + value size + pipeline + client count + Redis I/O-thread setting + load-generator thread count.

Use a stable machine-readable header so runs can be compared without parsing prose:

```text
topology,redis_version,parameter_template,persistence,storage_profile,storage_class,pvc_capacity_gib,value_size_bytes,pipeline,clients,redis_io_threads,redis_io_threads_do_reads,loadgen_threads,requests,keyspace,set_rps,set_p99_ms,get_rps,get_p99_ms,redis_cpu_max_millicores,redis_memory_max_mib,loadgen_cpu_max_millicores,loadgen_memory_max_mib,network_rx_mib_s,network_tx_mib_s,storage_iops,storage_latency_ms,valid,notes
```

| Category | Required report fields |
|---|---|
| Environment | Date/time, Kubernetes/Alauda Container Platform (ACP)/Operator/Redis versions, node count/type, CPU model, memory, network, storage profile, `StorageClass`, provisioner, parameters, `volumeBindingMode`, `allowVolumeExpansion`, filesystem/backing media, PVC capacity per Redis Pod, qualification results, image names and immutable digests |
| Topology | Cluster shard/replica count or Sentinel primary/replica/Sentinel count; Pod-to-node placement; Service access path |
| Redis configuration | Exact `ParamTemplate` identifier, `metadata.resourceVersion`, `cpaas.io/description` (Chinese), `cpaas.io/description-en` (English), exported template YAML, and allowlisted effective keys (`save`, `appendonly`, `appendfsync`, `maxmemory`, `maxmemory-policy`, `repl-diskless-sync`, `io-threads`, `io-threads-do-reads`, `hz`); approved tuning delta; TLS/ACL state without credentials |
| Load | Tool version/image digest, client location, access type and round-trip latency, commands, `-c`, `-n`, `-d`, `-P`, `--threads`, `-r`, warm-up method, start/end/duration |
| Results | `SET`/`GET` requests per second; average, min, p50, p95, p99, max latency when emitted; raw CSV |
| Resources | Client and server peak/average CPU/memory, throttling, network receive/transmit, storage operation rate/throughput/latency/queue depth/throttling, storage recovery or rebalancing activity, node pressure |
| Redis health | `INFO` deltas, Cluster slot/health state or Sentinel quorum/role state, errors, evictions, rejected connections, slow log, AOF size fields, persistence status and duration |
| Verdict | Meets/does not meet the pre-agreed throughput, p99, error, and resource-headroom objectives; bottleneck evidence and invalid-run reasons |

A run is valid only when the benchmark exits successfully with positive results, the load generator is not co-located with a measured Redis server, there are no unexpected failovers, restarts, out-of-memory kills, disk-full events, PVC expansions, or failed RDB saves/AOF rewrites, and topology health remains normal. A load-generator bottleneck, missing Cluster node reachability, unrelated node/storage load, or a persistence rewrite that occurs in only one compared run makes the comparison invalid. A run with storage-capacity or storage-performance saturation remains useful as a storage-limited production-path result, but it must not be reported as the Redis performance ceiling. Performance is a measured result, not a universal pass/fail threshold; define customer acceptance criteria before execution.

## Cleanup

Delete only the dedicated test resources after evidence has been exported:

```bash
kubectl -n redis-perf delete pod redis-perf-client
kubectl -n redis-perf delete redis redis-perf-cluster redis-perf-sentinel --ignore-not-found
kubectl -n redis-perf delete secret redis-perf-auth --ignore-not-found
kubectl taint node replace-with-loadgen-node redis-perf/loadgen=true:NoSchedule-
kubectl label node replace-with-loadgen-node redis-perf/loadgen-
```

Confirm the operator's PersistentVolumeClaim retention behavior before deleting volumes. Do not delete retained data unless the namespace and volumes are dedicated to this test and the customer has approved removal.

## Method and source traceability

This procedure is traceable to the following implementations; customers do not need these source repositories to run it:

- Redis Operator: `tests/perf/config.go`, `tests/perf/scenarios.go`, `tests/perf/helpers_test.go`, and `tests/framework/bench/{runner,metrics,parse,report}.go`; `internal/builder/clusterbuilder/configmap.go` and `internal/builder/failoverbuilder/configmap.go` derive an unset `maxmemory` from the Redis container memory limit and configured eviction policy; `internal/builder/clusterbuilder/configmap.go` and `internal/controller/middleware/redis/rediscluster.go` define `io-threads` and `io-threads-do-reads` as restart-required custom configuration.
- Internal validation repository: `performance_case/middleware/redis/test_cluster.py` and `test_sentinel.py` for the 4-CPU/8-GiB sizing, persistence/value/pipeline matrix, long request counts, and CPU/memory/network collection; `performance_case/staging/performance_testing.py` uses `sc-topolvm` as the example performance-test `StorageClass`.
- Product parameter templates: `middleware/charts/redis-param/templates/redis-7.2-paramtemplate-{0,1,2}.yaml` and `redis-7.2-paramdefinition.yaml` define the shipped RDB, no-persistence, and AOF baselines. `redis-frontend/src/app/components/params-template-select/{component.ts,template.html}`, `components/form/component.ts`, and `modules/meepo-shared/src/lib/utils/param-template.ts` define default selection, identifier display, localized descriptions, and application of template values to the form.
- Product schema and monitoring: `api/middleware/v1/redis_types.go`, `config/samples/middleware.alauda.io_v1_redis.yaml`, and `resources/dashboard/data/redis-dashboard.yaml`.
- Community references: [Redis benchmark](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/), [Redis 7.2 reference configuration](https://github.com/redis/redis/blob/7.2/redis.conf), [Redis `INFO`](https://redis.io/docs/latest/commands/info/), [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/), [`BGSAVE`](https://redis.io/docs/latest/commands/bgsave/), [`BGREWRITEAOF`](https://redis.io/docs/latest/commands/bgrewriteaof/), [Redis Cluster health](https://redis.io/docs/latest/commands/cluster-info/), [Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/), [TopoLVM](https://github.com/topolvm/topolvm), [Kubernetes Storage Classes](https://kubernetes.io/docs/concepts/storage/storage-classes/), [Ceph architecture](https://docs.ceph.com/en/latest/architecture/), [Kubernetes resource metrics](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/), and [Kubernetes Pod QoS](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/).
