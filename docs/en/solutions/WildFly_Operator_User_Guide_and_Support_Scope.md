# WildFly Overview

WildFly (formerly known as JBoss Application Server) is an open-source, lightweight, and high-performance Java EE / Jakarta EE application server developed under the leadership of Red Hat.  
It provides a runtime environment for enterprise Java applications, supporting the complete Jakarta EE specifications including EJB, JPA, JMS, JAX-RS, CDI, and more.  
Its core design philosophy emphasizes modularity, high performance, and cloud-native readiness.

## Key Features
- **Architecture**: Modular architecture (JBoss Modules) with class loading isolation to reduce resource consumption.
- **Performance**: Fast startup (1–3 seconds), low memory footprint (~80MB), and bytecode enhancement optimizations.
- **Security**: Supports JAAS/JACC/JASPI, remote TLS configuration, and enhanced distributed communication security.
- **Cloud-Native Support**: Deep integration with Docker/Kubernetes, enabling containerized deployment and automated operations.
- **Standards Compliance**: Full Jakarta EE Full Profile support, ensuring portability of enterprise applications.

## Typical Use Cases
- **Enterprise Systems**: ERP, CRM, financial platforms. Supports distributed transactions (JTA), messaging (JMS), clustering, and fault tolerance to meet business consistency requirements.
- **High-Performance Web/API Services**: E-commerce platforms, social media backends, RESTful API gateways. Integrated Undertow web server with HTTP/2 and WebSocket support; JAX-RS simplifies API development.
- **Cloud-Native & Microservices Architectures**: Kubernetes microservices and hybrid cloud apps. Container-friendly with Helm Charts and Operator support; integrates MicroProfile (health checks, metrics, monitoring).
- **Legacy Modernization**: Migrating traditional Java EE applications. Compatible with historical Java EE standards, providing smooth migration paths from WebLogic/WebSphere to WildFly.

# WildFly vs. Red Hat JBoss EAP

| Category | WildFly | JBoss EAP |
|----------|---------|-----------|
| **Maintainers** | Community (Red Hat engineers + contributors) | Red Hat commercial team |
| **Release Cycle** | Fast, frequent updates, adopts new tech quickly | Slower, rigorously tested, highly stable |
| **Support Lifecycle** | Short (usually <1 year per release) | Up to 7+ years of commercial support (security patches included) |
| **Stability** | Experimental features, sometimes less stable | Focus on stability and compatibility |
| **Features** | May include experimental features | Curated stable features, excludes unfinished components |
| **Documentation & Support** | Community docs, no SLA guarantee | Red Hat official docs, knowledge base, SLA-backed support |
| **License** | LGPL v2.1 (free) | Commercial subscription required |
| **References** | [WildFly Documentation](https://www.wildfly.org/documentation/) | [JBoss EAP Documentation](https://access.redhat.com/documentation/en-us/jboss_enterprise_application_platform) |

# WildFly Operator vs. JBoss EAP Operator

Alauda Platform provides the **WildFly Operator**, which simplifies Java application deployment and operations in Kubernetes environments.  
The WildFly Operator is a community project, maintained by the WildFly community, and differs from Red Hat’s **JBoss EAP Operator**.

| Category | WildFly Operator | JBoss EAP Operator |
|----------|------------------|--------------------|
| **Underlying Software** | WildFly (open-source) | JBoss EAP (enterprise, Red Hat supported) |
| **Image Building** | Users build their own application images with required dependencies (JAR/WAR) | Official JBoss EAP base images with commercial JARs included |
| **License** | Apache License 2.0 | Commercial license, Red Hat subscription required |
| **Operator Capabilities** | Manages WildFly application deployment, scaling, and configuration; compatible with JBoss EAP workloads | Manages JBoss EAP instances with enterprise-level support and additional features |
| **Support Scope** | Community self-support | Red Hat official support: bug fixes, patches, security updates |
| **References** | [WildFly Kubernetes Docs](https://docs.wildfly.org/) | [Red Hat JBoss EAP Operator Docs](https://access.redhat.com/documentation) |

# Operator Usage Guide

For detailed instructions on how to  manage applications with the WildFly Operator, please refer to the official user guide:  
👉 [WildFly Operator User Guide](https://docs.wildfly.org/wildfly-operator/user-guide.html)

# Responsibilities

## Platform Responsibilities
We ensure the availability of the WildFly Operator on the Alauda platform and provide:
- Availability and integration of the WildFly Operator on the platform
- Troubleshooting Kubernetes-level issues (e.g., networking, storage, resource scheduling)
- Guidance on proper use of Operator CRs (Custom Resources)
- Deployment-related configuration guidance (YAML/CR examples, log troubleshooting methods)

We do **not** provide:
- Official WildFly JARs or middleware dependencies (users should rely on community-provided JARs/images)
- Building/compiling user Java application images
- Application-level code issue resolution (business logic bugs, dependency conflicts, performance tuning)

## User Responsibilities
Users deploying with the WildFly Operator are responsible for:
- Preparing and compiling Java application images (based on community WildFly or custom base images)
- Ensuring correctness of application code and dependencies
- Troubleshooting and fixing business logic issues
- Procuring Red Hat subscriptions if enterprise features (e.g., JBoss EAP security patches) are required

# Summary
The WildFly Operator provided on the platform is the **community open-source version**, designed to simplify deployment and basic operations of Java applications in Kubernetes.  
Compared with the Red Hat JBoss EAP Operator, it does not provide commercial support, official images, or commercial JAR maintenance.  
Responsibility boundaries are clear: **Platform handles Kubernetes operations and Operator availability; users handle application development, image building, and business troubleshooting**.
