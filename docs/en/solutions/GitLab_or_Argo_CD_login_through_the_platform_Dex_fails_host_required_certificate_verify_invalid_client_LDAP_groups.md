---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
  - Alauda Container Platform
ProductsVersion:
  - "4.1"
  - "4.1.3"
  - "4.2"
  - "4.3"
  - "4.3.2"
---

# GitLab or Argo CD login through the platform Dex fails: host required, certificate verify, invalid_client, LDAP groups

## Issue

Login to GitLab or Argo CD through the platform Dex fails. One of these symptoms is shown:

- The GitLab sign-in page reports `Could not authenticate you from Dex because "'host' required.".`
- The GitLab sign-in page reports `Could not authenticate you from Dex because "Ssl connect returned=1 errno=0 peeraddr=<platform-address>:443 state=error: certificate verify failed (self-signed certificate in certificate chain)".`
- Argo CD opened from the platform fails `LOG IN VIA OIDC` with `failed to get token: oauth2: "invalid_client" "Invalid client credentials."`, while the Argo CD admin password still works; **Create GitOps Application** is a blank page, and the browser console shows `ERROR TypeError: Cannot read properties of undefined (reading 'ecmp')`.
- LDAP users do not receive the Argo CD groups that local users with the same kind of platform role receive.

Related articles: "Harbor SSO through the platform Dex fails: wrong issuer, OAuth2Client name, or Unregistered redirect_uri console-portal" and "Toolchain SSO on a domain name after an IP-based install, and kube-apiserver OIDC for an external UI on ACP".

## Root Cause

### Cause 1: the GitLab `OAuth2Client` redirect has no scheme

For an Alauda Build of GitLab instance (installed from OperatorHub) whose SSO provider is the platform Dex (`key: provider`, `secret: gitlab-sso-config`, `syncProfileFromProvider: - dex`), `'host' required` is returned when the redirect URLs on the Dex `OAuth2Client` for GitLab do not start with `https://`.

### Cause 2: GitLab does not trust the platform (Dex) certificate

`certificate verify failed (self-signed certificate in certificate chain)` is returned when the platform certificate chain is self-signed and GitLab has no CA to trust it. Creating a Secret with that CA and referencing it under `certificates.customCAs` on the GitLab instance fixes it. After Causes 1 and 2 are fixed, the Dex login reaches the GitLab profile page.

### Cause 3: GitOps 4.3.0 on ACP 4.1.3 uses a Dex client that does not exist

GitOps plugin 4.3.0 installed on the global cluster of ACP 4.1.3 configures Argo CD with `oidcConfig` `issuer: <platform>/dex`, `clientID: alauda-argocd-gitops`, and `clientSecret: $argocd-gitops-sso:clientSecret`. Dex (`dex-configmap` in `cpaas-system`) has no client `alauda-argocd-gitops`, and the Secret `argocd-gitops-sso` decodes to a different secret, so token exchange fails with `invalid_client`. ACP 4.1.3 is not adapted for GitOps 4.3.0. GitOps plugin 4.2.0 with argocd-operator 4.2.0 makes SSO work but leaves the blank page on 4.1.3; GitOps plugin 4.1.8 with argocd-operator 4.2.0 clears both.

### Cause 4: Argo CD does not map LDAP usernames that contain uppercase letters

Argo CD uses the platform Dex, and the platform uses LDAP. A local user with a platform role gets a group such as `platform-admin-system` or a project administrator group in Argo CD. An LDAP user with the same kind of role does not get the group when the LDAP username contains uppercase characters, because the sync ignores them, so group-based rights (for example creating a repository) cannot be granted. LDAP usernames in lowercase get the groups. There is no setting that stores such a user in lowercase.

## Resolution

### Cause 1: the GitLab `OAuth2Client` redirect has no scheme

1. Back up the clients and read their redirects:

   ```bash
   kubectl get oauth2clients.dex.coreos.com -A -o yaml > /tmp/oauth2clients.bak.yaml
   kubectl get oauth2clients.dex.coreos.com -A -o yaml | grep -n -i redirect
   ```

