---
products: 
   - Alauda Container Platform
kind:
   - Solution
id: KB250500013
---
# Full-Stack Automation with ACP

This guide provides a step-by-step approach to **fully automate** the deployment of a Kubernetes cluster, **Alauda Service Mesh**, essential extensions (e.g., logging, monitoring, networking), and a sample application on the **ACP platform**. By harnessing **declarative YAML files**, this process eliminates manual intervention, ensuring consistency, repeatability, and efficiency. Whether using shell scripts, Ansible, or tools like Argo CD, this guide empowers you to streamline the entire workflow **from cluster creation to application rollout** with minimal effort.

---

## Overview

This guide demonstrates how to use **declarative APIs** to:

1. **Create a Kubernetes cluster** on the ACP platform using concise YAML configurations.
2. **Install Alauda Service Mesh** (Istio control plane, CNI data plane, cross-cluster gateways) on the workload cluster.
3. **Install extensions** for logging, monitoring, and networking to enhance cluster functionality.
4. **Deploy a sample application** with associated project and namespace configurations.

---

## Prerequisites

Before starting, ensure the following:

- **ACP platform access**: Valid credentials and endpoint details for the DCS platform.
- **kubectl with ACP plugin**: Configured to interact with global and workload clusters using `kubectl acp`.

---

## 1. Creating a Cluster, Extensions, and Application with Declarative YAML

### 1.1 Cluster API Overview

The **Cluster API** extends Kubernetes’ declarative API to manage cluster lifecycles using CRDs and controllers. It enables consistent, repeatable cluster provisioning and upgrades across multi‑cloud and hybrid environments.

### 1.2 Creating a Kubernetes Cluster (`cluster.yaml`)

**Objective**: Declaratively provision a Kubernetes cluster on DCS infrastructure.

