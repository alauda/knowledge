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

Installing or reinstalling an OperatorBundle on ACP fails with:

```text
The OperatorGroup in the <ns> namespace does not support the
<X> installation mode. Select a different installation mode
or namespace.
```

The Subscription stays in `ResolutionFailed` / `ConstraintsNotSatisfiable`
and no CSV ever installs.

## Root Cause

OLM matches a CSV to an OperatorGroup by install mode. The CSV
declares its supported modes via `spec.installModes`; the
OperatorGroup picks one implicitly by `spec.targetNamespaces`:

| `targetNamespaces` value | implied mode |
|---|---|
| `[<og-ns>]` (own ns) | `OwnNamespace` |
| `[<other-ns>]` (different ns) | `SingleNamespace` |
| `[ns1, ns2, ...]` | `MultiNamespace` |
| absent / `[]` | `AllNamespaces` |

If the operator's `installModes` set shrinks between releases (e.g.
drops `SingleNamespace`) and an OperatorGroup created under the old
release still asks for that mode, the new CSV refuses to bind and
resolution fails.

This applies to any ACP OperatorBundle (kubevirt-operator,
topolvm-operator, asm-operator, etc.). It does **not** affect ACP
plugins on the ModulePlugin path (e.g. `logcenter` / `logagent` /
`logclickhouse`), which do not use OperatorGroups.

## Resolution

Delete the stale OperatorGroup. The next install attempt re-creates
one with a mode that matches the new CSV (upstream OLM behavior;
verify after deleting).

```bash
# 1. Find the OperatorGroup in the operator's namespace
kubectl get og -n <operator-ns>

# 2. Delete it
kubectl delete og -n <operator-ns> <og-name>

# 3. Re-trigger install — re-create the Subscription, or let the
#    Marketplace UI redo it. The existing Subscription rebinds.
```

> Scope the delete to the failing operator's namespace only. Don't
> touch OperatorGroups in unrelated namespaces — other operators
> share them.

## Diagnostic Steps

```bash
# Modes the failing CSV actually supports
kubectl get csv -n <ns> <csv-name> -o jsonpath='{.spec.installModes}'

# Mode the existing OG asks for
kubectl get og -n <ns> <og-name> -o jsonpath='{.spec.targetNamespaces}{"\n"}'
```

If the OG's `targetNamespaces` shape doesn't correspond to a
`supported: true` entry in the CSV's `installModes`, that is the
mismatch.

The Subscription's status carries the error verbatim:

```bash
kubectl get sub -n <ns> <sub-name> -o jsonpath='{.status.conditions}' | jq
```

`reason: ConstraintsNotSatisfiable` plus "does not support the X
installation mode" in `message` confirms this issue (and not some
other OLM resolution failure).
