---
kind:
  - How To
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
  - "4.3"
---

# Preparing a host before adding it to an ACP cluster: node check items, disks, init script, DefaultTasksMax, root access

## Issue

Before deploying the platform or adding a node, the following questions come up:

- Which operating-system and kernel parameters must be changed on the host, and why?
- How much disk does a new worker node need, and which mount points?
- What has to be run on a new server before it is added to an existing cluster?
- Why did the initialization script comment out `UsePAM` in `/etc/ssh/sshd_config`?
- What should `DefaultTasksMax` be, and which ports does a business cluster need?
- Can the deployment use a non-root user with limited rights?

Skipping these steps shows up later as node availability check failures, kernels the CNI cannot work with, or installs that stop on a missing package.

Related articles: "Adding a node to an ACP cluster fails on UseDNS or UsePAM, the node does not boot after init.sh, or a cloned node fails at yum" covers failures during the add; "Which operating systems, kernels, and CPU architectures can run in an ACP cluster" covers OS, kernel, and architecture support.

## Root Cause

### Cause 1: the node check has mandatory items that depend on the platform version

The requirements are version-specific and are published in the product documentation under **Installation → Node Preprocessing → Node Check** (on a running platform, open **Help Documentation** in the top-right corner). For ACP 4.1.6 the check splits configuration into items that must pass and scenario-specific checks. The mandatory items include:

- Kernel command line: `transparent_hugepage=never`; on CentOS 7.x also `cgroup.memory=nokmem`.
- Kernel modules: the `ip_vs` series and `nf_conntrack`; with Kube-OVN as CNI also `geneve` and `openvswitch`.
- AppArmor / SELinux, the host firewall, and swap.
- SSH: the user's permissions, and `UseDNS` and `UsePAM` in `sshd_config`.

### Cause 2: the initialization script comments out UsePAM

The platform drives nodes through automated SSH logins and remote commands. The initialization script comments out `UsePAM` (which was `yes`) so that PAM modules do not interfere with those automated logins and commands. The node check inspects `UsePAM` and `UseDNS`, and warns with `/etc/ssh/sshd_config文件中 UsePAM 参数被注释或值不为 no，请调整` (the `UsePAM` parameter in `/etc/ssh/sshd_config` is commented out or not `no`; adjust it). That warning is non-blocking: node preprocessing sets it to prevent SSH timeouts during the add, and it is not a problem once the node has joined.

### Cause 3: worker disk layout follows usage, not the existing nodes

For ACP 4.3.1 worker nodes, the recommended starting point is:

| Mount point | Minimum |
|---|---|
| `/cpaas` | 100 GB |
| `/var/lib/containerd` | 200 GB |

The real need depends on the number of Pods, image sizes and how many versions are kept, temporary container data, log volume, and local storage. Disks can start at the initial size and be expanded as usage grows. A new node does not have to copy the disks of the existing nodes. A node that will later host log or monitoring storage needs `/cpaas` on its own mount.

### Cause 4: a new server must be initialized before it is added

To add a server to a business cluster (for example on ACP 4.2.1): check the node against the deployment documentation of that version, run `init.sh` from the installer package of the same version on the node, then add the node through the platform. The `init.sh` kept on the first control-plane node of `global` (under `/root`) can also be copied to the new node and run there.

### Cause 5: DefaultTasksMax must be infinity, and the business cluster ports

For a production plan on Kylin (kernel `4.19.90-89.26.v2401`), two check items apply: `DefaultTasksMax` in `/etc/systemd/system.conf` must be `infinity`, and a 4.x business cluster needs ports 6443 and 11780 open for this purpose; 11781 is not needed. A change to `/etc/systemd/system.conf` takes effect only after `systemctl daemon-reexec`; `daemon-reload` rereads unit files but not the manager configuration. After `daemon-reexec`, only units started afterwards get the new default.

### Cause 6: the deployment needs root or sudo on the nodes

Deployment creates directories such as `/var/lib/containerd/`, `/var/lib/kubelet/`, `/var/lib/etcd/`, and `/cpaas/`, and runs partitioning commands. A non-root user with a restricted set of rights is not supported; the deployment needs `root` or a user with sudo rights.

## Resolution

### Cause 1: the node check has mandatory items that depend on the platform version

Apply the items from the Node Check page of your version. The commands below cover the items listed above.

> **Warning:** Changing the kernel command line requires a reboot, and a typo in the boot entry can leave the host unbootable. Do it before the host joins, or drain it first. Rollback: remove the arguments with the same tool (`grubby --update-kernel=ALL --remove-args=...`) and reboot. Disabling swap and the firewall changes host behavior for every process; follow your site's security approval for the firewall item.

