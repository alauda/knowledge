---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500459
---

# Java pod PKIX SSL handshake failure due to custom JKS truststore missing intermediate CA on ACP

## Issue

On Alauda Container Platform (verified on ACP base install package `v4.3.5` with Kubernetes `v1.34.5`), a Java workload pod fails its outbound TLS handshake to an external HTTPS endpoint and the JVM stack trace surfaces `javax.net.ssl.SSLHandshakeException` wrapping `sun.security.provider.certpath.SunCertPathBuilderException` with the message `unable to find valid certification path to requested target`. This wording is emitted by the JDK's default PKIX certificate-path builder when no trust anchor in the JVM's active TrustStore can chain to the peer's server certificate, and the wording is identical on any JVM regardless of the orchestrator.

The same pod can reach the same endpoint with `curl -v` from inside its container, so DNS resolution, egress, and any HTTP(S) proxy hop are not the failure surface — the break is isolated to the JVM's TrustStore configuration. The JVM in question has been started with the system property `-Djavax.net.ssl.trustStore=<path>` (typically passed through `JAVA_TOOL_OPTIONS` or `JAVA_OPTS`), which directs JSSE to use that file as the sole keystore for peer-certificate validation and to ignore the JRE's default `cacerts` and the OS CA bundle. ACP does not inject a JVM or rewrite this property — JSSE reads the value at startup from inside the container's JRE.

## Root Cause

The custom JKS file referenced by `-Djavax.net.ssl.trustStore` does not contain the full CA chain needed to validate the target endpoint's server certificate. Concretely, the JKS is missing the intermediate CA certificate that signed the server cert and/or the corresponding public root CA — for example, an endpoint served by a `DigiCert TLS RSA SHA256 2020 CA1` intermediate chaining to a `DigiCert Global Root` requires both the intermediate and the root to be present as trusted entries when the server does not present the full chain at handshake time.

Because JSSE consults only the keystore named by `-Djavax.net.ssl.trustStore` and ignores both the JRE's bundled `cacerts` and the node's OS trust bundle, a CA that is missing from this custom JKS is not made up for by anything the platform or the base image ships. The JVM cannot construct a chain back to a known trust anchor, and PKIX validation aborts with the `unable to find valid certification path to requested target` message.

## Resolution

Add the missing public CA certificate(s) — the root CA, plus the intermediate CA when the server does not present the full chain — to the JKS file used by the JVM, then redeliver the updated JKS into the pod and restart the workload so the JVM re-reads the TrustStore at startup.

The JKS file is delivered into the pod through a Kubernetes Secret mounted as a volume; the Secret's `data.<jks-key>` entry holds the binary JKS (base64-encoded), and the pod references it via `spec.volumes[].secret.secretName` with a `spec.containers[].volumeMounts[].mountPath` that matches the path passed to `-Djavax.net.ssl.trustStore`. This is the standard Kubernetes Secret-as-volume primitive on ACP — no platform-specific mount shape is required. Updating the JKS therefore means re-writing the Secret's `data.<jks-key>` entry with the new JKS file content.

Read the current JKS out of the Secret to a local working copy on a workstation that has `kubectl` and a JDK available. The `kubectl get secret ... -o jsonpath` form returns the base64-encoded value of the chosen data key, which `base64 -d` decodes into the binary JKS on disk:

```bash
kubectl get secret <secret-name> -n <namespace> \
    -o jsonpath='{.data.<jks-key>}' | base64 -d > truststore.jks
```

Append the missing root CA and, when needed, the missing intermediate CA to the local JKS using the standard JDK `keytool -import` invocation. The flags `-alias`, `-file`, `-keystore`, `-storepass`, and `-noprompt` are standard JDK CLI and behave identically inside or outside the cluster:

```bash
keytool -import -trustcacerts -noprompt \
    -alias digicert-global-root \
    -file digicert-global-root.pem \
    -keystore truststore.jks \
    -storepass <storepass>

keytool -import -trustcacerts -noprompt \
    -alias digicert-intermediate \
    -file digicert-intermediate.pem \
    -keystore truststore.jks \
    -storepass <storepass>
```

Confirm the new aliases are present in the JKS before pushing the file back into the Secret:

```bash
keytool -list -v -keystore truststore.jks -storepass <storepass> \
    | grep -iE 'Alias name|Owner|SHA-?256'
```

Re-write the Secret's `data.<jks-key>` entry with the updated JKS file. The portable form on ACP is to render the new Secret manifest with `kubectl create secret generic --dry-run=client -o yaml` and apply it with `kubectl replace`, which atomically swaps the data key without removing other keys when the manifest is constructed to include them:

```bash
kubectl create secret generic <secret-name> \
    --from-file=<jks-key>=truststore.jks \
    --dry-run=client -o yaml \
    | kubectl replace -n <namespace> -f -
```

Restart the Java workload pod so the JVM re-reads the TrustStore on startup. The JVM loads the file named by `-Djavax.net.ssl.trustStore` once during initialization, so a running pod will not pick up the new contents until its JVM process is restarted; for a Deployment-managed workload, deleting the pod (or rolling the Deployment) is sufficient because the controller respawns it and the Secret volume re-projects with the updated content:

```bash
kubectl delete pod <java-pod-name> -n <namespace>
# or, for a Deployment-managed workload:
kubectl rollout restart deployment/<deployment-name> -n <namespace>
```

After the new pod is Running, repeat the original outbound TLS call; the JVM now finds the missing CA in its active TrustStore and PKIX completes without the `unable to find valid certification path to requested target` error.

## Diagnostic Steps

Confirm first that the failure is isolated to the JVM's TrustStore rather than to network connectivity. From inside the same pod, run `curl -v` against the failing endpoint and compare against the Java client behavior; when `curl` completes the TLS handshake and the Java application still raises PKIX `unable to find valid certification path to requested target`, the break is on the JVM side and not on the network path:

```bash
kubectl exec -it -n <namespace> <java-pod-name> -- \
    curl -v https://<external-endpoint>/
```

Identify the JKS file path that JSSE is actually using. The JVM logs its system properties at startup, and grepping the pod's stdout for the literal token `-Djavax.net.ssl.trustStore` reveals the path that JSSE is reading (commonly visible inside the `Picked up JAVA_TOOL_OPTIONS:` banner emitted by OpenJDK at startup):

```bash
kubectl logs -n <namespace> <java-pod-name> \
    | grep -i 'javax.net.ssl.trustStore'
```

Cross-check that the path resolves to a Secret-backed volume by reading the pod's `spec.volumes[]` and `spec.containers[].volumeMounts[]`; the `mountPath` that matches the JKS path indicates the Secret carrying the keystore:

```bash
kubectl get pod <java-pod-name> -n <namespace> -o yaml \
    | grep -E 'secretName:|mountPath:|name:' -A1
```

List the keystore entries currently trusted by the JVM. Open a shell inside the pod's container with `kubectl exec -it` (the generic Kubernetes verb for the same operation), then run `keytool -list -v` against the JKS path identified above and filter to look for the CA in question — for example, the public root or intermediate that the target endpoint's server certificate chains to:

```bash
kubectl exec -it -n <namespace> <java-pod-name> -- /bin/sh
# inside the container:
keytool -list -v -keystore <jks-path> -storepass <storepass> \
    | grep -iE 'Alias name|Owner|Issuer' \
    | grep -i '<CA-name-fragment>'
```

If the expected root or intermediate CA does not appear in the JKS listing, the diagnosis is confirmed: the active TrustStore does not contain the trust anchor needed to chain to the peer certificate, and the resolution above (import the missing CA, replace the Secret, restart the pod) applies.
