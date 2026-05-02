---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

When a cluster sits behind a corporate egress proxy, every component that speaks to the public internet — image pulls from external registries, telemetry uploads, OperatorHub catalog updates — must respect the same `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` settings. Setting these on the cluster's top-level proxy CR is straightforward. What surprises operators is the indirection between that CR and the place where the proxy values actually take effect: the kubelet itself does not consume the proxy at all. The container runtime (CRI-O, containerd) does, and only because the platform's node-configuration controller drops a systemd environment file onto every node and points the runtime's unit at it.

This article walks the chain from the cluster-wide CR down to a single line in `/etc/systemd/system/...` so operators can both predict where the proxy is applied and diagnose why a particular request bypassed it.

## Resolution

The flow on a healthy node is:

1. Operator applies the cluster-wide proxy CR (the platform-level Proxy CR; the exact CR name depends on the platform, but the structure is `spec.httpProxy / spec.httpsProxy / spec.noProxy`).
2. The platform's machine-configuration controller materialises an environment file on every node containing the proxy values.
3. A systemd drop-in for the container runtime references that environment file, so every container the runtime starts inherits the proxy via env vars.
4. CRI-O reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` from its own environment when pulling images; it does **not** propagate them into the container's view (workload containers see only what the workload's pod spec sets).
5. The kubelet does not consume proxy env vars on its own. Anything kubelet needs to talk to lives in-cluster (apiserver, plugin sockets) and goes through the cluster's normal service discovery — no proxy involved.

### What the file layout looks like

The environment file the controller writes:

```bash
# /etc/mc/proxy.env on every node
HTTP_PROXY=http://proxy.corp.example.com:3128
HTTPS_PROXY=http://proxy.corp.example.com:3128
NO_PROXY=.cluster.local,.svc,10.128.0.0/14,127.0.0.1,172.30.0.0/16,localhost,api-int.lab.example.com
```

The systemd drop-in for CRI-O:

```bash
# /etc/systemd/system/crio.service.d/10-default-env.conf
[Service]
EnvironmentFile=/etc/mc/proxy.env
```

The unit's effective view (visible with `systemctl cat crio.service`):

```bash
# /usr/lib/systemd/system/crio.service
[Unit]
Description=Container Runtime Interface for OCI (CRI-O)
...

[Service]
EnvironmentFile=-/etc/sysconfig/crio
...

# /etc/systemd/system/crio.service.d/10-default-env.conf
[Service]
EnvironmentFile=/etc/mc/proxy.env
```

The drop-in's `EnvironmentFile=` (no leading `-`) is mandatory — if the file is missing, the unit fails to start, which is the desired safety property: an empty proxy file means the cluster admin's proxy intent has not landed yet, and starting CRI-O without proxy would silently bypass it.

### NO_PROXY content

The `NO_PROXY` list is the most error-prone part. It must include:

- `.cluster.local` and `.svc` — every in-cluster Service DNS name.
- The pod-CIDR (e.g. `10.128.0.0/14`) so pod-to-pod traffic is not proxied.
- The service-CIDR (e.g. `172.30.0.0/16`).
- `127.0.0.1`, `localhost` — apiserver localhost endpoint, kubelet probes.
- The internal apiserver hostname (`api-int.<cluster>.<base-domain>`), so kubelet's apiserver calls do not loop through the proxy.
- Any node's host-network range (e.g. `192.168.0.0/24`) so node-to-node SSH and apiserver-to-kubelet traffic are direct.

If any of these are missing, a workload that tries to reach an in-cluster service first goes through the proxy, gets a `502 Bad Gateway` from the proxy (the proxy can't see in-cluster IPs), and the workload thinks the service is down. Always check `NO_PROXY` first when an in-cluster traffic path that worked before suddenly fails after enabling the proxy.

### What containers see

The proxy env vars are set in the *runtime's* environment, not in the *workload container's* environment by default. CRI-O uses them when pulling images for the workload, but the workload pod itself sees only env vars its pod spec declares.

If a workload also needs to make outbound HTTP through the proxy (e.g. an in-pod tool that calls a public API), the workload's pod spec needs to mention the proxy explicitly:

```yaml
spec:
  containers:
    - name: app
      env:
        - name: HTTP_PROXY
          value: http://proxy.corp.example.com:3128
        - name: HTTPS_PROXY
          value: http://proxy.corp.example.com:3128
        - name: NO_PROXY
          value: .cluster.local,.svc,10.128.0.0/14,127.0.0.1,172.30.0.0/16
```

Some platforms inject these env vars into every workload pod via a mutating admission webhook driven by the same Proxy CR. Confirm with a debug pod whether the cluster does this:

```bash
kubectl run probe --rm -it --restart=Never --image=busybox \
  -- env | grep -E '^(HTTP|HTTPS|NO)_PROXY='
```

A populated env confirms the auto-injection. An empty env means workloads must self-declare the proxy.

## Diagnostic Steps

Confirm the env file is on a representative node and contains the expected values:

```bash
NODE=worker-1.lab.example.com
kubectl debug node/"$NODE" -- chroot /host bash -c '
  cat /etc/mc/proxy.env
  systemctl cat crio.service | tail -20
'
```

Confirm the runtime actually inherited the env vars by inspecting its running process:

```bash
kubectl debug node/"$NODE" -- chroot /host bash -c '
  pid=$(pidof crio)
  cat "/proc/$pid/environ" | tr "\0" "\n" | grep -E "_PROXY="
'
```

Three lines (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) confirm the drop-in took. Empty output means CRI-O started before the systemd drop-in was placed — restart the unit:

```bash
kubectl debug node/"$NODE" -- chroot /host \
  systemctl restart crio
```

Be aware that restarting CRI-O kills the running containers on that node; drain the node first if it is a production worker:

```bash
kubectl cordon "$NODE"
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data
```

If image pulls still bypass the proxy after the env vars are confirmed in CRI-O's process, the registry may be in `NO_PROXY` (a CIDR or domain that matches the registry IP). For partial-fix cases — proxy for some traffic, direct for others — `NO_PROXY` semantics are exact-match and prefix-match for domains, plus exact-or-CIDR for IP ranges; subdomain coverage requires the leading dot (`.example.com` matches `app.example.com` but `example.com` alone does not).

For systemic verification across every node, query the runtime's environment cluster-wide via a DaemonSet job:

```bash
kubectl get nodes -o name | while read n; do
  NODE=${n#node/}
  echo "------ $NODE ------"
  kubectl debug node/"$NODE" -q -- chroot /host bash -c '
    pid=$(pidof crio); cat "/proc/$pid/environ" | tr "\0" "\n" | grep _PROXY=
  ' 2>&1 | head -3
done
```

Any node whose CRI-O environment lacks the proxy lines is the one whose machine-configuration reconciliation has not caught up. Force the controller to re-roll that node's config and reboot it.
