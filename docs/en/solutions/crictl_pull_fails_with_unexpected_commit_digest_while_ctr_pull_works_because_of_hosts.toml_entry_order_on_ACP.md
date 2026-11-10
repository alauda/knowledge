---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# crictl pull fails with unexpected commit digest while ctr pull works because of hosts.toml entry order on ACP

## Issue

A registry (for example Harbor exposed through a NodePort, with HTTPS added in front of it by custom forwarding rules) is reachable by domain name. Pulling an image by that domain works with `docker`, `nerdctl` and `ctr`, but `crictl pull` on the same node fails, and kubelet image pulls that go through the same CRI path fail too:

```text
"PullImage from image service failed" err="rpc error: code = FailedPrecondition desc = failed to pull and unpack image \"<registry-domain>/<project>/<image>:<tag>\": failed commit on ref \"unknown-sha256:<digest-a>\": unexpected commit digest sha256:<digest-b>, expected sha256:<digest-a>: failed precondition"
FATA[0000] pulling image: rpc error: code = FailedPrecondition desc = failed to pull and unpack image ...: failed precondition
```

Clearing the containerd image store (`/var/lib/containerd`) and restarting containerd and kubelet does not help, and the same error comes back.

## Root Cause

`crictl` talks to the containerd CRI plugin, and the CRI plugin resolves registries through the host configuration files under `/etc/containerd/certs.d/`. On the node, the wildcard configuration `/etc/containerd/certs.d/0.0.0.0_0/hosts.toml` holds two entries, one for `https://*` and one for `http://*`. containerd tries the `[host."..."]` entries of a `hosts.toml` in the order in which they appear in the file.

When the `http://*` entry comes before the `https://*` entry, the CRI path contacts the registry domain over plain HTTP first. Behind forwarding rules that provide HTTPS for the registry, what comes back on that path is not the expected image content. Its digest does not match the digest from the manifest, and containerd aborts the commit with `unexpected commit digest ... failed precondition`.

Other clients are not affected because they do not resolve the registry through this file in the same way. For example, `ctr` ignores `/etc/containerd/certs.d` unless `--hosts-dir` is passed, and `docker` uses its own daemon configuration.

## Resolution

> **Warning:** A wrong `hosts.toml` breaks every CRI image pull on the node, which includes the kubelet pulls for new Pods. Edit one node first and verify before changing the others. Rollback: copy the saved file back.

1. Save the current file:

   ```bash
   sudo cp /etc/containerd/certs.d/0.0.0.0_0/hosts.toml /tmp/hosts.toml.bak
   ```

2. Edit `/etc/containerd/certs.d/0.0.0.0_0/hosts.toml` so that the `https://*` entry comes **before** the `http://*` entry. Keep the existing settings of each entry:

   ```toml
   [host."https://*"]
     capabilities = ["pull", "resolve", "push"]
     skip_verify = true

   [host."http://*"]
     capabilities = ["pull", "resolve", "push"]
     skip_verify = true
   ```

3. Pull the image again with `crictl`:

   ```bash
   crictl pull <registry-domain>/<project>/<image>:<tag>
   ```

4. Apply the same order on the other nodes that pull from this registry.

## Diagnostic Steps

1. Reproduce with both clients on the same node:

   ```bash
   crictl pull <registry-domain>/<project>/<image>:<tag>
   ctr -n k8s.io images pull <registry-domain>/<project>/<image>:<tag>
   ```

   Expected for this issue: `crictl` fails with `unexpected commit digest ... failed precondition`, while `ctr` completes.

2. Check the order of the entries in the wildcard host configuration:

   ```bash
   sudo grep -n 'host\.' /etc/containerd/certs.d/0.0.0.0_0/hosts.toml
   ls /etc/containerd/certs.d/
   ```

   Expected for this issue: `[host."http://*"]` is listed before `[host."https://*"]`. Also check whether a directory named after the registry domain exists under `/etc/containerd/certs.d/`. A host-specific `hosts.toml` there applies to that registry instead of the wildcard one, and its entry order matters in the same way.

3. Confirm which directory the CRI plugin reads:

   ```bash
   sudo grep -n -A2 'config_path' /etc/containerd/config.toml
   ```

   Expected: `config_path` points at `/etc/containerd/certs.d`.

4. Rule out a corrupted local store. If the error remains after the entry order is corrected, check the containerd log for the pull. An identical digest error across different registries points to something else, such as a proxy that rewrites responses:

   ```bash
   journalctl -u containerd --since "10 min ago" | grep -E 'commit digest|FailedPrecondition'
   ```