2. Prefix each GitLab redirect with `https://` (`https://<gitlab-address>/<existing-callback-path>`), keeping the host and path.

   > **Warning:** Changing redirect URLs breaks callbacks that still use the old string. Precondition: only when the error is `'host' required` and a redirect value has no `https://` prefix. Rollback: `kubectl apply -f /tmp/oauth2clients.bak.yaml`.

   ```bash
   kubectl edit oauth2clients.dex.coreos.com -n cpaas-system <gitlab-oauth2client-name>
   ```

### Cause 2: GitLab does not trust the platform (Dex) certificate

1. Export the chain that the platform presents and keep the CA certificate (the last certificate in the chain):

   ```bash
   openssl s_client -connect <platform-address>:443 -showcerts </dev/null 2>/dev/null \
     | awk '/BEGIN CERTIFICATE/{n++} n{print > ("/tmp/dex-chain-" n ".pem")}'
   ls /tmp/dex-chain-*.pem
   openssl x509 -in /tmp/dex-chain-<last>.pem -noout -subject -issuer
   ```

2. Create the Secret in the GitLab instance namespace. The upstream GitLab chart expects one PEM CA per key, with a `.crt` key name:

   ```bash
   kubectl create secret generic dex-tls -n <gitlab-namespace> --from-file=dex-ca.crt=/tmp/dex-chain-<last>.pem
   ```

3. Reference the Secret on the GitLab instance.

   > **Warning:** Editing the GitLab instance makes the operator roll the GitLab Pods, so GitLab is unavailable during the rollout. Precondition: only when the sign-in error is `certificate verify failed` against the platform address and the instance has no `customCAs` entry for that CA. Rollback: `kubectl apply -f /tmp/gitlab-instance.bak.yaml`.

   ```bash
   kubectl api-resources | grep -i gitlab
   kubectl get <gitlab-kind> -n <gitlab-namespace> <instance-name> -o yaml > /tmp/gitlab-instance.bak.yaml
   kubectl edit <gitlab-kind> -n <gitlab-namespace> <instance-name>
   ```

   ```yaml
   certificates:
     customCAs:
       - secret: dex-tls
   ```

4. Retry the SSO login after the GitLab Pods are Ready.

### Cause 3: GitOps 4.3.0 on ACP 4.1.3 uses a Dex client that does not exist

1. Confirm the mismatch:

   ```bash
   kubectl -n cpaas-system get cm dex-configmap -o yaml | grep -n -E 'staticClients|id:' -A2
   kubectl get oauth2clients.dex.coreos.com -A | grep -i argocd
   kubectl get secret -A | grep argocd-gitops-sso
   kubectl get argocd -A -o yaml | grep -n -A12 oidcConfig
   ```

   No Dex client with id `alauda-argocd-gitops` while Argo CD asks for it is this cause.

2. Deploy GitOps plugin 4.1.8 with argocd-operator 4.2.0 on ACP 4.1.3. That combination makes both SSO and the GitOps application pages work. Hand-editing the Argo CD client id and secret can make SSO pass, but does not fix a one-click install on this ACP version.

### Cause 4: Argo CD does not map LDAP usernames that contain uppercase letters

Use lowercase LDAP usernames for accounts that must receive Argo CD groups from platform roles. The groups that local users already show (`platform-admin-system` and the project administrator groups) confirm that the mapping works for lowercase names.

## Diagnostic Steps

```bash
curl -k -sS "https://<platform-address>/dex/.well-known/openid-configuration"
kubectl get oauth2clients.dex.coreos.com -n cpaas-system -o custom-columns=NAME:.metadata.name,ID:.id
kubectl get deploy -n cpaas-system | grep -Ei 'argo|gitops|apollo'
kubectl get csv -A | grep -Ei 'gitops|argocd'
```

- `'host' required` on the GitLab sign-in page, and a GitLab redirect without `https://`: Cause 1.
- `certificate verify failed (self-signed certificate in certificate chain)` on the GitLab sign-in page: Cause 2.
- `invalid_client` on Argo CD OIDC login, or `Cannot read properties of undefined (reading 'ecmp')` on Create GitOps Application, on ACP 4.1.3: Cause 3.
- LDAP users missing Argo CD groups that local users have: Cause 4.
