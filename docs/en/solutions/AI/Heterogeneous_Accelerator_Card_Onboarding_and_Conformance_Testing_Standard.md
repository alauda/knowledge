---
products:
  - Alauda AI
kind:
  - Article
id: KB261000017
---

# Heterogeneous Accelerator Card Onboarding and Conformance Testing Standard

**Version:** v1.0 Framework Draft · For Discussion and Confirmation  
**Scope:** GPU and NPU accelerator cards intended for onboarding to the unified computing platform, including NVIDIA, AMD, and domestic vendors.  
**Current scope:** Internal application scenarios. Scenarios that expose computing capacity externally are out of scope for this version.

## About This Draft

This draft establishes the framework and terminology for the onboarding standard for discussion and confirmation. Items marked “To be confirmed” or left blank must be completed after agreement based on the first round of measurements and the actual scenario. They are not current decision criteria.

---

## 1. Scope and General Principles

### 1.1 Contents of This Document

This document defines the **declarations, deliverables, test methods, and certification validity period** required when accelerator cards are onboarded to the unified computing platform.

Its purpose is to define information boundaries and verification methods before onboarding, so that cards from different vendors can be managed consistently without creating a separate process for every card model.

### 1.2 General Principles

1. **Use Kubernetes standard mechanisms.** The baseline interface in this version is the standard **Device Plugin**, together with a Prometheus-format exporter. Any proprietary mechanism must explain its relationship to the standard mechanism.
2. **Information must be collectable and semantically clear.** Device properties, metrics, and fault information must be exposed in a collectable form, with their definitions, units, denominators, and sampling windows specified. Information with unclear semantics cannot be included in unified management.
3. **Classify capabilities by level and use them by scenario.** The framework does not make a binary “qualified / unqualified” decision. It certifies a card to a capability level and uses it only in scenarios covered by that level. Failing to reach a higher level does not prevent onboarding for applicable scenarios.
4. **Match declarations to measurements.** Every declaration must have a corresponding verification method. When a declaration differs from the measured result, the measured result prevails and the declaration must be corrected.
5. **Bind certification to versions.** A certification conclusion applies to an exact version combination. Relevant items must be retested after a version change; see section 6.

### 1.3 Responsibility Boundaries

- **Vendor:** Provides device drivers, firmware, onboarding components, capability declarations, compatibility matrices, and technical support.
- **Platform owner:** Manages cluster-side deployment orchestration, resource scheduling, monitoring aggregation, certification levels, and usage scope.
- **Joint issues:** Issues involving the device, driver, runtime, and platform components are investigated jointly according to the agreed ownership.
- **Effect of a certification conclusion:** A conclusion represents the verification result within the **agreed version combination and test scope**. It does not mean that the product is suitable for every business scenario.

### 1.4 Clause Labels

| Label | Meaning |
|---|---|
| **[DEC]** | Vendor declaration used as a basis for classification |
| **[TEST]** | Measured verification item |
| **[DEL]** | Deliverable |

### 1.5 Identifier Overview

| Prefix | Meaning | Location |
|---|---|---|
| **R** | Baseline admission requirements, R1-R11 | Section 3 |
| **L** | Capability levels, L0-L3; L2 has Hard and Soft isolation tiers | Section 2.2 |
| **T** | Test groups, T0-T12; T7 is split into T7a and T7b, for 14 groups in total | Section 5.2 |
| **4.x** | Technical requirement clauses | Section 4 |
| **Appendix A** | Vendor capability declaration | Appendix |
| **Appendix B** | Monitoring metric mapping | Appendix |
| **Appendix C** | Benchmark set, to be completed | Appendix |
| **Appendix D** | Items requiring confirmation | Appendix |
| **Appendix E** | Appendix B example | Appendix |

---

## 2. Onboarding Interfaces, Partitioning, and Capability Levels

### 2.1 Onboarding Interface and Partitioning Method

**Onboarding interfaces and partitioning methods are separate layers and are described separately to avoid mixing the two technical concepts.**

#### A. Onboarding Interface

| Interface | Position |
|---|---|
| **Device Plugin** | The **baseline onboarding interface** for this version. It is used with a Prometheus-format exporter and corresponds to L0. |
| **DRA** | A forward-looking, **optional** interface. Vendors that support it may declare it as an additional capability. |

**[DEC]** A vendor that supports Kubernetes DRA may provide the DRA driver version, supported Kubernetes versions, DeviceClass and ResourceClaim examples, and known limitations. Complete Appendix A.1.

DRA support **does not affect baseline onboarding or capability certification in this version**. Lack of DRA support does not result in a deduction.

Whether an implementation that provides only DRA and no Device Plugin can be accepted as an independent onboarding path must be assessed by the platform based on the target Kubernetes version, DRA maturity, and project requirements. The target Kubernetes version is **to be confirmed**; see Appendix D.1.

#### B. Partitioning Method

The implementation method is not prescribed, but it affects isolation strength, achievable level, and applicable scenarios:

| Implementation method | Typical isolation strength | Achievable level |
|---|---|---|
| Hardware partitioning / hardware virtualization | Usually hard isolation | L2-Hard, subject to measurement |
| Native software partitioning | Subject to measurement | L2-Hard or L2-Soft |
| Software interception through a third-party middleware layer | Usually soft isolation | L2-Soft, subject to measurement |
| No partitioning support | — | L0 / L1 |

Applicable scenarios for the two L2 tiers are defined in section 2.2. **The final classification of every method is determined by the measurements in section 4.2**; this table describes typical cases.

#### C. Common Middleware Layer

A card without native partitioning may use a common middleware layer such as HAMi to obtain partitioning and baseline metrics. This is an **optional path, not an onboarding requirement**. The vendor decides whether to use it; not using it does not affect L0, L1, or L3 certification.

The relevant constraint comes from isolation strength rather than the path itself. Soft isolation does not constitute a fault boundary, so its applicable scenarios follow the L2-Soft rules in section 2.2. This constraint applies equally to all soft-isolation solutions.

### 2.2 Capability Levels

| Level | Capability | Applicable scenarios |
|---|---|---|
| **L0 Whole-card usable** | Whole-card scheduling, automated driver deployment, and readable basic health status | Development, testing, and non-critical workloads |
| **L1 Observable** | L0 plus all required metrics, metric association with Pods / Namespaces, and fault reporting | Production |
| **L2 Partitionable** | L1 plus partitioning represented as a finite set of profiles, with isolation level and fault domain confirmed by measurement | See the tier table below |
| **L3 Scalable training** | L1 plus exposed interconnect domains and verified multi-card and multi-node distributed training | Training and large-model workloads |

**L2 has two isolation tiers.**

| Tier | Condition | Applicable scenarios |
|---|---|---|
| **L2-Hard** | Memory and compute are hard-isolated, **and** an abnormality in one instance does not affect other instances on the same card; both conditions are confirmed by measurement | Cross-department sharing and production inference |
| **L2-Soft** | The two conditions above are not both satisfied | Multi-task sharing within one business group and non-critical inference; do not mix different departments on one card |

L2 and L3 may be combined, and both require L1 first. **A card carrying core business workloads must reach L1. If partitioning is used for core business, the card must be L2-Hard.**

> Fault isolation is used as the basis for L2 tiering rather than as an L2 admission requirement. Making it an admission requirement would exclude all software-partitioning solutions, even though soft partitioning can be appropriate for sharing within one business group. The difference is handled through applicable scenarios rather than admission.

---

## 3. Baseline Admission Requirements

