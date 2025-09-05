---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1757070159-ECAF
sourceSHA: b41db3b61989d724733b9c8eb18912bbe62bb385d98530949ec0b829f567e4a3
---

# Kafka 扩容切换

## 背景

在 ACP 3.18 之后，日志存储插件不再支持在插件更新期间扩容 Kafka。如果需要扩容，则需要手动干预。

## 适用版本

4.0.x, 4.1.x

## Kafka 扩容步骤

准备要扩容的 Kafka 节点，并按照以下三步操作步骤进行：

步骤 1：登录到全局主节点，找到目标集群的日志存储插件的 moduleinfo 资源。

```shell
kubectl get moduleinfo | grep logcenter | grep <cluster_name>          
global-e671599464a5b1717732c5ba36079795   global    logcenter             logcenter                           Processing   v3.19.0-fix.359.1.g991a35b1-feat   v3.19.0-fix.359.1.g991a35b1-feat   v3.19.0-fix.359.1.g991a35b1-feat
```

步骤 2：手动编辑资源，添加要扩容的 Kafka 节点名称。请参考注释示例以获取正确的位置。

```shell
kubectl edit moduleinfo <moduleinfo_name>
```

```yaml
apiVersion: cluster.alauda.io/v1alpha1
kind: ModuleInfo
metadata:
  annotations:
    cpaas.io/display-name: logcenter
    cpaas.io/module-name: '{"en": "ACP Log Storage with ElasticSearch", "zh": "ACP
       Log Storage with ElasticSearch"}'
    cpaas.io/upgraded-at: "2024-11-22T11:08:54Z"
    cpaas.io/upgraded-end: "2024-11-22T11:12:26Z"
  creationTimestamp: "2024-11-21T11:32:55Z"
  finalizers:
  - moduleinfo
  generation: 3
  labels:
    cpaas.io/cluster-name: global
    cpaas.io/module-name: logcenter
    cpaas.io/module-type: plugin
    cpaas.io/product: Platform-Center
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: global-e671599464a5b1717732c5ba36079795
  resourceVersion: "34173628"
  uid: 9eb04051-e5b1-4375-a31d-28b055a0dcb4
spec:
  config:
    clusterView:
      isPrivate: "true"
    components:
      kafka:
        address: ""
        auth: true
        basicAuthSecretName: ""
        exporterPort: 9308
        install: true
        k8sNodes:             # 将扩容的节点名称添加到指定数组中。
        - 1.1.1.1   
        - 2.2.2.2
        - 3.3.3.3
        port: 9092
        storageSize: 10
        tls: true
        zkElectPort: 3888
        zkExporterPort: 9141
        zkLeaderPort: 2888
        zkPort: 2181
```

步骤 3：等待日志存储插件更新完成。验证 Kafka 是否准备就绪，并检查日志是否正常收集。

```shell
kubectl get pods -n cpaas-system | grep kafka 
cpaas-kafka-0                                                 1/1     Running     0             6m54s
cpaas-kafka-1                                                 1/1     Running     0             7m49s
cpaas-kafka-2                                                 1/1     Running     0             7m49s
```

注意：如果 Kafka pods 正在运行但 Kafka 集群未正常工作，请在扩容完成后手动重启 Kafka 和 ZooKeeper 实例一次。

以下步骤是可选的——仅在上述问题发生时执行。重启后，请在 pods 再次运行时重新检查日志收集。

```shell
kubectl delete pods -n cpaas-system -l 'service_name in (cpaas-zookeeper, cpaas-kafka)'
pod "cpaas-kafka-0" deleted
pod "cpaas-kafka-1" deleted
pod "cpaas-kafka-2" deleted
pod "cpaas-zookeeper-0" deleted
pod "cpaas-zookeeper-1" deleted
pod "cpaas-zookeeper-2" deleted
```

## Kafka 分区重新分配步骤

如果 Kafka 从 3 个节点扩展到 3+n 个节点，则还需要进行分区重新分配。（注意：此步骤仅在此特定情况下需要，在其他情况下不需要。）

步骤 1：进入 cpaas-kafka-0 容器（或其他 Kafka 实例；通常选择第一个）。

```shell
kubectl exec -it -n cpaas-system cpaas-kafka-0 -- bash

bash-5.1$ cd /tmp
```

步骤 2：生成用于分区重新分配的 Kafka 配置文件 client.cfg。

