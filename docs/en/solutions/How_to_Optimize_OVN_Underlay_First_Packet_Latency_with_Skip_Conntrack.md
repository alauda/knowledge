---
id: KB202604070001
products:
  - Alauda Container Platform
kind:
  - Solution
sourceSHA: pending
---

# Optimize OVN Underlay First Packet Latency with Skip Conntrack (S2 Solution)

This document describes how to configure the `skip-conntrack-dst-cidrs` parameter in Kube-OVN to skip conntrack processing for specified destination IP CIDRs, reducing first packet latency in OVN underlay networks.

## Overview

In OVN underlay network mode, all cross-subnet traffic goes through conntrack (connection tracking) processing by default, which increases first packet latency. For latency-sensitive scenarios, the `skip-conntrack-dst-cidrs` feature can be used to bypass conntrack processing and reduce first packet latency.

The `skip-conntrack-dst-cidrs` feature allows administrators to specify destination IP CIDRs that should bypass conntrack processing entirely. It works by inserting priority 105 flows in the OVN `ls_in_pre_lb` logical flow table, which take precedence over the default priority 100 conntrack flow.

## Prerequisites

| Item | Requirement |
|------|------|
| ACP Version | 4.3+ |
| Network Mode | OVN Underlay |
| Kube-OVN Version | v1.15+ (with skip-conntrack-dst-cidrs support) |

## Configuration Steps

> **Warning**: Once conntrack is skipped for a destination CIDR, the following OVN features will **no longer take effect** for traffic to that CIDR:
> - **NetworkPolicy** — NetworkPolicy rules will not be able to control Pod traffic for the CIDR
> - **Service Access** — When the backend Pods of a Service are in the CIDR, the Service cannot be accessed via ClusterIP, NodePort, or LoadBalancer
>
> Ensure that the target CIDRs are **directly accessed Pod-to-Pod traffic** that does not rely on NetworkPolicy or Service routing.

### Step 1: Configure Kube-OVN Controller

Add the `--skip-conntrack-dst-cidrs` startup parameter to the kube-ovn-controller Deployment:

```bash
kubectl edit deploy kube-ovn-controller -n kube-system
```

Find the container args section and add the parameter:

```yaml
containers:
  - name: kube-ovn-controller
    args:
      # ... existing args ...
      - --skip-conntrack-dst-cidrs=10.0.0.0/24,192.168.1.0/24    # Replace with actual target CIDRs
```

After saving, the configuration takes effect automatically. To remove, delete the `--skip-conntrack-dst-cidrs` line and save.
