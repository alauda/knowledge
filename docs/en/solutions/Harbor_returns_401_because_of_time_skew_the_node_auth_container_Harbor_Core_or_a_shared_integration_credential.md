---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Harbor returns 401 because of time skew, the node auth container, Harbor Core, or a shared integration credential

## Issue

Pulls or pushes that worked before now fail with `401 Unauthorized` or `unauthorized`, and the workload's credentials did not change. Common forms: the rejection also hits a public project such as `library`, only one node is affected, the Harbor web UI shows `internal server error`, only the pipeline fails, or an image upload from the platform UI through a toolchain integration fails with:

```text
upload file error: writing blob: initiating layer upload to /v2/<project>/<repository>/blobs/uploads/ in <registry-host>:<port>: unauthorized: unauthorized to access repository: <project>/<repository>, action: push
```

while the same account pushes from the command line.

| Signature | Cause |
| --- | --- |
| `401 Unauthorized` on pull and push, including a pull from a public project, and node clocks differ; or a push that recovers after time is synchronized | Cause 1 |
| Pipeline log says image registry credentials were not found, and the imageRepository integration is abnormal | Cause 2 |
| UI image upload through a toolchain integration returns `500` with `unauthorized to access repository: ..., action: push`, and the integration's credential is also used by another integration | Cause 3 |
| `401` on one node only; other nodes pull the same reference | Cause 4 |
| Harbor web UI keeps showing `internal server error`, and pulls that worked before (even from public `library`) now say unauthorized | Cause 5 |

A public Harbor project such as `library` lets anyone pull, but a push to it still needs an account with push permission. A refused push to `library` is not, on its own, a sign of clock skew or of a Harbor Core problem; only a refused pull from it is.

For a missing or wrong pull Secret, a project-scoped account, port `11443`, or credentials stored on the node, see [Harbor image pull returns 401 because of the pull Secret, the project account, or node credentials](Harbor_image_pull_returns_401_because_of_the_pull_Secret_the_project_account_or_node_credentials.md).

## Root Cause

### Cause 1: control-plane clocks are skewed

Kubernetes tokens carried by the DevOps operator fall outside their validity window because the control-plane clock is wrong. Pulls and pushes fail with `401 Unauthorized`, or the pipeline keeps asking for credentials, even against a public project. etcd on ACP runs as the static Pod `etcd-<node>` in `kube-system` (label `component=etcd`); its log shows `rafthttp: the clock difference against peer ... is too high` when members disagree by more than one second. Restarting Jenkins or the operator before the clock is corrected does not produce a usable token. The same clock fault can stop image pushes without any `401` message; synchronizing time restores them.

A Docker message `Stored credentials invalid or expired` is the local credential store rejecting a saved entry; it is not proof that the registry certificate expired.

### Cause 2: the global and workload clusters share one Harbor integration credential

The pipeline `image-build` stage returns `unauthorized`, reports that image registry credentials were not found, and the imageRepository integration status is abnormal. Assigning the project again makes pulls work once, then the next run fails. When the global cluster and a workload cluster share one Harbor integration credential, the two conflict, and `katanomi` on the global cluster cannot hand the pipeline a usable registry credential. Sharing one credential between integrations is not supported.

### Cause 3: one credential is shared by several toolchain integrations

The UI upload goes to the image registry of a toolchain integration (request path `/files/v1alpha1/integrations/<integration-name>/namespaces/<namespace>/projects/<project>/upload`). The response is `StatusCode: 500` with `reason: InternalError` and the `action: push` message; the `via: alb` and `x-alb-err-reason: BackendError : read <n> byte data from backend` headers only show the ALB passing on the backend's `500`.

A toolchain integration card does not support sharing a single credential. When one credential is shared across integrations, and the registry address in its data is not the address of the integration that uploads, the upload fails with the permission error above, although the account itself can push from the command line and `harbor-core` logs no rejection of that account.

### Cause 4: the node-local auth container on one node

Platform components return `401` only on one node. The image is absent on that node, the containerd configuration matches a healthy node, and a manual pull succeeds after the node-local registry `auth` container is restarted. Other nodes are unaffected, so this is not a Harbor project permission and not a cluster-wide Secret.

### Cause 5: Harbor Core is unstable

The Harbor web page frequently shows `internal server error`, and pipelines that used to build fail at the image pull with `unauthorized`, even for an image in the public `library` project. Credentials and project permissions did not change. Restarting Harbor Core brings back both the web page and the pulls. The reason Core became unstable has not been identified.

## Resolution

### Cause 1

1. On each control-plane node, check time synchronization, and read the etcd clock warning:

   ```bash
   timedatectl status
   chronyc tracking
   chronyc sources
   kubectl get pods -n kube-system -l component=etcd -o wide
   kubectl -n kube-system logs -c etcd etcd-<node> --tail=80 | grep -F "clock difference against peer"
   ```

2. Correct the clock.

   > **Warning:** `chronyc makestep` jumps the clock. On a control-plane node that can stall etcd and invalidate in-flight tokens. Precondition: a maintenance window, and `chronyc sources` shows a reachable NTP server. Step one control-plane node at a time, and confirm `etcd-<node>` is `Running` and the clock-difference warning has stopped before the next node. The clock cannot be rolled back to the wrong time; if the new source is wrong, restore the previous NTP server in the chrony configuration.

   ```bash
   chronyc makestep
   ```

3. After time is correct, restart the DevOps tools operator so it requests a new token. The Deployment name varies; select it from the list.

   > **Warning:** Only after the clocks agree. Impact: DevOps tool reconciliation pauses until the new Pod is Ready. The Deployment recreates the Pod; nothing needs to be rolled back.

   ```bash
   kubectl get deploy -A | grep -Ei 'devops.*tool|tools-operator'
   kubectl rollout restart deploy/<devops-tools-operator> -n <namespace>
   kubectl rollout status deploy/<devops-tools-operator> -n <namespace>
   ```

