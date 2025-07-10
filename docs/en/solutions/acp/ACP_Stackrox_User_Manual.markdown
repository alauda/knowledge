---
id: KB250500010
---
# ACP Security User Manual

## Overview
ACP adopts StackRox to implement its security features. StackRox provides comprehensive security capabilities for containers and Kubernetes, covering areas such as vulnerability management, runtime security, compliance checks, infrastructure security, network security, and incident response. This document outlines several common security scenarios and how to address them using StackRox. Since ACS (Advanced Cluster Security) already offers well-documented guidance for StackRox, this document will frequently reference the ACS documentation.

## Functionality Classification and Scenarios

### 1. Vulnerability Management
**Function Description**: Scans container images, nodes, and Kubernetes components to identify and manage vulnerabilities (e.g., CVEs), supporting security checks during build and deploy phases.

**Supported Scenarios**:
- **Scenario 1: Image Security**

- **Scenario 1.1: Scan Container Images for CVEs and Malware Before Deployment**
  - **Description**: Scan container images before deploying to ensure no critical or high vulnerabilities.
  - **Expected Result**: Images are free of critical/high vulnerabilities, safe for deployment.
  - **Operational Steps**:
    1. **Configure Build Policies**:
       - [Create Vulnerability Policy](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-security-policies#con-policy-categories_about-security-policies)
    2. **Ensure Registry Integration**:
       - Go to **Platform Configuration → Integrations**.
       - Under "Image Integration," check if your registry is integrated.
       - If not, configure manually.

- **Scenario 1.2: Scan Images Directly Using roxctl**
  - **Description**: Use the roxctl CLI tool to scan container images in CI/CD pipelines and obtain immediate vulnerability scan results.
  - **Expected Result**: Quickly retrieve vulnerability information for images for manual inspection or other automated processes.
  - **Operational Steps**:
    1. **Ensure roxctl is Installed**:
       - Refer to [Installing the roxctl CLI](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html-single/roxctl_cli/index) to install roxctl.
    2. **Configure Authentication**:
       - Generate an API token: In the Stackrox portal, navigate to **Platform Configuration → Integrations** and generate an API token.
       - Export the token: `export ROX_API_TOKEN=<api_token>`
       - Export the central address: `export ROX_CENTRAL_ADDRESS=<central_address>`
    3. **Scan the Image**:
       - Use the command: `roxctl image scan --image=<image_registry>/<image_name>`
       - Example: `roxctl image scan --image=docker.io/library/nginx:latest`
    4. **Parse Scan Results**:
       - Scan results are output in JSON format, including details of components and vulnerabilities in the image.
    5. **Check the policy**:
       - Use the command: `roxctl image check --image=docker.io/library/nginx:latest`
       - [Check the policy](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html-single/roxctl_cli/index#checking-deployment-yaml-files_checking-policy-compliance)

- **Scenario 1.3: Generate SBOM to Ensure Software Supply Chain Security**
  - **Description**: Generate a Software Bill of Materials (SBOM) for container images to get a detailed overview of all software components, dependencies, and libraries.
  - **Expected Result**: Users can generate and analyze SBOMs to ensure compliance with supply chain security standards (e.g., NIST Executive Order).
  - **Operational Steps**:
    1. **Scan the Image**:
       - Go to Vulnerability Management  Results and locate the image.
    2. **View SBOM**:
       - Navigate to the image details page in the Stackrox portal to view the generated SBOM.
    3. **Export SBOM**:
       - Download the SBOM for further analysis or compliance purposes.
    4. **Generate SBOM with cli**:
       - Use the command: `roxctl image sbom --image=docker.io/library/nginx:latest > sbom.json`
  - **ACS Documentation Link**: [Generating SBOMs](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-vulnerabilities#sbom-generate_scanner-generate-sbom)

- **Scenario 1.4: Ensure Only Signed and Verified Images Are Deployed**
  - **Description**: Use image signature verification to ensure only signed images from trusted sources are deployed.
  - **Expected Result**: Unsigned or unverified images are blocked from deployment.
  
  - **Operational Steps**:
    1. **Configure Signature Integration**:
       - Go to **Platform Configuration → Integrations**.
       - Add Cosign public keys for signature verification.
    2. **Create Signature Policy**:
       - Go to **Platform Configuration → Policies**.
       - Create a policy to reject unsigned or unverified images.
    3. **Enable Enforcement**:
       - Set the policy lifecycle stage to "Deploy" and enable enforcement.
    4. **Test the Policy**:
       - Attempt to deploy an unsigned image and verify it is blocked.
  - **ACS Documentation Link**: [Verifying Image Signatures](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/verify-image-signatures)

### 2. Runtime Security
**Function Description**: Monitors container runtime behavior, detects anomalous activities (e.g., privilege escalation, unauthorized processes), and triggers alerts, with customizable policies to prevent high-risk behaviors.

**Supported Scenarios**:
- **Scenario 2: Test Detection of Container Escape Attempts**
  - **Description**: Detect behaviors like privileged containers or host mounts that could lead to container escapes via policy enforcement.
  - **Expected Result**: Alerts are triggered for such behaviors, notifying administrators.
  
  - **Operational Steps**:
    1. **Configure Security Policies**:
       - Go to **Platform Configuration → Policies**.
       - Enable policies related to container escape, such as:
         - Host Network
         - Host PID
         - Host IPC
         - Privileged Container
         - Privilege Escalation
         - Writable Host Mount
       - Set lifecycle stage to "Deploy" or "Runtime."
       - Enable enforcement.
    2. **Test the Policies**:
       - Deploy a container with HostNetwork enabled.
       - Deploy a privileged container.
       - Deploy a container with a writable host mount.
       - Verify Stackrox detects these and triggers alerts or blocks deployment.
    3. **Review Alerts and Violations**:
       - Check the Stackrox portal for violations.
       - Ensure alerts are generated for risky configurations.
  - **ACS Documentation Link**: [Managing Security Policies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-security-policies)

- **Scenario 3: Monitor for Abnormal Container Behavior and Alerts**
  - **Description**: Continuously monitor container runtime activities to identify anomalies (e.g., unusual network traffic or processes).
  - **Expected Result**: No undetected anomalous activities, with alerts generated for policy violations.
  
  - **Operational Steps**:
    1. **Configure Runtime Security Policies**:
       - Go to **Platform Configuration → Policy Management**.
       - Enable runtime policies, such as detecting privileged command execution or network scanning.
       - Set the lifecycle stage to "Runtime".
       - Enable enforcement or set notifications.
    2. **Set Up Notifications**:
       - Go to **Platform Configuration → Integrations**.
       - Configure notifiers (e.g., email, Slack) to send alerts when violations occur.
  - **ACS Documentation Link**: [Managing Security Policies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-security-policies)

- **Scenario 4: IDS Detects and Blocks Suspicious Activity**
  - **Description**: Use runtime security features to detect anomalous behavior and automatically respond with actions like blocking or isolating affected workloads.
  - **Expected Result**: Suspicious activities are detected and automatically blocked, reducing security risks.
  - **Operational Steps**:
    1. **Configure Runtime Security Policies**:
       - Go to **Platform Configuration → Policy Management**.
       - Create or enable policies to detect anomalous behavior (e.g., abnormal process execution, network traffic).
    2. **Set Up Automatic Responses**:
       - Configure response methods in the policies, such as automatically stopping or deleting affected Pods.
    3. **Test the Policies**:
       - Simulate suspicious behavior in a test environment and verify that the policies correctly detect and respond.
    4. **Monitor and Review**:
       - Regularly check runtime violation records in the Stackrox portal to ensure effective responses.
  - **ACS Documentation Link**: 
    - [Managing Security Policies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-security-policies)
    - [Network Baseline](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/manage-network-policies#use-network-baselining-ng20_manage-network-policies) 
    - [Enabling alerts on baseline violations in the network graph ](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/manage-network-policies#enable-alert-on-baseline-violations-ng20_manage-network-policies)

- **Scenario 5: Identifying the operating system of the base image**
  - **Description**: Use custom policies to detect the base image’s operating system for containers and reject the creation of workloads that do not meet specified requirements.
  - **Expected Result**: Only workloads with a compliant base-image operating system can be created.
  - **Operational Steps**:
    1. **Create Custom Policies**:
       - Go to **Platform Configuration → Policy Management**.
       - Create a new policy and select `Image contents` -> `Image OS` as the policy Rules.
    2. **Enable Enforcement**:
       - Set the policy lifecycle stage to "Deploy" and enable enforcement to block non-compliant workloads.
    3. **Test the Policy**:
       - Attempt to deploy a workload with a non-compliant base image in a test environment and verify that it is blocked.
  - **ACS Documentation Link**: 
    - [Managing Security Policies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-security-policies)
    - [Base image](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html-single/operating/index#identify-operating-system-of-the-base-image_vulnerability-management-dashboard)

### 3. Compliance and Auditing
**Function Description**: Audits the environment to ensure compliance with industry standards (e.g., CIS, PCI, HIPAA) and generates compliance reports.

**Supported Scenarios**:
- **Scenario 6: Maintain Compliance with Industry Standards**

  - **Description**: Run compliance scans to ensure the environment meets required standards.

  - **Expected Result**: Compliance reports show adherence to standards, with deviations identified for remediation.
  
  - **Operational Steps**:
    1. **Select Compliance Profiles**:
       - Go to **Compliance -> Dashboard**.
  
  - **ACS Documentation Link**: [Managing Compliance](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/managing-compliance)

### 4. Network Security
**Function Description**: Manages network policies to control traffic between pods and external networks, ensuring secure communication.

**Supported Scenarios**:
- **Scenario 7: Implement Network Policies for Isolation**

  - **Description**: Define and enforce network policies to isolate traffic and prevent unauthorized access.
  
  - **Expected Result**: Network traffic is restricted, reducing the attack surface.

  - **Operational Steps**:
    1. **Visualize the Network**:
       - Use Stackrox network graph to understand network topology.
    2. **Generate Network Policies**:
       - Generating network policies in the network graph.
    3. **Apply Policies**:
       - Apply policies and monitor network graph to verify implementation.
    4. **Regularly Review**:
       - Update policies based on changes and monitor compliance.
    5. **Alert on baseline violation**:
       - Alert unexpected traffic: Select a workload, then in the `Baseline` tab, toggle on `Alert on baseline violations`. 
  - **ACS Documentation Link**: [Managing Network Policies](https://docs.redhat.com/en/documentation/red_hat_advanced_cluster_security_for_kubernetes/4.7/html/operating/manage-network-policies#network-graph-simulate-generate)

### 5. Incident Response and Notifications
**Function Description**: Provides alerting mechanisms and integrations to support automated and documented incident response workflows.
**Supported Scenarios**:
- **Scenario 9: Test Incident Response Procedures and Alerting**

  - **Description**: Configure notification integrations, test alert triggering, and response workflows.
  
  - **Expected Result**: Alerts trigger timely responses
  
  - **Operational Steps**:
    1. **Configure Notifiers**:
       - Go to **Platform Configuration → Integrations**.
       - Set up notifiers (e.g., email, Slack).
    2. **Configure Security Policies**:
       - Ensure policies trigger alerts, e.g., for privileged containers.
    3. **Configure Policy behavior**:
       - Ensure `Notifiers` are set up as part of the policy creation process: `Policy behavior` -> `Actions` -> `Notifiers`
    4. **Simulate Security Events**:
       - Deploy a container that violates policies and verify alert triggering.
    5. **Review Incident Response**:
       - Check alert receipt and follow response procedures.
    6. **Document Results**:
       - Record the effectiveness of alerts and response procedures.