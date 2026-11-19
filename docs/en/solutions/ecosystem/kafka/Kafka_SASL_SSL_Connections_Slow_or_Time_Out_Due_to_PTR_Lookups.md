---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - 3.x
---

# Kafka Connections Using `SASL_SSL` Are Slow or Time Out Due to Reverse DNS Lookups

:::info Applicable Versions
This issue was reproduced with Apache Kafka 2.7.0 managed by Strimzi 0.25.0. It can affect Kafka versions in which the `SASL_SSL` channel builder performs a Domain Name System (DNS) lookup for a pointer record (PTR record) during connection registration. Apache Kafka fixes KAFKA-8562 in versions 2.7.2, 2.8.1, and 3.0.0.
:::

## Issue

External clients intermittently cannot connect to one or more Kafka brokers through Pod Internet Protocol (IP) addresses, ClusterIP, or NodePort endpoints. After DNS is partially corrected, clients might be able to connect but still report slow connection establishment, metadata timeouts, or repeated reconnects.

Typical observations include:

- Some brokers accept connections while other brokers time out.
- The Kafka pods remain `Running` and `Ready`.
- CPU, memory, and garbage collection dashboards do not show resource exhaustion.
- Port `9094` is listening, but even a TCP connection to `127.0.0.1:9094` from inside the affected broker pod can time out.
- Kafka repeatedly logs messages similar to:

  ```text
  Failed authentication with <peer-address> (SSL handshake failed)
  ```

- The TCP accept queue for port `9094` remains at or near `51`:

  ```text
  accept_queue=51 raw=00000000:00000033
  ```

In the reproduced environment, the external listener used `SASL_SSL` with `SCRAM-SHA-512`. Each broker had three Kafka network processor threads.

## Background

`SASL_SSL` combines Transport Layer Security (TLS) encryption with Simple Authentication and Security Layer (SASL) authentication. In this case, SASL used the Salted Challenge Response Authentication Mechanism (SCRAM) with the Secure Hash Algorithm 512 (SHA-512), represented by the Kafka configuration token `SCRAM-SHA-512`. Authorization is evaluated later and is not involved in the initial reverse DNS lookup.

For a server-side accepted connection, Kafka looks up the peer IP address visible on the socket. This address is not necessarily the original application IP:

- A direct Pod-to-Pod connection normally presents the client Pod IP.
- A NodePort connection can present a node, Container Network Interface (CNI), or source network address translation (SNAT) address after Kubernetes networking translates the source address.
- A TCP probe can also appear as a client connection.

The lookup does not resolve the hostname that the client used as its Kafka bootstrap address. It performs a PTR lookup for the source IP that the broker sees after networking and source address translation have been applied.

CoreDNS does not create PTR records for every existing Pod. The CoreDNS `kubernetes` plugin creates PTR records for Pods selected by a Service. The `pods insecure` option controls IP-based Pod A records and does not create a PTR record for every Pod IP.

## Environment

The reproduced environment had the following relevant characteristics:

- Apache Kafka 2.7.0
- Strimzi Cluster Operator
- Three Kafka brokers
- External NodePort listener on port `9094`
- `SASL_SSL` security protocol
- `SCRAM-SHA-512` authentication
- CoreDNS as the cluster DNS service
- Classless Inter-Domain Routing (CIDR) Pod range `192.168.0.0/16`
- CoreDNS forwarding unmatched queries to `/etc/resolv.conf`
- CoreDNS nodes forwarding internal PTR queries to a public upstream resolver that was unreachable for the Pod reverse zone, so those lookups timed out instead of returning a fast negative answer

The specific addresses and resource names in the commands below are examples. Replace them with values from the target environment.

## Diagnosis

### 1. Confirm the Listener and Advertised Endpoints

Check the broker pods, Services, Pod IPs, nodes, and NodePorts:

```bash
kubectl -n <namespace> get pod -o wide | grep '<cluster-name>-kafka'
kubectl -n <namespace> get svc -o wide | grep '<cluster-name>-kafka'
```

Check the generated Kafka configuration:

```bash
kubectl -n <namespace> exec <broker-pod> -c kafka -- \
  grep -E '^(listeners|advertised.listeners|listener.security.protocol.map|num.network.threads)=' \
  /tmp/strimzi.properties
```

The affected listener normally contains entries similar to:

