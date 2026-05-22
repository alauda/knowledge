---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# RabbitMQ Data Migration

## Introduction

Common RabbitMQ migration scenarios include:

1. replicating one queue to other nodes in the same cluster
2. migrating data from one RabbitMQ cluster to another
3. exporting queue data to a file and importing it later
4. loading data into RabbitMQ from a database-driven workflow

## Queue Replication Inside One Cluster

Classic HA-style queue replication can be configured with a policy such as:

```json
{
  "policies": [
    {
      "vhost": "/",
      "name": "test-ha",
      "pattern": "test-ha",
      "apply-to": "queues",
      "definition": {
        "ha-mode": "all"
      },
      "priority": 0
    }
  ]
}
```

Use this only when the queue model and RabbitMQ version still support the intended HA behavior.

## Cluster-to-Cluster Migration with Shovel

Shovel can move data from a source cluster to a destination cluster.

Basic flow:

1. create source and destination clusters
2. enable shovel plugins on one side
3. create source exchange and backup queue
4. create matching target exchange and queue
5. configure a shovel from the source queue to the target exchange or queue
6. verify message arrival on the destination side

This model is suitable for migration windows and also forms the base of the hot standby DR solution.

## Export Queue Data to a File

One tool previously used for file export and import is `node-amqp-tool`:

```bash
amqp-tool --host <host> --port <port> --user <user> --password <password> \
  --queue <queue> --export > dump.json

amqp-tool --host <host> --port <port> --user <user> --password <password> \
  --queue <queue> --import dump.json
```

Limitations:

- the tool is not actively maintained
- export consumes the queue like a normal consumer
- format compatibility is limited
- exported files include extra metadata and can become much larger than the raw message payloads

## Database-to-RabbitMQ Import

Possible patterns include:

- database extensions that publish directly to RabbitMQ
- RabbitMQ plugins that react to database notifications
- database triggers that publish or notify on insert and update

Risks:

- database extensions may not be supported by the platform operator
- triggers can affect database performance
- custom RabbitMQ plugins usually require custom images and additional validation

## Recommendation

If the business can drain the source queue backlog before cutover, prefer direct cutover to a new cluster. Use message migration only when backlog must be preserved.