The following are baseline onboarding conditions. They do not concern performance or advanced capabilities; they are prerequisites for cards from multiple vendors to coexist on one manageable platform. If any item is not satisfied, the card cannot normally be onboarded in a manageable and coexistent manner.

Verification stages: **Materials** means checked during material review; **Measurement** means checked by the corresponding test group; **End to end** means checked throughout the assessment.

| ID | Requirement | Verification |
|---|---|---|
| **R1** | Provide a containerized Kubernetes Device Plugin, delivered as a Helm chart or YAML. A DRA-supported implementation may also provide a DRA driver and examples; **DRA support is not a baseline admission requirement in this version** (see section 2.1A). | Materials + T1 |
| **R2** | Driver installation can be completed automatically, through a DaemonSet or an automated script, with no node configuration requiring manual maintenance. | Materials + T1 |
| **R3** | Do not require modification or replacement of the cluster's default scheduler. Vendor admission or scheduling extensions must not affect scheduling of other vendors' resources. | T3 |
| **R4** | Establish a “device → Pod / Namespace” association. If metrics do not directly contain the required labels, provide a workable association method. | T4 |
| **R5** | Provide a compatibility matrix covering the driver, firmware, components, kernel, OS, Kubernetes, and container runtime. | Materials |
| **R6** | Provide a written vulnerability-response and maintenance-period statement. | Materials |
| **R7** | Declared key capabilities match measured results. For example, a hard-isolation declaration must not permit cross-instance memory access or mutual impact in testing. | End to end |
| **R8** | If partitioning is supported, document resource configuration parameters, value ranges, and constraints so they can be packaged as a finite set of manageable resource profiles. If parameters are continuous and cannot be reliably packaged as fixed profiles, document allocation and reclamation semantics. | Materials (Appendix A.2) |
| **R9** | Host permissions required by components are restricted to the necessary scope, and the purpose of every permission can be explained. | T12 |
| **R10** | Document reset granularity and recovery behavior for a card or instance, and the impact on other devices and the host on the same node. **Undeclared node-level impact must not occur.** | Materials + T7a |
| **R11** | Workload containers must not access unauthorized device resources or affect unallocated devices or other workloads through device files, management interfaces, or other means. If a shared control device node must be exposed, document its purpose, access boundary, and potential impact. | T12 |

---

## 4. Technical Requirements

### 4.1 Resource Exposure and Scheduling Semantics

- **[DEC]** Device Plugin resource name or DeviceClass name, and supported Kubernetes version range.
- **[DEC] Resource configuration parameters and allocatable profiles:** Document configuration parameters, value ranges, and constraints. Provide recommended allocatable profiles in an enumerated form, including card model, memory, compute ratio, isolation level, fault domain, and maximum number of instances per card.

  The platform should package these as a finite, manageable set of resource profiles for quota and allocation management. If continuous parameters cannot be reliably packaged as fixed profiles, document allocation and reclamation semantics (corresponding to R8).
- **[DEC]** Exposure method for static attributes (model, memory, nominal compute for each precision, and interconnect bandwidth) and topology attributes (NUMA and interconnect domain): node labels, node annotations, Device attributes, DRA attributes, or the exporter. State where each attribute is exposed.
- **[DEC] Multi-vendor coexistence statement:** Describe the scope and activation conditions of any admission component (Mutating / Validating Webhook) or scheduling extension. If there is no such component, declare “none”.

  **Result requirement (R3):** The component must not unconditionally intercept objects unrelated to the vendor's resources.

  **Required details:** Scope and matching conditions, behavior when the component is unavailable, and impact on other vendors' resources. The platform decides whether to accept the component based on the actual impact.

  > Common scope-limiting methods include `rules`, `namespaceSelector`, `objectSelector`, and resource-name matching. If the scope is broad and the component relies on internal logic to “recognize and pass through” objects, creation of every object in that scope still passes through the component. In that case, `failurePolicy` and `timeoutSeconds` determine the impact of component failure and should also be declared.
  >
  > When scheduling requirements can be expressed as declarative constraints (topology affinity, profile restrictions, or exclusion rules), they usually coexist more easily with multiple vendors than a vendor-specific scheduler.
- **[DEL]** Runnable YAML examples for every profile: whole-card, each partition profile, exclusive allocation, and shared allocation.
- **[TEST]** Start Pods using the manual examples and verify that resources can be requested, device files are visible, and attributes are readable. Verify that over-requesting and repeated requests behave as expected.
- **[TEST]** Run alongside cards from other vendors in the same cluster. Pods using other vendors' resources must schedule normally and must not be intercepted or rewritten by this vendor's components.
- **[TEST · Observation]** Observe scheduling behavior and anomalies for other vendors' Pods before and after deployment of this vendor's components. If clear interception, failure, or unacceptable performance impact occurs, confirm it against the actual environment. This item has no fixed threshold.

### 4.2 Partitioning and Isolation (L2)

**[DEC]**

- Partitioning method: hardware partitioning, hardware virtualization, native software partitioning, software interception through a middleware layer, or unsupported.
- Isolation level for every profile: memory isolation (hard / soft / none), compute isolation (hard / soft / none), and fault isolation (yes / no).
- **Fault domain:** Whether memory overflow, compute deadlock, or process failure in one instance affects other instances on the same card, and whether it may cause a whole-card reset or node failure.
- Whether partitioning can be adjusted without restarting the container, and how memory and device state are cleaned up after an instance is destroyed.
- If oversubscription is supported, declare the maximum oversubscription ratio.

**[TEST]**

| Test | Method | Decision |
|---|---|---|
| Memory isolation | Run two instances on one card; one requests memory beyond its quota. | The over-limit instance fails and the other instance is unaffected. |
| Compute isolation | Run two instances at full load with half-card quotas. | The deviation between actual share and quota is within the agreed range (reference value 10%, to be confirmed). |
| Fault propagation | Inject memory overflow, forcibly terminate a process, or create an infinite loop in one instance. | Tasks in other instances continue without interruption. |
| Partitioning overhead | Compare one instance using its full-card quota with the whole-card passthrough baseline. | Performance loss does not exceed the declaration and remains within the agreed range (reference value 10%, to be confirmed). |
| Residual cleanup | Destroy an instance, create a new one, and inspect memory. | No data from the previous instance remains. |
| Oversubscription behavior | If supported, apply load according to the **declared maximum oversubscription ratio**. | Behavior matches the declaration and does not cause node-level failure. |

**Tiering rule:** A card is L2-Hard only when both memory and compute isolation are hard and other instances are unaffected in the fault-propagation test. Otherwise it is L2-Soft. If measured results differ from declarations, correct the declaration and repeat the affected tests.

> No uniform minimum partition granularity is defined. Hardware partitioning is often coarser but provides stronger isolation; a uniform minimum would exclude stronger solutions. Granularity is declared by the vendor and differences are handled through profile enumeration and capability levels.
>
> No uniform upper limit is defined for oversubscription. This item verifies only the stability of the declared value.

### 4.3 Workload Switching, Reclamation, and Reset

Some usage patterns switch workload types at different times, such as alternating inference and training. The actual behavior of switching and reclamation between workload types must therefore be understood.

**[DEC] Reclamation and switching**

- Time required to clean memory and device state after the previous workload is released.
- Whether switching workload types requires a node restart, driver reload, or global partitioning-mode change; if so, document the cost and prerequisites.
- Whether a device reset is required before accepting a different workload after a long period at full load.

**[DEC] Device reset semantics**

