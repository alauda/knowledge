---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

A migration plan from a VMware source to ACP Virtualization maps the VM's network to a cluster **user-defined primary network** (a UDN defined as the namespace's default pod network, rather than a secondary network). The migration reports success at the plan level, but the target VMI does not come up — the `virt-launcher` pod fails to start with a Multus error:

```text
ERRORED: error configuring pod [cudn-ns/virt-launcher-<vm>]
  networking: Multus: [cudn-ns/virt-launcher-<vm>]:
  error loading k8s delegates k8s args:
  TryLoadPodDelegates: error in loading K8S cluster default network from pod annotation:
  tryLoadK8sPodDefaultNetwork: failed getting the delegate:
  getKubernetesDelegate: cannot find a network-attachment-definition (default)
  in namespace (kube-system):
  networkattachmentdefinition.k8s.cni.cncf.io "default" not found
```

Multus cannot resolve the pod's default network: the migration-toolkit has configured the pod to fetch a NAD named `default` from the `kube-system` namespace, which does not exist on the cluster (the UDN's default NAD lives in the **VM's own namespace**, not in the CNI operator's namespace).

## Root Cause

The migration toolkit, when handed a mapping where the source VM's network becomes the destination's UDN primary network, synthesises a Multus annotation on the `virt-launcher` pod that names the default network to attach. In affected toolkit versions, that annotation names the cluster-wide NAD location (a conventional CNI-operator namespace) rather than the UDN's per-namespace default NAD.

Multus reads the annotation literally, looks for the named NAD in the named namespace, does not find it, and aborts pod startup. The VM never boots on the destination cluster.

There is currently no documented user-level workaround that does not involve editing the reconciled `virt-launcher` pod spec directly (which the migration toolkit immediately reconciles back). The fix is in the migration toolkit: the synthesised annotation needs to point at the UDN's per-namespace default NAD. That fix has been tracked by engineering and will ship in an upcoming toolkit release.

## Resolution

### Preferred — upgrade the migration toolkit

Follow the operator-upgrade channel for the migration toolkit to a release that includes the UDN-primary-network fix. After the upgrade, re-run the migration plan; the toolkit now writes the correct NAD reference into the `virt-launcher` annotation and Multus resolves the default network from the destination namespace.

Verify:

```bash
kubectl -n <forklift-ns> get csv -o custom-columns='NAME:.metadata.name,VERSION:.spec.version' | \
  grep -i forklift
```

Check the version against the fix's release notes.

### Workaround while the upgrade is pending

Two options, both time-boxed:

**Map the VM's network to a secondary (non-primary) UDN.** A secondary-network UDN migration does not rely on the broken primary-network annotation path; it attaches the UDN through the regular Multus secondary-network mechanism, which works correctly. Adjust the plan's network-mapping to point at a secondary NAD in the destination namespace:

```yaml
apiVersion: forklift.konveyor.io/v1beta1
kind: NetworkMap
metadata:
  name: my-network-map
spec:
  map:
    - source:
        namespace: <source-ns>
        name: <source-net>
      destination:
        # Instead of the default pod network (UDN primary), map to a
        # namespaced secondary NAD.
        namespace: <dest-ns>
        name: <secondary-nad-in-dest-ns>
        type: multus
```

Trade-off: the VM's primary interface is now a secondary network in Kubernetes terms. If the workload expects the VM's default route to go through this network, adjust the in-guest routing table accordingly.

**Migrate to the cluster's pod default network, not a UDN.** If the VM does not strictly need to be on the UDN, map the network to the plain `pod: {}` default. The toolkit's default-pod-network path is not affected by this bug:

```yaml
spec:
  map:
    - source:
        namespace: <source-ns>
        name: <source-net>
      destination:
        type: pod          # regular cluster pod default network
```

The VM runs on the default SDN; UDN integration has to wait for the upgrade.

### Do not

- Do not hand-edit the `virt-launcher` pod after migration to fix the annotation. The pod is reconciled by the VM operator and your change reverts in seconds, leaving the VM stuck on the next reconcile.
- Do not create a NAD named `default` in `kube-system` to satisfy the broken lookup. That namespace is managed by the CNI operator and manual resources there are unpredictable.

## Diagnostic Steps

Confirm the signature on the failing `virt-launcher`:

```bash
NS=<destination-vm-ns>
POD=$(kubectl -n "$NS" get pod -l kubevirt.io/domain=<vm-name> \
        -o jsonpath='{.items[0].metadata.name}')
kubectl -n "$NS" describe pod "$POD" | \
  grep -A4 -E 'Multus|tryLoadK8sPodDefaultNetwork|NetworkAttachment'
```

The `networkattachmentdefinition.k8s.cni.cncf.io "default" not found in namespace <ns>` line identifies this bug — note the `<ns>` the toolkit is pointing at (the CNI-operator namespace), not the VM's own namespace.

Read the pod's annotations to see the broken reference:

```bash
kubectl -n "$NS" get pod "$POD" \
  -o jsonpath='{.metadata.annotations}{"\n"}' | jq '."k8s.v1.cni.cncf.io/networks"'
```

A reference to `<cni-operator-ns>/default` (rather than `<vm-ns>/<udn-primary-nad-name>`) is the bug's footprint.

Check the destination cluster's actual NAD layout for comparison:

```bash
# The UDN's primary NAD sits in the VM's own namespace.
kubectl -n "$NS" get network-attachment-definitions
```

The expected default NAD for the UDN should appear in this listing. When the upgrade rolls out, the toolkit's annotation will correctly target this NAD name.

After applying the fix (or the workaround), re-run the plan and watch `virt-launcher` startup:

```bash
kubectl -n "$NS" get pod -l kubevirt.io/domain=<vm-name> -w
```

`Running` status and a subsequent `VMI Ready` condition confirms the network path works end-to-end.
