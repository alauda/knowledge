---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Harbor or registry image pull fails with x509 certificate signed by unknown authority or certificate has expired

## Issue

An image pull or push to Harbor or another HTTPS registry completes the TCP connection but fails the TLS check, before any permission check. The client (`crictl`, the kubelet, Docker, Buildah, Skopeo) reports one of:

```text
x509: certificate signed by unknown authority
x509: certificate has expired or is not yet valid
```

The failure can affect every node right after a containerd configuration change, or only one node, where `crictl pull` fails while `nerdctl pull` of the same image succeeds.

Related articles: [Harbor push or pull fails because the client uses the wrong scheme: HTTP response to HTTPS client, or port 443 refused](Harbor_push_or_pull_fails_because_the_client_uses_the_wrong_scheme_HTTP_response_to_HTTPS_client_or_port_443_refused.md).

## Root Cause

### Cause 1: the client does not trust the CA that signed the registry certificate

The HTTPS listener presents a certificate that the client does not trust. On a node this is usually one of:

- A private CA that was never added to containerd's host configuration under `/etc/containerd/certs.d/<registry>:<port>/`.
- A regenerated `/etc/containerd/config.toml` that dropped `config_path`. Running `containerd config default` and writing the result over `/etc/containerd/config.toml` makes the next pull from the platform registry fail with this error, because the host configuration is no longer loaded.
- A hand-added Harbor block in `config.toml` that replaced the trust configuration of the platform registry.
- One node that lacks the `/etc/containerd/certs.d/<registry>:<port>/hosts.toml` that the other nodes have. `crictl pull` on that node reports x509 while `nerdctl pull` of the same image succeeds.

`registry.alauda.cn:60080` is the in-cluster registry name used by ACP workloads; it is not an insecure HTTP endpoint.

### Cause 2: the certificate is outside its validity window, or the node clock is

The certificate presented for the registry hostname has expired or is not yet valid, or the node clock is outside the certificate's validity window. Putting the expired certificate into the trust store does not help, and skipping verification hides the expiry and leaves every pull on that node unprotected.

## Resolution

### Cause 1

1. Put the CA that signed the registry certificate into the containerd host directory and name it in `hosts.toml`. The directory name must match the image reference, including a non-default port.

   ```toml
   server = "https://<harbor-host>"

   [host."https://<harbor-host>"]
     capabilities = ["pull", "resolve", "push"]
     ca = "/etc/containerd/certs.d/<harbor-host>/ca.crt"
   ```

   When `hosts.toml` exists, containerd does not load a `*.crt` file from that directory unless `hosts.toml` names it with `ca`. A `hosts.toml` without a `ca` line clears the error only if the node already trusts the CA in its system trust store.

2. If only one node fails and other nodes pull, copy the `/etc/containerd/certs.d/<registry>:<port>/` directory from a healthy node to the failing node, then retry `crictl pull`. containerd 1.5 and later read a new or changed `hosts.toml` on the next pull without a restart, as long as `config_path` is already loaded.

3. If `config_path` is missing because `config.toml` was replaced or hand-edited, restore it from a healthy node of the same platform version, including any platform registry host entries. The `config_path` line for containerd 1.x is under `[plugins."io.containerd.grpc.v1.cri".registry]`; for containerd 2.x under `[plugins."io.containerd.cri.v1.images".registry]`. Do not regenerate the file with `containerd config default`. Then restart containerd.

   > **Warning:** Impact: restarting containerd interrupts the CRI socket on the node; the kubelet cannot start, stop, or probe containers meanwhile and the node can report `NotReady`. With the standard unit (`KillMode=process`, check with `systemctl show containerd -p KillMode`) running containers keep running; with `control-group` or `mixed` every container on the node stops. Precondition: copy `/etc/containerd/config.toml` and `/etc/containerd/certs.d` aside, and drain the node in a maintenance window. Rollback: restore the copies and restart containerd again.

   ```bash
   kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
   systemctl restart containerd
   kubectl uncordon <node>
   ```

4. For a Docker client, add the CA as `/etc/docker/certs.d/<harbor-host>/ca.crt` instead of adding the host to `insecure-registries`.

