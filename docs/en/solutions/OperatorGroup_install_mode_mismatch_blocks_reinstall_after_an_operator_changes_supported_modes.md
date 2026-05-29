---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# OperatorGroup install-mode mismatch blocks reinstall after an operator changes supported modes

## Issue

Installing or reinstalling an OperatorBundle on ACP fails. The OLM
controllers (`olm-operator` and `catalog-operator`) that decide
whether a CSV may install run in the `cpaas-system` namespace on
this platform, and a Subscription whose CSV cannot find a matching
OperatorGroup stays stuck in `ResolutionFailed` /
`ConstraintsNotSatisfiable` without ever installing a CSV.
The error surfaces on the Subscription as:

```text
The OperatorGroup in the <ns> namespace does not support the
<X> installation mode. Select a different installation mode
or namespace.
```

## Root Cause

OLM matches a CSV to an OperatorGroup by install mode. The CSV
declares its supported modes via `spec.installModes` — a list of
`{type, supported}` entries. The OperatorGroup picks one
implicitly by `spec.targetNamespaces`:

| `targetNamespaces` value | implied mode |
|---|---|
| `[<og-ns>]` (own ns) | `OwnNamespace` |
| `[<other-ns>]` (different ns) | `SingleNamespace` |
| `[ns1, ns2, ...]` | `MultiNamespace` |
| absent / `[]` | `AllNamespaces` |

If the operator's `installModes` set shrinks between releases (e.g.
the new CSV drops support for `SingleNamespace`) and an OperatorGroup
created under the old release still asks for that mode, the new CSV
no longer has a matching supported entry and OLM keeps the
Subscription stuck in the resolution-failed state described above.
This is the documented upstream OLM matching behavior; it has not
been directly reproduced on ACP by a deliberate installModes-shrink
experiment, so treat the specific shrink scenario as the most common
trigger of the surface symptom rather than the only one.

This applies to any ACP OperatorBundle (kubevirt-operator,
topolvm-operator, asm-operator, etc.). It does **not** affect ACP
plugins on the ModulePlugin path (e.g. `logcenter` / `logagent` /
`logclickhouse`), which do not use OperatorGroups.

## Resolution

Delete the stale OperatorGroup, then re-create one whose
`spec.targetNamespaces` shape maps to a mode that the new CSV's
`installModes` lists as `supported: true`. On ACP, OLM does
**not** auto-recreate the OperatorGroup for you — the install path
(for example the `install-acp-operator` flow) creates the OG
explicitly with a `targetNamespaces` value chosen by the caller, so
the namespace stays OG-less until you re-apply one. After the
matching OG exists, the existing Subscription re-resolves on the
next reconcile and OLM picks up a compatible CSV.

```bash
# 1. Find the OperatorGroup in the operator's namespace
kubectl get og -n <operator-ns>

# 2. Delete the stale one
kubectl delete og -n <operator-ns> <og-name>

# 3. Re-create an OG whose targetNamespaces matches a supported mode
#    on the new CSV. Pick the shape from the table in ## Root Cause.
cat <<'YAML' | kubectl apply -f -
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: <og-name>
  namespace: <operator-ns>
spec:
  targetNamespaces:
    - <operator-ns>   # OwnNamespace; or drop the whole spec for AllNamespaces
YAML

# 4. The existing Subscription re-resolves on the next reconcile.
```

> Scope the delete + re-create to the failing operator's namespace
> only. Don't touch OperatorGroups in unrelated namespaces — other
> operators share them.

## Diagnostic Steps

Compare the modes the failing CSV actually supports against the mode
the existing OG asks for. The first command lists the CSV's
`installModes` entries; the second prints the OG's
`targetNamespaces` shape — together they tell you whether the
mismatch in the error message reflects a real shape disagreement on
this cluster.

```bash
# Modes the failing CSV actually supports
kubectl get csv -n <ns> <csv-name> -o jsonpath='{.spec.installModes}'

# Mode the existing OG asks for
kubectl get og -n <ns> <og-name> -o jsonpath='{.spec.targetNamespaces}{"\n"}'
```

If the OG's `targetNamespaces` shape doesn't correspond to a
`supported: true` entry in the CSV's `installModes`, that is the
mismatch.

The Subscription's status carries the error verbatim, which is the
quickest way to confirm this issue and rule out other OLM
resolution failures.

```bash
kubectl get sub -n <ns> <sub-name> -o jsonpath='{.status.conditions}' | jq
```

A condition with `reason: ConstraintsNotSatisfiable` plus a message
containing "does not support the X installation mode" confirms this
issue rather than some other OLM resolution failure (for example a
missing or unhealthy CatalogSource).
