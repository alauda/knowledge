---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor image scan fails because Trivy cannot reach mirror.gcr.io

## Issue

A Harbor vulnerability scan fails and the UI shows no scan result, while push and pull of the same tag succeed. The Trivy Pod log shows that it cannot update the vulnerability database from `mirror.gcr.io` (a timeout, a connection reset or refusal, or a TLS error naming that host). The cluster is typically in an intranet that blocks outbound access.

## Root Cause

### Cause 1: Trivy cannot download its vulnerability database from mirror.gcr.io

Harbor 2.14 (for example `v2.14.1`) uses the online Trivy vulnerability database by default; the scanner image does not carry a current database. On each update Trivy connects to `mirror.gcr.io` on port 80 or 443. If that connection times out or is reset, the database refresh fails and the scan returns an error. The image layers in the registry are fine, and opening the Harbor UI or restarting Harbor Core does not fetch the database.

An intranet cluster that blocks those ports cannot scan until egress to `mirror.gcr.io` is allowed or an offline database is loaded.

## Resolution

### Cause 1

Choose one of the two repairs. Prefer egress when the security policy allows it; use the offline database when the cluster must stay without that path.

**Option A: allow egress to mirror.gcr.io**

1. Confirm the block from the Trivy Pod:

   ```bash
   kubectl get pods -A | grep -i trivy
   kubectl exec -n <harbor-namespace> <trivy-pod> -- wget -S -O /dev/null --timeout=10 https://mirror.gcr.io/ 2>&1 | head -n 20
   ```

   If `wget` is not in the image, run the same request with `curl` from a debug Pod on the same network. A timeout confirms the block.

2. Allow `mirror.gcr.io` on ports 80 and 443 from the Trivy Pod in the firewall or proxy.

3. Restart the Trivy Pod so it retries the download.

   > **Warning:** Only after egress is in place, otherwise the new Pod fails the same way. Impact: scans in progress are aborted; no images are deleted. The controller recreates the Pod; to undo the firewall change, restore the previous egress rule.

   ```bash
   kubectl delete pod -n <harbor-namespace> <trivy-pod>
   ```

4. Trigger the scan again in Harbor. A completed scan with a vulnerability report means the database downloaded.

**Option B: use an offline vulnerability database**

Follow "Update the Trivy Vulnerability Database in Offline Environments" in the Alauda Build of Harbor documentation for the installed Harbor version. In outline: download the Trivy database on a machine that can reach `mirror.gcr.io`, place it in the volume the Trivy Pod mounts, and turn off online database updates through the `Harbor` resource so the scanner does not try `mirror.gcr.io` again.

1. Save the Harbor resource and find the volume the Trivy Pod mounts:

   ```bash
   kubectl get harbor -n <harbor-namespace> <harbor-name> -o yaml > /tmp/harbor-before.yaml
   kubectl get harbor -n <harbor-namespace> <harbor-name> -o jsonpath='{.spec.helmValues.trivy}{"\n"}'
   kubectl get pod -n <harbor-namespace> <trivy-pod> -o jsonpath='{range .spec.volumes[*]}{.name}{" "}{.persistentVolumeClaim.claimName}{"\n"}{end}'
   ```

2. Change the Trivy update settings on the `Harbor` resource as the documentation describes. Do not edit the generated Trivy Deployment: the operator reverts it on the next reconcile.

   > **Warning:** Impact: editing the Harbor resource rolls Harbor components, which interrupts login and pushes until they are Ready. Copying a database file into the volume overwrites the previous one. Precondition: a maintenance window, `/tmp/harbor-before.yaml` saved, and a copy of the old database file if you may need it. Rollback: apply the saved file and restore the old database file.

   ```bash
   kubectl edit harbor -n <harbor-namespace> <harbor-name>
   ```

3. After the database is on the volume and online updates are off, restart the Trivy Pod and run a scan. If the log still dials `mirror.gcr.io`, the update setting did not reach the running scanner.

## Diagnostic Steps

1. Separate a scan failure from a pull failure. If `crictl pull` of the same tag works, credentials and the manifest are not the problem.

2. Read the Trivy log for the database host:

   ```bash
   kubectl logs -n <harbor-namespace> <trivy-pod> --tail=100
   ```

   A timeout, connection refusal, or TLS error naming `mirror.gcr.io` selects this article. An error naming the Harbor Core URL is a scanner-to-core problem, not the public database.

3. Test egress from the Trivy Pod (Option A, step 1). Success from a workstation and failure from the Pod means the cluster egress policy is the block.

4. Check the Harbor version and the current Trivy settings:

   ```bash
   kubectl get harbor -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,VERSION:.spec.version
   kubectl get harbor -n <harbor-namespace> <harbor-name> -o jsonpath='{.spec.helmValues.trivy}{"\n"}'
   ```

5. After either repair, scan a second small image and confirm the UI stores a result. A single cached report does not prove that the update path works.
