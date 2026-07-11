---
title: Add custom host entries to a pod's /etc/hosts on ACP
component: configure
scenario: how-to
tags: [pod, hostAliases, /etc/hosts, deployment]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Add custom host entries to a pod's /etc/hosts on ACP

## Issue

Workloads sometimes need extra hostname-to-IP entries in `/etc/hosts` inside their containers — for example, to point a hostname at a development loopback address, or to resolve an internal mirror that isn't in cluster DNS. The `/etc/hosts` file inside every container is managed by the kubelet: it is regenerated when the pod is created and the in-container file is not the right place to make persistent edits [ev:c1]. The right place is the pod spec.

## Resolution

Set `hostAliases` on the pod spec. `Pod.spec.hostAliases` is the declarative field for injecting extra entries into a pod's `/etc/hosts` [ev:c2_a]. Each entry is an object with a required `ip` (string) and a list of `hostnames` (strings) [ev:c2_b]:

```yaml
hostAliases:
  - ip: "127.0.0.1"
    hostnames:
      - "home"
      - "localdev"
  - ip: "10.99.0.42"
    hostnames:
      - "corp-mirror.internal"
```

For a workload managed by a `Deployment`, `StatefulSet`, or similar, the field belongs under the **pod template** — for a Deployment that is `.spec.template.spec.hostAliases`, not the Deployment's own `.spec` [ev:c4]. Verified on Kubernetes `v1.34.5-1`. A complete minimal example:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hostaliases-demo
spec:
  replicas: 1
  selector:
    matchLabels: {app: hostaliases-demo}
  template:
    metadata:
      labels: {app: hostaliases-demo}
    spec:
      hostAliases:
        - ip: "127.0.0.1"
          hostnames: ["home", "localdev"]
        - ip: "10.99.0.42"
          hostnames: ["corp-mirror.internal"]
      containers:
        - name: shell
          image: registry.alauda.cn:60080/ops/alpine:latest
          command: ["sh", "-c", "sleep 36000"]
```

Apply it and the kubelet will write the alias entries into `/etc/hosts` alongside its default lines. The aliases stay in place as long as the pod spec is unchanged; deleting and recreating the pod yields a new pod with the same alias section [ev:c3].

For workloads owned by an operator — concretely, when the `Deployment`'s `metadata.ownerReferences` point to a controller resource such as a `ClusterServiceVersion` — patching `hostAliases` directly onto the operator-rendered Deployment is not the supported configuration path, because the owning controller can re-reconcile the spec [ev:c6]. For these workloads, set the field through whatever knob the operator's own custom resource exposes for it.

## Diagnostic Steps

After the pod is running, inspect `/etc/hosts` from inside the container to confirm the alias entries landed [ev:c5]:

```bash
POD=$(kubectl get pod -n <namespace> -l app=<your-label> -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n <namespace> "$POD" -- cat /etc/hosts
```

A correctly configured pod prints the kubelet-generated section first (the `# Kubernetes-managed hosts file.` header, `localhost` lines, and `<pod-ip> <pod-name>`), followed by a clearly separated alias section that lists each configured entry on its own line [ev:c3]:

```text
# Kubernetes-managed hosts file.
127.0.0.1	localhost
::1	localhost ip6-localhost ip6-loopback
fe00::0	ip6-localnet
fe00::0	ip6-mcastprefix
fe00::1	ip6-allnodes
fe00::2	ip6-allrouters
10.3.2.28	hostaliases-demo-97477ff8-bbnwp

# Entries added by HostAliases.
127.0.0.1	home	localdev
10.99.0.42	corp-mirror.internal
```

If a needed entry is missing, the spec was not applied as intended — check the Deployment's `.spec.template.spec.hostAliases` field rather than editing `/etc/hosts` from inside the container, because the kubelet rewrites the file when the pod is recreated [ev:c1].