```properties
listeners=EXTERNAL-9094://0.0.0.0:9094
listener.security.protocol.map=EXTERNAL-9094:SASL_SSL
num.network.threads=3
```

Pod IPs can change after rescheduling. Do not use an old Pod IP when validating the current endpoint. NodePorts normally remain associated with the broker ordinal.

### 2. Test the Listener from Inside Each Broker

This test isolates Kafka socket acceptance from Service, NodePort, routing, and firewall behavior:

```bash
for i in 0 1 2; do
  echo "===== kafka-$i ====="
  kubectl -n <namespace> exec <cluster-name>-kafka-$i -c kafka -- \
    timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/9094'
  echo "tcp_exit_code=$?"
done
```

Interpret the result:

- `0`: TCP connection established.
- `124`: the local connection timed out.

A timeout to `127.0.0.1:9094` while the port is listening rules out the external network as the sole cause. It indicates that Kafka is not accepting new connections quickly enough.

### 3. Inspect the Kernel Accept Queue

If `ss` is available:

```bash
kubectl -n <namespace> exec <broker-pod> -c kafka -- \
  bash -c 'ss -lnt | awk "NR == 1 || \$4 ~ /:9094$/"'
```

For a listening socket, `Recv-Q` is the current accept queue and `Send-Q` is the configured backlog limit.

If the Kafka image does not contain `ss`, read `/proc/net/tcp`. Port `9094` is hexadecimal `2386`:

```bash
for i in 0 1 2; do
  printf "kafka-%s " "$i"

  kubectl -n <namespace> exec <cluster-name>-kafka-$i -c kafka -- bash -c '
    set -- $(grep -i ":2386 " /proc/net/tcp | grep " 0A " | head -1)
    q=$5

    if [ -z "$q" ]; then
      echo "9094_LISTEN_NOT_FOUND"
    else
      rx=${q#*:}
      printf "accept_queue=%d raw=%s\n" "$((16#$rx))" "$q"
    fi
  '
done
```

`00000000:00000033` means that the receive/accept queue contains hexadecimal `0x33`, or 51 connections. A queue that remains at 51 confirms sustained saturation. A healthy idle listener should normally remain close to zero; short bursts are acceptable if the queue drains quickly.

Increasing the backlog can allow more connections to wait, but it does not resolve blocked Kafka processor threads.

### 4. Exclude File Descriptor and JVM Resource Exhaustion

Check the Kafka process and file descriptor limits:

```bash
kubectl -n <namespace> exec <broker-pod> -c kafka -- bash -c '
  pid=$(pgrep -f "kafka.Kafka" | head -1)
  echo "kafka_pid=$pid"
  echo "fd_count=$(find /proc/$pid/fd -mindepth 1 -maxdepth 1 | wc -l)"
  grep -i "open files" /proc/$pid/limits
'
```

Also review the Kafka dashboard for CPU, heap, memory, and garbage collection pressure. In the reproduced case, file descriptor usage was low relative to the process limit, and the JVM resource graphs were normal.

### 5. Capture a JVM Thread Dump While the Queue Is Full

Send `SIGQUIT` to the Kafka JVM. On HotSpot, this writes a thread dump to the container log and does not terminate the JVM:

```bash
for i in 0 1 2; do
  kubectl -n <namespace> exec <cluster-name>-kafka-$i -c kafka -- bash -c '
    pid=$(pgrep -f "kafka.Kafka" | head -1)
    echo "kafka_pid=$pid"
    kill -3 "$pid"
  '
done

sleep 5
```

Extract the external listener stacks:

```bash
for i in 0 1 2; do
  echo "===== kafka-$i EXTERNAL-9094 ====="
  kubectl -n <namespace> logs <cluster-name>-kafka-$i \
    -c kafka --since=2m |
    grep -nE -A18 \
    'ListenerName\(EXTERNAL-9094\)|getHostByAddr|assignNewConnection|ArrayBlockingQueue.put'
done
```

Affected processor threads show these key frames (condensed — a full `jstack` also shows `SaslChannelBuilder.buildChannel`, `Selector.buildAndAttachKafkaChannel`, and `Selector.registerChannel` between `buildTransportLayer` and `Selector.register`, plus `Processor.run` beneath `configureNewConnections`):

