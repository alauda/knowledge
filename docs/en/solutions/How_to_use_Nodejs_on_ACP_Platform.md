---
kind:
   - Solution
products: 
  - Alauda Application Services
---

# How to Use Node.js on ACP Platform

## Overview

This guide explains how to develop, containerize, and deploy a Node.js application on the Alauda Container Platform (ACP). Provides example source, Container file, container image workflow, and Kubernetes manifests (Deployment, Service). You will also find troubleshooting and best practices for running Node.js on ACP.

## Node.js Support Cycle

The support cycle for Node.js on ACP **aligns with the official Node.js community support cycle** to ensure security, stability, and access to critical updates. Node.js releases follow a clear lifecycle, which includes three phases:

1. **Current**: New features and improvements are actively added; supported until the next major version is released.

2. **LTS (Long-Term Support)**: Focus on stability, security patches, and bug fixes; typically supported for 18 months (Active LTS) followed by an additional 12 months of Maintenance LTS.

3. **End-of-Life (EOL)**: No further updates (including security fixes) are provided; **Although ACP offers technical consulting services for EOL Node.js versions**, the use of such versions on ACP is strongly discouraged as it introduces security risks and compatibility issues.

For the latest Node.js support cycle details (including active LTS versions, EOL dates, and release schedules), refer to the official Node.js website: [Node.js Release Schedule](https://nodejs.org/en/about/releases/)

### Recommended Node.js Image Repositories

To ensure compliance with support cycles and access to verified, secure images, use the following official repositories when building Node.js containers for ACP:

1. **Node.js Community Docker Hub Repository** (official, community-maintained images):

   [https://hub.docker.com/\_/node](https://hub.docker.com/_/node)

* Includes Alpine, Debian, and Slim variants (e.g., `node:20-alpine`, `node:22-slim`).

* Tags are aligned with Node.js versioning (e.g., `node:18.20.2` for a specific patch version, `node:18-lts` for the latest Active LTS patch).

1. **Red Hat Public Node.js Repository** :

* ACP also supports the deployment of the nodejs image pulled from the redhat public image repository.

## Supported platforms

This list of supported platforms is current as of the branch/release to
which it belongs.

### Input

Node.js relies on V8 and libuv. We adopt a subset of their supported platforms.

### Strategy

There are three support tiers:

* **Tier 1**: These platforms represent the majority of Node.js users. The
  Node.js Build Working Group maintains infrastructure for full test coverage.
  Test failures on tier 1 platforms will block releases.
* **Tier 2**: These platforms represent smaller segments of the Node.js user
  base. The Node.js Build Working Group maintains infrastructure for full test
  coverage. Test failures on tier 2 platforms will block releases.
  Infrastructure issues may delay the release of binaries for these platforms.
* **Experimental**: May not compile or test suite may not pass. The core team
  does not create releases for these platforms. Test failures on experimental
  platforms do not block releases. Contributions to improve support for these
  platforms are welcome.

Platforms may move between tiers between major release lines. The table below
will reflect those changes.

### Platform list

Node.js compilation/execution support depends on operating system, architecture,
and libc version. The table below lists the support tier for each supported
combination. A list of [supported compile toolchains](#supported-toolchains) is
also supplied for tier 1 platforms.

**For production applications, run Node.js on supported platforms only.**

Node.js does not support a platform version if a vendor has expired support
for it. In other words, Node.js does not support running on End-of-Life (EoL)
platforms. This is true regardless of entries in the table below.

| Operating System | Architectures    | Versions                          | Support Type | Notes                                |
| ---------------- | ---------------- | --------------------------------- | ------------ | ------------------------------------ |
| GNU/Linux        | x64              | kernel >= 4.18[^1], glibc >= 2.28 | Tier 1       | e.g. Ubuntu 20.04, Debian 10, RHEL 8 |
| GNU/Linux        | x64              | kernel >= 3.10, musl >= 1.1.19    | Experimental | e.g. Alpine 3.8                      |
| GNU/Linux        | x86              | kernel >= 3.10, glibc >= 2.17     | Experimental | Downgraded as of Node.js 10          |
| GNU/Linux        | arm64            | kernel >= 4.18[^1], glibc >= 2.28 | Tier 1       | e.g. Ubuntu 20.04, Debian 10, RHEL 8 |
| GNU/Linux        | armv7            | kernel >= 4.18[^1], glibc >= 2.28 | Experimental | Downgraded as of Node.js 24          |
| GNU/Linux        | armv6            | kernel >= 4.14, glibc >= 2.24     | Experimental | Downgraded as of Node.js 12          |
| GNU/Linux        | ppc64le >=power8 | kernel >= 4.18[^1], glibc >= 2.28 | Tier 2       | e.g. Ubuntu 20.04, RHEL 8            |
| GNU/Linux        | s390x            | kernel >= 4.18[^1], glibc >= 2.28 | Tier 2       | e.g. RHEL 8                          |
| GNU/Linux        | loong64          | kernel >= 5.19, glibc >= 2.36     | Experimental |                                      |
| Windows          | x64              | >= Windows 10/Server 2016         | Tier 1       | [^2],[^3]                            |
| Windows          | arm64            | >= Windows 10                     | Tier 2       |                                      |
| macOS            | x64              | >= 13.5                           | Tier 1       | For notes about compilation see [^4] |
| macOS            | arm64            | >= 13.5                           | Tier 1       |                                      |
| SmartOS          | x64              | >= 18                             | Tier 2       |                                      |
| AIX              | ppc64be >=power8 | >= 7.2 TL04                       | Tier 2       |                                      |
| FreeBSD          | x64              | >= 13.2                           | Experimental |                                      |
| OpenHarmony      | arm64            | >= 5.0                            | Experimental |                                      |

<!--lint disable final-definition-->

[^1]: Older kernel versions may work. However, official Node.js release
    binaries are [built on RHEL 8 systems](#official-binary-platforms-and-toolchains)
    with kernel 4.18.

[^2]: On Windows, running Node.js in Windows terminal emulators
    like `mintty` requires the usage of [winpty](https://github.com/rprichard/winpty)
    for the tty channels to work (e.g. `winpty node.exe script.js`).
    In "Git bash" if you call the node shell alias (`node` without the `.exe`
    extension), `winpty` is used automatically.

[^3]: The Windows Subsystem for Linux (WSL) is not
    supported, but the GNU/Linux build process and binaries should work. The
    community will only address issues that reproduce on native GNU/Linux
    systems. Issues that only reproduce on WSL should be reported in the
    [WSL issue tracker](https://github.com/Microsoft/WSL/issues). Running the
    Windows binary (`node.exe`) in WSL will not work without workarounds such as
    stdio redirection.

[^4]: Our macOS Binaries are compiled with 13.5 as a target. Xcode 16 is
    required to compile.

<!--lint enable final-definition-->

### Supported toolchains

Depending on the host platform, the selection of toolchains may vary.

| Operating System | Compiler Versions                                              |
| ---------------- | -------------------------------------------------------------- |
| Linux            | GCC >= 12.2 or Clang >= 19.1                                   |
| Windows          | Visual Studio >= 2022 with the Windows 10 SDK on a 64-bit host |
| macOS            | Xcode >= 16.4 (Apple LLVM >= 19)                               |

### Official binary platforms and toolchains

Binaries at <https://nodejs.org/download/release/> are produced on:

| Binary package          | Platform and Toolchain                                        |
| ----------------------- | ------------------------------------------------------------- |
| aix-ppc64               | AIX 7.2 TL04 on PPC64BE with GCC 12[^5]                       |
| darwin-x64              | macOS 15, Xcode 16 with -mmacosx-version-min=13.5             |
| darwin-arm64 (and .pkg) | macOS 15 (arm64), Xcode 16 with -mmacosx-version-min=13.5     |
| linux-arm64             | RHEL 8 with Clang 19.1 and gcc-toolset-14-libatomic-devel[^6] |
| linux-ppc64le           | RHEL 8 with Clang 19.1 and gcc-toolset-14-libatomic-devel[^6] |
| linux-s390x             | RHEL 8 with Clang 19.1 and gcc-toolset-14-libatomic-devel[^6] |
| linux-x64               | RHEL 8 with Clang 19.1 and gcc-toolset-14-libatomic-devel[^6] |
| win-arm64               | Windows Server 2022 (x64) with Visual Studio 2022             |
| win-x64                 | Windows Server 2022 (x64) with Visual Studio 2022             |

[^5]: Binaries produced on these systems require libstdc++12, available
    from the [AIX toolbox][].

[^6]: Binaries produced on these systems are compatible with glibc >= 2.28
    and libstdc++ >= 6.0.25 (`GLIBCXX_3.4.25`). These are available on
    distributions natively supporting GCC 8.1 or higher, such as Debian 10,
    RHEL 8 and Ubuntu 20.04.

#### OpenSSL asm support

OpenSSL-1.1.1 requires the following assembler version for use of asm
support on x86\_64 and ia32.

For use of AVX-512,

* gas (GNU assembler) version 2.26 or higher
* nasm version 2.11.8 or higher in Windows

AVX-512 is disabled for Skylake-X by OpenSSL-1.1.1.

For use of AVX2,

* gas (GNU assembler) version 2.23 or higher
* Xcode version 5.0 or higher
* llvm version 3.3 or higher
* nasm version 2.10 or higher in Windows

Please refer to <https://docs.openssl.org/1.1.1/man3/OPENSSL_ia32cap/> for details.

If compiling without one of the above, use `configure` with the
`--openssl-no-asm` flag. Otherwise, `configure` will fail.

## Prerequisites

- Access to an ACP instance and user credentials.
- kubectl and kubectl-acp configured and logged in to your ACP cluster.
- Podman or a compatible container builder and access to an image registry that your ACP cluster can pull from (image repository address and credentials).
- Basic familiarity with Node.js and npm.

## Example Node.js application

Create a minimal Express app. Save as `app.js`:

```js
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Hello from Node.js on ACP!');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

Create a minimal `package.json`:

```json
{
  "name": "acp-nodejs-sample",
  "version": "1.0.0",
  "main": "app.js",
  "scripts": {
    "start": "node app.js"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

### Container file

Build a small production image using node:22-alpine:

```
FROM node:22-alpine
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "app.js"]
```

## Build and push image

1. Build the image locally (replace `<registry>` and `<repo>` with your registry address):

```bash
podman build -t <registry>/<repo>/acp-nodejs-sample:1.0.0 .
```

2. Push the image to your registry (ensure credentials are configured):

```bash
podman push <registry>/<repo>/acp-nodejs-sample:1.0.0
```

If your organization uses a platform tool for publishing images (for example `violet push`), follow your platform's standard image publishing workflow and note the final image URL.

## Prepare ACP namespace and image pull secret

1. Login to ACP and select the cluster/namespace:

```bash
kubectl acp login <acp_address> --idp=<idp_name> --cluster=<cluster-name> --namespace=<namespace-name>
```

2. Create a project/namespace if necessary:

```bash
kubectl acp create project <project-name> --cluster=<cluster-name>
kubectl acp process namepace-quota-limit -n cpaas-system -p NAMESPACE=<namespace-name> -p PROJECT=<project-name> -p CLUSTER=<cluster-name> | kubectl acp apply -f -
```

3. Create image pull secret so the cluster can pull your image (replace credentials appropriately):

```bash
kubectl create secret docker-registry regcred \
  --docker-server=<registry> \
  --docker-username=<username> \
  --docker-password=<password> \
  --docker-email=<email> \
  -n <namespace-name>
```

## Kubernetes manifests (Deployment + Service)

Save the following as `deployment-nodejs.yaml`.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: acp-nodejs-sample
  labels:
    app: acp-nodejs-sample
spec:
  replicas: 2
  selector:
    matchLabels:
      app: acp-nodejs-sample
  template:
    metadata:
      labels:
        app: acp-nodejs-sample
    spec:
      imagePullSecrets:
      - name: regcred
      containers:
      - name: nodejs
        image: <registry>/<repo>/acp-nodejs-sample:1.0.0
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        livenessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 20
        readinessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        resources:
          requests:
            cpu: "100m"
            memory: "128Mi"
          limits:
            cpu: "500m"
            memory: "512Mi"

---
apiVersion: v1
kind: Service
metadata:
  name: acp-nodejs-service
spec:
  selector:
    app: acp-nodejs-sample
  ports:
  - protocol: TCP
    port: 80
    targetPort: 3000
  type: ClusterIP
```

Apply the manifest in your namespace:

```bash
kubectl acp apply -f deployment-nodejs.yaml -n <namespace-name>
```

## Deploy using ACP Application (UI)

ACP also supports creating Applications from Catalog or by uploading the manifest. Steps (UI):

1. In ACP console, go to the target namespace and click Applications → Create.
2. Choose Create from YAML/Manifest or Create from Catalog if you packaged an application chart.
3. Provide the `deployment-nodejs.yaml` and any configuration values (image tag, replicas, etc.).
4. Create and monitor the deployment from the Applications dashboard.

## Scaling and Updates

- To scale replicas:

```bash
kubectl scale deployment acp-nodejs-sample --replicas=4 -n <namespace-name>
```

- To perform a rolling update (image change):

```bash
kubectl set image deployment/acp-nodejs-sample nodejs=<registry>/<repo>/acp-nodejs-sample:1.0.1 -n <namespace-name>
```

ACP will show rollout status in the UI; you can also monitor with:

```bash
kubectl rollout status deployment/acp-nodejs-sample -n <namespace-name>
```

## Troubleshooting

- View pod logs:

```bash
kubectl logs -l app=acp-nodejs-sample -n <namespace-name>
```

- Exec into a running pod for debugging:

```bash
kubectl exec -it $(kubectl get pod -l app=acp-nodejs-sample -n <namespace-name> -o jsonpath='{.items[0].metadata.name}') -n <namespace-name> -- /bin/sh
```

- Common issues:
  - Image pull errors: confirm `regcred` exists and image URL is correct.
  - CrashLoopBackOff: check `NODE_ENV`, missing environment variables, or errors in application startup.
  - Readiness probe failing: increase initialDelaySeconds while app warms up.

## Best practices

- Use multi-stage builds if you compile native modules or want smaller images.
- Pin Node.js base image versions and tidy dependencies to reduce vulnerabilities.
- Configure liveness/readiness probes and resource requests/limits.
- Use ConfigMaps and Secrets for configuration and sensitive data.
- Use rolling updates and readiness gates to avoid downtime during updates.

## Example quick commands

```bash
# build and push
podman build -t <registry>/<repo>/acp-nodejs-sample:1.0.0 .
podman push <registry>/<repo>/acp-nodejs-sample:1.0.0

# create secret (once)
kubectl create secret docker-registry regcred --docker-server=<registry> --docker-username=<user> --docker-password=<pw> -n <namespace-name>

# deploy
kubectl acp apply -f deployment-nodejs.yaml -n <namespace-name>

# check status
kubectl get pods -l app=acp-nodejs-sample -n <namespace-name>
kubectl logs -l app=acp-nodejs-sample -n <namespace-name>
```

## Notes

This document provides a starting point for running Node.js workloads on ACP. For production deployments consider adding observability (Prometheus metrics, traces), secure image scanning, and CI/CD pipelines integrated with ACP's Catalog.
