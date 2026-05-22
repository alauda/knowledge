---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# How to Use RabbitMQ Plugins

## Introduction

RabbitMQ plugins extend the broker with additional protocols, monitoring, management, routing behavior, and integration features.

Operator-created RabbitMQ instances typically enable these plugins by default:

- `rabbitmq_peer_discovery_k8s`
- `rabbitmq_prometheus`
- `rabbitmq_management`

## Check Plugin Status

Run the following command in a RabbitMQ pod:

```bash
rabbitmq-plugins list
```

An enabled plugin is shown with an enabled marker in the command output.

## Enable Built-In Plugins

Add the plugin names to `spec.rabbitmq.additionalPlugins`:

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_top
      - rabbitmq_shovel
```

Verify after the pod is ready:

```bash
rabbitmq-plugins list
```

## Common Plugin Categories

| Category | Examples |
| --- | --- |
| Management | `rabbitmq_management`, `rabbitmq_management_agent` |
| Monitoring | `rabbitmq_prometheus` |
| Discovery | `rabbitmq_peer_discovery_k8s`, `rabbitmq_peer_discovery_aws` |
| Replication | `rabbitmq_shovel`, `rabbitmq_federation` |
| Protocols | `rabbitmq_mqtt`, `rabbitmq_amqp1_0`, `rabbitmq_web_stomp` |
| Exchange extensions | `rabbitmq_consistent_hash_exchange`, `rabbitmq_delayed_message_exchange` |

## Enable Community or Custom Plugins

If the plugin is not already packaged in the RabbitMQ image, placing the name in `additionalPlugins` is not enough. The plugin file must exist in the container before RabbitMQ starts.

### Method 1: Download in an Init Container

Use an init container to download the `.ez` plugin file into a shared volume and extend `RABBITMQ_PLUGINS_DIR`.

```yaml
spec:
  rabbitmq:
    additionalPlugins:
      - rabbitmq_management_exchange
    envConfig: |
      RABBITMQ_PLUGINS_DIR=/opt/rabbitmq/plugins:/opt/rabbitmq/community-plugins
  override:
    statefulSet:
      spec:
        template:
          spec:
            volumes:
              - name: community-plugins
                emptyDir: {}
            initContainers:
              - name: copy-community-plugins
                image: curlimages/curl
                command:
                  - sh
                  - -c
                  - curl -L https://<plugin-url> --output /community-plugins/<plugin>.ez
                volumeMounts:
                  - name: community-plugins
                    mountPath: /community-plugins
            containers:
              - name: rabbitmq
                volumeMounts:
                  - name: community-plugins
                    mountPath: /opt/rabbitmq/community-plugins
```

### Method 2: Mount Plugin Files from the Node

If the environment cannot download from the internet, mount the plugin directory from the node and copy it into a writable shared volume before RabbitMQ starts.

This method requires:

- plugin files already present on the selected nodes
- node-level directory management
- stricter scheduling control

## Recommendations

- Keep plugin sets minimal.
- Validate plugin compatibility with the RabbitMQ version in use.
- Apply the same required plugin set to target clusters used for migration or DR.
- Treat community plugins as application dependencies and test them before production rollout.