```yaml
# cluster.yaml

# Secret: DCS platform credentials
---
apiVersion: v1
data:
  authUser: {{ .Values.global.dcs_resource.user }}
  authKey: {{ .Values.global.dcs_resource.authkey }}
  endpoint: {{ .Values.global.dcs_resource.endpoint }}
kind: Secret
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: {{ .Values.global.cluster.name }}-credential-secret
  namespace: cpaas-system
type: Opaque
---

# Cluster: High-level cluster definition
apiVersion: cluster.x-k8s.io/v1beta1
kind: Cluster
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
    capi.cpaas.io/resource-group-version: infrastructure.cluster.x-k8s.io/v1beta1
    capi.cpaas.io/resource-kind: DCSCluster
    cpaas.io/kube-ovn-version: {{ .Values.plugin.kubeovn.version }}
    cpaas.io/kube-ovn-join-cidr: {{ .Values.plugin.kubeovn.join_cidr }}
  labels:
    cluster-type: DCS
  name: "{{ .Values.global.cluster.name }}"
  namespace: cpaas-system
spec:
  clusterNetwork:
    pods:
      cidrBlocks:
        - {{ .Values.global.cluster.pod_cidr }}
    services:
      cidrBlocks:
        - {{ .Values.global.cluster.service_cidr }}
  controlPlaneRef:
    apiVersion: controlplane.cluster.x-k8s.io/v1beta1
    kind: KubeadmControlPlane
    name: "{{ .Values.global.cluster.name }}-control-plane"
  infrastructureRef:
    apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
    kind: DCSCluster
    name: "{{ .Values.global.cluster.name }}"
---

# DCSCluster: Infrastructure configuration
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSCluster
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}"
  namespace: cpaas-system
spec:
  controlPlaneLoadBalancer: 
    host: {{ .Values.global.cluster.controlplane_endpoint }}
    port: 6443
    type: external
  credentialSecretRef:
    name: "{{ .Values.global.cluster.name }}-credential-secret"
  controlPlaneEndpoint:
    host: {{ .Values.global.cluster.controlplane_endpoint }}
    port: 6443
  networkType: kube-ovn
  site:  {{ .Values.global.dcs_resource.site }}
---

# KubeadmControlPlane: Control plane configuration
apiVersion: controlplane.cluster.x-k8s.io/v1beta1
kind: KubeadmControlPlane
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-control-plane"
  namespace: cpaas-system
spec:
  kubeadmConfigSpec:
    users:
      - name: root
        passwd: xxxx
    format: ignition
    files:
      - path: /etc/kubernetes/admission/psa-config.yaml
        owner: "root:root"
        permissions: "0644"
        content: |
          apiVersion: apiserver.config.k8s.io/v1
          kind: AdmissionConfiguration
          plugins:
            - name: PodSecurity
              configuration:
                apiVersion: pod-security.admission.config.k8s.io/v1
                kind: PodSecurityConfiguration
                defaults:
                  enforce: "privileged"
                  enforce-version: "latest"
                  audit: "baseline"
                  audit-version: "latest"
                  warn: "baseline"
                  warn-version: "latest"
                exemptions:
                  usernames: []
                  runtimeClasses: []
                  namespaces:
                    - kube-system
                    - cpaas-system
      - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
        owner: "root:root"
        permissions: "0644"
        content: |
          {
            "apiVersion": "kubelet.config.k8s.io/v1beta1",
            "kind": "KubeletConfiguration",
            "protectKernelDefaults": true,
          }
      - path: /etc/kubernetes/encryption-provider.conf
        owner: root:root
        permissions: "0644"
        content: |
          apiVersion: apiserver.config.k8s.io/v1
          kind: EncryptionConfiguration
          resources:
            - resources:
              - secrets
              providers:
              - aescbc:
                 keys:
                 - name: key1
                   secret: 3udSs4eXILckbtXZ4C8Sx0hWJpQhRDA7mGjiGZEQhWc=
      - path: /etc/kubernetes/audit/policy.yaml
        owner: root:root
        permissions: "0644"
        content: |
          apiVersion: audit.k8s.io/v1
          kind: Policy
          # Don't generate audit events for all requests in RequestReceived stage.
          omitStages:
            - "RequestReceived"
          rules:
            # The following requests were manually identified as high-volume and low-risk,
            # so drop them.
            - level: None
              users:
                - system:kube-controller-manager
                - system:kube-scheduler
                - system:serviceaccount:kube-system:endpoint-controller
              verbs: ["get", "update"]
              namespaces: ["kube-system"]
              resources:
                - group: "" # core
                  resources: ["endpoints"]
            # Don't log these read-only URLs.
            - level: None
              nonResourceURLs:
                - /healthz*
                - /version
                - /swagger*
            # Don't log events requests.
            - level: None
              resources:
                - group: "" # core
                  resources: ["events"]
            # Don't log devops requests.
            - level: None
              resources:
                - group: "devops.alauda.io"
            # Don't log get list watch requests.
            - level: None
              verbs: ["get", "list", "watch"]
            # Don't log lease operation
            - level: None
              resources:
                - group: "coordination.k8s.io"
                  resources: ["leases"]
            # Don't log access review and token review requests.
            - level: None
              resources:
                - group: "authorization.k8s.io"
                  resources: ["subjectaccessreviews", "selfsubjectaccessreviews"]
                - group: "authentication.k8s.io"
                  resources: ["tokenreviews"]
            # Don't log imagewhitelists and namespaceoverviews operations
            - level: None
              resources:
                - group: "app.alauda.io"
                  resources: ["imagewhitelists"]
                - group: "k8s.io"
                  resources: ["namespaceoverviews"]
            # Secrets, ConfigMaps can contain sensitive & binary data,
            # so only log at the Metadata level.
            - level: Metadata
              resources:
                - group: "" # core
                  resources: ["secrets", "configmaps"]
            # devops installmanifests and katanomis can contains huge data and sensitive data, only log at the Metadata level.
            - level: Metadata
              resources:
                - group: "operator.connectors.alauda.io"
                  resources: ["installmanifests"]
                - group: "operators.katanomi.dev"
                  resources: ["katanomis"]
            # Default level for known APIs
            - level: RequestResponse
              resources:
                - group: "" # core
                - group: "aiops.alauda.io"
                - group: "apps"
                - group: "app.k8s.io"
                - group: "authentication.istio.io"
                - group: "auth.alauda.io"
                - group: "autoscaling"
                - group: "asm.alauda.io"
                - group: "clusterregistry.k8s.io"
                - group: "crd.alauda.io"
                - group: "infrastructure.alauda.io"
                - group: "monitoring.coreos.com"
                - group: "operators.coreos.com"
                - group: "networking.istio.io"
                - group: "extensions.istio.io"
                - group: "install.istio.io"
                - group: "security.istio.io"
                - group: "telemetry.istio.io"
                - group: "opentelemetry.io"
                - group: "networking.k8s.io"
                - group: "portal.alauda.io"
                - group: "rbac.authorization.k8s.io"
                - group: "storage.k8s.io"
                - group: "tke.cloud.tencent.com"
                - group: "devopsx.alauda.io"
                - group: "core.katanomi.dev"
                - group: "deliveries.katanomi.dev"
                - group: "integrations.katanomi.dev"
                - group: "artifacts.katanomi.dev"
                - group: "builds.katanomi.dev"
                - group: "versioning.katanomi.dev"
                - group: "sources.katanomi.dev"
                - group: "tekton.dev"
                - group: "operator.tekton.dev"
                - group: "eventing.knative.dev"
                - group: "flows.knative.dev"
                - group: "messaging.knative.dev"
                - group: "operator.knative.dev"
                - group: "sources.knative.dev"
                - group: "operator.devops.alauda.io"
                - group: "flagger.app"
                - group: "jaegertracing.io"
                - group: "velero.io"
                  resources: ["deletebackuprequests"]
                - group: "connectors.alauda.io"
                - group: "operator.connectors.alauda.io"
                  resources: ["connectorscores", "connectorsgits", "connectorsocis"]
            # Default level for all other requests.
            - level: Metadata
    preKubeadmCommands:
      - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
      - mkdir -p /run/cluster-api && restorecon -Rv /run/cluster-api
    clusterConfiguration:
      imageRepository: cloud.alauda.io/alauda
      dns:
        imageTag: 1.11.3-v4.0.4
      etcd:
        local:
          imageTag: v3.5.18
      apiServer:
        extraArgs:
          audit-log-format: json
          audit-log-maxage: "30"
          audit-log-maxbackup: "10"
          audit-log-maxsize: "200"
          profiling: "false"
          audit-log-mode: batch
          audit-log-path: /etc/kubernetes/audit/audit.log
          audit-policy-file: /etc/kubernetes/audit/policy.yaml
          tls-cipher-suites: "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384"
          encryption-provider-config: /etc/kubernetes/encryption-provider.conf
          admission-control-config-file: /etc/kubernetes/admission/psa-config.yaml
        extraVolumes:
          - name: vol-dir-0
            hostPath: /etc/kubernetes
            mountPath: /etc/kubernetes
            pathType: Directory
      #          cloud-provider: external
      controllerManager:
        extraArgs:
          bind-address: "::"
          profiling: "false"
          #          cloud-provider: external
          flex-volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
      scheduler:
        extraArgs:
          bind-address: "::"
          profiling: "false"
    initConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
          provider-id: PROVIDER_ID
          #            cloud-provider: external
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          protect-kernel-defaults: "true"
    joinConfiguration:
      patches:
        directory: /etc/kubernetes/patches
      nodeRegistration:
        kubeletExtraArgs:
          node-labels: "kube-ovn/role=master"
          provider-id: PROVIDER_ID
          #            cloud-provider: external
          volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
          protect-kernel-defaults: "true"
  machineTemplate:
    infrastructureRef:
      apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
      kind: DCSMachineTemplate
      name: "{{ .Values.global.cluster.name }}-control-plane"
  replicas: 3
  version: v1.31.6
---

# ControlPlane VM Template
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSMachineTemplate
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-control-plane"
  namespace: cpaas-system
spec:
  template:
    spec:
      vmTemplateName: {{ .Values.global.dcs_resource.vm_template_name }}
      resource:
        type:  {{ .Values.global.dcs_resource.computing_resource_type }}
        name: {{ .Values.global.dcs_resource.computing_resource }}
      vmConfig:
        dvSwitchName:  {{ .Values.global.dcs_resource.dvswitch_name }}
        portGroupName:  {{ .Values.global.dcs_resource.portgroup_name }}
        dcsMachineCpuSpec:
          quantity: 8
        dcsMachineMemorySpec:
          quantity: 16380
        dcsMachineDiskSpec:
          - quantity: 200
            datastoreClusterName: {{ .Values.global.dcs_resource.datastore_cluster_name }}
            systemVolume: true
      ipHostPoolRef:
        name: "{{ .Values.global.cluster.name }}-control-plane"
---

# ControlPlane IP/Hostname Pool
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSIpHostnamePool
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-control-plane"
  namespace: cpaas-system
spec:
  pool:
  {{- range .Values.global.cluster.controlplane.pool }}
    - ip: {{ .ip | quote }}
      mask: {{ .mask | quote }}
      gateway: {{ .gateway | quote }}
      dns: {{ .dns | quote }}
      hostname: {{ .hostname | quote }}
  {{- end }}
---

# Worker node IP/Hostname Pool
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSIpHostnamePool
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-worker-node"
  namespace: cpaas-system
spec:
  pool:
  {{- range .Values.global.cluster.worker.pool }}
    - ip: {{ .ip | quote }}
      mask: {{ .mask | quote }}
      gateway: {{ .gateway | quote }}
      dns: {{ .dns | quote }}
      hostname: {{ .hostname | quote }}
  {{- end }}
---

# Worker node VM Template
apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
kind: DCSMachineTemplate
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-worker-node"
  namespace: cpaas-system
spec:
  template:
    spec:
      vmTemplateName: {{ .Values.global.dcs_resource.vm_template_name }}
      resource:
        type:  {{ .Values.global.dcs_resource.computing_resource_type }}
        name: {{ .Values.global.dcs_resource.computing_resource }}
      vmConfig:
        dvSwitchName: {{ .Values.global.dcs_resource.dvswitch_name }}
        portGroupName:  {{ .Values.global.dcs_resource.portgroup_name }}
        dcsMachineCpuSpec:
          quantity: 16
        dcsMachineMemorySpec:
          quantity: 32760
        dcsMachineDiskSpec:
          - quantity: 200
            datastoreClusterName: {{ .Values.global.dcs_resource.datastore_cluster_name }}
            systemVolume: true
      ipHostPoolRef:
        name: "{{ .Values.global.cluster.name }}-worker-node"
---

# Bootstrap Configuration
apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
kind: KubeadmConfigTemplate
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-worker-config-tempalte"
  namespace: cpaas-system
spec:
  template:
    spec:
      format: ignition
      users:
        - name: root
          passwd: xxxxx
      files:
        - path: /etc/kubernetes/patches/kubeletconfiguration0+strategic.json
          owner: "root:root"
          permissions: "0644"
          content: |
            {
              "apiVersion": "kubelet.config.k8s.io/v1beta1",
              "kind": "KubeletConfiguration",
              "protectKernelDefaults": true,
            }
      preKubeadmCommands:
        - while ! ip route | grep -q "default via"; do sleep 1; done; echo "NetworkManager started"
        - mkdir -p /run/cluster-api && restorecon -Rv /run/cluster-api
      joinConfiguration:
        patches:
          directory: /etc/kubernetes/patches
        nodeRegistration:
          kubeletExtraArgs:
            provider-id: PROVIDER_ID
            volume-plugin-dir: "/opt/libexec/kubernetes/kubelet-plugins/volume/exec/"
            v: "3"
---

# Worker node Deployment
apiVersion: cluster.x-k8s.io/v1beta1
kind: MachineDeployment
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "-999"
  name: "{{ .Values.global.cluster.name }}-worker-node"
  namespace: cpaas-system
spec:
  clusterName: {{ .Values.global.cluster.name }}
  replicas: {{ .Values.global.cluster.worker.replicas }}
  selector:
    matchLabels: null
  template:
    spec:
      bootstrap:
        configRef:
          apiVersion: bootstrap.cluster.x-k8s.io/v1beta1
          kind: KubeadmConfigTemplate
          name: "{{ .Values.global.cluster.name }}-worker-config-tempalte"
          namespace: cpaas-system
      clusterName: {{ .Values.global.cluster.name }}
      infrastructureRef:
        apiVersion: infrastructure.cluster.x-k8s.io/v1beta1
        kind: DCSMachineTemplate
        name: "{{ .Values.global.cluster.name }}-worker-node"
        namespace: cpaas-system
      version: v1.31.6
```