```bash
# kernel command line (distributions that use grubby, such as CentOS and Kylin)
cat /proc/cmdline
sudo grubby --update-kernel=ALL --args="transparent_hugepage=never"
# CentOS 7.x only
sudo grubby --update-kernel=ALL --args="cgroup.memory=nokmem"

# kernel modules, loaded now and at boot
sudo modprobe -a ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh nf_conntrack
printf '%s\n' ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh nf_conntrack | sudo tee /etc/modules-load.d/acp.conf
# Kube-OVN clusters only
sudo modprobe -a geneve openvswitch
printf '%s\n' geneve openvswitch | sudo tee -a /etc/modules-load.d/acp.conf

# swap
sudo swapoff -a
```

Comment out the swap line in `/etc/fstab` so swap stays off after a reboot. Reboot once after the command-line change and confirm with `cat /proc/cmdline`.

### Cause 2: the initialization script comments out UsePAM

The change is intentional; keep it. If the availability check warns about `UsePAM` or `UseDNS`, set both explicitly to `no`, then check the values sshd actually uses:

```bash
sudo grep -n -E '^\s*#?\s*(UsePAM|UseDNS)' /etc/ssh/sshd_config
# after setting "UsePAM no" and "UseDNS no":
sudo sshd -t && echo "sshd_config syntax OK"
sudo systemctl restart sshd
sudo sshd -T | grep -i -E '^(usepam|usedns) '
```

If a site baseline requires PAM for SSH logins, raise it with Alauda technical support before re-enabling `UsePAM`.

### Cause 3: worker disk layout follows usage, not the existing nodes

Create the mounts before the node is added, sized from the table and the expected workload:

```bash
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE
df -h /cpaas /var/lib/containerd
findmnt /cpaas /var/lib/containerd
```

Plan a separate `/cpaas` volume on any node that may later become a log or monitoring storage node.

### Cause 4: a new server must be initialized before it is added

1. Run the checks of your version on the new server.
2. Run the installer's `init.sh` of the same version:

   ```bash
   # on the new server, from the extracted installer package of the same version
   sudo bash ./init.sh
   ```

   The script path inside the package can differ between versions; use the one named in that version's deployment documentation. Start the scripts with `bash`, not `sh`; an add-node script run with `sh` fails on its syntax.

3. Add the node from the cluster's node page, and check afterwards that its monitoring metrics are collected.

### Cause 5: DefaultTasksMax must be infinity, and the business cluster ports

> **Warning:** `systemctl daemon-reexec` restarts the systemd manager in place; running services keep running, but a broken `/etc/systemd/system.conf` affects every unit started afterwards. Apply it before the node joins, after backing up the file. Rollback: restore the backup and run `systemctl daemon-reexec` again.

```bash
sudo cp /etc/systemd/system.conf /root/system.conf.bak
if grep -qE '^\s*#?\s*DefaultTasksMax=' /etc/systemd/system.conf; then
  sudo sed -ri 's/^\s*#?\s*DefaultTasksMax=.*/DefaultTasksMax=infinity/' /etc/systemd/system.conf
else
  echo 'DefaultTasksMax=infinity' | sudo tee -a /etc/systemd/system.conf
fi
sudo systemctl daemon-reexec
systemctl show --property=DefaultTasksMax
```

The expected output is `DefaultTasksMax=infinity`. Units that are already running keep the old value until they restart or the node reboots; because node preprocessing happens before installation, containerd and kubelet start with the new value.

Open ports 6443 and 11780 for the business cluster as listed above.

### Cause 6: the deployment needs root or sudo on the nodes

Give the deployment user root, or sudo without a password prompt (the availability check runs sudo non-interactively):

```bash
id <user>
sudo -l -U <user>
```

## Diagnostic Steps

Run on the host before adding it, and compare with a node already in the cluster:

```bash
cat /etc/os-release; uname -r
cat /proc/cmdline
cat /sys/kernel/mm/transparent_hugepage/enabled
lsmod | grep -E 'ip_vs|nf_conntrack|geneve|openvswitch'
swapon --show
getenforce 2>/dev/null || true
systemctl is-active firewalld 2>/dev/null || true
sudo sshd -T | grep -i -E '^(usepam|usedns) '
df -h /cpaas /var/lib/containerd
hostname
systemctl show --property=DefaultTasksMax
rpm -qa | grep -i -E 'docker|podman' || true
```

Expected results: `[never]` in the transparent hugepage file, the listed modules loaded, an empty `swapon --show`, `usepam no` and `usedns no`, `DefaultTasksMax=infinity`, a lowercase hostname, and no preinstalled Docker or podman packages. A missing module or an active `UsePAM` appears in the availability check as a failure or warning.