```text
java.net.Inet4AddressImpl.getHostByAddr
java.net.InetAddress.getHostName
org.apache.kafka.common.network.SaslChannelBuilder.buildTransportLayer
org.apache.kafka.common.network.Selector.register
kafka.network.Processor.configureNewConnections
```

The external listener Acceptor can show:

```text
java.util.concurrent.ArrayBlockingQueue.put
kafka.network.Processor.accept
kafka.network.Acceptor.assignNewConnection
```

This thread state is not a Java monitor deadlock. The processor appears `RUNNABLE` because it is blocked in a native DNS resolver call. The Acceptor then blocks while trying to place another connection into a full processor connection queue.

### 6. Measure Reverse DNS Latency from the Kafka Pod

Test all peer IP ranges observed in Kafka logs or `/proc/net/tcp`, including Pod IPs and node/CNI/SNAT addresses:

```bash
kubectl -n <namespace> exec <broker-pod> -c kafka -- bash -c '
  TIMEFORMAT="elapsed=%3R sec"

  for ip in <peer-ip-1> <peer-ip-2> <peer-ip-3>; do
    echo "===== PTR $ip ====="
    { time timeout 6 getent hosts "$ip"; } 2>&1
    echo "exit_code=$?"
  done
'
```

Interpret the result:

- `exit_code=0`, returned in milliseconds: a name was found quickly.
- `exit_code=2`, returned in milliseconds: no name exists, but the negative response is fast.
- `exit_code=2`, returned after several seconds: the negative lookup followed a timeout or retry path.
- `exit_code=124`: the lookup did not finish before the command timeout.

`getent` reports only the Name Service Switch result. Use `dig` to distinguish `NXDOMAIN`, `SERVFAIL`, and a DNS timeout:

```bash
dig @<cluster-dns-service-ip> -x <peer-ip> \
  +time=2 +tries=1 \
  +noall +comments +answer +authority +stats
```

In the reproduced case, reverse lookup of unknown Pod/CNI addresses consistently took approximately four seconds before returning no result.

### 7. Inspect CoreDNS Resolution Flow

Check the CoreDNS ConfigMap:

```bash
kubectl -n kube-system get configmap <coredns-configmap> -o yaml
```

The problematic configuration was equivalent to:

```text
kubernetes cluster.local in-addr.arpa ip6.arpa {
    pods insecure
    fallthrough in-addr.arpa ip6.arpa
    ttl 30
}

forward . /etc/resolv.conf
```

For an unknown Pod PTR:

1. The `kubernetes` plugin did not find a PTR record.
2. `fallthrough in-addr.arpa` passed the query to the next plugin.
3. `forward . /etc/resolv.conf` sent the internal reverse lookup to the node resolver.
4. The upstream resolver was unreachable for the internal Pod reverse zone, so the forwarded query received no fast answer.
5. The query waited on the resolver timeout and retry path, adding several seconds to each new Kafka connection.

A reachable resolver that is simply not authoritative for the Pod reverse zone usually returns a fast `NXDOMAIN` or `REFUSED`. The sustained multi-second wait is a timeout signature, which indicates the upstream was effectively unreachable for these internal reverse queries.

If the CoreDNS `log` plugin is enabled, inspect recent PTR requests:

```bash
for pod in $(kubectl -n kube-system get pod -o name | grep '/coredns-'); do
  echo "===== $pod ====="
  kubectl -n kube-system logs "$pod" --since=10m |
    grep '"PTR IN ' |
    tail -100
done
```

## Root Cause

The incident required both of the following conditions:

1. **Kafka performs a synchronous reverse DNS lookup in the `SASL_SSL` connection path.**

   In the affected Kafka version, `SaslChannelBuilder.buildTransportLayer()` calls `getHostName()` while a processor registers a new connection. The processor run loop performs connection registration serially. A slow PTR lookup therefore delays other work on the same processor.

   The KAFKA-8562 report itself is written around a client-observed symptom, but `buildTransportLayer()` runs for every `SASL_SSL` channel with no client or server guard, so the same lookup also blocks a broker's network processor threads. The author of the fix documented exactly this broker-wide outage on the fixing pull request (`apache/kafka#10059`): client IP addresses without PTR records caused reverse DNS to block the networking thread pool of all brokers.