**Steps**:

1. Switch to the global cluster context:
   
   ```bash
   kubectl acp set-cluster global
   ```

2. Apply the cluster configuration:
   
   ```bash
   kubectl apply -f cluster.yaml
   ```

---

### 1.3 Installing Cluster Extensions (`extensions.yaml`)

```yaml
# extensions.yaml

---
# log collector
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    cpaas.io/display-name: logagent
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: logagent
spec:
  config:
    crossClusterDependency:
      logcenter: global
      logclickhouse: null
    dataSource:
      audit: true
      event: true
      kubernetes: false
      platform: false
      system: true
      workload: true
    storage:
      type: ElasticSearch
  pluginName: logagent
  valuesOverride:
    chart-alauda-log-agent:
      nevermore:
        dataDirName: var/lib/
        systemLogFromJournal: true
---

# monitor agent
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    cpaas.io/display-name: victoriametrics
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: victoriametrics
spec:
  config:
    agentOnly: true
    agentReplicas: 1
    components:
      nodeExporter:
        port: 9100
      vmagent:
        scrapeInterval: 60
        scrapeTimeout: 45
    crossClusterDependency:
      victoriametrics: global
    replicas: 1
  pluginName: victoriametrics

---

# networking: metallb
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "2"
    cpaas.io/display-name: metallb
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: metallb
spec:
  pluginName: metallb

---

#netwroking: multus
apiVersion: cluster.alauda.io/v1alpha1
kind: ClusterPluginInstance
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "1"
    cpaas.io/display-name: multus
  labels:
    create-by: cluster-transformer
    manage-delete-by: cluster-transformer
    manage-update-by: cluster-transformer
  name: multus
spec:
  pluginName: multus
```

