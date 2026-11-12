---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.2"
  - "4.3"
  - "4.3.2"
---

# Toolchain SSO on a domain name after an IP-based install, and kube-apiserver OIDC for an external UI on ACP

## Issue

One of these is reported:

- The platform was installed and is opened by IP address, and toolchain SSO (Harbor, GitLab, and similar) should use a domain name instead. Adding the DNS name alone does not switch SSO.
- Headlamp, or a similar cluster UI, needs kube-apiserver OIDC flags, and the concern is that the API would then accept only OIDC, which would break the ACP console, in-cluster components, and kubectl, and that an upgrade would remove the flags.

Related articles: "OIDC clients and pages are sent to the wrong Dex issuer address on ACP", "Harbor SSO through the platform Dex fails: wrong issuer, OAuth2Client name, or Unregistered redirect_uri console-portal", and "GitLab or Argo CD login through the platform Dex fails: host required, certificate verify, invalid_client, LDAP groups".

## Root Cause

### Cause 1: a domain for toolchain SSO needs an access address, a certificate, and updated client callbacks

Publishing a DNS name does not change anything on the platform by itself. For toolchain SSO to work on the domain, the domain has to be added as a platform access address, a certificate for that name has to be installed, and each toolchain OAuth2 client callback has to use the domain. A reinstall is normally not needed for this. These steps do not change the default access URL, and they do not change the issuer that Dex publishes. On ACP 4.3.2 the default platform access address and the internal registry address cannot be edited after installation; only additional access addresses can be added. Redeploying with the domain as the default is the only way to change the default itself, and it is not realistic once user clusters already run workloads.

### Cause 2: kube-apiserver OIDC flags add OIDC authentication without turning off ServiceAccount or certificate authentication

Adding the OIDC flags to the kube-apiserver static Pod manifest on every control-plane node enables OIDC login for the external UI. ServiceAccount and client-certificate authentication keep working, so the ACP console, in-cluster components, and kubectl are not affected. A platform upgrade does not revert this manifest edit, and the standard product supports it. Passing the same parameters through installer `extraArgs` has not been shown to work; edit the manifest instead.

This is not how a third-party application obtains a token for the ACP API proxy: the platform API proxy accepts tokens from the `alauda-auth` client only.

## Resolution

### Cause 1: a domain for toolchain SSO needs an access address, a certificate, and updated client callbacks

1. Publish DNS for the platform name.
2. Add the name as an additional platform access address.
3. Install a platform access certificate that contains the DNS name.
4. Edit each toolchain OAuth2 client and set its callback (redirect) URLs to `https://<platform-dns>/...`:

   ```bash
   kubectl get oauth2clients.dex.coreos.com -n cpaas-system -o yaml > /tmp/oauth2clients.bak.yaml
   kubectl edit oauth2clients.dex.coreos.com -n cpaas-system <client-name>
   ```

   > **Warning:** Changing redirect URLs breaks callbacks that still use the old string. Precondition: only after the domain resolves and serves a certificate that contains the name. Rollback: `kubectl apply -f /tmp/oauth2clients.bak.yaml`.

If an OIDC client then reports that the issuer in the provider metadata does not match the issuer it was configured with, the discovery document still advertises the install-time IP; see "OIDC clients and pages are sent to the wrong Dex issuer address on ACP".

### Cause 2: kube-apiserver OIDC flags add OIDC authentication without turning off ServiceAccount or certificate authentication

Apply this only when an external UI must talk to kube-apiserver with OIDC, and a maintenance window covers a rolling kube-apiserver restart.

1. On one control-plane node, back up the static Pod manifest and add the OIDC arguments, keeping every existing argument:

   ```yaml
   - --authorization-mode=Node,RBAC
   - --oidc-issuer-url=https://<issuer>
   - --oidc-username-claim=email
   - --oidc-client-id=<client-id>
   ```

   > **Warning:** kubelet restarts kube-apiserver when the manifest is saved; API calls on that node fail until the Pod is Ready. Precondition: only when the issuer and client id are the identity provider the UI should trust, and the other control-plane nodes are Ready. Rollback: copy `/tmp/kube-apiserver.yaml.bak` back to `/etc/kubernetes/manifests/kube-apiserver.yaml`. An upgrade does not revert this file, so removing the flags is a manual restore from the backup.

   ```bash
   sudo cp -a /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/kube-apiserver.yaml.bak
   sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
   kubectl get nodes
   ```

2. Wait until the kube-apiserver Pod on that node is Ready, then repeat on the next control-plane node, one node at a time.

3. After every control plane is Ready, confirm that an in-cluster ServiceAccount call and a kubectl call still succeed, then test the OIDC UI.

## Diagnostic Steps

```bash
curl -k -sS https://<platform-dns>/dex/.well-known/openid-configuration | jq -r .issuer
openssl s_client -connect <platform-dns>:443 -servername <platform-dns> </dev/null 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName
kubectl get oauth2clients.dex.coreos.com -n cpaas-system -o yaml | grep -n -i redirect
kubectl -n kube-system get pods -o wide | grep kube-apiserver
```

- The toolchains should use a new domain, the platform was installed on an IP, and the client callbacks or the certificate do not contain the domain: Cause 1.
- An external UI needs kube-apiserver OIDC, and the console must keep working: Cause 2. After the change, the kube-apiserver Pods are Running on every control-plane node and both kubectl and the OIDC UI work.