2. **CoreDNS does not return a fast answer for unknown addresses in the Pod reverse zone.**

   CoreDNS correctly returns PTR records only when it has a corresponding Kubernetes record. However, the broad `fallthrough in-addr.arpa` rule forwards an unknown Pod PTR to the upstream resolver instead of immediately returning `NXDOMAIN`. When that upstream is unreachable for the internal reverse zone, the forwarded query blocks on a timeout instead of failing fast.

The resulting failure chain is:

```text
TCP connection reaches Kafka
  -> Kafka Processor registers the SASL_SSL channel
  -> getHostName() triggers a PTR lookup for the visible peer IP
  -> unknown Pod/CNI PTR waits on upstream DNS retries
  -> all external listener Processors stop draining new connections
  -> Processor connection queues fill
  -> Acceptor blocks in ArrayBlockingQueue.put()
  -> kernel accept queue reaches its limit
  -> new clients connect slowly, retry, or time out
```

Repeated `SSL handshake failed` messages are not sufficient by themselves to prove a certificate problem. A raw TCP probe, a client that closes while waiting, or a client that uses the wrong TLS settings can all produce this message. During this incident, many connections reached TLS processing only after the reverse lookup delay, by which time the peer had already closed or retried.

Changing Kafka authorization does not resolve this issue because authorization occurs after connection registration and authentication. Changing from SCRAM to another SASL mechanism while retaining `SASL_SSL` also does not remove the affected channel-builder path in Kafka 2.7.0.

## Resolution

Configure CoreDNS to be authoritative for the Kubernetes Pod reverse zone and to return `NXDOMAIN` immediately for unknown addresses in that zone.

For Pod CIDR `192.168.0.0/16`, the reverse zone is:

```text
168.192.in-addr.arpa
```

### 1. Back Up the CoreDNS Configuration

```bash
kubectl -n kube-system get configmap <coredns-configmap> -o yaml \
  > coredns-before-kafka-ptr-fix.yaml
```

### 2. Narrow the Kubernetes Reverse Zone

Change:

```text
kubernetes cluster.local in-addr.arpa ip6.arpa {
    pods insecure
    fallthrough in-addr.arpa ip6.arpa
    ttl 30
}
```

To:

```text
kubernetes cluster.local 168.192.in-addr.arpa ip6.arpa {
    pods insecure
    fallthrough ip6.arpa
    ttl 30
}
```

This configuration has the following behavior:

- A known Kubernetes PTR in `192.168.0.0/16` is returned normally.
- An unknown address in `192.168.0.0/16` receives an immediate `NXDOMAIN`.
- Other IPv4 reverse zones are outside the Kubernetes plugin's configured authority and can continue to later plugins or the appropriate upstream resolver.
- The existing IPv6 fallthrough behavior is preserved.

:::warning Configuration Boundary
Use the reverse zone that matches the actual Pod CIDR. Before making the plugin authoritative, confirm that no required PTR records in that zone are served exclusively by another DNS system. Configure every Pod CIDR when the cluster uses multiple ranges. Do not make all of `in-addr.arpa` non-fallthrough unless the cluster DNS is intended to be authoritative for every IPv4 reverse zone.
:::

### 3. Optionally Add PTR Records for Stable Node or SNAT Addresses

If Kafka consistently sees stable node, CNI, or SNAT addresses that require names, add verified mappings to the CoreDNS `hosts` plugin or to the authoritative internal DNS service:

```text
hosts {
    <stable-source-ip> <verified-hostname>
    fallthrough
}
```

Do not add changing Pod IPs as permanent static records. Static entries can become stale after Pod recreation and are unnecessary when an unknown address receives a fast `NXDOMAIN`.

### 4. Reload CoreDNS

If the Corefile includes the `reload` plugin, wait for automatic reload and confirm that the CoreDNS pods remain ready:

```bash
kubectl -n kube-system get pod | grep coredns
kubectl -n kube-system logs deployment/<coredns-deployment> --since=5m
```

If the deployment name differs, identify it before checking logs or performing a controlled rollout:

```bash
kubectl -n kube-system get deployment | grep coredns
kubectl -n kube-system rollout restart deployment/<coredns-deployment>
kubectl -n kube-system rollout status deployment/<coredns-deployment>
```

### 5. Validate the Fix

Test known and unknown addresses again:

