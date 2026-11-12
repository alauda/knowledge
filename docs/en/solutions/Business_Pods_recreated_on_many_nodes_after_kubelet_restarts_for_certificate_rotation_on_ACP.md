---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.12.x
  - 4.0.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# Business Pods recreated on many nodes after kubelet restarts for certificate rotation on ACP

## Issue

Many business Pods are recreated at the same time, on more than one node and sometimes on more than one cluster. The kubelet logs on those nodes show that kubelet restarted because of certificate rotation. The Kubernetes Certificates Rotator plugin is installed, and the restart happened about 61 days after the kubelet certificate was issued. The recreated Pods do not mount any certificate volume.

Related articles: "Recovering ACP Kubernetes Certificates with Kubernetes Certificates Rotator" covers restoring long-lived certificates after the plugin; "Log module and monitoring dashboard unavailable after a kube-apiserver internal certificate expires on ACP" covers certificates that expired after the plugin was uninstalled.

## Root Cause

### Cause 1: kubelet restarts on certificate-rotation day 61 and re-admits Pods against the current node isolation policy

The Kubernetes Certificates Rotator plugin replaces the default long-lived Kubernetes certificates with short-lived ones (91 days for kubelet certificates), renews the kubelet certificate about 61 days after issue, and restarts kubelet so that it loads the new certificate.

When kubelet restarts, it no longer has the admission state it held in memory, and it runs the admission checks, including node affinity, again for the Pods assigned to the node. Pods whose node affinity no longer matches the node are rejected, and their controllers create replacements. This happens when the saved Pods still require a previous node-group label while the node isolation policy in force has changed. The restart for certificate rotation is what triggers the recreation; the Pods are not missing a certificate.

## Resolution

### Cause 1: kubelet restarts on certificate-rotation day 61 and re-admits Pods against the current node isolation policy

1. Confirm the signature: kubelet restarted because of certificate rotation, the rotation fell on day 61 of the kubelet certificate, and the recreated Pods fail node affinity against the current labels (Diagnostic Steps).

2. Stop the periodic restarts: replace the short-lived certificates with 10-year certificates as described in the platform certificate documentation, then uninstall the Kubernetes Certificates Rotator plugin. The re-signing procedure is in "Recovering ACP Kubernetes Certificates with Kubernetes Certificates Rotator".

   > **Warning:** Uninstalling the plugin without long-lived certificates in place stops rotation of short-lived certificates, which then expire and break the control plane and kubelet. Uninstall only after the long-lived certificates are written and verified on every node, and only on a cluster that shows this kubelet-restart signature. Re-signing restarts the control-plane components and kubelet on each node; follow the backup and rollback steps of that procedure.

3. Changing workload selectors or node labels would change where business Pods can be scheduled. That is a separate decision for the workload owner and the node isolation policy owner, not part of this fix.

## Diagnostic Steps

1. Check the kubelet restart and its reason on an affected node:

   ```bash
   journalctl -u kubelet --since "<time-before-the-recreation>" | grep -i -E 'certificate|rotat|Started|Stopping' | head -50
   openssl x509 -in /var/lib/kubelet/pki/kubelet.crt -noout -dates 2>/dev/null
   openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates
   ```

   A restart at the time of the recreation, and a kubelet certificate whose `notBefore` matches that time with a validity of about 91 days, match this cause.

2. Check that the plugin is installed:

   ```bash
   kubectl get moduleinfo -l cpaas.io/module-name=cluster-cert-rotator
   ```

3. Check why the old Pods were rejected:

   ```bash
   kubectl get pods -A --field-selector status.phase=Failed -o wide | head
   kubectl get pod -n <namespace> <failed-pod> -o jsonpath='{.status.reason}{"\t"}{.status.message}{"\n"}'
   kubectl get pod -n <namespace> <pod> -o jsonpath='{.spec.affinity.nodeAffinity}{"\n"}{.spec.nodeSelector}{"\n"}'
   kubectl get node <node> --show-labels
   ```

   A reason such as `NodeAffinity`, and a required node label that the node no longer carries, confirm that the recreation was caused by admission after the kubelet restart.
