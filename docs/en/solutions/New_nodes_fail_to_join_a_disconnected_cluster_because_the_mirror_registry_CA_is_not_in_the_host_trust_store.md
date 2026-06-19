---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# New nodes fail to join a disconnected cluster because the mirror registry CA is not in the host trust store
## Issue

After cycling or scaling out a disconnected cluster, freshly provisioned nodes never finish joining. Their `BareMetalHost` (or equivalent provider) shows the host registered, but the kubelet on the node cannot pull the cluster's release image from the mirror registry. The journal log on the node fills with TLS verification failures pointing at the mirror endpoint:

```text
time="..." level=warning msg="Failed, retrying in 1s... (3/3).
  Error: initializing source docker://<mirror>/release@sha256:...:
    pinging container registry <mirror>:
      Get \"https://<mirror>/v2/\":
        tls: failed to verify certificate: x509: certificate signed by unknown authority"
```

Existing nodes pull from the same mirror without issue. The cluster's image-config CR carries the right `additionalTrustedCA` ConfigMap, the value of which references a valid CA bundle. The CA simply never reaches new nodes before the kubelet's first image pull.

## Root Cause

The cluster ships the CA bundle to nodes through a DaemonSet that watches the image-config ConfigMap and writes the certificate into a per-node directory like `/etc/docker/certs.d/<mirror>/ca.crt`. That works for nodes that are already in the cluster: the DaemonSet pod runs, drops the file, and `crio` picks it up on the next pull.

Freshly provisioned nodes don't have the DaemonSet running yet — the kubelet must succeed at its first pull before the cluster can schedule any workload, including the CA-distributing DaemonSet. The first pull goes to the mirror, the host trust store has no entry for the mirror's CA, and the pull fails. The DaemonSet never gets a chance to run because no pod ever lands on the node.

The fix is to put the CA into the OS-level trust bundle (`/etc/pki/ca-trust/...`) so it is present from the very first boot. That requires the CA to come down with the node configuration that the node fetches at registration time, before any image pull.

There are two paths that solve this, both delivered through the cluster's node-configuration mechanism:

- A node-config object that drops the CA into `/etc/pki/ca-trust/source/anchors/` and runs `update-ca-trust`. This is the lowest-impact path when the cluster has no proxy.
- The cluster proxy `trustedCA` ConfigMap, which the platform extracts and re-ships to every node's trust bundle. This is the right path when the cluster already routes egress through a proxy.

The two are interchangeable for solving the symptom; pick the one that matches the cluster's existing topology and don't combine them, or two copies of the CA end up in the trust store.

## Resolution

When the cluster has no proxy, ship the CA via a node-configuration object. The example below uses the on-cluster Machine Configuration operator; substitute the equivalent CR if a different mechanism drives node config.

```yaml
apiVersion: node.alauda.io/v1
kind: NodeConfig
metadata:
  name: 99-worker-mirror-ca
  labels:
    node-role.kubernetes.io/worker: ""
spec:
  storage:
    files:
      - path: /etc/pki/ca-trust/source/anchors/mirror-registry.crt
        mode: 0644
        contents:
          inline: |
            -----BEGIN CERTIFICATE-----
            <base64-encoded mirror CA cert>
            -----END CERTIFICATE-----
  systemd:
    units:
      - name: update-ca-trust.service
        enabled: true
        contents: |
          [Unit]
          Description=Refresh CA trust bundle after mirror CA dropped
          ConditionPathExists=/etc/pki/ca-trust/source/anchors/mirror-registry.crt
          Before=kubelet.service

          [Service]
          Type=oneshot
          ExecStart=/usr/bin/update-ca-trust extract
          RemainAfterExit=yes

          [Install]
          WantedBy=multi-user.target
```

Apply and wait for the worker pool to roll. New nodes added afterwards pick the file up at first boot, run `update-ca-trust`, and pull from the mirror cleanly.

When the cluster does have a proxy, populate the proxy CR's `trustedCA` ConfigMap with the same bundle. The platform copies that ConfigMap into every node's OS trust store automatically — no separate node-config object is needed.

```bash
kubectl -n kube-system create configmap trusted-ca \
  --from-file=ca-bundle.crt=mirror-ca.pem
```

```yaml
apiVersion: config.alauda.io/v1
kind: Proxy
metadata:
  name: cluster
spec:
  trustedCA:
    name: trusted-ca
```

After the proxy CR is updated, the per-node controller reconciles the trust bundle; once it does, new nodes registering through the same provisioning flow inherit the CA before their first image pull and the failure mode goes away.

For a defensive baseline, include the mirror CA in the install-config so any future scale-out from a fresh image already has the bundle baked in. Treat per-node updates after the cluster is built as a follow-up patch, not the primary distribution mechanism.

## Diagnostic Steps

Confirm new nodes are missing the CA by listing the OS trust anchors. From a debug pod on the affected node:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  chroot /host trust list --filter=ca-anchors | grep -i mirror
```

If the mirror CA isn't listed, the OS trust store doesn't have it. Check the per-node directory the DaemonSet uses:

```bash
kubectl debug node/<node> -it --image=busybox -- \
  ls /host/etc/docker/certs.d/<mirror>/
```

Existing nodes have `ca.crt` here; new nodes typically don't, because the DaemonSet never landed (the kubelet failed to pull its image first).

To distinguish proxy-CA from node-config-CA paths, inspect the proxy CR:

```bash
kubectl get proxy/cluster -o yaml | grep -A2 trustedCA
```

An empty `name: ""` means no proxy-driven distribution is in place — use the node-config path. A populated `name: <configmap>` means the proxy already wires the CA — point that ConfigMap at the right bundle and skip the node-config object.

After applying either fix, watch a new node come up and confirm the trust list includes the mirror CA before the first image pull succeeds:

```bash
kubectl debug node/<new-node> -it --image=busybox -- \
  chroot /host trust list --filter=ca-anchors | grep -i mirror
kubectl get bmh <new-node> -o jsonpath='{.status.provisioning.state}{"\n"}'
```

A node that prints "provisioned" or equivalent and lists the mirror CA in its trust store should successfully complete its first image pull within the next reconcile cycle.
