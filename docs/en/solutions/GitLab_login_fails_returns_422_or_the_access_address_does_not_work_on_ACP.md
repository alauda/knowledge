---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "3.10"
  - "4.2"
  - "4.3"
---

# GitLab login fails, returns 422, or the access address does not work on ACP

## Issue

A GitLab instance deployed on the platform shows a normal status and every component is Running, but users cannot get in or the address does not work. Typical reports:

- Login says `Invalid login or password`, or authentication failed, although the password in the Secret is correct. On a new instance, for example one deployed for a migration, the GitLab log shows `Failed Login: username=root`.
- The administrator can log in, but one user suddenly cannot.
- Login shows `422: The change you requested was rejected. Make sure you have access to the thing you tried to change.`
- After HTTPS is enabled, the instance update fails with `Ingress.networking.k8s.io "<instance>-webservice-default" is invalid: spec.rules[0].host: Invalid value: "<ip>": must be a DNS name, not an IP address` and `failed rollback: invalid/unknown release server-side apply method`.
- The internal domain is unstable and GitLab should be switched to NodePort, or someone asks whether the Ingress rules in `cpaas-system` can be used to reach GitLab or Harbor.
- The GitLab v4 plugin cannot be switched to Chinese.

The root account password comes from the Secret referenced by `spec.helmValues.global.initialRootPassword` of the `GitlabOfficial` resource (default name `gitlab-root-password`, key `password`). The access address comes from `spec.helmValues.global.hosts` and the Ingress or NodePort settings of the same resource.

Related articles: "GitLab toolchain integration fails: token-gitlab not found, Internal error, projects API 500, or an extra bot project" covers a toolchain integration that reports `Your account has been blocked`.

## Root Cause

### Cause 1: the configured root password is weak

GitLab rejects weak root passwords, so login fails although the Secret matches what the user types. Passwords that fail include a word, a symbol, and a year (such as `Password@2024`), anything containing `gitlab`, `root`, or `admin`, and anything that does not meet the complexity rule. The product documentation requires the root password to contain letters, numbers, and special characters, be at least 8 characters long, and not be one of GitLab's blocked weak passwords. Login works after GitLab is redeployed with a complex password. This is the most frequent cause.

### Cause 2: one user's account is not in an active state

GitLab works and the administrator logs in, but the error for the affected user indicates the account is not approved or not active. Resetting the user's password refreshes the account state.

### Cause 3: the client uses a different address than `external_url`

GitLab is configured for HTTPS with Ingress, and `external_url` is an HTTPS domain plus the Ingress controller's NodePort. Opening GitLab through another address, for example plain HTTP, makes form submissions fail with 422.

### Cause 4: HTTPS was enabled while the instance used an IP address

With HTTPS enabled on an instance still configured for IP access, the rendered Ingress uses the IP as `spec.rules[0].host`, which Kubernetes rejects, so both the upgrade and the Helm rollback fail. HTTPS requires access through a domain name.

### Cause 5: the access method is set in the instance, not in platform Ingress rules

GitLab offers Ingress with a domain, or NodePort with HTTP and SSH ports. Switching is done in the instance: on the toolchain instance update page, or in the `GitlabOfficial` resource. The access method can be changed after creation; the storage settings (for example node storage with path `/cpaas/devops/gitlab`) cannot. The Ingress rules in `cpaas-system` belong to the operator and cannot be used for GitLab or Harbor domain access. NodePort is not available in the high availability template, which requires Ingress with a domain.

### Cause 6: the language is a per-user setting

The GitLab v4 plugin supports Chinese. The management view does not offer a language choice for users; each user sets the language in the user view.

## Resolution

### Cause 1: the configured root password is weak

Choose a password with upper- and lower-case letters, numbers, and special characters that avoids `admin`, `gitlab`, `root`, the user name, and word-plus-year patterns. Redeploy GitLab with it. If the first deployment already initialized the database, rebuild the GitLab database as well.

> **Warning:** Deleting the `GitlabOfficial` resource and dropping the GitLab database removes all GitLab data: projects, users, and settings. Only for a new instance with no data to keep (or with a backup), where root login fails and the configured password is weak. The database drop is irreversible; the saved YAML restores only the configuration.

```bash
# 1. Save the instance definition
kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o yaml > gitlabofficial-<instance>.yaml
# 2. Write the new password into the account Secret
kubectl -n <gitlab-namespace> create secret generic gitlab-root-password \
  --from-literal=password='<new-strong-password>' --dry-run=client -o yaml | kubectl apply -f -
# 3. Delete the instance
kubectl -n <gitlab-namespace> delete gitlabofficial <instance>
# 4. Recreate the GitLab database empty
kubectl -n <pg-namespace> exec -it <pg-primary-pod> -- psql -U postgres \
  -c 'DROP DATABASE IF EXISTS <gitlab-db> WITH (FORCE);' \
  -c 'CREATE DATABASE <gitlab-db> OWNER <gitlab-db-user>;'
```