```bash
kubectl -n <namespace> exec <broker-pod> -c kafka -- bash -c '
  TIMEFORMAT="elapsed=%3R sec"

  for ip in <known-peer-ip> <unknown-or-retired-pod-ip>; do
    echo "===== PTR $ip ====="
    { time timeout 3 getent hosts "$ip"; } 2>&1
    echo "exit_code=$?"
  done
'
```

Expected results:

- Known PTR: millisecond response and `exit_code=0`.
- Unknown PTR: millisecond response and `exit_code=2`.
- No lookup should wait for the previous multi-second timeout.

Monitor the accept queue during application reconnection:

```bash
while true; do
  date '+%F %T'

  for i in 0 1 2; do
    printf "kafka-%s " "$i"

    kubectl -n <namespace> exec <cluster-name>-kafka-$i -c kafka -- bash -c '
      set -- $(grep -i ":2386 " /proc/net/tcp | grep " 0A " | head -1)
      q=$5

      if [ -z "$q" ]; then
        echo "9094_LISTEN_NOT_FOUND"
      else
        rx=${q#*:}
        printf "accept_queue=%d raw=%s\n" "$((16#$rx))" "$q"
      fi
    '
  done

  sleep 5
done
```

The queue should drain toward zero and remain low under normal connection load. Validate all of the following during a representative production traffic period:

- Initial Kafka connection latency
- Metadata request success and latency
- Producer and consumer request latency
- Client reconnect and timeout rate
- All broker endpoints
- CoreDNS `NXDOMAIN`, `SERVFAIL`, and timeout behavior
- Absence of `getHostByAddr` in new `EXTERNAL-9094` thread dumps

In the reproduced environment, reverse DNS tests and broker connectivity returned to normal after CoreDNS was changed to use the specific Pod reverse zone without IPv4 fallthrough. Final acceptance should still include production application validation.

## Rollback

If the DNS change affects a required reverse zone, restore the saved ConfigMap:

```bash
kubectl apply -f coredns-before-kafka-ptr-fix.yaml
kubectl -n kube-system get pod | grep coredns
```

Then configure a reachable authoritative internal resolver for the affected reverse zone instead of forwarding internal PTR queries to a public resolver.

If CoreDNS is managed by Helm or another platform controller, persist the validated change in its values or source configuration. Otherwise, a later upgrade or reconciliation can overwrite the live ConfigMap.

## Long-Term Remediation

Upgrade to a product-supported Kafka and operator combination that contains the KAFKA-8562 fix.

Apache Kafka lists the fix in versions 2.7.2, 2.8.1, and 3.0.0. Strimzi 0.25.0 provides Kafka 2.7.x, and 2.8.x images, so none of its standard Kafka images contain this fix. Do not introduce an unsupported custom broker image only to change the Kafka patch version. Follow the Alauda-supported operator and Kafka upgrade path to a maintained release.

Also review systems that perform plain TCP health checks against the `SASL_SSL` listener. A TCP-only check opens a connection without completing TLS and can create repeated `SSL handshake failed` messages. Prefer a Kafka-aware or TLS-aware check where available.

The DNS correction remains good operational practice after upgrading: known internal PTR queries should resolve quickly, and unknown internal addresses should receive a fast authoritative negative response rather than wait for an unreachable upstream resolver.

## References

- [Apache Kafka KAFKA-8562: SASL_SSL still performs reverse DNS lookup](https://issues.apache.org/jira/browse/KAFKA-8562)
- [Apache Kafka pull request 10059: fix for KAFKA-8562, stops resolving the peer hostname when building the `SASL_SSL` transport layer](https://github.com/apache/kafka/pull/10059)
- [Apache Kafka KAFKA-13576: make the Processor connection-queue size configurable and add connection-register metrics](https://issues.apache.org/jira/browse/KAFKA-13576) — open, unresolved enhancement whose description documents the same `SASL_SSL` reverse-DNS connection-queue impact
- [Apache Kafka 2.7.2 release notes](https://archive.apache.org/dist/kafka/2.7.2/RELEASE_NOTES.html)
- [CoreDNS kubernetes plugin](https://coredns.io/plugins/kubernetes/)
- [CoreDNS forward plugin](https://coredns.io/plugins/forward/)
- [CoreDNS hosts plugin](https://coredns.io/plugins/hosts/)
- [Strimzi 0.25.0 deployment and upgrade documentation](https://strimzi.io/docs/operators/0.25.0/deploying)
