---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Harbor access address and exposure: HA needs Ingress and a domain, wrong externalURL, ALB, and Envoy Gateway

## Issue

The Harbor instance installs, but the way it is reached is wrong or unclear:

- The high-availability creation form demands a domain name. No domain is available, and NodePort, a raw IP, or DNS to a VIP that load-balances onto node NodePorts was expected to provide high availability.
- The Harbor Pods are `Running`, but the UI does not open on the name clients use.
- The Harbor toolchain integration and the clients use an `IP:Port` address (for example a hardware load balancer in front of a NodePort) and have to move to a domain name.
- After a platform upgrade, Harbor has to be served through ALB, and it is not clear which `expose` type and fields that needs.
- The Harbor entry has to move from ALB Ingress to Envoy Gateway.

## Root Cause

### Cause 1: high availability requires Ingress and a domain name; NodePort does not provide it

The high-availability template of Alauda Build of Harbor uses an Ingress and a domain name, with the domain resolving to a VIP. NodePort exposure, including a YAML deployment whose expose type is `nodePort`, is the non-HA (single-point) form. A domain whose DNS points at a VIP that load-balances onto node NodePorts is not the supported HA exposure, and IP-only access is not supported for an HA instance. A single-point instance can still use `IP:NodePort` as its one access address.

The domain has to exist before the HA deployment. A temporary domain is enough to finish the deployment and can be replaced later (Cause 2).

The documented baseline for the HA template is: more than two cluster nodes, highly available Redis and PostgreSQL, and a highly available load balancer (with ALB, a VIP is part of it). Node-local storage is not the HA storage form; the StorageClass or PVC must be `ReadWriteMany`.

### Cause 2: the UI does not open because the access address on the Harbor resource is wrong

The Pods are `Running`, but the access address stored on the `Harbor` resource is not the name clients resolve, or does not resolve to the instance's Ingress. Harbor builds its links and token realm from that address, so the UI does not open on the client's name. The repair is to edit the access address on the Harbor resource, not the NodePort Service.

The address is `spec.helmValues.externalURL`, and the Ingress host is `spec.helmValues.expose.ingress.hosts.core`, with `spec.helmValues.expose.type: ingress`. Some examples, such as the [Harbor disaster recovery procedure](How_to_perform_disaster_recovery_for_harbor.md), place `externalURL` directly under `spec`. Edit the field that exists on the live object, and keep the host identical in `externalURL` and in the Ingress host.

### Cause 3: moving the toolchain integration and clients from `IP:Port` to a domain

Under standard usage Harbor has a single access address, either `IP:NodePort` or a domain name, and a single expose type; the portal, push, and pull must all use that address. A second, hand-written Ingress next to a NodePort exposure is not a supported way to add a domain. Moving to a domain therefore means switching the instance to Ingress access with that domain (Causes 1 and 2), after which the old `IP:Port` entry stops serving Harbor. Everything that names the old address (the toolchain integration, image references, pull Secrets) has to move with it.

### Cause 4: serving Harbor through ALB is the `ingress` expose type

In the Alauda Build of Harbor 2.14 deployment documentation for the 4.3 platform, the complete example that combines high availability, a storage class, and Ingress network access is the ALB form. ALB access is the `ingress` expose type. Under `spec.helmValues` the example sets:

- `expose.type: ingress`
- `expose.tls.enabled: false`
- `expose.ingress.hosts.core`: the Harbor domain, `harbor.example.com` in the example
- `externalURL`: the access address on the same domain, `http://harbor.example.com` in the example
- `existingSecretAdminPassword: harbor-password` and `existingSecretAdminPasswordKey: password`
- `persistence.enabled: true`

The host in `externalURL` and in `expose.ingress.hosts.core` is the same value, the same rule as Cause 2.

### Cause 5: Envoy Gateway exposure needs Harbor 2.14

Alauda Build of Harbor 2.14 supports Envoy Gateway network access: its documentation describes an Envoy Gateway template (`spec.helmValues.expose.type: route`) and a high-availability Envoy Gateway template. An older instance (for example 2.6.4) cannot switch its entry from ALB to Envoy Gateway directly; upgrade it to 2.14 first.

## Resolution

### Cause 1: high availability requires Ingress and a domain name; NodePort does not provide it

1. Use the high-availability template with an Ingress and a domain name. If the formal domain is not ready, use a temporary domain that you control and that resolves to the VIP.
2. Check the baseline before deploying: more than two nodes, HA Redis and PostgreSQL, an HA load balancer, and `ReadWriteMany` storage.
3. After the temporary name works, replace it with the formal one using the edit in Cause 2. That edit is how the domain is changed; it is not a reinstall.

A NodePort instance, with or without DNS and a VIP in front of it, stays the non-HA form.

### Cause 2: the UI does not open because the access address on the Harbor resource is wrong

1. Save the resource and find where the address is stored:

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml > /tmp/harbor-before.yaml
   grep -n -E 'externalURL|type: |core:' /tmp/harbor-before.yaml
   nslookup <harbor-domain>
   ```

   `nslookup` must return the address of the instance's Ingress (the load balancer or VIP) before you continue.

2. Set the live `externalURL` and `spec.helmValues.expose.ingress.hosts.core` to the same host, with `https://` on the URL when TLS is enabled, and `spec.helmValues.expose.type` to `ingress`.

   > **Warning:** Changing the access address makes Harbor emit links and token realms for the new host. Impact: browsers and `docker login` that still use the old host fail until they switch. Precondition: a maintenance window, `/tmp/harbor-before.yaml` saved, and the new name resolving to this instance's Ingress. Rollback: `kubectl apply -f /tmp/harbor-before.yaml`.

   ```bash
   kubectl -n <namespace> edit harbor <name>
   ```

