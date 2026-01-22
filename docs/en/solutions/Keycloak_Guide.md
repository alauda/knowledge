# Keycloak Overview
Keycloak is an open-source, enterprise-grade Identity and Access Management (IAM) solution led by Red Hat. It provides unified identity authentication, authorization and user management capabilities for applications, APIs and microservices, supporting a variety of mainstream identity authentication protocols. Its core design concept emphasizes centralized identity control, high security, scalability and cloud-native adaptation capabilities.

## Key Features
- **Architecture**: Adopts a modular, microservice-friendly architecture, supports cluster deployment and horizontal scaling, with complete high-availability design and data synchronization mechanisms.
- **Identity Authentication Protocols**: Fully supports mainstream identity protocols such as OpenID Connect (OIDC), SAML 2.0 and OAuth 2.0, compatible with various client applications (Web, mobile, API).
- **Security**: Built-in Multi-Factor Authentication (MFA), Single Sign-On (SSO), identity federation and fine-grained permission control; supports password policy management, LDAP/Active Directory integration, key rotation and encrypted storage.
- **Integration Capabilities**: Provides rich APIs and client adapters for easy integration with applications of various technology stacks such as Java, Python and Node.js; supports custom authentication processes and user storage adapters.
- **Cloud-Native Support**: Deeply integrated with Docker/Kubernetes, supports containerized deployment; provides official Operator to simplify deployment, operation, maintenance and scaling in Kubernetes environment.

## Typical Use Cases
- **Enterprise-grade Single Sign-On (SSO)**: Provides unified identity authentication for internal enterprise systems such as ERP, CRM and OA, realizing "one login for multiple system access", improving user experience and management efficiency.
- **Cloud-Native Application Identity Control**: Provides API authorization and inter-service identity authentication for Kubernetes microservices and Serverless applications, ensuring secure communication of microservice architecture.
- **External User Identity Management**: User registration, login and permission management for B2C e-commerce platforms and B2B partner portals, supporting social login (Google, Facebook, etc.) and third-party identity federation.
- **Legacy System Identity Modernization**: Replace traditional outdated identity authentication systems, provide standardized identity authentication interfaces for legacy applications, and smoothly migrate to modern identity management architecture.

