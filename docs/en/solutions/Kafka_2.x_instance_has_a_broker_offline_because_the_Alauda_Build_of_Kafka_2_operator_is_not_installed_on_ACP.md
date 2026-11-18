---
kind:
  - Troubleshooting
products:
  - Alauda Application Services
ProductsVersion: []
---

# Kafka 2.x instance has a broker offline because the Alauda Build of Kafka 2 operator is not installed on ACP

## Issue

One broker of a Data Services Kafka instance is reported offline ("a Kafka broker node is not online"). The instance runs Kafka 2.x (for example 2.7). The other brokers may still be running.

This is an application-facing Kafka instance, not the platform log Kafka (`cpaas-kafka-*` in `cpaas-system`). For the platform log Kafka, see [Platform log Kafka brokers fail: no leader election, exit 137, Pending on DiskPressure, Ceph write errors, or OOM on ACP](Platform_log_Kafka_brokers_fail_no_leader_election_exit_137_Pending_on_DiskPressure_Ceph_write_errors_or_OOM_on_ACP.md).

## Root Cause

A Kafka 2.x instance is managed by the **Alauda Build of Kafka 2** operator. When that operator is not installed on the cluster, nothing reconciles the instance, so a broker that goes down is not brought back.

Operator version `v4.0.3` of Alauda Build of Kafka 2 supports platform versions `v4.0` and `v4.1`, and Kafka `2.5`, `2.7`, and `2.8`.

## Resolution

1. Confirm the Kafka version of the instance and that the operator is missing (see Diagnostic Steps).
2. In the application marketplace (OperatorHub), check the Alauda Build of Kafka 2 operator versions and pick the one whose supported platform and Kafka versions match this cluster and this instance.
3. If the operator package is not yet on the platform, push it with the `violet` tool version that matches the operator package, not the `violet` version shipped with the platform.
4. Install the Alauda Build of Kafka 2 operator and wait until it reports success.
5. Restart the Kafka instance so the operator takes it over and brings the offline broker back.

   > **Warning:** Restarting the Kafka instance interrupts producers and consumers of that instance while its brokers restart. Precondition: the operator is installed and healthy, and the instance's applications can tolerate the interruption (do it in a maintenance window). Rollback: none needed for the restart itself; the operator recreates the broker pods.

   ```bash
   kubectl -n <namespace> get pods -o wide | grep <kafka-instance>
   kubectl -n <namespace> delete pod <kafka-broker-pod>
   ```

   Restart the brokers one at a time and wait for each to be `Running` and ready before the next.

6. Check that every broker of the instance is online.

## Diagnostic Steps

1. Find the instance, its namespace, and the broker that is offline:

   ```bash
   kubectl get pods -A -o wide | grep -iE 'kafka|zookeeper'
   kubectl -n <namespace> logs -p <kafka-broker-pod> --tail=50
   ```

2. Check whether the Kafka 2 operator is installed (no matching ClusterServiceVersion, or no operator pod, means it is missing):

   ```bash
   kubectl get csv -A | grep -i kafka
   kubectl get pods -A | grep -i kafka | grep -i operator
   ```

3. Read the Kafka version of the instance from its custom resource or broker image, and compare it with the Kafka versions the available operator version supports.
4. If the operator is installed and healthy and a broker is still offline, the cause is elsewhere: check the broker pod events, its node, and its volume (for example a node that is `NotReady` or a volume that is full).