**Steps**:

1. Switch to the workload cluster context:
   
   ```bash
   kubectl acp set-cluster <workload-cluster>
   ```

2. Apply the extensions configuration:
   
   ```bash
   kubectl apply -f extensions.yaml
   ```

---

### 1.4 Installing Alauda Service Mesh (`mesh.yaml`)

**Objective**: Declaratively install and configure Alauda Service Mesh, including the Istio control plane, CNI for sidecar networking, east-west gateways for cross-cluster communication, and observability components for tracing and monitoring.

```yaml
# mesh.yaml
apiVersion: asm.alauda.io/v1alpha1
kind: ServiceMesh
metadata:
  labels:
    servicemesh.cpaas.io/managedBy: operator
    asm.cpaas.io/meshgroup: "multi-cluster-mesh"
    asm.cpaas.io/cluster: "{{ .Values.global.cluster.name }}"
  name: "{{ .Values.global.cluster.name }}"
  namespace: cpaas-system
  annotations:
    argocd.argoproj.io/sync-wave: "100"
    asm.cpaas.io/display-name: ''
spec:
  withoutIstio: false
  istioVersion: "1.22.4+202408291030"
  cluster: "{{ .Values.global.cluster.name }}"
  registryAddress: {{ .Values.global.registry.address }}
  multiCluster:
    enabled: true
    isMultiNetwork: true
  istioSidecarInjectorPolicy: false
  ipranges:
    ranges:
      - '*'
  ingressH2Enabled: false
  ingressScheme: https
  caConfig:
    certmanager: {}
  componentConfig:
    - name: istioCni
      group: istio
      replicaCount: 0
      resources: {}
      hpaSpec:
        enabled: false
      cni:
        namespace: kube-system
    - name: istiod
      group: istio
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.5'
          memory: 512Mi
        limits:
          cpu: '2'
          memory: 2048Mi
    - name: asmController
      group: controller
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 512Mi
        limits:
          cpu: '1'
          memory: 1Gi
    - name: eastwestGateways
      group: istio
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 128Mi
        limits:
          cpu: '2'
          memory: 1024Mi
      deployMode: FixedRequired
      parameters: null
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: "kubernetes.io/os"
                    operator: In
                    values:
                      - "linux"
    - name: flagger
      group: controller
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 128Mi
        limits:
          cpu: '1'
          memory: 512Mi
    - name: jaegerCollector
      group: tracer
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 512Mi
        limits:
          cpu: '3'
          memory: 512Mi
    - name: jaegerQuery
      group: tracer
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 512Mi
        limits:
          cpu: '1'
          memory: 512Mi
    - name: asmCore
      group: controller
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 128Mi
        limits:
          cpu: '1'
          memory: 512Mi
    - name: asmOtelCollector
      group: tracer
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 512Mi
        limits:
          cpu: '2'
          memory: 1Gi
    - name: asmOtelCollectorLB
      group: tracer
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 512Mi
        limits:
          cpu: '1'
          memory: 1Gi
    - name: tier2ingressGateways
      group: istio
      replicaCount: 1
      hpaSpec:
        enabled: false
      resources:
        requests:
          cpu: '0.25'
          memory: 128Mi
        limits:
          cpu: '2'
          memory: 1024Mi
  requiredAntiAffinity: true
  elasticsearch:
    url: "{{ .Values.global.elasticsearch.url }}"
    isDefault: true
    cluster: "global"
  redis:
    address: "{{ .Values.global.cluster.redis.address }}"
    authType: basic
    enabled: true
    kind: sentinel
    masterName: mymaster
    # This secret provides credentials for connecting to an external Redis sentinel. 
    # It must be present in the workload cluster for authentication to succeed
    # example:
    #
    #  apiVersion: v1
    #  data:
    #    ASM_CORE_REDIS_PASSWORD: xxxxx
    #  kind: Secret
    #  metadata:
    #    labels:
    #      asm.cpaas.io/basic-auth: "true"
    #    annotations:
    #      argocd.argoproj.io/sync-wave: "20"
    #    name: external-redis-basic-auth-sentinel
    #    namespace: cpaas-system
    #  type: Opaque
    #
    secretName: external-redis-basic-auth-sentinel
  istioSidecar:
    resources:
      requests:
        cpu: 100m
        memory: 128Mi
      limits:
        cpu: 500m
        memory: 512Mi
  istioConfig:
    cni:
      enabled: true
    defaultHttpRetryPolicy:
      attempts: 2
  traceSampling: 100
  globalIngressHost: "{{ .Values.global.platform_url }}"
  monitorType: victoriametrics
  prometheusURL: "{{ .Values.global.cluster.prometheus.url }}"
  isDefaultMonitor: true
  clusterType: Baremetal
  kafka:
    enabled: false
```

