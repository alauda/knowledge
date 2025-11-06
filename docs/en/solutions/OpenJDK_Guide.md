---
kind:
  - Solution
products:
  - Alauda Application Services
---


# How to Use OpenJDK on ACP Platform

## Overview

**OpenJDK (Open Java Development Kit)** is the official open-source implementation of the Java Platform, Standard Edition (Java SE), maintained by multiple vendors including Oracle, Red Hat, IBM, and Microsoft.  
It includes the full **Java compiler (javac)**, **runtime environment (JRE)**, **virtual machine (JVM)**, and **core libraries**, and serves as the de facto standard for Java application development and runtime.

### Red Hat Build of OpenJDK
Red Hat is one of the main maintainers of the long-term support (LTS) releases of OpenJDK. It provides an enterprise-grade build called **Red Hat Build of OpenJDK**, featuring:

- Synchronization with the OpenJDK community mainline;
- Long-term maintenance (LTS) and security patches;
- Optimization for RHEL / UBI environments;
- Free commercial use under GPLv2 + Classpath Exception.

Alauda has verified compatibility and certified enterprise-grade container images based on the Red Hat Build of OpenJDK to ensure secure and stable operation within **Kubernetes** and **Alauda ACP** platforms.


---

## Support Policy

Alauda supports **all community-released OpenJDK versions** by default, with representative versions validated for ACP platform compatibility and runtime performance.  
The support period follows the **Red Hat / OpenJDK community lifecycle**.  
Users can directly pull official Red Hat OpenJDK images from the community registry and deploy them on ACP without modification.

### Validated Version List

| Version | Base Image | Image Repository | Supported ACP Versions | Certification | Architecture | Maintenance Until |
|----------|-------------|------------------|------------------------|---------------|---------------|-------------------|
| OpenJDK 8  | RHEL 8 UBI | `registry.access.redhat.com/ubi8/openjdk-8` | All                    | ✅ Certified   | x86_64, aarch64 | 2026 |
| OpenJDK 17 | RHEL 9 UBI | `registry.access.redhat.com/ubi9/openjdk-17` | All                    | ✅ Certified   | x86_64, aarch64 | 2027 |
| OpenJDK 21 | RHEL 9 UBI | `registry.access.redhat.com/ubi9/openjdk-21` | All                    | ✅ Certified   | x86_64, aarch64 | 2029 |

---

## Quick Start

This section demonstrates how to build and deploy a Java application using Alauda-verified OpenJDK base images.

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

Then access your application at:
```bash
http://<NodeIP>:30080
```

---

## Best Practices

- **Use LTS versions** (OpenJDK 17 or 21) for enterprise deployments.
- **Rely on community-maintained Red Hat OpenJDK images** to ensure timely CVE patches.
- **Adjust JVM parameters** such as `-Xms512m -Xmx1024m` based on workload size.
- **Leverage multi-stage Docker builds** to reduce image size when building custom JARs.
- **Monitor memory usage** using ACP metrics for container-level optimization.  