3. After the operator reconciles, open the UI on that host and log in.

### Cause 3: moving the toolchain integration and clients from `IP:Port` to a domain

1. Record what uses the old address before the window:

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml > /tmp/harbor-before.yaml
   grep -nE 'externalURL|type: nodePort|type: ingress|hosts:|core:' /tmp/harbor-before.yaml
   kubectl -n <namespace> get svc,ingress
   kubectl get secret -A --field-selector type=kubernetes.io/dockerconfigjson -o name
   nslookup <harbor-domain>
   ```

   The domain must resolve to the load balancer address that will front the Harbor Ingress. The Secret list shows the pull Secrets that may need to be recreated for the new host.

2. Switch the instance to Ingress access on the domain: the HA template from Cause 1 when the instance must be highly available, otherwise the edit in Cause 2 on the existing instance (setting `expose.type` from `nodePort` to `ingress`). Use the backup, Warning, and rollback of Cause 2.

3. Edit the Harbor tool integration so that its access address and its API address both use the new domain.

4. Change image references and pull Secrets that name the old `IP:Port` to the domain, in the same window: once `expose.type` is `ingress`, the old address no longer serves Harbor. Test `docker login <harbor-domain>` and one pull.

### Cause 4: serving Harbor through ALB is the `ingress` expose type

1. Read the current expose block and confirm that the domain resolves to the ALB address (the VIP when ALB is the HA load balancer):

   ```bash
   kubectl -n <namespace> get harbor <name> -o yaml > /tmp/harbor-before.yaml
   grep -n -E 'externalURL|expose:|type: |hosts:|core:|tls:' /tmp/harbor-before.yaml
   kubectl get ingressclass
   nslookup <harbor-domain>
   ```

2. Merge this block into the existing `spec.helmValues`, keeping the database, Redis, and persistence keys the live object already has:

   ```yaml
   spec:
     helmValues:
       expose:
         type: ingress
         tls:
           enabled: false
         ingress:
           hosts:
             core: <harbor-domain>
       externalURL: http://<harbor-domain>
       existingSecretAdminPassword: harbor-password
       existingSecretAdminPasswordKey: password
       persistence:
         enabled: true
   ```

   `harbor-password` is the Secret name of the example; use the admin-password Secret the live object already names, or create it before a new Harbor resource. With TLS enabled, `externalURL` starts with `https://`.

   > **Warning:** Changing `expose.type` on a running instance (for example from `nodePort` to `ingress`) replaces the way Harbor is reached. Impact: the old `IP:Port` entry stops serving Harbor, and clients, pull Secrets, and the toolchain integration that use it fail until they move to the domain. Precondition: the domain resolves to the ALB address, `/tmp/harbor-before.yaml` is saved, and the change is made in a maintenance window. Rollback: `kubectl apply -f /tmp/harbor-before.yaml`.

   ```bash
   kubectl -n <namespace> edit harbor <name>
   ```

3. After the operator reconciles, an Ingress for the domain exists in the instance namespace. Open the UI on the domain, run `docker login <harbor-domain>`, and pull one known tag. Move the integration and pull Secrets as in Cause 3.

### Cause 5: Envoy Gateway exposure needs Harbor 2.14

1. Read the Harbor version:

   ```bash
   kubectl get harbor -A
   kubectl get csv -A | grep -i harbor
   ```

2. Below 2.14, upgrade Harbor to 2.14 first, following the upgrade documentation for your Harbor version.
3. On 2.14, follow the Envoy Gateway network access section of the Alauda Build of Harbor 2.14 deployment documentation. Its template sets `spec.helmValues.expose.type: route`; take the other fields from that document.
4. For a high-availability instance, use the HA Envoy Gateway template from the same documentation and test it on the target cluster before the production change.

Changing `expose.type` replaces the Harbor entry; use the backup, Warning, and client checks of Cause 4.

## Diagnostic Steps

1. Read the expose block and the access address on the live object:

   ```bash
   kubectl get harbor -A
   kubectl -n <namespace> get harbor <name> -o yaml | grep -n -E 'externalURL|expose:|type: |core:'
   kubectl -n <namespace> get svc,ingress
   ```

2. Match the request:

   | Situation | Cause |
   | --- | --- |
   | New HA instance, the form does not continue without a domain | Cause 1 |
   | Instance `Running`, only the URL does not open; the host in `externalURL` differs from what clients resolve | Cause 2 |
   | Healthy instance, integration and clients must move from `IP:Port` to a domain | Cause 3 |
   | Which `expose` values serve Harbor through ALB | Cause 4 |
   | Move the entry from ALB Ingress to Envoy Gateway | Cause 5; check the version first |

3. Before any edit, confirm where `externalURL` sits on the live YAML (`spec.helmValues` or `spec`) and that `nslookup <harbor-domain>` returns the load balancer address.

An instance that never finishes installing (PostgreSQL or Redis failures) is not covered here; see [harbor-core cannot connect to Redis](harbor-core_cannot_connect_to_Redis_NOAUTH_from_Sentinel_or_ERR_invalid_password_after_a_Redis_password_change.md) and [Harbor core service unavailable or internal server error, stuck instance status, or Pods cycling after an edit](Harbor_core_service_unavailable_or_internal_server_error_stuck_instance_status_or_Pods_cycling_after_an_edit.md). For a toolchain integration that fails after the address is correct, see [Harbor toolchain integration fails](Harbor_toolchain_integration_fails_images_not_selectable_katanomi-plugin_timeout_or_push_asks_for_credentials.md).
