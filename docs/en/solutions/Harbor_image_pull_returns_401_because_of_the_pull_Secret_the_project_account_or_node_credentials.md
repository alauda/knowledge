---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Harbor image pull returns 401 because of the pull Secret, the project account, or node credentials

## Issue

The registry answers HTTP, but `docker login`, a push, or an image pull is rejected with `401 Unauthorized`, `403 Forbidden`, or `authorization failed: no basic auth credentials`, and the problem is the credential itself: the workload's pull Secret, the project account in it, or what is stored on the node.

| Signature | Cause |
| --- | --- |
| `authorization failed: no basic auth credentials` | Cause 1 |
| `FailedToRetrieveImagePullSecret` or `Unable to retrieve some image pull secrets (global-registry-auth)` | Cause 2 |
| Private Harbor project: the credential of an authorized (project-scoped) account fails; admin or a public project succeeds | Cause 3 |
| Pull from the global built-in registry as `<registry-domain>:11443/<repo>/...` fails; the same image without `:11443` pulls | Cause 4 |
| The ServiceAccount lists `imagePullSecrets`, the running Pod spec has none, and the pull fails | Cause 5 |
| After a node or host reboot, platform components on that node cannot pull, while a manual `crictl pull` on the node works | Cause 6 |

An anonymous `GET /v2/` that returns 401 only proves the port is open; do not rotate a password because of it. A successful login does not grant push or pull on every Harbor project. A Secret of type `kubernetes.io/dockerconfigjson` is namespace-scoped, and the kubelet matches its `auths` key to the registry host string in the image reference, including the port.

A 401 that also hits a public project, follows a clock fault, is limited to one node, comes with a Harbor web UI `internal server error`, or comes from a pipeline or UI upload through a toolchain integration is covered in [Harbor returns 401 because of time skew, the node auth container, Harbor Core, or a shared integration credential](Harbor_returns_401_because_of_time_skew_the_node_auth_container_Harbor_Core_or_a_shared_integration_credential.md).

## Root Cause

### Cause 1: no credential matches the registry host

The kubelet or CRI presents no Authorization header that matches this registry host. Usually the workload was never bound to a Harbor image credential. The same error appears when a Secret exists but its `auths` key is `192.0.2.10` while the image is `192.0.2.10:5000/team/app:1.0`: to the kubelet those are different registries.

### Cause 2: the named pull Secret does not exist in the namespace

The Pod or its ServiceAccount names a Secret that is absent from the workload namespace, or the object is not of type `kubernetes.io/dockerconfigjson`. After a platform upgrade the event can name `global-registry-auth`, the platform registry pull Secret, which is not created automatically in every new namespace.

### Cause 3: the project-scoped account lacks permission on the private project

On a private Harbor project, the image credential of a project member fails with `authentication failed`, while the same image pulls when the project is made public or when the admin credential is used. The blobs are present. The workload Secret holds the wrong user, or that user lacks pull (or push) permission on this project. Switching the workload to admin removes the permission boundary; it is a test, not the fix.

### Cause 4: the repository used through port 11443 is outside the registry auth configuration

Nodes pull from the global cluster's built-in registry with addresses like `<registry-domain>:11443/<repo>/<image>:<tag>`. These pulls worked before and now fail, while the same image pulls without the port. The business cluster's registry configuration lists only the domain, without `11443`. When the repository used through `11443` is not in the registry auth configuration and anonymous access to it is not allowed, the node has no way to authenticate.

### Cause 5: the Pod started without the ServiceAccount's imagePullSecrets

Kubernetes copies a ServiceAccount's `imagePullSecrets` into the Pod spec only when the Pod is created. A Pod created while the ServiceAccount lacked the right Secret keeps running without it, even after the ServiceAccount is corrected. The pull fails with `ErrImagePull` and `ImagePullBackOff`, and the event text can be misleading (for example `server gave HTTP response to HTTPS client`). This can happen when `katanomi-controller` rewrites the namespace's `default` ServiceAccount, changing its `imagePullSecrets` list, around the time a Pod is created; it is a known product issue.

### Cause 6: wrong registry credentials stored on the host after a reboot

After a physical machine or node went down and restarted, some platform components on it cannot download images, while `crictl pull` of the image and `nerdctl login` to the registry VIP on the same node work. The registry credentials stored on the host for the registry domain are wrong. The kubelet reads node-level Docker config files (for example `/var/lib/kubelet/config.json` and `/root/.docker/config.json`) as registry credentials, and `nerdctl login` / `nerdctl logout` write the `.docker/config.json` of the user who runs them. Logging in to the registry domain with the password recorded in `/etc/kubernetes/registry/auth.yaml` on the global cluster makes the component pulls work; after a logout and a restart of the components, the issue does not return.