---

**Steps**:

1. Switch to the workload cluster context:
   
   ```bash
   kubectl acp set-cluster global
   ```

2. Apply the ServiceMesh configuration:
   
   ```bash
   kubectl apply -f mesh.yaml
   ```

### 1.5 Deploying an Application

This section covers creating a project, namespace, resource quotas, and deploying a **Hello World** application.

#### 1.5.1 Creating a Project (`project.yaml`)

**Objective**: Create a project to organize resources and associate it with the workload cluster.

```yaml
# project.yaml
apiVersion: auth.alauda.io/v1
kind: Project
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "99"
    cpaas.io/display-name: ''
    cpaas.io/description: ''
  labels:
    cpaas.io/project.level: '1'
    cpaas.io/project.parent: ''
  name: demo
  namespace: ''
spec:
  clusters:
    - name: "global"
      quota: {}
    - name: "{{ .Values.global.cluster.name }}"
      quota: {}
```

**Steps**:

1. Switch to the global cluster context:
   
   ```bash
   kubectl acp set-cluster global
   ```

2. Apply the project configuration:
   
   ```bash
   kubectl apply -f project.yaml
   ```

#### 1.5.2 Creating Namespace, ResourceQuota, and LimitRange (`namespace-resources.yaml`)

**Objective**: Set up a namespace with resource quotas and limits for the application.