- Reset trigger and **granularity**: whole-card reset, instance-level reset, driver reload, or node restart.
- Reset duration and whether the card is automatically removed from allocatable resources during reset.
- Whether the driver must be unbound first and whether workloads on other cards on the same node must stop.
- **IOMMU grouping:** Whether the card shares an IOMMU group with other devices on the node; if so, describe the mutual impact during reset.
- Reset-failure handling: automatic retry, fault marking, or manual intervention.

**[TEST] T7a Reset impact** (applies to all cards; corresponds to R10)

Reset the target card while other physical cards on the same node are serving workloads, and verify:

| Check | Decision |
|---|---|
| Actual impact matches the declaration | **Baseline requirement.** Undeclared node-level impact, such as host failure or loss of other cards on the node, must not occur. |
| Workloads on other physical cards continue without interruption | **Production enhancement.** Cards with this capability may share a node with other workloads. Cards without it are placed on dedicated nodes according to the declared impact and admitted with restrictions (see section 5.4). |
| The reset card recovers and returns automatically within the declared time | Compare with the declaration. |
| The card is not assigned new workloads during reset | Compare with the declaration. |

This test must run on an isolated test node and must not share the node with other test groups.

**[TEST] T7b Workload switching and reclamation** (applies to cards that declare support for time-based workload switching)

Continuously switch between training and inference workloads for several rounds (the number of rounds is to be confirmed). For each round, check reclamation latency, residual memory, the need for manual intervention, and whether performance changes across rounds.

> The T7b conclusion determines whether a card is suitable for time-based workload switching. **It does not affect L0-L3 level classification.** T7a applies to all cards.

### 4.4 Observability (L1)

**[DEL]** Provide a Prometheus-format exporter, complete the Monitoring Metric Mapping in Appendix B, and provide an official monitoring dashboard template with query expressions to align metric semantics.

**Required metrics** (necessary for L1): device health, total memory, used memory, compute utilization, temperature, power, unique device identity, and **device-to-Pod / Namespace association** or a workable association method corresponding to R4.

**Extended metrics:** See the groups in Appendix B. **Partition-instance memory and compute usage** is required for L2. **Interconnect link status and bandwidth** are required for L3.

**[DEC]** Define the **semantics** of every metric precisely, including its definition, denominator, sampling window, and unit.

> Semantics are mandatory. Vendors define “utilization” differently: some mean the proportion of time during which a compute task is running, while others mean the occupancy of compute units. The numeric ranges may be identical while the meanings differ. A metric with unclear semantics cannot be included in a common measurement model.

**[DEC]** Metrics must support aggregation by card model.

**[TEST]**

- Accuracy: sample concurrently with the vendor CLI and compare; deviation must be within the agreed range (reference value 5%, to be confirmed).
- Collection period: meet the agreed minimum collection period (suggested reference value 15 seconds; see Appendix D.2.1).
- Exporter overhead: exporter resource usage must not exceed the declaration and must remain within the agreed range (baseline to be confirmed).
- Association correctness: after Pod creation, deletion, migration, and node restart, the association must follow correctly.
- Partitioned scenarios: for additive metrics such as memory capacity and memory usage, verify accounting between instances and the whole card; for non-additive metrics such as utilization and temperature, verify their definitions, denominators, and aggregation methods.

### 4.5 Fault Detection and Isolation (L1)

**[DEC]**

- List detectable fault types, such as card loss, uncorrectable errors, link faults, thermal throttling, and driver unresponsiveness, together with the detection latency for each type.
- Reporting channels: Kubernetes Events, node Conditions, metrics, and Device Plugin health reporting.
- **List raw fault codes and their meanings**, covering every fault code that can be reported.
- State whether a faulty device is automatically removed from allocatable resources, whether it automatically returns after recovery, and whether manual intervention is required.
- For partitioned scenarios, state whether faults can be marked at instance level. If not, describe the handling method, such as removing the whole card.

**[TEST]** Inject faults by unloading the driver, simulating hardware errors, disconnecting an interconnect, and making the driver unresponsive. Check detection latency, removal, return after recovery, and impact on workloads on other cards on the same node.

**Detection latency** (suggested references; whether they become formal gates is to be confirmed by the user of the framework):

| Fault category | Suggested reference |
|---|---|
| Fatal: card loss, driver unresponsiveness, uncorrectable errors | 30 seconds |
| Other: thermal throttling, link degradation, accumulated correctable errors | 5 minutes |

> Reference upper bounds are included because checking only whether a declaration matches a measurement is insufficient. A declared and measured latency could both be long while still failing to meet production needs.

### 4.6 Topology and Interconnect (L3)

- **[DEC]** Inter-card interconnect type and bandwidth; the exposure method for the **interconnect domain** (the set of cards in one high-speed interconnect); and performance-difference data for cross-domain communication.
- **[DEC]** Collective-communication libraries and their version compatibility with mainstream training frameworks.
- **[DEC]** Multi-node training network requirements (RDMA, RoCE, or a proprietary interconnect), recommended topology, and reference performance.
- **[TEST]** The bandwidth difference between multiple cards in the same interconnect domain and cards across domains must be identifiable for allocation decisions. Multi-card and multi-node training must reach the agreed proportion of the declared scaling efficiency (reference value 90%, to be confirmed).

> Cross-node aggregation into one logical super-card is not required. Cross-node communication is implemented by the collective-communication library; cross-node capability is measured through distributed-training scaling efficiency.

### 4.7 Driver, Firmware, and Operations

- **[DEL]** Compatibility matrix: driver / firmware / component × kernel × OS (including target domestic OS list) × Kubernetes × container runtime, corresponding to R5.
- **[DEC]** Driver and firmware upgrade methods: whether a node restart is required, whether running workloads are interrupted, whether rolling upgrades are supported, and whether rollback is supported. **Describe drivers and firmware separately**, because they are usually independent installation artifacts.
- **[DEC]** List and explain the host permissions required by components; see section 4.10.
- **[DEL]** One-click diagnostic and log-collection tools and a troubleshooting guide.
- **[TEST]** Complete deployment, uninstall, upgrade, and rollback. **Perform a driver upgrade while workloads are running**, verify that the actual impact matches the declaration, and verify automatic recovery of devices and components after a node restart.

**Domestic operating-system support**

The common difficulty in deploying domestic cards is coupling between the driver and the domestic OS kernel. The following items are mandatory:

- **[DEC]** Officially supported domestic OS versions and **exact kernel versions**, down to the kernel patch version. An OS name without a version cannot be used for compatibility decisions.
- **[DEC]** Kernel adaptation method: **precompiled** binaries distributed by kernel version or **dynamic compilation** on the node.
  - Precompiled: list released kernel packages and the turnaround time for new kernel versions.
  - Dynamic compilation: list compiler-toolchain and kernel-header dependencies and how compilation is completed on **offline nodes**.
- **[DEC]** **Kernel-module signing and Secure Boot:** when the target OS enables module signing or Secure Boot, describe the signing method and signer.
- **[DEC]** Follow-up policy and response time after the OS publishes a kernel patch update, and the mitigation when the update is not followed.
- **[DEL] Offline deployment plan (where required by the target environment):** for an offline or isolated deployment, provide a complete offline plan and dependency list. Package contents depend on the driver adaptation method:
  - Dynamic compilation: provide the compiler toolchain, kernel headers, and related dependencies.
  - Precompiled: provide driver installation media for each supported kernel version.
  - Both methods: provide offline installation artifacts for component images, operator libraries, and runtimes, together with the dependency list and version mapping.
- **[TEST]** Execute the complete deployment process on target domestic OS nodes. In an isolated environment, **run the full process with external network access disconnected** and verify that no dependency must be downloaded during the process.

> This item is separate because a precompiled driver may fail after an OS kernel upgrade, while dynamic compilation is often constrained by toolchains and network conditions in production. Both problems are commonly discovered only after go-live.

