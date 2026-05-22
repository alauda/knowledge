---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Use Kafka Built-in Performance Test Scripts

:::info Applicable Versions
General Kafka guidance for ACP 3.x Kafka deployments.
:::

## Introduction

Kafka images include command-line tools that can create topics, run producer throughput tests, run consumer throughput tests, and inspect basic performance characteristics. Use these scripts for initial validation and comparative tests, not as a replacement for workload-specific benchmarking.

## Prerequisites

- A Kafka cluster is deployed and reachable.
- The test environment has the Kafka scripts available.
- Test topics can be created and deleted safely.
- Authentication configuration is prepared if the cluster requires SASL or TLS.

Set common connection variables:

```bash
kafka_link="localhost:9092"
```

## Topic Operations

```bash
./kafka-topics.sh --create \
  --bootstrap-server ${kafka_link} \
  --topic test_producer_perf \
  --partitions 6 \
  --replication-factor 1

./kafka-topics.sh --list --bootstrap-server ${kafka_link}
./kafka-topics.sh --describe --bootstrap-server ${kafka_link}
./kafka-topics.sh --delete --bootstrap-server ${kafka_link} --topic test_producer_perf
```

## Producer Tests

### Test Different Partition Counts

```bash
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_producer_perf6 --partitions 6 --replication-factor 1
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_producer_perf12 --partitions 12 --replication-factor 1

./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf6 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf12 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
```

### Test Different Replica Counts

```bash
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_replication3 --partitions 3 --replication-factor 3
./kafka-topics.sh --create --bootstrap-server ${kafka_link} --topic test_replication5 --partitions 3 --replication-factor 5

./kafka-producer-perf-test.sh --num-records 5000000 --topic test_replication3 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_replication5 --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
```

### Test Batch Size

```bash
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link} batch.size=200
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link} batch.size=400
```

### Test Message Size

```bash
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 1000 --producer-props bootstrap.servers=${kafka_link}
./kafka-producer-perf-test.sh --num-records 5000000 --topic test_producer_perf --throughput -1 --record-size 2000 --producer-props bootstrap.servers=${kafka_link}
```

Important producer options:

| Option | Meaning |
| --- | --- |
| `--topic` | Topic to produce to. |
| `--num-records` | Number of records to produce. |
| `--throughput` | Approximate message rate. `-1` disables throttling. |
| `--record-size` | Message size in bytes. |
| `--producer-props` | Producer config overrides such as `bootstrap.servers`. |
| `--producer.config` | Producer properties file. |
| `--print-metrics` | Print detailed metrics after the run. |

## Consumer Tests

### Test Different Thread Counts

```bash
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf --timeout 100000 --threads 2
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf --timeout 100000 --threads 3
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf --timeout 100000 --threads 4
```

### Test Different Partition Counts

```bash
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf6 --timeout 100000
./kafka-consumer-perf-test.sh --bootstrap-server ${kafka_link} --messages 5000000 --topic test_producer_perf12 --timeout 100000
```

Important consumer options:

| Option | Meaning |
| --- | --- |
| `--bootstrap-server` | Kafka bootstrap server. |
| `--topic` | Topic to consume from. |
| `--messages` | Number of messages to consume. |
| `--threads` | Number of processing threads. |
| `--num-fetch-threads` | Number of fetcher threads. |
| `--consumer.config` | Consumer properties file. |
| `--timeout` | Maximum interval between returned records. |

## Interpreting Results

Producer output includes records per second, MiB per second, average latency, maximum latency, and latency percentiles. Consumer output includes data consumed, throughput in MiB/s, message throughput, and fetch timing.

To estimate network bandwidth from producer MiB/s, multiply by 8 to convert bytes to bits.

## Important Considerations

- Kafka's built-in producer performance script does not model every application pattern and does not replace real client testing.
- Test with the same authentication, TLS, compression, batch, and acknowledgement settings used by production clients.
- Benchmark on isolated topics and clean up test topics after use.
- Watch broker CPU, disk, network, and consumer lag during tests.