# Keycloak vs Red Hat Single Sign-On (RH-SSO)
| Category               | Keycloak                                  | Red Hat Single Sign-On (RH-SSO)                          |
|--------------------|-------------------------------------------|-----------------------------------------------------------|
| **Maintainer**         | Community (Red Hat engineers + community contributors)  | Red Hat Commercial Team                                          |
| **Release Cycle**       | Rapid iteration and frequent updates, priority support for new technical features    | Slow iteration, strictly tested for enterprise grade, focus on stability                |
| **Support Lifecycle**   | Short (usually 6-12 months of support for each version)          | Up to 7+ years of commercial support (including security patches and bug fixes)           |
| **Stability**         | May contain experimental features, stability needs user verification in some scenarios | Enterprise-grade stability, verified in multiple scenarios, compatible with mainstream enterprise systems            |
| **Features**           | Covers core identity management functions, including some experimental features    | Selected stable features with additional enterprise-grade enhanced functions (e.g., advanced monitoring, exclusive support tools) |
| **Documentation & Support**     | Community documentation, no official SLA guarantee, problems rely on community discussions for solutions | Red Hat official documentation and knowledge base, providing SLA-level commercial support and technical consulting    |
| **License**         | Apache License 2.0 (open source and free)            | Requires Red Hat commercial subscription                                     |
| **Reference**           | [Keycloak Official Documentation](https://www.keycloak.org/documentation) | [Red Hat Single Sign-On Official Documentation](https://docs.redhat.com/en/documentation/red_hat_single_sign-on/7.6) |

# Quick Start
The configurations provided in this chapter are **for development/test environment only**, supporting access within the Kubernetes cluster or via port forwarding only. For production environment, additional configuration of ingress host information and TLS encryption is required to ensure access security.

## Core Description
- Keycloak deployment depends on a database (PostgreSQL is used as an example), the YAML configurations for database-related resources and Keycloak instances will be provided below;
- For detailed database configuration, refer to the official documentation: [Keycloak DB Configuration Guide](https://www.keycloak.org/server/db);
- For basic Keycloak deployment, refer to the official documentation: [Keycloak Operator Basic Deployment Guide](https://www.keycloak.org/operator/basic-deployment).

## Configuration List
### PostgreSQL Database
```yaml
# PostgreSQL Secret
apiVersion: v1
kind: Secret
metadata:
  name: keycloak-db-secret
stringData:
  username: "kc-user"
  password: "testpassword"
type: Opaque
---
# PostgreSQL StatefulSet
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql-db
spec:
  serviceName: postgres-db
  selector:
    matchLabels:
      app: postgresql-db
  replicas: 1
  template:
    metadata:
      labels:
        app: postgresql-db
    spec:
      containers:
        - name: postgresql-db
          image: quay.io/sclorg/postgresql-15-c9s:latest
          volumeMounts:
            - mountPath: /var/lib/pgsql/data
              name: cache-volume
          env:
            - name: POSTGRESQL_USER
              valueFrom:
                secretKeyRef:
                  key: username
                  name: keycloak-db-secret
            - name: POSTGRESQL_PASSWORD
              valueFrom:
                secretKeyRef:
                  key: password
                  name: keycloak-db-secret
            - name: POSTGRESQL_DATABASE
              value: keycloak
      volumes:
        - name: cache-volume
          # WARNING: emptyDir will lose all data on pod restart/deletion.
          # For production, use a PersistentVolumeClaim instead.
          emptyDir: {}
---
# PostgreSQL StatefulSet Service
apiVersion: v1
kind: Service
metadata:
  name: postgres-db
spec:
  selector:
    app: postgresql-db
  ports:
  - port: 5432
    targetPort: 5432
```
### Keycloak Instance
```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: Keycloak
metadata:
  name: example-kc
spec:
  instances: 1
  db:
    vendor: postgres
    host: postgres-db
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
    - name: metrics-enabled
      value: "true"
    - name: hostname-strict
      value: 'false'
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

### Deployment Instructions
1. Execute the YAML configurations in the above sequence (Deploy PostgreSQL first, then deploy Keycloak);
2. For debugging and development purposes, you can use port forwarding to connect directly to the Keycloak service. For example, run the following command:
```bash
kubectl port-forward service/example-kc-service 8080:8080
```
3. Access the admin console via browser at `http://localhost:8080`.
4. Production Environment Adaptation: Enable ingress and configure host and TLS encryption. The example is as follows (adjust according to the actual environment):
```yaml
apiVersion: k8s.keycloak.org/v2alpha1
kind: Keycloak
metadata:
  name: example-kc
spec:
  instances: 1
  db:
    vendor: postgres
    host: postgres-db
    usernameSecret:
      name: keycloak-db-secret
      key: username
    passwordSecret:
      name: keycloak-db-secret
      key: password
  http:
    tlsSecret: example-tls-secret
  ingress:
    className: nginx
    tlsSecret: example-tls-secret
  additionalOptions:
    - name: metrics-enabled
      value: "true"
  hostname:
    hostname: test.keycloak.org
  proxy:
    headers: xforwarded # default nginx ingress sets x-forwarded
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

## Access the Admin Console
When deploying Keycloak, the Operator generates a random initial administrator username and password, and stores these credentials as a basic-auth type Secret object, which is in the same namespace as the Keycloak Custom Resource (CR).

To obtain the initial administrator credentials, you need to read and decode the corresponding Secret object. The name of this Secret is derived from the Keycloak CR name plus the fixed suffix `-initial-admin`. To get the administrator username and password for the CR named `example-kc`, run the following commands:

```bash
kubectl get secret example-kc-initial-admin -o jsonpath='{.data.username}' | base64 --decode
kubectl get secret example-kc-initial-admin -o jsonpath='{.data.password}' | base64 --decode
```
You can use these credentials to access the Keycloak Admin Console or the Admin REST API.

# Red Hat SSO (RH-SSO) Migration Guide to Keycloak

## Migration Overview
Red Hat Single Sign-On (RH-SSO) 7.x is a commercial distribution developed by Red Hat based on the **Keycloak Community Edition**, and the two are **fully compatible in core data model and storage structure**.

This migration solution adopts the **officially recommended export/import mechanism**, which achieves complete migration of the following data:

- Realm configurations
- Users (including credentials and status)
- Realm Roles / Client Roles
- Clients and their permission mappings
- Composite roles and built-in administrative permissions

### Overall Migration Process
```
RH-SSO (OpenShift)
   ↓ Export as JSON file
Local Server
   ↓ Copy the migration file
Keycloak (Kubernetes)
   ↓ Import JSON file
Migration Completed
```

### Steps

#### Full Data Export from RH-SSO (OpenShift Environment)
```bash
## Enter the RH-SSO Pod
oc rsh <RH-SSO-Pod-Name>
## Execute the export command
/opt/eap/bin/standalone.sh -c standalone-openshift.xml -Dkeycloak.migration.action=export -Dkeycloak.migration.provider=singleFile -Dkeycloak.migration.file=/tmp/sso-export.json -Dkeycloak.migration.usersExportStrategy=REALM_FILE -Djboss.socket.binding.port-offset=502
```

#### Cross-Cluster Copy of Migration File
```bash
oc cp <RH-SSO-Pod-Name>:/tmp/sso-export.json /tmp/sso-export.json
kubectl cp /tmp/sso-export.json <namespace>/<keycloak-pod>:/tmp/sso-export.json
```

#### Data Import to Keycloak
```bash
## Enter the running Keycloak Pod
kubectl exec -it <Keycloak-Pod-Name> -n <Target-Namespace> -- /bin/bash
## Execute the import command
/opt/keycloak/bin/kc.sh import --file /tmp/sso-export.json --override true
```

### Notes
- Import Success Criterion: After executing the Keycloak import command, the log prints `Realm 'xxxxxx' imported` which means the data import is completed. The final prompt `ERROR: Address already in use` is a port conflict and will not affect the data import result.
- Data Integrity Verification: After the import is completed, log in to the Keycloak Admin Console and verify that the Realm list, user quantity, client configuration, role permissions and other data are consistent with the source RH-SSO.

## Reference Documentation
- [RH-SSO 7.6 Migration Documentation](https://docs.redhat.com/en/documentation/red_hat_single_sign-on/7.6/html/server_administration_guide/assembly-exporting-importing_server_administration_guide)
- [Keycloak Migration Documentation](https://www.keycloak.org/server/importExport)
