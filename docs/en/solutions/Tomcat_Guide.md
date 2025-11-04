---
kind:
   - Solution
products: 
  - Alauda Application Services
---

# How to Use Tomcat on ACP Platform
## Overview

**Apache Tomcat** is an open-source Java web container maintained by the **Apache Software Foundation (ASF)**.  
It is widely used to run Jakarta EE applications based on Servlet, JSP, and WebSocket.  
With its lightweight, efficient, and extensible architecture, Tomcat has become one of the most popular runtime environments for enterprise Java web applications.

**Alauda** has validated the official community Tomcat images (from Docker Hub) for compatibility, security, and performance, ensuring stable and secure operation on **ACP** and **Kubernetes** platforms.

---

## Version Maintenance

Alauda has validated the following official community Tomcat images within the ACP environment:

| Version | JDK Version | Image | Status | Architecture | Released | Maintenance Until | Phase |
|----------|--------------|--------|----------|---------------|-----------|-------------------|--------|
| 10.1 | OpenJDK 17 (Eclipse Temurin) | `tomcat:10.1-jre17-temurin-jammy` | ✅ Certified | x86_64, aarch64 | 2022 | ~2027 | Maintenance |
| 11.0 | OpenJDK 17 (Eclipse Temurin) | `tomcat:11.0-jre17-temurin-jammy` | ✅ Certified | x86_64, aarch64 | 2024 | ~2029 | Active |

---

## Validation Scope

Alauda’s validation includes full compatibility and performance testing:

- Full deployment verification on ACP / Kubernetes
- WAR file deployment and hot reload tests
- Container startup and JVM memory management performance
- Security scan and CVE patch validation

After each official Apache Tomcat release or security update, Alauda revalidates and republishes certified updates within **1–2 weeks**.

---

## Version Support and Lifecycle

Alauda-certified Tomcat lifecycles are fully aligned with **Apache community releases**, ensuring timely access to security fixes and new features.

### Lifecycle Phases

| Phase | Description |
|--------|--------------|
| **Active Development** | The current main release, receiving feature and performance updates. |
| **Maintenance** | Receives only security and critical bug fixes, suitable for long-term production use. |
| **End of Life (EOL)** | No further updates are provided by the Apache community. |

> Alauda provides limited consulting for EOL versions and does not recommend their use in production.

Reference: [Apache Tomcat Supported Versions](https://tomcat.apache.org/whichversion.html)

---

## Quick Start

This section demonstrates how to build and run a Java web application using an **Alauda-certified Apache Tomcat official image**.

### 1. Prepare the WAR package

Assume you have a built WAR file, such as:

```
target/myapp.war
```

### 2. Create a `Dockerfile`

```dockerfile
# Use Alauda-verified Tomcat base image
FROM tomcat:11.0-jre17-temurin-jammy

# Optional: remove default webapps
RUN rm -rf /usr/local/tomcat/webapps/*

# Copy your WAR file into the deployment directory
COPY target/myapp.war /usr/local/tomcat/webapps/ROOT.war

# Expose default port
EXPOSE 8080

# Start Tomcat
CMD ["catalina.sh", "run"]
```

### 3. Build the image

```bash
nerdctl build -t myapp:latest .
```

### 4. Run locally

```bash
nerdctl run -p 8080:8080 myapp:latest
```

Access [http://localhost:8080](http://localhost:8080) in your browser.  
If the homepage loads, the deployment is successful.

---

### 5. Deploy to ACP / Kubernetes

**Example Deployment and Service:**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myapp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: myapp
  template:
    metadata:
      labels:
        app: myapp
    spec:
      containers:
        - name: myapp
          image: xxxxx/demo/myapp:latest
          ports:
            - containerPort: 8080
---
apiVersion: v1
kind: Service
metadata:
  name: myapp
spec:
  type: NodePort
  selector:
    app: myapp
  ports:
    - port: 8080
      targetPort: 8080
      nodePort: 30080
```

After deployment, visit:

```
http://<NodeIP>:30080
```

If the page is accessible, the WAR application is successfully running inside the Tomcat container.

---

## Security Patch and Update Policy

Alauda’s security update mechanism follows the **Apache Tomcat official release cycle**:

- Updates synchronized quarterly or when critical CVEs are patched
- Alauda completes validation within 1–2 weeks of upstream release
- Optional vulnerability tracking and security reporting available

Reference: [Apache Tomcat Security Advisories](https://tomcat.apache.org/security.html)

---

## Platform and Architecture Support

| Tomcat Version | Platform | Architecture |
|----------------|-----------|---------------|
| 10.1 / 11.0 | ACP / Kubernetes | x86_64, aarch64 |

**Recommended Runtime Environment:**

- Base OS: Ubuntu Jammy (22.04) or Ubuntu Noble (24.04)
- JDK: Eclipse Temurin JRE 17
- Container Memory: ≥ 512 MB (adjustable via JVM options)

---

## Licensing and Compliance

| Component | License | Commercial Use |
|------------|----------|----------------|
| Apache Tomcat | Apache License 2.0 | Free for commercial use |
| Eclipse Temurin JRE | GPLv2 + Classpath Exception | Free for commercial use |

Alauda-certified images comply with upstream open-source licenses and can be used freely for enterprise production deployments.
