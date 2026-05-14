---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Java Pod PKIX SSL Handshake Failure to External HTTPS Endpoint — Custom JKS TrustStore Missing the Server's Issuer CA
## Issue

A Java application pod running on ACP fails to open an HTTPS connection to an external endpoint with a PKIX-class exception. Typical messages in the pod logs:

```
javax.net.ssl.SSLHandshakeException:
  PKIX path building failed:
  sun.security.provider.certpath.SunCertPathBuilderException:
    unable to find valid certification path to requested target
```

Or the wrapper variant from a Spring / RestTemplate application:

```
org.springframework.web.client.ResourceAccessException:
  I/O error on POST request for "https://api.partner.example.com/auth":
  PKIX path building failed
```

Symptoms that confirm the truststore is the problem rather than the network:

- `curl -v https://<endpoint>` from inside the same pod succeeds — i.e., the OS-level CA bundle works.
- The error happens on every connection attempt, not intermittently.
- The pod's environment exposes a `JAVA_TOOL_OPTIONS` (or `JAVA_OPTS`) variable that pins `-Djavax.net.ssl.trustStore=` to a JKS file mounted from a Kubernetes Secret.

## Root Cause

The JVM does not consult the operating-system CA bundle that `curl` and OpenSSL use. When `-Djavax.net.ssl.trustStore=<path>` is set, the JVM trusts **only** the certificate authorities present in that JKS keystore.

The customer-provided keystore is usually a curated, project-specific bundle (private internal CA, plus a small set of partner CAs). When the application starts calling a new external endpoint that is signed by a CA the JKS does not include, the handshake fails. The JVM cannot fall back to system trust — it has been told to ignore it.

To resolve, identify the issuer chain the failing endpoint presents and import the missing CA(s) into the JKS keystore that the JVM is using. Update the Secret. Restart the pod so the JVM re-reads the keystore.

## Resolution

### Step 1 — confirm the trust path is custom

```bash
NS=<app-namespace>
POD=$(kubectl -n "$NS" get pod -l app=<your-app> -o=jsonpath='{.items[0].metadata.name}')

# Find the truststore options the JVM was started with:
kubectl -n "$NS" exec "$POD" -- env | grep -E 'JAVA_TOOL_OPTIONS|JAVA_OPTS|trustStore'
```

Look for `-Djavax.net.ssl.trustStore=<path>` and `-Djavax.net.ssl.trustStorePassword=<pwd>` in the value. Note the path; it is usually mounted from a Secret. To find which Secret:

```bash
kubectl -n "$NS" get pod "$POD" -o=yaml | yq '.spec.containers[].volumeMounts[] | select(.mountPath as $p | env(MOUNT) | contains($p))'
# Or just inspect all volume mounts and match the path manually:
kubectl -n "$NS" get pod "$POD" -o=yaml | yq '.spec.containers[].volumeMounts'
kubectl -n "$NS" get pod "$POD" -o=yaml | yq '.spec.volumes'
```

The volume entry will show `secret: { secretName: <truststore-secret> }`.

### Step 2 — capture the issuer chain the failing endpoint actually presents

From the same pod (so you observe what the JVM sees on the wire), use `openssl s_client` against the failing endpoint:

```bash
ENDPOINT=api.partner.example.com:443

kubectl -n "$NS" exec -it "$POD" -- /bin/sh -c "
  openssl s_client -connect $ENDPOINT -servername ${ENDPOINT%:*} -showcerts < /dev/null 2>/dev/null |
    awk '/BEGIN CERT/,/END CERT/'
" > /tmp/server-chain.pem
```

`/tmp/server-chain.pem` now contains every cert the server sent — leaf, then any intermediates. Read each cert's subject and issuer to find the issuing chain:

```bash
csplit -z -f /tmp/cert- /tmp/server-chain.pem '/-----BEGIN CERTIFICATE-----/' '{*}'
for c in /tmp/cert-*; do
  echo "=== $c ==="
  openssl x509 -in "$c" -noout -subject -issuer
done
```

Walk the list. The leaf cert's issuer is the first intermediate; that intermediate's issuer is the next; the chain ends at a self-signed root. The root (and any intermediates the server does not send but the JVM also does not have) is what you need to import.

If the server only sends the leaf, fetch the intermediate from the issuer's published distribution point (CRL or AIA URL embedded in the leaf):

```bash
openssl x509 -in /tmp/cert-00 -noout -text | grep -A1 'CA Issuers'
# Then fetch the URL listed and convert to PEM if needed.
```