**Stability**

- **[DEC]** Performance fluctuation range under full load.
- **[TEST]** Run one long full-load training round and one long full-load inference round (duration to be confirmed), and verify no card loss, no driver failure, and performance fluctuation within the declaration.

### 4.8 Software Stack and Ecosystem Compatibility

- **[DEL] Software-stack declaration:** versions of operator libraries, graph compilers, and runtimes, and their relationship with **driver and firmware versions**. State whether they are **decoupled** and can be upgraded independently, or **coupled** and must be upgraded together:
  - Coupled: provide a compatible version-combination matrix.
  - Decoupled: provide the compatible version range for each component.

  > This item determines whether a driver upgrade also requires an upper-layer software-stack upgrade. If coupling is not declared in advance, a driver upgrade may make application code unable to run.
- **[DEL] Operator coverage statement:** against the standard operator set of supported frameworks, list unsupported operators or operators that fall back to CPU execution, and model structures known to fail or suffer a material performance loss as a result.
- **[DEC]** Follow-up time for new framework versions.
- **[DEL]** Framework compatibility matrix, including supported versions of PyTorch and other frameworks, whether workloads run without modification, and whether vendor-specific plugins are required. Describe plugin maintenance and version-following policy.
- **[DEL]** Verified model list, distinguishing training / fine-tuning from inference and covering the agreed benchmark set in Appendix C.
- **[DEL]** Inference-engine support, including supported versions and known limitations of mainstream engines and interface compatibility of proprietary engines.
- **[DEL]** Official base images containing driver user-space libraries, operator libraries, and frameworks, or a repackaged toolchain, together with the update cadence.
- **[TEST]** Run the benchmark model set and verify whether models run, performance reaches the declaration, and numerical accuracy deviation from the baseline card remains within the agreed range (accuracy threshold to be confirmed). Clearly mark scenarios exceeding the accepted deviation.

### 4.9 Supply Chain and Service Commitments

- **[DEL]** Domestic-production and supply-chain statement, including origins and degree of autonomy for chips, drivers, firmware, and key components.
- **[DEL]** SBOM for component and driver images. Images must pass vulnerability scanning and composition analysis.
- **[DEL]** Vulnerability-response statement, including severity-based response and remediation times and the vulnerability-notification mechanism.
- **[DEL]** Maintenance-period statement, including maintenance duration and support after product end of sale (minimum duration to be confirmed; corresponds to R6).
- **[DEL]** Technical-support statement, including fault response time, spare-parts policy, and contact mechanism.
- **[DEL]** Materials required for supplier and outsourcing risk assessment.

> Procurement-governance matters such as brand concentration are outside this document's decision scope.

### 4.10 Device Exposure and Container Permissions

The platform is shared by multiple departments, and workloads from different departments may run on the same node or card. Device exposure must therefore be auditable and reducible. This section provides the basis for R9 and R11.

**[DEC] Permission and exposure inventory (down to path and capability name)**

| Item | Requirement |
|---|---|
| Permissions required by vendor components | State whether `privileged` is required; list every Linux capability and its purpose; list every hostPath mount and its purpose; state whether hostNetwork / hostPID is required. |
| **Device nodes injected into workload containers** | List every injected path and explain why it is required. |
| **`/sys` or `/proc` paths mounted into workload containers** | List every path, its purpose, and whether it is read-only. |
| User-space library and configuration injection | State whether they are mounted or built into the image. |
| Permission-reduction plan | If the current permissions are broader than necessary, state the reduction plan and target date. |

**[TEST] T12 Permissions and device exposure**

1. **Inventory check:** After deployment, collect actual permissions, mounts, and device nodes for components and workload containers and compare them item by item with the declared inventory.
2. **Resource and management boundary:** A workload container must not obtain unauthorized resources or management capabilities. For a shared control device node that must be exposed, verify that its access scope and effect match the declaration.
3. **Access boundary:** Between neighboring containers on the same node and card, attempt to access another workload's memory contents or task information through device files, management interfaces, or performance counters. The attempt must fail.
4. **Management interfaces:** A workload container must not be able to perform management operations affecting the whole card or other instances, such as reset, partitioning changes, or power-limit changes.
5. **Read-only behavior:** A mount declared read-only must be verified as non-writable inside the container.

> Items 2 and 3 complement the residual-cleanup test in section 4.2. Residual cleanup covers two instances using the same resource sequentially; this section covers neighboring instances running concurrently. They are different paths and must be verified separately.

**Scope:** This version covers device exposure and isolation within one node. Cross-node tenant isolation and network isolation are out of scope.

### 4.11 On-site Self-check and Fast Verification

Most of the POC cycle is often spent checking the environment and locating problems rather than running tests. Vendors should therefore provide a self-check tool that can run with one command on site.

**[DEL]** Automated self-check program, or an equivalent verification suite, preferably meeting the following requirements:

| Requirement | Description |
|---|---|
| **Coverage** | Driver and firmware version checks, device discovery and count, resource-registration state, whole-card allocation, allocation of every partition profile, metric-collection connectivity, fault-reporting connectivity, and interconnect status (L3-related). |
| **Execution** | Runs as a container in the target cluster, supports offline environments, and requires no permission beyond the inventory declared in section 4.10. |
| **Output** | Machine-readable results (JSON or equivalent), with pass/fail and failure reason for every item. |
| **Idempotence and non-destructiveness** | Can be run repeatedly, does not modify node or cluster state beyond the declared test purpose, and cleans itself up after execution. |
| **Duration** | Target duration for the baseline self-check, to be confirmed. |

**[DEL]** Minimal runnable example: one end-to-end example containing YAML, images, and expected output.

**[TEST] T0** Run the vendor self-check tool and verify that it runs correctly, its output matches independent observations, and it does not require undeclared permissions or make undeclared state changes.

> **T0 is a prerequisite item used to shorten later testing and does not determine the capability level.** Certification conclusions are based on T1-T12; if the self-check passes but independent testing fails, the independent result prevails.

---

## 5. Conformance Testing Standard

### 5.1 Organization

Provide a standard test cluster containing the target Kubernetes version and target OS nodes. **Test cases and scripts must be disclosed to the vendor in advance.** The vendor provides technical support; execution and decisions are performed independently by the platform owner.

Two points apply:

1. **Published cases are baseline cases.** The acceptance process may include additional cases to confirm that declared capabilities are general rather than valid only for known cases.
2. **T7a reset-safety testing runs on an isolated test node** and must not share a node with other test groups.

### 5.2 Test Groups

The “scope” column states which cards the group applies to. The “duration” column is completed according to the actual scenario.

