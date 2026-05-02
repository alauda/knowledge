---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Vector — used as the cluster's node-side log collector — keeps track of which log file it is reading and how far into the file it has gone via a *checkpoint* file. With the `checksum` fingerprint strategy, Vector identifies a file by hashing its first line(s) (or first N bytes). The hash is what survives across renames and rotations: when Vector boots, it walks every file in scope, recomputes the fingerprint, and rejoins the read at the saved offset for the file whose fingerprint matches.

The failure modes that bring this article into play:

- Vector starts re-reading large files from the beginning after a restart, even though they had not been rotated.
- Application logs appear duplicated downstream.
- Operators want to confirm that the `first_lines_checksum` recorded in the checkpoint actually matches what is on disk *now*, before declaring "Vector lost the file".

This article describes a deterministic way to recompute the fingerprint by hand and compare it to the checkpoint.

## Resolution

The fingerprint Vector uses for `strategy: checksum` is **CRC-64-ECMA-182** with parameters `width=64, poly=0x42F0E1EBA9EA3693, init=0, refin=false, refout=false, xorout=0`. Recomputing it for the first lines (or first N bytes) of a file gives the value that should appear in `first_lines_checksum`.

### 1. Locate the checkpoint

Vector stores its checkpoint database under `/var/lib/vector/<deployment-id>/<pipeline-id>/`. The exact path depends on how the cluster's log-collector chart names its pipelines; a typical path looks like:

```text
/var/lib/vector/cluster-logging/vector-clf/checkpoints.json
```

The file holds one entry per source-file Vector is tracking:

```json
{
  "version": "1",
  "checkpoints": [
    {
      "fingerprint": { "first_lines_checksum": 15164445669303451960 },
      "position": 723597,
      "modified": "2026-04-22T03:00:15.168545469Z"
    }
  ]
}
```

Pick out the `first_lines_checksum` for the file you want to verify and the `position` (byte offset) Vector last persisted.

### 2. Recompute the checksum from the file

The Python below mirrors Vector's bit-by-bit CRC-64-ECMA-182 implementation with the same parameters. Hand it the file path, the number of lines to fingerprint (Vector defaults to 1), and the number of leading bytes to ignore (Vector's `ignored_header_bytes`, default 0). The two parameters must match what Vector's source config has, otherwise the recomputed hash will not match.

```python
#!/usr/bin/env python3
"""Recompute Vector's first_lines_checksum (CRC-64-ECMA-182) for a log file."""
import argparse
import gzip
import sys

POLY   = 0x42F0E1EBA9EA3693
INIT   = 0
XOROUT = 0


def crc64_ecma_182(data: bytes) -> int:
    """Bit-by-bit CRC-64-ECMA-182 with refin=false, refout=false."""
    crc = INIT
    for byte in data:
        crc ^= byte << 56
        for _ in range(8):
            if crc & (1 << 63):
                crc = ((crc << 1) ^ POLY) & ((1 << 64) - 1)
            else:
                crc = (crc << 1) & ((1 << 64) - 1)
    return crc ^ XOROUT


def first_lines(path: str, lines: int, ignored_header_bytes: int) -> bytes:
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rb") as f:
        if ignored_header_bytes:
            f.read(ignored_header_bytes)
        out = bytearray()
        for _ in range(lines):
            line = f.readline()
            if not line:
                break
            out.extend(line)
        return bytes(out)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("file")
    p.add_argument("--lines", type=int, default=1,
                   help="number of leading lines to hash (Vector default: 1)")
    p.add_argument("--ignored-header-bytes", type=int, default=0,
                   help="leading bytes to skip before hashing (default: 0)")
    args = p.parse_args()
    data = first_lines(args.file, args.lines, args.ignored_header_bytes)
    print(crc64_ecma_182(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run it on the file the checkpoint claims to track:

```bash
python3 calculate_checksum.py /var/log/pods/<ns>_<pod>_<uid>/<container>/0.log
```

If the printed value matches `first_lines_checksum` from the checkpoint, the checkpoint is valid: Vector is correctly identifying this file. If it does not match, the file's first line has changed since the checkpoint was written — a rotation that did not move the inode, a truncation, or an editor-induced change — and Vector treated it as a new file, which is why it re-read from the beginning.

### 3. Decide what the mismatch means

A mismatch is *expected* when:

- The file was rotated (moved aside, replaced by a fresh file with the same name). Vector should have created a new checkpoint entry for the new inode; if it did not, look at the rotation strategy in the source config (`oldest_first`, `read_from`).
- The application's first line includes a timestamp that changes on every restart. In that case, raise `lines` so the fingerprint covers a more stable region, or switch to the `device_and_inode` fingerprint strategy.

A mismatch is *unexpected* and worth a deeper look when:

- The file has not been rotated and the first line should be stable. Sample multiple Vector pods on the same node and the same source — if one matches and another does not, the diverging pod has a stale checkpoint; delete `checkpoints.json` for that pipeline (Vector will re-fingerprint everything on the next start) and watch for repeats.

### 4. (Optional) cross-check the position

A valid fingerprint plus a `position` greater than the file's current size means Vector overshot — it had read past the file's tail before the file was truncated. In that case, the next read will return zero bytes and Vector will sit idle until new lines append. Recover by deleting the checkpoint entry; the next read picks up cleanly from the live tail (`read_from: end`) or from the start (`read_from: beginning`) depending on the source config.

## Diagnostic Steps

1. Confirm the checkpoint exists and is the right one for the file in question. Multiple Vector pipelines write to different directories under `/var/lib/vector/`; verify you are reading the pipeline's own checkpoint and not another agent's.

2. Capture the source config for the pipeline. The `lines` and `ignored_header_bytes` you pass to the script must come from this config — defaulting them to 1 and 0 is correct only if the config does not override them:

   ```bash
   kubectl get configmap -n <log-collector-ns> <vector-config> \
     -o jsonpath='{.data.vector\.toml}' \
     | grep -E 'fingerprint|lines|ignored_header_bytes'
   ```

3. Run the script on a known-good file (one that Vector is currently tailing without trouble) and confirm the script's output matches that file's checkpoint entry. That validates the script in your environment before you trust its output for the suspect file.

4. If the suspect file repeatedly desyncs after each rotation, raise `lines` or move to a fingerprint strategy that does not depend on textual content (`device_and_inode`). The CRC-64 itself is fine; the input you are hashing is the question.
