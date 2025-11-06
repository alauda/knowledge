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

**Alauda** has validated the official community Tomcat images (from Docker Hub) for compatibility, security, and performance,
ensuring stable and secure operation on **ACP** and **Kubernetes** platforms.

---

## Support Policy

Alauda supports all official **Apache Tomcat community versions** by default, with representative versions validated for functionality, performance, and security.
The support lifecycle aligns fully with the **Apache community lifecycle**.
Users can directly download and use official Tomcat images from Docker Hub on the ACP platform.

### Validated Version List

| Tomcat Version | JDK Version | Image | Supported ACP Versions | Validation  | Architecture | Released | Maintenance Until | Phase |
|----------------|--------------|--------|---------------------|-------------|-----------|-----------|-------------------|--------|
| 10.1 | OpenJDK 17 (Eclipse Temurin) | `tomcat:10.1-jre17-temurin-jammy` | All                 | ✅ Certified | x86_64, aarch64 | 2022 | ~2027 | Maintenance |
| 11.0 | OpenJDK 17 (Eclipse Temurin) | `tomcat:11.0-jre17-temurin-jammy` | All                 | ✅ Certified | x86_64, aarch64 | 2024 | ~2029 | Active |

---

## Quick Start

This guide demonstrates how to build and deploy a simple Java web application using an **Alauda-certified Apache Tomcat image**.

### 1. Prepare the WAR package

Assume you have a built WAR file, such as:

```text
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
          image: myrepo/myapp:latest
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

Then visit: `http://<NodeIP>:30080`

---

## Best Practices

- Use official, community-maintained images to ensure CVE patch updates.
- Customize `server.xml` and `context.xml` via ConfigMap if needed.
- Use `Eclipse Temurin JRE 17` as the base JDK for long-term support.
- Adjust JVM options (e.g., `-Xms512m -Xmx1024m`) according to application size.
- When building custom images, prefer multi-stage builds to reduce image size.
