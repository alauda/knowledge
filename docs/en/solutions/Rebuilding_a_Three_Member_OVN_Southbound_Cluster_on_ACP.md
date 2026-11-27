---
products:
  - Alauda Container Platform
kind:
  - Solution
ProductsVersion:
  - '4.5.x'
---

# Rebuild an OVN Southbound cluster after all three replicas are corrupted

## Issue

All three `ovn-central` Pods fail to start, and their logs report a parse error in `ovnsb_db.db`. Use this procedure when all three Southbound (SB) database files are corrupted and you have no usable SB backup. Northbound (NB) and SB share a startup sequence, so an SB preflight failure can prevent NB from starting even if its files are intact. Scaling the Deployment down and back up reuses the database files on the hosts.

## Environment

- Alauda Container Platform (ACP) 4.5 with the three-replica `kube-system/ovn-central` Deployment, host networking, and host-local Raft database files. The procedure was exercised on a development cluster running Kube-OVN `v1.16.18`.
- A management terminal with Kubernetes API access and permission to scale Deployments. SSH or console access as root on all three Raft nodes.
- containerd on each node, with the deployed `ovn-central` image available locally. The commands use the default containerd socket. The OVN `hostPath` is typically `/etc/origin/ovn`. Verify the actual path in step 1.
- At least two original NB database files that can form a quorum. One of them must be the local NB file on the first node listed in `NODE_IPS`.

## Resolution