### Cause 2

1. Compare node time with the certificate dates before replacing anything:

   ```bash
   date -u
   echo | openssl s_client -connect <harbor-host>:443 -servername <harbor-host> 2>/dev/null \
     | openssl x509 -noout -dates -subject -ext subjectAltName
   ```

2. If `notBefore` is in the future or `notAfter` is in the past only because the node clock is wrong, correct NTP first. See [Configuring chrony NTP on Cluster Nodes](Configuring_chrony_NTP_on_Cluster_Nodes.md).

   > **Warning:** Stepping the clock on a control-plane node can stall etcd and invalidate in-flight tokens. Precondition: a maintenance window; correct one control-plane node at a time. ACP etcd runs as the static Pod `etcd-<node>` in `kube-system` (label `component=etcd`); before the next node, confirm that Pod is `Running` and that its log has no `clock difference against peer` line. The clock cannot be rolled back to the wrong time; point chrony at the previous source if the new source is wrong.

   ```bash
   kubectl get pods -n kube-system -l component=etcd -o wide
   kubectl -n kube-system logs -c etcd etcd-<node> --tail=50 | grep -i "clock difference"
   ```

3. If the certificate is expired against a correct clock, replace the certificate served for that hostname, with a new certificate for the same name prepared in advance. When the registry hostname is the platform access address, the certificate is the platform access certificate; replace it with the procedure in the ACP documentation. Confirm the `openssl` command from step 1 shows the new dates, then retry the pull. Do not add the expired certificate to `ca.crt`, and do not use `skip_verify` as the lasting fix.

   If an intermediate CA in the chain is what expired, see [Diagnosing x509 certificate has expired caused by an expired CA in the chain](Diagnosing_x509_certificate_has_expired_caused_by_an_expired_CA_in_the_chain.md).

## Diagnostic Steps

1. Inspect the certificate the port presents:

   ```bash
   echo | openssl s_client -connect <harbor-host>:443 -servername <harbor-host> -showcerts
   ```

   `Verify return code: 19`, `20`, or `21` (self-signed certificate in the chain, unknown local issuer, or first certificate not verifiable) points to Cause 1; dates outside the current time point to Cause 2.

2. See what containerd uses for this host and compare with a node that can pull:

   ```bash
   grep -n "config_path\|certs.d" /etc/containerd/config.toml
   containerd config dump | grep -n config_path
   ls -l /etc/containerd/certs.d/<harbor-host>:<port>/
   sed -n '1,80p' /etc/containerd/certs.d/<harbor-host>:<port>/hosts.toml
   ```

   Expected on a healthy node: `config_path = "/etc/containerd/certs.d"` and a `hosts.toml` with a `ca` line for a private CA.

3. Compare runtimes on the failing node:

   ```bash
   crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   nerdctl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   `crictl` failing with x509 while `nerdctl` succeeds, on a node without the registry's `hosts.toml`, is the single-node form of Cause 1.

   The two tools read different trust locations: `nerdctl` reads both `/etc/containerd/certs.d` and `/etc/docker/certs.d` by default, while CRI (`crictl` and the kubelet) reads only the `config_path` set in `/etc/containerd/config.toml`. A CA file under `/etc/docker/certs.d/<harbor-host>:<port>/` can therefore explain why `nerdctl` pulls while `crictl` does not:

   ```bash
   ls -la /etc/containerd/certs.d/<harbor-host>:<port>/ /etc/docker/certs.d/<harbor-host>:<port>/
   ```

   Before adding a host file on that one node, also compare `sha256sum /usr/bin/containerd` with a healthy node of the same platform version. A different checksum with Docker installed on the node means the runtime binaries were overwritten; see [Container runtime conflicts on ACP nodes: Docker, podman, docker-runc, and overwritten runtime binaries](Container_runtime_conflicts_on_ACP_nodes_Docker_podman_docker-runc_and_overwritten_runtime_binaries.md) and restore the binaries instead.

4. If the error is `server gave HTTP response to HTTPS client` or `connection refused` on 443 instead of x509, see the related article under Issue.
