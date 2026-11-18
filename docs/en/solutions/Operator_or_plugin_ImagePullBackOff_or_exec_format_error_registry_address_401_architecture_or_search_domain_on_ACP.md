---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
---

# Operator or plugin ImagePullBackOff or exec format error: registry address, 401, architecture, or search domain on ACP

## Issue

- An operator deployed from OperatorHub (for example `knative-operator` on `global`, installed for all namespaces) stays in Deploying (`部署中`), and its Pod events say the image cannot be pulled.
- The Knative Operator from the marketplace cannot be installed into a namespace because its image cannot be downloaded. Editing the image on the Deployment works for a while and is then changed back.
- Installing the ClickHouse plugin on `global` times out and the console shows the installation as failed; `cpaas-elasticsearch-0` is in `ImagePullBackOff`.
- Cluster functional components stay in upgrading, and the `connectors-operator` Pod on an ARM business cluster crashes with `exec /manager: exec format error`.
- After the global cluster recovers from a failure, platform component Pods in a workload cluster stay in `ImagePullBackOff`; a manual pull from the platform registry fails with `received unexpected HTTP status: 500 Internal Server Error`.

A plugin that waits for a Pod that is Pending or failing on its node for reasons other than the image is covered in "Cluster plugin stuck at wait resources ready: Pod Pending, /cpaas I/O error, or missing log secret on ACP".

## Root Cause

### Cause 1: the registry address was changed and the running Pod still pulls from the old address

The Pod event is `BackOff: Back-off pulling image "<old-registry>/<repository>:<tag>"`, repeated a very large number of times, and the registry in the event is not the one the platform is configured with now. After the image registry address of the platform is changed, an operator Pod that was created before the change (for example `knative-operator` in namespace `operators`) still references the old address, so every pull fails and the operator stays in Deploying. Recreating the Pod makes it pull from the current address.

### Cause 2: the image points to a registry domain the cluster cannot reach, and Deployment edits are reverted

The events of the operator Pods (for example `knative-operator-<hash>` and `operator-webhook-<hash>`) show:

```text
Failed to pull image "<build-registry-domain>/<repository>:<tag>": rpc error: code = DeadlineExceeded desc = failed to pull and unpack image ... failed to resolve reference ... dial tcp ...:443: i/o timeout
```

followed by `Back-off pulling image` and `Error: ImagePullBackOff`.

The operator's image references use a registry domain that the cluster cannot resolve or reach. Normally Metis, the platform webhook controller that passes values from upper-level resources down to workloads, replaces such image addresses with the platform registry address; when it does not, the Pods keep the unreachable domain. The same repository and tag pull fine from the platform registry address of the cluster (Clusters → `<cluster>` → Overview → Basic Info → Image Repository Address, for example an `IP:11443` address). Editing the image on the Deployment does not last, because the operator Deployment is owned by its ClusterServiceVersion (CSV) and OLM writes the CSV's spec back. Changing the image address in the CSV propagates to the Deployments, and the operator starts.

For Knative, the components from the platform marketplace are supported; open-source Knative Operators that are not from the product are not.

### Cause 3: 401 Unauthorized from the registry token service, a platform image cannot be pulled

A platform Pod (for example `cpaas-elasticsearch-0` in `cpaas-system`, image `ait/elasticsearch-basic-http:<tag>`) cannot pull its image:

```text
failed to authorize: failed to fetch oauth token: unexpected status from GET request to https://<registry>/auth/token?scope=repository%3Aait%2Felasticsearch-basic-http%3Apull&service=token-service: 401 Unauthorized
```

then `ErrImagePull`, `ImagePullBackOff`, and `Back-off pulling image`; a plugin install that needs the Pod times out. The registry token service refused the pull with `401`. Pulling the image manually on the node and then recreating the Pod recovers it.

### Cause 4: exec format error, the operator package that was pushed has no image for the cluster's architecture

`kubectl logs` of the operator Pod returns `exec /manager: exec format error`. The image itself was pulled successfully, the `manager` container restarts, and the event is `Back-off restarting failed container manager`. The cluster runs on another architecture than the image (for example `global` is x86 and the business cluster is ARM).

The operator package that was pushed contained only the x86 image, so the ARM nodes run an x86 binary. Pushing the multi-architecture (hybrid) package of the same operator version with `violet push --force` overwrites the package, the business cluster pulls the ARM image, and the Pod reaches `Running`. Triggering the upgrade of the stuck components from OperatorHub then clears the upgrading state.

### Cause 5: pulls return 500 because a node search domain makes registry name lookups time out

Platform component Pods on a workload cluster stay in `ImagePullBackOff`. A manual pull on a node fails with:

