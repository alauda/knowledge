---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Recovering a PostgreSQL StatefulSet pod blocked by wrong data-directory ownership

## Issue

On Alauda Container Platform (Kubernetes v1.34.5), a PostgreSQL container that runs as part of a StatefulSet and persists its data directory onto a PersistentVolumeClaim can refuse to start when the directory on the underlying volume is not owned by the OS user the postgres process runs as. The standard postgres image refuses to start when the data directory's ownership does not match the user the server runs as, so the pod keeps restarting against the same PVC-backed mount until the ownership mismatch is corrected. The env entry sourcing the username from a Secret, the StatefulSet pod identity, and the PVC-volumeMount pair are all readable from the pod spec.

## Root Cause

The standard upstream postgres image requires the data directory to be owned by the OS user the server runs as before it will start. When the username supplied to the container — typically through an environment variable sourced from a Secret via `valueFrom.secretKeyRef` — does not match the directory's owner on the mounted PersistentVolumeClaim, the container fails to come up on every restart. The container's env entry, the PVC backing the data directory, and the volumeMount path are all readable from the pod spec and are the input needed to plan a fix.

## Resolution

Two correction paths exist depending on which side of the mismatch is wrong: the on-disk ownership, or the username configured in the Secret. Both paths follow the standard Kubernetes resource shapes that apply to any postgres StatefulSet pod.

**Option 1 — correct on-disk ownership via an ephemeral debug container.** When the username configured for the postgres process is the intended one and the on-disk ownership drifted (typically left over from an earlier image or a manual restore), attach an ephemeral debug container to the running pod and `chown` the data directory to the expected user. The `kubectl debug` ephemeral-container form is the generic equivalent on this cluster; targeted at the postgres container, it shares the target pod's namespaces so the data-directory path is reachable from the debug shell at the same mountpoint exposed to the postgres container:

```bash
kubectl debug -n <namespace> pod/<postgres-pod> \
  --image=<debug-image-with-shell> \
  --target=<postgres-container> \
  -it -- sh
```

From the debug shell, align ownership on the mounted data directory to the user the postgres process runs as, then exit the shell:

```bash
chown -R <postgres-user>:<postgres-group> <data-dir-path>
```

After the on-disk ownership is corrected, delete the pod so its controller recreates it under the same ordinal against the same PVC; the recreated container re-runs the initdb startup check, which then passes:

```bash
kubectl delete pod -n <namespace> <postgres-pod>
```

**Option 2 — correct the username carried in the Secret.** When the data directory's on-disk ownership is the intended one and the Secret holds a non-matching username, update the Secret's `user` key to match the directory owner. The standard merge-patch form writes a base64-encoded value into `.data`, which is the field shape Secrets require for binary-safe storage:

```bash
kubectl patch secret -n <namespace> <secret-name> \
  --type merge \
  -p '{"data":{"user":"<base64-encoded-username>"}}'
```

Values under a Secret's `data` field are base64-encoded; the `stringData` field accepts plain-text values that the API server merges into `.data` on write. Either field shape is valid for the username update, so long as the resulting plain-text value matches the on-disk owner.

After the Secret is updated, restart the pod so the controller recreates it and the postgres container picks up the new env value sourced from the Secret:

```bash
kubectl delete pod -n <namespace> <postgres-pod>
```

## Diagnostic Steps

Read the Secret's `user` key by base64-decoding the `.data.user` value. The `.data` field is a map of base64-encoded strings, so a one-shot decode against the jsonpath projection returns the plain-text username currently configured:

```bash
kubectl get secret -n <namespace> <secret-name> \
  -o jsonpath='{.data.user}' | base64 -d
```

Read the PVC bound to the pod and the env entry sourcing the username from the pod spec. The PVC name appears under `spec.volumes[].persistentVolumeClaim.claimName` and pairs with the matching `name` in `spec.containers[].volumeMounts`; the env entry appears under `spec.containers[].env[]` with `valueFrom.secretKeyRef.{name,key}` pointing at the Secret and key inspected above:

```bash
kubectl get pod -n <namespace> <postgres-pod> -o json
```

Compare the decoded username from the Secret against the on-disk ownership of the data directory exposed inside the debug container; the mismatched side identifies which resolution path applies.
