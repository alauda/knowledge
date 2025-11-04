---
kind:
   - Solution
products: 
  - Alauda Application Services
---


# How to Use OpenJDK on ACP Platform

## Overview
**OpenJDK (Open Java Development Kit)** is the official open-source implementation of the Java Platform, Standard Edition (Java SE). It is jointly maintained by multiple vendors including Oracle, Red Hat, IBM, and Microsoft.  
It includes the full **Java compiler, runtime environment (JRE), virtual machine (JVM), and core libraries**, and is the de facto standard for Java development and runtime.

Red Hat is one of the main maintainers of the long-term support (LTS) releases of OpenJDK. It provides an enterprise-grade build called **Red Hat Build of OpenJDK**, featuring:

- Synchronization with the OpenJDK community mainline;
- Long-term maintenance (LTS) and security patches;
- Optimization for RHEL / UBI environments;
- Free commercial use under GPLv2 + Classpath Exception.

Alauda has verified compatibility and certified enterprise-grade container images based on the Red Hat Build of OpenJDK to ensure secure and stable operation within **Kubernetes** and **Alauda ACP** platforms.

---

## Version Maintenance

### Community Downloads and Image Sources

Alauda-certified OpenJDK versions are based on Red Hat’s official distribution channels. Below are the main download and mirror sources:

| Version | Image Repository | Description |
|----------|------------------|--------------|
| OpenJDK 8  | `registry.access.redhat.com/ubi8/openjdk-8`  | Stable long-term support version |
| OpenJDK 17 | `registry.access.redhat.com/ubi9/openjdk-17` | Recommended enterprise default version |
| OpenJDK 21 | `registry.access.redhat.com/ubi9/openjdk-21` | Latest LTS version, recommended for new projects |

All images are built on **Red Hat UBI (Universal Base Image)** and can be used directly in Kubernetes or containerd environments.

---

### Verified Versions

| Version | Base Image | Certification Status | Architecture Support |
|----------|-------------|----------------------|----------------------|
| 8  | RHEL 8 Base Image  | ✅ Certified | x86_64, aarch64 |
| 17 | RHEL 8/9 Base Image | ✅ Certified | x86_64, aarch64 |
| 21 | RHEL 8/9 Base Image | ✅ Certified | x86_64, aarch64 |

Alauda’s verification scope includes:
- Startup compatibility
- Container performance
- Memory reclamation stability
- Security scanning

---

## Technical Support

Alauda provides OpenJDK technical services aligned with Red Hat’s official support policy:

| Service Type | Description |
|---------------|-------------|
| Image Compatibility | Container image compatibility and upgrade validation |
| Security Advisory | Evaluation and remediation of community CVE announcements |
| Lifecycle Planning | EOL version replacement recommendations |
| JVM Optimization | GC tuning and startup parameter optimization |

---

## Version Lifecycle

Alauda-certified OpenJDK lifecycle fully aligns with Red Hat Build of OpenJDK:

| Version | Release Year | End of Maintenance | Status |
|----------|---------------|-------------------|---------|
| OpenJDK 8  | 2015 | 2026 | Active |
| OpenJDK 17 | 2021 | 2027 | Active |
| OpenJDK 21 | 2023 | 2029 | Active |

👉 Reference: [RedHat OpenJDK Life Cycle and Support Policy](https://access.redhat.com/articles/1299013)

---

## Quick Start

This section demonstrates how to quickly build and run a Java application using Alauda-certified OpenJDK base images.

### 1. Create a `Dockerfile`

```dockerfile
# Use Alauda-certified Red Hat OpenJDK 17 base image
FROM registry.access.redhat.com/ubi9/openjdk-17

# Copy the application into the container
COPY target/app.jar /opt/app/app.jar

# Set working directory
WORKDIR /opt/app

# Startup command
CMD ["java", "-jar", "app.jar"]
```

> You can replace the image with other verified versions if needed.

---

### 2. Build the Image

```bash
nerdctl build -t my-java-app .
```

### 3. Run Locally

```bash
nerdctl run -p 8080:8080 my-java-app
```

---

### 4. Deploy to Kubernetes / Alauda ACP

**Example Deployment:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-java-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-java-app
  template:
    metadata:
      labels:
        app: my-java-app
    spec:
      containers:
        - name: my-java-app
          image: my-java-app:latest
          ports:
            - containerPort: 8080
```

**Example Service (NodePort):**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-java-app
spec:
  type: NodePort
  selector:
    app: my-java-app
  ports:
    - port: 8080
      targetPort: 8080
```

---

## Security Patch Policy

Alauda follows the Red Hat OpenJDK official security release cycle, which provides four updates per year (approximately every three months).  
All security updates are synchronized with Red Hat’s official advisories.

---

## Architecture and Platform Support

Aligned with Red Hat’s official support scope:

| Architecture | Support Level | Description |
|---------------|---------------|--------------|
| x86_64 | ✅ Fully Supported | Mainstream enterprise environments |
| aarch64 | ✅ Fully Supported | ARM64 platform adaptation |

**Base Image Environment:**

- Red Hat UBI 8 / 9
- Compatible with Kubernetes and Alauda ACP

---

## Compliance and Licensing

Alauda-certified OpenJDK versions comply with Red Hat and OpenJDK official licensing terms:

| Component | License | Commercial Use |
|------------|----------|----------------|
| OpenJDK Runtime | GPLv2 with Classpath Exception | Free for commercial use, modification, and redistribution |
| Red Hat Build of OpenJDK | GPLv2 with Classpath Exception | Same as the community license |