The rebuild stops all `ovn-central` processes. New Pods and network configuration changes may fail during the outage. After the new SB cluster starts, `ovn-northd` uses NB to regenerate logical flows and port records. The `ovn-controller` on each node registers its Chassis and reestablishes port bindings. Network traffic repopulates dynamic MAC bindings. [OVN maintainers' guidance](https://mail.openvswitch.org/pipermail/ovs-dev/2020-July/373441.html) · [OVN architecture](https://www.ovn.org/support/dist-docs/ovn-architecture.7.html)

### 1. Identify the Raft nodes, image, and database path

**Run on the management terminal.** Verify the current Kubernetes context and inspect the Deployment and Pods.

```bash
kubectl config current-context
kubectl -n kube-system get pods -l app=ovn-central -o wide
kubectl -n kube-system get deployment ovn-central -o yaml
kubectl -n kube-system get deployment ovn-central \
  -o jsonpath='{.spec.template.spec.containers[?(@.name=="ovn-central")].env[?(@.name=="NODE_IPS")].value}{"\n"}'
kubectl get nodes -o wide
```

`NODE_IPS` is an environment variable of the `ovn-central` container. The query prints its comma-separated list of node addresses. In the order printed, match each address to the `INTERNAL-IP` column in the node listing and record the corresponding `NAME`. Confirm that the Deployment specifies three replicas, the Pod template sets `hostNetwork: true`, and the Pod listing shows one `ovn-central` Pod on each of the three distinct nodes.

- The **SB bootstrap node** is the node whose address appears first in `NODE_IPS`. Create the empty SB database on this node in step 5 and install the new SB file there in step 6. Its local NB database must pass the checks in step 4.
- Choose the **NB source node** after step 4. Select either of the other two nodes whose NB file passes validation and has the same CID and a different SID from the bootstrap node's NB file. In step 5, copy the source node's archived NB file to the bootstrap node to validate the two NB files together.

Record the `ovn-central` container's `image`, `ENABLE_SSL`, and `DB_CLUSTER_ADDR` if set. In `volumeMounts`, find the volume mounted at `/etc/ovn` and record that volume's `hostPath.path`. Record the ports from the container environment. Use the defaults in the table for unset variables.

| Environment variable | Purpose | Default port |
| --- | --- | --- |
| `NB_PORT` | NB client connections | `6641` |
| `SB_PORT` | SB client connections | `6642` |
| `NB_CLUSTER_PORT` | NB Raft traffic | `6643` |
| `SB_CLUSTER_PORT` | SB Raft traffic | `6644` |

Kube-OVN uses the node's effective `DB_CLUSTER_ADDR` for its local Raft address and falls back to the `ovn-central` Pod IP when the variable is unset. In this host-networked deployment, the Pod IP corresponds to the node address in `NODE_IPS`. TLS uses `ssl` and plaintext uses `tcp`. Step 5 reads the complete address from the bootstrap node's archived SB database. [Kube-OVN startup script](https://github.com/kubeovn/kube-ovn/blob/v1.16.18/dist/images/start-db.sh)

Use each affected Pod's name from the Pod listing to review its logs. For a Pod that has just failed for the first time, omit `--previous` to read the current logs.

```bash
kubectl -n kube-system logs '<failed Pod name>' -c ovn-central --previous --tail=100
```

Typical output includes these messages. Step 4 checks all three database files directly.

```text
ovsdb-tool: syntax error: /etc/ovn/ovnsb_db.db: parse error at offset ... in header line ""
no consistent live sb quorum is reachable; keeping /etc/ovn/ovnsb_db.db unchanged
```

### 2. Stop the monitor and ovn-central

**Run on the management terminal.** Save the current `kube-ovn-monitor` replica count. Record the printed value and keep this terminal open for step 8. If the monitor Deployment is absent, skip to stopping `ovn-central`.

```bash
MONITOR_REPLICAS=$(kubectl -n kube-system get deployment kube-ovn-monitor -o jsonpath='{.spec.replicas}') &&
  printf 'MONITOR_REPLICAS=%s\n' "$MONITOR_REPLICAS"
```

After you have the replica count, scale the monitor to zero and confirm that its Pods have exited.

```bash
kubectl -n kube-system scale deployment/kube-ovn-monitor --replicas=0
kubectl -n kube-system wait --for=delete pod -l app=kube-ovn-monitor --timeout=180s
kubectl -n kube-system get pods -l app=kube-ovn-monitor -o wide
```

Stop the `ovn-central` Deployment.

```bash
kubectl -n kube-system scale deployment/ovn-central --replicas=0
kubectl -n kube-system wait --for=delete pod -l app=ovn-central --timeout=180s
kubectl -n kube-system get deployment ovn-central
kubectl -n kube-system get pods -l app=ovn-central -o wide
```

**Continue when** `ovn-central` shows `0/0` and both Pod lists are empty. If a platform controller restores either replica count, pause the relevant reconciliation and confirm that the Pods have exited.

### 3. Archive the database files on all three nodes

**Run as root in Bash on each Raft node.** Confirm that no `ovn-central` container is running and that no process is listening on the NB and SB ports. Replace the port numbers with the values recorded in step 1 if they differ.

```bash
crictl ps --name ovn-central
ss -lntp '( sport = :6641 or sport = :6642 or sport = :6643 or sport = :6644 )'
```

When both commands show only their column headers, replace the `cd` argument with the `hostPath.path` recorded in step 1 and create the archive. Record the printed `BACKUP` path separately for each node. Keep each node's terminal open to reuse its `BACKUP` variable.

```bash
cd -- '<hostPath.path recorded in step 1>' &&
  BACKUP="$PWD/.sb-rebuild-$(date -u +%Y%m%dT%H%M%SZ)" &&
  (
    set -e
    if [ ! -f ovnsb_db.db ]; then
      printf 'Cannot find ovnsb_db.db in %s. Check hostPath.path.\n' "$PWD" >&2
      exit 1
    fi
    mkdir -m 0700 "$BACKUP"
    for file in ovnnb_db.db ovnnb_db.hdr ovnsb_db.db ovnsb_db.hdr; do
      if [ -f "$file" ]; then
        cp -a -- "$file" "$BACKUP/"
      fi
    done
    ls -la -- "$BACKUP"
    printf 'BACKUP=%s\n' "$BACKUP"
  )
```

**Continue when** each archive lists `ovnsb_db.db` and the other NB and SB files present on its node. Step 4 checks the archived databases offline. The leading dot in the archive directory name keeps it outside the startup script's permission changes to `/etc/ovn/*`. [Kube-OVN startup script](https://github.com/kubeovn/kube-ovn/blob/v1.16.18/dist/images/start-db.sh)

### 4. Check the archived NB and SB files

**Run on each Raft node.** Use the image recorded in step 1. Start the tool container from an interactive SSH session or console with a TTY. The container mounts the archive directory and can run with all `ovn-central` Pods stopped. When you exit the container, keep the host session and its `BACKUP` variable.

```bash
IMAGE='<full image reference for the ovn-central container>'
ctr --namespace k8s.io run --rm --tty --user 0:0 \
  --mount "type=bind,src=$BACKUP,dst=/recovery,options=rbind:rw" \
  "$IMAGE" "sb-rebuild-$$" /bin/sh
```

Run these checks **inside the tool container** on each node.

```bash
ovsdb-tool check-cluster /recovery/ovnsb_db.db
echo $?
ovsdb-tool check-cluster /recovery/ovnnb_db.db
echo $?
ovsdb-tool db-cid /recovery/ovnnb_db.db
ovsdb-tool db-sid /recovery/ovnnb_db.db
exit
```

**Continue when** all three SB files report corruption and a nonzero exit status, and at least two NB files pass with exit status `0`. The passing NB files must include the bootstrap node's file, share the same cluster ID (CID), and have different server IDs (SIDs). A successful check can produce no text. A file reported as `has not joined the cluster, omitting` cannot count toward the NB quorum. Record the node name, CID, and SID for each passing NB file. [ovsdb-tool manual](https://www.openvswitch.org/support/dist-docs/ovsdb-tool.1.html)

### 5. Create an empty SB database on the bootstrap node

**Run on the management terminal.** Select the NB source node using the results from step 4. Download its archived NB file, then upload it to the SB bootstrap node's archive directory. Fill in each node's SSH address and the absolute archive paths recorded in step 3. If SSH password authentication is enabled, enter each node's login password at its prompt.

```bash
NB_COPY_DIR=$(mktemp -d) &&
  scp 'root@<source SSH address>:<source archive path>/ovnnb_db.db' \
    "$NB_COPY_DIR/ovnnb-peer.db" &&
  scp "$NB_COPY_DIR/ovnnb-peer.db" \
    'root@<bootstrap SSH address>:<bootstrap archive path>/ovnnb-peer.db'
```

After the upload succeeds, remove the temporary copy from the management host.

```bash
rm -- "$NB_COPY_DIR/ovnnb-peer.db"
rmdir -- "$NB_COPY_DIR"
```

**Run only on the first node in `NODE_IPS`.** Open the tool container again with the `ctr run` command from step 4. Check that the copied file's SID matches the source node's SID recorded in step 4. Continue when the joint check returns `0` and includes both members.

```bash
ovsdb-tool db-sid /recovery/ovnnb-peer.db
ovsdb-tool check-cluster /recovery/ovnnb_db.db /recovery/ovnnb-peer.db
echo $?
```

In the same tool container, read the bootstrap node's original local SB Raft address into `SB_RAFT_ADDR`. The command reads the Raft header, so it can succeed when corruption is limited to the tail of the log.

```bash
SB_RAFT_ADDR=$(ovsdb-tool db-local-address /recovery/ovnsb_db.db) &&
  printf 'SB_RAFT_ADDR=%s\n' "$SB_RAFT_ADDR"
```

If the command fails or prints an empty value, read `local_address` from the same node's archived `ovnsb_db.hdr` into the same variable.

```bash
SB_RAFT_ADDR=$(sed -nE 's/.*"local_address"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' /recovery/ovnsb_db.hdr) &&
  printf 'SB_RAFT_ADDR=%s\n' "$SB_RAFT_ADDR"
```

Check the address's protocol, host, and port against the Deployment settings recorded in step 1. In a standard deployment, the address has the form `ssl:[<bootstrap node address>]:6644` or `tcp:[<bootstrap node address>]:6644`. If both files are unreadable, confirm the complete local SB Raft address from the deployment settings, then assign it with `SB_RAFT_ADDR='<confirmed local SB Raft address>'`.

Create the database in the same tool container. Kube-OVN `v1.16.18` defaults to an election timer of 5000 milliseconds. If a pre-incident SB `cluster/status` record shows a customized value, set `SB_ELECTION_MS` to its `Election timer`. For another image version, use that version's default or the pre-incident value. [Kube-OVN election timer patch](https://github.com/kubeovn/kube-ovn/blob/v1.16.18/dist/images/patches/54056ea65dc28aa1c4c721a2a34d7913f79f8376.patch)

```bash
SB_ELECTION_MS=5000
test -n "$SB_RAFT_ADDR" &&
  test ! -e /recovery/sb-seed.db &&
  ovsdb-tool --election-timer="$SB_ELECTION_MS" create-cluster \
    /recovery/sb-seed.db /usr/share/ovn/ovn-sb.ovsschema "$SB_RAFT_ADDR" &&
  ovsdb-tool check-cluster /recovery/sb-seed.db
echo $?
```

If the archive already contains `sb-seed.db`, verify its origin and state before proceeding. After creation and validation succeed, check the new file's local address and record its CID.

```bash
ovsdb-tool db-local-address /recovery/sb-seed.db
ovsdb-tool db-cid /recovery/sb-seed.db
exit
```

**Continue when** creation and validation return `0`, the new file's local address matches `SB_RAFT_ADDR`, and you have recorded its new CID.

### 6. Move the old SB files and install the new database

**On the management terminal**, repeat the two `ovn-central` queries from step 2. Confirm the Deployment still shows `0/0` and has no Pods.

**On each Raft node**, verify that the current directory and `BACKUP` match the host path and the archive recorded in step 3. If you opened a new session, use `cd` to enter the host path and assign that node's recorded archive path to `BACKUP` first.

```bash
pwd
printf 'BACKUP=%s\n' "$BACKUP"
```

On each node, compare its current SB files with the archive before moving them. Move the old header with the database so that the startup script uses the new cluster's CID.

```bash
(
  set -e
  cmp -- ovnsb_db.db "$BACKUP/ovnsb_db.db"
  if [ -f ovnsb_db.hdr ]; then
    cmp -- ovnsb_db.hdr "$BACKUP/ovnsb_db.hdr"
  fi
  mkdir -m 0700 "$BACKUP/retired"
  mv -- ovnsb_db.db "$BACKUP/retired/"
  if [ -f ovnsb_db.hdr ]; then
    mv -- ovnsb_db.hdr "$BACKUP/retired/"
  fi
  test ! -e ovnsb_db.db
  test ! -e ovnsb_db.hdr
  echo 'Old SB files moved'
)
```

After all three nodes print `Old SB files moved`, run the following **only on the bootstrap node**. Set the new file's owner and group to match the local NB database.

```bash
test ! -e ovnsb_db.db &&
  install -m 0600 "$BACKUP/sb-seed.db" "$BACKUP/sb-install.db" &&
  chown --reference=ovnnb_db.db "$BACKUP/sb-install.db" &&
  mv -- "$BACKUP/sb-install.db" ovnsb_db.db
ls -l ovnnb_db.db ovnsb_db.db
cmp -s "$BACKUP/sb-seed.db" ovnsb_db.db && echo 'SB bootstrap file installed'
```

**Continue when** the bootstrap node prints `SB bootstrap file installed`, the other two nodes have no SB database or header at the live paths, and the original NB files remain in their live locations.

### 7. Start all three ovn-central replicas

**Run on the management terminal.** Start all three replicas in one scale operation so the original NB cluster can elect a leader and the two peers can join the new SB cluster.

```bash
kubectl -n kube-system scale deployment/ovn-central --current-replicas=0 --replicas=3
kubectl -n kube-system rollout status deployment/ovn-central --timeout=300s
kubectl -n kube-system get pods -l app=ovn-central -o wide
```

**Continue when** all three Pods show `1/1 Running`. If startup times out, check the current and previous container logs. When the bootstrap node fails to start, check its seed file's path, permissions, and Raft address. If the bootstrap node starts but either peer fails to join, check the affected peer's logs, connectivity on the SB Raft port, and TLS settings. Keep the archives for diagnosis.

### 8. Verify both databases and Pod networking, then restore the monitor

**Run on the management terminal.** Use the Pod names from step 7 and run both commands on each of the three `ovn-central` Pods.

```bash
kubectl -n kube-system exec '<central Pod name>' -c ovn-central -- \
  ovn-appctl -t /var/run/ovn/ovnnb_db.ctl cluster/status OVN_Northbound
kubectl -n kube-system exec '<central Pod name>' -c ovn-central -- \
  ovn-appctl -t /var/run/ovn/ovnsb_db.ctl cluster/status OVN_Southbound
```

NB should show the original CID, and SB should show the new CID from step 5. Each database should have one leader, two followers, and all three member addresses. Confirm that pending Raft entries drain and that the SB `Election timer` matches the value used in step 5. Use the Pod whose output says `Role: leader` for each database in the corresponding command below.

```bash
kubectl -n kube-system exec '<NB leader Pod name>' -c ovn-central -- \
  ovn-nbctl --timeout=60 --wait=sb sync
kubectl -n kube-system exec '<SB leader Pod name>' -c ovn-central -- \
  ovn-sbctl --timeout=15 --columns=hostname list Chassis
kubectl -n kube-system get daemonset ovs-ovn kube-ovn-cni
```

The sync command should succeed. The Chassis list should contain the expected nodes, and both DaemonSets should have their desired number of ready Pods. If a Chassis stays missing, find that node's `ovs-ovn` Pod in the `NODE` column and read its logs.

```bash
kubectl -n kube-system get pods -l app=ovs -o wide
kubectl -n kube-system logs '<affected ovs-ovn Pod name>' -c openvswitch --tail=100
```

If the log reports `clustered database server has stale data`, reset the SB client state in that Pod and check its connection status. [OVN client reconnection guidance](https://mail.openvswitch.org/pipermail/ovs-discuss/2020-August/050504.html)

```bash
kubectl -n kube-system exec '<affected ovs-ovn Pod name>' -c openvswitch -- sh -ec '
  pid=$(cat /var/run/ovn/ovn-controller.pid)
  ovn-appctl -t "/var/run/ovn/ovn-controller.$pid.ctl" sb-cluster-state-reset
  ovn-appctl -t "/var/run/ovn/ovn-controller.$pid.ctl" connection-status
'
```

Create two test Pods in a namespace that uses the recovered OVN network and permits the test traffic. Choose two different `Ready` nodes from `kubectl get nodes` and use their names for the two `nodeName` values. Use an image that the nodes can pull and that provides `sleep`, `cat`, `ping`, and `nslookup`.

```bash
TEST_NS='<test namespace>'
TEST_IMAGE='<test image available to the nodes>'
kubectl -n "$TEST_NS" run ovn-sb-check --image="$TEST_IMAGE" \
  --restart=Never --overrides='{"spec":{"nodeName":"<first test node name>","automountServiceAccountToken":false}}' \
  --command -- sleep 300
kubectl -n "$TEST_NS" run ovn-sb-peer --image="$TEST_IMAGE" \
  --restart=Never --overrides='{"spec":{"nodeName":"<second test node name>","automountServiceAccountToken":false}}' \
  --command -- sleep 300
kubectl -n "$TEST_NS" wait --for=condition=Ready \
  pod/ovn-sb-check pod/ovn-sb-peer --timeout=120s
kubectl -n "$TEST_NS" get pods ovn-sb-check ovn-sb-peer -o wide
```

Both Pods should have IP addresses. In the test Pod's resolver configuration, find the `svc.<cluster domain>` entry in the `search` line. Set `CLUSTER_DOMAIN` to the part after `svc.`.

```bash
kubectl -n "$TEST_NS" exec ovn-sb-check -- cat /etc/resolv.conf
```

Run the DNS query and cross-node ping in the same terminal. The ping target comes from the peer Pod's status.

```bash
CLUSTER_DOMAIN='<cluster domain from the search line>'
kubectl -n "$TEST_NS" exec ovn-sb-check -- nslookup "kubernetes.default.svc.$CLUSTER_DOMAIN"
PEER_POD_IP=$(kubectl -n "$TEST_NS" get pod ovn-sb-peer -o jsonpath='{.status.podIP}') &&
  test -n "$PEER_POD_IP" &&
  kubectl -n "$TEST_NS" exec ovn-sb-check -- ping -c 3 "$PEER_POD_IP"
```

After DNS returns an address and all three pings succeed, remove the test Pods.

```bash
kubectl -n "$TEST_NS" delete pod ovn-sb-check ovn-sb-peer --timeout=60s
```

Restore the monitor with `MONITOR_REPLICAS` from step 2. If you opened a new management terminal, assign the recorded value to the variable first. If the monitor Deployment was absent in step 2, skip these commands.

```bash
test -n "$MONITOR_REPLICAS" &&
  kubectl -n kube-system scale deployment/kube-ovn-monitor --replicas="$MONITOR_REPLICAS" &&
  kubectl -n kube-system rollout status deployment/kube-ovn-monitor --timeout=180s &&
  kubectl -n kube-system get deployment ovn-central kube-ovn-monitor
```
