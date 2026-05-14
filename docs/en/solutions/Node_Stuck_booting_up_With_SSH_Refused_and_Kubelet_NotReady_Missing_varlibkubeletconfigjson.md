---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Node Stuck "booting up" With SSH Refused and Kubelet NotReady — Missing `/var/lib/kubelet/config.json`
## Issue

A cluster node stops serving workloads and the control plane reports it as `NotReady`. Attempting to SSH to the node to investigate returns a boot-time refusal message instead of a shell prompt:

```text
System is booting up. Unprivileged users are not permitted to log in yet.
Please come back later.
For technical details, see pam_nologin(8).
```

The node responds to `ping`, so networking to it is basically fine. But:

- SSH refuses non-root logins.
- The API server reports the node as `NotReady` (kubelet is not sending successful status updates).
- Standard `kubectl debug node/<name>` cycles and may also stall.
- Running services on the node appear to be holding, waiting for something.

The message from PAM is not a red herring: `pam_nologin(8)` rejects unprivileged logins while `/run/nologin` (or `/etc/nologin`) exists. Systemd creates `/run/nologin` while essential boot-time services have not yet reported `ready`. A service that **hangs during start-up** keeps `/run/nologin` present indefinitely, which is why ordinary SSH stays refused even long after the node's initial boot time.

## Root Cause

On cluster nodes, the kubelet's in-cluster identity and image-pull credentials are supplied through a kubelet-side pull-secret at `/var/lib/kubelet/config.json`. Multiple services that run early in the boot sequence depend on that file:

- `nodeip-configuration.service` — determines the node's node-IP by talking to the platform (which requires authenticated access to the cluster's image registry / API).
- `kubelet.service` — reads the pull-secret to authenticate image pulls for static pods and for any in-cluster image the kubelet fetches directly.

When `/var/lib/kubelet/config.json` is missing, unreadable, or corrupted:

- `nodeip-configuration.service` blocks waiting for a response that can never come.
- `kubelet.service` cannot pull static-pod images and stays not-ready.
- systemd keeps `/run/nologin` present because critical boot targets have not completed.
- PAM honours the `nologin` file and refuses non-root interactive logins.

The node appears completely stuck from the operator's perspective. It is actually not stuck — it is faithfully waiting for the pull-secret to appear, which it never will without intervention.

Causes of the file going missing:

- An overly enthusiastic maintenance script deleted files under `/var/lib/kubelet/` (a cleanup that thought it was removing cached container images).
- Disk corruption (filesystem check at next boot truncated or orphaned the file).
- An operator action touching the file without understanding its boot-path criticality.
- Node re-provisioned from an image missing the file; the installer / ignition that should have written it did not.

## Resolution

### Restore the pull-secret file on the affected node

The file's content is identical across nodes that joined the same cluster with the same image-pull credentials. Copy it from a healthy node.

**If some nodes are still healthy and accessible:**

```bash
# From a healthy node, read the file content.
HEALTHY_NODE=<healthy-node>
kubectl debug node/$HEALTHY_NODE --image=busybox -- \
  chroot /host cat /var/lib/kubelet/config.json > /tmp/kubelet-config.json

# Verify it's a parseable JSON docker-config.
jq '.auths | keys' /tmp/kubelet-config.json
```

**If the affected node can be reached as root via a management channel (ILO, iDRAC, vSphere console):**

Log in through the out-of-band console, escalate to root (PAM only blocks unprivileged logins; root is unaffected), and write the file:

```bash
# On the affected node, as root:
install -m 0600 -o root -g root /path/to/healthy-config.json /var/lib/kubelet/config.json
```

**If no healthy node exists, reconstruct from the cluster-side source:**

The file derives from the cluster's own image-pull-secret. Extract it from the cluster and upload to the node:

```bash
# Capture the pull-secret from the cluster (from any machine with kubectl access).
kubectl -n <platform-ns> get secret <pull-secret-name> \
  -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > /tmp/kubelet-config.json
```

Transfer `/tmp/kubelet-config.json` to the node through whatever channel remains (out-of-band console, boot into maintenance mode, mount the disk from a neighbouring node). Place it at `/var/lib/kubelet/config.json` with the same permissions as above.

### After the file is restored

The dependent services unblock themselves on their next retry tick, but a restart is faster. From the node's root shell:

```bash
systemctl restart nodeip-configuration.service
systemctl restart kubelet
```

`systemctl status nodeip-configuration.service` should reach `active (exited)` within a few seconds. `systemctl status kubelet` should reach `active (running)`.

Once those two services reach `active`, systemd completes the rest of the boot targets. `/run/nologin` is removed, PAM accepts unprivileged logins, and the kubelet resumes sending status updates. The API server sees the node transition to `Ready` within one kubelet-report interval.

### Verify recovery

```bash
# SSH as a normal user should now succeed.
ssh <user>@<node-hostname>

# kubelet's own status.
kubectl get node <node-name>     # should show Ready

# Pull-secret is present with sane permissions.
ls -la /var/lib/kubelet/config.json
# -rw------- 1 root root ... /var/lib/kubelet/config.json
```

### Prevent recurrence

The file is node-critical and should not be deleted by any automation. Two preventive postures:

- **Back it up as part of the node image / initial-config payload.** If nodes are re-provisioned from a golden image or a provisioning template, ensure the template includes the pull-secret so a rebuild from the image always has it.
- **Monitor for the file's absence.** A small node-exporter textfile collector (or any node-level monitoring agent) can run `test -f /var/lib/kubelet/config.json` periodically and alert on absence. The alert fires before a reboot exposes the problem as a full outage.

## Diagnostic Steps

If the node is accessible as root (through an out-of-band console), verify the specific failure shape:

```bash
# /run/nologin present — boot-target not yet complete.
ls -la /run/nologin

# The kubelet's pull-secret.
ls -la /var/lib/kubelet/config.json 2>/dev/null || echo "MISSING: pull-secret"

# Which services are stuck.
systemctl list-units --state=activating --no-pager
```

If `/var/lib/kubelet/config.json` is missing, the diagnosis is confirmed. Any service in `activating` for more than a couple of minutes is likely the one blocking the boot target.

Cross-reference with journal entries for the services named in Root Cause:

```bash
journalctl -u nodeip-configuration.service -u kubelet --since "30 min ago" --no-pager | tail -40
```

`nodeip-configuration.service` retries forever until its registry/API calls succeed; you will see repeated `waiting for …` log lines. `kubelet` reports it cannot pull images because the authoritative config is missing.

After restoring the file and restarting the services, the journal should show `nodeip-configuration.service` reporting the discovered IP and `kubelet` reporting a successful `Register node …` event.
