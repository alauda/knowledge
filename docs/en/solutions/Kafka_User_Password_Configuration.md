---
products:
  - Alauda Container Platform
kind:
  - Solution
id: KB1776670415-KAFU
---

# Kafka User Password Configuration

## Background

By default the Alauda middleware operator (`rds-operator`) delegates SCRAM-SHA-512 credential generation to the Strimzi User Operator, which produces a random password when a `KafkaUser` is created. Some use cases — migrations from an existing Kafka cluster, integrations with external systems that already have a fixed password, or centrally managed credential rotation — require setting a known password on the user and rotating it on demand.

Starting with ACP 3.15, `RdsKafkaUser` exposes `spec.authentication.password.valueFrom.secretKeyRef` so a user's SCRAM-SHA-512 password can be sourced from a user-managed `Secret`. Updating the `Secret` together with a `changePasswordTimestamp` annotation on the `RdsKafkaUser` triggers an in-place rotation.

## Applicable Version

Verified on ACP 4.2.x (rds-operator `v4.2.0`, Kafka `4.1.1`). The `password.valueFrom.secretKeyRef` field was introduced in rds-operator 3.15, so earlier ACP releases that bundle a rds-operator >= 3.15 support the same flow.

## Prerequisites

The target `RdsKafka` cluster must have a listener with SCRAM-SHA-512 authentication and authorization enabled so user credentials and ACLs are enforced:

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafka
metadata:
  name: my-cluster
spec:
  kafka:
    listeners:
      plain:
        authentication:
          type: scram-sha-512
    authorization:
      type: simple
  # ... other fields omitted
```

Note: `kafka.authorization.type: simple` is required for per-user ACLs to take effect. Without it, a `KafkaUser`'s ACL rules are accepted but not enforced by the brokers.

## Steps

### 1. Create the password Secret

The `Secret` must live in the same namespace as the `RdsKafka` instance. The `password` field is base64-encoded:

```shell
# base64 of 'Passw0rd123!'
kubectl -n <ns> create secret generic my-user-password \
  --from-literal=password='Passw0rd123!'
```

Equivalent declarative form:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-user-password
  namespace: <ns>
type: Opaque
data:
  password: UGFzc3cwcmQxMjMh
```

### 2. Create the RdsKafkaUser

Create the user with `authentication.type: scram-sha-512` and reference the password `Secret`. The cluster binding uses the label `middleware.alauda.io/cluster: <rdskafka-name>`:

```yaml
apiVersion: middleware.alauda.io/v1
kind: RdsKafkaUser
metadata:
  name: my-user
  namespace: <ns>
  labels:
    middleware.alauda.io/cluster: my-cluster
spec:
  authentication:
    type: scram-sha-512
    password:
      valueFrom:
        secretKeyRef:
          name: my-user-password
          key: password
  authorization:
    type: simple
    acls:
      - host: '*'
        operation: All
        resource:
          name: '*'
          patternType: literal
          type: topic
```

> Use the kind `RdsKafkaUser` (group `middleware.alauda.io/v1`), not the downstream Strimzi `KafkaUser`. The operator owns the Strimzi object and overwrites any user edits to it. The cluster label key is `middleware.alauda.io/cluster`; the operator translates this to `strimzi.io/cluster` on the downstream `KafkaUser`.

### 3. Verify reconcile

```shell
kubectl -n <ns> get rdskafkauser my-user -o jsonpath='{.status.phase}'
# Active

kubectl -n <ns> get kafkauser my-user -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
# True
```

The Strimzi User Operator publishes a same-named `Secret` that contains the SASL/JAAS config with the configured password:

```shell
kubectl -n <ns> get secret my-user -o jsonpath='{.data.sasl\.jaas\.config}' | base64 -d
# org.apache.kafka.common.security.scram.ScramLoginModule required username="my-user" password="Passw0rd123!";
```

Client applications can mount this `Secret` directly to obtain a ready-to-use JAAS configuration.

### 4. Rotate the password

Update the password `Secret` and set the `changePasswordTimestamp` annotation on the `RdsKafkaUser`. The operator reconciles the downstream `KafkaUser` within seconds, and the Strimzi User Operator then republishes the SASL credentials:

```shell
NEW_B64=$(printf '%s' 'NewRotated456!' | base64)
kubectl -n <ns> patch secret my-user-password \
  -p "{\"data\":{\"password\":\"$NEW_B64\"}}"

kubectl -n <ns> annotate rdskafkauser my-user \
  "changePasswordTimestamp=$(date +%s)" --overwrite
```

After rotation, clients using the old password fail with `SaslAuthenticationException: Authentication failed during authentication due to invalid credentials with SASL mechanism SCRAM-SHA-512`. Clients using the new password authenticate successfully.

## Notes

- The password `Secret` is automatically tagged with an `OwnerReference` to the `RdsKafkaUser`. Deleting the `RdsKafkaUser` garbage-collects the password `Secret` along with it.
- `spec.authentication.type` accepts only `tls` or `scram-sha-512`. TLS authentication (mutual TLS) uses a different credential flow and does not consume the `password` field.
- When the Strimzi User Operator processes the downstream `KafkaUser`, it may emit `DeprecatedFields` or `UnknownFields` status conditions regarding the ACL schema (`operation` vs `operations`, and `resource.name`/`resource.patternType`). These are warnings and do not prevent the user from becoming `Ready`.

## OCP Parity

Red Hat OpenShift Container Platform uses AMQ Streams (the productized Strimzi distribution) for Kafka. The same capability is exposed natively on the upstream `KafkaUser` resource:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: my-user
  labels:
    strimzi.io/cluster: my-cluster
spec:
  authentication:
    type: scram-sha-512
    password:
      valueFrom:
        secretKeyRef:
          name: my-user-password
          key: password
  authorization:
    type: simple
    acls:
      - resource:
          type: topic
          name: '*'
          patternType: literal
        operations: [All]
        host: '*'
```

Key differences when migrating between platforms:

| Aspect | ACP (`RdsKafkaUser`) | OCP / AMQ Streams (`KafkaUser`) |
| --- | --- | --- |
| API group / kind | `middleware.alauda.io/v1` `RdsKafkaUser` | `kafka.strimzi.io/v1beta2` `KafkaUser` |
| Cluster binding label | `middleware.alauda.io/cluster` | `strimzi.io/cluster` |
| Password `secretKeyRef` field | Identical (`spec.authentication.password.valueFrom.secretKeyRef`) | Identical |
| Rotation trigger | `changePasswordTimestamp` annotation on `RdsKafkaUser` | Update the password `Secret`; the User Operator re-syncs automatically. A no-op annotation change on the `KafkaUser` can force an immediate reconcile. |
| ACL schema | Single `operation` + `resource.{name,patternType,type}` (translated to Strimzi) | `operations` array + `resource.{type,name,patternType}` |
| Ownership of password `Secret` | Operator sets `OwnerReference` to `RdsKafkaUser` | No default owner reference; application-managed lifecycle |

The credential flow on the broker side is unchanged: the User Operator writes the SCRAM credentials into Kafka and publishes a `Secret` containing `sasl.jaas.config` for clients to consume. Moving an existing `KafkaUser` manifest from OCP to ACP is a mechanical rewrite of the `kind`, `apiVersion`, cluster label, and ACL shape — no behavioral differences in authentication or rotation.