| Group | Content | Related clauses | Scope | Duration |
|---|---|---|---|---|
| **T0 Self-check** | Run the vendor self-check program and examples; compare output with independent observations. | 4.11 | Prerequisite; does not determine level | |
| **T1 Deployment** | Deploy, uninstall, upgrade, and rollback; recover after node restart. | 4.7, R1, R2 | All | |
| **T2 Scheduling** | Request every profile; verify device visibility, readable attributes, and abnormal requests. | 4.1 | All | |
| **T3 Coexistence** | Run with other vendors' cards in one cluster; verify no mutual impact and observe other vendors' Pod scheduling before and after deployment. | 4.1, R3 | All | |
| **T4 Observability** | Metric completeness, accuracy, association correctness, and semantic review. | 4.4, R4 | Required for L1 | |
| **T5 Faults** | Fault injection, detection latency, automatic removal, return after recovery, and impact on neighboring cards. | 4.5 | Required for L1 | |
| **T6 Partitioning** | Memory isolation, compute isolation, fault propagation, overhead, residuals, and oversubscription. | 4.2 | Partitionable cards; basis for L2 tiering | |
| **T7a Reset impact** | Reset impact while neighboring cards run workloads; run on an isolated node. | 4.3, R10 | All; impact must match declaration. Independent reset capability is assessed as a production enhancement. | |
| **T7b Workload switching** | Repeated training / inference switching, reclamation latency, and residuals. | 4.3 | Cards that declare time-based workload switching | |
| **T8 Topology** | Interconnect-domain exposure, same-domain and cross-domain bandwidth, and multi-card and multi-node scaling efficiency. | 4.6 | Required for L3 | |
| **T9 Stability** | One long full-load training round and one long full-load inference round. | 4.7 | All | |
| **T10 Ecosystem** | Benchmark model execution, performance, and numerical consistency. | 4.8 | All | |
| **T11 Benchmark** | Standard compute measurement for the whole card and every partition profile. | 5.5 | All | |
| **T12 Permissions** | Permission and device-exposure inventory, visibility, access boundaries, management interfaces, and read-only behavior. | 4.10, R9, R11 | All | |

### 5.3 Decision Rules

1. If any **baseline admission requirement** R1-R11 is not met, the card does not enter the subsequent assessment.
2. Record every **[TEST]** result item by item.
3. Handle a **[DEC]** item that differs from measurement according to section 8.3.
4. Level classification:
   - L1 requires passing T4 and T5.
   - **L2 and L3 both require L1 first**. L2 additionally requires T6 and is tiered according to its result; L3 additionally requires T8.
   - T0 and T7b do not determine the capability level.
5. The conclusion must state the **exact version combination** tested (driver, firmware, components, OS, kernel, and Kubernetes). The conclusion applies only to that combination.

### 5.4 Restricted Admission

A device that does not meet an advanced capability requirement but has acceptable baseline onboarding and runtime boundaries **may be admitted with restrictions**. It need not be excluded because of one insufficient capability.

| Restriction type | Example |
|---|---|
| Scope restriction | Specific node or node pool, specific Namespace |
| Allocation restriction | Whole-card allocation only; partitioning unavailable |
| Co-location restriction | No cross-department co-location; no co-location with core workloads |
| Workload restriction | Only a specified model or workload type |
| Operational condition | Upgrade only in a maintenance window; manual recovery after a fault |

Restrictions must be **clearly recorded in the certification conclusion and platform resource catalog**, so that users know them when requesting capacity.

> This approach turns an insufficient individual capability into a manageable usage scope instead of excluding the device.

### 5.5 Standard Compute Measurement

Vendor-claimed peak compute is not used directly for comparison. Vendors use different definitions, may or may not include sparsity, support different precisions, and achieve different utilization levels. Cross-vendor comparison therefore uses a common measured basis.

- **Separate results by workload category** instead of using one scalar: training throughput and inference throughput. A card may rank differently for the two workloads.
- Treat memory capacity, memory bandwidth, interconnect bandwidth, and collective-communication bandwidth as **independent dimensions**; do not merge them into the compute metric.
- **Measure every partition profile separately**; do not linearly infer partition performance from whole-card performance.
- Use the measured result of a baseline card as the reference; the baseline card is to be confirmed.
- Repeat measurements after a major driver or firmware version change; see section 6.

The benchmark set is defined in Appendix C.

### 5.6 Confirmation and Activation of Thresholds

To avoid fixing values without measurement evidence, distinguish three different things first:

| | Status |
|---|---|
| **Framework** | Proposed: test items, metric categories, level relationships, and decision process. |
| **Reference values** | Suggested values have been proposed (15 seconds, 30 seconds, 5 minutes, 10%, 5%, and so on); see Appendix D.2. |
| **Formal thresholds** | **To be confirmed:** whether the suggested values are adopted and where they apply; the user of the framework confirms this. |

Thresholds take effect in two phases:

| Phase | Threshold status | Decision method |
|---|---|---|
| **Phase 1: Baseline measurement** | Suggested reference values are used **only for observation, recording, and comparison; they are not rejection criteria**. | Record each measured value and its deviation from the reference value; mark the conclusion as “Phase 1”. |
| **Phase 2: Formal operation** | The user of the framework confirms whether each reference value becomes a formal gate; **different scenarios may use different thresholds**. | Confirmed thresholds become decision gates. |

Cards tested during Phase 1 are reclassified against the new thresholds after confirmation. Tests do not need to be repeated unless a retest condition in section 6 is triggered.

Appendix D.2 divides thresholds into three types with different confirmation methods: **policy thresholds** depend on user needs, **capability thresholds** require calibration against measurements, and **method thresholds** are selected by the user according to cost and benefit.

---

## 6. Certification Validity and Retesting

### 6.1 Recording the Conclusion

Record a certification conclusion as **card model + version combination + document version + capability level + isolation tier**. A statement that “a card is certified” without a version combination is invalid.

### 6.2 Retest Triggers

The relevant test groups must be rerun when any of the following occurs. A certification conclusion that has not been retested is considered pending confirmation.

| Change | Test groups to repeat |
|---|---|
| Major driver or firmware update | T1, T4, T5, T7a, T9, T11; add T6 for partitionable cards and T7b for workload-switching scenarios |
| Vendor component update (Device Plugin / Exporter / DRA driver) | T1, T2, T4 |
| Node OS or kernel upgrade | T1, T9 |
| Kubernetes version upgrade | T1, T2, T3 |
| Framework or inference-engine version upgrade | T10 |

### 6.3 Annual Reassessment

Perform one reassessment each year. Check fulfillment of maintenance commitments, vulnerability-response records, on-site fault rate, support-commitment fulfillment, and updates to the ecosystem compatibility matrix. A model that fails two consecutive reassessments enters the retirement process.

Use platform-observed fault data as the source of truth; do not use vendor self-reported data.

---

## 7. Deliverables

| # | Deliverable | Related clauses |
|---|---|---|
| 1 | Deployment package: Helm Chart / YAML, driver and firmware installation media, images, and **online or offline delivery package suitable for the target network** with dependency list | R1, R2, 4.7 |
| 2 | **Capability declaration** (Appendix A) | 4.1–4.3, 4.5–4.7, 4.10 |
| 3 | Resource scheduling guide with runnable YAML examples and parameter semantics for every profile | 4.1 |
| 4 | **Monitoring metric mapping** (Appendix B) and official monitoring dashboard template | 4.4 |
| 5 | Version compatibility matrix | 4.7, R5 |
| 6 | AI ecosystem compatibility matrix for frameworks, models, and inference engines, down to version | 4.8 |
| 7 | Official base image or repackaged toolchain | 4.8 |
| 8 | Operations manual for deployment, upgrade, rollback, diagnosis, and troubleshooting | 4.7 |
| 9 | **On-site self-check program and minimal runnable example** | 4.11 |
| 10 | Security and compliance materials: SBOM, permission inventory, vulnerability response, and maintenance-period statement | 4.9, R6, R9 |
| 11 | Technical support statement | 4.9 |
| 12 | Integration support: interface documentation, native metric and fault-code mapping, and technical support during integration | 4.4, 4.5 |

---

## 8. Assessment and Comparison

### 8.1 Three Steps

1. Check **baseline admission requirements** R1-R11.
2. Perform **capability certification**, determine L0-L3 and the isolation tier, and define applicable scenarios.
3. Perform a **comprehensive assessment** for comparison among vendors.

### 8.2 Assessment Dimensions

Weights are to be confirmed against the procurement strategy.