4. Retry the pipeline pull and push. A pull from a public project must succeed without a new password. If Docker still says `Stored credentials invalid or expired`, clear only that host and log in again:

   ```bash
   docker logout <harbor-host>:<port>
   printf '%s' "$HARBOR_PASSWORD" | docker login <harbor-host>:<port> --username <username> --password-stdin
   ```

### Cause 2

1. Find the global `katanomi` Deployment and record its replica count:

   ```bash
   kubectl get deploy -A | grep -i katanomi
   kubectl get deploy -n <namespace> <katanomi-deploy> -o jsonpath='{.spec.replicas}{"\n"}'
   ```

2. Scale it to zero while the credentials are split.

   > **Warning:** Scaling the global `katanomi` to 0 stops integration and pipeline reconciliation on the global cluster until replicas return. Precondition: a maintenance window and the recorded replica count. Rollback: `kubectl scale deploy/<katanomi-deploy> -n <namespace> --replicas=<recorded>`.

   ```bash
   kubectl scale deploy/<katanomi-deploy> -n <namespace> --replicas=0
   ```

3. Create a distinct Harbor integration credential for the global cluster and another for the workload cluster, then scale `katanomi` back to the recorded replica count. Re-run the pipeline stage. Reassigning the project without splitting the credential only clears the symptom until the next run.

### Cause 3

1. Confirm the account is not the fault: log in and push to the `<registry-host>:<port>` named in the error with the account the credential is supposed to hold.

   ```bash
   printf '%s' "$HARBOR_PASSWORD" | docker login <registry-host>:<port> --username <username> --password-stdin
   docker push <registry-host>:<port>/<project>/<repository>:<tag>
   ```

   If this push is refused too, the account lacks push permission on the project; see [Registry push fails with insufficient_scope or authentication required on ACP](Registry_push_fails_with_insufficient_scope_or_authentication_required_on_ACP.md).

2. If it succeeds, open the integration on the toolchain integration page, note the credential bound to it, and check whether another integration card uses the same credential. Read the registry addresses in that credential without printing the password (for a `kubernetes.io/dockerconfigjson` credential):

   ```bash
   kubectl get secret -A | grep <credential-name>
   kubectl get secret -n <credential-namespace> <credential-name> -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq -r '.auths | keys[]'
   ```

   The cause is confirmed when the credential is shared and a registry address in it differs from the integration's access address and from `<registry-host>:<port>` in the error.

3. Create a separate credential for this integration with the integration's registry address and an account that can push to the project, and bind it to this integration card. Do not change the address of the shared credential in place: the other integrations still use it.

   > **Warning:** Impact: from that moment, everything that goes through this integration (UI uploads, pipelines, and projects that use it) uses the new credential. Precondition: the command-line push in step 1 succeeded with the account in the new credential, and the name of the currently bound credential is recorded. Rollback: bind the recorded credential to the integration again.

4. Retry the UI upload. It completes with no `500` and no `action: push` message.

### Cause 4

On the failing node, restart the registry `auth` container. The kubelet recreates a container that belongs to a Pod.

> **Warning:** Only when the failure is limited to this node and the container is the registry auth helper, not an unrelated workload. Impact: image pulls that depend on it on this node are interrupted until the kubelet recreates the container. If it does not come back, delete the owning Pod so its controller recreates it. Do not `crictl rm` the container; that is hard to reverse if no controller owns it.

```bash
crictl ps --name auth
crictl stop <container-id>
crictl ps --name auth
crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
```

### Cause 5

1. Check Harbor Core for restarts and errors at the time the UI shows `internal server error`:

   ```bash
   kubectl get pods -A | grep -i harbor
   kubectl -n <harbor-namespace> logs <harbor-core-pod> --tail=200
   ```

2. Restart Harbor Core.

   > **Warning:** Only when the Harbor UI itself returns `internal server error` and unauthorized pulls affect projects whose permissions did not change (including public `library`). Impact: the Harbor UI and API, and registry logins and pulls that go through Core, are interrupted until the new Pod is Ready. The Deployment recreates the Pod; nothing needs to be rolled back. If the errors return, collect the Core log instead of restarting repeatedly.

   ```bash
   kubectl -n <harbor-namespace> get deploy | grep -i core
   kubectl -n <harbor-namespace> rollout restart deploy/<harbor-core-deployment>
   kubectl -n <harbor-namespace> rollout status deploy/<harbor-core-deployment>
   ```

3. Reload the Harbor UI and rerun the failed pull.

## Diagnostic Steps

1. Test the same pull with a known-good account and check the workload's pull Secret first (see the pull Secret article linked under Issue). A missing Secret, a wrong account, or a Pod without `imagePullSecrets` is that article.

2. If a pull from a public project also returns 401, check clocks before rotating passwords (Cause 1, step 1). Expected for Cause 1: a large `chronyc tracking` offset and the etcd `clock difference against peer` warning. If clocks agree and the Harbor web UI itself shows `internal server error`, select Cause 5.

3. For a pipeline-only failure, read the `image-build` log. `credentials were not found` together with an abnormal imageRepository integration selects Cause 2.

4. For a UI upload that returns `500` with `action: push`, push from the command line with the same account to the host:port in the error. If that works, compare the host:port in the error with the integration's address and check whether the credential is shared; that selects Cause 3. Credentials are matched by host and port, so an account checked on a different port of the same host proves nothing about the port in the error.

5. A 401 on one node while a neighboring node pulls the same reference selects Cause 4.