```text
Error response from daemon: received unexpected HTTP status: 500 Internal Server Error
```

and `curl -kv` against the platform registry, and against its backend address, also returns `500`.

The node `/etc/resolv.conf` (written by NetworkManager) carries an extra search domain such as `linklocal`. Pods with `dnsPolicy: ClusterFirst` inherit the node search domains after the cluster suffixes, with `options ndots:5`; the `alb2` container of the global ALB, for example, shows `search cpaas-system.svc.cluster.local svc.cluster.local cluster.local linklocal`. Every lookup of the registry domain and of in-cluster Service names is then also tried with `.linklocal` appended, CoreDNS forwards those names upstream, and the lookups time out. The CoreDNS log shows:

```text
[ERROR] plugin/errors: 2 <name>.linklocal. A: read udp <coredns-pod-ip>:<port>-><upstream>:53: i/o timeout
```

for names such as the platform registry domain, `registry.kube-system.svc.cluster.local.linklocal.`, and `erebus.cpaas-system.svc.cluster.local.linklocal.`. The component that serves the registry cannot resolve what it needs in time and answers `500`. Removing the search domain from the node `/etc/resolv.conf` and recreating the ALB and CoreDNS Pods restores the pulls.

## Resolution

### Cause 1: the registry address was changed and the running Pod still pulls from the old address

1. Compare the registry in the event with the current Image Repository Address of the cluster:

   ```bash
   kubectl get pods -A | grep -i <operator-name>
   kubectl -n <namespace> describe pod <operator-pod> | grep -E 'Image:|Back-off pulling'
   ```

2. Recreate the Pod.

   > **Warning:** Deleting the operator Pod restarts the operator; its reconciliation pauses until the new Pod is Running. Precondition: only when the registry address was changed and the Pod event still pulls from the old address. Rollback: none needed; the Deployment recreates the Pod.

   ```bash
   kubectl -n <namespace> delete pod <operator-pod>
   kubectl -n <namespace> get pod -w | grep <operator-name>
   ```

3. If the new Pod still names the old registry, the address is stored in the workload spec; continue with Cause 2.

### Cause 2: the image points to a registry domain the cluster cannot reach, and Deployment edits are reverted

1. Read the image of the Deployment and find the CSV:

   ```bash
   kubectl get po -A | grep <operator-name>
   kubectl -n <namespace> get deploy <operator-deployment> -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
   kubectl get csv -A | grep <operator-name>
   kubectl get po -A | grep metis
   ```

2. On a node, test both addresses. The domain failing and the platform registry address working is this cause:

   ```bash
   crictl pull <build-registry-domain>/<repository>:<tag>
   crictl pull <platform-registry-address>/<repository>:<tag>
   ```

3. Save the CSV:

   ```bash
   kubectl -n <operator-namespace> get csv <csv-name> -o yaml > "$HOME/<csv-name>.before.yaml"
   ```

4. Change the image in the CSV, not on the Deployment.

   > **Warning:** Saving the CSV makes OLM roll the operator Deployments with the new image; the operator restarts. Precondition: only when the Pods are in `ImagePullBackOff` for an image whose registry domain the cluster cannot reach, and the same repository and tag pull from the platform registry address. Rollback: `kubectl apply -f "$HOME/<csv-name>.before.yaml"`.

   ```bash
   kubectl -n <operator-namespace> edit csv <csv-name>
   ```

   Replace `<build-registry-domain>` with the platform registry address in every image under `.spec.install.spec.deployments[].spec.template.spec.containers[].image` (and `relatedImages` if present), and save.

5. Check the Pods:

   ```bash
   kubectl get po -A | grep <operator-name>
   ```

If other operators from the marketplace show the same unreplaced domain, collect the Metis Pod log (`kubectl -n <metis-namespace> logs <metis-pod> --tail=300`) for Alauda technical support before editing more CSVs.

### Cause 3: 401 Unauthorized from the registry token service, a platform image cannot be pulled

1. On the node that runs the Pod, pull the image the event names:

   ```bash
   kubectl -n cpaas-system get pod cpaas-elasticsearch-0 -o wide
   kubectl -n cpaas-system describe pod cpaas-elasticsearch-0 | grep -E 'Image:|Failed'
   crictl pull <registry>/ait/elasticsearch-basic-http:<tag>
   ```

   If the plain pull also returns `401`, pull with the platform registry credentials:

   ```bash
   crictl pull --creds '<registry-user>:<registry-password>' <registry>/ait/elasticsearch-basic-http:<tag>
   ```

