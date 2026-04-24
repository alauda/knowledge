---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

All Vector collector pods managed by the cluster log forwarder enter `CrashLoopBackOff` immediately after start. The collector container logs show Vector itself rejecting its configuration file at parse time:

```text
Creating the directory used for persisting Vector state /var/lib/vector/<ns>/collector
Starting Vector process...
ERROR vector::cli: Configuration error.
error=TOML parse error at line 763, column 43
  |
  763 | auth.access_key_id = "XXXXXXXXXXXXXXXXXXXXX
  |                                           ^
  invalid basic string
```

No log line reaches the CloudWatch output (or whichever output the secret is attached to). Upstream queries show a growing backpressure gap as the collector never actually starts the pipeline.

## Root Cause

The log forwarder renders Vector's `vector.toml` from the `ClusterLogForwarder` CR. Any credential referenced from a `Secret` (AWS access key id, AWS secret access key, TLS material, bearer tokens) is substituted into the TOML at the appropriate key. The substitution is a literal byte copy — Vector then parses the file as TOML.

TOML's "basic string" form does not accept raw control characters. If the Secret value contains a trailing newline, a hidden CR (`\r`), or any non-printable byte, the string the renderer emits looks valid to the shell that copied it in but is invalid TOML. Vector bails at parse time and the collector pod dies before it can forward a single record.

The two frequent sources of invisible characters in Secrets:

1. `echo` or clipboard paste producing a trailing `\n` — especially common on Linux/macOS workflows where `echo -n` is forgotten.
2. File-based extraction on Windows producing `\r\n` line endings — the CR travels into the Secret data and breaks the basic string the same way.

The fix is to re-create the Secret without the stray byte. The forwarder itself is behaving correctly: it copies exactly what it was given.

## Resolution

### Preferred path — ACP Logging Service

The log forwarder shipped with the ACP Logging Service follows the same pattern: credentials live in Secrets in the collector namespace, and Secret values are rendered verbatim into the Vector configuration.

1. Identify the offending Secret. Inspect the `ClusterLogForwarder` CR and locate the output whose credentials are referenced:

   ```bash
   ns=<collector-ns>
   cr=<forwarder-name>
   kubectl -n "$ns" get clusterlogforwarder "$cr" -o yaml \
     | grep -A4 -E 'authentication|secretName|keyId|keySecret'
   ```

   For a CloudWatch output the reference looks like:

   ```yaml
   outputs:
     - name: cw
       type: cloudwatch
       cloudwatch:
         authentication:
           type: awsAccessKey
           awsAccessKey:
             keyId:
               secretName: cw-secret
               key: aws_access_key_id
             keySecret:
               secretName: cw-secret
               key: aws_secret_access_key
   ```

   Note the `secretName` and the inner `key` — this is the value you need to regenerate.

2. Regenerate the Secret with a clean payload. The safe pattern is to avoid any shell substitution that introduces a newline:

   ```bash
   kubectl -n "$ns" delete secret cw-secret

   kubectl -n "$ns" create secret generic cw-secret \
     --from-literal=aws_access_key_id='<ACCESS_KEY_ID>' \
     --from-literal=aws_secret_access_key='<SECRET_ACCESS_KEY>'
   ```

   `--from-literal=` reads the value as a single string and does not append a newline. If you must build the Secret from a file, strip `\r` and trailing `\n` first:

   ```bash
   printf %s "<ACCESS_KEY_ID>"     > /tmp/aki
   printf %s "<SECRET_ACCESS_KEY>" > /tmp/sak
   kubectl -n "$ns" create secret generic cw-secret \
     --from-file=aws_access_key_id=/tmp/aki \
     --from-file=aws_secret_access_key=/tmp/sak
   rm -f /tmp/aki /tmp/sak
   ```

3. Restart the collector pods so they pick up the new Secret and re-render the configuration. If the DaemonSet does not roll automatically:

   ```bash
   kubectl -n "$ns" delete pod -l app.kubernetes.io/component=collector
   ```

   New collector pods should reach `Running` and stay up. The TOML parse error disappears from the log; the `vector::cli` banner is followed by the normal `started` / `sinks` initialization messages.

### OSS fallback — raw Vector

If the deployment runs Vector directly (not via a cluster log forwarder), the same root cause applies: the Secret projected into the Vector config must not contain control characters. Verify the Secret's rendered value with `kubectl get secret ... -o jsonpath='{.data.<key>}' | base64 -d | xxd | tail` and confirm the last byte is the last meaningful character — no `0a` (LF) or `0d` (CR) trailing.

## Diagnostic Steps

1. Confirm all collector pods share the same failure mode:

   ```bash
   ns=<collector-ns>
   kubectl -n "$ns" get pod -l app.kubernetes.io/component=collector
   ```

   `READY 0/1` plus restart counts incrementing in lockstep across the DaemonSet means it is a config issue, not a per-node problem.

2. Read the Vector config error from one pod:

   ```bash
   pod=$(kubectl -n "$ns" get pod -l app.kubernetes.io/component=collector \
           -o jsonpath='{.items[0].metadata.name}')
   kubectl -n "$ns" logs "$pod" --previous --tail=100 \
     | grep -A5 'TOML parse error'
   ```

   The `line 763, column 43` / `invalid basic string` signature pins the failure at the moment Vector parses the Secret-derived string.

3. Inspect the Secret bytes directly (do not trust `kubectl get secret -o yaml`, which will display a base64-encoded form that hides the trailing newline):

   ```bash
   kubectl -n "$ns" get secret <secret-name> -o jsonpath='{.data.aws_access_key_id}' \
     | base64 -d | xxd
   ```

   A trailing `0a` (newline) or `0d 0a` (CRLF) on the last line is the smoking gun. After regenerating the Secret with a clean value, the same command should end exactly at the last character of the key.

4. After restart, confirm the collector started cleanly:

   ```bash
   kubectl -n "$ns" logs -l app.kubernetes.io/component=collector --tail=20 \
     | grep -E 'started|sinks|sources' | head
   ```

If the TOML error re-appears after Secret replacement, the invisible byte is coming from a different Secret referenced in the same output (for example the TLS `ca-bundle` or the session token on an STS-based auth path). Repeat the `base64 -d | xxd` check on every Secret the offending output references.
