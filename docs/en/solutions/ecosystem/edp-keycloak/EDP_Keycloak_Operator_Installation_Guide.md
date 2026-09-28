---
products:
  - Alauda Application Services
kind:
  - Solution
ProductsVersion:
  - '4.1,4.2,4.3,4.4'
id: KB260900044
---

<!--
  Authoring model (oss-operator-factory): this guide is authored ONCE by hand. On later
  EDP Keycloak Operator releases, only the slots fenced with `factory:auto:*` markers below are
  updated by the factory pipeline (version, supported versions, known limitations).
  Do NOT hand-edit inside a factory:auto block — those are regenerated from component.yaml /
  release evidence. Prose outside the markers is human-owned and preserved across releases.
-->

# EDP Keycloak Operator — Installation Guide

## Overview

**EDP Keycloak Operator** is the open-source
[EDP Keycloak Operator](https://github.com/epam/edp-keycloak-operator) from the KubeRocketCI project,
listed on the Alauda Cloud marketplace and installable from the ACP OperatorHub.

It lets you manage the **configuration** of a Keycloak server as Kubernetes resources, so that the
identity setup an application needs can live in Git next to the application itself:

- **Realms**, including token lifetimes, event settings and the user profile policy.
- **Clients** — public, confidential and service-account clients, with their roles and redirect URIs.
- **Users, groups and roles**, including group membership and role assignments.
- **Identity providers** (GitHub, another OIDC provider, …) and their mappers.
- **Client scopes, authentication flows, realm components and organizations.**

The Operator applies a resource to Keycloak whenever you create or change it, so the resource is the
place to make changes. An edit made by hand in the Keycloak Admin Console is not reverted right away:
it stays until the resource is next applied — when you change the resource, or when the Operator
restarts.

> **It needs an existing Keycloak 25 or later, and it does not deploy one.** Install Keycloak first —
> for example **Alauda Application Services Identity Management E1** — and then point this Operator
> at it. [Use it with Identity Management E1](#use-it-with-alauda-application-services-identity-management-e1)
> walks through the whole setup.

### Supported Versions

<!-- factory:auto:supported-versions BEGIN -->
| Item | Version |
|------|---------|
| ACP | 4.1, 4.2, 4.3, 4.4 |
| Architectures | amd64 (x86_64), arm64 |
| Network | IPv4, IPv6 |
| EDP Keycloak Operator (bundle) | v1.35.0 |
| EDP Keycloak Operator | 1.35.0 |
| Keycloak server it can manage | 25 or later |
| License | Apache-2.0 |
<!-- factory:auto:supported-versions END -->

## Prerequisites

- An ACP cluster at one of the supported versions above, and `cluster-admin` access to the target
  workload cluster.
- A **Keycloak 25 or later** that the cluster can reach. The rest of this guide uses
  **Alauda Application Services Identity Management E1**; any Keycloak 25+ works the same way once you
  have its URL and an administrator credential.
- The **EDP Keycloak Operator** plugin available in your cluster's OperatorHub. If it has not been
  uploaded yet, an administrator can push it with the `violet` CLI:
  ```bash
  violet push edp-keycloak-operator.<version>.tgz \
    --platform-address="https://<acp-console>" \
    --platform-username="<user>" --platform-password="<password>" \
    --clusters="<target-cluster>"
  ```
- `kubectl` configured against the target cluster.

## Install the Operator

1. In the ACP Console, go to **Administrator > Marketplace > OperatorHub**, select the target
   cluster, find **EDP Keycloak Operator**, and click **Install**.
2. Keep the default channel (`alpha`) and the **Cluster** installation mode (all namespaces). For
   **Installation Location**, the suggested namespace is **`edp-keycloak-operator`**.
3. Confirm the installation.

One Operator serves the whole cluster: you create its resources in the namespaces of the applications
that use them, not in the Operator's own namespace.

### Verify the Operator

```bash
kubectl -n edp-keycloak-operator get csv | grep edp-keycloak-operator
kubectl -n edp-keycloak-operator get deploy
```

Expected: the entry `edp-keycloak-operator.v<version>` reaches phase `Succeeded`, and the Operator's
Deployment shows `1/1` ready.

## Two different resources are called `Keycloak`

This Operator and Identity Management E1 both define a resource of kind `Keycloak`, in different API
groups:

| Resource | Owned by | What it is |
|---|---|---|
| `keycloaks.k8s.keycloak.org` | Identity Management E1 | **a Keycloak server** — creating one deploys Keycloak |
| `keycloaks.v1.edp.epam.com` | EDP Keycloak Operator | **a connection** to an existing Keycloak — a URL plus a credential |

Both can exist in the same cluster and even share a name. But once both are installed, a bare
`kubectl get keycloak` lists only one of the two kinds — on ACP it lists the Keycloak servers and
silently leaves out the EDP connections. So **always use the full resource name**:

```bash
kubectl get keycloaks.k8s.keycloak.org -A     # Keycloak servers
kubectl get keycloaks.v1.edp.epam.com -A      # EDP connections
```

The Identity Management E1 documentation uses the short form `kubectl get keycloak`; on a cluster
that also runs this Operator, type the full name instead.

## Use it with Alauda Application Services Identity Management E1

This section sets up, in one namespace called `sso`:

1. a Keycloak server from Identity Management E1;
2. a connection from this Operator to that server;
3. a realm, a client, a group, a role and a user — all as Kubernetes resources;
4. a check that the user can actually sign in.

### 1. Create the Keycloak server

Install **Alauda Application Services Identity Management E1** and create a Keycloak instance as
described in its documentation:

- [Install](https://docs.alauda.io/keycloak/26.7/install.html)
- [Create Instance](https://docs.alauda.io/keycloak/26.7/functions/10-create_instance.html)

For this walkthrough the instance is called `sso-kc` in namespace `sso`, with the in-cluster HTTP
listener enabled:

```yaml
apiVersion: k8s.keycloak.org/v2beta1
kind: Keycloak
metadata:
  name: sso-kc
  namespace: sso
spec:
  instances: 1
  db:
    vendor: postgres
    host: postgres-db                     # your PostgreSQL service
    database: keycloak
    usernameSecret:
      name: keycloak-db-secret
      key: username
    passwordSecret:
      name: keycloak-db-secret
      key: password
  http:
    httpEnabled: true
  ingress:
    enabled: false
  additionalOptions:
    - name: hostname-strict
      value: "false"
  unsupported:
    podTemplate:
      spec:
        containers:
          - securityContext:
              allowPrivilegeEscalation: false
              runAsNonRoot: true
              capabilities:
                drop:
                  - ALL
              seccompProfile:
                type: RuntimeDefault
```

Wait until it is ready:

```bash
kubectl -n sso wait keycloaks.k8s.keycloak.org/sso-kc --for=condition=Ready --timeout=10m
```

Identity Management E1 then provides two things this Operator uses:

| Object | Name | Used for |
|---|---|---|
| Service | `sso-kc-service`, port `8080` | the URL the Operator talks to |
| Secret | `sso-kc-initial-admin`, keys `username` and `password` | the administrator the Operator signs in as |

### 2. Connect the Operator to it

```yaml
apiVersion: v1.edp.epam.com/v1
kind: Keycloak
metadata:
  name: sso-kc
  namespace: sso
spec:
  url: http://sso-kc-service.sso.svc:8080
  auth:
    passwordGrant:
      username:
        secretKeyRef:
          name: sso-kc-initial-admin
          key: username
      passwordRef:
        name: sso-kc-initial-admin
        key: password
```

```bash
kubectl apply -f connection.yaml
kubectl -n sso get keycloaks.v1.edp.epam.com sso-kc
```

Expected: `CONNECTED` shows `true` within a minute. The Operator sets it only after it has signed in
to Keycloak successfully, so `true` means the URL and the credential are both right.

- The URL is used exactly as written. Keycloak 25+ serves at the root path, so there is **no `/auth`**
  suffix.
- The Secret must be in the same namespace as this resource.
- `sso-kc-initial-admin` is the bootstrap administrator that Keycloak creates at first start. It is
  fine for getting started; for a long-lived setup, switch to a dedicated client as described in
  [Connect with a dedicated service account](#connect-with-a-dedicated-service-account).

### 3. Create a realm

```yaml
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealm
metadata:
  name: demo
  namespace: sso
spec:
  realmName: demo
  keycloakRef:
    kind: Keycloak
    name: sso-kc
  userProfileConfig:
    unmanagedAttributePolicy: ADMIN_EDIT   # needed for custom user attributes, see Known Limitations
```

```bash
kubectl apply -f realm.yaml
kubectl -n sso get keycloakrealms.v1.edp.epam.com demo \
  -o jsonpath='{.status.available}/{.status.value}{"\n"}'
```

Expected: `true/OK`.

### 4. Create a client, a group, a role and a user

```yaml
apiVersion: v1.edp.epam.com/v1
kind: KeycloakClient
metadata:
  name: demo-app
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  clientId: demo-app
  directAccess: true                  # lets the check in step 5 sign in from the command line
  standardFlowEnabled: true
  redirectUris:
    - https://demo-app.example.com/*
  webUrl: https://demo-app.example.com
---
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealmRole
metadata:
  name: developer
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  name: developer
  description: Developer role
---
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealmGroup
metadata:
  name: developers
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  name: developers
  realmRoles:
    - developer
---
apiVersion: v1.edp.epam.com/v1
kind: KeycloakRealmUser
metadata:
  name: alice
  namespace: sso
spec:
  realmRef:
    kind: KeycloakRealm
    name: demo
  username: alice
  email: alice@example.com
  firstName: Alice
  lastName: Example
  enabled: true
  emailVerified: true
  groups:
    - developers
  passwordSecret:
    name: alice-password
    key: password
```

The user's password comes from a Secret, so it never appears in the resource. Create it first:

```bash
kubectl -n sso create secret generic alice-password --from-literal=password='<choose-a-password>'
kubectl apply -f app.yaml
kubectl -n sso get keycloakclients.v1.edp.epam.com,keycloakrealmroles.v1.edp.epam.com,keycloakrealmgroups.v1.edp.epam.com,keycloakrealmusers.v1.edp.epam.com \
  -o custom-columns='KIND:.kind,NAME:.metadata.name,STATUS:.status.value'
```

Expected: every row shows `OK`.

`demo-app` is a confidential client. The Operator generated its client secret and stored it in the
Secret `keycloak-client-demo-app-secret`:

```bash
kubectl -n sso get secret keycloak-client-demo-app-secret -o jsonpath='{.data.clientSecret}' | base64 -d
```

To supply your own secret instead, create a Secret and reference it with
`secret: "$<secret-name>:<key>"` in the `KeycloakClient`.

### 5. Check that the user can sign in

Forward the Keycloak service and request a token for `alice` through `demo-app`:

```bash
kubectl -n sso port-forward svc/sso-kc-service 8080:8080 &

CLIENT_SECRET=$(kubectl -n sso get secret keycloak-client-demo-app-secret -o jsonpath='{.data.clientSecret}' | base64 -d)
TOKEN=$(curl -s http://localhost:8080/realms/demo/protocol/openid-connect/token \
  -d grant_type=password -d client_id=demo-app -d client_secret="$CLIENT_SECRET" \
  -d scope=openid -d username=alice -d password='<the-password-you-chose>' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

curl -s http://localhost:8080/realms/demo/protocol/openid-connect/userinfo \
  -H "Authorization: Bearer $TOKEN"
```

Expected: the second command prints `alice`'s profile — `"preferred_username":"alice"` and her email.
That proves the realm, the client and its generated secret, and the user with her password all work
together. An empty `TOKEN` means the sign-in was refused; run the first `curl` on its own to see why.
Keep `scope=openid` in the token request: without it Keycloak answers the second call with `403`.
You can also sign in to the Admin Console at `http://localhost:8080` with the `sso-kc-initial-admin`
credentials and look at realm `demo`.

`directAccess: true` is there only to make this command-line check possible. Browser-based
applications sign in with the standard flow and do not need it; remove it once you have confirmed the
setup.

## Connect with a dedicated service account

The bootstrap administrator in `sso-kc-initial-admin` is meant for the first start of Keycloak. For a
long-lived connection, give the Operator its own client in the `master` realm and let it sign in with
that client's credentials.

Create the client with the Keycloak admin CLI inside the Keycloak pod. It asks for the password of the
bootstrap administrator:

```bash
kubectl -n sso exec -it sso-kc-0 -- bash -c '
  set -e
  KC=/opt/keycloak/bin/kcadm.sh
  CFG="--config /tmp/kcadm.config"
  $KC config credentials $CFG --server http://localhost:8080 --realm master --user temp-admin
  ID=$($KC create clients $CFG -r master -i \
        -s clientId=edp-keycloak-operator -s publicClient=false \
        -s serviceAccountsEnabled=true -s standardFlowEnabled=false -s directAccessGrantsEnabled=false)
  $KC add-roles $CFG -r master --uusername service-account-edp-keycloak-operator --rolename admin
  $KC get clients/$ID/client-secret $CFG -r master --fields value
  rm -f /tmp/kcadm.config'
```

`temp-admin` is the user name stored in `sso-kc-initial-admin`; check it with
`kubectl -n sso get secret sso-kc-initial-admin -o jsonpath='{.data.username}' | base64 -d`.
The last command prints the new client's secret as `{ "value" : "<secret>" }`. Store it in a Secret and
switch the connection over:

```bash
kubectl -n sso create secret generic edp-keycloak-operator-client \
  --from-literal=clientId=edp-keycloak-operator \
  --from-literal=clientSecret='<the-printed-secret>'
```

```yaml
apiVersion: v1.edp.epam.com/v1
kind: Keycloak
metadata:
  name: sso-kc
  namespace: sso
spec:
  url: http://sso-kc-service.sso.svc:8080
  auth:
    clientCredentials:
      clientId:
        secretKeyRef:
          name: edp-keycloak-operator-client
          key: clientId
      clientSecretRef:
        name: edp-keycloak-operator-client
        key: clientSecret
```

After `kubectl apply`, `CONNECTED` should return to `true`, and the realm, client and user from the
walkthrough stay `OK`.

### Share one connection across namespaces

A `Keycloak` connection serves only its own namespace. To let many namespaces use the same Keycloak,
create a cluster-wide `ClusterKeycloak` instead. Its Secret must be in the **Operator's** namespace,
`edp-keycloak-operator`:

```bash
kubectl -n edp-keycloak-operator create secret generic edp-keycloak-operator-client \
  --from-literal=clientId=edp-keycloak-operator \
  --from-literal=clientSecret='<the-printed-secret>'
```

```yaml
apiVersion: v1.edp.epam.com/v1alpha1
kind: ClusterKeycloak
metadata:
  name: sso-kc
spec:
  url: http://sso-kc-service.sso.svc:8080
  auth:
    clientCredentials:
      clientId:
        secretKeyRef:
          name: edp-keycloak-operator-client
          key: clientId
      clientSecretRef:
        name: edp-keycloak-operator-client
        key: clientSecret
---
apiVersion: v1.edp.epam.com/v1alpha1
kind: ClusterKeycloakRealm
metadata:
  name: shared
spec:
  clusterKeycloakRef: sso-kc
  realmName: shared
```

Resources in any namespace can then point at the realm with
`realmRef: {kind: ClusterKeycloakRealm, name: shared}`.

## Identity Management E1's own resources, or this Operator?

Identity Management E1 also offers some declarative configuration of its own. They can be used side by
side; pick by what you need to manage:

| You need to… | Use |
|---|---|
| Deploy, scale and upgrade the Keycloak server | Identity Management E1 (`keycloaks.k8s.keycloak.org`) |
| Seed a new realm **once**, from a full realm export | Identity Management E1 `KeycloakRealmImport` — it creates the realm and never updates or deletes it afterwards |
| Keep OIDC clients reconciled, next to the Keycloak instance | Identity Management E1 `KeycloakOIDCClient` (new in 26.7; same namespace as the Keycloak instance) |
| Keep realms, users, groups, roles, identity providers, client scopes or authentication flows reconciled | **EDP Keycloak Operator** |
| Manage configuration from the application's own namespace, or against a Keycloak that Identity Management E1 did not deploy | **EDP Keycloak Operator** |

Do not manage the same object from both sides — for example the same client through a
`KeycloakOIDCClient` and a `KeycloakClient`. Each overwrites the other's changes whenever it applies
its own.

## What deleting a resource does

Deleting one of this Operator's resources **deletes the matching object in Keycloak**: deleting a
`KeycloakRealm` deletes the realm, with all its users and clients. To keep the Keycloak object when the
Kubernetes resource goes away, annotate the resource first:

```yaml
metadata:
  annotations:
    edp.epam.com/preserve-resources-on-deletion: "true"
```

Delete in this order, so that each resource can still reach Keycloak while it is being removed:

1. realm contents — `KeycloakClient`, `KeycloakRealmUser`, `KeycloakRealmGroup`, `KeycloakRealmRole`, …
2. `KeycloakRealm` / `ClusterKeycloakRealm`
3. `Keycloak` / `ClusterKeycloak`

To remove the walkthrough:

```bash
kubectl -n sso delete keycloakrealmusers.v1.edp.epam.com,keycloakrealmgroups.v1.edp.epam.com,keycloakrealmroles.v1.edp.epam.com,keycloakclients.v1.edp.epam.com --all
kubectl -n sso delete keycloakrealms.v1.edp.epam.com demo
kubectl -n sso delete keycloaks.v1.edp.epam.com sso-kc
```

## Known Limitations

<!-- factory:auto:known-limitations BEGIN -->
- **Custom user attributes are dropped silently unless the realm allows them.** Keycloak 24 and later
  reject user attributes that the realm's user profile does not declare. A `KeycloakRealmUser` with
  `attributesV2` still reports `OK`, but Keycloak stores no attributes. Set
  `userProfileConfig.unmanagedAttributePolicy: ADMIN_EDIT` on the `KeycloakRealm` (as in the
  walkthrough), or declare the attributes in the realm's user profile.
- **Deleting a resource deletes the Keycloak object.** See
  [What deleting a resource does](#what-deleting-a-resource-does); use the
  `edp.epam.com/preserve-resources-on-deletion` annotation to keep it.
- **Only one side should own each object.** If a client or realm is also managed by Identity Management
  E1 resources or edited in the Admin Console, those changes are overwritten the next time the
  Operator applies the resource — which may be much later, so the conflict is easy to miss.
- **Removing the Operator leaves its resource definitions in the cluster.** Uninstalling does not
  delete the `*.v1.edp.epam.com` resource types; your Keycloak configuration is unaffected.
- **The older `1.23.0` version does not upgrade to this one automatically.** The `1.23.0` entry listed
  for ACP 4.0 is an earlier community-provided build; this version is installed on its own on ACP 4.1
  or later.
<!-- factory:auto:known-limitations END -->

## Uninstall

First remove the resources you created, in the order given in
[What deleting a resource does](#what-deleting-a-resource-does). Then uninstall the Operator from
**Administrator > Marketplace > OperatorHub**, or:

```bash
kubectl -n edp-keycloak-operator delete subscription edp-keycloak-operator
kubectl -n edp-keycloak-operator delete csv -l operators.coreos.com/edp-keycloak-operator.edp-keycloak-operator
```

> Uninstall the Operator **last**. It is what removes each object from Keycloak when its resource is
> deleted; if the Operator is gone first, the resources cannot finish deleting and their namespace
> hangs in `Terminating`.

## FAQ

**Q: `CONNECTED` stays `false`.**
Look for the reason in the Operator's log:

```bash
kubectl -n edp-keycloak-operator logs deploy/keycloak-operator-controller-manager | grep -i "unable to connect"
```

The usual causes: the URL ends in `/auth` (remove it), the Secret is in a different namespace from the
`Keycloak` resource, the credential is wrong, or the Keycloak server is not ready yet.

**Q: `kubectl get keycloak` does not show the connection I created.**
Two resource kinds share that name, and the short form lists only the Keycloak servers. Use `kubectl get keycloaks.k8s.keycloak.org` for servers and
`kubectl get keycloaks.v1.edp.epam.com` for connections. See
[Two different resources are called `Keycloak`](#two-different-resources-are-called-keycloak).

**Q: Creating a second realm resource is rejected with "is already used by KeycloakRealm".**
Two resources cannot manage the same realm on the same Keycloak. Edit the existing `KeycloakRealm`
instead, or give the new one a different `realmName`.

**Q: A user was created, but its attributes are empty in Keycloak.**
The realm's user profile rejects undeclared attributes. See the first item under
[Known Limitations](#known-limitations).

**Q: Can I manage the `master` realm?**
Yes, but be careful: deleting a `KeycloakRealm` for `master` would try to delete the `master` realm.
Always annotate such a resource with `edp.epam.com/preserve-resources-on-deletion: "true"`.

**Q: How do I upgrade?**
Upgrade the Operator from the Marketplace. Your resources and the Keycloak configuration they manage
stay as they are.