2. Recreate the Pod.

   > **Warning:** Deleting the Pod restarts that Elasticsearch replica; it rejoins after it starts. Precondition: only after the image is present on that node (`crictl images | grep elasticsearch-basic-http`) and the Pod is in `ImagePullBackOff` with the `401 Unauthorized` token error. Rollback: none needed; the StatefulSet recreates the Pod.

   ```bash
   kubectl -n cpaas-system delete pod cpaas-elasticsearch-0
   kubectl -n cpaas-system get pod cpaas-elasticsearch-0 -w
   ```

3. Retry the plugin install.

### Cause 4: exec format error, the operator package that was pushed has no image for the cluster's architecture

1. Compare the node architecture with the crash:

   ```bash
   kubectl get nodes -o custom-columns=NAME:.metadata.name,ARCH:.status.nodeInfo.architecture
   kubectl -n <operator-namespace> get pods
   kubectl -n <operator-namespace> logs <operator-pod> --previous --tail=20
   ```

2. Push the multi-architecture package of the same version.

   > **Warning:** `--force` overwrites the package, Artifact, and ArtifactVersion already on the platform for this operator version. Precondition: only when the operator Pod logs `exec format error` on nodes of one architecture and the package you push is the multi-architecture (hybrid) build of the same version. Rollback: none for the overwritten content; push the previous file again with `--force` if needed.

   ```bash
   violet push <operator-hybrid-package>.tgz --platform-address <platform-access-address> --platform-username <platform-admin-name> --platform-password '<platform-admin-password>' --clusters <arm-cluster-name> --force
   ```

3. Trigger the upgrade of the stuck components from OperatorHub on that cluster, and check that the Pod pulls the ARM image and runs:

   ```bash
   kubectl -n <operator-namespace> get pods -w
   ```

### Cause 5: pulls return 500 because a node search domain makes registry name lookups time out

1. Confirm the search domain in a platform Pod and the timeouts in CoreDNS (on the global cluster for the global ALB):

   ```bash
   kubectl -n cpaas-system get pods | grep alb
   kubectl -n cpaas-system exec <global-alb2-pod> -c alb2 -- cat /etc/resolv.conf
   kubectl -n kube-system logs -l k8s-app=kube-dns --tail=200 | grep -i 'i/o timeout'
   ```

2. On each node whose `/etc/resolv.conf` carries the extra search domain, back the file up and comment out the `search` entry.

   > **Warning:** Removing the node search domain changes how host processes resolve short names; anything on the host that relied on that suffix must use full names afterwards. Precondition: only when Pod `resolv.conf` files carry the site suffix and CoreDNS logs `i/o timeout` for names with that suffix appended. Rollback: restore the backup file and recreate the Pods again.

   ```bash
   cp -a /etc/resolv.conf /root/resolv.conf.before
   grep -nE '^(search|domain)' /etc/resolv.conf
   sed -i -E 's/^(search|domain)([[:space:]])/# \1\2/' /etc/resolv.conf
   cat /etc/resolv.conf
   ```

   When NetworkManager writes the file, also remove the search domain from the NetworkManager connection, or the next NetworkManager restart puts it back.

3. Recreate the ALB and CoreDNS Pods so that their `/etc/resolv.conf` is written again.

   > **Warning:** Restarting the ALB interrupts the traffic it carries, including console access, until the new Pods are Ready, and a CoreDNS restart briefly delays lookups. Precondition: the node files are fixed first. Rollback: none needed; the controllers recreate the Pods.

   ```bash
   kubectl -n cpaas-system delete pod <global-alb2-pod>
   kubectl -n kube-system rollout restart deploy/coredns
   ```

4. Pull the image again on a workload cluster node and watch the Pods leave `ImagePullBackOff`.

For the same search-domain mechanism behind console and DevOps timeouts, see "Platform UI stuck loading or DevOps errors from Service name timeouts caused by node search domains on ACP".

## Diagnostic Steps

```bash
kubectl get pods -A | grep -E 'ImagePullBackOff|ErrImagePull|CrashLoopBackOff'
kubectl -n <namespace> describe pod <pod> | grep -E 'Image:|Failed|Back-off'
kubectl -n <namespace> logs <pod> --previous --tail=20
```

- A back-off on an image from a registry address that was changed: Cause 1.
- `i/o timeout` or a resolution failure for a build registry domain, with Deployment edits reverted: Cause 2.
- `failed to fetch oauth token ... 401 Unauthorized`: Cause 3.
- A successful pull followed by `exec format error` on nodes of one architecture: Cause 4.
- `received unexpected HTTP status: 500` from the platform registry, and CoreDNS `i/o timeout` errors for names ending in an extra suffix such as `.linklocal.`: Cause 5.
