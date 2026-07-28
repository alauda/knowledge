---
title: Configure Kubelet Log Level Verbosity on Alauda Container Platform
component: observability
scenario: how-to
tags: [kubelet, logging, systemd, troubleshooting]
date_created: 2026-05-30
date_updated: 2026-05-30
---

# Configure Kubelet Log Level Verbosity on Alauda Container Platform

## Issue

When investigating a node-level problem such as a kubelet that is slow to register pods, stuck on container GC, or generating unexpected NotReady events, the default kubelet log volume is often too sparse to show the failing decision path. Kubelet exposes the upstream klog verbosity control as the `logging.verbosity` field in its `KubeletConfiguration` (`/var/lib/kubelet/config.yaml`, `apiVersion: kubelet.config.k8s.io/v1beta1`), and the same value can be raised at the systemd layer by passing `-v=<level>` to the `kubelet` binary [ev:c1_a]. Raising verbosity surfaces additional klog lines so the failing flow is easier to follow.

## Root Cause

On Alauda Container Platform (k8s v1.34.5 on the verified cluster), the kubelet runs as a host systemd unit at `/etc/systemd/system/kubelet.service` with the kubeadm-supplied drop-in `/usr/lib/systemd/system/kubelet.service.d/10-kubeadm.conf` already in the load path. That drop-in resets `ExecStart=` and re-launches `/usr/bin/kubelet` with three variables — `$KUBELET_KUBECONFIG_ARGS`, `$KUBELET_CONFIG_ARGS`, and `$KUBELET_KUBEADM_ARGS` — which means kubelet's effective command line is assembled from `EnvironmentFile=-/var/lib/kubelet/kubeadm-flags.env` plus the `--config` file [ev:c3_a]. There are two places where verbosity can be introduced: the `KubeletConfiguration` file the kubelet reads at startup, or an additional systemd drop-in that injects `-v=<level>` into the `ExecStart` line [ev:c3_b].

## Resolution

There are two equivalent places to raise kubelet verbosity on a node — the `KubeletConfiguration` file or a systemd drop-in — and either change is picked up by restarting the `kubelet.service` unit on that node [ev:c3_b].

**Path A — edit the kubelet configuration file (persistent).** Change `logging.verbosity` in `/var/lib/kubelet/config.yaml` on the node, then restart the unit. The kubelet reads its merged `KubeletConfiguration` from that file at startup, so the new value applies after the next `systemctl restart kubelet` [ev:c1_a]:

```yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
logging:
  verbosity: 4
# ... rest of the existing fields unchanged
```

Apply it:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

**Path B — add a systemd drop-in (per-node one-time override).** Drop-in unit files placed under `/etc/systemd/system/kubelet.service.d/` are merged with the unit fragment and the existing `10-kubeadm.conf` drop-in at load time, so adding a small file there is the lightest-weight way to override `ExecStart=` for a single node [ev:c3_a]. Create `/etc/systemd/system/kubelet.service.d/20-verbose.conf` on the target node; the override resets `ExecStart=` and re-launches the kubelet with the same three variables the kubeadm drop-in already uses, appending `-v=<level>` [ev:c3_a][ev:c3_b]:

```text
[Service]
ExecStart=
ExecStart=/usr/bin/kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS $KUBELET_KUBEADM_ARGS -v=4
```

Reload systemd and restart kubelet so the new drop-in takes effect [ev:c3_b]:

```bash
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

After the relevant log lines have been collected, revert the change (delete `/etc/systemd/system/kubelet.service.d/20-verbose.conf` or set `logging.verbosity: 0`) and restart kubelet again to return to the baseline log volume [ev:c1_a][ev:c3_b].

## Diagnostic Steps

Confirm the live kubelet configuration via the kubelet's own configz endpoint; the `logging.verbosity` field reflects whatever value the kubelet currently runs with [ev:c1_a]:

```bash
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" \
  | python3 -c 'import sys, json; print(json.dumps(json.load(sys.stdin)["kubeletconfig"]["logging"], indent=2))'
```

Tail the kubelet's klog stream on the node itself. Kubelet logs to the systemd journal, so `journalctl -u kubelet.service` returns the raw `Ixxxx`/`Exxxx` lines — increase verbosity first, reproduce the symptom, then read the journal back to the moment of the event [ev:c4]:

```bash
sudo journalctl -b -f -u kubelet.service
```

Two related forms of the same command are useful when collecting a window of history rather than tailing live:

```bash
# Lines since the most recent boot, paged
sudo journalctl -b -u kubelet.service --no-pager
# A specific time window
sudo journalctl -u kubelet.service --since "2026-05-30 03:00:00" --until "2026-05-30 03:30:00"
```
