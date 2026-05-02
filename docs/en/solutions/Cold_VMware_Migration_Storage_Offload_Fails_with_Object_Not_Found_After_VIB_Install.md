---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Cold VMware Migration Storage-Offload Fails with Object-Not-Found After VIB Install
## Issue

A cold VMware migration configured with Storage Offload (direct SAN copy via `vmkfstools-wrapper`) fails on a host where the wrapper VIB was recently installed. The migration controller correctly identifies the VIB as installed, but the actual offload command errors with:

```text
The object or item referred to could not be found
```

The offload step returns immediately; no data is copied. `esxcli software vib list` on the host shows the wrapper VIB as installed — which makes the failure confusing, because the prerequisite check and the runtime behaviour disagree.

## Root Cause

ESXi discovers new `esxcli` plugins at **hostd startup**. Installing the VIB registers the plugin in the VIB database and advertises it to `esxcli software vib list`, but the running `hostd` process continues to use its cached plugin inventory until it restarts. The migration controller's plugin-availability probe looks at the VIB registry (sees "installed" → ✓), while the actual offload call goes through `hostd`, which still doesn't know about the plugin and returns `object not found`.

The pattern is specific to ESXi's two-phase plugin load: install makes it visible; restart makes it runnable.

## Resolution

Restart `hostd` on each ESXi host where the wrapper VIB was installed, then retry the migration.

1. **Identify the hosts that have the VIB installed** (ESXi CLI):

   ```bash
   esxcli software vib list | grep -iE 'vmkfstools|wrapper'
   ```

2. **Restart the management service on those hosts.** `hostd` supervises VM state and API access; restarting it briefly interrupts new API calls but does **not** power-cycle running VMs. Still, schedule this during a quiet window if the host hosts production VMs:

   ```bash
   /etc/init.d/hostd restart
   ```

   Wait ~30 seconds for hostd to come back fully (check with `/etc/init.d/hostd status`), then verify the plugin registered:

   ```bash
   esxcli --help 2>&1 | grep -i vmkfstools || esxcli storage nmp device list >/dev/null
   ```

3. **Re-trigger the migration plan**. Delete any stuck migration tasks first if the plan is already in a failed state; the new attempt will pick up the now-loaded plugin.

4. **For future VIB installs**, add "restart hostd" as a post-install step in whatever automation pushes the VIB. `esxcli software vib install` does not restart hostd automatically; documentation says so, but operators often miss it in cluster-scale rollouts.

## Diagnostic Steps

Distinguish this failure mode from other Storage-Offload errors:

```bash
# On ESXi: VIB visible?
esxcli software vib get -n <vib-name>

# On ESXi: hostd plugin list — this is what actually gets consulted at runtime
esxcli --debug system version get 2>/dev/null

# On the migration controller: inspect the exact error line
kubectl -n <migration-ns> logs <forklift-controller> --tail=200 \
  | grep -iE 'offload|vmkfstools|object.*not.*found'
```

If `esxcli software vib get` shows the VIB and the controller log reports "object not found" on an `esxcli vmkfstools` subcommand, the hostd-restart path is the fix. If the controller log shows SSH authentication failures or SSL errors instead, you're looking at a different issue — the VIB presence is a red herring.

A successful retry after `hostd` restart produces normal Storage-Offload progress lines in the migration plan's log. If the VIB disappears or becomes corrupt after the restart, reinstall it and restart hostd again — do not proceed with migrations on a host whose VIB inventory is inconsistent.