Remove `metadata.resourceVersion`, `uid`, `creationTimestamp`, `generation`, `managedFields`, and the `status` block from the saved file, then apply it:

```bash
kubectl apply -f gitlabofficial-<instance>.yaml
```

Give each toolchain instance its own PostgreSQL database instead of sharing one across GitLab, SonarQube, and others. GitLab must not use Harbor's PostgreSQL instance; give it a separate instance before the redeploy and update `spec.helmValues.global.psql` and the database Secret.

### Cause 2: one user's account is not in an active state

As an administrator, open **Admin Area > Users**, select the user, and set a new password. If the user is shown as pending approval or blocked, approve or unblock the account on the same page.

### Cause 3: the client uses a different address than `external_url`

```bash
kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o jsonpath='{.spec.helmValues.global.hosts}{"\n"}'
kubectl -n <gitlab-namespace> get ingress
```

Open `https://<gitlab-domain>:<ingress-nodeport>`. If the domain is not in DNS, add it to the client `hosts` file, for example `192.0.2.10 gitlab.example.com`, where `192.0.2.10` is a node or VIP that serves the Ingress controller.

### Cause 4: HTTPS was enabled while the instance used an IP address

Edit the `GitlabOfficial` resource, replace the IP with a domain in every host field, enable Ingress, then enable TLS:

```yaml
spec:
  helmValues:
    gitlab:
      webservice:
        ingress:
          enabled: true
    global:
      hosts:
        domain: gitlab.example.com
        gitlab:
          hostnameOverride: gitlab.example.com
          https: true
          name: gitlab.example.com
        ssh: gitlab.example.com
      ingress:
        class: ""
        enabled: true
        tls:
          enabled: true
          secretName: <gitlab-tls-secret>
```

The TLS Secret is of type `kubernetes.io/tls` in the instance namespace. The instance recovers once the access address is a domain.

### Cause 5: the access method is set in the instance, not in platform Ingress rules

On the toolchain instance update page, change the network access mode from `Ingress` to `Node Port`, and the service access address to the node IP and NodePort that clients will use.

> **Warning:** Switching the access method can restart GitLab components and changes the URL used by users, Git remotes, and CI runners; clones and webhooks that use the old address stop working. Use a maintenance window and update the clients. Rollback: switch back to `Ingress` with the previous address.

The same change in YAML (`kubectl edit gitlabofficial <instance>`), using the NodePort layout from the product documentation:

```yaml
spec:
  helmValues:
    gitlab:
      gitlab-shell:
        service:
          nodePort: 30000          # SSH port
          type: NodePort
      webservice:
        ingress:
          enabled: false
    global:
      appConfig:
        gitlabPort: 30010          # HTTP port
      gitlabNodePort:
        http: 30010
        ssh: 30000
      hosts:
        domain: 192.0.2.10         # node IP
        gitlab:
          https: false
          name: 192.0.2.10
        ssh: 192.0.2.10
      ingress:
        enabled: false
      shell:
        port: 30000
```

Make sure the ports are free on the nodes. For domain access, use the Cause 4 layout with `https: false` and `tls.enabled: false`, and make the domain resolve to the Ingress entry point.

### Cause 6: the language is a per-user setting

1. Open GitLab in the user view as the user who wants Chinese.
2. Open the avatar menu > **Preferences** > **Localization**, and choose `简体中文` (Chinese, Simplified) in **Language**.
3. Select **Save changes** and reload. Each user repeats this for their own account.

To check the stored value through the API:

```bash
curl -s -H "PRIVATE-TOKEN: <token>" "https://<gitlab-domain>/api/v4/user/preferences"
```

## Diagnostic Steps

1. Confirm all components are Running:

   ```bash
   kubectl -n <gitlab-namespace> get pods
   ```

2. Read the configured root password and check it against Cause 1, and look for failed logins:

   ```bash
   SECRET=$(kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o jsonpath='{.spec.helmValues.global.initialRootPassword.secret}')
   kubectl -n <gitlab-namespace> get secret "$SECRET" -o jsonpath='{.data.password}' | base64 -d; echo
   kubectl -n <gitlab-namespace> logs deploy/<instance>-webservice-default -c webservice --tail=500 | grep -i 'Failed Login'
   ```

3. If root works and one user fails, go to Cause 2.
4. Compare the browser address with `spec.helmValues.global.hosts` and the Ingress NodePort (Cause 3).
5. For a failed update after enabling HTTPS, check the host fields:

   ```bash
   kubectl -n <gitlab-namespace> get gitlabofficial <instance> -o yaml | grep -n -A3 'hosts:'
   ```

   An IP in `hosts.gitlab.name` with `https: true` is Cause 4.
6. A missing Chinese option in the management view is Cause 6.
