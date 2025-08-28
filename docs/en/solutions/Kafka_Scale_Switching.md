---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# Kafka Scale Switching

## Background

After ACP 3.18, the Log Storage Plugin no longer supports scaling Kafka during plugin updates. Manual intervention is required if scaling is needed.

## Applicable Version

4.0.x,4.1.x

## Kafka Scaling Steps

Prepare the Kafka nodes to be scaled and follow the three-step procedure below:

Step 1: Log into the global master node and locate the moduleinfo resource of the log storage plugin for the target cluster.

```shell
➜ kubectl get moduleinfo | grep logcenter | grep <cluster_name>          
global-e671599464a5b1717732c5ba36079795   global    logcenter             logcenter                           Processing   v3.19.0-fix.359.1.g991a35b1-feat   v3.19.0-fix.359.1.g991a35b1-feat   v3.19.0-fix.359.1.g991a35b1-feat
```

Step 2: Manually edit the resource to add the names of the Kafka nodes to be scaled. Refer to the comment examples for the correct placement.

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
        k8sNodes:             # Add the scaled node names to the specified array.
        - 192.168.179.86   
        - 192.168.178.182
        - 192.168.179.33
        port: 9092
        storageSize: 10
        tls: true
        zkElectPort: 3888
        zkExporterPort: 9141
        zkLeaderPort: 2888
        zkPort: 2181
```

Step 3: Wait for the log storage plugin update to complete. Verify that Kafka is ready and check if logs are being collected normally.

```shell
kubectl get pods -n cpaas-system | grep kafka 
cpaas-kafka-0                                                 1/1     Running     0             6m54s
cpaas-kafka-1                                                 1/1     Running     0             7m49s
cpaas-kafka-2                                                 1/1     Running     0             7m49s
```

Note: If Kafka pods are Running but the Kafka cluster is not functioning, manually restart both Kafka and ZooKeeper instances once after scaling completes.

The steps below are optional—only perform them if the above issue occurs. After restarting, recheck log collection once pods are Running again.

```shell
kubectl delete pods -n cpaas-system -l 'service_name in (cpaas-zookeeper, cpaas-kafka)'
pod "cpaas-kafka-0" deleted
pod "cpaas-kafka-1" deleted
pod "cpaas-kafka-2" deleted
pod "cpaas-zookeeper-0" deleted
pod "cpaas-zookeeper-1" deleted
pod "cpaas-zookeeper-2" deleted
```

## Steps for Kafka Partition Reassignment

If Kafka is scaled from 3 nodes to 3+n nodes, partition reassignment is also required. (Note: This step is only needed in this specific scenario, not in other cases.)

Step 1: Enter the cpaas-kafka-0 container (or another Kafka instance; the first one is typically chosen).

```shell
kubectl exec -it -n cpaas-system cpaas-kafka-0 -- bash

bash-5.1$ cd /tmp
```

Step 2: Generate the Kafka configuration file client.cfg for partition reassignment.

(2.1）Retrieve the Kafka username and password:

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

(2.2) Create client.cfg and replace the username/password fields (replace username once and password four times):

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

Step 3: Check the current topic status (e.g., ALAUDA_LOG_TOPIC) for reference:

```shell
bash-5.1$ /opt/kafka/bin/kafka-topics.sh --describe --bootstrap-server cpaas-kafka:9092 --command-config ./client.cfg --topic ALAUDA_LOG_TOPIC
```

Step 4: Create the topic list file topic-generate.json (6 default topics used by the platform):

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

Step 5: Generate partition assignment json files. This command will produce both the current partition assignment JSON and the recommended assignment JSON. Save the outputs to respective files. The old-assign.json serves as backup for rollback purposes.

!!!NOTE: The --broker-list parameter needs to be replaced with values extracted from each instance's /kafka0/meta.properties file

```shell
bash-5.1$ /opt/kafka/bin/kafka-reassign-partitions.sh --bootstrap-server cpaas-kafka:9092 --topics-to-move-json-file topic-generate.json --broker-list "1100,1101,1102,1103,1104" --generate --command-config ./client.cfg
bash-5.1$ cat <<EOF> old-assign.json # The JSON content under "Current partition" from the command output above
xxxxxx
EOF
bash-5.1$ cat <<EOF> new-assign.json # The JSON content under "Proposed partition" from the command output above
{"version":1,"partitions":[{"topic":"ALAUDA_AUDIT_TOPIC","partition":0,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":1,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":2,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":3,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":4,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":5,"replicas":[1102,1101,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":6,"replicas":[1103,1102,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":7,"replicas":[1104,1103,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":8,"replicas":[1100,1104,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":9,"replicas":[1101,1100,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":10,"replicas":[1102,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":11,"replicas":[1103,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":12,"replicas":[1104,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":13,"replicas":[1100,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":14,"replicas":[1101,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":15,"replicas":[1102,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":16,"replicas":[1103,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":17,"replicas":[1104,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":18,"replicas":[1100,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":19,"replicas":[1101,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":20,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":21,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":22,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":23,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":24,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":25,"replicas":[1102,1101,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":26,"replicas":[1103,1102,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":27,"replicas":[1104,1103,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":28,"replicas":[1100,1104,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_AUDIT_TOPIC","partition":29,"replicas":[1101,1100,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":0,"replicas":[1101,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":1,"replicas":[1102,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":2,"replicas":[1103,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":3,"replicas":[1104,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":4,"replicas":[1100,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":5,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":6,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":7,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":8,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":9,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":10,"replicas":[1101,1100,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":11,"replicas":[1102,1101,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":12,"replicas":[1103,1102,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":13,"replicas":[1104,1103,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":14,"replicas":[1100,1104,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":15,"replicas":[1101,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":16,"replicas":[1102,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":17,"replicas":[1103,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":18,"replicas":[1104,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":19,"replicas":[1100,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":20,"replicas":[1101,1103,1104],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":21,"replicas":[1102,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":22,"replicas":[1103,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":23,"replicas":[1104,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":24,"replicas":[1100,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":25,"replicas":[1101,1104,1100],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":26,"replicas":[1102,1100,1101],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":27,"replicas":[1103,1101,1102],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":28,"replicas":[1104,1102,1103],"log_dirs":["any","any","any"]},{"topic":"ALAUDA_EVENT_TOPIC","partition":29,"replicas":[1100,1103,1104],"log_dirs":["any","any","any"]}]}
EOF
```

Step 6: Execute partition reassignment using the specified JSON file

```shell
bash-5.1$ /opt/kafka/bin/kafka-reassign-partitions.sh --bootstrap-server cpaas-kafka:9092 --reassignment-json-file new-assign.json --execute --command-config ./client.cfg
```

Step 7: Monitor reassignment progress. The process completes when all partitions show "completed" status

```shell
bash-5.1$ /opt/kafka/bin/kafka-reassign-partitions.sh --bootstrap-server cpaas-kafka:9092 --reassignment-json-file new-assign.json --verify --command-config ./client.cfg
```