| Dimension | Weight | Main evidence |
|---|---|---|
| Measured performance per unit of compute, with separate training and inference bases | | Ratio of T11 measured result to price |
| Ecosystem compatibility | | T10: operating scope, performance achievement, and numerical consistency |
| Stability and fault capability | | T5, T9 |
| Operations maturity | | T1, T7a: automation, upgrade and rollback, diagnosis, and reset safety |
| Standards compliance | | Degree of adoption of Kubernetes standard mechanisms; fewer platform changes are better |
| Support and service commitments | | Response time, maintenance period, and vulnerability-response record |

> The procurement strategy determines how the training and inference compute measures are combined. This document does not define a single scalar.

### 8.3 Handling Declaration and Measurement Differences

1. If a **[DEC]** item differs from measurement, correct the declaration and repeat the test. Repeated differences must be reflected in the assessment conclusion.
2. If a capability works only with published cases and fails with an equivalent supplemental case, reclassify the item according to the measured result.

> The purpose is to keep declarations consistent with actual behavior and to assign applicable scenarios according to real capability. A difference does not automatically prevent onboarding, but it affects level classification and applicable scenarios.

---

## 9. Implementation Sequence

| Step | Content | Notes |
|---|---|---|
| 1 | Confirm the items listed in Appendix D | Can start immediately |
| 2 | Select the baseline card | |
| 3 | Publish this document and the test-case set | Depends on step 1 |
| 4 | Vendor self-assessment and material submission, followed by material review | Depends on step 3 |
| 5 | Run every test group on the baseline card, confirm thresholds, and convert this document to the formal version | Depends on steps 2 and 3 |
| 6 | Other vendors run the test groups required for their target levels | Depends on step 5 |
| 7 | Publish and continuously manage certifications (section 6) | |

---

## Appendix A. Vendor Capability Declaration

### A.1 Basic Information

| Item | Entry |
|---|---|
| Vendor / model / product code | |
| Resource registration name (Device Plugin) | |
| DRA support status (unsupported / planned / pilot / verified) | |
| DRA driver version (if supported) | |
| Kubernetes versions supported by DRA (if supported) | |
| DeviceClass / ResourceClaim examples (if supported) | |
| Known DRA limitations (if supported) | |
| Partitioning method (hardware partitioning / hardware virtualization / native software / middleware / unsupported) | |
| Supported Kubernetes version range | |
| Supported OS and kernel range | |
| Driver / firmware / component versions submitted for testing | |
| Driver upgrade requires node restart | |
| Driver upgrade interrupts running workloads | |
| Driver supports rolling upgrade | |
| Driver supports rollback | |
| Firmware upgrade requires node restart | |
| Firmware upgrade interrupts running workloads | |
| Firmware supports rolling upgrade | |
| Firmware supports rollback | |
| Maintenance period | |
| Built-in admission or scheduling extension (yes / no); if yes, scope and activation conditions | |

### A.2 Allocatable Profile Enumeration (one row per profile)

| Profile name | Card model | Memory | Compute ratio | Memory isolation (hard/soft/none) | Compute isolation (hard/soft/none) | Fault isolation (yes/no) | Maximum instances per card | Adjustable without restart | Nominal compute (each precision) |
|---|---|---|---|---|---|---|---|---|---|
| Whole card | | | 100% | — | — | — | 1 | — | |
| | | | | | | | | | |

Maximum oversubscription ratio (complete when supported):

### A.3 Domestic OS Adaptation

| Item | Entry |
|---|---|
| Supported domestic OS and **exact OS and kernel patch versions** | |
| Driver kernel adaptation method (precompiled / dynamic compilation) | |
| Precompiled: released kernel-version list | |
| Precompiled: turnaround time for a new kernel version | |
| Dynamic compilation: required toolchain and kernel-header dependencies | |
| Dynamic compilation: process for offline nodes | |
| Kernel-module signing / Secure Boot handling (signer) | |
| Follow-up policy and response time after OS kernel patch updates | |

### A.4 Faults and Topology

| Item | Entry |
|---|---|
| Detectable fault types and detection latency | |
| Raw fault-code list and meanings | |
| Fault-reporting channels | |
| Automatic fault removal / automatic return after recovery / manual intervention | |
| Instance-level fault marking for partitioned scenarios; handling when unavailable | |
| Impact of a single-instance abnormality (other instances / whole-card reset / node) | |
| Inter-card interconnect type and bandwidth; interconnect-domain exposure | |
| Collective-communication library and framework compatibility versions | |
| Multi-node interconnect network requirements | |

### A.5 Workload Switching, Reclamation, and Reset

| Item | Entry |
|---|---|
| Time to clean memory and state after instance destruction | |
| Whether switching workload types requires node restart / driver reload / global partitioning-mode change | |
| Whether reset is required before accepting another workload after long full load | |
| Reset granularity (whole card / instance / driver reload / node restart) | |
| Reset duration; automatic removal during reset | |
| Whether the driver must be unbound / other card workloads stopped | |
| Whether the card shares an IOMMU group with other devices; impact scope | |
| Reset-failure handling | |
| Performance fluctuation range under full load | |

### A.6 Device Exposure and Container Permissions

| Item | Entry |
|---|---|
| Whether vendor components require `privileged` | |
| Required Linux capabilities, listed with purpose | |
| Required hostPath mounts, listed with purpose | |
| Whether hostNetwork / hostPID is required | |
| **Device nodes injected into workload containers (path and purpose for each)** | |
| `/sys` or `/proc` paths mounted into workload containers (each path and read-only status) | |
| User-space library injection (mount / built into image) | |
| Permission-reduction plan, if current permissions are broad | |

---

## Appendix B. Monitoring Metric Mapping

For every row, provide the native metric name, unit conversion, and **semantic description**, including definition, denominator, and sampling window.

**Requiredness:** `Required` means necessary for L1; `L2` / `L3` means necessary for the corresponding level; `Recommended` does not affect level classification but affects operational capability.

See Appendix E for examples.

### B.1 Identity and Attributes

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Unique device identity | Required | ☐Yes ☐No | | | |
| Card model | Recommended | ☐Yes ☐No | | | Must support aggregation by model, possibly through labels |
| Driver version | Recommended | ☐Yes ☐No | | | May be an info metric |
| Firmware version | Recommended | ☐Yes ☐No | | | Complete when the device has a firmware concept |
| Bus / PCI address | Recommended | ☐Yes ☐No | | | |
| NUMA node | Recommended | ☐Yes ☐No | | | |
| Interconnect-domain identity | L3 | ☐Yes ☐No | | | |
| Operator-library / runtime version | Recommended | ☐Yes ☐No | | | Info metric |

### B.2 Health and Faults

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Device health status | Required | ☐Yes ☐No | | | Explain the value meanings |
| Current fault code | Recommended | ☐Yes ☐No | | | Must map to the raw fault-code list |
| Fault-event count by type | Recommended | ☐Yes ☐No | | | |
| Uncorrectable-error count | Recommended | ☐Yes ☐No | | | Recommended for critical workloads |
| Correctable-error count | Recommended | ☐Yes ☐No | | | |
| Memory-error count (since boot / cumulative) | Recommended | ☐Yes ☐No | | | Distinguish the two meanings |
| Retired memory pages / row remapping and remaining capacity | Recommended | ☐Yes ☐No | | | Can reveal degradation early |
| Device degraded or restricted status | Recommended | ☐Yes ☐No | | | |

### B.3 Utilization and Load

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Compute utilization | Required | ☐Yes ☐No | | | **Required:** time occupancy / compute-unit occupancy / other |

