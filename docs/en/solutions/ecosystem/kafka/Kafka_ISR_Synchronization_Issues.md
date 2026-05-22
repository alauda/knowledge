---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Resolve Kafka ISR Synchronization Issues That Block Broker Restart

:::info Applicable Versions
Kafka 2.7.0 and 2.8.2 on ACP 3.x.
:::

## Problem

When the operator tries to restart a broker pod, it detects that restarting the pod would reduce the ISR count for a partition below `min.insync.replicas`. The restart is blocked. Topic details show that some partitions have the expected replica count, but only one replica remains in ISR.

## Recovery Options

### Option 1: Force Delete the Stuck Pod

This option is risky and should be used only when data consistency is not important.

```bash
kubectl -n <namespace> delete pod <stuck-kafka-pod> --force --grace-period=0
```

If ISR has only one replica, forcibly deleting the pod can lose the latest records for affected partitions or cause consumers to reprocess data. Avoid this in production unless the business accepts the data risk.

### Option 2: Reassign Affected Topic Partitions

Reassign the affected topic so replicas can recover and ISR can become healthy again.

Create a topic list file. Replace `__consumer_offsets` with the affected topic if needed:

```bash
cat > /tmp/topic-generate.json <<'EOF'
{
  "topics": [
    {"topic": "__consumer_offsets"}
  ],
  "version": 1
}
EOF
```

Generate a reassignment plan. Update `--broker-list` to match your brokers:

```bash
./bin/kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --topics-to-move-json-file /tmp/topic-generate.json \
  --broker-list "0,1,2" \
  --generate
```

Copy the proposed partition assignment from the command output and save it:

```bash
cat > /tmp/partition-replica-reassignment.json <<'EOF'
{
  "version": 1,
  "partitions": [
    {
      "topic": "__consumer_offsets",
      "partition": 0,
      "replicas": [0, 1, 2],
      "log_dirs": ["any", "any", "any"]
    }
  ]
}
EOF
```

Execute reassignment:

```bash
./bin/kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file /tmp/partition-replica-reassignment.json \
  --execute
```

Check the result:

```bash
./bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic __consumer_offsets
```

After ISR recovers, the blocked pod restart or rolling update can continue.

## Important Considerations

- Reassign only the affected topics and partitions.
- Keep a copy of the current assignment from the `--generate` output for rollback planning.
- Do not force-delete broker pods in production unless the data consistency risk is explicitly accepted.
- Monitor under-replicated partitions and ISR after reassignment.
