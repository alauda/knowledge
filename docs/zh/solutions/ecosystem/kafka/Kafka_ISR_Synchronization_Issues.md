---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
id: KB260500106
sourceSHA: bfffbf7404ded83277d0b3f21a472c2876fc3d22a6a504e2fe583cd931f4b5db
---

# 解决阻止代理重启的 Kafka ISR 同步问题

:::info 适用版本
Kafka 2.7.0 和 2.8.2 在 ACP 3.x 上。
:::

## 问题

当 operator 尝试重启一个代理 pod 时，它检测到重启该 pod 会使某个分区的 ISR 计数低于 `min.insync.replicas`。重启被阻止。主题详情显示某些分区具有预期的副本计数，但只有一个副本仍在 ISR 中。

## 恢复选项

### 选项 1：强制删除卡住的 Pod

此选项风险较高，仅在数据一致性不重要时使用。

```bash
kubectl -n <namespace> delete pod <stuck-kafka-pod> --force --grace-period=0
```

如果 ISR 只有一个副本，强制删除 pod 可能会导致受影响分区的最新记录丢失或导致消费者重新处理数据。在生产环境中避免这样做，除非业务接受数据风险。

### 选项 2：重新分配受影响的主题分区

重新分配受影响的主题，以便副本可以恢复，ISR 可以再次变得健康。

创建一个主题列表文件。如果需要，将 `__consumer_offsets` 替换为受影响的主题：

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

生成重新分配计划。更新 `--broker-list` 以匹配您的代理：

```bash
./bin/kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --topics-to-move-json-file /tmp/topic-generate.json \
  --broker-list "0,1,2" \
  --generate
```

从命令输出中复制建议的分区分配并保存：

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

执行重新分配：

```bash
./bin/kafka-reassign-partitions.sh \
  --bootstrap-server localhost:9092 \
  --reassignment-json-file /tmp/partition-replica-reassignment.json \
  --execute
```

检查结果：

```bash
./bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 \
  --describe \
  --topic __consumer_offsets
```

在 ISR 恢复后，被阻止的 pod 重启或滚动更新可以继续。

## 重要考虑事项

- 仅重新分配受影响的主题和分区。
- 保留 `--generate` 输出中的当前分配副本以便于回滚规划。
- 在生产环境中，除非明确接受数据一致性风险，否则不要强制删除代理 pod。
- 在重新分配后监控欠副本分区和 ISR。