| Compute-unit occupancy | Recommended | ☐Yes ☐No | | | List separately when its semantics differ from the previous metric. |
| Total compute (comparable compute unit) | Recommended | ☐Yes ☐No | | | Complete when this concept exists. |
| Memory-bandwidth utilization | Recommended | ☐Yes ☐No | | | |
| Active process / context count | Recommended | ☐Yes ☐No | | | |
| Codec utilization | Recommended | ☐Yes ☐No | | | Complete for video workloads. |

### B.4 Memory

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Total memory | Required | ☐Yes ☐No | | | State Bytes / MB / MiB; explain any derivation. |
| Used memory | Required | ☐Yes ☐No | | | State whether driver-reserved memory is included. |
| Free memory | Recommended | ☐Yes ☐No | | | |
| Driver / system reserved memory | Recommended | ☐Yes ☐No | | | Affects allocatable-capacity calculation. |
| Memory fragmentation | Recommended | ☐Yes ☐No | | | Complete when available. |

### B.5 Power and Temperature

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Current power | Required | ☐Yes ☐No | | | State W. |
| Power limit | Recommended | ☐Yes ☐No | | | |
| Cumulative energy | Recommended | ☐Yes ☐No | | | |
| Core temperature | Required | ☐Yes ☐No | | | |
| Memory / board temperature | Recommended | ☐Yes ☐No | | | |
| Temperature thresholds (throttle / shutdown) | Recommended | ☐Yes ☐No | | | |
| Fan speed | Recommended | ☐Yes ☐No | | | Complete for cards with fans. |

### B.6 Frequency and Throttling

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Current core frequency | Recommended | ☐Yes ☐No | | | |
| Current memory frequency | Recommended | ☐Yes ☐No | | | |
| Maximum / default frequency | Recommended | ☐Yes ☐No | | | |
| Throttling state and reason | Recommended | ☐Yes ☐No | | | Distinguish thermal, power, hardware, and software causes. |
| Cumulative throttling duration or ratio | Recommended | ☐Yes ☐No | | | |

### B.7 Interconnect and Bus

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Inter-card link status (per link) | L3 | ☐Yes ☐No | | | |
| Inter-card receive / transmit bandwidth | L3 | ☐Yes ☐No | | | |
| Inter-card link error count | L3 | ☐Yes ☐No | | | Such as CRC errors and retransmissions. |
| Active links / total links | Recommended | ☐Yes ☐No | | | |
| PCIe receive / transmit bandwidth | Recommended | ☐Yes ☐No | | | |
| PCIe retransmission count | Recommended | ☐Yes ☐No | | | |
| Network status and errors (RDMA / RoCE, where applicable) | Recommended | ☐Yes ☐No | | | Relevant to multi-node training. |

### B.8 Partition-Instance Metrics

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Instance identity and physical-card ownership | L2 | ☐Yes ☐No | | | |
| Number of partition instances per card | Recommended | ☐Yes ☐No | | | |
| Instance memory quota | L2 | ☐Yes ☐No | | | |
| Instance used memory | L2 | ☐Yes ☐No | | | |
| Instance compute quota | L2 | ☐Yes ☐No | | | |
| Instance used compute | L2 | ☐Yes ☐No | | | |
| Instance health status | Recommended | ☐Yes ☐No | | | Complete when instance-level fault marking is supported. |

### B.9 Container and Process Association

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Device → Pod / Namespace association | Required | ☐Yes ☐No | | | May be carried by labels or provided through an association method. |
| Partition instance → Pod / Namespace association | L2 | ☐Yes ☐No | | | Same as above. |
| Process-level memory usage | Recommended | ☐Yes ☐No | | | |
| Process-level compute usage | Recommended | ☐Yes ☐No | | | |

### B.10 Exporter Itself

| Normalized metric | Requiredness | Supported | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|---|---|
| Exporter health / liveness | Recommended | ☐Yes ☐No | | | |
| Single collection duration | Recommended | ☐Yes ☐No | | | |
| Collection-failure count | Recommended | ☐Yes ☐No | | | |

### B.11 Labels

Label names differ by vendor. Complete the actual label name for each item.

| Meaning | Requirement | Actual label name |
|---|---|---|
| Node | Required; provide an association method when the metric does not carry it directly | |
| Device identity | Required | |
| Card model | Required, for aggregation by model | |
| Pod / Namespace | Required; provide an association method when the metric does not carry it directly | |
| Partition-instance identity | L2 | |

---

## Appendix C. Benchmark Set (To Be Completed)

This appendix is the common basis for measured compute results in section 5.5 and ecosystem certification in section 4.8. **T10 and T11 must not run until this appendix is completed.**

### C.1 Items to Complete

| Category | Items to complete |
|---|---|
| Inference benchmark | Models and sizes, input/output length distribution, concurrency levels, and statistical definitions for time to first token and throughput |
| Training benchmark | Models and sizes, dataset, precision, batch, iteration count, and throughput definition |
| Memory bandwidth | Test tool and data size |
| Collective communication | Operation types, data-size levels, and same-domain and cross-domain topologies |
| Numerical consistency | Metrics and acceptable deviation compared with the baseline card |
| Long-running workload | Training and inference stress-load definitions, duration, sampling, and fluctuation statistics |
| Workload switching | Number of rounds, per-round workload definition, and reclamation decision method |
| Runtime constraints | Common container-image source, driver-version recording, and result-submission format. Vendors must submit reproducible test scripts and complete configuration, including environment variables, concurrency parameters, and random seeds. |

### C.2 Selection Principles

1. **At least one item must come from an actual business workload**, so that the certification conclusion reflects production behavior.
2. **At least one item must be a widely used industry model**, so results can be compared across vendors.
3. **Cover two scales:** a scale that fits on one card and a scale requiring multi-card cooperation.
4. **Remain engine-neutral:** do not make one inference engine the only prerequisite. A vendor's proprietary engine may participate, but its interface compatibility must be declared and its results recorded separately from mainstream-engine results.
5. **Include only decision-relevant workloads.** Workloads unrelated to actual business use increase the schedule without changing the conclusion.

### C.3 Candidate Set (For Selection, Not a Requirement)

The following are optional starting points and **must be confirmed, replaced, or adjusted by the business owner before taking effect**.

| Category | Candidate | Description |
|---|---|---|
| Inference - mainline | Medium-scale LLMs (7B-14B class, such as Qwen or Llama), covering short and long contexts with two concurrency levels | The main production workload pattern; record TTFT and throughput separately. |
| Inference - capacity boundary | Larger LLMs (70B class or MoE architectures) | Verify multi-card cooperation and memory-capacity boundaries. |
| Training - mainline | Fine-tuning of medium-scale LLMs (LoRA or full-parameter) | Closer to common use than pretraining. |
| Training - scalability | Multi-node training of one model | Corresponds to scaling efficiency in section 4.6. |
| Optional supplement | Vision or recommendation models | **Include only when the business actually carries the workload**; otherwise omit. |

> **Inference engines:** Some accelerator cards do not support mainstream inference engines and instead provide proprietary engines. If one mainstream engine is made the only prerequisite, those cards cannot participate in a common comparison. This appendix therefore permits proprietary engines, but records their results separately and declares interface compatibility; results are not merged into one horizontal comparison.

---

## Appendix D. Items Requiring Confirmation

The following items must be confirmed before this draft becomes final. If items 1-4 are missing, the corresponding clauses cannot be executed.

### D.1 Required Inputs