For widely used public roots (DigiCert, Let's Encrypt, GlobalSign), the issuer's site publishes the certs:

- DigiCert: <https://www.digicert.com/kb/digicert-root-certificates.htm>
- Let's Encrypt: <https://letsencrypt.org/certificates/>

Save the missing CA(s) to local files in PEM form, e.g., `/tmp/issuer-root.pem`, `/tmp/issuer-int.pem`.

### Step 3 — extract the current keystore from the Secret

```bash
SECRET=<truststore-secret>
KS_KEY=<key-name-in-secret>   # e.g. crm.cacerts.jks
PASSWORD=<storepass-from-JAVA_TOOL_OPTIONS>

kubectl -n "$NS" get secret "$SECRET" -o=jsonpath="{.data.$KS_KEY}" | base64 -d > /tmp/truststore.jks
```

Verify the JKS is intact:

```bash
keytool -list -keystore /tmp/truststore.jks -storepass "$PASSWORD" | head -20
```

### Step 4 — import the missing CA(s)

Add each missing CA to the keystore. Use a unique alias per cert; reusing an existing alias overwrites the previous entry:

```bash
keytool -import \
  -alias my-issuer-root \
  -file /tmp/issuer-root.pem \
  -keystore /tmp/truststore.jks \
  -storepass "$PASSWORD" \
  -noprompt

keytool -import \
  -alias my-issuer-int \
  -file /tmp/issuer-int.pem \
  -keystore /tmp/truststore.jks \
  -storepass "$PASSWORD" \
  -noprompt
```

Verify the alias is now present:

```bash
keytool -list -keystore /tmp/truststore.jks -storepass "$PASSWORD" | grep my-issuer
```

### Step 5 — push the updated JKS back to the Secret

```bash
kubectl -n "$NS" create secret generic "$SECRET" \
  --from-file="$KS_KEY=/tmp/truststore.jks" \
  --dry-run=client -o=yaml | \
  kubectl -n "$NS" apply -f -
```

`--dry-run=client | apply -f -` is the safe pattern: it preserves any other keys in the Secret while overwriting only the truststore key. If the Secret has no other keys, the simpler form works:

```bash
kubectl -n "$NS" patch secret "$SECRET" --type=merge -p \
  "{\"data\":{\"$KS_KEY\":\"$(base64 -w0 /tmp/truststore.jks)\"}}"
```

### Step 6 — restart the pod so the JVM re-reads the truststore

The JVM reads the truststore at start-up. Updating the Secret while the pod is running has no effect; the pod sees the change only after a restart.

```bash
# If the workload is a Deployment:
kubectl -n "$NS" rollout restart deploy/<deployment-name>

# Or simply delete the pod (if it is owned by a Deployment / StatefulSet that will recreate it):
kubectl -n "$NS" delete pod "$POD"
```

Wait for the new pod to be Ready:

```bash
kubectl -n "$NS" rollout status deploy/<deployment-name>
```

### Step 7 — verify the handshake

Trigger the same code path (a request that previously failed). Check the pod logs:

```bash
kubectl -n "$NS" logs -l app=<your-app> --tail=100 | grep -E 'PKIX|SSL|handshake'
```

Expected: no PKIX exception. The application's response succeeds.

For a quick low-level check from inside the pod, use the JDK's `keytool -printcert -sslserver`:

```bash
kubectl -n "$NS" exec -it "$POD" -- \
  keytool -printcert -sslserver "$ENDPOINT" -storepass "$PASSWORD" -keystore /path/to/jks
```

If `keytool -printcert -sslserver` succeeds, the JVM trust path is healthy.

### Step 8 — codify the trust source

Manual `keytool` updates are easy to forget on the next CA rotation. Two longer-term patterns:

- **Build the truststore in CI**: define the trusted set in a Git repo (one PEM file per CA), have CI build the JKS and push to the cluster (cert-manager + a small operator, or a one-shot Job in the namespace). Rotation becomes a PR.
- **Mount the OS bundle directly**: if your application can use the system trust (Spring Boot 3+ supports `-Djavax.net.ssl.trustStoreType=system`, OpenJDK 11+ supports the system PKCS#11 store), prefer that and let the platform manage CA rotations.

## Diagnostic Steps

Confirm the symptom is JVM-trust and not network:

```bash
# OS-level (curl uses /etc/pki or /etc/ssl):
kubectl -n "$NS" exec "$POD" -- curl -v https://<endpoint> 2>&1 | head -30

# JVM-level via a tiny Java check (if a JRE is in the image):
kubectl -n "$NS" exec "$POD" -- jrunscript -e "
  new java.net.URL('https://<endpoint>/').openStream().close();
"
```

`curl` succeeds + `jrunscript` fails with PKIX → confirmed.

List the CAs the JVM currently trusts (the ones in the JKS):

```bash
kubectl -n "$NS" exec "$POD" -- \
  keytool -list -storepass "$PASSWORD" -keystore <path-to-jks> | \
  grep -E '^[^,]+,.*trustedCertEntry'
```

Compare with the chain captured in Step 2 — any cert in the server chain that does not appear here is the missing CA.

If the JKS is right but the JVM still rejects, check whether the JVM is actually loading that file:

```bash
kubectl -n "$NS" exec "$POD" -- jcmd 1 VM.system_properties | grep ssl.trustStore
```

The JVM's runtime view of `javax.net.ssl.trustStore` should match the path mounted from the Secret. If it does not, an earlier `JAVA_TOOL_OPTIONS` is being overridden by a later one in the entrypoint or a wrapper script.
