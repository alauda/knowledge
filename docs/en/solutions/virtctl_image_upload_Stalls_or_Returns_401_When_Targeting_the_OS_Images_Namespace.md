---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Uploading a disk image to the namespace that hosts the platform-supplied VM base images fails or stalls shortly after the transfer starts. `virtctl image-upload` reports one of:

```text
error uploading image after 5 retries: unexpected return value 401
```

or simply hangs, with the client-side send queue filling up while no progress is made. A `netstat` snapshot on the client shows a very large `Send-Q` and a TCP window stuck full against the upload-proxy endpoint:

```text
# netstat -tnp | grep virtctl
Proto Recv-Q Send-Q Local Address        Foreign Address      State        PID/Program name
tcp   0      1165848 192.168.2.103:34704 192.168.3.53:443     ESTABLISHED  31637/virtctl
```

At the same time, the CDI upload-proxy pod in the virtualization namespace logs reverse-proxy timeouts reaching the in-namespace upload Service or upload pod:

```text
Error in reverse proxy: http: proxy error: dial tcp <upload-svc-ip>:443: connect: connection timed out
```

Uploads to any *other* namespace behave normally. Only the namespace that stores the platform's VM golden images is affected.

## Root Cause

The namespace that stores the platform-shipped VM images is created with a hardened default-deny NetworkPolicy posture so that tenant workloads cannot freely talk to the golden-image PVCs. A regression in the upstream KubeVirt CDI (Containerized Data Importer) controller causes the matching `allow from cdi-uploadproxy` NetworkPolicy to be *missing* inside that hardened namespace when the upload pod is scheduled. Without that allow rule, the upload-proxy pod in the virtualization control-plane namespace cannot reach the ephemeral `cdi-upload-<name>` Service or the `cdi-upload-server` pod that virtctl's request is being reverse-proxied to.

On the wire the symptom sequence is:

1. `virtctl image-upload` POSTs to the CDI upload-proxy route/Service. The proxy accepts the TLS session — so the client sees the connection as ESTABLISHED — then opens a second connection *from the proxy pod* to the short-lived `cdi-upload-server` pod inside the OS-images namespace.
2. The second connection is dropped by the hardened namespace's default-deny because no NetworkPolicy selects the upload-proxy as an allowed source.
3. From the client's perspective the upload either times out (stalls with TCP window full) or returns HTTP 401 once the proxy decides the upstream is unreachable.

The fix is to publish the missing allow policy at VM-image-namespace creation time. A downstream patch ships the corrected CDI controller in a point release of the virtualization operator.

## Resolution

### Preferred: upgrade the virtualization operator

Update the platform's virtualization operator to a release that ships the fix for this CDI regression. The operator reconciles the missing NetworkPolicy into the OS-images namespace at startup; after the upgrade, uploads to that namespace succeed without any manual YAML. The platform's virtualization change log lists the fixed build under the CDI / upload-proxy area.

### Workaround: publish the NetworkPolicy manually

If the upgrade cannot be scheduled immediately, author the allow rule directly in the OS-images namespace. The rule lets the upload-proxy pod (by label) reach the upload-server pods (by label) regardless of source namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-ingress-from-cdi-upload-proxy-to-cdi-upload-server
  namespace: <vm-os-images-namespace>
spec:
  podSelector:
    matchLabels:
      cdi.kubevirt.io: cdi-upload-server
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector: {}
          podSelector:
            matchLabels:
              cdi.kubevirt.io: cdi-uploadproxy
```

Apply it before retrying the upload:

```bash
kubectl -n <vm-os-images-namespace> apply -f allow-uploadproxy.yaml
```

The policy matches the ephemeral `cdi-upload-server` pod that CDI creates per upload, so no further edits are required per image. After the operator upgrade lands, the manually-authored policy can be deleted; the reconciled copy will replace it.

### Alternative: upload to a different namespace

If neither the operator upgrade nor the manual NetworkPolicy is acceptable (for example, because the namespace is centrally governed), target any other namespace for the upload and move the resulting PVC afterwards. The regression is scoped to the hardened OS-images namespace — uploads to a tenant namespace succeed without modification.

## Diagnostic Steps

Reproduce the wedge in one shell, then confirm the proxy cannot reach the upload-server endpoints from a second shell.

1. Start an upload in one terminal:

   ```bash
   virtctl image-upload pvc -n <vm-os-images-namespace> test-image \
     --access-mode ReadWriteOnce --volume-mode filesystem \
     --storage-class <sc-name> --size 20Gi \
     --force-bind --insecure --image-path=./test.qcow2
   ```

2. In a second terminal, find the Service and upload-pod IP the CDI controller created for that upload:

   ```bash
   kubectl -n <vm-os-images-namespace> get svc,pod,endpointslice -o wide
   ```

   Note the `cdi-upload-<name>` ClusterIP and the `cdi-upload-<name>` pod IP.

3. Exec into the CDI upload-proxy pod in the virtualization namespace and probe both addresses:

   ```bash
   kubectl -n <virtualization-ns> get pods -l cdi.kubevirt.io=cdi-uploadproxy
   kubectl -n <virtualization-ns> exec -it <upload-proxy-pod> -- sh
   # inside the pod
   curl -k https://<upload-pod-ip>:8443
   curl -k https://<upload-svc-ip>:443
   ```

   Both curls hanging — with no TCP reset, no TLS error, just a timeout — confirms the default-deny is dropping the second leg of the reverse proxy.

4. List the NetworkPolicies actually present in the OS-images namespace:

   ```bash
   kubectl -n <vm-os-images-namespace> get networkpolicy
   kubectl -n <vm-os-images-namespace> describe networkpolicy
   ```

   If no policy selects pods labelled `cdi.kubevirt.io=cdi-upload-server` with an allow from the `cdi-uploadproxy` source, that is the missing rule.

5. As a control, repeat step 1 against a namespace that does not have the hardened default-deny. The upload succeeds — confirming the CDI control-plane itself is healthy and the issue is scoped to NetworkPolicy coverage in the OS-images namespace.