```yaml
# namespace-resources.yaml
---
apiVersion: "v1"
kind: "Namespace"
metadata: 
  name: "demo-ns"
  annotations:
    argocd.argoproj.io/sync-wave: "1"
    cpaas.io/display-name: ""
  labels: 
    cpaas.io/cluster: "{{ .Values.global.cluster.name }}"
    cpaas.io/project: "demo"
    pod-security.kubernetes.io/enforce: "baseline"
    pod-security.kubernetes.io/audit: "baseline"
    pod-security.kubernetes.io/warn: "baseline"
    cpaas.io/serviceMesh: enabled
    istio.io/rev: 1-22
---
apiVersion: "v1"
kind: "ResourceQuota"
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "2"
  name: "default"
  namespace: "demo-ns"
spec:
  hard: 
    pods: "1000"
---
apiVersion: "v1"
kind: "LimitRange"
metadata:
  annotations:
    argocd.argoproj.io/sync-wave: "2"
  name: "default"
  namespace: "demo-ns"
spec:
  limits: 
  - type: "Container"
```

**Steps**:

1. Switch to the workload cluster context:
   
   ```bash
   kubectl acp set-cluster <workload-cluster>
   ```

2. Apply the namespace and resource configurations:
   
   ```bash
   kubectl apply -f namespace-resources.yaml
   ```

#### 1.5.3 Deploying the Hello World Application (`hello-world.yaml`)

**Objective**: Deploy a sample application with a deployment and service.

```yaml
# hello-world.yaml

# Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-world
  namespace: demo-ns
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec: {...}

---

# Service
apiVersion: v1
kind: Service
metadata:
  name: hello-world
  namespace: demo-ns
  annotations:
    argocd.argoproj.io/sync-wave: "3"
spec: {...}
```

**Steps**:

1. Switch to the workload cluster context:
   
   ```bash
   kubectl acp set-cluster <workload-cluster>
   ```

2. Apply the application configuration:
   
   ```bash
   kubectl apply -f hello-world.yaml
   ```
