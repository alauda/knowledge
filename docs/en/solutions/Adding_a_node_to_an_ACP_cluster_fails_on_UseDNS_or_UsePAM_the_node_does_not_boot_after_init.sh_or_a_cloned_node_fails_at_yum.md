---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# Adding a node to an ACP cluster fails on UseDNS or UsePAM, the node does not boot after init.sh, or a cloned node fails at yum

## Issue

- The availability check of a new node fails with `节点可用性检查未通过，无法添加节点到集群下` (the node availability check did not pass; the node cannot be added to the cluster) together with `检查sshd配置：/etc/ssh/sshd_config文件中 UseDNS 参数被注释或值不为 no，请调整` (sshd check: the `UseDNS` parameter in `/etc/ssh/sshd_config` is commented out or not `no`; adjust it).
- Adding a node succeeds only sometimes. The node's secure log shows most platform logins as `Accepted password for <user> ... ssh2` and some as `Failed password for <user> ... ssh2` followed by `Connection closed by authenticating user <user> ... [preauth]`.
- A new workload-cluster node runs the initialization script and then does not boot after a reboot. Without the script it reboots normally, and `lsblk` and `/etc/fstab` look fine.
- Adding a node that was cloned from an existing node fails at the task `[core/bootstrap-os : Installing basic packages using yum]` with `"msg": "MODULE FAILURE"` and `Install failed!`, and the traceback ends with:

  ```text
  shutil.Error: Destination path '/etc/yum.repos.d/temp/temp_repo_0.repo' already exists
  ```

Related articles: "Preparing a host before adding it to an ACP cluster: node check items, disks, init script, DefaultTasksMax, root access" covers what to prepare; "Which operating systems, kernels, and CPU architectures can run in an ACP cluster" covers an add that fails with an unsupported operating system.

## Root Cause

### Cause 1: UseDNS or UsePAM in sshd_config is commented out or not no

The platform adds nodes through automated SSH logins. The availability check requires `UseDNS no` and inspects `UsePAM`. With `UseDNS` commented out or not `no`, the check fails and the node is not added; after `UseDNS no` is set, the node is added.

Intermittent `Failed password` entries for the platform's logins, while most logins of the same user succeed, stop after `UsePAM` is set to `no`, and the checks then pass every time. Because a commented or overridden line in `sshd_config` is not what sshd actually uses, check the effective values with `sshd -T`, not only the file.

### Cause 2: the cgroup nokmem step of the init script stops the node from booting

The `config cgroup nokmem` step of the initialization script writes kernel parameters into the grub configuration. On some hosts those parameters stop the node from booting. Commenting out that section of the script before running it lets the node be initialized and rebooted normally.

### Cause 3: a cloned node carries the yum repository backup of the original node

The yum task backs up the existing repository files by moving them into `/etc/yum.repos.d/temp/`. A machine cloned from an existing node (even after a cleanup script from another environment was run on it) still holds state from the original node, including `/etc/yum.repos.d/temp/temp_repo_0.repo`. The move then fails because the destination exists, and the install stops. The output can also show `setlocale: LC_ALL: cannot change locale (C.UTF-8)` warnings, which are not the failure. A freshly installed machine is added normally.

## Resolution

### Cause 1: UseDNS or UsePAM in sshd_config is commented out or not no

1. Read the file and the effective values:

   ```bash
   sudo grep -n -E '^\s*#?\s*(UsePAM|UseDNS)' /etc/ssh/sshd_config
   sudo sshd -T | grep -i -E '^(usepam|usedns) '
   ```

2. Set `UseDNS no` and `UsePAM no` explicitly in `/etc/ssh/sshd_config`.

   > **Warning:** A syntax error in `sshd_config` can stop sshd from accepting new logins after the restart. Keep the current session open, back the file up first, and validate it before restarting. Rollback: restore the backup and restart sshd.

   ```bash
   sudo cp -a /etc/ssh/sshd_config /root/sshd_config.bak
   sudo vi /etc/ssh/sshd_config
   sudo sshd -t && sudo systemctl restart sshd
   sudo sshd -T | grep -i -E '^(usepam|usedns) '
   ```

   Expected: `usedns no` and `usepam no`.

3. Run the availability check and add the node again.

### Cause 2: the cgroup nokmem step of the init script stops the node from booting

1. Before running the init script on such a node, find its `config cgroup nokmem` section:

   ```bash
   grep -n -i 'nokmem' init.sh
   ```

2. Comment out that section, then run the script with `bash`.
3. For a node that already fails to boot, compare its kernel command line and grub configuration with a node that boots, and remove the parameters that the step added:

   ```bash
   cat /proc/cmdline    # on a node that boots, for comparison
   ```

### Cause 3: a cloned node carries the yum repository backup of the original node

1. Check the node for the leftover backup:

   ```bash
   ls -la /etc/yum.repos.d/ /etc/yum.repos.d/temp/ 2>/dev/null
   ```

2. Replace the clone with a freshly installed machine and add that machine instead.

## Diagnostic Steps

1. Read the failed item of the availability check in the console.
   - `UseDNS 参数被注释或值不为 no`: Cause 1.
   - Intermittent add failures: read the node's secure log (`/var/log/secure`, or `/var/log/auth.log` on Ubuntu) for `Failed password` from the platform's address next to `Accepted password` for the same user: Cause 1.
2. A node that boots without the init script and does not boot after it: check whether the script contains a `nokmem` step (`grep -n -i nokmem init.sh`): Cause 2.
3. `Installing basic packages using yum` fails with `temp_repo_0.repo' already exists`, and `ls /etc/yum.repos.d/temp/` lists files on a cloned machine: Cause 3.
