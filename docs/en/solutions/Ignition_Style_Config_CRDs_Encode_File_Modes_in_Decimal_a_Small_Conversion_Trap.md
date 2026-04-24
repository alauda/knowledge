---
kind:
   - Information
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Overview

Kubernetes CRDs that provision files onto a node (the Ignition-format configs that the node OS consumes at boot, or higher-level CRs that wrap Ignition for reconciled delivery) specify each file's permission mode as a **decimal integer**. That is surprising because every Linux tool a cluster operator is fluent in — `chmod`, `stat -c %a`, `ls -l`'s mode column — prints the mode in **octal**. A `0644`-style value pasted from a shell into the CR's `storage.files.mode` field does not produce the expected permissions on the target file.

A symptom of the mismatch: a ConfigMap or file intended to be world-unreadable ends up with liberal permissions (or the reverse) because the number submitted in the CR was read as decimal by the reconciler and as octal by nobody.

## Root Cause

Ignition's schema (JSON-based) encodes numeric fields as standard base-10 integers. A file mode field defined as a JSON number therefore carries the decimal representation of the intended permission bit pattern. The Ignition reconciler reads the number, converts it to the 12-bit mode the kernel expects, and applies the file. Nothing in this path reinterprets a leading zero as the octal marker it would be in a shell literal.

Linux tools, conversely, have always spoken octal for file modes. `chmod 0755 file` treats the digits as base-8 so the underlying mode integer becomes `493` decimal — but when the same idea is expressed in an Ignition-style CR, the number written is `493` directly (not `0755`). A literal `0755` pasted into a decimal field is interpreted as `755` decimal — which is a valid 12-bit mode, but a completely unrelated one (`0001363` octal = `u=rwx,g=rwx,o=rwx` plus sticky and setuid bits, not the `u=rwx,g=rx,o=rx` the operator wanted).

The mismatch is not a bug; it is a consequence of JSON numbers being decimal by definition. But because the human is fluent in one representation and the CR is authored in the other, the value round-trips incorrectly unless the conversion is done explicitly.

## Resolution

Do the conversion at write-time. Keep a small lookup on hand for the common modes, and validate the applied mode on the target file before trusting that the CR was authored correctly.

### Common mode conversion table

| Octal (what `chmod`/`ls` show) | Decimal (what the CR stores) | Meaning |
|---|---|---|
| `0400` | 256 | owner read only |
| `0600` | 384 | owner read/write |
| `0640` | 416 | owner read/write, group read |
| `0644` | 420 | owner read/write, group+other read |
| `0700` | 448 | owner read/write/execute |
| `0744` | 484 | owner read/write/execute, group+other read |
| `0750` | 488 | owner rwx, group rx |
| `0755` | 493 | owner rwx, group+other rx |
| `0770` | 504 | owner rwx, group rwx |
| `0777` | 511 | owner rwx, group rwx, other rwx |

### Converting on the fly

The conversion is `int("<octal-string>", 8)`. A one-liner in any shell:

```bash
python3 -c 'import sys; print(int(sys.argv[1], 8))' 0755
# 493
```

Or in pure shell:

```bash
printf '%d\n' 0755
# 493
```

Use the output in the CR's `mode:` field. Confirm at render time that the number is what you expect — a CR with `mode: 420` is `0644`, and a CR with `mode: 0420` is `272` decimal (`u=r-x,g=--,o=-w-`), which almost certainly is not intended.

### Validate the applied file

After the CR reconciles to a node, confirm the resulting file's permissions match the intent. Shell out through a debug pod:

```bash
kubectl debug node/<node> --image=busybox -- \
  chroot /host stat -c '%n %a %u:%g' /etc/<your-file>
# /etc/<your-file> 644 0:0
```

The `%a` format prints octal. A mismatch between the expected octal mode and the observed octal mode means the decimal in the CR was wrong — go back to the conversion.

### Authoring workflow

If multiple files are being provisioned through the same CR, keep a comment next to each `mode:` line noting the intended octal so code review catches the mistake:

```yaml
storage:
  files:
    - path: /etc/my-config.conf
      mode: 420            # 0644 (owner rw, group+other r)
      contents:
        source: data:text/plain;base64,...
    - path: /etc/my-secret.key
      mode: 384            # 0600 (owner rw only)
      contents:
        source: data:text/plain;base64,...
```

The comment does not affect behaviour, but it drops the "pop quiz: what permissions will this file actually have?" cost to zero for every future reader.

## Diagnostic Steps

Given an existing CR whose file modes are suspected wrong, compare what the CR declares against what actually ended up on the node:

```bash
# Dump the relevant CR and pretty-print file mode entries in both bases.
kubectl get <your-cr-kind> <name> -o json | \
  jq -r '.spec.config.storage.files[] | "\(.path)\t\(.mode)\t(0\( .mode | tostring | ("o" + .))"' 2>/dev/null || \
kubectl get <your-cr-kind> <name> -o json | \
  jq -r '.spec.config.storage.files[]?
         | "\(.path)\tdecimal=\(.mode)\toctal=\(.mode | tonumber | . as $n | "0" + (($n/512 | floor) | tostring) + (($n%512/64 | floor) | tostring) + (($n%64/8 | floor) | tostring) + (($n%8) | tostring))"'
```

Compare each row's octal column against what the node reports:

```bash
kubectl debug node/<node> --image=busybox -- \
  chroot /host stat -c '%n %a' /etc/<path>
```

Any mismatch points at an incorrect decimal in the CR. The fix is to re-author the field with the correct decimal converted from the intended octal, re-apply the CR, and let the reconciler roll the change through the node.

If several CRs are suspected wrong, extract the list of declared modes and eyeball values that look like a pasted octal literal — any decimal that would be visually mistaken for a common octal (420 looks like `0644`, 493 looks like `0755`, 511 looks like `0777`) is correct; but any mode that *visually reads* as a valid Linux octal (e.g. 755, 644, 777 as decimals) is almost always a mistake.