| # | Item | Impact |
|---|---|---|
| 1 | **Benchmark set** (Appendix C): at least two training and two inference models; preferably one actual business workload and one industry-standard model | T10 and T11 cannot run; cross-vendor comparison is unavailable |
| 2 | **Baseline card model** | All reference values are calibrated against its measurements; it provides the compute baseline |
| 3 | **Target domestic OS list:** name, exact version, and kernel version; preferably at least one version with kernel-module signing or Secure Boot enabled | Basis for compatibility decisions in section 4.7; the item cannot be verified without a signed-kernel version |
| 4 | **Target Kubernetes version** | Basis for the supported-version decision in section 4.1 |
| 5 | Assessment-dimension weights (section 8.2) | Affects comparison conclusions |

> For item 2: when there is no comparable baseline model within the baseline card's capability range, the compute measure is mainly a relative scale and should not be used for cross-generation or cross-architecture comparisons. This limitation must be understood during selection.

### D.2 Thresholds

Thresholds are divided into three types by nature, with different confirmation methods. The two-phase activation method is defined in section 5.6.

**D.2.1 Policy thresholds - depend on user needs and have little relationship with card capability**

The following are suggested reference values in this draft; **the user of the framework confirms whether they become formal gates**.

| # | Item | Suggested reference | Description |
|---|---|---|---|
| 1 | Minimum metric collection period | 15 seconds | Determined by monitoring needs; mainstream exporters can usually meet it |
| 2 | Fatal fault detection latency (card loss, driver unresponsiveness, uncorrectable error) | 30 seconds | Common production need; adjust based on measurements if generally unattainable |
| 3 | Other fault detection latency | 5 minutes | Same as above |

**D.2.2 Capability thresholds - calibrated against baseline-card measurements; not rejection criteria in Phase 1**

| # | Item | Reference | Calibration method |
|---|---|---|---|
| 4 | Compute-isolation deviation limit | 10% | Use the baseline-card measurement with reasonable margin |
| 5 | Partitioning performance-overhead limit | No higher than the declaration and no higher than 10% | Same as above |
| 6 | Metric-accuracy deviation limit | 5% | Same as above |
| 7 | Exporter resource-overhead limit | No higher than the declaration and no higher than an agreed multiple of the baseline-card measurement | Multiple to be confirmed |
| 8 | Multi-card / multi-node scaling-efficiency achievement | 90% of the declaration | Same as above |
| 9 | Acceptable numerical-accuracy deviation | | To be confirmed together with Appendix C |

**D.2.3 Method thresholds - selected by the user according to cost and benefit**

| # | Item | Description |
|---|---|---|
| 10 | Long-running test duration (one training and one inference round) | Longer tests reveal more problems but consume more of the POC cycle |
| 11 | Workload-switching rounds | Same as above |
| 12 | Self-check target duration | Expectation for the vendor self-check tool |
| 13 | Maintenance-period requirement | Determined by procurement policy |
| 14 | Duration of each test group (section 5.2) | Related to items 10 and 11 |

> Maximum oversubscription ratio is not included in this table. It is verified against the vendor declaration and has no uniform upper limit; see section 4.2.

### D.3 Framework Items Already Proposed

The following items are already proposed as the **framework** and are no longer open structural questions. Specific parameters and formal gates remain subject to confirmation under D.2 and section 5.6:

- Baseline onboarding requirements, and the optional positioning of DRA and a common middleware layer (section 2.1).
- The relationship between partitioning method, isolation strength, and achievable level, with final tiering based on measurements (sections 2.1 and 4.2).
- Definitions and applicable scenarios for L0-L3, including Hard and Soft L2 tiers (section 2.2).
- The content of the 11 baseline admission requirements (section 3).
- All declaration and deliverable items (section 4 and Appendices A and B).
- The 14 test groups, related clauses, decision rules, and restricted-admission mechanism (section 5).
- Certification validity and retest triggers (section 6).
- The deliverables list (section 7).
- No uniform partition-granularity gate, no uniform oversubscription upper limit, and no requirement for a cross-node logical super-card (sections 4.2 and 4.6).
- T0 and T7b do not determine level classification (sections 4.11 and 4.3).
- Responsibility boundaries and the scope of certification conclusions (section 1.3).

---

## Appendix E. Appendix B Examples (Informative)

This appendix provides three naming styles to show the level of detail required by Appendix B. **These examples are not requirements and do not establish completeness criteria**; vendors complete the mapping according to their actual stack.

### E.1 Example 1: Camel-case Metric and Label Names

| Normalized metric | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|
| Compute utilization | `DCGM_FI_DEV_GPU_UTIL` | Percentage | Proportion of time with a compute task executing |
| Used memory | `DCGM_FI_DEV_FB_USED` | MiB, ×1024×1024 for bytes | Excludes driver-reserved memory |
| Total memory | Derived from `FB_USED + FB_FREE`; no independent metric | MiB | **Mark every derived field here.** |
| Core temperature | `DCGM_FI_DEV_GPU_TEMP` | Celsius | |
| Current power | `DCGM_FI_DEV_POWER_USAGE` | Watts | |
| Raw device error information | `DCGM_FI_DEV_XID_ERRORS` | — | Error codes or events; exact semantics depend on the component version |
| PCIe retransmission count | `DCGM_FI_DEV_PCIE_REPLAY_COUNTER` | Count | |

Labels: node = `Hostname`, device identity = `UUID`, card model = `modelName`.

### E.2 Example 2: Underscore Metric Names with Node Association

| Normalized metric | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|
| Compute utilization | `npu_chip_info_utilization` | Percentage | Compute-unit occupancy |
| Used memory | `npu_chip_info_hbm_used_memory` | MiB | |
| Total memory | `npu_chip_info_hbm_total_memory` | MiB | |
| Device health status | `npu_chip_info_health_status` | 1 = healthy | |
| Core temperature | `npu_chip_info_temperature` | Celsius | |
| Current power | `npu_chip_info_power` | Watts | |
| Inter-card link status | `npu_chip_info_link_status` | 1 = healthy | |

Labels: device identity = `vdie_id`, card model = `model_name`, Pod = `pod_name`.

**Node label:** the metric does not directly carry a node label, so node ownership must be obtained through the Pod dimension. This is acceptable, **but the association method must be documented in Appendix B.11** (corresponding to R4).

### E.3 Example 3: Partition Metrics Distinguishing Quota and Usage

| Normalized metric | Native metric name | Unit / conversion | Semantic description |
|---|---|---|---|
| Compute utilization | `hami_core_util` | Percentage | |
| Used memory | `hami_memory_used` | MiB | Actual usage |
| Total memory | `hami_memory_size` | MiB | |
| Instance memory quota | `hami_container_vmemory_allocated` | MiB | **Allocation amount; different from used amount** |
| Instance compute quota | `hami_container_vcore_allocated` | Cores | Allocation amount |
| Partition instances per card | `hami_vgpu_count` | Count | |

Labels: node = `node`, device identity = `device_uuid`, card model = `device_type`.

**An instance’s “quota” and “used” values are different semantics.** Appendix B.8 requires both to be completed separately; if only one is available, explain the limitation.

### E.4 Label-Style Comparison

| Meaning | Example 1 | Example 2 | Example 3 |
|---|---|---|---|
| Node | `Hostname` | Obtained through association | `node` |
| Device identity | `UUID` | `vdie_id` | `device_uuid` |
| Card model | `modelName` | `model_name` | `device_type` |
| Pod | `pod` | `pod_name` | Obtained through association |

The label name for the same concept differs completely across stacks. Although the numeric range of “utilization” is 0-100 in all three examples, **the semantic definition differs**. In Appendix B, label names and semantic descriptions are therefore as important as metric names.
