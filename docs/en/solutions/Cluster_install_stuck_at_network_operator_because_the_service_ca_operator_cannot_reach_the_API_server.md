---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cluster install stuck at network operator because the service-ca operator cannot reach the API server
## Issue

A new cluster install reaches the point where the control-plane nodes
report `Ready` but never finishes. The cluster-operator status sticks at:

```text
network    True    True    False    DaemonSet "<ns>/network-metrics-daemon"
                                     is waiting for other operators
                                     to become ready
```

The installer eventually times out and the deployment is recorded as
failed. Inspecting the cluster shows the network operator's pods stuck in
`ContainerCreating` because they cannot mount their TLS secrets:

```text
MountVolume.SetUp failed for volume "webhook-certs":
  secret "<webhook-secret>" not found
MountVolume.SetUp failed for volume "metrics-certs":
  object "<ns>"/"<metrics-secret>" not registered
```

The secrets that fail to mount are the ones the cluster's service-CA
operator should be issuing.

## Root Cause

The cluster's service-CA operator is responsible for generating the TLS
secrets that mTLS-protected service endpoints (admission webhooks, the
metrics daemon, etc.) consume. To do so it has to be able to reach the
in-cluster Kubernetes API service — typically `https://172.30.0.1:443`
or the equivalent in the cluster's service network.

If the underlying network blocks that traffic (a host-level firewall, a
cloud-provider security group, a misconfigured load balancer between the
control-plane nodes), the service-CA operator's leader election fails
because it cannot acquire its lease against the API server, and the
operator pod restarts repeatedly. Without the service-CA operator the
webhook and metrics secrets never get created. The downstream consumers
(the network operator's webhook deployment, the network metrics daemon)
cannot mount those secrets and stay in `ContainerCreating`. The network
cluster-operator therefore stays `Progressing`, and because the installer
gates on every cluster-operator becoming `Available`, the install never
finishes.

The same fingerprint applies to any other operator on the install
critical path that needs to reach the API server through the
in-cluster service IP — DNS, image registry, ingress. The
service-CA operator just happens to be the most common first failure
because so many things depend on its issued certificates.

## Resolution

Open the firewall / security group / load-balancer ACLs so every node in
the cluster can reach every other node on the API-server port (TCP
`6443`, or whatever port the API server listens on for the cluster):

1. **Bootstrap connectivity.** During the initial install, the bootstrap
   node temporarily acts as the API server. Every control-plane and
   worker node must be able to reach the bootstrap node on the API port.

2. **Control-plane connectivity.** Once the install hands off, the
   stable API endpoint is one or more of the control-plane nodes (often
   fronted by a virtual IP or load balancer). Every node, including the
   control-plane nodes themselves, must be able to reach all
   control-plane nodes on the API port.

3. **Service IP routing.** The in-cluster service IP that maps to the
   API server (`172.30.0.1` or whatever the service network's first
   address is) is reached by traffic that traverses the kube-proxy /
   CNI fabric. If the underlying network silently drops traffic from
   pod IPs to the service network, the service-CA operator's API call
   times out. Confirm pod-to-service connectivity for the API service
   specifically.

After the connectivity is restored, the service-CA operator's pod
acquires its lease on the next restart, the missing TLS secrets are
generated, and the network operator's pods proceed past
`ContainerCreating`. The installer reaches `Available` for every
cluster-operator and completes.

## Diagnostic Steps

1. Confirm the symptom is service-CA-operator-driven, not the network
   operator failing on its own. Inspect the service-CA operator's pod
   log:

   ```bash
   kubectl logs -n <service-ca-ns> deploy/service-ca-operator --tail=200
   ```

   Lines like `failed checking apiserver connectivity: ... context
   deadline exceeded` against the service IP confirm the API server is
   unreachable from the operator pod.

2. From a debug pod on a worker node, attempt to reach the API service
   endpoint:

   ```bash
   kubectl run apicheck --rm -it --image=busybox -- \
     wget -O- --timeout=5 https://172.30.0.1:443/ 2>&1 | head -5
   ```

   A successful TCP connect (even if the TLS handshake fails) confirms
   the data path is open. A timeout confirms a firewall block.

3. Identify which firewall layer is dropping the traffic. From the worker
   node host (`kubectl debug node/<node>`):

   ```bash
   nc -vz <control-plane-ip> 6443
   ```

   for each control-plane node. A failure between specific nodes points at
   the host firewall, network ACLs, or security groups for those nodes
   specifically.

4. After opening the rule, confirm the service-CA operator stabilises:

   ```bash
   kubectl get pods -n <service-ca-ns>
   kubectl get secrets -n <network-operator-ns> | grep -E "webhook-cert|metrics"
   ```

5. Confirm the network operator finishes:

   ```bash
   kubectl get clusteroperators network -w
   ```

   The `Progressing` flag flips to `False` and `Available` stays `True`.