## Resolution

### Cause 1

1. Create the pull Secret in the workload namespace. `--docker-server` must be the host:port written in the image reference.

   ```bash
   kubectl create secret docker-registry <pull-secret> \
     --namespace=<namespace> \
     --docker-server=<harbor-host>:<port> \
     --docker-username=<username> \
     --docker-password="$HARBOR_PASSWORD"
   kubectl get secret <pull-secret> -n <namespace> -o jsonpath='{.type}{"\n"}'
   ```

2. Record the current `imagePullSecrets` of the Pod template, then attach the new Secret.

   > **Warning:** The patch below changes the Pod template and rolls the Deployment. A JSON merge patch would replace the whole `imagePullSecrets` array, so include every Secret the Pod still needs. Rollback: patch the array back to the recorded list and delete the added Secret if it should not remain.

   ```bash
   kubectl get deploy/<deploy> -n <namespace> -o jsonpath='{.spec.template.spec.imagePullSecrets}{"\n"}'
   kubectl patch deploy/<deploy> -n <namespace> --type=strategic \
     -p '{"spec":{"template":{"spec":{"imagePullSecrets":[{"name":"<pull-secret>"}]}}}}'
   ```

   To combine several registries into one Secret, see [Merge Multiple Image Pull Secrets Into a Single Kubernetes Docker Config Secret](Merge_Multiple_Image_Pull_Secrets_Into_a_Single_Kubernetes_Docker_Config_Secret.md).

3. Verify with the runtime on a node, not only with Docker:

   ```bash
   crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

### Cause 2

1. Find which namespaces have the named Secret, and copy it into the workload namespace without decoding it.

   > **Warning:** Copying `global-registry-auth` lets Pods in the destination namespace pull whatever it authorizes, usually the platform registry. Precondition: that namespace is allowed to pull platform images; back up the destination object if one exists. Rollback: `kubectl delete secret global-registry-auth -n <namespace>`, or re-apply the previous object.

   ```bash
   kubectl get secret -A --field-selector metadata.name=global-registry-auth
   kubectl get secret global-registry-auth -n <source-namespace> -o json \
     | python3 -c 'import json,sys; o=json.load(sys.stdin); m=o["metadata"];
   [m.pop(k, None) for k in ("namespace","resourceVersion","uid","creationTimestamp","managedFields")];
   o.pop("status", None); json.dump(o, sys.stdout)' \
     | kubectl apply -n <namespace> -f -
   ```

2. For any other missing name, create it with the Cause 1 command instead of copying a platform Secret. Confirm the type is `kubernetes.io/dockerconfigjson` and that the Pod or its ServiceAccount lists that name.

### Cause 3

1. Test as the project member:

   ```bash
   printf '%s' "$HARBOR_PASSWORD" | docker login <harbor-host>:<port> --username <username> --password-stdin
   docker pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   If this fails, give that user or robot account pull permission on the private project (push permission for a push) in Harbor. Do not leave the project public and do not put the admin password in the workload Secret.

2. Create a docker-registry Secret from the project member's username and password in the workload namespace, and point the workload at it (Pod template patch as in Cause 1):

   ```bash
   kubectl create secret docker-registry <pull-secret> \
     --namespace=<namespace> \
     --docker-server=<harbor-host>:<port> \
     --docker-username=<project-member-username> \
     --docker-password="$HARBOR_PASSWORD"
   ```

### Cause 4

1. Confirm the split on a failing node: the TCP connection to `11443` opens, the pull with the port is refused, and the pull without the port succeeds.

   ```bash
   nc -vz -w 3 <registry-domain> 11443
   crictl pull <registry-domain>:11443/<repo>/<image>:<tag>
   crictl pull <registry-domain>/<repo>/<image>:<tag>
   ```

2. Compare the registry entries in the business cluster's registry configuration with the address the workloads use (domain only versus domain with `11443`).

3. Pulls through `11443` recover when anonymous access is enabled for that registry. This is a temporary measure. The lasting fix is to put that repository and address inside the registry auth configuration, or to point workloads at an address that is already covered; agree on it with the registry owner.

   > **Warning:** Enabling anonymous access lets any client that can reach the registry pull from it without credentials. Precondition: the split above is confirmed, the registry owner accepts unauthenticated pulls for the duration, and the images are not sensitive. Rollback: disable anonymous access again once the repository is covered by the auth configuration, then test a pull through `11443`.

### Cause 5

