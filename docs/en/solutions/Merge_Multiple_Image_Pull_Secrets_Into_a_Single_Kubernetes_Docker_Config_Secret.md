---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
id: KB260500029
---

# Merge Multiple Image Pull Secrets Into a Single Kubernetes Docker-Config Secret

## Issue

A workload needs to pull container images from more than one private registry (for example a public mirror, a vendor registry, and a team-internal Harbor). Each registry exposes its own credentials in a separate `~/.docker/config.json`-style file. Kubernetes accepts only one `imagePullSecrets` entry at a time per ServiceAccount default, and even when several are listed, supplying many secrets adds operational noise.

This article describes how to merge two or more existing pull-secret JSON files into a single `kubernetes.io/dockerconfigjson` Secret that satisfies every registry in one step.

## Root Cause

The `dockerconfigjson` Secret type is a plain base64-wrapped copy of a JSON document with the shape:

```json
{
  "auths": {
    "registry-a.example.com": { "auth": "<base64>" },
    "registry-b.example.com": { "auth": "<base64>" }
  }
}
```

When two pull-secret files contain disjoint `auths` keys, merging is purely a JSON union — the kubelet image puller looks up the registry hostname at pull time, and any matching entry under `auths` is used. The work is therefore client-side text manipulation; no API change is needed.

## Resolution

### Steps

1. Export each existing pull secret to a plain JSON file. For a Secret that already lives in the cluster:

   ```bash
   kubectl get secret registry-a-pull -n team-x \
     -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > /tmp/auth-a.json

   kubectl get secret registry-b-pull -n team-x \
     -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d > /tmp/auth-b.json
   ```

   For a `~/.docker/config.json` produced by `docker login`, copy the file verbatim.

2. Merge the `.auths` objects with `jq`. The right-hand operand wins on key collisions, so put the higher-priority registry second if the same host appears in both:

   ```bash
   jq -s '.[0] * .[1] | {auths: .auths}' /tmp/auth-a.json /tmp/auth-b.json \
     > /tmp/auth-merged.json
   ```

   Inspect:

   ```bash
   jq '.auths | keys' /tmp/auth-merged.json
   ```

3. Create or replace the merged Secret:

   ```bash
   kubectl create secret generic glean-merged-pull \
     --from-file=.dockerconfigjson=/tmp/auth-merged.json \
     --type=kubernetes.io/dockerconfigjson \
     -n team-x \
     --dry-run=client -o yaml | kubectl apply -f -
   ```

4. Reference the merged Secret on each Pod (or attach it to the namespace's default ServiceAccount so Pods inherit it automatically):

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: multi-registry-app
   spec:
     imagePullSecrets:
       - name: glean-merged-pull
     containers:
       - name: app
         image: registry-a.example.com/foo:1.0
   ```

   Or:

   ```bash
   kubectl patch serviceaccount default -n team-x \
     -p '{"imagePullSecrets":[{"name":"glean-merged-pull"}]}'
   ```

5. Delete the source temp files (`/tmp/auth-*.json`) — they contain credentials in plain text.

## Diagnostic Steps

If a Pod still reports `ImagePullBackOff` after switching to the merged Secret:

- Confirm the Secret type is exactly `kubernetes.io/dockerconfigjson`:

  ```bash
  kubectl get secret glean-merged-pull -n team-x -o jsonpath='{.type}'
  ```

- Decode the live Secret to confirm the registry hostname appears under `.auths`:

  ```bash
  kubectl get secret glean-merged-pull -n team-x \
    -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq '.auths | keys'
  ```

- Check the Pod event stream for the exact registry hostname the kubelet tried (it must match the key in `.auths` byte-for-byte, including port if non-standard):

  ```bash
  kubectl describe pod multi-registry-app -n team-x | tail -20
  ```

- If the failing host is missing, repeat the merge with the additional source file.