(2.1）获取 Kafka 用户名和密码：

```shell
bash-5.1$ cat /opt/kafka/conf/kafka_server_jaas.conf

KafkaServer {
    org.apache.kafka.common.security.plain.PlainLoginModule required
    username="dBodNvjT"
    password="oC6viKVmKtzYpOKH7f8DWOmC15wWxg38"
    user_dBodNvjT="oC6viKVmKtzYpOKH7f8DWOmC15wWxg38";
};
Client {
    org.apache.zookeeper.server.auth.DigestLoginModule required
    username="dBodNvjT"
    password="oC6viKVmKtzYpOKH7f8DWOmC15wWxg38";
};
```

(2.2) 创建 client.cfg 并替换用户名/密码字段（用户名替换一次，密码替换四次）：

```shell
bash-5.1$ cat <<EOF> client.cfg
security.protocol=sasl_ssl
 
ssl.endpoint.identification.algorithm=
ssl.keystore.location=/opt/kafka/config/certs/keystore.jks
ssl.keystore.password=STTTzrX4YmkTeCgc5zLycZGXjMafpouU
ssl.key.password=STTTzrX4YmkTeCgc5zLycZGXjMafpouU
ssl.truststore.location=/opt/kafka/config/certs/truststore.jks
ssl.truststore.password=STTTzrX4YmkTeCgc5zLycZGXjMafpouU
ssl.client.auth=required
ssl.enabled.protocols=TLSv1.2
ssl.cipher.suites=TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
ssl.keystore.type=JKS
ssl.truststore.type=JKS
ssl.secure.random.implementation=SHA1PRNG
 
sasl.mechanism=PLAIN
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="VhwgyZj7" password="STTTzrX4YmkTeCgc5zLycZGXjMafpouU";
EOF
```

步骤 3：检查当前主题状态（例如，ALAUDA_LOG_TOPIC）以供参考：

```shell
bash-5.1$ /opt/kafka/bin/kafka-topics.sh --describe --bootstrap-server cpaas-kafka:9092 --command-config ./client.cfg --topic ALAUDA_LOG_TOPIC
```

步骤 4：创建主题列表文件 topic-generate.json（平台使用的 6 个默认主题）：

```shell
bash-5.1$ cat <<EOF> topic-generate.json
{
  "topics": [
    {
      "topic": "ALAUDA_AUDIT_TOPIC"
    },
    {
      "topic": "ALAUDA_EVENT_TOPIC"
    },
    {
      "topic": "ALAUDA_LOG_TOPIC"
    },
    {
      "topic": "cpaas-devops-pipeline-item"
    },
    {
      "topic": "cpaas-devops-pipeline-log"
    },
    {
      "topic": "cpaas-devops-pipeline-unittest"
    }
   ],
  "version": 1
}
EOF
```

步骤 5：生成分区分配 JSON 文件。此命令将生成当前分区分配 JSON 和推荐分配 JSON。将输出保存到各自的文件中。old-assign.json 用作回滚的备份。

!!!注意：--broker-list 参数需要替换为从每个实例的 /kafka0/meta.properties 文件中提取的值

```shell
bash-5.1$ /opt/kafka/bin/kafka-reassign-partitions.sh --bootstrap-server cpaas-kafka:9092 --topics-to-move-json-file topic-generate.json --broker-list "1100,1101,1102,1103,1104" --generate --command-config ./client.cfg
bash-5.1$ cat <<EOF> old-assign.json # 从上面的命令输出中获取 "Current partition" 下的 JSON 内容
xxxxxx
EOF
bash-5.1$ cat <<EOF> new-assign.json # 从上面的命令输出中获取 "Proposed partition" 下的 JSON 内容
{"version":1,"partitions":[{"topic":"ALAUDA_AUDIT_TOPIC","partition":0,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":1,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":2,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":3,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":4,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":5,"replicas":[1102,1101,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":6,"replicas":[1103,1102,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":7,"replicas":[1104,1103,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":8,"replicas":[1100,1104,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":9,"replicas":[1101,1100,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":10,"replicas":[1102,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":11,"replicas":[1103,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":12,"replicas":[1104,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":13,"replicas":[1100,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":14,"replicas":[1101,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":15,"replicas":[1102,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":16,"replicas":[1103,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":17,"replicas":[1104,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":18,"replicas":[1100,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":19,"replicas":[1101,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":20,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":21,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":22,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":23,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":24,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":25,"replicas":[1102,1101,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":26,"replicas":[1103,1102,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":27,"replicas":[1104,1103,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":28,"replicas":[1100,1104,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":29,"replicas":[1101,1100,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":0,"replicas":[1101,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":1,"replicas":[1102,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":2,"replicas":[1103,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":3,"replicas":[1104,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":4,"replicas":[1100,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":5,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":6,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":7,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":8,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":9,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":10,"replicas":[1101,1100,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":11,"replicas":[1102,1101,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":12,"replicas":[1103,1102,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":13,"replicas":[1104,1103,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":14,"replicas":[1100,1104,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":15,"replicas":[1101,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":16,"replicas":[1102,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":17,"replicas":[1103,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":18,"replicas":[1104,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":19,"replicas":[1100,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":20,"replicas":[1101,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":21,"replicas":[1102,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":22,"replicas":[1103,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":23,"replicas":[1104,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":24,"replicas":[1100,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":25,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":26,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":27,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":28,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":29,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]}]}
EOF
```

步骤 6：使用指定的 JSON 文件执行分区重新分配

```shell
bash-5.1$ /opt/kafka/bin/kafka-reassign-partitions.sh --bootstrap-server cpaas-kafka:9092 --reassignment-json-file new-assign.json --execute --command-config ./client.cfg
```

步骤 7：监控重新分配进度。当所有分区显示为“完成”状态时，过程完成。

```shell
bash-5.1$ /opt/kafka/bin/kafka-reassign-partitions.sh --bootstrap-server cpaas-kafka:9092 --reassignment-json-file new-assign.json --verify --command-config ./client.cfg
```
