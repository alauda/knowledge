---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A Windows VM is migrated from VMware into the cluster's virtualization stack via the migration toolkit (the workflow that drives `virt-v2v` and writes a Firstboot script into the destination guest to apply the source IP configuration). The VM boots, but its static IP address is not applied. The Firstboot logs inside the destination guest show the configuration script crashing on `New-NetIPAddress`:

```text
adapters = 'MSFT_NetAdapter (DeviceID = "{...}", SystemName = "VMINWIN.example.com")'
setting IP address of adapter at 12
New-NetIPAddress : The RPC server is unavailable.
At C:\Program Files\Guestfs\Firstboot\Temp\network-configure.ps1:18 char:5
+ New-NetIPAddress -InterfaceIndex $ifindex -IPAddress '10.9.222.25 ...
```

The Windows Event Log (`Event Viewer`) shows a service-dependency chain failure:

```text
The Network List Service depends on Network Location Awareness, which failed
  to start because of: dependency service or group failed to start.
The Network Location Awareness service depends on the DHCP Client service,
  which failed to start because: the service cannot be started, either because
  it is disabled or because it has no enabled devices associated with it.
```

The VM is up; the network adapter is present; only the static IP from the source did not stick.

## Root Cause

`New-NetIPAddress`, the PowerShell cmdlet the Firstboot network-configuration script uses, has a non-obvious service-dependency chain inside Windows:

```text
New-NetIPAddress  →  RPC to Network Location Awareness (NlaSvc)
                 →  Network Location Awareness depends on Network List Service
                 →  Network List Service depends on DHCP Client (Dhcp)
```

Even when the guest is configured purely with a static IP, the DHCP Client service must be enabled (start type `Manual` or `Automatic`) for the rest of the chain to come up — it provides the internal RPC plumbing those services use to register the interface state. If DHCP Client is *disabled* on the source VM (often by a corporate Group Policy that hardens the OS by killing services that look unused), the same disabled state is carried into the migrated guest. On first boot, NLA cannot start, the RPC endpoint `New-NetIPAddress` calls is not registered, and the cmdlet fails with "The RPC server is unavailable."

The failure surfaces in the migrated VM, but the cause is on the source side — the source's service configuration was migrated faithfully and that configuration is broken for the way Firstboot is going to drive `New-NetIPAddress`.

## Resolution

Fix the DHCP Client service on the **source** VM, then re-run the migration.

### 1. Enable DHCP Client on the source VM

On the source VM (still on its original hypervisor):

1. Open `Services.msc`.
2. Locate **DHCP Client**.
3. Set the *Startup type* to **Manual** or **Automatic**.
4. Click **Start** and confirm the service shows *Running*.

That is enough to make `New-NetIPAddress` work on the next boot — the service does not need to be doing anything visible, only registering its RPC endpoint.

### 2. If the service is locked down by Group Policy

If the *Startup type* dropdown is greyed out or reverts after a reboot, the service is being managed by a Group Policy Object pushing `Start = 4` (disabled). The corporate GPO has to be updated:

- Either remove DHCP Client from the GPO's **System Services** policy entirely (so the service's local startup type wins), or
- Set its policy startup type to **Manual**.

After the GPO change, run `gpupdate /force` on the VM and verify with `Get-Service Dhcp` that the service is back to startable. Without this, the GPO will reset the service to disabled on the destination VM as well, defeating the migration even after a fresh run.

### 3. Re-run the migration

In the migration toolkit's UI / CR, archive the failed migration plan and restart it. With DHCP Client enabled on the source, the destination Firstboot script's `New-NetIPAddress` finds an answering RPC server and the static IP applies cleanly.

### Avoiding the trap on a fleet

If you migrate Windows VMs in batches, add a pre-flight check to the migration runbook: enumerate the source VMs and warn on any whose DHCP Client service is disabled. The check is a one-liner against each source guest:

```text
Get-Service Dhcp | Format-Table Name, Status, StartType
```

Anything where `StartType` is `Disabled` is a candidate to break the same way. Catching this before the cutover is much cheaper than a failed migration window.

## Diagnostic Steps

1. Capture the Firstboot logs from the destination VM. They live at `C:\Program Files\Guestfs\Firstboot\log` and are visible from inside the guest:

   ```text
   type "C:\Program Files\Guestfs\Firstboot\log\firstboot.log"
   ```

   The `New-NetIPAddress: The RPC server is unavailable` line is the fingerprint.

2. Inspect the Event Viewer's *System* log for the dependency chain failure. Filter for source `Service Control Manager`. The three messages above (DHCP Client disabled → NLA failed → Network List Service failed) appear in sequence around boot time.

3. Verify the DHCP Client service on the destination VM:

   ```text
   Get-Service Dhcp | Format-Table Name, Status, StartType
   ```

   `StartType: Disabled` confirms the service-dependency cause. `StartType: Manual` and `Status: Running` is what a healthy guest shows.

4. After the fix, watch the next migration's destination Firstboot log — the script should report each adapter being configured without the RPC error, and the guest should come up with the expected static IP. `ipconfig /all` from inside the new guest is the final check.

5. If a migration succeeds but DHCP Client comes back as disabled later (because the GPO is still active in the new environment), expect the next reboot to drop the IP again. The GPO has to be either removed from scope or relaxed for this service before treating the issue as closed.