1. Compare the ServiceAccount with the running Pod, and see which manager last wrote the ServiceAccount:

   ```bash
   kubectl get sa <service-account> -n <namespace> -o jsonpath='{.imagePullSecrets[*].name}{"\n"}'
   kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.serviceAccountName}{" "}{.spec.imagePullSecrets}{"\n"}'
   kubectl get sa <service-account> -n <namespace> --show-managed-fields -o yaml | grep -E 'manager:|time:'
   ```

2. When the ServiceAccount now holds the correct Secret and the Pod spec lacks it, recreate the Pods so admission copies the current list.

   > **Warning:** Impact: the Pods are replaced; a single-replica workload is unavailable until the new Pod is Ready. Precondition: re-check right before that the ServiceAccount lists the correct Secret, because the controller may rewrite it. If the new Pod also lacks the Secret, the ServiceAccount changed again in between.

   ```bash
   kubectl rollout restart deploy/<deploy> -n <namespace>
   kubectl get pod -n <namespace> -l <workload-selector> -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.imagePullSecrets}{"\n"}{end}'
   ```

3. A Pod-template `imagePullSecrets` entry (Cause 1) does not depend on what the ServiceAccount holds at Pod creation, so it protects the workload from later rewrites.

### Cause 6

1. On the affected node, list which registry hosts have stored credentials, without printing the secrets:

   ```bash
   jq -r '.auths | keys[]' /var/lib/kubelet/config.json 2>/dev/null
   jq -r '.auths | keys[]' /root/.docker/config.json 2>/dev/null
   ```

2. Read the registry password from `/etc/kubernetes/registry/auth.yaml` on a control-plane node of the global cluster. On the affected node, back up the Docker config file and log in to the registry domain with it, then check the failing component Pods:

   ```bash
   cp -a /root/.docker/config.json /root/docker-config.json.bak 2>/dev/null
   printf '%s' "$REGISTRY_PASSWORD" | nerdctl login <registry-domain> --username <username> --password-stdin
   kubectl get pods -A -o wide --field-selector spec.nodeName=<node> | grep -E 'ImagePull|ErrImage'
   ```

3. Log out of the registry domain and restart the platform component Pods that had failed.

   > **Warning:** Impact: `nerdctl logout` removes the stored credential for that host from the node's Docker config file, and the restarted Pods are interrupted until they are Ready. Precondition: the login in step 2 made the component pulls succeed, and `/root/docker-config.json.bak` exists. Rollback: copy the backup file back to `/root/.docker/config.json`.

   ```bash
   nerdctl logout <registry-domain>
   kubectl delete pod -n <namespace> <failing-component-pod>
   kubectl get pods -A -o wide --field-selector spec.nodeName=<node> | grep -E 'ImagePull|ErrImage'
   ```

   The recreated Pods pull their images and stay `Running`.

## Diagnostic Steps

1. Save the first event, not the final `ImagePullBackOff` line, and compare the Pod's image and Secrets with its ServiceAccount:

   ```bash
   kubectl describe pod <pod-name> -n <namespace>
   kubectl get pod <pod-name> -n <namespace> -o jsonpath='{.spec.containers[*].image}{"\n"}{.spec.imagePullSecrets[*].name}{"\n"}'
   kubectl get sa <service-account> -n <namespace> -o jsonpath='{.imagePullSecrets[*].name}{"\n"}'
   ```

   `FailedToRetrieveImagePullSecret` selects Cause 2. `no basic auth credentials` selects Cause 1: compare the image host:port with the Secret's registry key. A ServiceAccount that lists Secrets while the Pod spec has none selects Cause 5, whatever the pull error says.

2. From the failing node, separate reachability from authentication:

   ```bash
   curl -sS -o /dev/null -D - --connect-timeout 10 https://<harbor-host>:<port>/v2/
   printf '%s' "$HARBOR_PASSWORD" | docker login <harbor-host>:<port> --username <username> --password-stdin
   crictl pull <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

   A TLS error or `server gave HTTP response to HTTPS client` happens before authentication; see [Harbor push or pull fails because the client uses the wrong scheme: HTTP response to HTTPS client, or port 443 refused](Harbor_push_or_pull_fails_because_the_client_uses_the_wrong_scheme_HTTP_response_to_HTTPS_client_or_port_443_refused.md) or [Harbor or registry image pull fails with x509 certificate signed by unknown authority or certificate has expired](Harbor_or_registry_image_pull_fails_with_x509_certificate_signed_by_unknown_authority_or_certificate_has_expired.md).

3. On a private project, if the member's credential fails and admin or a public project works, select Cause 3. If a pull from a public project also returns 401, check clocks first (see the related article under Issue).

4. If the same image pulls without `:11443` and fails with it, select Cause 4.

5. If only platform components on a node that was just rebooted fail, and `crictl pull` on that node succeeds, select Cause 6.
