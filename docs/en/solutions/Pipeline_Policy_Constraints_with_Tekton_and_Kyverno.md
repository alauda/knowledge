---
products:
  - Alauda Container Platform
  - Alauda DevOps
kind:
  - Solution
ProductsVersion:
  - 4.3.x
---

# Pipeline Policy Constraints with Tekton and Kyverno

:::info Applicable versions

**Applies to: Alauda DevOps Pipelines v4.14.x and later** — that version is the criterion, not the ACP version (this document depends on the Tekton APIs and features shipped with Alauda DevOps Pipelines; the ACP version only determines whether the Kyverno plugin can be installed). On earlier versions these features are incomplete: the policy assets and examples in this document cannot be applied as-is (see [§3.2](#s3-2) for the hard prerequisites), though the mechanisms and design trade-offs are still worth reading. All mechanism explanations, policy assets, and quantitative figures in this document were produced against the following combination of versions:

| Component | Version | Role |
|---|---|---|
| Alauda DevOps Pipelines (the ACP distribution of Tekton Pipelines) | v4.14.x | **Applicability criterion** — below this version, the policy assets do not apply |
| Alauda Artifact Hub Shim (the built-in ACP hub: an Artifact Hub-compatible API consumed by Tekton's hub resolver; the release source of the catalog Task / Pipeline definitions this document references) | v1.0.0 | The template / Task definitions in the [§3.2](#s3-2) contract matrix ship with it |
| Kyverno (ACP Compliance Management plugin) | v1.15.9-v4.3.2 | Policy engine; delivered by ACP's Compliance Management plugin |
| Alauda Container Platform | 4.3 | The platform hosting both of the above (the verification environment for this document) |

**Re-test whenever you change versions.** The mechanisms are usually backward compatible, but result and parameter contracts change with Task and template versions (see the matrix in [§3.2](#s3-2)), and applying them across versions fails as a **silent mismatch** — the failure shape is not an error: the policy stays `Ready`, the reports stay clean, and the path you care about is simply no longer watched. The concrete numbers in this document likewise depend on the runtime environment (scale, network, load); re-measure in the target environment before putting them into a change request. For any combination outside this table, run the positive/negative probe regression per [§3.4](#s3-4) before switching to Enforce; after go-live, whenever any of Kyverno / Tekton / templates / Tasks / ACP is upgraded, use [§3.6](#s3-6) to locate the affected criteria and run the minimal regression set per [§3.8](#s3-8).

:::

## 1. Overview {#s1}

In platform engineering practice, the CI/CD pipeline is the mandatory path through which every change reaches production — which makes it the key leverage point for enforcing an organization's engineering standards. Common governance requirements include:

- **Template sprawl**: business teams bypass the platform-approved pipeline templates and assemble their own pipelines that lack quality steps;
- **Gates switched off**: the code scanning and quality gates in a template are disabled with a single parameter (for example, setting the scan switch to false) — the pipeline "appears to run the template" while the critical steps never execute;
- **Unauthorized sources and targets**: artifacts pulled from unapproved repositories, applications deployed to unauthorized namespaces;
- **Substandard results still shipped**: coverage or vulnerability counts miss the bar, yet the pipeline proceeds through the release stages anyway.

This document describes how to enforce policy constraints on **Tekton**-based pipelines using **Kyverno** on Alauda Container Platform (ACP). Rather than a rule-by-rule how-to, it focuses on **mechanisms**: what Kyverno can see across the pipeline lifecycle, when it sees it, what actions it can take (block, audit, inject, cancel) — and how to build out a policy system tailored to your organization on top of these mechanism points, using custom Tasks and Task results.

### 1.0 What you will be able to do after reading {#s1-0}

Once your environment is prepared per [§3](#s3), you should be able to:

- **Decide which layer owns a given governance requirement** — what Kyverno can block at admission, what only the construction of a trusted template can guarantee, and what must be left to RBAC or after-the-fact audit ([§1.4](#s1-4) boundaries, [§2.3](#s2-3) the seven contracts);
- **Lock template and Task identity**, so business teams cannot change "which template, which version" ([§4.1](#s4-1));
- **Validate the effective values of gate parameters**, so that changes like "set the scan switch to false" or "drop the threshold to 0" are rejected the moment the gate TaskRun is created ([§4.2](#s4-2));
- **Constrain sources and release targets** — only pull material from approved repositories/registries, only release to authorized namespaces ([§4.5](#s4-5));
- **Close the entrances that bypass the pipeline** — bare TaskRuns, unapproved inline definitions and resolver types ([§4.5.4](#s4-5-4));
- **Consume custom Task results** for audit, reporting, and automatic cancellation, bringing your in-house checks into the same governance system ([§2.4](#s2-4), [§4.4](#s4-4), [§4.6](#s4-6));
- **Differentiate and exempt safely** — the two-tier model of platform baseline plus per-project tightening, controlled exemptions via PolicyException, and making sure the scoping itself cannot be bypassed ([§5](#s5));
- **Operate the whole system** — staged rollout order, change and upgrade triggers, scale and failure budgets, and the minimal regression set to run after upgrades ([§3.5](#s3-5)–[§3.8](#s3-8)).

**Out of scope**: image signing and supply-chain attestation (see the companion document *Software Supply Chain Security of ACP with Tekton and Kyverno*), the installation and operation of Kyverno itself (see the ACP Compliance Management documentation), and how to write pipeline templates — this document only states the contracts a template must satisfy.

**Shortest evaluation path**: if all you want is to confirm whether this machinery can block the scenarios you care about, read [§1.4](#s1-4) + [§2.3](#s2-3). To get hands-on, follow the role-based paths in [§1.1](#s1-1).

### 1.1 Audience and reading paths {#s1-1}

| Role | Focus | Suggested path |
|---|---|---|
| Platform administrator (writes policies, manages scope) | The full mechanism picture, scope safety, policy assets | [§2](#s2) mechanisms overview (first learn what can be seen and done) → [§3](#s3) common configuration (install, verify, build fixtures) → [§5](#s5) scope control → [§4](#s4) Cookbook → [§6](#s6) FAQ |
| Project administrator (maintains per-project constraints) | Namespaced `Policy`, per-project tightening, permission boundaries | [§1.3](#s1-3) per-project differentiation and scope safety (the two-tier model) → [§5.1](#s5-1)–[§5.2](#s5-2) scope and RBAC → [§4](#s4) Cookbook (pick what you need; remember to convert the demo's cross-namespace scoping into a `Policy` in your own namespace) |
| Template / Task author (supplies governed pipelines) | Hard-gate contracts, extension contracts | [§2.3](#s2-3) hard-gate contracts → [§2.4](#s2-4) extension model → [§3.2](#s3-2) versions and dependent features → [§3.3](#s3-3) fixtures → [§4.3](#s4-3) genuine gate failure → the relevant parts of [§4.1](#s4-1)–[§4.2](#s4-2) |
| Pipeline user (runs pipelines, gets blocked by policy) | Quick reference of failure shapes, exemption path | [§1.5](#s1-5) quick reference of outcome shapes → [§6.2](#s6-2) user-side FAQ (only read [§6.2.3](#s6-2-3) if your run was auto-cancelled) |
| Walkthrough operator (runs the whole document as a lab) | Every step copy-pasteable, and no leftovers on a shared cluster | [§3.1](#s3-1) verification → **[§3.2](#s3-2) first confirm object results are enabled** (`enable-api-fields`; acceptable values per [§3.2](#s3-2) — if it is off, the very first fixture creation is rejected, with an error that looks like a Kyverno problem) → **[§4.0.3](#s4-0-3) placeholders + [§4.0.4](#s4-0-4) cleanup discipline (read before creating anything: self-created namespaces plus a pre-check for cluster-scoped name collisions are what make deletion possible afterwards)** → [§3.3](#s3-3) build the fixtures and **keep your walkthrough id at hand** → [§4.0.1](#s4-0-1) install order + **[§4.0.5](#s4-0-5) cross-section interference between demos** (the number-one reason "the probe won't run") → your target sections (**run each section's "cleanup" immediately after finishing it** — do not batch them up for the end) → the "final cleanup" in [§3.3](#s3-3) to delete the two shared namespaces; and if you did [§5.3](#s5-3), go back to [§3.1.1](#s3-1-1) at the very end to revert the platform configuration |

**A few items in the [§3.1](#s3-1) checklist are forward references** (`--exceptionNamespace` in [§3.1.1](#s3-1-1), the mutate-existing RBAC in the [§4.6](#s4-6) introduction, replica planning in [§6.1.8](#s6-1-8)): that checklist is a **capability inventory**, not an "all green before you may proceed" gate — items 1 and 2 are shared prerequisites; come back for the rest depending on which chapter's capabilities you actually use.

### 1.2 Kyverno in brief {#s1-2}

Kyverno is a Kubernetes-native policy engine (a CNCF project), delivered on ACP through Compliance Management (the Kyverno plugin). The core concepts relevant to pipeline governance:

- **Architecture**: the admission controller (admission webhook — enforces validate / mutate / image verification), the background controller (scans existing resources, executes mutate-existing / generate), the reports controller (produces compliance reports), and the cleanup controller (periodic cleanup).
- **Policy resources**: `ClusterPolicy` is a cluster-scoped resource, maintained by platform administrators, that can match namespaced resources across the whole cluster as well as cluster-scoped resources; `Policy` is a namespaced resource that only applies to resources inside its own `metadata.namespace` — the right vehicle for letting project administrators self-maintain their project's constraints. A rule is not a standalone Kubernetes resource; it is embedded in the policy's `spec.rules`, and each rule = `match/exclude` (which resources and operations to select) + optional `preconditions` (further filtering) + an action.
- **Action types**:
  - `validate`: validates a resource. In `Enforce` mode it rejects at admission; in `Audit` mode it allows the request but records the result in a **PolicyReport**;
  - `mutate`: modifies a resource at admission (injecting defaults); the **mutate-existing** variant can, upon a triggering event, modify other resources that **already exist** in the cluster;
  - `generate`: creates new resources when triggered;
  - `verifyImages`: image signature verification (not covered here — see the companion document *Software Supply Chain Security of ACP with Tekton and Kyverno*).
- **PolicyException**: the controlled exemption mechanism — it turns "who may bypass which rule" into a separate resource governed by RBAC ([§5.3](#s5-3)).
- **How it works**: once loaded, policies are registered as admission webhooks; every matching API request (CREATE/UPDATE/…) goes through policy evaluation. Audit results and background scan results both land in PolicyReports.

For Kyverno's full capabilities, see the ACP Compliance Management documentation and the upstream Kyverno documentation ([§8.2](#s8-2) References); this document only develops the usage relevant to pipeline governance.

**Terminology used throughout** (these words live at different layers; conflating them makes you misread where a policy acts):

| Term | What it means | What it is not |
|---|---|---|
| **policy** | One Kyverno `ClusterPolicy` / `Policy` resource | Not a gate step inside a pipeline |
| **rule** | One entry in a policy's `spec.rules` (`match` + optional `preconditions` + an action) | Not a standalone Kubernetes resource |
| **criterion** | The boolean expression inside a rule that decides compliant / non-compliant (usually written as a JMESPath variable in `context`) | Not the name of a YAML structure |
| **`deny.conditions`** | The YAML structure that carries the criteria; under `any:` a single hit denies, under `all:` every condition must hold | — |
| **guard (precondition)** | A condition that decides whether the rule applies to this request at all: identity, terminal state, list uniqueness, and so on. A non-match is a **skip (allow)**, not a denial | Not a criterion; writing a criterion as a guard amounts to allowing everything |
| **gate / gate Task** | The Tekton Task in the pipeline that renders the quality verdict (`exit 1` when below the bar), e.g. `sonarqube-scanner`, `trivy-scanner` | Not a Kyverno action |
| **DAG** (directed acyclic graph) | The dependency graph among a pipeline's tasks. Tekton derives it from `runAfter` plus result references between tasks: dependent tasks run in order, independent ones run in parallel, and cycles are not allowed. "The gate's DAG successors" are the tasks that depend on the gate directly or transitively; when the gate fails they are **skipped** — never created at all | Does not include finally tasks — finally is not part of the DAG; it is scheduled only after the whole DAG has finished (this distinction is the key to the outcome-shape table in [§2.3](#s2-3)) |
| **profile** | A set of criteria written against a **specific version** of a real template / Task | Not a generic template |

One sentence to tie it together: **the gate Task's job is to stop unqualified builds; Kyverno's job is to make sure the gate Task is present when it should be and its parameters have not been tampered with** ([§1.4](#s1-4)) — and note that "present when it should be" is not the same as "guaranteed to run": a gate skipped wholesale by `when` / matrix never produces a TaskRun, admission never sees it, and only after-the-fact audit can catch it ([§4.1.5](#s4-1-5)).

### 1.3 Per-project differentiation and scope safety {#s1-3}

Different projects almost inevitably need different constraints: project A sets the coverage bar at 80, project B at 60; and the platform has a set of lines nobody may cross. **Differentiation is a hard requirement — but the way it is implemented must not open a loophole around the policies.** Every policy in this document follows a two-tier model (detailed and verified in [§5](#s5)):

- **Platform baseline**: a `ClusterPolicy` covering **all workload namespaces**, using a **negative `exclude`** to carve out the platform's own system namespaces. The baseline must **not** depend on "this namespace carries a certain label" — otherwise a newly created unlabeled namespace, or one whose label gets changed, naturally escapes the baseline.
- **Per-project tightening**: the main path for project administrators is to maintain namespaced `Policy` resources inside their own project namespaces — they do not need, and should not be granted, `ClusterPolicy` permissions. Where the platform team centrally manages policies for multiple projects, a `ClusterPolicy` + `namespaceSelector` (e.g. on the `cpaas.io/project` label) can select the target projects.

**This section describes the target governance model, not the current state of this document's demo assets**: every policy in [§4](#s4) has its scope hard-coded to the demo namespace `policy-poc` so that installation and cleanup can be uniform ([§4](#s4) introduction, [§4.0.2](#s4-0-2)). **"Covering all workload namespaces" is something you change yourself at production deployment time** — copying the demo YAML verbatim will not cover any real project, and newly created namespaces will of course not be picked up automatically either (that is exactly the first trigger listed in [§3.6](#s3-6)).

The accompanying semantics (which likewise only hold once you deploy per the target model above): an unclassified namespace necessarily falls under the baseline; when multiple policies match the same resource the relationship is **AND** (all must pass; there is no precedence semantics under which a project `Policy` overrides or weakens the platform baseline); and permission to change the scoping labels themselves must also be controlled ([§5.0](#s5-0)). Note that a `Policy`'s scope is a single Kubernetes namespace; if one ACP project spans several namespaces, deploy a corresponding `Policy` in each of them, or have the platform distribute them through a controlled central mechanism.

### 1.4 Roles and boundaries: what Kyverno does and does not govern {#s1-4}

The division of labor in one sentence: **hard gates are implemented by gate Tasks inside the pipeline (below the bar → `exit 1` → the pipeline fails natively); Kyverno's role is to narrow the paths by which a gate gets removed, tampered with, or bypassed from the side — and to provide audit and response actions.**

**Deliberately, this does not say "impossible to bypass"** — that property only emerges from **policies + RBAC + template design combined**; Kyverno alone cannot deliver it. The last two items under "cannot do" below are exactly where the gaps are; the document-wide conditional phrasing is in [§4.0.1](#s4-0-1), "what the minimal usable set guarantees is conditional".

What Kyverno can do:

- **Hard validation at admission**: block at PipelineRun / TaskRun / Pod creation — non-compliant template identity, gate parameters switched off, unauthorized image sources; the object simply cannot be created, and the pipeline terminates with a clear failure shape ([§2.1](#s2-1), [§4](#s4));
- **Audit visibility**: read run results (coverage, vulnerability counts, scan verdicts) on resource status updates, and record misses in PolicyReports ([§4.4](#s4-4));
- **Inject defaults**: mutate at admission (default timeouts, labels, etc., [§4.2](#s4-2));
- **Response actions**: perform a controlled cancellation of a running pipeline (mutate-existing patch of `spec.status`, [§4.6](#s4-6)).

What Kyverno explicitly cannot do (the boundaries):

- **It cannot turn a running pipeline into Failed**: the terminal state of a PipelineRun/TaskRun is decided by the Tekton controller. If you want "results below the bar → failure", the correct answer is for the gate Task itself to `exit 1`; what Kyverno can do is **cancel** (terminal state Cancelled, [§4.6](#s4-6)).
- **Never block writes to `*/status` subresources with Enforce**: what you would be blocking is the Tekton controller's status write-back. The result is a resource stuck in Running with the controller retrying forever (a wedge) — not a failure ([§2.2](#s2-2), [§6.1.4](#s6-1-4)).
- **Remotely referenced definitions (hub / git resolver) never pass through cluster admission**: Kyverno can only lock the **identity** (which catalog entry, which commit); trust in the content comes from external governance (catalog release process, repository permissions). The three tiers of strength are in [§2.1](#s2-1).
- **It cannot see a skipped gate**: when a `when` expression is false, or a matrix expands to nothing, that gate **never produces a TaskRun**, so admission has no object to reject — "the gate must run" can only be guaranteed by template design (do not give the gate a `when` that business teams can switch off) plus the **after-the-fact Audit** of `status.skippedTasks` in [§4.1.5](#s4-1-5). It is not an admission-time hard block.
- **It cannot block the path that avoids Tekton entirely**: an identity with workload API permissions can create Pods / Jobs / Deployments directly, or use the deployment credentials somewhere else, without a single PipelineRun. **Only RBAC can close this layer** ([§4.5.4](#s4-5-4)) — the entry-closure policies in this document seal off bare `TaskRun` / `CustomRun`, not every API capable of running a container.
- **It cannot protect itself**: every conclusion in this document rests on "the policy system and Kyverno's own configuration are controlled". Whoever can modify `ClusterPolicy` / `PolicyException` can modify the gates ([§5.3](#s5-3) / [§5.0](#s5-0)); whoever can modify Kyverno's `resourceFilters` or its webhooks can make an entire chapter of policies **silently stop enforcing** ([§3.1](#s3-1) checklist item 7 / [§5.0](#s5-0)); whoever can modify Tekton's platform configuration can swap out the template resolution source ([§4.1.1](#s4-1-1)) or break the scoping labels the image policy relies on ([§3.6](#s3-6)). **These identities are outside this document's threat model** — they are closed off by RBAC separation of duties, change auditing, and the policy system's self-protection ([§5.0](#s5-0)), not by writing yet another policy.

### 1.5 Quick reference of outcome shapes (for pipeline users) {#s1-5}

When a policy acts on your pipeline, you will see one of the following five shapes (mechanisms in [§2](#s2), troubleshooting in [§6](#s6)):

| What you see | What it means | Where to look for the reason |
|---|---|---|
| Creating the PipelineRun is rejected outright (kubectl / UI shows an admission error) | Admission blocking: template / parameters / entry non-compliant | The error message itself is the policy message (policy name, rule name, reason) |
| PipelineRun fails with reason `CreateRunFailed`; some mid-pipeline Task was never created | Mid-run admission blocking: the effective parameters of a gate Task are non-compliant | `kubectl describe pipelinerun`; the condition message carries the full policy message |
| PipelineRun fails with reason `Failed`; the gate Task is red | A genuine quality-gate failure (coverage / vulnerabilities below the bar). **Exception**: a non-empty `spec.status` (`CancelledRunFinally`) means **someone — or some policy — did request cancellation** and the task's own failure merely outranked it; `spec.status` alone cannot tell you who wrote it | The gate Task's logs; if `spec.status` is non-empty, follow [§6.2.3](#s6-2-3) to look for `cancel-reason` / `statusMessage` — only with those markers is it a policy cancellation; without them the origin is unknown (a manual cancel looks exactly the same) |
| TaskRun fails with reason `PodCreationFailed`; the Pod never appeared | Pod-level admission blocking: the container image for this step is not on the approved list ([§4.5.3](#s4-5-3)) | `kubectl describe taskrun`; the message carries the full policy message |
| The PipelineRun turns `Cancelled` (and you didn't cancel it) | A policy response action. **There are four possible origins**: parent run cancelled for non-compliant gate parameters ([§4.2.2](#s4-2-2)), gate TaskRun cancelled for non-compliant parameters ([§4.2.3](#s4-2-3)), results below the bar ([§4.6.1](#s4-6-1)), definition drift ([§4.6.2](#s4-6-2)) | The four leave their evidence in different places; work through them in the order given in [§6.2.3](#s6-2-3) (the mechanism differences are summarized in the table in the [§4.6](#s4-6) introduction) |

## 2. Understanding the Mechanisms {#s2}

This chapter is the core of the document. Two models run through everything that follows:

- **Model 1: the lifecycle observation/action matrix ([§2.1](#s2-1)–[§2.2](#s2-2))** — what Kyverno can see along the pipeline lifecycle, when it sees it, and what it can do;
- **Model 2: the trust and hard-gate contracts ([§2.3](#s2-3))** — the seven contracts that make up an "unbypassable quality gate", and who guarantees each one.

Every section of the Cookbook ([§4](#s4)) is an instantiation of these two models in a concrete scenario.

### 2.1 The lifecycle observation/action matrix {#s2-1}

The typical lifecycle of a reference-style pipeline (`pipelineRef` pointing at a template), with Kyverno's intervention points:

```text
Pipeline/Task definition stored (CREATE/UPDATE)  ← observation point 1 (in-cluster definitions only)
        │
PipelineRun CREATE ── admission ─────────────── ← observation point 2 (the primary hard blocking point)
        │ resolver resolution (cluster/hub/git)
PipelineRun status UPDATE (resolution written) ── ← observation point 3 (the only place a referenced definition can be introspected)
        │ TaskRuns created one by one
TaskRun CREATE ── admission ─────────────────── ← observation point 4 (hard blocking point after parameter expansion)
        │ execution Pod created
Pod CREATE ── admission ─────────────────────── ← observation point 5 (hard blocking point for the images that actually run)
        │ execute, write back results
TaskRun status UPDATE (results written) ──────── ← observation point 6 (the only source of results)
        │
PipelineRun status UPDATE (terminal state, pipelineResults)
```

| # | Observation point | What is visible | What can be done / caveats |
|---|---|---|---|
| 1 | Pipeline / Task definition resource CREATE/UPDATE (**in-cluster definitions only**) | The full definition spec is introspectable: tasks, finally, parameter defaults, labels | Enforce-validate the stored content (must contain the gate task, etc.) + lock change permissions (only platform administrators / a designated CI identity may modify, [§4.1](#s4-1)). **Coverage comes in three tiers**: ① inline / in-cluster direct ref — introspectable and lockable at admission; ② hub / git **immutable reference** (pinned version / commit SHA) — in-cluster you can only lock the **identity**; content trust comes from external catalog / repository governance; ③ hub / git **mutable reference** (branch / tag) — content changes take effect automatically as the remote moves; Kyverno can only lock "which branch / tag is referenced". Using this tier requires repository-side permission controls (protected branches / tags); otherwise it should be rejected |
| 2 | `PipelineRun` CREATE admission | `pipelineRef` (resolver type + all resolver parameters), **`spec.params` with values**, workspaces, labels, **`request.userInfo`** (creator identity) | Enforce: template identity allowlist, PipelineRun-level parameter contracts, entry identity constraints; mutate: inject defaults (timeout / label, [§4.2.6](#s4-2-6)). ⚠️ For a reference-style pipeline, `spec.pipelineSpec` is **empty** at this moment — the definition content is invisible, and so are task-level parameters |
| 3 | `PipelineRun/status` UPDATE (subresource) | The resolver-resolved **`status.pipelineSpec`** (the only place in the cluster a referenced definition can be introspected), `status.childReferences`, **`status.skippedTasks`** (each skipped task's `name` + `reason` + `whenExpressions`; `reason` values come from Tekton's `SkippingReason` enum), `status.pipelineResults` (only present after completion — far too late for admission) | Past admission = after-the-fact view. **Never Enforce-deny** (wedge, [§2.2](#s2-2)). Correct uses: **Audit as defense in depth** (resolved definition missing the gate task → record in PolicyReport, [§4.1.4](#s4-1-4); gate skipped by `when` / empty matrix → read `status.skippedTasks` and record, [§4.1.5](#s4-1-5)); **response action**: trigger self-cancellation ([§4.6.2](#s4-6-2)) |
| 4 | `TaskRun` CREATE admission | `spec.taskRef` (resolver + kind/catalog/name/version/namespace), labels (visible but **untrusted**: `tekton.dev/pipeline` / `tekton.dev/pipelineTask` / `tekton.dev/pipelineRun` can be overridden via `taskRunSpecs` — usable as troubleshooting hints, never to locate a trusted profile or the parent run), `request.userInfo`, the controller ownerReference, and **`spec.params` = the expanded, effective parameter values** (`$(params.x)` already resolved to concrete values — **task-level gate parameters can be validated without being surfaced at the PipelineRun level**); step images visible only for inline taskSpec. ⚠️ `tekton.dev/task` is visible on the final TaskRun but may not yet be present at real CREATE admission time, so it likewise cannot serve as an identity precondition at this stage; parent identity must be derived from the controller ownerReference + an `apiCall` for the live parent's UID/`spec.pipelineRef` | Enforce: **validation of the gate task's effective parameters** (deny → the parent run fails cleanly with `CreateRunFailed`, the policy message passed through verbatim into the run condition, [§4.2](#s4-2)), bare-TaskRun closure ([§4.5.4](#s4-5-4)), taskRef allowlist. ⚠️ A parameter the pipeline did not bind **does not appear** in `spec.params` (the task definition's default takes effect) — a policy may interpret absence as that trusted default only when `spec.taskRef` is already locked to an exact Task version whose defaults are trusted; with untrusted identity or unknown defaults it must fail closed |
| 5 | **Pod CREATE / plain UPDATE / `Pod/ephemeralcontainers` UPDATE admission** (Tekton execution Pods, in-flight image updates, and debug containers injected after the fact) | CREATE and plain UPDATE expose the actual step / sidecar / init container images, securityContext, labels (`tekton.dev/taskRun` etc.), volumes; the subresource UPDATE exposes `spec.ephemeralContainers` | **The reliable hard blocking point for the images that actually run** (non-compliant execution image → TaskRun `PodCreationFailed`; non-compliant main/init images on plain UPDATE and non-compliant ephemeral-image patches are rejected the same way, [§4.5.3](#s4-5-3)). **What this layer can do**: registry allowlist, digest requirements, no-privileged, image signature verification (verifyImages); **this document ships only the registry-prefix allowlist** ([§4.5.3](#s4-5-3)) — digest / privileged / signing each need their own policy; for verifyImages see the companion document |
| 6 | `TaskRun/status` UPDATE (subresource) | **Task results** (object-result drill-down / aggregate-string parsing) and the terminal state — **the only source of results** | One run triggers multiple UPDATEs, so a terminal-state guard is required ([§4.4](#s4-4)); usable only for **Audit** or as a **mutate-existing trigger** (cancellation, [§4.6](#s4-6)) — **never Enforce** (wedge) |
| 7 | Pod status / events | The failure scene at runtime | Troubleshooting observation only ([§6](#s6)); carries no policy action |
| 8 | External data sources | `context.apiCall` (query other in-cluster resources during admission: Pipeline definitions, the parent PipelineRun, …), `context.imageRegistry` (read image config; usage in [§4.5.2](#s4-5-2)) | apiCall's JMESPath syntax is strict ([§6.1.7](#s6-1-7)); imageRegistry can only read images that already exist in the registry, and it puts external network calls on the admission path (latency and timeout risks in [§4.5.2](#s4-5-2)) |

### 2.2 Enforcement and action modes {#s2-2}

| Mode | Use for | Key boundaries |
|---|---|---|
| `validate` + **Enforce** | Template / parameter / definition / Pod constraints (CREATE on observation points 1/2/4, plus Pod CREATE / plain UPDATE / `Pod/ephemeralcontainers` UPDATE on point 5) — non-compliant requests are rejected outright | For CREATE/UPDATE on main resources, or on **non-status subresources** explicitly brought under governance such as `Pod/ephemeralcontainers`; never on `*/status` UPDATE. Operational boundary: the webhook's `failurePolicy` decides whether Kyverno being unavailable means allow-everything (Ignore) or reject-everything (Fail) — verify it in [§3.1](#s3-1) and have a playbook in [§6.1](#s6-1) |
| `validate` + **Audit** | Result constraints (status UPDATE on observation points 3/6) — allowed through, but recorded in PolicyReport | **Reading status is Audit-only.** ⚠️ Subresource match and `background: true` are mutually exclusive — result-type Audit only has the admission moment; there is no background-scan backstop |
| `mutate` (admission injection) | Injecting default timeout / labels / SA etc. (observation point 2) | The `+(field)` anchor = add-if-absent: it never overwrites a user's explicit value ([§4.2.6](#s4-2-6)) |
| **mutate-existing** | Response action: on a triggering event, patch other resources that **already exist** in the cluster — used in this document to cancel pipelines ([§4.6](#s4-6)) | Requires the background controller to hold update RBAC on the target resource (**Kyverno validates that RBAC at policy-creation time; without it the policy fails to install**, [§3.1](#s3-1)). When triggered by admission events and using `subjects` / `request.userInfo`, it must set `background: false`; only enable `background: true` when you genuinely need policy updates to scan pre-existing trigger resources and the rule uses none of those request variables |
| `generate` | Auto-provisioning namespaced Policies for new project namespaces, etc. | Lifecycle management is complex; not covered here (Advanced) |
| `verifyImages` | Image signatures / attestations | See the companion document; one of the trust prerequisites for the "identity" contract in [§2.3](#s2-3) |

**The anti-mechanism (burn this in)**: hanging `validate + Enforce` on UPDATE of `tekton.dev/v1/TaskRun/status` or `PipelineRun/status` blocks **the Tekton controller's completion write-back** — the TaskRun sticks at Running, the controller retries `UpdateFailed` forever, and the pipeline neither fails nor ends until a human intervenes (reproduction and recovery steps in [§6.1.4](#s6-1-4)). This is the single easiest trap on the road to "I want the pipeline to fail": **denying the status write ≠ making it fail**.

### 2.3 Trust and the hard-gate contracts {#s2-3}

**Positioning**: hard gates (coverage bars, vulnerability thresholds — "below the bar shall not pass") are implemented by a **gate Task inside the pipeline** — the gate reads the results of earlier tasks and exits 1 when the bar is missed; the pipeline fails natively (`Failed`), and the release tasks ordered after the gate (`runAfter`) are skipped by the DAG, **never created at all**. Kyverno's responsibility is to **verify the statically verifiable parts of this contract set**; the rest is guaranteed by the construction of trusted templates (by construction) and by external governance.

An "unbypassable hard gate" = all seven of the following contracts holding at once. Guarantors come in three kinds: **K** = statically verifiable by Kyverno, **T** = promised by trusted-template construction (true by the way the template is built, not by runtime checks), **E** = external governance. The skeleton first:

| # | Contract | One-liner | Guarantor | Details |
|---|---|---|---|---|
| 1 | Identity | The gate uses a trusted Task with an immutable reference (pinned / digest) | K + E | [§4.1](#s4-1) |
| 2 | Effective parameter values | Switches / thresholds validated on the expanded, effective values | K | [§4.2.1](#s4-2-1) |
| 3 | Must-run | The gate is not skipped via `when` / matrix / defaults | T + K post-hoc Audit | [§4.1.5](#s4-1-5) |
| 4 | Data binding | The gate consumes the results of the intended task | T | — (template responsibility) |
| 5 | DAG dominance | Release-type side-effect tasks must be ordered after the gate | T + K post-hoc Audit | [§4.1.4](#s4-1-4) |
| 6 | finally safety | No gate-protected side effects inside finally | T + K post-hoc Audit | [§4.2.2](#s4-2-2) |
| 7 | Entry closure | No bypassing the pipeline via bare TaskRuns / inline definitions / unapproved resolvers | K + RBAC | [§4.5](#s4-5) |

In detail:

1. **Identity** (K + E): the gate uses a trusted Task with an immutable reference (pinned version / digest). K locks the reference identity ([§4.1](#s4-1)); the integrity of step images (digest / signature), registry push permissions, and the credential safety of external scanning services belong to the external trust surface (E; image signing is verifyImages / the companion document).
2. **Effective parameter values** (K): gate switches, thresholds, target branches, and so on are validated on the **expanded, effective values**. Validation site = **gate TaskRun CREATE** — at that moment `$(params.x)` has been resolved to concrete values; identity is derived from the controller `ownerReference` + the live parent run + `spec.taskRef` (child labels can be forged by the caller and are unusable), and template authors owe zero changes. Response: Enforce deny (the gate TaskRun cannot be created → the parent run fails cleanly with `CreateRunFailed`) or cancel the parent run ([§4.6](#s4-6)); when a template already exposes the parameters at the PipelineRun level, **blocking early** at PipelineRun CREATE is an optional optimization. Full derivation and policy in [§4.2.1](#s4-2-1).
3. **Must-run** (T + K post-hoc Audit): the gate is not skipped by `when` expressions / matrix / conditional branches / parameter defaults. The classic trap: the scan-URL parameter defaults to empty + `when: sonarURL != ''` ⇒ by default the scan is skipped entirely and the gate becomes opt-in. ⚠️ **A skipped gate produces no TaskRun** — contract 2's admission validation is blind to absence (admission cannot block what never happens). So must-run is grounded in T (the template offers no skip path); on the K side, post-hoc Audit of **`status.skippedTasks`** (the controller records every skip with its `reason` into the PipelineRun status) determines whether the gate was opted out — still Audit, and it cannot stop the current run. How to classify the reasons and write the policy: [§4.1.5](#s4-1-5).
4. **Data binding** (T): the gate really consumes the results of the designated producer task (the `$(tasks.scan.results.x)` wiring is correct). Admission cannot see expression-level bindings; the template guarantees this.
5. **DAG dominance** (T + K post-hoc Audit): **every** release / push / promotion side-effect task must depend on the gate transitively (`runAfter`, directly or indirectly). The gate can only stop its DAG successors — **tasks ordered before or parallel to the gate may already have finished, and failure does not roll back side effects that already happened**. Making side effects dominated by the gate is a template design responsibility.
6. **finally safety** (T + K post-hoc Audit): finally tasks execute when the pipeline fails, or when it is cancelled with **`CancelledRunFinally`** (whether finally runs under deny vs. cancel is contrasted in the table in [§4.2.2](#s4-2-2); the full trade-off across the three response shapes is in [§4.2.3](#s4-2-3)); a plain `spec.status: Cancelled` does not guarantee scheduling of finally tasks that have not started — so finally must not contain any gate-protected side effect (release, push).
7. **Entry closure** (K + RBAC): business identities must not bypass the pipeline by creating bare TaskRuns, must not use unapproved inline definitions, must not use unapproved resolver types; `CustomRun` is denied by default or explicitly declared unsupported ([§4.5.4](#s4-5-4)).

**Kyverno's three verifiable things** (the taxonomy for every Enforce policy in this document): template identity allowlisting (per the three tiers in [§2.1](#s2-1); **change permissions** on in-cluster definitions are separately closed off by standard RBAC, see [§4.1.2](#s4-1-2) — that one does not count as Kyverno-verifiable); parameter contracts (effective values at the TaskRun level as the main path, early blocking at the PipelineRun level as the auxiliary path); entry closure. **Audit / PolicyReport is the second, after-the-fact line of defense — for spotting drift and backstop alerting; it does not count toward the hard gate's guarantee.** Audit blocks nothing.

**Failure / termination shape comparison** (pipeline users' quick reference is [§1.5](#s1-5)):

| Shape | Trigger | Run terminal reason | Downstream release tasks | finally | How the failure is surfaced |
|---|---|---|---|---|---|
| Admission rejects the gate TaskRun's creation (contract 2 response) | Gate's effective parameters non-compliant | `CreateRunFailed` (terminal, no retry) | Never created (`skippedTasks` empty) | **Does not run** | The Kyverno policy message is passed through verbatim into the PipelineRun condition |
| Gate task exits 1 (the mainline hard gate) | Results below the bar | `Failed` | Skipped by the DAG; listed in `skippedTasks` (reason `PipelineRun was stopping`) | **Runs** | The gate task's logs + "Tasks Completed: N (Failed: 1)" |
| mutate-existing cancellation ([§4.6.1](#s4-6-1)) | Results below the bar (status-event triggered); a missing / malformed result triggers the same way, fail-closed | Usually `Cancelled`; when the result-producing task itself failed first it is `Failed` (the failure verdict outranks the cancellation; `spec.status` still reads `CancelledRunFinally`) | In-flight ones are stopped with `TaskRunCancelled` | **Runs** | The parent run's `cancel-reason` annotation (written by the same patch; the text names the triggering TaskRun and the out-of-bounds result value) + events; with the companion Audit rule there is also a PolicyReport record |
| mutate-existing self-cancellation ([§4.6.2](#s4-6-2)) | Resolved-definition drift (the `pipelineSpec` written back into `status` does not match the approved identity) | `Cancelled` | Same as above | **Runs** | The parent run's `cancel-reason` annotation (stating the drift) + events |
| **mutate-existing cancellation (RunFinally) replacing deny on non-compliant gate parameters ([§4.2.2](#s4-2-2))** | Non-compliant effective parameters detected on the gate TaskRun | `Cancelled` | Tasks before the gate already ran; from the gate onward, cancelled | **Runs** | Generic cancellation text + the `cancel-reason` annotation |
| **Admission-mutate cancelling the gate TaskRun itself (the synchronous alternative to deny, [§4.2.3](#s4-2-3))** | Gate's effective parameters non-compliant | `Cancelled` | Skipped by the DAG; listed in `skippedTasks` (reason `PipelineRun was stopping`) | **Runs** | The TaskRun condition carries the policy-written `statusMessage` verbatim (visible in tkn / the UI); no violation record in PolicyReport |

:::info Why "admission rejecting the gate TaskRun" skips finally (a known community issue)

The behavior has been reported upstream: https://github.com/tektoncd/pipeline/issues/10514 (*finally tasks are not executed when a child run creation is permanently rejected*; still open as of this writing). The community Pipelines version used by the current ACP release carries this issue; until the upstream fix lands, the selection guidance below applies. The mechanism:

- **Mechanism**: finally is scheduled only after the whole DAG has finished, and "finished" requires every DAG task to land in one of succeeded / failed / **skipped**. A gate TaskRun rejected at admission **was never created**, so that node can never reach any of the three — the DAG never counts as finished, finally is never scheduled, and the controller promptly moves the run to the `CreateRunFailed` terminal state.
- **Contrast**: when the gate task exits 1, the TaskRun was created, ran, and failed — the node has a terminal state, the DAG can finish, and finally runs as usual. The dividing line is **whether the gate node reached a terminal state**, not whether the run failed.
- **How to recognize this shape**: the run is `CreateRunFailed`, there are no child TaskRuns, finally never got created, and `skippedTasks` is empty.

:::

:::warning Selection note: teams that rely on finally for notifications / cleanup, pay attention

- Under the admission-rejection shape (`CreateRunFailed`), finally **does not run**; finally runs per the comparison above only when the gate task landed and then failed, or when the run is cancelled explicitly with `CancelledRunFinally`.
- If your notification / cleanup must fire even when gate parameters are blocked, do not hang it on finally alone — replace deny with a **cancel (RunFinally)**, via either of two routes:
  - **[§4.2.2](#s4-2-2) (cancel the parent run)**: on scan TaskRun CREATE, trigger mutate-existing to patch the parent PipelineRun's `spec.status=CancelledRunFinally` and stamp a reason annotation; the run terminates as `Cancelled` but finally runs as usual (cancellation triggered by below-the-bar results is [§4.6](#s4-6)).
  - **[§4.2.3](#s4-2-3) (the other synchronous shape: cancel the gate TaskRun itself)**: leave the parent run alone and instead mutate the gate TaskRun itself to `spec.status=TaskRunCancelled` during admission — it completes within the same admission pass, has no race window, and needs no extra background-controller RBAC.
- The trade-off across the three shapes is in the comparison table in [§4.2.3](#s4-2-3).

:::

### 2.4 The extension model: growing policies from custom Tasks and results {#s2-4}

Beyond the platform's built-in scanning / gating capabilities, every organization has checks of its own (in-house linters, license scans, security baselines, artifact conventions, …). The extension path has three steps:

1. **The Task produces declarative results**: a custom Task writes its conclusions as **decidable results** — a number (`error-count`), an enum verdict (`verdict: pass|fail`), or a structured object — not "the path to a report file". Tekton results come in three declared types — `string` / `array` / `object` — and the policy side can consume all three: `status.results[].value` is serialized per the declared type (string → a string, array → an array of strings, object → a map of strings), so JMESPath receives the corresponding native structure:
   - **`type: object` (use it for multi-field structures)**: the Task declares `type: object` + `properties`, and the policy drills straight down with JMESPath `.value.xxx` — fields have names and a schema, and the policy never parses any text format. Note that the values under `properties` can only be `string` (no nested objects / arrays); when you need hierarchy, flatten the field names;
   - **`type: array` (use it for homogeneous lists)**: the value is an array of strings; the policy filters with `[?...]`, `contains(...)`, `length(...)` — e.g. "the list of unfixed critical CVEs must be empty". It solves "many values", not "many fields" — semantically distinct fields still belong in an object;
   - **`type: string` (the default)**: most direct for single values — one number or one enum verdict per result; the policy converts with `to_number` or compares directly, with zero parsing risk.
     - **Aggregate strings (a convention layered on `type: string`; a compatibility measure, not recommended)**: packing several fields into one string result as `key=value` concatenation, unpacked on the policy side with `split` + regex + `to_number` ([§4.4.2](#s4-4-2)). **It does work** — but only do it when consuming an **existing Task contract you cannot change yet**: a text format is not a stable contract; field order, separators, added fields, and "count unknowable" sentinel values all cause silent mismatches — and a mismatch typically shows up as **falsely scored as passing**. When you own the contract and have several fields to aggregate, use `type: object`.
2. **For a hard gate**: the Task renders its own verdict and exits 1 (or is immediately followed by a gate task that reads the result) — entering the [§2.3](#s2-3) contract system, subject to identity locking and parameter validation;
3. **For visibility / backstop**: an Audit policy reads the result into PolicyReport ([§4.4](#s4-4)); below-the-bar results can additionally trigger automatic cancellation ([§4.6](#s4-6)).

**Two-layer parameter validation** (same as contract 2): the main path = validating the expanded, effective values at TaskRun CREATE (works for any template as-is, zero design obligations on template authors); the optional optimization = when the template already exposes the switch / threshold as a PipelineRun-level parameter, block early at PipelineRun CREATE.

**Trust prerequisite**: custom Tasks fall under contract 1 like everything else — immutable reference + trusted image. Otherwise "push a script version that always prints pass" is the cheapest bypass there is.

[§4](#s4), the Cookbook, threads this extension path through a fictional, self-contained scanner task (`policy-demo-scanner`); real Tasks from the platform catalog such as sonarqube / trivy appear as profile subsections with their real result contracts.
## 3. Common Configuration and Operating Discipline {#s3}

This chapter completes, in one pass, the environment verification and shared resources that every later chapter depends on ([§3.1](#s3-1)–[§3.4](#s3-4)), and lays down the operating discipline you keep observing once these policies are live ([§3.5](#s3-5)–[§3.8](#s3-8): staged rollout, change triggers, scale and failure budgets, the upgrade regression set). **Only the first half is needed to get started; the second half is what you come back to, again and again, once the policies are in production.**

:::warning Which cluster do the commands run on

**The `kubectl` commands in this document run, by default, on the workload cluster that hosts Kyverno and Tekton** (the target cluster from here on) — including this chapter's verification checklist and fixtures, and every policy and probe in [§4](#s4)–[§6](#s6).

**The only exception is [§3.1.1](#s3-1-1)**: changing the configuration of platform-managed components goes through the `ModuleInfo` on the global management cluster; that section's commands explicitly carry `--kubeconfig <path-to-global-kubeconfig>` — write them exactly as shown and do not reuse the current context.

Before doing anything, confirm your current context points at the target cluster; do not create demo resources on the global cluster:

```bash
kubectl config current-context
# Expect the context of the cluster that runs Kyverno and Tekton. If it points
# anywhere else, switch first: kubectl config use-context <target-context>
kubectl get deploy -n kyverno kyverno-admission-controller
# Expect the controller to exist here. NotFound means you are on the wrong
# cluster (or Kyverno is not installed yet -- see the checklist below).
```

:::

### 3.1 Installation and capability verification checklist {#s3-1}

Both components install through ACP's modular mechanisms, and both support air-gapped environments:

- **Kyverno**: administrator view → **Marketplace → Cluster Plugins** → search `kyverno` → install **"Alauda Container Platform Compliance for Kyverno"**. Once installed, Kyverno is managed by the platform as Helm / AppRelease, with the four controllers deployed in the `kyverno` namespace.
- **Tekton Pipelines**: administrator view → **Marketplace → OperatorHub** → install **"Alauda DevOps Pipelines"**; from then on `TektonConfig` manages Pipelines / Triggers / Chains and the resolver switches.

Product documentation: Compliance Management (Kyverno) installation and configuration, DevOps (Tekton) installation — see the official ACP documentation links in [§8.2](#s8-2).

:::warning Do not change managed configuration on the Deployment directly

ACP's Kyverno is managed by a platform module (Helm / AppRelease) and **periodically reconciled** — any argument change made by directly `kubectl patch`ing the controller Deployment (for example manually adding `--exceptionNamespace`) **will be reverted by the next reconcile**. All controller-level configuration must be persisted through the platform module's configuration entry point (how-to in [§3.1.1](#s3-1-1)).

:::

**Confirm three prerequisites first, or the commands below will give misleading results**:

```bash
# 1) Tekton's namespace: this document (including the checklist below) writes the
#    literal tekton-pipelines for readability, but on ACP the operator decides it
#    and it may be something else. TektonConfig is authoritative. Every later code
#    block that uses it starts with a fallback line : "${TEKTON_NS:=tekton-pipelines}",
#    so the blocks run even when read out of order; but **tekton-pipelines inside
#    policy YAML is a literal** (controller ServiceAccount subjects,
#    system:serviceaccount:tekton-pipelines:... and the like) -- a shell variable
#    cannot be substituted in. When targetNamespace is not that name, every
#    occurrence must be edited by hand; a missed one means the rule silently skips.
TEKTON_NS=$(kubectl get tektonconfig config -o jsonpath='{.spec.targetNamespace}')
# Exported so the commands you run from this shell (including subshells and scripts)
# see it. It does NOT survive a new terminal, which is why later blocks re-assert the
# default on their first line instead of trusting the variable to be there.
export TEKTON_NS=${TEKTON_NS:-tekton-pipelines}
echo "Tekton namespace: $TEKTON_NS"

# 2) Checklist items 3 and 4 use --as to query someone else's permissions, which
#    requires impersonate permission; without it the command itself reports
#    forbidden (which is NOT a "permission missing" verdict). If you lack
#    impersonate permission, inspect the ClusterRoleBindings directly instead:
#    kubectl get clusterrolebinding -o json | jq '…kyverno…'
echo "can impersonate serviceaccounts: $(kubectl auth can-i impersonate serviceaccounts)"

# 3) Client tools: besides kubectl, the commands in this document use jq (parsing
#    childReferences / PolicyReport / result JSON) and python3 (generating the
#    regex in §4.5.3). Install whichever is missing -- you can read without them,
#    but the corresponding steps cannot be followed along.
for tool in kubectl jq python3; do
  command -v "$tool" >/dev/null 2>&1 && echo "$tool: ok" || echo "$tool: MISSING"
done
# §4.5.2 reads image labels, and for that EITHER skopeo OR crane is enough -- so this
# one is an either-or, not a per-tool requirement. Missing both only blocks §4.5.2.
if command -v skopeo >/dev/null 2>&1 || command -v crane >/dev/null 2>&1; then
  echo "skopeo/crane: ok (at least one)"
else
  echo "skopeo/crane: BOTH MISSING -- only §4.5.2 needs them"
fi
# The kyverno CLI is a LOCAL binary, separate from the in-cluster Kyverno install --
# having Kyverno running does not give you this command. Only §6.1.6's offline
# evaluation uses it, so missing it blocks nothing on the walkthrough path.
# Probe by RUNNING it, not by resolving a path: a version-manager shim (mise/asdf)
# resolves fine yet fails on every invocation, so `command -v` reports a false "ok".
kyverno version >/dev/null 2>&1 \
  && echo "kyverno (CLI): ok" \
  || echo "kyverno (CLI): MISSING or not runnable -- optional, only §6.1.6 uses it"
```

Once installed, verify each capability this solution depends on, item by item. This checklist is a **capability inventory, not an "all green before you may proceed" gate**: items 1 and 2 are shared prerequisites; items 3, 4, and 5 only need to hold when you use the corresponding chapter's capabilities; item 6 has no right or wrong — it is planning input; and item 7 is the **single check where "not as expected" means an entire chapter of policies is void**. **Where to fix each item that does not match expectations is in the remediation table after the code block.**

```bash
# 1. All four controllers must be Ready
#    Expect kyverno-admission-controller / background-controller / cleanup-controller /
#    reports-controller with all replicas Ready. A single replica is not acceptable
#    long term in production; size the replica count per your HA plan (§6.1.8).
#    Every item below prints an "== N) ... ==" banner first, so the combined output of
#    this block reads back against the checklist numbers without guessing.
echo "== 1) Kyverno controllers =="
kubectl get deploy -n kyverno

# 2. Tekton controllers and resolver feature flags
#    TEKTON_NS is set by the prerequisite block above; this line only fills it in if you
#    copied this block alone. It is not cosmetic: with the variable unset, `-n ""` reads
#    the CURRENT namespace and still exits 0, so the three checks would report an empty
#    Tekton namespace instead of failing loudly.
: "${TEKTON_NS:=tekton-pipelines}"
echo "== 2) Tekton controllers and resolver flags (ns: $TEKTON_NS) =="
kubectl get deploy -n "$TEKTON_NS"
echo "resolver feature flags:"
kubectl get cm -n "$TEKTON_NS" resolvers-feature-flags -o jsonpath='{.data}{"\n"}'
#    Expect enable-cluster-resolver / enable-hub-resolver / enable-git-resolver to be
#    "true" as required by the resolvers you actually use
echo "hub default-type: $(kubectl get cm -n "$TEKTON_NS" hubresolver-config -o jsonpath='{.data.default-type}')"

# 3. RBAC prerequisite for mutate-existing (required by the cancellation policies in §4.6)
echo "== 3) mutate-existing RBAC (only needed for §4.6) =="
echo "background-controller can update pipelineruns: $(kubectl auth can-i update pipelineruns.tekton.dev \
  --as=system:serviceaccount:kyverno:kyverno-background-controller -A)"
#    "no" means you must grant it as described in the §4.6 preamble; without the grant Kyverno
#    rejects those policies at creation time

# 4. Effective reports-controller permissions on the Tekton /status subresource
#    (all three verbs: get / list / watch). "no" is usually fine -- see the notes below
echo "== 4) reports-controller perms on /status (no is usually fine) =="
for resource in pipelineruns.tekton.dev taskruns.tekton.dev; do
  for verb in get list watch; do
    echo "  $resource status/$verb: $(kubectl auth can-i "$verb" "$resource" \
      --subresource=status \
      --as=system:serviceaccount:kyverno:kyverno-reports-controller -A)"
  done
done

# 5. PolicyException feature flags (required by §5.3)
echo "== 5) PolicyException flags =="
kubectl get deploy -n kyverno kyverno-admission-controller \
  -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -i exception
#    Expect BOTH --enablePolicyException=true and --exceptionNamespace=<trusted-namespace>.
#    Only the first one present is the ACP default -- configure the second per §3.1.1

# 6. Webhook failure policy (fail-open or fail-closed while Kyverno is unavailable)
#    and the per-request timeout every rule -- including its external calls (§3.7) -- must fit inside
echo "== 6) webhook failurePolicy / timeout (planning input, no pass-fail) =="
kubectl get validatingwebhookconfiguration -o \
  custom-columns='NAME:.metadata.name,POLICY:.webhooks[*].failurePolicy,TIMEOUT:.webhooks[*].timeoutSeconds' \
  | grep kyverno

# 7. Which resources Kyverno ignores outright, BEFORE any policy is consulted
echo "== 7) Kyverno resourceFilters (silent, pre-policy exemptions) =="
kubectl get cm -n kyverno kyverno -o jsonpath='{.data.resourceFilters}' | tr ' ' '\n' | grep -n ','
#    Expect no entry covering a namespace where pipelines run, and none covering
#    PipelineRun / TaskRun / Pod. A match here produces no denial and no report at all
```

**The expected value for each item, and where to go when the result does not match** (read this table first, then the three easily misjudged interpretations below it):

| Check | Expected | If not as expected |
|---|---|---|
| 1 Controllers ready | All four controllers Ready | First check the plugin's installation status (Marketplace → Cluster Plugins) and the Pod events to locate the failure; size the replica count per the HA plan in [§6.1.8](#s6-1-8), and make that change through the [§3.1.1](#s3-1-1) `ModuleInfo.spec.valuesOverride` entry point too — **do not edit the Deployment directly** (the platform reconcile reverts it) |
| 2 Resolver switches | The resolvers you actually use are `true`; Hub's `default-type` is `artifact` | These two ConfigMaps are managed by the Tekton operator and direct edits get reverted — change `TektonConfig.spec.pipeline` instead: set `enable-cluster-resolver` / `enable-hub-resolver` / `enable-git-resolver` to `true` as needed; the Hub output type is changed via `default-type: artifact` in the `hubresolver-config` entry under `TektonConfig.spec.hub.options.configMaps` (**not** `spec.pipeline` — that only holds the three `enable-*-resolver` switches). If you would rather not touch platform configuration, have every Hub reference carry an explicit `type=artifact` ([§4.5.1](#s4-5-1)) |
| 3 mutate-existing RBAC | Returns `yes` if you use the [§4.6](#s4-6) cancellation capability | On `no`, grant the aggregated ClusterRole given in the [§4.6](#s4-6) preamble (the `rbac.kyverno.io/aggregate-to-background-controller: "true"` label in its labels aggregates it into the background controller's permissions). **If you want to use a namespaced Role instead, you must also change `mutate.targets[].namespace` from `{{ request.namespace }}` to a namespace literal** — otherwise Kyverno's creation-time authorization check cannot resolve that variable, recognizes only cluster-level permissions, and the policy still fails to install (see the [§4.6](#s4-6) preamble). **If you do not install the [§4.6](#s4-6) cancellation policies, this permission is not needed** |
| 4 reports-controller reads status | All six `yes` (optional, not required) | A `no` **usually needs no action** (rationale in the third interpretation below). Only when some other feature genuinely needs the reports-controller to read status directly, add one more least-privilege ClusterRole the same aggregated way as item 3, with the aggregation label swapped to `rbac.kyverno.io/aggregate-to-reports-controller: "true"` |
| 5 PolicyException switches | Both `--enablePolicyException=true` and `--exceptionNamespace=<trusted-namespace>` present | Seeing only the former is ACP's default state — per [§3.1.1](#s3-1-1), write the `enabled` / `namespace` of `features.policyExceptions` into the kyverno `ModuleInfo`'s `spec.valuesOverride["ait/chart-kyverno"]` (**`ModuleInfo` exists only on the global management cluster**, see the warning in [§3.1.1](#s3-1-1)); **do not patch the Deployment args**. [§3.1.1](#s3-1-1) provides copy-pasteable atomic patch and rollback commands. **If you do not plan to use PolicyException exemptions ([§5.3](#s5-3)), you need not configure this** |
| 6 Webhook failure policy and timeout | **No fixed expected value** — it is planning input, not a pass/fail criterion. ⚠️ **The reading is timing-sensitive**: `kyverno-resource-validating-webhook-cfg` (the one that actually governs `PipelineRun` / `TaskRun` / `Pod`) is **generated dynamically by Kyverno from the installed policies** — with none of this document's policies installed its `webhooks` is empty and this line prints `<none>` (observed in practice). The `Fail/10` lines you can read at that point all belong to the webhooks of Kyverno's **own CRs** (policy / exception / cleanup / ttl). To get the actual values for pipeline resources, **come back and read this line after installing any [§4](#s4) policy** | Record the actual values and build your playbook around them: `Fail` requires guaranteed controller replicas and HA ([§6.1.8](#s6-1-8)); `Ignore` means accepting a policy vacuum while Kyverno is unavailable. `timeoutSeconds` is the **total budget for a single request** (this document's verification environment measured `failurePolicy=Fail` / `timeoutSeconds=10`); the external calls in [§3.7](#s3-7) must fit inside that number. If you genuinely need to adjust it, go through the [§3.1.1](#s3-1-1) entry point as well — **do not edit the `ValidatingWebhookConfiguration` directly**: it is an object Kyverno itself maintains (it carries `webhook.kyverno.io/managed-by=kyverno`) |
| 7 Resources Kyverno ignores outright | The filter list has **no** entry covering a namespace where pipelines run, and none covering `PipelineRun` / `TaskRun` / `Pod` | The `resourceFilters` in the `kyverno` ConfigMap take effect **before any policy**: a matched request is neither denied, nor recorded in a PolicyReport, nor logged — a **completely silent** exemption channel. The factory value in this document's verification environment excludes four namespaces — `kyverno` / `kube-system` / `kube-public` / `kube-node-lease`: the same violating Pod is denied in `policy-poc` yet sails straight through in `kube-system`. Therefore ① do not run pipelines in an excluded namespace; ② know that a policy written with `namespaces: ["*"]` carries this hole by construction; ③ write permission on this configuration must be controlled at the same level as `ClusterPolicy` ([§5.0](#s5-0)) |

Three of the interpretations above are easy to get wrong:

- **Item 2's `default-type`**: this document allows Hub references to omit the `type` parameter, on the premise that this platform setting outputs `artifact`. If it does not, either govern that platform setting first, or require every Hub reference to write `type=artifact` explicitly ([§4.5.1](#s4-5-1)).
- **Item 4 must carry `--subresource=status`**: passing `taskruns.tekton.dev/status` as a positional argument to `kubectl auth can-i` gets parsed as `TYPE/NAME` — what you queried is not the status-subresource permission but an object named `status`.
- **Item 4 returning `no` does not mean widen permissions right away**: status Audit with `background: false` is aggregated through the admission-report chain and does not require the reports-controller to read TaskRun / PipelineRun status directly; even with all six permissions at `no`, [§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2) still produce terminal-state PolicyReports. So **do not enlarge the ClusterRole merely because a permission warning appears at policy creation time** — first run one real controlled request and confirm whether the PolicyReport converges from the early skip to a terminal pass/fail; only when some other feature genuinely needs the reports-controller to read status directly, grant it separately with least privilege.
#### 3.1.1 Enabling PolicyException (optional; required by §5.3) {#s3-1-1}

ACP's "Compliance for Kyverno" plugin **ships by default with only `--enablePolicyException=true`, without `--exceptionNamespace`**. This default state is the most deceptive one: a PolicyException object **can be created successfully**, with nothing but a warning `The exceptionNamespace flag is not set` — yet it **has no effect at all**: the exemption is in place, and the target resource is still denied. The two flags must be configured together, and Kyverno only honors PolicyExceptions in the namespace `--exceptionNamespace` points at (which is exactly where exemption authority is closed off, [§5.3](#s5-3)). The flag **accepts a single namespace name, or `*`** (meaning PolicyExceptions in any namespace take effect) — **multiple namespaces are not supported** (confirmed on the Kyverno 1.15 line; the multi-namespace-list request was raised upstream — [kyverno#6980](https://github.com/kyverno/kyverno/issues/6980) — and closed as not-planned in 2026-01, because the informer only comes in "single namespace / whole cluster" flavors and the implementation is complex). In a multi-project / multi-tenant environment, this single-value constraint lands in one of two ways:

- **Central approval (used in this document)**: the trusted namespace **belongs to the approving side (the platform)**; project members never enter it — exemptions go through a request-and-approval flow, issued on the requester's behalf by the approver identity (this is exactly the model [§5.3](#s5-3) demonstrates). The natural isolation between projects is unaffected: this namespace is not a space projects share, it is the landing point of the approval flow. Do **not** let multiple projects share one trusted namespace and self-serve their exemptions — RBAC can only govern "who may create a PolicyException", not "whether the exemption's content stays in bounds" (`spec.match` can name any namespace), so project A could create an exception that exempts project B's pipelines.
- **Project autonomy (`*`)**: each project creates PolicyExceptions in its own namespace, and issuing authority follows project RBAC. In this mode you **must** add a meta-policy restricting a PolicyException to **exempting only resources in its own namespace** — without it, the "content out of bounds" problem above holds in every namespace; and write permission on `policyexceptions` must be explicitly tightened in each project — default roles should not carry it.

:::warning ModuleInfo exists only on the global management cluster; workload clusters do not have this resource

`ModulePlugin` / `ModuleConfig` / `ModuleInfo` are all platform management-plane objects and **exist only on the global management cluster**. Running `kubectl get moduleinfo` on the workload cluster where Kyverno runs finds nothing — that cluster does not even have the CRD. The **locate and patch commands in this section must therefore be executed with the global cluster's kubeconfig**; whereas, of the three confirmations in point 4, ② the Deployment args and ③ the rollout and the Pods' actual arguments must be executed on **the cluster Kyverno runs on**.

Note also that on global, one plugin has **one `ModuleInfo` per installation target cluster**, so before asserting "exactly one match" you must first narrow by target cluster — the platform marks the delivery target with `cpaas.io/cluster-name`; an instance installed on the global cluster itself may not carry that label, in which case identify it by the ownerReference pointing at its `Cluster` object.

The commands below are written for Kyverno and Tekton on the same cluster, so there is no cross-cluster switching; if your environment deploys the two separately, split the commands into the two sides as described above.

:::

The correct enablement path has four essentials:

1. **Never patch the controller Deployment's args directly** — the platform reconcile will revert it (see the warning above).
2. **The override entry point is the plugin's `ModuleInfo` `spec.valuesOverride`**, not `spec.config`. The kyverno `ModuleInfo` has only `version` in its spec by default; `spec.config` is the module instance's user configuration, not an override surface for chart values — change the wrong field and nothing takes effect. `valuesOverride` is layered by **chart name** (isomorphic to `ModuleConfig.spec.valuesTemplates`), and the chart name is `ait/chart-kyverno`.
3. **Locating the ModuleInfo must assert uniqueness**: on the global cluster, query precisely by the module label, narrow by the target-cluster label, then hard-assert exactly 1 match; do not guess by version or a `global-` prefix, and do not silently take `items[0]`.
4. **After the change, confirm in three places — every one of them**: ① the `AppRelease` has merged the values; ② the Deployment template args carry the flag; ③ the rollout has finished and **every Ready admission Pod** actually runs the new arguments. Looking only at the Deployment template, or hitting only one new Pod, is not enough to prove that every serving instance has switched over during an HA rolling update.

:::warning Single-node / CPU-starved clusters: the configuration can be right and the flag still not in effect

The admission-controller rollout **starts the surge pod first, then retires the old pod** (`maxUnavailable` is effectively 0); on a node short of CPU the surge pod goes Pending, the rollout wedges, the old pod keeps serving, and the symptom is that PolicyException still reports `exceptionNamespace flag is not set` — this is not a configuration error. **There is exactly one criterion: what arguments the serving pods are actually running** (③ of point 4); the flag being on the Deployment template does not mean it is on the serving pods. When wedged, free up node resources and let the rollout complete on its own — do not count on deleting a single old pod being enough (the new pod's actual resource request need not equal the template value).

:::

⚠️ **First look at where it currently points**: `--exceptionNamespace` **accepts exactly one value**. If the cluster already has it enabled, pointing at another namespace that carries real exemptions, changing it to a demo value makes **all of those exemptions stop working immediately** (and they stay broken until you change it back). In that case do not change it — reuse the existing trusted namespace to run [§5.3](#s5-3) (the opening of [§5.3](#s5-3) reads exactly that value; the `policy-exceptions` in the text is merely the value configured by this document's [§3.1.1](#s3-1-1), not a constant you must match). This change is a switch that is **globally unique on the target cluster**; only one person should be touching it at any given time.

**Every value this section needs from you is gathered in the input block below** — every later block (a)–g), the save-to-disk block, the read-back block) only references the variables set here and carries no further `<...>` placeholders, so this block must run first:

```bash
# The ONLY user-supplied inputs of this section, gathered in one place so a pasted
# block never hides a <placeholder> in its middle; later blocks validate these
# variables instead of re-declaring them.
GLOBAL_KUBECONFIG='<path-to-global-kubeconfig>'  # kubeconfig of the GLOBAL management cluster
TARGET_CLUSTER='<cluster-name>'                  # the cluster Kyverno runs on; a) narrows its query by it
TRUSTED_EXCEPTION_NS='<trusted-namespace>'       # namespace that will hold PolicyExceptions (§5.3)
# ModuleInfo lives only on the global management cluster, so every command in this
# section goes through this one wrapper. A shell FUNCTION, not a KGLOBAL="kubectl ..."
# string: zsh keeps an unquoted expansion as one word, so the string form pasted into
# an interactive zsh looks for a command literally named "kubectl --kubeconfig ...".
# The :? inside makes every call refuse by name in a shell that never ran this block.
KGLOBAL() {
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG:?run the inputs block at the top of §3.1.1 in this shell first}" "$@"
}
KGLOBAL config view --minify -o jsonpath='{.clusters[0].cluster.server}{"\n"}'
```

The API server address that last command prints must be **the global cluster you intend to change**; if it is not, fix the kubeconfig first, then continue.

**Execution order overview** — a)–g) all live in the collapsible block below; the order must not change, and **do not paste the whole collapsible block in one go** (e) is the rollback — running it all at once amounts to enabling and immediately reverting):

1. **Check for an old ledger before starting**: if `ls moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json 2>/dev/null` prints anything, a previous enable round was never rolled back — first use the "Recovering rollback state in a new terminal" block to reload that state, run e)–g) to close out that round, then start a new one. This step must happen before a): once c) has run, the globally unique switch has already been changed.
2. **Enable**: a) locate and assert uniqueness → b) save the original value → **write to disk** (persist the rollback state into the three files above; this must come before c) — c) is irreversible, and until the state is on disk the "original value" lives only in the current shell: close the terminal at that moment and it is gone forever, and re-running b) afterwards would only record the modified value as the original) → c) atomic write → d) confirm in three places.
3. **Use**: go run [§5.3](#s5-3); come back to roll back only after all of it is done and cleaned up.
4. **Rollback**: e) atomic restore → f) confirm it took effect the same way d) did → g) delete the rollback files. If you switched terminals along the way, first rebuild state from the files with the "Recovering rollback state in a new terminal" block — **never re-run b)**. This restoration is platform-side configuration; it belongs to no section's "cleanup" subsection and can only be performed manually here.

:::details Enable and rollback commands (atomic JSON Patch, copy-paste ready)

```bash
# a) Locate the ModuleInfo on the GLOBAL management cluster and assert the match is unique.
#    ModuleInfo exists only there -- the cluster running Kyverno has no such resource.
#    KGLOBAL and TARGET_CLUSTER come from the inputs block at the top of §3.1.1; stop
#    here if this shell never ran it, rather than query the wrong cluster.
: "${GLOBAL_KUBECONFIG:?run the inputs block at the top of §3.1.1 in this shell first}"
# Presetting GLOBAL_KUBECONFIG by hand is not enough -- the KGLOBAL wrapper
# function must exist too, or every call below dies as "command not found".
command -v KGLOBAL >/dev/null || : "${KGLOBAL:?run the inputs block at the top of §3.1.1 in this shell first}"
: "${TARGET_CLUSTER:?run the inputs block at the top of §3.1.1 in this shell first}"
#    One plugin gets one ModuleInfo per target cluster, so narrow the query to the cluster
#    Kyverno runs on before asserting uniqueness. An instance installed onto the global
#    cluster itself may carry no cpaas.io/cluster-name label -- identify that one by the
#    ownerReference pointing at its Cluster object instead of by this selector.
#    ModuleInfo is CLUSTER-SCOPED -- it has no namespace, so nothing here passes -n.
MODULES=$(KGLOBAL get moduleinfo -o json \
  -l cpaas.io/module-name=kyverno,cpaas.io/cluster-name="$TARGET_CLUSTER")
#    `test ... -eq 1` on its own line does NOT stop an interactive shell: it only sets $?,
#    and the next line would take items[0] anyway -- the very thing point 3 above forbids.
#    Branch instead, so a non-unique match leaves MODULE unset and c) cannot run.
if [ "$(jq '.items | length' <<<"$MODULES")" -ne 1 ]; then
  echo "expected exactly ONE ModuleInfo, got $(jq '.items | length' <<<"$MODULES") --"
  echo "narrow the selector by target cluster first; do NOT continue to b)/c)."
  unset MODULE
else
  MODULE=$(jq -r '.items[0].metadata.name' <<<"$MODULES")
  echo "target ModuleInfo: $MODULE"
fi

# b) Save the complete original spec and compute the target spec to write.
#    Keeping the original verbatim is what lets the rollback restore an absent field,
#    an explicit null, or an arbitrary non-empty object exactly as it was.
: "${TRUSTED_EXCEPTION_NS:?run the inputs block at the top of §3.1.1 in this shell first}"
#    a) prints "do NOT continue to b)/c)" when the match is not unique -- but printing is not
#    stopping, and the whole block is pasted in one go, so b) has to refuse for itself. A bare
#    `: "${MODULE:?...}"` would not do it either: in an INTERACTIVE shell that fails only that
#    one command and the next line still runs. Branch, exactly as a) does.
if [ -z "${MODULE:-}" ]; then
  echo "a) did not settle on exactly one ModuleInfo -- fix a) first; b) and c) are skipped."
else
  ORIGINAL_MODULEINFO_SPEC=$(KGLOBAL get moduleinfo "$MODULE" -o json | jq -c '.spec')
  TEST_MODULEINFO_SPEC=$(jq -c --arg ns "$TRUSTED_EXCEPTION_NS" '
    .valuesOverride = (.valuesOverride // {}) |
    .valuesOverride["ait/chart-kyverno"].features.policyExceptions = {
      enabled: true,
      namespace: $ns
    }
  ' <<<"$ORIGINAL_MODULEINFO_SPEC")
fi
```

**After b) finishes, write to disk before touching c)** — the state e) depends on (`GLOBAL_KUBECONFIG`, `MODULE`, the two specs) at this point lives only in the current shell; write it into the three rollback files first, and continue only after seeing `saved:`:

```bash
# Everything here comes from earlier blocks IN THIS SHELL: GLOBAL_KUBECONFIG (which
# the KGLOBAL wrapper reads) from the inputs block at the top of §3.1.1, the rest
# from a)-b). Checked first and by name -- a bare "command not found: KGLOBAL"
# further down would not say which piece of state is missing.
if [ -z "$GLOBAL_KUBECONFIG" ] || ! command -v KGLOBAL >/dev/null \
   || [ -z "$MODULE" ] \
   || [ -z "$ORIGINAL_MODULEINFO_SPEC" ] || [ -z "$TEST_MODULEINFO_SPEC" ]; then
  echo "missing state in this shell -- run the inputs block (GLOBAL_KUBECONFIG +"
  echo "the KGLOBAL wrapper) and a)+b)"
  echo "(MODULE / the two specs) here first, then this block."
  # Refuse to overwrite: if these files are already here, an earlier enable was never
  # rolled back, and b) has just captured the ALREADY-MODIFIED spec as "the original".
  # Overwriting would destroy the only record of the true original value.
elif [ -e moduleinfo-target.txt ] || [ -e moduleinfo-original.json ] \
   || [ -e moduleinfo-expected.json ]; then
  # Any of the three still here means an earlier enable was never rolled back -- and
  # b) has just captured the ALREADY-MODIFIED spec as "the original". Overwriting
  # would destroy the only record of the true original value.
  echo "rollback files from an earlier run are still here, so what this shell is"
  echo "holding as 'the original' is really the PREVIOUS round's modified spec."
  echo "Do NOT run c). The true original is in moduleinfo-original.json: load it with"
  echo "the read-back block below, run e)+f)+g) to finish THAT round, then start over."
  # Not just a printed refusal: e) reads these variables, and running it with
  # what this shell currently holds would write the previous round's change back as
  # if it were the original. Clearing them makes e) fail until the read-back block
  # has reloaded the real values from the files.
  unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  # The API server URL goes in too: a name alone does not identify a CLUSTER, and
  # e)'s test would happily pass against a same-named ModuleInfo on another global
  # cluster whose current spec matches -- writing this cluster's original onto it.
  # The uid is the tie-breaker: one kubeconfig can spell the same API server several
  # ways (DNS alias, load balancer, :443 written out, a tunnel), so a URL mismatch on
  # the way back is not proof of a different cluster -- the uid settles it.
  # Each value is read and checked separately: inside `printf "$(...)"` a failed
  # command substitution is invisible, and an empty field would still print "saved".
elif ! saved_api=$(KGLOBAL config view --minify \
       -o jsonpath='{.clusters[0].cluster.server}') || [ -z "$saved_api" ]; then
  echo "could not read the API server URL out of this kubeconfig -- fix that first."
elif ! saved_uid=$(KGLOBAL get moduleinfo "$MODULE" \
       -o jsonpath='{.metadata.uid}' 2>&1) || [ -z "$saved_uid" ]; then
  echo "could not read the ModuleInfo uid ($saved_uid)."
  echo "Do NOT run c) yet: with no uid there is nothing to bind the rollback files to,"
  echo "and c) is the step that makes this shell's variables irreplaceable."
elif ! printf '%s %s %s\n' "$MODULE" "$saved_api" "$saved_uid" \
        > moduleinfo-target.txt \
     || ! printf '%s' "$ORIGINAL_MODULEINFO_SPEC" > moduleinfo-original.json \
     || ! printf '%s' "$TEST_MODULEINFO_SPEC"     > moduleinfo-expected.json; then
  # "Run this block again" is not enough on its own: a partial write can leave one or
  # two of the three files behind, and the guard at the top would then read them as an
  # earlier round's rollback and refuse -- with the true values still only in this
  # shell. They came from THIS block, seconds ago, so deleting them is safe here and
  # nowhere else; say so explicitly rather than leaving the reader in that deadlock.
  echo "writing the rollback files failed -- do NOT run c), and do NOT close this shell:"
  echo "its variables are the only copy. Free space / fix permissions, then delete"
  echo "whatever this attempt left behind and run this block again:"
  echo "  rm -f moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json"
  echo "(safe ONLY right here: at the top of this block none of the three existed.)"
else
  echo "saved: rollback for $MODULE (uid $saved_uid)"
fi
```

```bash
# Same-shell state from the inputs block, a)-b) and the save block; fail by name here
# instead of feeding jq an empty --argjson or patching a nameless object.
# `: "${VAR:?msg}"` reports a missing variable but does NOT stop an INTERACTIVE shell --
# it fails that one command and the next line runs regardless. That is precisely the trap
# this document describes in block b), so the same shape cannot be left guarding the block
# that WRITES. Collect what is missing and branch: either every input is present, or nothing
# below runs.
#
# `$MODULE` is also checked against the name the save block recorded. An unset variable is
# caught by the emptiness test; a STALE one -- left in a reused shell by an earlier attempt
# -- is not, and it is the dangerous case, because the patch would then rewrite a DIFFERENT
# ModuleInfo that the rollback files do not describe.
missing=
for v in GLOBAL_KUBECONFIG TRUSTED_EXCEPTION_NS MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC; do
  eval "[ -n \"\${$v:-}\" ]" || missing="$missing $v"
done
command -v KGLOBAL >/dev/null || missing="$missing KGLOBAL(the wrapper function)"
# The rollback files are inputs here too: this is a block that CHANGES the cluster, and
# it must not run unless the on-disk record to roll back from exists. The target file
# carries three fields (name, API server URL, uid) -- the recovery block needs all
# three -- so the stale-shell comparison reads only the first field, not the whole line.
for f in moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json; do
  [ -s "$f" ] || missing="$missing $f(missing or empty -- the save block has not written it)"
done
if [ -z "$missing" ]; then
  read -r saved_name _ < moduleinfo-target.txt
  if [ "$MODULE" != "$saved_name" ]; then
    missing="$missing MODULE(='$MODULE' but the save block recorded '$saved_name' -- stale shell?)"
  fi
fi
if [ -n "$missing" ]; then
  echo "NOT RUN -- missing or inconsistent state from earlier blocks IN THIS SHELL:$missing"
  echo "Run the inputs block at the top of §3.1.1, then a), b) and the save block, then paste this block again."
else
  # c) Atomic write (still on the global cluster): the test op guarantees no concurrent
  #    modification happened -- on conflict the whole patch fails instead of silently overwriting
  KGLOBAL patch moduleinfo "$MODULE" --type json -p \
    "$(jq -cn \
      --argjson expected "$ORIGINAL_MODULEINFO_SPEC" \
      --argjson replacement "$TEST_MODULEINFO_SPEC" '
      [
        {op:"test",path:"/spec",value:$expected},
        {op:"replace",path:"/spec",value:$replacement}
      ]
    ')"

  # d) Confirm in three places -- after waiting out the reconcile. The platform
  #    propagates asynchronously (ModuleInfo -> AppRelease -> Deployment -> rollout), and
  #    until the Deployment TEMPLATE has actually changed, (3)'s `rollout status` returns
  #    success for the PREVIOUS, already-finished rollout and the closing jq prints false:
  #    pasted in one go straight after c), every check below races the operator and
  #    proves nothing (live run on the validation environment: apprelease empty, args unchanged,
  #    "successfully rolled out", `false` -- and 30s later all four converged). So first
  #    wait, bounded, for the observable precondition: the template carrying the flag.
  #    Steps (2) and (3) inspect the workloads, so run them against the cluster Kyverno runs
  #    on -- that is the global cluster only when Kyverno is installed there.
  EXPECTED_ARG="--exceptionNamespace=$TRUSTED_EXCEPTION_NS"
  elapsed=0
  until kubectl get deploy -n kyverno kyverno-admission-controller \
          -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -qF "$EXPECTED_ARG"; do
    if [ "$elapsed" -ge 120 ]; then
      echo "no $EXPECTED_ARG on the Deployment template after ${elapsed}s -- the reconcile"
      echo "is stuck, not merely slow. Check the kyverno AppRelease/operator, then re-run d)."
      break
    fi
    sleep 5; elapsed=$((elapsed + 5))
  done

  #    (1) AppRelease has merged the values; expect {"enabled":true,"namespace":"<trusted-namespace>"}
  kubectl get apprelease -n cpaas-system kyverno \
    -o jsonpath='{.spec.values.features.policyExceptions}'

  #    (2) The Deployment template args now carry the flag (re-run item 5 of the checklist)
  kubectl get deploy -n kyverno kyverno-admission-controller \
    -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -i exception

  #    (3) Rollout finished AND every Ready admission Pod actually runs the new arg
  kubectl rollout status deployment/kyverno-admission-controller -n kyverno --timeout=5m
  #    rollout status can return in the brief window before the new admission Pod flaps
  #    NotReady to reload config with the changed arg; for that instant there are zero
  #    Ready Pods and the jq below (which requires `($ready|length)>0`) would print false
  #    on an enable that in fact succeeded. Wait for a Ready Pod first so the check reads
  #    steady state, not the flap. Best-effort: on timeout the jq still runs and prints
  #    the real verdict.
  kubectl wait --for=condition=Ready pod -n kyverno \
    -l app.kubernetes.io/component=admission-controller --timeout=120s
  kubectl get pod -n kyverno -l app.kubernetes.io/component=admission-controller -o json | \
    jq -e --arg expected "$EXPECTED_ARG" '
      [.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] as $ready
      | ($ready | length) > 0
        and all($ready[];
          any(.spec.containers[]?;
            .name == "kyverno" and any(.args[]?; . == $expected)))
    '
fi
```

Once d)'s three confirmations pass, go run [§5.3](#s5-3); come back and execute e)–g) only after **all of [§5.3](#s5-3)'s steps** are done and cleaned up. If you have switched terminals, first rebuild state with the "Recovering rollback state in a new terminal" collapsible block below.

```bash
# Same-shell state again -- from the shell that ran a)-d), or rebuilt by the recovery
# block below. Refuse by name rather than patch a nameless object as the admin user.
# `: "${VAR:?msg}"` reports a missing variable but does NOT stop an INTERACTIVE shell --
# it fails that one command and the next line runs regardless. That is precisely the trap
# this document describes in block b), so the same shape cannot be left guarding the block
# that WRITES. Collect what is missing and branch: either every input is present, or nothing
# below runs.
#
# `$MODULE` is also checked against the name the save block recorded. An unset variable is
# caught by the emptiness test; a STALE one -- left in a reused shell by an earlier attempt
# -- is not, and it is the dangerous case, because the patch would then rewrite a DIFFERENT
# ModuleInfo that the rollback files do not describe.
missing=
for v in GLOBAL_KUBECONFIG MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC; do
  eval "[ -n \"\${$v:-}\" ]" || missing="$missing $v"
done
command -v KGLOBAL >/dev/null || missing="$missing KGLOBAL(the wrapper function)"
# The rollback files are inputs here too: this is a block that CHANGES the cluster, and
# it must not run unless the on-disk record to roll back from exists. The target file
# carries three fields (name, API server URL, uid) -- the recovery block needs all
# three -- so the stale-shell comparison reads only the first field, not the whole line.
for f in moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json; do
  [ -s "$f" ] || missing="$missing $f(missing or empty -- the save block has not written it)"
done
if [ -z "$missing" ]; then
  read -r saved_name _ < moduleinfo-target.txt
  if [ "$MODULE" != "$saved_name" ]; then
    missing="$missing MODULE(='$MODULE' but the save block recorded '$saved_name' -- stale shell?)"
  fi
fi
if [ -n "$missing" ]; then
  echo "NOT RUN -- the rollback would target the wrong object or fail halfway:$missing"
  echo "Rebuild state with the 'Recovering rollback state in a new terminal' block below, then paste this block again."
else
  # e) Rollback (global cluster again): test that the current spec still equals what we wrote,
  #    then replace it with the complete original spec. A failing test means someone else
  #    changed the ModuleInfo meanwhile -- do a manual three-way merge and revert only the
  #    policyExceptions change.
  KGLOBAL patch moduleinfo "$MODULE" --type json -p \
    "$(jq -cn \
      --argjson expected "$TEST_MODULEINFO_SPEC" \
      --argjson original "$ORIGINAL_MODULEINFO_SPEC" '
      [
        {op:"test",path:"/spec",value:$expected},
        {op:"replace",path:"/spec",value:$original}
      ]
    ')"

  # f) Confirm the rollback the same way d) confirmed the enable -- a patched ModuleInfo is
  #    not a withdrawn flag. Until the platform has reconciled and the Pods have rolled,
  #    `--exceptionNamespace` is still live on the admission controllers actually serving
  #    requests, which means every PolicyException in that namespace is still in force.
  #    The asymmetry is the trap: enabling has three confirmations, and a rollback that
  #    just ends looks equally finished while leaving the exemption entrance open.
  #    Expect: an empty/absent policyExceptions value, no exception flag in the args, and
  #    the jq below printing true (every Ready admission Pod is free of the flag).
  #    (1)-(3) inspect workloads, so like d) they run against the cluster Kyverno runs on,
  #    not the global one -- plain kubectl, not the KGLOBAL wrapper.
  #    Same operator race as d), mirrored: until the Deployment template has dropped the
  #    flag, `rollout status` blesses the PREVIOUS rollout and the jq below prints false
  #    while the exemption entrance is still open. Wait, bounded, for the drop first.
  elapsed=0
  until ! kubectl get deploy -n kyverno kyverno-admission-controller \
          -o jsonpath='{.spec.template.spec.containers[0].args}' | grep -q 'exceptionNamespace'; do
    if [ "$elapsed" -ge 120 ]; then
      echo "the Deployment template still carries --exceptionNamespace after ${elapsed}s --"
      echo "the reconcile is stuck and the exemption entrance is STILL OPEN. Check the"
      echo "kyverno AppRelease/operator, then re-run f); do not proceed to g)."
      break
    fi
    sleep 5; elapsed=$((elapsed + 5))
  done
  # Re-check once, explicitly: the loop above exits BOTH when the flag dropped and when
  # the timeout branch broke out of it, and g) below must not have to guess which. A
  # failed read answers "no match" too, so capture the read and require it to succeed
  # before interpreting emptiness as absence.
  if ARGS_NOW=$(kubectl get deploy -n kyverno kyverno-admission-controller \
        -o jsonpath='{.spec.template.spec.containers[0].args}' 2>&1) \
     && ! printf '%s' "$ARGS_NOW" | grep -q 'exceptionNamespace'; then
    flag_dropped=yes
  else
    flag_dropped=no
  fi
  kubectl get apprelease -n cpaas-system kyverno \
    -o jsonpath='{.spec.values.features.policyExceptions}{"\n"}'
  kubectl get deploy -n kyverno kyverno-admission-controller \
    -o jsonpath='{.spec.template.spec.containers[0].args}' | tr ',' '\n' | grep -i exception
  kubectl rollout status deployment/kyverno-admission-controller -n kyverno --timeout=5m
  # Same readiness flap as d): rollout status can return just before the admission Pod
  # flaps NotReady to reload config, and the jq below requires at least one Ready Pod, so
  # a single shot would print false on a rollback that in fact completed. Wait for a Ready
  # Pod first; best-effort, the jq still runs and prints the real verdict on timeout.
  kubectl wait --for=condition=Ready pod -n kyverno \
    -l app.kubernetes.io/component=admission-controller --timeout=120s
  kubectl get pod -n kyverno -l app.kubernetes.io/component=admission-controller -o json | \
    jq -e '
      [.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))] as $ready
      | ($ready | length) > 0
        and all($ready[];
          all(.spec.containers[]?;
            .name != "kyverno" or all(.args[]?; (. | test("exceptionNamespace")) | not)))
    '

  # g) Only now retire the rollback files. Leaving them behind is not harmless: the check
  #    you are told to run before the NEXT enable ("ls moduleinfo-*") reads any of them as
  #    "the previous round was never rolled back", and the save block then refuses to
  #    record the new round and clears its variables. Delete them only after f) came back
  #    clean -- while any of it is unconfirmed, these three files are still the record.
  if [ "$flag_dropped" = yes ]; then
    rm -f moduleinfo-target.txt moduleinfo-original.json moduleinfo-expected.json
  else
    echo "KEEPING the rollback files: the Deployment template still carries (or could not"
    echo "be confirmed free of) --exceptionNamespace, so the withdrawal is unconfirmed and"
    echo "these three files are still the only record. Re-run f); delete only when it is clean."
  fi
  unset flag_dropped
fi
```


:::

:::details Recovering rollback state in a new terminal (as needed, before running e))

**Read the target from the files; do not pick it by querying again**:

```bash
# A new terminal has none of the variables, so re-declare the wrapper here (this is the
# one place it is re-declared on purpose -- everywhere else it comes from the block at
# the top of this section).
GLOBAL_KUBECONFIG='<path-to-global-kubeconfig>'
KGLOBAL() {
  kubectl --kubeconfig "${GLOBAL_KUBECONFIG:?fill GLOBAL_KUBECONFIG in this block first}" "$@"
}
# The saved target is the authority. Re-running a) would pick an object by querying
# again -- point it at the wrong cluster and e)'s test could pass against a DIFFERENT
# ModuleInfo whose current spec happens to equal the saved one, writing this cluster's
# original spec onto somebody else's object.
# Guarded on purpose: a missing or empty file must stop you here, not leave MODULE
# empty and let the patch below run against a name the API server fills in for you.
if [ -s moduleinfo-target.txt ] && [ -s moduleinfo-original.json ] \
   && [ -s moduleinfo-expected.json ] \
   && read -r MODULE SAVED_API SAVED_UID < moduleinfo-target.txt \
   && [ -n "$SAVED_UID" ]; then
  # The read is kept OUT of the condition above and its exit status kept: an
  # unreachable API server, a missing token and a deleted object all answer "empty"
  # to a `2>/dev/null` query, and only one of those means "wrong cluster".
  if ! live_uid=$(KGLOBAL get moduleinfo "$MODULE" \
       -o jsonpath='{.metadata.uid}' 2>&1); then
    echo "could not read $MODULE ($live_uid)."
    echo "NotFound means wrong cluster or a deleted object; anything else (Forbidden,"
    echo "connection refused, timeout) says nothing at all about what is there."
    echo "Fix the kubeconfig / RBAC / connectivity and run this block again."
    # Cleared AFTER the message, so the message can still name the target.
    unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  elif [ "$live_uid" != "$SAVED_UID" ]; then
    echo "same name, DIFFERENT object (live $live_uid vs saved $SAVED_UID): the"
    echo "ModuleInfo was recreated, or this is another cluster. The saved spec belongs"
    echo "to an object that no longer exists -- do a manual three-way merge instead."
    unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  else
    # The uid is what binds this file to an OBJECT; the URL below is only a hint about
    # which cluster you were on. Same uid = same object, whatever the URL says.
    ORIGINAL_MODULEINFO_SPEC=$(cat moduleinfo-original.json)
    TEST_MODULEINFO_SPEC=$(cat moduleinfo-expected.json)
    echo "rollback target: $MODULE (uid $SAVED_UID)"
    [ "$SAVED_API" = "$(KGLOBAL config view --minify \
        -o jsonpath='{.clusters[0].cluster.server}')" ] \
      || echo "note: the API server is spelled differently than when saved ($SAVED_API) -- same object though"
  fi
else
  # A printed refusal is only a refusal if something downstream reads it. Nothing
  # stops you from pasting e) anyway, and stale values left in this shell from an
  # earlier session would let it patch the WRONG ModuleInfo -- successfully. So
  # clear them: e) then stops at its state guard, which is the intended outcome.
  unset MODULE ORIGINAL_MODULEINFO_SPEC TEST_MODULEINFO_SPEC
  echo "the three saved files are not all here (or the target line has no uid) --"
  echo "do NOT run e) from memory. Recover them from the shell that ran a)-d), or do"
  echo "a manual three-way merge: read the live spec, remove only the policyExceptions"
  echo "change, write it back."
fi
```

Re-running a) as a cross-check is fine, but **the query result must match `moduleinfo-target.txt` word for word — if it differs, stop and investigate**. **Never re-run b)** — by then the spec on the cluster is already the modified one, b) would record the "original value" as the changed value, and the rollback would be lost for good; apart from the target and these two specs, e) depends on nothing from b).

:::
### 3.2 Applicable versions and dependent features {#s3-2}

The applicable range is stated in the "Applicable versions" box at the top of this document: the criterion is **Alauda DevOps Pipelines v4.14.x and later**, not the ACP version. On earlier versions the dependent features below are incomplete, and policies may silently stop enforcing instead of raising an error — the mechanism chapters read just as well there, but do not apply this document's policy assets and examples as-is.

The specific features depended on (your degradation checklist on older versions):

- **Tekton**: the `tekton.dev/v1` API, object results (`enable-api-fields: beta`), the `status.pipelineSpec` write-back, `status.childReferences`, `spec.status: CancelledRunFinally`, cluster / hub / git resolvers;
- **Kyverno**: subresource match (the `kind/subresource` form), mutate-existing (`targets`), `context.apiCall`, `foreach` + `element`, PolicyException v2 (`--enablePolicyException` + `--exceptionNamespace`).

Of these, **only `enable-api-fields` will stop you at the very start**: the fixture Task in [§3.3](#s3-3) declares a result of `type: object`, and when this switch is not `beta` (or `alpha`), Tekton's own admission rejects `kubectl apply -f public-fixtures.yaml` outright — **the blocking point is in the shared fixtures, not in any policy**, and it is easy to misdiagnose as a Kyverno problem. So read it first (`TEKTON_NS` per [§3.1](#s3-1)):

```bash
# Either read is fine; they must agree. Expect: beta (alpha also enables object
# results). Anything else -- including empty output -- means object results are off.
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
kubectl -n "$TEKTON_NS" get configmap feature-flags \
  -o jsonpath='{.data.enable-api-fields}{"\n"}'
kubectl get tektonconfig config \
  -o jsonpath='{.spec.pipeline.enable-api-fields}{"\n"}'
```

When it is not `beta`, **change the `TektonConfig` — do not edit the ConfigMap directly**: the operator's next reconcile reverts a hand-edited ConfigMap (the same discipline as in [§3.1.1](#s3-1-1)). On the verification environment both reads return `beta`.

**The template → Task → result contract version matrix.** Every real profile in the Cookbook is pinned per version: different versions may carry different result contracts, and applying one across versions fails as a **silent mismatch**.

**The table below is this document's single contract baseline**: parameter names, types, defaults, and result shapes are authoritative here. **The action items for upgrading these versions are in [§3.6](#s3-6) (which criteria are affected) and [§3.8](#s3-8) (what to run after the upgrade).** Later sections repeat, in place, the one or two rows relevant to their own criteria (so you can write policies as you read), but **when upgrading a template / Task version you only need to come back to this table and re-verify it row by row** — no hunting for the scattered notes in each section. The template and Task definitions in the matrix ship with **Alauda Artifact Hub Shim v1.0.0** (the built-in ACP hub: an Artifact Hub-compatible API consumed by Tekton's hub resolver); **later Shim versions may change these definitions** — upgrading the Shim is handled the same way as upgrading a template / Task version, per [§3.6](#s3-6) / [§3.8](#s3-8).

| Template / scenario | Key Tasks contained (version) | Consumed result / parameter contract |
|---|---|---|
| Official `java-image-build-scan-deploy` 0.3, `python-image-build-scan-deploy` 0.3 | `sonarqube-scanner` 0.7 | `code-scan-results` (object: result/reportURL/taskID/projectID), `code-scan-metrics` |
| Same as above | `trivy-scanner` **0.6** (both templates pin this version) | `trivy-summary-metadata` (object, 11 keys, **the recommended consumption shape**) + `trivy-summary` (array, whose first element is a string mirror of the same aggregate); the gate parameters are the structured `trivyExitCode` (string, **default `"1"`**) and `trivySeverity` (array); `trivyExtraArgs` (array) carries only the remaining native arguments |
| Same as above | `deploy-or-upgrade` alias → `kubectl` 0.1 | The release switch and target come from the PipelineRun's `workloadName` / `workloadNamespace` / `kubeconfig` workspace; the resolved TaskRun carries only `args` / `script` |
| **Standalone profile** (not contained in the templates above) | `skopeo-copy` 0.1 | Parameters `srcImage` / `srcTransport` / `imageMappings` (validated in [§4.5.1](#s4-5-1)) |

:::warning Four points that are easy to get wrong

1. **The vulnerability gate is controlled by structured parameters — do not compare `trivyExtraArgs` literals**: the gate switches are `trivyExitCode` (string, default `"1"`) and `trivySeverity` (array), which the templates pass straight through to `trivy-scanner`'s `exitCode` / `severity`. `trivyExtraArgs` is an **array** (one complete argument per element) carrying only the remaining native arguments — the criterion should require it to be empty, not equal to some approved list (see [§4.2.5](#s4-2-5)).
2. **Parameters are passed to the Task structurally, no longer concatenated into a shell command string**: `scanType` / `scanTargets` / `severity` / `exitCode` / `extraArgs` each travel in their own slot. So the main risk on the scanning side is not command injection but "has the gate been switched off"; what still genuinely needs injection defense are the string-typed `buildExtraArgs` / `pushExtraArgs` in the same templates (this document does not govern the build/push side, see [§4.2.5](#s4-2-5)).
3. **java 0.3 and python 0.3 have different DAG shapes**: in java 0.3, `deploy-or-upgrade` only has `runAfter: [trivy-scanner]`; in python 0.3 it is `runAfter: [sonarqube-scanner, trivy-scanner]` — "the Sonar verdict dominates the release" is expressed only in the python DAG (details in [§4.3](#s4-3)). Carrying a conclusion from one over to the other gets it backwards. Their **parameter surfaces** differ too (python replaces the maven group with a `preBuildScript` / `pythonImage` group; workspaces number **12** versus java's **16**; `trivy-config` exists in both); but **the trivy-gate-related parameters are field-for-field identical on both sides** (the sonar-side parameter names are also the same; only the `sonarProperties` default differs, which does not affect the criteria), so the gate criteria in [§4.2.5](#s4-2-5) cover both templates with a single rule — only the build inputs and workspace allowlists are split per template.
4. **Neither of these pipelines contains `skopeo-copy`**: [§4.5.1](#s4-5-1) is a standalone profile for the artifact-transfer scenario.

The Task versions in the table above defer to **whatever your environment's templates actually pin**; the field names in your policies must match the real contract of the target version.

:::

Degradation on older versions: fall back to the aggregate-string result only when object results are unavailable (the parsing pattern in [§4.4.2](#s4-4-2) is exactly that backstop shape) — **this is the degradation path, not the target shape**. Since 0.6, `trivy-scanner` also publishes an object result, so **consume trivy results directly via the drill-down pattern in [§4.4.1](#s4-4-1)**; [§4.4.2](#s4-4-2) is reserved for third-party / in-house Tasks that "only give you a string and cannot be changed any time soon". The reasoning is in [§2.4](#s2-4).

### 3.3 Shared fixtures {#s3-3}

:::info What the walkthrough leaves behind (see where things land before copy-pasting)

- **The local working directory**: the rollback files of [§3.1.1](#s3-1-1) — `moduleinfo-target.txt` / `moduleinfo-original.json` / `moduleinfo-expected.json` (**deleted only by rollback step g); if they are still there, that round was never wrapped up**); the snapshots and verdict files written along the six steps of [§5.3](#s5-3) (`gate-snapshot.txt`, `step*-verdict.txt`, `exemption-id.txt` and the like — whatever each step actually writes); the side files `*.err` used to split off stderr (**empty on success, and left in the directory all the same**); plus the YAML / JSON you copied out in each section. Cluster cleanup never touches these local files — keeping them as evidence is your call.
- **On the cluster**: the two shared namespaces this section creates, `policy-poc` / `tekton-templates`; the namespaces created by the probe block of [§5.2](#s5-2) (`proj-a` / `proj-b` / `rogue-ns` — defer to that section's creation loop); and [§5.3](#s5-3)'s `policy-exempt-runs` / `policy-exceptions` (**all of them get the walkthrough-id label only when this walkthrough created them by hand** — pre-existing ones are never labelled and never touched by cleanup). The namespaced demo objects — `PipelineRun` / `TaskRun`, the fixture `Task` / `Pipeline` objects, allowlist-type `ConfigMap`s, the `Role` / `RoleBinding` of [§4.2.2](#s4-2-2) and [§5.3](#s5-3), `PolicyException` — all live inside these namespaces. Beyond that, individual sections also create **cluster-scoped objects**: `ClusterPolicy` and the aggregated `ClusterRole` of [§4.6](#s4-6) — **deleting the namespaces does not take those along**.
- **Where cleanup lands ([§4.0.4](#s4-0-4)'s two rules)**: cluster-scoped objects are deleted one by one, by name, in each section's closing "cleanup"; namespaces are deleted after checking the walkthrough-id label, cascading away everything inside ([§5.2](#s5-2) / [§5.3](#s5-3)'s namespaces are handled by their own cleanup passages; `policy-poc` / `tekton-templates` by the "final cleanup" at the end of this section). Hence **clean up as each section finishes — do not batch it up for the end**. And one thing **no cleanup passage will do for you**: the platform configuration changed per [§3.1.1](#s3-1-1) for [§5.3](#s5-3) (the PolicyException switch in the `ModuleInfo`) — after finishing [§5.3](#s5-3), go back to [§3.1.1](#s3-1-1) yourself and run its rollback step.

:::

Resources shared by all later chapters. First create the two namespaces: `policy-poc` hosts the business-side runs and probes, `tekton-templates` hosts the trusted template and Task definitions.

```bash
# Record which namespaces THIS walkthrough created, so the final cleanup never
# deletes one that was already there (§4.0.4 keeps the same discipline per object).
# The marker is a LABEL on the namespace carrying an id UNIQUE TO THIS RUN. A fixed
# value like "created-here" would not do: on a shared cluster an earlier unfinished
# walkthrough may have left its own marked namespaces behind, and a fixed marker
# cannot tell the two apart -- the cleanup would delete somebody else's work.
# WRITE THE ID DOWN. Without it the cleanup refuses to delete anything, which is the
# safe direction, but you then have to compare the label by hand.
# date+PID alone is not unique across machines (same second, same PID happens);
# $RANDOM makes an accidental collision between two parallel walkthroughs unlikely.
# Any unique string works -- what matters is that it is not a constant.
WALKTHROUGH_ID=$(date +%Y%m%d-%H%M%S)-$$-$RANDOM
export WALKTHROUGH_ID
echo "walkthrough id: $WALKTHROUGH_ID"

for ns in policy-poc tekton-templates; do
  # --ignore-not-found gives three distinguishable outcomes without matching any error
  # text: exit 0 + a name = it exists, exit 0 + empty = it does not, non-zero = the
  # query itself failed (no RBAC, API server down) and you must not create anything.
  if ! out=$(kubectl get namespace "$ns" -o name --ignore-not-found 2>&1); then
    echo "$ns: CHECK FAILED ($out)"
  elif [ -n "$out" ]; then
    # §4.0.4's premise: every demo object lives in a namespace THIS walkthrough
    # created, because cleanup is a namespace cascade. A pre-existing namespace has
    # no removal path here, so going on inside it would strand everything you make.
    echo "$ns: pre-existing -- STOP: this walkthrough must own its namespaces (§4.0.4)."
    echo "  Pick your own names and substitute them throughout, or finish the earlier"
    echo "  walkthrough that left this one behind."
  elif ! kubectl create namespace "$ns" >/dev/null 2>&1; then
    # Somebody created it between the check and the create: it is theirs, not yours.
    echo "$ns: create failed -- do NOT label it, and treat it as pre-existing (STOP)"
  elif ! kubectl label namespace "$ns" "policy.alauda.io/walkthrough=$WALKTHROUGH_ID" >/dev/null; then
    # Created but unlabelled: the cleanup loop keys on that label and would skip it
    # forever. The namespace is seconds old, empty, and certainly yours -- delete it
    # by hand and re-run this loop rather than going on without the marker.
    echo "$ns: created but LABEL FAILED -- the cleanup loop will not touch it."
    echo "  Run: kubectl delete namespace $ns   # then re-run this loop"
  else
    echo "$ns: created"
  fi
done
```

The heart of the fixtures is a **SonarQube Scanner 0.7 contract fixture** (`policy-demo-scanner`). It is not a real scanner, but it **fully mirrors the 0.7 external contract surface this document depends on**, so every policy expression the Cookbook writes against that contract holds on the real Task as well:

- `enableScanQualityGate` / `enableAnalyzeQualityGate` are both `string` with default `"true"`;
- `analyzeQualityGateRules` is an `array` with default `[]`; `sonarBranchName` is a `string`, default empty;
- `code-scan-results` is an object result declaring only `result` / `reportURL` / `taskID` / `projectID`; the real schema of all four properties is the empty map `{}`, with no additional `type: string`;
- `code-scan-metrics` is an object result whose schema declares only the property the real 0.7 always has, `bugs: {}` (the real Task can collect more fields dynamically via its `metrics` parameter, but **a policy must not assume undeclared fields necessarily exist**);
- `code-scan-results.result` uses the real value range `Succeeded` / `Failed` / `Skipped` / `Canceled`.

The fixture additionally uses `demoCoverage` / `demoBugs` / `demoDelaySeconds` / `demoResult` to drive repeatable pass / fail / cancellation and four-value-range audit tests, and the template layer adds a `demoSkipScan` (default `"false"`; set to `"true"` it skips `scan` entirely via `when`, letting [§4.1.5](#s4-1-5) reproduce "the gate opted out"). These `demo*` parameters are **explicitly not a productized Task contract** — do not keep them when substituting a real Task. There is no separate gate task: the fixture failing by itself is what blocks the `release` behind it.

:::warning Replace the placeholder

Replace `<registry>` in the fixtures with a registry prefix from which your environment can pull busybox. In production, pin step images to a digest — otherwise anyone with registry push permission can swap out the scanning logic outright (contract 1, [§2.3](#s2-3)).

**If you do not know what to put there, first look at where the platform itself pulls from** — in an air-gapped environment this is the easiest starting point:

```bash
# Where the platform itself pulls from. Output shape: <host>[:port]/<path prefix>/...
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
kubectl -n "$TEKTON_NS" get deploy tekton-pipelines-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# Wider sample: every distinct prefix in use in that namespace.
kubectl -n "$TEKTON_NS" get pods \
  -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' \
  | sed 's#/[^/]*$##' | sort -u
```

⚠️ **These are candidates, not the answer**: that the platform namespace can pull does not mean `policy-poc` can too (pull credentials are granted per namespace), and both commands print **platform image** paths, which may not carry a `busybox` at all. **The only verification that counts is the fixture actually running** — after building the fixtures per [§3.3](#s3-3), run `demo-run-pass`; if the Pod will not start, look for the `ImagePullBackOff` / `ErrImagePull` events in `kubectl -n policy-poc describe pod`. That is not a Tekton or Kyverno problem — the prefix is wrong or the credentials are missing.

:::

:::details Complete shared-fixture YAML (Task, templates, negative template — copy-paste ready)

One YAML file contains five objects; later chapters reference them as needed:

- `Task/policy-demo-scanner` (`tekton-templates`) — the contract fixture itself;
- `Pipeline/gated-build` — the standard governed template: scan → release, finally does notification only;
- `Pipeline/gated-build-with-prep` — used by [§4.2.2](#s4-2-2) to prove "work already completed before scan + RunFinally cancellation + finally still executes";
- `Task/policy-demo-scanner` (`policy-poc`) — the **same-name, different-source** Task, [§4.6.2](#s4-6-2)'s definition-drift target;
- `Pipeline/gated-build-rogue` — the negative template: the `scan` alias keeps the trusted name but resolves from `policy-poc`.

```yaml
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-scanner
  namespace: tekton-templates
spec:
  # This fixture mirrors the sonarqube-scanner 0.7 contract surface consumed by
  # this document. Parameters prefixed with demo are test drivers, not product
  # task parameters.
  params:
    - name: enableScanQualityGate
      type: string
      default: "true"
    - name: enableAnalyzeQualityGate
      type: string
      default: "true"
    - name: analyzeQualityGateRules
      type: array
      default: []
    - name: sonarBranchName
      type: string
      default: ""
    - name: demoCoverage
      type: string
      default: "85"
    - name: demoBugs
      type: string
      default: "0"
    - name: demoDelaySeconds
      type: string
      default: "0"
    - name: demoResult
      type: string
      default: Auto
  results:
    - name: code-scan-results
      description: quality-gate verdict object (result/reportURL/taskID/projectID)
      type: object
      properties:
        # Empty property schemas exactly match the catalog 0.7 Task.
        result: {}
        reportURL: {}
        taskID: {}
        projectID: {}
    - name: code-scan-metrics
      description: metrics collected after the scan; real 0.7 always declares bugs
      type: object
      properties:
        bugs: {}
  steps:
    - name: scan
      # pin to a digest in production so a registry pusher cannot swap the scan logic
      image: <registry>/busybox:latest
      # params passed via env (NOT text-substituted into the script body) to avoid
      # Tekton parameter injection; the script reads shell variables only
      env:
        - name: ENABLE_SCAN_QG
          value: $(params.enableScanQualityGate)
        - name: ENABLE_ANALYZE_QG
          value: $(params.enableAnalyzeQualityGate)
        - name: DEMO_COVERAGE
          value: $(params.demoCoverage)
        - name: BUGS
          value: $(params.demoBugs)
        - name: DEMO_DELAY_SECONDS
          value: $(params.demoDelaySeconds)
        - name: DEMO_RESULT
          value: $(params.demoResult)
      script: |
        #!/bin/sh
        set -eu
        case "$ENABLE_SCAN_QG" in true|false) ;; *) exit 1 ;; esac
        case "$ENABLE_ANALYZE_QG" in true|false) ;; *) exit 1 ;; esac
        case "$DEMO_COVERAGE" in ''|*[!0-9]*) exit 1 ;; esac
        case "$BUGS" in ''|*[!0-9]*) exit 1 ;; esac
        case "$DEMO_DELAY_SECONDS" in ''|*[!0-9]*) exit 1 ;; esac
        # The numeric-looking "1" is an intentional invalid-contract probe. It
        # does not extend the scanner 0.7 result enum.
        case "$DEMO_RESULT" in Auto|Succeeded|Failed|Skipped|Canceled|1) ;; *) exit 1 ;; esac
        [ "$DEMO_DELAY_SECONDS" -le 300 ] || exit 1
        sleep "$DEMO_DELAY_SECONDS"

        RESULT="$DEMO_RESULT"
        if [ "$RESULT" = Auto ]; then
          RESULT=Succeeded
          if [ "$DEMO_COVERAGE" -lt 80 ]; then RESULT=Failed; fi
        fi

        # The fixture self-gates whenever either 0.7 quality-gate phase is enabled.
        # Setting both switches false is reserved for the explicit negative fixture
        # that proves §4.2 rejects a fully disabled gate.
        FAIL=0
        if [ "$RESULT" != "Succeeded" ] && { [ "$ENABLE_SCAN_QG" = "true" ] || [ "$ENABLE_ANALYZE_QG" = "true" ]; }; then
          FAIL=1
        fi

        printf '{"result":"%s","reportURL":"https://sonar.example/dashboard?id=demo","taskID":"demo-task-001","projectID":"demo-proj"}' "$RESULT" > "$(results.code-scan-results.path)"
        printf '{"bugs":"%s"}' "$BUGS" > "$(results.code-scan-metrics.path)"
        echo "scan: demoCoverage=$DEMO_COVERAGE result=$RESULT fail=$FAIL"
        if [ "$FAIL" = 1 ]; then
          echo "task-side quality gate FAILED"; exit 1
        fi
        echo "quality gate not enforced or passed"
---
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: gated-build
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
      default: "85"
    - name: enableScanQualityGate
      type: string
      default: "true"
    - name: enableAnalyzeQualityGate
      type: string
      default: "true"
    - name: analyzeQualityGateRules
      type: array
      default: []
    - name: demoDelaySeconds
      type: string
      default: "0"
    - name: demoResult
      type: string
      default: Auto
    # §4.1.5 needs a run where the gate is skipped BY CONFIGURATION. The default keeps
    # `scan` running, so every other section behaves exactly as before; passing "true"
    # is the opt-out that section's Audit is supposed to catch.
    - name: demoSkipScan
      type: string
      default: "false"
  tasks:
    - name: scan
      # the scanner self-gates; failing it blocks `release` (no separate gate task)
      when:
        - input: $(params.demoSkipScan)
          operator: notin
          values:
            - "true"
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-scanner
          - name: namespace
            value: tekton-templates
      params:
        - name: demoCoverage
          value: $(params.coverage)
        - name: enableScanQualityGate
          value: $(params.enableScanQualityGate)
        - name: enableAnalyzeQualityGate
          value: $(params.enableAnalyzeQualityGate)
        - name: analyzeQualityGateRules
          value:
            - $(params.analyzeQualityGateRules[*])
        - name: demoDelaySeconds
          value: $(params.demoDelaySeconds)
        - name: demoResult
          value: $(params.demoResult)
    - name: release
      runAfter:
        - scan
      taskSpec:
        steps:
          - name: release
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "releasing..."
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "notify: run finished"
---
# 4.2.2 uses this profile to prove that work completed before `scan` can be
# followed by a RunFinally cancellation and still execute the final notifier.
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: gated-build-with-prep
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
      default: "85"
    - name: enableScanQualityGate
      type: string
      default: "true"
    - name: enableAnalyzeQualityGate
      type: string
      default: "true"
    - name: demoDelaySeconds
      type: string
      default: "0"
  tasks:
    - name: prep
      taskSpec:
        steps:
          - name: prep
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "prep completed"
    - name: scan
      runAfter:
        - prep
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-scanner
          - name: namespace
            value: tekton-templates
      params:
        - name: demoCoverage
          value: $(params.coverage)
        - name: enableScanQualityGate
          value: $(params.enableScanQualityGate)
        - name: enableAnalyzeQualityGate
          value: $(params.enableAnalyzeQualityGate)
        - name: demoDelaySeconds
          value: $(params.demoDelaySeconds)
    - name: release
      runAfter:
        - scan
      taskSpec:
        steps:
          - name: release
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "release completed"
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "finally notification completed"
---
# 4.6.2 uses a same-name Task from another namespace as the resolved-definition
# drift target. The name still looks trusted, but the complete source does not.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-scanner
  namespace: policy-poc
spec:
  steps:
    - name: wait
      image: <registry>/busybox:latest
      script: |
        #!/bin/sh
        sleep 30
---
# Negative fixture for 4.6.2: the scan alias keeps the trusted Task name but
# resolves it from policy-poc instead of tekton-templates.
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: gated-build-rogue
  namespace: tekton-templates
spec:
  tasks:
    - name: prep
      taskSpec:
        steps:
          - name: prep
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              sleep 30
    - name: scan
      runAfter:
        - prep
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-scanner
          - name: namespace
            value: policy-poc
    - name: release
      runAfter:
        - scan
      taskSpec:
        steps:
          - name: release
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "release must not complete after self-cancel"
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "finally notification completed"
```

:::

Save the YAML above as `public-fixtures.yaml` (with `<registry>` replaced) and create it on the target cluster — **every later section's probes assume these five objects exist**:

```bash
# If either namespace pre-existed, check for same-named objects FIRST: `apply` would
# overwrite somebody else's Task or Pipeline with this document's fixture, and the
# cleanup at the end of §3.3 would then delete what you overwrote (§4.0.4).
# Fail-closed on purpose: a query that ERRORS (no RBAC, API server hiccup, CRD not
# installed) must stop you too -- silencing stderr and reading "empty" as "absent" is
# how a guard turns into decoration.
FIXTURES_SAFE=yes
# Heredoc + read, not `set -- $spec`: zsh keeps an unquoted expansion as ONE word, so
# a splitting-based loop pasted into an interactive zsh queries an empty resource type.
# `read` splits on IFS in bash and zsh alike, and the redirect (no pipe) keeps the
# FIXTURES_SAFE assignment in the current shell.
while read -r ns kind name; do
  # Same three-way outcome as the namespace check: exists / absent / query failed --
  # decided by the exit code and whether anything was printed, not by error text.
  if ! out=$(kubectl get "$kind" -n "$ns" "$name" -o name --ignore-not-found 2>&1); then
    echo "CHECK FAILED for $ns/$kind/$name: $out"; FIXTURES_SAFE=no
  elif [ -n "$out" ]; then
    echo "COLLISION: $ns/$out already exists -- stop, and use namespaces of your own"; FIXTURES_SAFE=no
  fi
done <<'FIXTURE_LIST'
tekton-templates task policy-demo-scanner
policy-poc task policy-demo-scanner
tekton-templates pipeline gated-build
tekton-templates pipeline gated-build-with-prep
tekton-templates pipeline gated-build-rogue
FIXTURE_LIST
echo "FIXTURES_SAFE=$FIXTURES_SAFE"
# Expect FIXTURES_SAFE=yes and nothing else. COLLISION means the name is taken (change
# the two namespace names in the block above and in every later probe). CHECK FAILED
# means you do not know yet -- fix that query before applying anything.
```

**This probe is written for a first install: it cannot tell "somebody else's same-named object" from "the same batch of fixtures you built last time"** — both report `COLLISION`. Hence:

- **First install**: the probe should print nothing; if it does, switch namespaces as instructed above.
- **Re-running the same walkthrough**: those five objects are the ones you built last time. Verify they really are yours (`kubectl get -o yaml` — is the content this fixture, and is the namespace's walkthrough label your previous id), then **set `FIXTURES_SAFE=yes` by hand** and run the next block — `apply` on the same YAML is idempotent. Or delete last time's batch first and start over.
- **For "never overwrite"**: replace the next block's `kubectl apply -f` with `kubectl create -f`; when a same-named object exists it fails with `AlreadyExists` instead of overwriting. There is still a window between the probe and the creation (someone may create a same-named object exactly in between) — the value of `create` is precisely that in that case it fails rather than silently overwrites.

**The probe and the apply below are split into two blocks on purpose**: in a single block, pasting the whole thing would run `apply` regardless, reducing the probe to an after-the-fact notice. The next block checks `FIXTURES_SAFE` once more — both guards exist because **splitting only stops "pasted along the way"; it cannot stop "skipped the previous block and pasted this one"**:

```bash
# Refuse to run if the check above did not pass (or was never run at all).
if [ "${FIXTURES_SAFE:-no}" != yes ]; then
  echo "run the collision check above first, and fix what it reported"
else

  # `apply` on purpose, so that re-running the whole walkthrough is idempotent. It is
  # NOT collision-proof: the check above and this line are separate requests, and a
  # same-named object created in between would be overwritten rather than reported. On
  # a shared cluster prefer `kubectl create -f public-fixtures.yaml` -- it fails with
  # AlreadyExists instead, which is the answer you want there (see the bullet above).
  kubectl apply -f public-fixtures.yaml
  # Expect five objects created. Verify all five before going on: a missing template
  # makes the cluster resolver fail later, and the run will report a resolution error
  # instead of the gate behaviour this document describes.
  kubectl get task -n tekton-templates policy-demo-scanner
  kubectl get task -n policy-poc policy-demo-scanner
  kubectl get pipeline -n tekton-templates gated-build gated-build-with-prep gated-build-rogue

fi
```

If any line reports `NotFound`, go back to that YAML and find the corresponding object — the most common causes are an unreplaced `<registry>` failing the whole apply midway, or the two namespaces not yet created (the loop at the start of this section).

⚠️ **The two shared namespaces must have been created by this walkthrough** ([§4.0.4](#s4-0-4)'s prerequisite discipline — cleanup relies on the namespace-deletion cascade, and the cascade presumes nothing of anybody else's is inside). When the creation loop above prints `pre-existing`, someone on this cluster already occupies that namespace name — **do not demo inside it**: substitute your own names for `policy-poc` / `tekton-templates` throughout (and run the final cleanup under your names too); or first confirm it is what your own previous walkthrough left behind (the walkthrough id in the label is the one you wrote down), wrap that round up, and start again.

This template embodies the template-side responsibilities of the [§2.3](#s2-3) contracts: the gate is carried by the scanner itself (contract 3 "must-run" + contract 4 "consuming the real effective values" cohere inside one task), `release` is ordered after the scanner (contract 5, DAG dominance), and finally does notification only (contract 6).

The standard business-side usage references the template through the cluster resolver:

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo-run-pass
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
```

Save it as `demo-run-pass.yaml` and create it (on the target cluster; the observation commands below need it to really exist):

```bash
kubectl create -n policy-poc -f demo-run-pass.yaml
kubectl wait -n policy-poc pipelinerun/demo-run-pass \
  --for=condition=Succeeded --timeout=5m
```

The `code-scan-results.result` in the last column of the table below is **a Tekton task result produced by the scan task** — neither a Pipeline-level field nor a Kyverno concept. Get it straight first; the "result-type" policies of the coming chapters all hinge on it:

- **Who produces it**: the `scan` task (`policy-demo-scanner` in the fixture) writes a piece of JSON into `$(results.code-scan-results.path)` in its step script;
- **Where it lands**: Tekton records it on `status.results` of **the TaskRun corresponding to that task**. The PipelineRun does not hold this data itself — look at the child TaskRun ([§2.1](#s2-1) observation point 6);
- **What `.result` is**: this result is of type `object` ([§2.4](#s2-4)), and its `result` field is **the scan verdict**, with the real value range `Succeeded` / `Failed` / `Skipped` / `Canceled`;
- **Why this document keeps returning to it**: the result audit of [§4.4](#s4-4) and the automatic cancellation of [§4.6.1](#s4-6-1) both read this field. The table lists it so you can confirm the verdicts your fixture environment produces match expectations.

To see it with your own eyes (using the `demo-run-pass` above):

```bash
# The verdict lives on the scan TaskRun, not on the PipelineRun.
# childReferences is the API-level mapping from pipeline task name to TaskRun name --
# unlike the tekton.dev/pipelineTask label, it cannot be overridden by the submitter.
TR=$(kubectl get pipelinerun -n policy-poc demo-run-pass -o json \
  | jq -r '.status.childReferences[] | select(.pipelineTaskName == "scan") | .name')
kubectl get taskrun -n policy-poc "$TR" -o jsonpath='{.status.results}{"\n"}'
```

Three runs cover the gate's three shapes and double as an environment-readiness check:

| run | Input | scan | release | finally notify | Scan verdict (scan's task result `code-scan-results.result`) |
|---|---|---|---|---|---|
| pass | `coverage=85` | ✅ succeeds | ✅ runs | ✅ runs | `Succeeded` |
| gate-fail | `coverage=30` (both gate switches `true`) | ❌ fails itself | ⏭ skipped (reason `PipelineRun was stopping`) | ✅ runs | `Failed` |
| gates-off | `coverage=30` + both gate switches `false` | ✅ fixture succeeds | ✅ runs (**the deliberately exposed bypass**) | ✅ runs | `Failed` |

The latter two runs differ from `demo-run-pass` **only in params** (beyond the template identity, only `metadata.name` and the params differ). Save as `demo-runs-negative.yaml`:

```yaml
# gate-fail: coverage below the bar; both gate switches keep the template default "true"
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo-run-gate-fail
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
---
# gates-off: below the bar as well, but both gate switches explicitly off (the deliberately exposed bypass)
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: demo-run-gates-off
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
    - name: enableScanQualityGate
      value: "false"
    - name: enableAnalyzeQualityGate
      value: "false"
```

Create both together and wait for their terminal states — **note the two end opposite**, so the wait conditions are opposite too:

```bash
kubectl create -n policy-poc -f demo-runs-negative.yaml

# gate-fail must end NOT Succeeded (the scanner fails itself and stops the run)
kubectl wait -n policy-poc pipelinerun/demo-run-gate-fail \
  --for=condition=Succeeded=false --timeout=5m
# gates-off must end Succeeded -- that "green" run is the exposed bypass, not a pass
kubectl wait -n policy-poc pipelinerun/demo-run-gates-off \
  --for=condition=Succeeded --timeout=5m

# Then read the scan verdict of each: expect Failed for BOTH (the table's last column)
for run in demo-run-gate-fail demo-run-gates-off; do
  TR=$(kubectl get pipelinerun -n policy-poc "$run" -o json \
    | jq -r '.status.childReferences[] | select(.pipelineTaskName == "scan") | .name')
  printf '%s -> %s\n' "$run" \
    "$(kubectl get taskrun -n policy-poc "$TR" -o jsonpath='{.status.results}')"
done
```

A `wait` that times out rather than returning promptly usually means the run is stuck on resolution (the template was never built — go back to the five-object verification above); when either run's terminal state disagrees with the table, first confirm the fixture's `demo*` parameters have not been altered.

The first two rows are the hard gate's baseline shape (the scanner fails itself → `release` is skipped → finally runs anyway — exactly the second row of the comparison table in [§2.3](#s2-3)).

The third row is a **fixture-only negative test**, and its `Failed` is not a typo — two things are deliberately pulled apart in this row: the **verdict** still computes to `Failed` (`demoResult` defaults to `Auto`; coverage 30 < 80 judges `Failed`), but the fixture converts a failing verdict into `exit 1` only when **at least one gate switch is `true`**. With both switches off, scan exits successfully and `release` runs — while the scan TaskRun's `code-scan-results.result` says `Failed` in plain sight. **The verdict says non-compliant, yet the pipeline is green all the way** — exactly the harm shape of "the gate switches were turned off", and exactly why [§4.2.1](#s4-2-1) must block non-compliant switch values at TaskRun CREATE: by the time the result is out, the release has already run. This row describes only the fixture's deterministic behavior; it does not claim that a real SonarQube service necessarily produces the same combination with both gates disabled.

#### Final cleanup (after walking the whole document)

Each section's closing "cleanup" deletes only that section's own policies and run objects; **these two shared namespaces are deleted separately after the whole document is done** — otherwise the fixtures stay on the cluster forever:

```bash
# First LOOK: which namespaces carry a walkthrough marker at all, and whose?
kubectl get namespace -l policy.alauda.io/walkthrough \
  -o custom-columns='NAME:.metadata.name,WALKTHROUGH:.metadata.labels.policy\.alauda\.io/walkthrough'
# Expect your own id (printed when you created them) on the namespaces you created.
# A DIFFERENT id belongs to another run of this document -- leave it alone and go ask
# its owner.
#
# Then delete BY NAME, with your own id as the precondition. Deliberately not
# `kubectl delete namespace -l <label>`: a selector cannot express "mine". And never
# `kubectl delete namespace policy-poc tekton-templates` with no check at all -- that
# takes every unrelated object in them along.
for ns in policy-poc tekton-templates; do
  if ! json=$(kubectl get namespace "$ns" -o json 2>&1); then
    case "$json" in
      *NotFound*) echo "$ns: gone already -- nothing to do" ;;
      # Forbidden and a connection error must not read as "gone": an unreadable
      # namespace is not a deleted one, and walking away here would leave it (and
      # everything in it) behind while the output reads like a finished pass.
      *) echo "$ns: could not be read -- $json"
         echo "  Left alone. Resolve the read error and run this loop again." ;;
    esac
    continue
  fi
  # jq's exit code too: a parse failure would produce an empty marker, and the branch
  # below would then report a labelling mistake that never happened.
  if ! marker=$(printf '%s' "$json" | jq -r '.metadata.labels."policy.alauda.io/walkthrough" // ""'); then
    echo "$ns: could not parse the namespace JSON -- left alone"
    continue
  fi
  if [ -n "${WALKTHROUGH_ID:-}" ] && [ "$marker" = "$WALKTHROUGH_ID" ]; then
    # The label check right above is the ownership evidence (§4.0.4): only a namespace
    # THIS run created and marked gets deleted, cascade and all.
    kubectl delete namespace "$ns"
  else
    echo "$ns: label '${marker:-<none>}' is not this run's id '${WALKTHROUGH_ID:-<unset>}' -- left alone"
  fi
done
# An <unset> id means you are in a different shell than the one that created them:
# re-export WALKTHROUGH_ID with the value you wrote down, then run this again.
```

Deleting the namespaces cascades away the Pipelines / Tasks / runs inside and the Pods they spawned; `PolicyReport`s vanish along with their objects ([§4.4.4](#s4-4-4)). **The one thing not inside any namespace is `ClusterPolicy`** — a cluster-scoped object that must be deleted item by item per each section's cleanup list; deleting the namespaces does not take it along.

### 3.4 Policy verification methods (three kinds, strictly separated by scenario) {#s3-4}

Once a policy is written, which method verifies it depends on which observation point it hangs on. The three kinds do not substitute for one another:

- **Admission policies** (matching CREATE/UPDATE on main resources): use a `kubectl create --dry-run=server -f probe.yaml` probe — it runs the full webhook evaluation without persisting anything, zero side effects. Note that for resources using `generateName`, `--dry-run=server` requires `create`, not `apply`. Run both directions: the policy must reject the violating probe and must not hit the compliant one.
- **Result policies** (matching `*/status`): run results are not available at admission, so there are two routes — offline evaluation on your machine with `kyverno apply <policy> --resource <fixture>` (limitations in [§6.1.6](#s6-1-6)), or use a real emitter task in an **experiment namespace** to produce the target result shape (for example the scanner fixture in [§3.3](#s3-3)).
- **End-to-end verification**: actually run a minimal pipeline and verify the complete failure / skip / cancellation shapes and the parent-child timing. An admission probe **cannot prove** runtime timing; any conclusion involving `CreateRunFailed`, whether finally runs, or cancellation semantics must go through this tier.

**Production troubleshooting is read-only**: look only at status / events / PolicyReport ([§6](#s6)). **Never** hand-edit the status of a running object in production.

#### 3.4.1 Turning an "expectation table" into commands (the generic recipe) {#s3-4-1}

Later sections supply probes in one of two ways: some give complete manifests and commands directly ([§3.3](#s3-3), [§4.4.1](#s4-4-1), [§4.4.2](#s4-4-2), [§4.6.1](#s4-6-1)); the others give only an **expectation table** (listing which inputs should be allowed / denied / skipped) and leave the commands to this section — because these three kinds of commands are mechanical, and repeating them section by section would make the document longer, not clearer.

**Eight sections give only an expectation table and need you to turn it into commands yourself**: [§4.1.1](#s4-1-1), [§4.2.4](#s4-2-4), [§4.5.1](#s4-5-1), [§4.5.3](#s4-5-3), [§4.5.4](#s4-5-4), [§4.5.5](#s4-5-5), [§5.2](#s5-2), [§5.3](#s5-3). (The method behind this list is "the section has an expectation table but no `kubectl create` that submits a probe" — after the document changes, recount by that method instead of trusting the list. The `kubectl apply` commands already present in [§4.5.3](#s4-5-3), [§5.2](#s5-2), [§5.3](#s5-3) create **prerequisite objects** (ConfigMaps, namespaces), not the probes themselves.) In addition, [§4.1.4](#s4-1-4) and [§4.1.5](#s4-1-5) have no expectation table: they are Audit defense in depth on `*/status`, their criteria are stated in the body, and the expected shape is "which fail entry should appear in the report" — follow **type 2** below.

When following along, apply one of the three types below:

```bash
# Type 1 - Admission (the table says "allow / deny"; the policy matches CREATE/UPDATE on main resources)
#   Take the matching one of the three skeletons below, edit the fields per that table row, then:
kubectl create --dry-run=server -n policy-poc -f probe.yaml
#   ALLOW  = the object is echoed back (ending with "(server dry run)")
#   DENY   = admission webhook "validate.kyverno.svc-fail" denied the request,
#            and the message carries <policy-name>: <rule-name>: <message>
#   Neither (e.g. a resolver / validation error) = the request never reached the policy; fix the manifest first

# Type 2 - Result (the table says "pass / fail / skip"; the policy matches */status and is Audit)
#   An Audit policy denies no request; the verdict lives only in the report. You must really run it and wait for the terminal state:
kubectl create -n policy-poc -f probe.yaml
kubectl get taskrun,pipelinerun -n policy-poc \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[0].status,REASON:.status.conditions[0].reason'
kubectl get policyreport -n policy-poc \
  -o custom-columns=SUBJECT:.scope.name,RESULT:.results[*].result
#   Before the terminal state the report records skip; do not read once and conclude (the closing paragraph of §4.4.2)

# Type 3 - mutate-existing (the table says "cancelled / unaffected", §4.6)
#   Look at the target object itself: whether spec.status was written to CancelledRunFinally, plus the terminal reason.
#   The run name is the only thing to fill in -- set it first, on its own line:
PROBE_RUN='<probe-pipelinerun-name>'
#   Quoting makes the line parse; this makes it MEAN something. Without the guard the
#   placeholder flows into the query as a literal name and you get a confusing NotFound.
case "$PROBE_RUN" in '<'*'>') echo "fill in PROBE_RUN first"; false;; esac &&
kubectl get pipelinerun -n policy-poc "$PROBE_RUN" \
  -o jsonpath='{.spec.status} {.status.conditions[0].reason}{"\n"}'
```

**The "example manifest for that section" mentioned above is exactly what those eight sections do not provide** — so first pick one of the three skeletons below, then edit the fields per the expectation-table row. All three pass the `kubectl create --dry-run=server` admission check (how to obtain `<registry>` / `<catalog>` is in [§4.0.3](#s4-0-3)):

```yaml
# Skeleton A - PipelineRun entry (used by §4.1.1, §4.5.5, §5.2, §5.3)
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: probe-
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
```

```yaml
# Skeleton B - TaskRun entry (used by §4.2.4, §4.5.1, §4.5.4). Written here in the hub shape:
# these sections' policies pin the hub identity, so running with the §3.3 fixture's
# cluster resolver leaves the precondition unmet and the whole rule skips — that is
# a cell in the expectation table, not an "allow".
# Remote resolution happens after admission, so even if the referenced object does not
# exist in the hub, the dry-run still passes admission — enough to verify the policy criteria.
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  generateName: probe-
  namespace: policy-poc
spec:
  taskRef:
    resolver: hub
    params:
      - name: catalog
        value: <catalog>
      - name: type
        value: artifact
      - name: kind
        value: task
      - name: name
        value: sonarqube-scanner
      - name: version
        value: "0.7"
  params:
    # The parameter NAME is part of the contract, not a placeholder: §4.2.4's rule
    # reads `sonarBranchName` out of spec.params. Naming it `branch` would make even a
    # compliant branch look like "parameter absent" -- and that row of the table is
    # then indistinguishable from the illegal-branch row.
    - name: sonarBranchName
      value: main
```

```yaml
# Skeleton C - Pod entry (used by §4.5.3 — that section's policy governs Pod-level images, not the TaskRun)
apiVersion: v1
kind: Pod
metadata:
  generateName: probe-
  namespace: policy-poc
spec:
  restartPolicy: Never
  containers:
    - name: probe
      image: <registry>/busybox:latest
      command:
        - "true"
```

What each of the eight sections edits:

| Section | Which skeleton | What each expectation-table row is changing |
|---|---|---|
| [§4.1.1](#s4-1-1) template allowlist | A | The whole `pipelineRef` block: change `name` / `namespace`, change the `resolver` (cluster → git), write the git reference as a mutable reference |
| [§4.2.4](#s4-2-4) protected-branch gate | B | Keep the five hub items in `taskRef.params` exactly as listed in that section's body; vary the `spec.params` combinations: the value of `sonarBranchName` (protected branch / feature branch / removed entirely) × the gate switch (absent / `"true"` / `"false"` / empty string); for the PR best-effort probe additionally vary the `sonar.pullrequest.key=` entry in the `sonarProperties` array (empty / non-empty) and the `sonar.pullrequest.base=` entry |
| [§4.5.1](#s4-5-1) source allowlist | B | Change `name` / `version` in `taskRef.params` to that section's `skopeo-copy` entry, then vary `spec.params`' `srcTransport` / `srcImage` / `imageMappings`, and whether a workspace is mounted |
| [§4.5.3](#s4-5-3) image allowlist | C | `containers[].image`; `initContainers` likewise, as an extra block; for the `ephemeralcontainers` cell use `kubectl patch pod <name> --subresource=ephemeralcontainers` instead (it is a subresource UPDATE, not a CREATE) |
| [§4.5.4](#s4-5-4) bare-entry closure | B | The manifest barely changes; **what varies is the identity**: run the same request once with `--as=<platform-admin-identity>` and once with `--as=<business-identity>` — only when the two cells come out opposite has this policy been hit; for the CustomRun cell change `kind` to `CustomRun` and `taskRef` to `customRef` |
| [§4.5.5](#s4-5-5) release targets | A | The deployment switch and target namespace in `spec.params`, the ServiceAccount specified via `taskRunSpecs`, and the Secret referenced by the workspace |
| [§5.2](#s5-2) namespace layering | A | The manifest stays put; **change `-n`** (`proj-a` / `proj-b` / `rogue-ns`), then add the field that violates the baseline / the project policy per that section's body |
| [§5.3](#s5-3) exemption boundary | A | Switch `-n` between `policy-exempt-runs` and an ordinary namespace, set both gate switches in `spec.params` to `"false"`, and carry `--as` throughout |

**Every command must carry an explicit identity** (`--as=<...>`): without it you run as your own kubeconfig identity, which is most likely an administrator — an identity carved out by `exclude` never triggers the policy, and you will record "was not denied" as "the policy allowed it".

**There is exactly one acceptance criterion**: only seeing `<policy>: <rule>: <message>` (admission kind) or a `pass`/`fail` under that policy's name in the report (result kind) counts as this policy being hit. **"Was not denied" does not equal "the policy allowed it"** — it may just as well mean the policy did not match, the preconditions short-circuited, or another policy denied something else first. When unsure, follow [§6.1.2](#s6-1-2) (the three-step check for "installed but not in force") and [§6.1.3](#s6-1-3) (locating a false block); for being blocked first by another section's policy, see [§4.0.5](#s4-0-5).

### 3.5 Rollout safety process (Audit first) {#s3-5}

Different action types must follow different rollout rhythms; do not mechanically flip every policy to Enforce:

1. **Admission validate on main resources** (CREATE/UPDATE of PipelineRun / TaskRun / Pod): first set each rule's `validate.failureAction` to `Audit`, watch the PolicyReports and fix match / preconditions; switch to `Enforce` only once false positives reach zero, and regress with the dry-run positive/negative probes before flipping ([§3.4](#s3-4)).
2. **`*/status` result policies**: stay `Audit` permanently, observing only real terminal-state pass/fail. **Never switch to Enforce** — that would block the Tekton controller's status write-back and create a wedge ([§2.2](#s2-2), [§4.4.3](#s4-4-3)).
3. **mutate-existing / generate**: first grant minimal RBAC in an isolated namespace and verify the target selectors and idempotency conditions, then widen the scope; these are not validate policies, and the Audit → Enforce switching model does not apply to them.

**"Zero false positives, then Enforce" is still not enough — the switch itself must ramp in three stages, with the rollback rehearsed first.** One misconfigured wide-scope policy (above all the Pod-level image allowlist of [§4.5.3](#s4-5-3)) can reject Pod creation in every workload namespace at once — **that is a platform-wide pipeline outage**:

| Stage | Scope | What to watch at this stage |
|---|---|---|
| 1 Canary | **One** namespace you control yourself | Positive and negative probes ([§3.4](#s3-4)) both behave as expected; a real pipeline in that namespace runs to its terminal state |
| 2 Small batch | A few real workload namespaces (pick ones with high pipeline frequency) | Admission denial rate, PipelineRun creation failure rate, `PodCreationFailed` events, any change in webhook latency |
| 3 Full | The entire target scope | Same as above, and cover **at least one full business cycle** (including scheduled jobs and upgrade windows) |

**Rollback must be a one-step operation you have already rehearsed**, not an on-the-spot decision: switching the policy back to `Audit` (or deleting it) restores allow on the spot — before flipping, **actually execute one rollback at the canary stage and confirm recovery**, and write the commands and expected output into the change request. Also write down your own recovery-time objective: when a Pod-level policy is misconfigured, whether the platform recovers in minutes or waits for a human to come online depends on whether this step was prepared in advance.

:::warning Where the failure action goes: every asset in this document uses rule-level validate.failureAction (the top-level spec.validationFailureAction is Deprecated)

Basis: `kubectl explain clusterpolicy.spec.validationFailureAction` itself reads `Deprecated, use validationFailureAction under the validate rule instead` (rule-level path `rules[].validate.failureAction`, enum `Audit` / `Enforce`). This record stays here because **plenty of policies running on existing clusters still use the top-level form**, and this deprecation is among the most dangerous kinds of drift at upgrade time:

| Form | Submit a necessarily-violating request | Notes |
|---|---|---|
| Rule-level `validate.failureAction: Enforce` only, no top-level field (all assets in this document) | **Denied** | Measured in the verification environment (Kyverno v1.15.9, see the version table in [§1](#s1)) |
| Top-level `spec.validationFailureAction: Enforce` (the common legacy form) | **Denied** | Still effective today, but Deprecated |
| **Neither is set** | **Allowed** (the policy still shows `Ready=True`) | The default equals Audit |

The third row is where the risk lives: **when the top-level field is eventually removed, CRD field pruning will silently drop it** — the policy still installs successfully, shows `Ready=True`, and `kubectl get clusterpolicy` looks perfectly normal, yet it **no longer blocks anything**. That is exactly the worst shape this document keeps warning about — the silent allow.

Therefore:

- If you still hold legacy policies in the top-level form, **migrate them to rule level before the upgrade**: delete the top-level line and write `failureAction` under each validate rule's `validate:` (semantically equivalent; this document's assets are the post-migration form). Note that it is **every** rule — the rule-level field does not inherit, and any rule you miss falls back to the default Audit (the third row above);
- **After upgrading Kyverno, do not just check whether policies are Ready** — re-run each section's "a violating request must be denied" probes (the `--dry-run=server` positive and negative cells of [§3.4](#s3-4)). The rule-level form dodges this one named deprecation, but "semantic drift after upgrade" itself has not gone away (the Kyverno upgrade row of [§3.6](#s3-6));
- For the `*/status` policies that **stay Audit**, the only thing unaffected is that "they will not suddenly start blocking people"; their drift risk lives elsewhere (see the result contract in [§4.4.1](#s4-4-1) and the version-mismatch constraints in [§4.0.1](#s4-0-1)).

:::

### 3.6 Change and upgrade triggers (whenever the environment changes, come back to this table first) {#s3-6}

The criteria of this chapter's policies lean heavily on three kinds of **external facts**: template / Task versions and contracts, Tekton's `config-defaults`, and the approval lists you maintain yourself. When any of these changes and the policies do not follow, the consequence is one of the two shapes this whole document keeps warning about — the **silent allow** (the policy is still there but no longer blocks) or the **silent false denial** (every compliant request is denied, with a message pointing at some criterion).

| Triggering action | Affected criteria | Consequence | What the change must include |
|---|---|---|---|
| Adding a workload namespace, or migrating pipelines to a new namespace | The `namespaces:` enumeration of **every** policy in this chapter (demo value `policy-poc`) | **Silent allow**: the new namespace matches no rule | First add the new namespace to every scope (or switch to namespaced `Policy` per [§5](#s5); for "covered by default" switch to a platform-level ClusterPolicy with a negative `exclude` for system namespaces, instead of enumerating one by one), run the positive/negative probes against the new namespace, and only **then** let the business move in |
| **Adding a workload cluster**, or migrating pipelines to another cluster | **All** policies in this chapter — `ClusterPolicy` / `Policy` are in-cluster objects and **do not sync across clusters** | **Silent allow**: the new cluster has not a single policy, while the old cluster's reports look perfectly fine — completely invisible from the old cluster | Write "install the minimal set ([§4.0.1](#s4-0-1)) + run the positive/negative probes" into the cluster onboarding process; distribute the policy inventory via GitOps / a platform module rather than installing by hand; periodically diff the `kubectl get clusterpolicy` inventories across clusters (listed as a lossy item in [§7.3](#s7-3)) |
| A template version bump (e.g. 0.3 → 0.4) | Every policy pinning `refVersion` | **Silent allow** (identity mismatch = skip) | See ordering constraint 3 in [§4.0.1](#s4-0-1); the only layer that can stop "a new version sneaking in" is `pipeline-template-allowlist` |
| **A Task version bump** (decoupled from the template; happens on its own) | The result-reading policies of [§4.4](#s4-4).x, and the Task-identity criteria inside the full profiles | **Silent allow** (the old-version identity no longer matches → the PolicyReport looks "clean"); changing the version but not the result paths turns into **false positives** | Change all three places together: the Task identity version, the result **name**, and the property **path**. After the change, confirm with **one genuinely failing scan** that a fail appears in the PolicyReport — this is the positive control for an Audit policy: **if no fail shows up, first suspect the identity did not match, not "no violations"** |
| Changing `default-service-account` in `config-defaults` | The run-level SA approval list of [§4.5.5](#s4-5-5) | **Silent false denial**: every compliant request with deployment enabled is denied | Update the list in the same change, and run the three probe cells (new default SA / site-approved SA / off-list SA) |
| Changing `default-pod-template` in `config-defaults`, **especially adding `env`** | `runWideEnvCount` in [§4.2.5](#s4-2-5) and [§4.5.5](#s4-5-5) | **Silent false denial**: once the platform injects env by default, every run's count is > 0 and **all** pipelines are denied | Add the **names** of the platform-injected env entries to the allow list (a usable form is given below) — do not delete the criterion |
| Changing `default-managed-by-label-value` | The Pod scoping label of [§4.5.3](#s4-5-3) | **Silent allow**: the Pod rules no longer hit any Tekton Pod | Change the placeholder in the same change, verify the match hits with a real Tekton Pod, then verify an image outside the approved registries is still denied |
| The **content** of an approved object changes (the contents of an `approved-*` ConfigMap / Secret, the regex in `pipeline-image-allowlist` loosened) | Every criterion that compares only the **object name** (the workspace series in [§4.2.5](#s4-2-5), the ConfigMap shape in [§4.5.3](#s4-5-3)) | **Silent allow**: the name is still the approved value, the content has already been loosened | Manage "object rotation" (renaming) separately from "object content change": content must go under GitOps / RBAC control and review — **a policy can only lock "which object is bound"** |
| A Kyverno upgrade | All policies (this document's assets already use rule-level `validate.failureAction`, dodging the top-level field's deprecation; legacy top-level policies carry the greatest risk) | Possible **silent allow** | See the warning block in [§3.5](#s3-5); after the upgrade do not just check `Ready` — re-run the minimal regression set per [§3.8](#s3-8). **Beyond the failure action, verify each of these semantics yourself** (not "some version definitely changed them" — "you do not know until you verify"): the failure direction of `context.apiCall`, JMESPath function behavior, whether `foreach` still iterates all three container kinds, subresource match syntax, PolicyException matching and deletion propagation, and the PolicyReport API version |
| **A Tekton Pipelines upgrade** | All policies, above all those that "enumerate known fields" (see "two criterion shapes" below) | **Silent allow**: new fields / new override entry points / new resolver parameters are absent from the criteria and land on the allow side by default | Re-enumerate the field surface and check the criteria one by one: the `PipelineRun` / `TaskRun` spec, the overridable items of `spec.taskRunSpecs`, resolver parameters, the Pod's container-type fields, and any newly appeared run-like resources (the entry closure of [§4.5.4](#s4-5-4) enumerates by kind). **Enumeration method**: take `kubectl get -o yaml` of a real run's objects and diff against the pre-upgrade archive, looking only at the added fields. **Also re-verify the cancellation semantics separately**: the acceptable values of `spec.status`, the relation between `CancelledRunFinally` and finally, and which of "cancel vs. task failure" wins the terminal-state verdict — [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6](#s4-6) all ride on that state machine |
| **An ACP upgrade / platform module reconcile** | Policies that depend on platform configuration (the scoping label of [§4.5.3](#s4-5-3), the SA list of [§4.5.5](#s4-5-5), the hub endpoint of [§4.1.1](#s4-1-1), Kyverno's own configuration) | **Silent allow or silent false denial**, depending on which item got reset | A platform upgrade re-reconciles configuration from the module templates, and **your earlier manual changes may be reverted**: after the upgrade re-run the 7-item checklist of [§3.1](#s3-1) (especially items 6 and 7, `failurePolicy` and `resourceFilters`), and re-check the four configs `config-defaults` / `feature-flags` / `hubresolver-config` / the kyverno ConfigMap. **If you use PolicyException, also re-check the [§3.1.1](#s3-1-1) management-plane path itself** — the `ModuleInfo` locating conditions, the `valuesOverride` chart key, and the propagation chain of configuration to workload clusters are all platform implementation and may have changed after the upgrade: the commands still run yet find no object or the write does not take effect, and the rollback path fails the same way. **While platform configuration is being reset, a policy's `Ready=True` does not mean it is still in force** |
| A PolicyException expires without being cleaned up | The exemption scope of [§5.3](#s5-3) | **Silent allow**: the old exemption keeps matching later runs of the same kind | Every exception must carry the approval ticket number / effective and expiry times / an owner; scan for expired objects periodically; after deletion, confirm with one violating run that denial is back (Kyverno has no native TTL) |
| An SA on the identity list is deleted and recreated | Criteria comparing on `request.userInfo.username`, as in [§4.5.4](#s4-5-4) / [§4.2.1](#s4-2-1) | The name comparison still passes, **but the permissions are a different set** | An unchanged name is not identity equivalence: after recreation, re-check that SA's RoleBindings and Secrets, and re-verify both the allow and the deny side with `--as` probes |

**The relaxed form for when the platform injects env by default** (this document's environment has only `securityContext` in `default-pod-template`, so the body keeps the "any env → deny" criterion; the moment the platform adds default env, switch to allowing by name):

```yaml
- name: nonDefaultEnvCount
  variable:
    # Count only env entries the platform default did not put there. Verified on
    # cluster: two platform names -> 0, one extra business name -> 1.
    jmesPath: >-
      length((request.object.spec.taskRunTemplate.podTemplate.env || `[]`)[?contains(['<platform-default-env-name>'], name) == `false`])
    default: 0
```

**Wire this table into your own change process**: any change request touching templates, Tasks, `config-defaults`, approved objects, or the Kyverno / Tekton / ACP versions should carry a check item "does the policy side need to change too?" — every row above corresponds to one instance of "something else changed and the policies did not keep up".

#### Two criterion shapes decide which side a "new field" lands on

Upgrades are dangerous at the root because criteria come in two shapes, and the two give opposite default answers to **anything the criterion did not anticipate**:

- **The allowlist shape** ("must hit the approved set, otherwise deny") — e.g. the three-channel union in [§4.1.1](#s4-1-1), the registry prefixes in [§4.5.3](#s4-5-3), the entry identities in [§4.5.4](#s4-5-4), the target list in [§4.5.5](#s4-5-5). **A newly appeared shape automatically lands on the deny side**; after an upgrade this shows up as a "visible outage": compliant requests get denied. Painful but safe — and you are guaranteed to notice.
- **The denylist shape** ("deny when a known bad value / bad field appears") — e.g. the various gate parameter contracts ([§4.2](#s4-2)), the result-reading Audit ([§4.4](#s4-4)), the `skippedTasks` audit ([§4.1.5](#s4-1-5)). **New fields, new override entry points, and new enum values automatically land on the allow side**; after an upgrade this shows up as the "silent allow": the policy is still Ready, the reports are spotless, and that path is simply no longer watched.

**The unit of classification is "one criterion + one field surface", not "one policy"** — the two shapes routinely coexist within a single policy: [§4.2.5](#s4-2-5) locks template identity with an allowlist while enumerating bad parameters with a denylist; the image prefixes of [§4.5.3](#s4-5-3) are an allowlist, but the fact that it "iterates only the three known container fields" is a denylist. So upgrade regression must test **field surface by field surface** (one probe each for an unknown resolver / unknown parameter / unknown enum value / unknown container path) — do not tick off by policy count.

**To classify a criterion, ask a single question: hand it an input in a shape it has never seen — does it deny or allow?** Deny = allowlist, allow = denylist. **Every denylist-shaped criterion must have its field surface re-enumerated after an upgrade** — that is why the Tekton / template / Task rows in the table above demand "re-enumerate", and why the [§3.8](#s3-8) regression set must include negative probes of the "unknown override field" kind.

### 3.7 Scale and failure budgets (run these numbers before production) {#s3-7}

The preceding sections guarantee that the criteria are correct. This section is a different matter: **whether this policy set drags the platform down at real scale and under real failures, or fails in a different way under pressure**. For the five budgets below, this document can only give the mechanisms and the orders of magnitude — **the concrete numbers must be load-tested in your environment and written into the change request**.

| What to budget | Mechanism facts | The budget / action you must set |
|---|---|---|
| **External calls on the admission path** | Two kinds of criteria wait for an external round trip inside admission: `context.imageRegistry` ([§4.5.2](#s4-5-2)) and `context.apiCall` (one each in [§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.6.1](#s4-6-1) — three in the whole document). **Both fail closed**: registry unreachable → request denied (measured at roughly 5 seconds; roughly 3 seconds when reachable, see limitation 4 in [§4.5.2](#s4-5-2)); apiCall cannot fetch its target → the rule errors out and the request is denied (the error message shape is in the [§4.2.1](#s4-2-1) warning) | Decide explicitly "which request paths may carry external calls"; narrow such rules' match down to **the Tasks that genuinely need them**; load-test p95 / p99 and the timeout ratio, and confirm it stays below the webhook timeout — **that ceiling applies to the whole request, not to each rule separately** (measured `timeoutSeconds=10` in this document's verification environment, see checklist item 6 in [§3.1](#s3-1); one 5-second registry round trip fits, two stacked on the same request may not). **Registry / API server jitter turns directly into pipeline creation failures** — have the matching alerts and playbooks ready |
| **How many rules a single request hits** | One CREATE may hit several policies at once (multiple policies are AND-composed, [§1.3](#s1-3)), each of which may hold several rules; the image allowlist of [§4.5.3](#s4-5-3) is three rules, each running `foreach` over the container lists | Set a ceiling per resource kind for "maximum rules hit / maximum external calls per request"; when exceeded, merge criteria or narrow the match — do not draw conclusions from the isolated load test of a single policy |
| **Evaluation frequency of `*/status` policies** | One pipeline's status gets **written back many times** (observation points 3 / 6, [§2.1](#s2-1)); a status-reading policy **re-evaluates on every write-back**, and the request body carries the entire `status.pipelineSpec` (which can be large for a big template) | Keep expensive criteria (external calls, long list traversals) **in the gate task or the after-the-fact chain**, never in a `*/status` policy; before rollout, measure "single request body size × number of status updates" once |
| **Background scans and PolicyReport volume** | The whole document has exactly one `background: true` policy ([§4.4.4](#s4-4-4)); it periodically re-evaluates **all** matching objects; reports are generated per evaluated object, are GC'd with the object, and have **no TTL / retention semantics** (the [§4.4.4](#s4-4-4) boundaries) | Estimate report object count and growth from PipelineRun volume; if you need a paper trail, set up **external archiving** (do not treat PolicyReport as a history store); alert on reports-controller backlog |
| **The `failurePolicy` trade-off** | Checklist item 6 of [§3.1](#s3-1) only has you **record the actual value**; [§6.1.8](#s6-1-8) explains the consequences of both (`Fail` = requests denied while Kyverno is unavailable; `Ignore` = a policy vacuum exists) | Tier by policy risk: **the platform baseline and the Pod-level image allowlist lean toward `Fail`**, provided the four controllers are HA across nodes and stay available through rolling upgrades; bookkeeping-only Audit policies can accept `Ignore`. For every cluster, write down "which tier was chosen + why + minimum replica count + what happens during a Kyverno maintenance window", and rehearse one failure scenario |

**The one-line criterion**: any criterion that "waits for someone else's answer" (external registry, API server) is an availability risk; any criterion that "runs on every status write-back" is a cost risk. **Neither belongs on the main path without a budget.**

### 3.8 Upgrades and rollback: the minimal regression set (must run after every upgrade — do not just check `Ready`) {#s3-8}

[§3.6](#s3-6) tells you "what an upgrade affects"; this section answers "so which ones exactly do I run". **Without this list, in practice no regression happens** — because the most common failure shape after a policy upgrade is `Ready=True` with clean reports (the two criterion shapes of [§3.6](#s3-6)).

Run in order; every step must include **both one probe that should be allowed and one that should be denied** (running only half of it cannot catch a direction error; the reasoning is the two-step self-check in [§4.0.3](#s4-0-3)):

| # | What to run | Pass criterion (look at the behavior, not `Ready`) |
|---|---|---|
| 1 | The 7-item checklist of [§3.1](#s3-1) + the four configs `config-defaults` / `feature-flags` / `hubresolver-config` / the kyverno ConfigMap | Values match the pre-upgrade state; for any mismatch, first locate the affected policies per [§3.6](#s3-6) |
| 2 | The template allowlist of [§4.1.1](#s4-1-1) | The approved template is allowed; all three of an old version number, an unknown resolver, and a request-level `url` are denied |
| 3 | The gate parameter contract of [§4.2](#s4-2) (in whichever response shape you actually chose) | Compliant parameters are allowed; all three of switching the gate off / an explicit empty value / **an override field the criterion has never seen** are blocked (the third is the key probe for the denylist shape) |
| 4 | One real gate TaskRun | Non-compliant parameters terminate in **the one** response shape you chose, and the three shapes are checked in different places ([§6.2.3](#s6-2-3)): [§4.2.1](#s4-2-1) deny → parent run `CreateRunFailed`; [§4.2.2](#s4-2-2) cancel the parent run → parent run `Cancelled` + the `cancel-reason` annotation; [§4.2.3](#s4-2-3) cancel the gate TaskRun itself → **that TaskRun** `Cancelled` + `spec.statusMessage` (no `cancel-reason` appears on the parent run — do not judge the failure by it) |
| 5 | One scan that **genuinely fails** (one for sonar and one for trivy) | The corresponding `fail` appears in the PolicyReport. **No `fail` is always judged as "the policy did not match", never as "the scan passed"** (the five meanings in [§4.4.4](#s4-4-4)) |
| 6 | Have the gate skipped via `when` / an empty matrix | It shows up in `status.skippedTasks`, and the [§4.1.5](#s4-1-5) Audit records the violation |
| 7 | The Pod image allowlist of [§4.5.3](#s4-5-3) | Approved registries are allowed; unapproved ones are denied on all three paths — **regular containers / init containers / the `ephemeralcontainers` subresource** — with the violating images listed in the message |
| 8 | The release targets of [§4.5.5](#s4-5-5) | Approved namespaces / credentials are allowed; anything off the list is denied |
| 9 | When PolicyException is enabled ([§5.3](#s5-3)) | Denied without an exception → allowed under a controlled exception → denied again after deletion (check all three states; cache revocation takes a moment) |
| 10 | One complete business pipeline run to its terminal state (if none is handy, use `demo-run-pass` from [§3.3](#s3-3), the compliant fixture used throughout this document) | Check item by item rather than "it ran, good enough": the parent run's terminal state matches pre-upgrade; every child TaskRun in `status.childReferences` reaches its expected terminal state; finally executed; every Audit record that should be in the PolicyReport is there (pull them by run UID with the [§6.2.3](#s6-2-3) commands); and not a single `cancel-reason` or `statusMessage` appears unexpectedly |

**The special requirement for Task / template upgrades** (the kind of upgrade most likely to leave nothing but "looks fine"): result-reading policies must have their criteria changed **first** (identity, result name, property path — all three together, [§3.6](#s3-6)) before the production Task is switched; the change only counts as correct once step 5 has verified that "a failing sample produces a `fail`".

**Rollback runs in the reverse order of the rollout: policy contracts first, then the running objects.** First redeploy the policy version that matches the target Task / template version and verify it with steps 2, 3, and 5 of the table above, then switch the template / Task back to the old version. **During the window in which policy and template identity do not match, the gate carries no guarantee**: a "no PolicyReport violations" in that window only means the policies did not match, and must not be treated as a pass (same as [§4.4.4](#s4-4-4)). When the window cannot be avoided, explicitly mark that period as "gate not in force" — do not let it enter after-the-fact compliance conclusions.
## 4. Policy Cookbook {#s4}

This chapter is organized by governance scenario, and every section follows a fixed structure:

**Introduction** (What it governs / Why it is hard / How the policy is layered / What it cannot govern) → **Key criteria** (the few core lines of the policy, expanded inline) → **Complete policy assets** (collapsed, ready to copy) → **Verification probes and expected results** (collapsed) → **Cleanup**.

So that the same set of demo assets can be installed, verified, and cleaned up uniformly, this chapter uses `ClusterPolicy`, but every Enforce rule is scoped to the demo namespace `policy-poc`. **This is a demo choice, not a production permission recommendation for project administrators**: a project administrator should put the same rule logic into a `Policy` in their own namespace, set `metadata.namespace`, and remove the demo's cross-namespace scoping (such as `resources.namespaces` or `namespaceSelector`). Only the platform baseline, or cross-namespace policies centrally managed by the platform, use `ClusterPolicy`. The concrete conversion and the RBAC boundaries are in [§5](#s5).

All admission-type policies in this chapter are verified with `kubectl create --dry-run=server -f probe.yaml` probes — full webhook evaluation, zero side effects ([§3.4](#s3-4)). Policies and probes are both executed on the **target cluster** (the one running Kyverno and Tekton); see the note at the start of [§3](#s3).

### 4.0 Before you start: which policies to install, in what order {#s4-0}

This chapter contains **21 policy names** (22 `kind: ClusterPolicy` definition blocks — `pod-image-registry-allowlist` ships two interchangeable YAMLs). **Do not install them sequentially from start to finish.** Below is a "minimal usable set" and its installation order; take the rest as needed.

#### 4.0.1 The minimal usable set and its installation order {#s4-0-1}

| Stage | What to install | Prerequisites | What it blocks | Suggested mode |
|---|---|---|---|---|
| 0 | Nothing (verification and fixtures only) | [§3.1](#s3-1) checklist item 1 (all four Kyverno controllers Ready) is mandatory; item 2 — **verify per the resolvers you will actually use**: the three channels of [§4.1.1](#s4-1-1) depend on the cluster / hub / git resolver switches respectively, so enable only the one you need. To run the demos, also build the fixtures of [§3.3](#s3-3) | — | — |
| 1 | `pipeline-template-allowlist` ([§4.1.1](#s4-1-1)) | Decide which of the three channels you take (in-cluster templates / immutable remote references / mutable references denied by default); remote references require settling `<approved-git-repo>` and `<catalog>` first | Bypassing governed templates and assembling pipelines on your own | Observe one round in Audit first, then switch to Enforce |
| 2 | `pipeline-entry-lockdown` ([§4.5.4](#s4-5-4)) | `<platform-admin-identity>` (enumerate one by one; no wildcards) | Bypassing PipelineRun by creating bare `TaskRun` / `CustomRun` directly, thereby skipping the previous policy | Enforce (without this one, policy 1 can be bypassed) |
| 3 | Pick one by your pipeline source (they can also coexist): official java / python 0.3 templates → `trivy-gate-must-stay-on` ([§4.2.5](#s4-2-5) minimal version, PipelineRun level — **installable once the scope is changed; the identity criteria need no edits**); self-built templates → use `gate-param-contract` ([§4.2.1](#s4-2-1), TaskRun level) as a **template to rewrite** | `trivy-gate-must-stay-on` is usable as-is; `gate-param-contract` is **not a ready-made implementation** — its preconditions pin the demo's `gated-build` / `policy-demo-scanner`, and it takes effect only after you swap in your real parent Pipeline identity, Task identity, and parameter contract | Gate parameters switched off (`trivy-gate-must-stay-on` also blocks the explicit skip switch `skipTrivyScan`, plus two `podTemplate.env` injection paths: per-task `taskRunSpecs[].podTemplate` / `serviceAccountName`, and per-run `taskRunTemplate.podTemplate.env` — env vars reach the step containers and can alter scanning behavior while every parameter looks green). **But it cannot block arbitrary `when` / matrix skips** — a skipped gate produces no TaskRun at all, admission sees nothing, and only the `skippedTasks` after-the-fact Audit of [§4.1.5](#s4-1-5) can discover it | Enforce; **must go live in sync with the template version** (see the upgrade-order warning in [§4.2.5](#s4-2-5)) |
| 4 | `scan-verdict-audit` / `vuln-summary-audit` ([§4.4.1](#s4-4-1)), `inventory-ungated-runs` ([§4.4.4](#s4-4-4)) | The Tasks' result contracts ([§3.2](#s3-2) version matrix). **The three differ in readiness**: `vuln-summary-audit` pins hub `trivy-scanner` 0.6, matching the official templates — usable once the scope is changed; `scan-verdict-audit` pins the demo `policy-demo-scanner` and **must first be rewritten for hub `sonarqube-scanner` 0.7 per [§4.4.1](#s4-4-1)** before it audits the official templates | Blocks nothing; records results into PolicyReport: vulnerability aggregates and overall status (usable directly), scan verdicts (usable after the rewrite), and **existing runs missing the platform marker** — note this last one **does not prove the gate ever ran** (the label can be written by pipeline users themselves; [§4.4.4](#s4-4-4) has a dedicated note) | The first two **must stay Audit** — they read `*/status`, and Enforce would wedge the pipeline ([§4.4.3](#s4-4-3), [§6.1.4](#s6-1-4)). `inventory-ungated-runs` matches the PipelineRun main resource: **Audit first to take stock; once the backlog is remediated, evaluate switching to Enforce per [§4.4.4](#s4-4-4)** |
| 5 | `pod-image-registry-allowlist` ([§4.5.3](#s4-5-3)) | Three values: `<approved-registry-regex>`, `<tekton-infra-image-regex>` (both generated by the method in [§4.5.3](#s4-5-3)), `<tekton-managed-by-label-value>` (read from `config-defaults`; scopes in the Tekton Pods). **Then pick one shape**: regexes written into the policy body, or — the cross-environment shape of [§4.5.3](#s4-5-3) — create the `pipeline-image-allowlist` ConfigMap first (the policy reads it via `context.configMap` and **fails closed when the ConfigMap is missing**, so it must be created first and put under change control) | Swapping the actually-executed images for ones **outside the approved registries** (covering all three container classes of a Tekton Pod — **steps / init / ephemeral debug containers** — and all three entry paths: CREATE, plain UPDATE changing an image, and `ephemeralcontainers` subresource injection). **Note this is a "prefix allowlist", not an "image identity allowlist"**: swapping to another image **inside** an approved registry, or a mutable tag whose content is replaced, is not blocked — for that strength, pin digests or add `verifyImages` ([§4.5.3](#s4-5-3)) | **Audit first, without fail**: this policy acts at the Pod layer, and a regex missing one class of infrastructure image will keep all of Tekton from starting |

**Four policies in the minimal set need more than placeholder replacement**: three pin identity to the demo fixtures (`pipeline-template-allowlist`, `gate-param-contract`, `scan-verdict-audit` — `tekton-templates` / `gated-build` / `policy-demo-scanner`; before installing, replace them with your real template namespace, template names, and Task names), and the fourth, `pipeline-entry-lockdown`, must be completed with every legitimate automation creator identity in your environment ([§4.5.4](#s4-5-4)). **Copying verbatim fails in two opposite directions**: the allowlist types will **reject all** of your real pipelines, while the Audit types will **silently do nothing**. Per-policy annotations are in the "usable as copied?" column of [§4.0.2](#s4-0-2).

**Stage 5 completes the minimal usable set** — but what it gives is a **conditional guarantee**; do not read it as "the pipeline can no longer be bypassed":

- The **identity of the definition a PipelineRun references** is constrained by the allowlist — but the **content and change permissions** of in-cluster templates must still be closed off by the RBAC of [§4.1.2](#s4-1-2) (the policy only governs "which template is referenced", not "who has modified that template");
- The **bare TaskRun / CustomRun** entrances are constrained by policy — but an identity holding workload API permissions can still create Pods / Jobs / Deployments directly, or use the deployment credentials elsewhere. **"The pipeline cannot be bypassed" is the joint result of RBAC + policy** ([§4.5.4](#s4-5-4));
- What the gate-parameter guarantee covers **depends on which policy you chose in stage 3**: with `trivy-gate-must-stay-on` → the gate parameters of the **official 0.3 templates** cannot be switched off, cannot be skipped via `skipTrivyScan`, and cannot have the scanning behavior altered from the side via `podTemplate.env` (per task or per run); with `gate-param-contract` → it covers only the self-built gates **you have rewritten to a real profile with identity locked** — copied unmodified it matches nothing but the demo fixtures. Neither covers "the gate skipped wholesale via `when` / matrix" — that belongs to the after-the-fact Audit of [§4.1.5](#s4-1-5), outside the minimal set's hard blocking;
- The **runtime images** of step containers are restricted to approved registry prefixes — **but that is not the same as "the scanner cannot be replaced"**: swapping images within the same registry, or a mutable tag whose content is replaced, are both outside this policy ([§4.5.3](#s4-5-3) recommends pinning digests / adding `verifyImages`).
- Results are **partially observable** (Audit; no blocking): the **vulnerability** side works out of the box (`vuln-summary-audit` shares identity with the official templates); the **Sonar verdict** side requires first rewriting `scan-verdict-audit` to the real scanner identity — otherwise it audits only the demo fixture and PolicyReport will contain not a single record; and the "missing platform marker" inventory **is not the same as** "the gate did not run".

**Explicitly outside the minimal set** (add as needed; each has extra prerequisites):

- The after-the-fact introspection and "gate must-run" audits of [§4.1.4](#s4-1-4) / [§4.1.5](#s4-1-5) — defense in depth, Audit type;
- [§4.2.4](#s4-2-4) protected-branch gates, [§4.5.1](#s4-5-1) artifact-transfer sources, [§4.5.5](#s4-5-5) release targets, [§4.5.2](#s4-5-2) source-image properties — **scenario profiles**, installed only when you actually use those templates / Tasks;
- The **full profile** of [§4.2.5](#s4-2-5) — the minimal version only guarantees "the gate has not been switched off"; the full profile adds "configuration entrances and build inputs under control", carries many entries, and is tightly coupled to the template version; take pieces per the grouping table in [§4.2.5](#s4-2-5);
- The **cancellation-type** policies of [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6](#s4-6) — they need the extra mutate-existing RBAC ([§4.6](#s4-6) introduction), and they are response actions, not admission blocking;
- The PolicyException of [§5.3](#s5-3) — requires first enabling two flags per [§3.1.1](#s3-1-1) and designating `<trusted-namespace>`.

**Three hard ordering constraints**:

1. **Audit before Enforce** ([§3.5](#s3-5)): before each Enforce goes live, run the same rule in Audit and check PolicyReport for existing runs that would be blocked.
2. **Allowlist and parameter-type policies must be installed as a pair; either alone is void**: most criteria outside `pipeline-template-allowlist` pin identity (template namespace / Pipeline / Task names) into preconditions, and in Kyverno **an identity mismatch is not a denial — it is a skip (allow)**. So with only the parameter policies installed and no allowlist, someone who wants around them never needs to touch the gate parameters — submit a run with a self-written `pipelineSpec` (or referencing an ungoverned template): the identity matches none of the parameter policies → everything skips → straight through, and the scanning steps need not even exist. The two layers each own half: the allowlist forces every run onto the governed-template road, and the parameter policies lock the gate switches along that road; allowlist only → templates cannot be bypassed but gate parameters can be switched off; parameter policies only → a back door held open for ungoverned templates.
3. **Keep policies and template versions in sync — and distinguish the two mismatch directions, whose consequences are opposite**:
   - The template **changed its version number** while the policy still pins the old `refVersion`: the identity precondition no longer matches, and the rule simply **skips (allows)** — it **silently stops enforcing**. The only thing that catches this is constraint 2: `pipeline-template-allowlist` allows only approved versions, so the new version is blocked at the allowlist layer rather than discovered by the parameter policy itself.
   - The template **changed, under the same identity, the very parameters this policy judges** (renamed, retyped, or default semantics changed, so the old criterion can no longer fetch the field or the shape no longer holds): the old criterion starts **rejecting all compliant requests** (fail-closed) — the symptom is that right after the upgrade every pipeline is stuck at admission, with the rejection messages coming from your own policy. **Merely adding parameters unrelated to this policy has no such consequence** — a sufficiently narrow criterion is an advantage here. Upgrade order and troubleshooting are in the upgrade-order warning of [§4.2.5](#s4-2-5).

#### 4.0.2 Policy quick reference for this chapter (find the section by name) {#s4-0-2}

When you are blocked, the error message gives you the **policy name**; the table below maps names back to which section they come from, what they govern, and which mode they install in. Rows marked ✅ in the `min` column are the minimal usable set above. **Counting convention**: the table carries **8 ✅ marks**, but those are **candidates across the 5 installation stages (1–5; stage 0 installs nothing)** — stage 3 is a pick-one, so **a single installation is normally 7 policies**; only when official and self-built templates **coexist** and both are needed does it become 8. (Stage 4 installs its three Audit policies in one go.)

The table lists **21 policy names** ([§4](#s4) has 22 `kind: ClusterPolicy` definition blocks, because `pod-image-registry-allowlist` ships two interchangeable YAMLs — see the row **immediately below** `pod-image-registry-allowlist` in the table: it describes the same-named alternative shape, not another policy).

**First, one thing that holds for every policy**: each policy in this chapter is scoped to the demo namespace `policy-poc` (the [§4](#s4) introduction already flags this as a demo choice). So **whether a row says ✅ or 🔧, you must change the scope before copying it to production** — to the namespaces you actually govern, or into a namespaced `Policy` per [§5](#s5). The column below answers a different question: **beyond scope and placeholders, do the identity criteria inside the policy also need changing?**

Of the 21, **11 need more than placeholder replacement**: 10 pin identity to the demo fixtures (`gated-build` / `policy-demo-scanner` / `policy-demo-trivy-summary` / `tekton-templates` / the demo task alias `scan`, and so on) — copied into your environment they **will not error, but will not behave as you expect either**, and the two failure directions are opposite:

- **Allowlist / contract types** (e.g. `pipeline-template-allowlist`): the approved list still names the demo templates → your real pipelines are **all rejected** (fail-closed — loud, not silent);
- **Audit / cancellation types** (e.g. `scan-verdict-audit`, the two in [§4.6](#s4-6)): identity mismatch → **skip, nothing happens** (silently ineffective; not a single record in PolicyReport).

`pipeline-entry-lockdown` is a third case: it pins no demo objects, but **must enumerate every legitimate automation creator identity in your environment** — miss one and you have rejected all of that automation's pipelines.

So the 11 rows marked 🔧 need either an identity rewrite or an identity-list completion; the 10 marked ✅ only need placeholder replacement per [§4.0.3](#s4-0-3) (the scope still needs changing — see the previous paragraph).

| Policy name | Section | What it governs | Mode | min | Usable as copied? |
|---|---|---|---|---|---|
| `pipeline-template-allowlist` | [§4.1.1](#s4-1-1) | PipelineRuns may only reference governed pipeline definitions (three channels) | Enforce | ✅ | 🔧 demo identity: `tekton-templates` + the approved-template name list |
| `pipeline-resolved-definition-audit` | [§4.1.4](#s4-1-4) | For templates the allowlist already let through, **whether the resolved content has been broken** (e.g. the gate task swapped for a same-named one from another source) | Audit | | 🔧 demo identity: template namespace / template name / Task name |
| `pipeline-gate-must-execute-audit` | [§4.1.5](#s4-1-5) | Whether the gate Task was skipped via `when` (`skippedTasks`) | Audit | | 🔧 demo identity: parent Pipeline and gate task names |
| `gate-param-contract` | [§4.2.1](#s4-2-1) | The gate Task's effective parameters (TaskRun level); shipped as a **demo profile** — rewrite the identity when used for self-built templates | Enforce | ✅ | 🔧 demo identity: `gated-build` + `policy-demo-scanner` |
| `gate-param-cancel-existing` | [§4.2.2](#s4-2-2) | Cancel the parent run instead of denying creation when parameters are non-compliant (so finally runs) | mutate-existing | | 🔧 demo identity: two demo templates + the demo Task |
| `gate-param-mutate-to-cancel` | [§4.2.3](#s4-2-3) | Synchronously cancel the gate TaskRun itself when parameters are non-compliant | mutate | | 🔧 demo identity: `policy-demo-scanner` |
| `sonar-branch-analysis-branch-contract` | [§4.2.4](#s4-2-4) | Analysis of protected branches (`main` / `release-*`) may not explicitly switch off the gate or change the scan source; PR / feature builds pass (real sonarqube-scanner profile; 2 Enforce rules + 1 optional Audit) | Enforce + Audit | | ✅ placeholders only |
| `trivy-gate-must-stay-on` | [§4.2.5](#s4-2-5) minimal version | The official 0.3 templates' vulnerability gate cannot be explicitly switched off: four parameter bypasses (`skipTrivyScan`, `trivyExitCode` emptied / `"0"`, severity narrowed, `trivyExtraArgs` non-empty) + two `podTemplate.env` injection paths (per-task `taskRunSpecs`, per-run `taskRunTemplate`), PipelineRun level; **does not block arbitrary `when` / matrix skips**, and **does not restrict the element count of `images`** (the template builds and pushes every element yet scans only `images[0]`, so with multiple images the rest go unscanned — that criterion lives in the full profile) | Enforce | ✅ | ✅ placeholders only |
| `official-template-gates-on` | [§4.2.5](#s4-2-5) full profile | The row above + allowlists for configuration entrances and build inputs (take pieces by group) | Enforce | | ✅ placeholders only |
| `pipeline-run-defaults` | [§4.2.6](#s4-2-6) | Inject defaults (timeout, labels) | mutate | | ✅ placeholders only |
| `scan-verdict-audit` | [§4.4.1](#s4-4-1) sonar shape | Below-the-bar scan verdicts recorded in PolicyReport | Audit | ✅ | 🔧 demo identity: `policy-demo-scanner` |
| `vuln-summary-audit` | [§4.4.1](#s4-4-1) trivy shape | Below-the-bar vulnerability aggregates and overall status recorded in PolicyReport | Audit | ✅ | ✅ placeholders only |
| `vuln-threshold-audit` | [§4.4.2](#s4-4-2) | Books a record when the vulnerability count inside a **string-shaped** result exceeds the threshold (demonstrates the splitting paradigm — a compatibility measure, not the recommended shape) | Audit | | 🔧 demo identity: resolver-less `taskRef.name` = `policy-demo-trivy-summary` |
| `inventory-ungated-runs` | [§4.4.4](#s4-4-4) | Stock-taking: which PipelineRuns lack the platform marker (**does not prove the gate ever ran**, [§4.4.4](#s4-4-4)) | Audit (background) | ✅ | ✅ placeholders only |
| `artifact-source-allowlist` | [§4.5.1](#s4-5-1) | Allowlist of artifact-transfer sources (real skopeo-copy profile) | Enforce | | ✅ placeholders only |
| `promotion-source-image-labels` | [§4.5.2](#s4-5-2) | Read the source image's config and validate its properties | Enforce | | ✅ placeholders only |
| `pod-image-registry-allowlist` | [§4.5.3](#s4-5-3) | **Prefix** allowlist for the images Tekton Pods actually run, covering all three classes — steps / init / ephemeral containers (Pod-level hard block); **cannot block image swaps within an approved prefix or mutable-tag content swaps** | Enforce | ✅ | ✅ placeholders only |
| (The same-named alternative shape of the row above — **not another policy**) | [§4.5.3](#s4-5-3) | `pod-image-registry-allowlist` ships **two interchangeable complete YAMLs**: regexes written into the policy body, or regexes centralized in the `pipeline-image-allowlist` **ConfigMap** (called "shape A" in that section; portable across environments). There are also two **relaxed regex variants** (shapes B / C — regex fragments plus a strength comparison only, not standalone policies) | Enforce | | Same as the row above |
| `pipeline-entry-lockdown` | [§4.5.4](#s4-5-4) | Close the bare `TaskRun` / `CustomRun` entrances (contract 7) | Enforce | ✅ | 🔧 besides replacing `<platform-admin-identity>`, you must also **complete the list of legitimate automation creators in your environment** (triggers / GitOps controllers etc., end of [§4.5.4](#s4-5-4)) — missing one means rejecting all of its pipelines |
| `release-target-allowlist` | [§4.5.5](#s4-5-5) | Hub source identity (**validated whether or not deployment is enabled**) + with deployment enabled: target namespace, kubeconfig source, shell-safe parameters and container names (`workloadContainers`), plus execution coverage (any `taskRunSpecs` override of the deploy task and any run-level `podTemplate.env` are denied outright; run-level `serviceAccountName` per the approved list). **All of the above constrain "what the request says"**: the manifest's own `metadata.namespace`, cluster-scoped resources, the **content** of the kubeconfig Secret, and business semantics like "which container should be updated" sit outside them — see the boundary note in [§4.5.5](#s4-5-5). The identity covers **both** the java **and** python 0.3 templates | Enforce | | ✅ placeholders only (**five spots**; the SA and namespace entries are list-as-many-as-you-have lists, and the SA list must include the one Tekton fills in by default) |
| `cancel-on-failed-verdict` | [§4.6.1](#s4-6-1) | Cancel a running pipeline when results miss the bar | mutate-existing | | 🔧 demo identity: template namespace |
| `cancel-run-without-gate` | [§4.6.2](#s4-6-2) | Self-cancel on definition drift | mutate-existing | | 🔧 demo identity: demo template and gate task names |

[§5](#s5) has three more policies related to scope / exemption: `pipeline-baseline` and `project-alpha-tightening` ([§5.2](#s5-2) two-tier governance), and `exempt-namespace-approver-only` ([§5.3](#s5-3) the RBAC closure of PolicyException).

#### 4.0.3 Placeholder reference table (replace every one before copying a policy) {#s4-0-3}

The policy assets in this chapter contain a class of **environment configuration values**: they decide what the policy actually matches, and a missed or wrong replacement **raises no error** — instead the policy fails in one of two opposite directions:

- **fail-open (the majority)**: the policy installs, looks right, and blocks nothing (e.g. the allowlist prefix names somebody else's registry);
- **fail-closed**: all **compliant** requests get rejected (e.g. the approved Sonar URL or deployment target namespace still carries the sample value, which real parameters will never equal).

Rows marked ⚠️ are those whose **failure direction is unusual or whose consequences are heaviest**; the direction follows each row's own note: most ⚠️ rows are fail-closed, but the `catalog` literal row splits **both ways** by policy type, and the Tekton controller identity row is **purely fail-open** (skip — silent allow). Do not read ⚠️ as "⚠️ = false rejections, at least discoverable".

The table below lists this class exhaustively, each entry with how to obtain the value and how to self-check. **Note that three rows are not in angle-bracket form** (the hub catalog name `catalog`, the Tekton controller identity, and the batch of `approved-*` object names): they are written into the policies as bare literals, so searching for angle brackets will not find them — yet they must be verified and replaced all the same (the `catalog` row also has 11 parameter-key occurrences that must **not** be replaced; see that row's note).

⚠️ **The replacement action is "search the whole policy text for the placeholder and replace every occurrence", not "fix the one in front of you"**. This document's policy assets deliberately collapse each placeholder to **a single site** ([§4.5.3](#s4-5-3) pulls the regex into one `variable` that both the criterion and the message reference, precisely for this) — but the moment you extend the criteria yourself it is easy to copy out a second site, and **two inconsistent sites raise no error**; they just make the verdict and the message tell two different stories ([§4.5.3](#s4-5-3) records both directions). After replacing, search once more for `<` to confirm nothing slipped through — **except sample angle brackets inside policy YAML comments** (such as `<kind>` / `<name>` in the [§4.5.5](#s4-5-5) policy comments: they live in comments, take no part in evaluation, and are harmless to keep).

For **Enforce validate policies**, the post-install self-check is always two steps: first run a genuinely compliant request through `--dry-run=server` to confirm it is **allowed** (catches fail-closed), then deliberately break one field to confirm it is **denied** (catches fail-open). Doing only the second step will never find a missed replacement.

:::warning The two-step self-check does not apply to one class of policy: the identity-preconditioned ones

The two steps above work directly for **PipelineRun-level** policies. But for any policy that makes `request.userInfo` or "created by the controller" a precondition — `gate-param-contract` in [§4.2.1](#s4-2-1) (requires the creator to be the Tekton controller SA + an owner lookup of the parent run), `pipeline-entry-lockdown` in [§4.5.4](#s4-5-4), the PolicyException RBAC closure in [§5.3](#s5-3) — **objects you submit by hand will not hit their preconditions**: your identity is neither the controller nor the approved one, so the rule **skips and the request is allowed**. It looks like "step one passed", when in fact **nothing was verified** (this is the classic false pass).

Two correct approaches; pick either:

1. **Submit with the identity**: `kubectl create --dry-run=server --as=<that-identity> -f <object>.yaml`. Same TaskRun, same policy: submitted as yourself → **allowed** (the rule did not fire); submitted with `--as=system:serviceaccount:tekton-pipelines:tekton-pipelines-controller` → **denied, with the message printing `creator=…tekton-pipelines-controller`**. This requires impersonate permission (`kubectl auth can-i impersonate serviceaccounts`), and for policies like [§4.2.1](#s4-2-1) the **parent run must really exist** — the policy uses `context.apiCall` to look it up via the ownerReference and verify its UID.
2. **Run a real pipeline as an E2E**: watch whether the child TaskRun is denied at admission, whether the parent run enters `CreateRunFailed`, and whether finally executes (the "What it cannot govern" part of [§4.2.1](#s4-2-1) explains how the three relate).

By the same token, the self-checks for the `<platform-admin-identity>` / `<approver-identity>` placeholders must use `--as` — otherwise you have only verified "an ordinary identity is denied", not "the approved identity passes".

:::

Two further policy classes skip the "confirm denied" step; their self-check targets differ: **Audit policies** (including the ones reading `*/status`) should confirm the request is **allowed** as usual, then check PolicyReport for the recorded violation; **mutate / mutate-existing policies** should inspect the patched object or the triggered response action (e.g. whether the run really entered `Cancelled`).

| Placeholder | What it is | How to obtain the value | How to self-check |
|---|---|---|---|
| `<registry>` | The image registry prefix the fixtures pull busybox from | Use the two commands in [§3.3](#s3-3) to read out, as candidates, the prefixes the platform itself is pulling (the controller image / all image prefixes in that namespace, deduplicated), then confirm the prefix is also pullable from `policy-poc` and carries `busybox`; production should pin a digest ([§3.3](#s3-3)) | The fixture Pod starts normally. If it does not, check `describe pod` for `ImagePullBackOff` first — that is a prefix or pull-credential problem, not a policy problem |
| `<approved-git-repo>` | The approved git repository URL for pipeline definitions | Take the **verbatim string** of the `url` parameter the git resolver actually uses (including protocol and `.git`-suffix differences); compare exactly with `==`, no prefix matching | Dry-run a real PipelineRun and confirm allow; changing one character of the URL should be denied |
| `<approved-registry>` | The approved artifact registry prefix ([§4.5.1](#s4-5-1)) | Registry host (port allowed) + project path prefix. This one is a `starts_with` **string** comparison, **not a regex** — do not fill in a regex fragment | A `srcImage` under the approved prefix is allowed; switching it to `docker.io/...` is denied |
| `<approved-registry-regex>` | The approved business registry prefix, as a **regex fragment** ([§4.5.3](#s4-5-3)) | Take the host part of `<approved-registry>` and escape RE2 metacharacters character by character per the rules in [§4.5.3](#s4-5-3) (`.` → `[.]`, etc.) | Run the 9 self-check probes of [§4.5.3](#s4-5-3); the three "neighboring host / neighboring port / unescaped `.`" probes must be **denied** |
| `<tekton-infra-image-regex>` | The **complete-repository** regex fragment for Tekton's five classes of infrastructure images ([§4.5.3](#s4-5-3)) | Command A in [§4.5.3](#s4-5-3) (controller startup arguments) yields the **complete candidate list**; command A2 replaces the address prefixes with the **platform's private registry address** (read `registryAddress` from the `global-info` ConfigMap in `kube-public`) — admission sees the addresses **after** platform image rewriting, and pre-rewrite forms do not belong in the allowlist; command B (sampling real Pods) is **cross-validation only**, never the list source (sampling only sees the classes that happened to run, and can come back empty). Strip tags / digests down to the repository, then escape character by character. **Even command A is only a starting point, not proof of a "complete list"**: the startup arguments do not include every auxiliary image (GC / results / affinity assistant / future versions). The authoritative source should additionally include an **installed-state inventory** — the operator's `TektonConfig` / `TektonPipeline` CRs plus the image fields of every Deployment in the `tekton-pipelines` namespace — take the union, and run it through the same A2 prefix replacement | All five image classes allowed; a same-host `…-evil` denied. **And you must first run a full cycle in Audit** (including one upgrade and one GC) confirming PolicyReport shows no infrastructure-image violations before switching to Enforce — one missed class keeps all of Tekton from starting |
| `<project-path>` | The project path segment pinned in relaxed shape B ([§4.5.3](#s4-5-3)) | Cut, from the same repository list above, the segment between the host and the image name | Re-verify shape B's comparison table row by row; note that shape **does not lock the host** and is weaker than shape A |
| `<tekton-managed-by-label-value>` | The label value that scopes in Tekton Pods | Read `default-managed-by-label-value` from `tekton-pipelines/config-defaults`; only a **missing key** falls back to the default `tekton-pipelines` — a key present with an empty value is a deployment blocker and must be changed to a non-empty value first | Select a real Tekton Pod once with that label; it is only correct if the selection returns one |
| `<platform-admin-identity>` | The platform administrator identities allowed to bypass entry closure ([§4.5.4](#s4-5-4)) | Write them as full `system:serviceaccount:<ns>:<sa>` strings or usernames, taken from your platform operations accounts, **enumerated one by one — no wildcards**. **You must also enumerate every legitimate automation creator in the environment**, and "complete" needs a method, not memory: ① **RBAC reverse lookup** — walk `RoleBinding` / `ClusterRoleBinding` for subjects bound to roles carrying `create` on `taskruns` / `pipelineruns` (filter `rules[].resources` in `kubectl get clusterrole,role -A -o json`, then look up the bindings); ② **the trigger and GitOps side** — the SAs used by EventListener / TriggerTemplate, the ArgoCD / Flux controller SAs, the platform's own scheduling component SAs; ③ **install one round in Audit first**, collect the real creators from PolicyReport and the API server audit logs, complete the list, then switch to Enforce. Do all three before Enforce | Creating a bare TaskRun with `--dry-run=server --as=<identity>` under that identity should be allowed; an ordinary business identity should be denied (**`--as` is mandatory** — see the identity-class self-check note above) |
| `<approver-identity>` | The approver identity entitled to issue exemptions ([§5.3](#s5-3)) | Take the actual owner / service account of your exemption approval process, again as a full identity string | That identity can create PolicyExceptions in the trusted namespace; other identities are denied by RBAC |
| `<business-identity>` | An ordinary business identity, used to verify the "no exemption-issuing power" side ([§5.3](#s5-3)) | Take a real business ServiceAccount, full identity string | `kubectl auth can-i create policyexceptions` for that identity should be `no`; creating a run in `policy-exempt-runs` should be denied at admission |
| `<catalog>` | The catalog name of hub references (**signpost row**: **the angle-bracket form appears only in the probe skeletons and error samples of [§3.4](#s3-4)** — in the policy assets it is a bare literal, see the next row; this row stays in the table because you will most likely search for `<catalog>`) | Take it from the hub entries you actually reference: the value of the `catalog` parameter in a real run's `taskRef.params` / `pipelineRef.params` | Matches the real run's `catalog` parameter value verbatim |
| The `catalog` literal (**22 effective-line occurrences across the installable YAML of 7 policies, of which the 11 value-side occurrences must be replaced** — the `refCatalog=='catalog'` comparison ×1 + `value: catalog` in preconditions ×10 ([§4.2.4](#s4-2-4) 1 in each of its three rules, [§4.2.5](#s4-2-5) 4 across its two policies, [§4.4.1](#s4-4-1) / [§4.5.1](#s4-5-1) / [§4.5.5](#s4-5-5) 1 each); the policy list: `pipeline-template-allowlist` / `sonar-branch-analysis-branch-contract` / `trivy-gate-must-stay-on` / `official-template-gates-on` / `vuln-summary-audit` / `artifact-source-allowlist` / `release-target-allowlist`. **The counting scope = effective lines of the installable YAML**, comments excluded; same-named literals in the "key criteria" excerpts and in the probes / fixtures get replaced likewise when you copy those blocks, but do not count toward this number) | The hub catalog name pinned into the policies' identity criteria — **not in angle-bracket form; searching for `<` will not find it**. **And this row is the one exception to the introduction's "search the whole text, replace every occurrence" discipline**: the other 11 occurrences, `[?name=='catalog']`, are the hub resolver's **parameter key** (fixed by the Tekton API, unrelated to what your catalog is called) and must **never** be replaced — replace those and `refCatalog` always evaluates to the empty string: allowlist types reject everything compliant, identity-preconditioned types all skip | Same method as the previous row. In this document's verification environment (the official catalog of ACP's built-in hub) the name is literally `catalog`, so with the built-in hub + official templates you usually need no change — **but verify it verbatim once before installing** | ⚠️ Pinned wrong, both directions are silent: for **identity-preconditioned types** (Audit / gate types, where catalog is a link in the identity chain) the rule skips — **silent allow**, not one record in PolicyReport; for **allowlist types** ([§4.1.1](#s4-1-1) hub channel, [§4.5.1](#s4-5-1)) **all compliant requests are rejected**. Self-check with one real run through the two-step dry-run at the top of this section (allow + break-and-deny) |
| The Tekton controller identity literal (**7 policies**: the `match.subjects` of [§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3) / [§4.6.1](#s4-6-1) / [§4.6.2](#s4-6-2) (`namespace: tekton-pipelines` + `name: tekton-pipelines-controller`), the full-string comparison `creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller'` in [§4.5.4](#s4-5-4), and the trusted-identity list of [§5.3](#s5-3) — which additionally carries `tekton-chains-controller`) | The identity pin behind every "created by the Tekton controller" precondition — **again not in angle-bracket form**. In environments where Tekton sits in a non-default namespace (the `TektonConfig.spec.targetNamespace` mentioned in [§4.1.2](#s4-1-2)) or the SA name differs, these identities **all fail to match** | Read the real thing, do not hand-assemble: use the two `kubectl get deploy … -o jsonpath` commands in the "identity verification" passage of [§5.3](#s5-3) to print the exact identity strings (the controller is a must-read; the Results watcher only when enabled); how to obtain `TEKTON_NS` is in [§3.1](#s3-1) | ⚠️ Pinned wrong = the identity precondition never holds → the rule **skips, silent allow**: the gate / cancellation policies are as good as not installed, and PolicyReport will not carry a single record. The self-check must include a denial probe with `--as=<that-identity>` (see the "identity-preconditioned" warning above) — probes under an ordinary identity are, for these rules, always a false pass |
| `<approved-sonar-url>` | The approved Sonar server URL ([§4.2.5](#s4-2-5)) | Take the real `sonarURL` parameter value from your environment, as a **verbatim string** (including protocol, port, and trailing-slash differences), compared exactly with `!=` | ⚠️ **A missed replacement here shows the opposite of the rows above**: not "nothing gets blocked", but **all compliant requests rejected** — `sonarURL` will never equal the sample value. After installing, first run a genuinely compliant PipelineRun through `--dry-run=server` and confirm allow |
| `<approved-maven-mirror-url>` | The approved Maven mirror repository URL ([§4.2.5](#s4-2-5), java template only) | Take the real `mavenMirrorURL` parameter value from your environment, verbatim string | ⚠️ Same direction as above, but **scoped to requests that explicitly pass a non-empty value**: the criterion is `mavenMirrorURLPresent && mavenMirrorURL != '' && != placeholder`, so not passing it / passing the empty string still allows (template default `""`). **Every compliant request that explicitly configures a mirror will be rejected** |
| `<approved-maven-cert-path>` | The approved Maven certificate file name ([§4.2.5](#s4-2-5), java template only) | Take the real `mavenCertPath` parameter value from your environment (the sample is `ca.cert`) | ⚠️ Same as above, **scoped to requests that explicitly pass the parameter**: the criterion is `mavenCertPathPresent && != placeholder`; absence inherits the template default `ca.cert` and still allows |
| `<approved-deploy-namespace-a>` / `<approved-deploy-namespace-b>` | The target namespaces deployment is allowed into ([§4.5.5](#s4-5-5)) | Enumerate every deployment target namespace you approve — the sample gives two; list however many you actually have inside `contains([...])` | ⚠️ Same direction, **scoped to requests with deployment enabled** (the criterion hangs under `deploymentEnabled`; requests not enabling deployment still allow): **every compliant request that actually releases will be rejected**. After installing, run a real deployment PipelineRun through `--dry-run=server` to confirm allow, then change the namespace to an off-list value to confirm deny |
| `<approved-deploy-kubeconfig-secret>` | The Secret name allowed as the `kubeconfig` workspace source ([§4.5.5](#s4-5-5)) | Take the real deployment-credential Secret name from your environment. **The criterion is likewise a single-value `!=` and supports only one Secret**; to approve several, rewrite it into the `contains([...], kubeconfigSecret)` form — do not use wildcards | ⚠️ Same as above: **a missed replacement = every compliant request that explicitly binds a kubeconfig is rejected** (not binding a kubeconfig = deploying to the current cluster, which was allowed anyway and is unaffected) |
| `<tekton-default-service-account>` | The SA name Tekton defaulting fills into a run-level `spec.taskRunTemplate.serviceAccountName` (the first entry of the approved list in [§4.5.5](#s4-5-5)) | Read `default-service-account` from `tekton-pipelines/config-defaults`; only a **missing key** falls back to Tekton's built-in default `default` — and most ACP clusters ship with the key missing (it appears only in the inert `_example` comment block), so **reading back an empty value is normal, not a broken command**. For a definitive answer in one step, read the **effective value** after defaulting (using the [§3.3](#s3-3) fixture run; `--dry-run=server` has no side effects; factory state prints `default`): `kubectl create --dry-run=server -n policy-poc -f demo-run-pass.yaml -o jsonpath='{.spec.taskRunTemplate.serviceAccountName}{"\n"}'` — it reads exactly the field the policy compares; whatever it prints is what you fill in. **This entry is not optional**: the defaulting webhook runs before Kyverno, so admission never sees the field absent — leaving it off the list amounts to refusing to approve "ordinary requests" | ⚠️ **Miss it = 100% of compliant deployment-enabled requests rejected** (lesson learned: the first version of the criterion listed only the site SA, and every compliant request was rejected). The self-check is that allow probe: one real release run must be allowed |
| `<approved-deploy-service-account>` | The deployment ServiceAccount names you approve yourself (the remaining entries of the approved list in [§4.5.5](#s4-5-5)) | Enumerate the SAs your release pipelines actually use — the criterion is `contains([...], runWideSa)`; list however many you have. It must be maintained together with the RBAC you grant the deployment credentials: **add a new deployment SA → add it to this list in the same change**, or that pipeline gets rejected | ⚠️ Same direction, **scoped to requests with deployment enabled whose run-level SA is not the default from the previous row**; requests without deployment are unaffected. Self-check: confirm a release run using the real SA is allowed, then change the SA to an off-list name and confirm deny |
| The batch of `approved-*` **object names** (12 in the full profile of [§4.2.5](#s4-2-5): `approved-sonar-credentials` / `approved-sonar-settings` / `approved-registry-config` / `approved-sonar-certificate` / `approved-trivy-config` / `approved-ca-bundle` / `approved-maven-settings` / `approved-maven-cert` / `approved-maven-server` / `approved-maven-local-repo` / `approved-maven-trust-store` / `approved-pip-conf`; the [§4.5](#s4-5).x sections use angle-bracket placeholders, which are not in this batch) | Approved Secret / ConfigMap names written directly into the policies as literals — **not in angle-bracket form, but they must be changed all the same** | Replace them with the objects genuinely approved in your environment. **"Which one is the approved one" needs an authoritative source** — do not guess by name inside the namespace: take the copy declared in the platform configuration repository / GitOps manifest, or give approved objects a uniform label (e.g. `policy.alauda.io/approved=true`) and list them with `kubectl get cm,secret -n <ns> -l policy.alauda.io/approved=true`, then confirm with the configuration's owner; list changes (new / rotated objects) must ride the same process as policy changes, or the policy will reject the object you just rotated in. **Note the criterion is a single-value `!=` comparison — each workspace allows exactly one approved object.** To allow several sources you must change the criterion itself to `count > `1` \|\| (count == `1` && !contains(['approved-a','approved-b'], name))` — merely listing several names here does nothing. (`count` here is **the number of bindings that workspace has in the request**, not the number of approved objects; Tekton guarantees a workspace name is not repeated, so it is normally 0 or 1, and the `count > 1` branch is defense in depth kept in the same shape as the other criteria.) | ⚠️ Same direction, **scoped to requests that explicitly bind the workspace**: the criterion shape is `count > 1 \|\| (count == 1 && name != approved-value)`, and **requests not binding this optional workspace still allow under the absence semantics**. Self-check the same way: first confirm a compliant request genuinely binding these objects is allowed, then swap in an unapproved object and confirm deny |
| `<trusted-namespace>` | The trusted namespace — the only one Kyverno accepts PolicyExceptions from ([§3.1.1](#s3-1-1) / [§5.3](#s5-3)) | Designated by you and written into `--exceptionNamespace`; it should be a dedicated namespace **writable only by exemption approvers** — do not reuse a business or demo namespace | Item 5 of the [§3.1](#s3-1) checklist reads back `--exceptionNamespace=<that value>`; a PolicyException created in any other namespace should have no effect |

None of the remaining angle brackets in the document belong to this class; do not look for them in the table above:

- **Object names in commands and error samples** — `<policy>`, `<fixture>`, `<producer>`, `<gate>`, `<kind>`, `<name>`, `<seq>`, `<yyyymmdd>` and the like, whose meaning follows the example they sit in (e.g. `<policy>` in the [§4.4](#s4-4) troubleshooting commands is the policy you are inspecting, and `<yyyymmdd>-<seq>` in the PolicyException sample is merely a suggested naming convention); `<path-to-global-kubeconfig>` (the global cluster kubeconfig path) and `<cluster-name>` (the target cluster running Kyverno) in the [§3.1.1](#s3-1-1) commands, `<target-context>` (the target cluster's kubectl context name) at the start of [§3](#s3), and `<your-pipeline-namespace>` / `<one-real-run>` / `<terminal-taskrun>` / `<measurement-copy-name>` in the troubleshooting commands are in this class too; so is `<configured-hub-endpoint>` (the cluster's configured hub service address) — it appears only in an error-message sample and is written into no policy; to verify it, read `tekton-pipelines/hubresolver-config`, which should match what item 2 of the [§3.1](#s3-1) checklist reads;
- **Placeholders that appear only in "relaxed variants"** — e.g. `<platform-default-env-name>` in [§3.6](#s3-6), or `<approved-scanner-service-account>` in the [§4.2.5](#s4-2-5) passage about extracting the `serviceAccountName` criterion into an approved list: they belong to optional shapes you need only when a certain condition appears in your environment, and are not part of this document's published policy assets, so they are not in the table; if you do adopt those shapes, the value-taking and self-check methods are written in those passages;
- **Prose that uses angle brackets to mean "fill in your own value"** — e.g. `system:serviceaccount:<ns>:<sa>` and `<that value>` in the identity-format notes of the table above, or `spec.statusMessage: <reason>` in [§4.2.3](#s4-2-3).

Getting these two classes wrong only makes a command find nothing, or changes message wording; it cannot make a policy silently stop enforcing — so they are not itemized in the table above.

#### 4.0.4 How to clean up demo resources (self-created namespaces cascade; cluster-scoped objects by name) {#s4-0-4}

Every section in this chapter ends with a "cleanup" passage. **The prerequisite discipline ([§3.3](#s3-3)): all namespaced demo objects are created only inside namespaces the walkthrough created itself — never operate on pre-existing namespaces.** Cleanup therefore reduces to two rules:

1. **Namespaced objects are not deleted one by one**: the `PipelineRun` / `TaskRun` objects, the fixture `Task` / `Pipeline`, ConfigMaps, RBAC and the rest are all reclaimed together with their namespace — the namespaces are deleted in each section's cleanup passage or in the final cleanup of [§3.3](#s3-3), after checking the walkthrough-id label, and the cascade takes everything inside with it (controller-derived child TaskRuns / Pods need no separate deletion either; the owner cascade reclaims them). The cascade is exactly why the prerequisite must hold: **the namespace you delete must contain nothing of anyone else's** — so the creation loop stamps the walkthrough id only on namespaces it newly created, and the cleanup loop deletes only those whose label equals this run's id; the id must be unique per walkthrough ([§3.3](#s3-3) generates it) — a fixed value cannot tell "created this time" apart from "left over from a previous unfinished walkthrough".
2. **Cluster-scoped objects (`ClusterPolicy`, the `ClusterRole` of [§4.6](#s4-6)) are not taken away by namespace deletion**; delete them by name, one by one. There is a check at each end: **before creating**, confirm no same-named object exists (the code block below — `apply` would silently overwrite a same-named policy somebody else is actively governing with); **before deleting**, `kubectl get` and eyeball that the `creationTimestamp` falls inside this walkthrough's window. The window risk of a same-named object being swapped mid-walkthrough is carried by that one look; the demo policy names in this chapter are names dedicated to this document and normally will not collide with anyone else's objects. **The batch delete commands each section's cleanup passage gives list "every name this section may have installed" — they are not copy-and-run**: if you only ran part of a section, or hit one of this chapter's mutually exclusive choices (the first three of [§4.2](#s4-2)), the name list will contain policies you never installed — and those names either do not exist (harmless) or **belong to someone else** (harmful). So batch deletion follows this rule too: first look at the `creationTimestamp` values `get` prints, remove from the `delete` command every name not inside your walkthrough window, then run it.

```bash
# Cluster-scoped objects: `apply` would silently overwrite an existing same-named
# policy -- somebody else's live governance rule. Check first, then create.
# Three branches, not `get || create`: a get that failed for RBAC or network reasons
# is NOT "the name is free", and falling through to create would skip the very check
# this block exists for.
POLICY_NAME='<policy-name>'
# Reject the unreplaced placeholder BEFORE anything queries or creates with it: this block
# ends in `kubectl create -f "$POLICY_NAME.yaml"`, so a literal <policy-name> would look for
# a file of that name -- or match nothing and read as "the name is free".
case "$POLICY_NAME" in '<'*'>') echo "fill in POLICY_NAME first"; POLICY_NAME='';; esac
if [ -z "$POLICY_NAME" ]; then
  echo "no policy name set -- nothing to check or create"
elif ! out=$(kubectl get clusterpolicy "$POLICY_NAME" -o name --ignore-not-found 2>&1); then
  echo "$POLICY_NAME: CHECK FAILED ($out) -- fix cluster access first; do NOT create blindly"
elif [ -n "$out" ]; then
  echo "$POLICY_NAME already exists -- stop and check with its owner; do NOT apply over it"
else
  kubectl create -f "$POLICY_NAME.yaml"
fi

# ...and before deleting by name, one look at when it was created:
kubectl get clusterpolicy "$POLICY_NAME" \
  -o jsonpath='{.metadata.creationTimestamp} {.metadata.name}{"\n"}'
# A creationTimestamp inside your walkthrough window is yours. Anything older is
# not -- then STOP and ask its owner instead of deleting.
kubectl delete clusterpolicy "$POLICY_NAME"
```

If you genuinely must run a demo alongside an existing policy, give your copy a distinct prefixed name (which is what this document's per-section probe scripts do); do not reuse the published name.

#### 4.0.5 Cross-section interference when walking the demos (the number-one reason a probe will not run) {#s4-0-5}

The table in [§4.0.1](#s4-0-1) gives the **production rollout order**, not an order for walking this document section by section. **The section demos are mutually independent**: each installs its own policies, runs its probes, and cleans up. Stack several sections' Enforce policies on the same cluster while running demos and you get "the request was already rejected by another policy before this section's policy was ever evaluated" — the rejection reason you are reading has nothing to do with this section's conclusion.

**Mechanical criterion**: a Kyverno rejection message always carries the **policy name**. Name ≠ the policy you are verifying = you were blocked by a different policy; draw no conclusion from it (leftover debug policies make entire probe suites fail spuriously in batches — clean up per [§4.0.4](#s4-0-4) before running).

Two spots genuinely self-lock (the table below is the interlock result among this document's own policy assets, re-checkable with `--dry-run=server`):

| Installed policy | Blocked demo | Result |
|---|---|---|
| [§4.1.1](#s4-1-1) `pipeline-template-allowlist` (Enforce) | `gated-build-with-prep` of [§4.2.2](#s4-2-2), `gated-build-rogue` of [§4.6.2](#s4-6-2) | Both demo runs are rejected by the **allowlist** (the message names `pipeline-template-allowlist`) — those sections' own policies are never even evaluated. The three `gated-build` variants of [§3.3](#s3-3) (pass / gate-fail / gates-off) are unaffected and pass as usual |
| [§4.5.4](#s4-5-4) `pipeline-entry-lockdown` (Enforce) | The **bare TaskRun probes you submit by hand** in [§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4) / [§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2) / [§4.5.1](#s4-5-1) / [§4.5.2](#s4-5-2) | Submitted under an ordinary identity they are all rejected by it (the message says `pipeline-entry-lockdown`); submitted with `--as` under the approved `<platform-admin-identity>` they pass |

Pick one of two modes for the walkthrough:

- **Section-by-section isolation** (recommended): before running a section's probes, `kubectl get clusterpolicy` to confirm no other section's Enforce policy is on the cluster;
- **Temporary relaxation**: temporarily add `gated-build-with-prep` / `gated-build-rogue` to the approved-name list of [§4.1.1](#s4-1-1) (revert after the demo), and submit every bare-TaskRun probe with `--as=<platform-admin-identity>`.

Also, `official-gated-build` in the [§4.1.1](#s4-1-1) approved list is merely a sample name for "your second approved template" — **this document's fixtures do not create it**; when copying the list, replace it with your real template name per the note in [§4.0.2](#s4-0-2).

#### 4.0.6 The minimum bar for rejection messages (can the blocked person fix it themselves) {#s4-0-6}

**"The policy blocks" ≠ "the rollout succeeded".** A rejected pipeline user holds exactly one thing — the sentence the API returned; they can see neither the full `ClusterPolicy` nor should they. Write that sentence badly and every block becomes a conversation with the platform team. When copying this document's policies, walk each one through three questions:

| Element | Criterion | Who is responsible |
|---|---|---|
| **① Which policy blocked it** | The rejection message must reveal the policy / rule name | **Kyverno built-in**: the API error carries a `<policy>: <rule>: ...` prefix; you need not repeat it in the message |
| **② Which field's value is non-compliant** | The message must name the **field**, and echo the **value actually read** where possible (absence must also be recognizable as absence) | **You, when writing the message** — the most commonly missed item |
| **③ What compliant looks like / whom to ask for the list** | If the value set is small and non-sensitive (e.g. `"true"`, `main` / `release-*`), write it straight into the message; **if it is an approved list (registry prefixes, approved namespaces / Secrets / identity names), do not** — write "the list is maintained by the platform; request it from X" instead | **You, when writing the message**, deciding per environment what counts as sensitive |

Elements ② and ③ do not conflict, because they speak of two different things: **what gets echoed is "the value in the request"** (the submitter wrote it in; they already know it), **what does not get echoed is "the approved set"** (which they do not know and should not be able to derive from an error). So "your `srcImage` is not among the approved sources" is right, and "the approved sources are A / B / C" is wrong. **Do not collapse the two into "the actual value must not be echoed either"** — that regresses to the useless message that only says "non-compliant".

Three practical points (each stumbled over on this document's own policies):

- **Multiple criteria under `deny.conditions.any` share one message**: the user cannot tell which one they tripped. Either split the criteria into separate rules (one message each), or **echo the actual values of a few key fields in the message** (most policies in this document choose the latter — e.g. [§4.2.1](#s4-2-1) prints the actual values of both gate parameters). The test is: **after reading the message, do you know which field to change?**
- **`element.*` cannot be used in a `foreach` message** (Kyverno rejects it at policy creation); to call out the specific element you have to recompute it with a `context` variable — the writing pattern and its two traps are in the design notes of [§4.5.3](#s4-5-3).
- **Cancellation (mutate-existing / admission mutate) has no rejection message**: the user only sees `Cancelled`. **The reason must be written into the object by you** (the `cancel-reason` annotation or `spec.statusMessage`) — otherwise afterwards you cannot even prove "a policy did this" ([§6.2.3](#s6-2-3)).

One boundary in the other direction: **do not treat the message as an audit record**. It lives only in that one API response and the PipelineRun's condition; once the object is cleaned up it is gone ([§4.4.4](#s4-4-4)).
### 4.1 Template and definition constraints (the definition side of contract 1 "identity" / contract 7 "entry closure") {#s4-1}

**The general contract**: PipelineRuns in workload namespaces may only reference governed pipeline definitions. "Governed" unfolds along the three tiers of strength in [§2.1](#s2-1):

1. The in-cluster template namespace (cluster resolver → `tekton-templates`): both content and change permissions are controlled inside the cluster (change permissions closed off by standard RBAC, see [§4.1.2](#s4-1-2)) — the strongest;
2. hub / git **immutable reference** (catalog entry + explicit version / commit SHA): identity is locked in-cluster, content trust comes from the catalog release process / repository governance — strong identity, content dependent on external governance;
3. hub / git **mutable reference** (branch / tag / defaulted version): content changes take effect automatically as the remote moves — tracking template updates without touching cluster configuration, which is itself a common and legitimate usage; but Kyverno cannot lock content at this tier, and any strong constraint can only come from repository-side permission controls (protected branches / tags, tightened write permissions). Where the repository side lacks that layer of control, reject it.

#### 4.1.1 Template allowlist (three channels, fail-closed) {#s4-1-1}

- **What it governs**: PipelineRuns in workload namespaces **may only reference governed pipeline definitions** — unknown templates are stopped at the "reference shape" layer.
- **Why it is hard**: legitimate references come through three channels (cluster / hub / git), and on each channel, **validating only some of the fields leaves a bypass path**: cluster checked by namespace alone lets through any ungated Pipeline in that namespace; hub checked only by the resource tuple can have its backend swapped via a request-level `url` or a `type` switch; git checked only by url + SHA lets through any other file in the same commit.
- **How the policy is layered**: ① each of the three channels computes one boolean (`clusterOK` / `hubOK` / `gitOK`), each locking the **complete** canonical identity → ② take the union of the three → ③ **union false ⇒ deny** — inline `pipelineSpec`, bare name references, unpinned versions, and any reference shape that appears in the future all land on the deny side by default.
- **What it cannot govern**: it only knows "who is being referenced" — it cannot see **the content of the referenced definition** (at CREATE the definition is not yet resolved, [§2.1](#s2-1) observation point 2) — content drift is backstopped by the after-the-fact Audit in [§4.1.4](#s4-1-4); channel 1's strength additionally depends on write permissions to `tekton-templates` being closed off by RBAC ([§4.1.2](#s4-1-2)); for cases that genuinely need inlining, see the exception in [§4.1.3](#s4-1-3).

**The key criterion** — each of the three channels locks the complete identity, and a false union is a denial:

```yaml
        # channel 1: cluster resolver — FULL identity: kind + namespace + an approved name
        - name: clusterOK
          variable:
            jmesPath: "resolver=='cluster' && refKind=='pipeline' && refNamespace=='tekton-templates' && contains(['gated-build','official-gated-build'], refName)"
        # channel 2: governed Artifact Hub endpoint + complete resource tuple
        - name: hubOK
          variable:
            jmesPath: >-
              resolver=='hub'
              && refKind=='pipeline'
              && refCatalog=='catalog'
              && refName=='java-image-build-scan-deploy'
              && refVersion=='0.3'
              && length(p[?name=='url']) == `0`
              && (length(p[?name=='type']) == `0`
              || (length(p[?name=='type']) == `1`
              && refType=='artifact'))
        # channel 3: approved git repo + full commit SHA + EXACT path (a repo pins content only with url+sha+path)
        - name: gitOK
          variable:
            jmesPath: "resolver=='git' && refUrl=='<approved-git-repo>' && regex_match('^[0-9a-f]{40}$', refRevision) && refPath=='pipeline/gated-build.yaml'"
        # ...(validate.message omitted; see the full YAML below)
        deny:
          conditions:
            all:
              - key: "{{ clusterOK || hubOK || gitOK }}"
                operator: Equals
                value: false
```

The field choices for the three channels are not casual picks — every missing field is one more bypass path:

- **cluster** = `kind + namespace + name`. Checking namespace alone lets through any ungated Pipeline in that namespace.
- **hub** = `governed type + no request-level url + kind + catalog + name + exact version`. Checking only the resource tuple still misses backend overrides and type switching (see the warning below).
- **git** = `url + 40-char SHA + exact pathInRepo`. Checking only url + SHA lets through any other file in the same commit.

Two further structural design points:

- **Fail-closed**: the criterion is "deny when the union of approved channels is false", so newly appearing reference shapes (a new resolver, a misconfigured field, an unknown name) land on the deny side by default;
- **Mutable references are denied by default**: a hub reference with a defaulted / unapproved version, and git branch / tag, all belong to the third of the three tiers in [§2.1](#s2-1) — allowing them hands content control to anyone who can move that reference. If a team deliberately uses branch / tag so that template updates take effect automatically, first confirm the repository side has the corresponding permission controls (protected branches / tags, tightened write permissions), then add that reference to the allowlist — at that point the content constraint is borne by the repository, and this policy only locks "which branch / tag is referenced". An inline definition (`pipelineSpec`) has no `pipelineRef`, so all three channels are false and it is naturally denied (exception in [§4.1.3](#s4-1-3)).

**Omitting `type` on the hub channel has a platform precondition**: this document allows callers to omit `type` on the premise that `default-type` in `tekton-pipelines/hubresolver-config` is `artifact` ([§3.1](#s3-1) checklist item 2); when `type` is written explicitly, only `artifact` is allowed. Restrict modification of that ConfigMap with RBAC and monitor for drift; where the default value cannot be guaranteed, every reference should write `type: artifact` explicitly.

**This channel's trust root is the cluster-configured hub endpoint itself**: the warning below explains why the request-level `url` must be rejected — but once `url` is rejected, the conclusion "approved coordinates ⇒ governed content" **rests entirely on that one configured endpoint**. In other words, **an identity that can modify `hubresolver-config` does not need to bypass this policy**: the very same approved coordinates still pass the allowlist, yet what resolves is a definition on that identity's own hub — possibly without any gate at all — and the after-the-fact Audit of [§4.1.4](#s4-1-4) only sees it after resolution and cannot stop that run. So write permission on this piece of platform configuration must be controlled at the same level as `ClusterPolicy` ([§5.0](#s5-0)), and endpoint changes must leave an audit trail; where that cannot be done, do not treat the hub channel as a "content is trusted" channel — treat it only as "the source is registered".

:::warning Why the request-level url must be rejected — an easily overlooked, complete bypass

The `catalog` + `name` + `version` + `kind` tuple is only **"coordinates on some hub", not content**. The hub resolver accepts an extra `url` passed by the caller in `params`, and **it overrides the cluster-configured hub endpoint**. An attacker can therefore use **exactly the same coordinates** to fetch **their own Task / Pipeline** from **their own hub**: name, version, and catalog all check out, while the content is arbitrary. Miss this one condition and every "identity-locking" field check above is hollowed out.

Compare two TaskRuns differing only in a `url` parameter (both reference a nonexistent task, so neither actually executes), and look at which address the resolver really requested:

```text
# Without url: the cluster-configured endpoint is used
requested resource 'http://<configured-hub-endpoint>/api/v1/packages/tekton-task/<catalog>/no-such-task-xyz' not found on hub

# With url: http://127.0.0.1:1/definitely-not-a-hub -- the caller-supplied address is used verbatim
requesting resource from Hub: Get "http://127.0.0.1:1/definitely-not-a-hub/api/v1/packages/tekton-task/<catalog>/no-such-task-xyz":
dial tcp 127.0.0.1:1: connect: connection refused
```

`type` must be locked down for the same reason: switching to another type is switching to another set of endpoints and another set of governance assumptions.

:::

:::details Full policy YAML: pipeline-template-allowlist

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-template-allowlist
spec:
  background: false
  rules:
    - name: only-approved-templates
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: p
          variable:
            jmesPath: "request.object.spec.pipelineRef.params || `[]`"
        - name: refKind
          variable:
            jmesPath: "p[?name=='kind'].value | [0] || ''"
        - name: refName
          variable:
            jmesPath: "p[?name=='name'].value | [0] || ''"
        - name: refNamespace
          variable:
            jmesPath: "p[?name=='namespace'].value | [0] || ''"
        - name: refCatalog
          variable:
            jmesPath: "p[?name=='catalog'].value | [0] || ''"
        - name: refVersion
          variable:
            jmesPath: "p[?name=='version'].value | [0] || ''"
        - name: refType
          variable:
            jmesPath: "p[?name=='type'].value | [0] || ''"
        - name: refUrl
          variable:
            jmesPath: "p[?name=='url'].value | [0] || ''"
        - name: refRevision
          variable:
            jmesPath: "p[?name=='revision'].value | [0] || ''"
        - name: refPath
          variable:
            jmesPath: "p[?name=='pathInRepo'].value | [0] || ''"
        # channel 1: cluster resolver — FULL identity: kind + namespace + an approved name
        - name: clusterOK
          variable:
            jmesPath: "resolver=='cluster' && refKind=='pipeline' && refNamespace=='tekton-templates' && contains(['gated-build','official-gated-build'], refName)"
        # channel 2: governed Artifact Hub endpoint + complete resource tuple
        - name: hubOK
          variable:
            jmesPath: >-
              resolver=='hub'
              && refKind=='pipeline'
              && refCatalog=='catalog'
              && refName=='java-image-build-scan-deploy'
              && refVersion=='0.3'
              && length(p[?name=='url']) == `0`
              && (length(p[?name=='type']) == `0`
              || (length(p[?name=='type']) == `1`
              && refType=='artifact'))
        # channel 3: approved git repo + full commit SHA + EXACT path (a repo pins content only with url+sha+path)
        - name: gitOK
          variable:
            jmesPath: "resolver=='git' && refUrl=='<approved-git-repo>' && regex_match('^[0-9a-f]{40}$', refRevision) && refPath=='pipeline/gated-build.yaml'"
      validate:
        failureAction: Enforce
        message: >-
          only approved pipeline templates may run: cluster resolver
          (kind=pipeline, namespace=tekton-templates, an approved name),
          hub resolver (type omitted under the governed artifact default, or
          type=artifact; no request-level url; kind=pipeline;
          catalog/java-image-build-scan-deploy pinned to version 0.3), or the
          approved git repo pinned to a full commit SHA and exact path. Inline
          pipelineSpec, plain name refs, unpinned or unknown identities are rejected.
        deny:
          conditions:
            all:
              - key: "{{ clusterOK || hubOK || gitOK }}"
                operator: Equals
                value: false
```

:::

:::details Verification probes (13, --dry-run=server)

| Probe | Expected |
|---|---|
| Inline pipelineSpec | Deny |
| Bare `pipelineRef.name` | Deny |
| cluster: kind + ns + approved name | Allow |
| cluster: approved ns but an **unapproved name** | Deny |
| cluster resolver → another ns | Deny |
| hub: catalog + **exact version 0.3** | Allow |
| hub: approved tuple + a single explicit `type=artifact` | Allow |
| hub: same name but `version=9.9` (unapproved) | Deny |
| hub: approved tuple + request-level `url` | Deny |
| hub: approved tuple + `type=tekton` | Deny |
| git: approved repo + SHA + **exact path** | Allow |
| git: approved repo + SHA + **wrong path** | Deny |
| git: approved repo + `revision: main` (not a SHA) | Deny |

:::

#### 4.1.2 Governing definition resources (closed off via RBAC) {#s4-1-2}

Channel 1's strength comes from "in-cluster content is controlled", which presupposes that the definitions in `tekton-templates` **can only be changed by platform identities**. This is a job for **standard Kubernetes RBAC — no separate Kyverno policy needed**: grant `create` / `update` / `patch` / `delete` on `Pipeline` / `Task` in the `tekton-templates` namespace only to the platform administrators' Role / ClusterRole, and give ordinary project identities no write access. RBAC is the native control plane for "who may change the resources in a namespace"; redoing the same thing with a Kyverno `userInfo` allowlist is only weaker and more roundabout (and cannot stop `system:masters`), so this document does not carve out a separate policy for it.

**The platform-level switch (disabling inline definitions)**: Tekton itself provides the `disable-inline-spec` field in the `feature-flags` ConfigMap, which can disable inline definitions **cluster-wide**; Tekton's own validating webhook rejects them at admission with `must not set the field(s): ...`. It is a cluster-wide sledgehammer; when you need per-namespace differentiation, use the Kyverno allowlist in [§4.1.1](#s4-1-1).

The value is a comma-separated combination of `pipeline` / `pipelinerun` / `taskrun`, and the three values govern **three different inline locations** — they are not three strength tiers of the same thing:

| Value | Inline location it disables | Rejected fields |
| --- | --- | --- |
| `pipelinerun` | A PipelineRun inlining the whole pipeline directly | `spec.pipelineSpec` |
| `taskrun` | A TaskRun inlining a task definition directly | `spec.taskSpec` |
| `pipeline` | An **individual task's inline** definition inside a Pipeline (or inside any inline pipelineSpec) | `spec.tasks[].taskSpec` / `spec.tasks[].pipelineSpec` |

To seal off inlining completely, all three values must be present — with `pipelinerun` alone, a `PipelineRun.spec.pipelineRef` referencing an in-cluster Pipeline whose tasks are inline still goes through.

**How to configure it (on ACP you must change TektonConfig, not the ConfigMap directly)**: the `feature-flags` ConfigMap is rendered by tektoncd-operator from `TektonConfig.spec.pipeline`; a hand-edited ConfigMap is overwritten back on the next reconcile. Change it here:

```bash
# Run against the cluster where Tekton/the pipelines run -- NOT the global management cluster.
# TektonConfig is a cluster-scoped singleton named "config".
kubectl patch tektonconfig config --type merge \
  -p '{"spec":{"pipeline":{"disable-inline-spec":"pipeline,pipelinerun,taskrun"}}}'

# Verify the operator has propagated it into the ConfigMap the pipeline webhook
# actually reads. NOT a single read: the operator reconciles asynchronously (10-20s
# live-measured on the validation environment), and pasted in one go the read lands BEFORE the render
# and prints an empty line -- which looks exactly like "the switch did nothing".
: "${TEKTON_NS:=tekton-pipelines}"   # §3.1 sets it; this only covers a fresh shell
elapsed=0
# The exit condition compares against the value just written, not merely "non-empty":
# a cluster that ALREADY had a different value (say only `taskrun`) would satisfy a
# non-empty test on the very first read, and the propagation this loop exists to observe
# would never be observed at all.
until v=$(kubectl get configmap feature-flags -n "$TEKTON_NS" \
        -o jsonpath='{.data.disable-inline-spec}') \
      && [ "$v" = 'pipeline,pipelinerun,taskrun' ]; do
  if [ "$elapsed" -ge 60 ]; then
    echo "feature-flags still does not carry disable-inline-spec='pipeline,pipelinerun,taskrun'"
    echo "after ${elapsed}s (current value: '${v:-<empty>}') -- check the operator"
    break
  fi
  sleep 5; elapsed=$((elapsed + 5))
done
echo "disable-inline-spec now: '${v:-}'"
```

To **turn the switch off** (for example, to open up the inline exception of [§4.1.3](#s4-1-3)), set the value back to the empty string:

```bash
kubectl patch tektonconfig config --type merge \
  -p '{"spec":{"pipeline":{"disable-inline-spec":""}}}'

# The revert propagates on the same asynchronous terms as the enable did -- and the
# window cuts the OTHER way: until the ConfigMap has actually dropped the value,
# inline specs are still rejected cluster-wide. Expect the final line to print ''.
: "${TEKTON_NS:=tekton-pipelines}"
elapsed=0
until v=$(kubectl get configmap feature-flags -n "$TEKTON_NS" \
        -o jsonpath='{.data.disable-inline-spec}') && [ -z "$v" ]; do
  if [ "$elapsed" -ge 60 ]; then
    echo "feature-flags still carries disable-inline-spec after ${elapsed}s -- check the operator"
    break
  fi
  sleep 5; elapsed=$((elapsed + 5))
done
echo "disable-inline-spec now: '${v:-}'"
```

> If ACP's Tekton namespace is not `tekton-pipelines`, go by `TektonConfig.spec.targetNamespace`.

#### 4.1.3 Inline exceptions (forbidden by default, opened with care) {#s4-1-3}

**The default stance: no inlining in hard-gated namespaces** (the three channels of [§4.1.1](#s4-1-1) naturally reject inline definitions; when a cluster-wide blanket ban is needed, layer on `disable-inline-spec` from [§4.1.2](#s4-1-2)). Open an inline exception only where there is a genuine need — experimental namespaces, platform automation, and the like.

:::warning Precondition: this section is mutually exclusive with §4.1.2's disable-inline-spec — the two cannot be on at the same time

`disable-inline-spec` is **Tekton's own validating webhook**, and it is an admission webhook independent of Kyverno — **if either one denies, the request is denied**. Kyverno allowing an inline definition does not make Tekton allow it.

So for this section's inline exception to take effect, `TektonConfig.spec.pipeline.disable-inline-spec` **must not contain the corresponding value**: to open up PipelineRun inlining, remove `pipelinerun`; if the inline pipelineSpec is also meant to embed `taskSpec`, remove `pipeline` as well. The second patch in [§4.1.2](#s4-1-2) shows how to clear it.

In other words, the cluster-wide blanket ban ([§4.1.2](#s4-1-2)) and per-namespace exceptions (this section) are **two mutually exclusive approaches**: once you choose per-namespace differentiation, the cluster-wide switch must be turned off, and the entire closure falls on the Kyverno allowlist of [§4.1.1](#s4-1-1).

:::

:::warning When opening up inlining, checking only the task name is not enough

Requiring merely that "a task named `scan` exists in the inline definition" is an **insufficient** security check — an attacker can drop in a hollow no-op scanner, hang a never-true `when` on it so it gets skipped, set the gate switch to `false`, or order release before it / parallel to it.

To open up inlining safely, you must validate the complete contract set of [§2.3](#s2-3) (scanner identity, effective values of the gate switches, must-run, DAG dominance, finally safety). **Name presence alone constitutes no gate guarantee whatsoever.**

:::

The `inlineOK` snippet below is therefore only a **structural example** of how to add a restricted inline channel on top of [§4.1.1](#s4-1-1) — it must not be used as a security gate as-is:

```yaml
        # ILLUSTRATIVE ONLY — name presence is NOT a gate guarantee (see §2.3).
        # A real inline channel must also constrain identity/params/when/DAG/finally,
        # and should be restricted to a trusted userInfo or an experimental namespace.
        - name: inlineOK
          variable:
            jmesPath: "length(request.object.spec.pipelineSpec.tasks || `[]`) > `0` && length((request.object.spec.pipelineSpec.tasks || `[]`)[?name=='scan']) > `0`"
```

#### 4.1.4 Post-hoc introspection of referenced definitions (Audit defense in depth) {#s4-1-4}

- **What it governs**: whether a template the allowlist has already let through **has had its content broken** — for example, the gate task quietly swapped for a same-named task from another source.
- **Why it is hard**: a reference-style pipeline's definition content is invisible at CREATE (the blind window of [§2.1](#s2-1) observation point 2); the content lands in `status.pipelineSpec` only after the resolver finishes (observation point 3), and that observation point is **Audit-only** — Enforce wedges ([§2.2](#s2-2)).
- **How the policy is layered**: ① use `preconditions` to scope the rule precisely to one template profile (derived from the parent `PipelineRun.spec.pipelineRef`, not from runtime labels) → ② evaluate only once `status.pipelineSpec` has appeared → ③ pull the gate task's complete `taskRef` out of the resolved result and assert its identity field by field → ④ on mismatch, record a PolicyReport violation.
- **What it cannot govern**: it is **after the fact** — it cannot stop this run; nor can it detect "the gate is still there but skipped by `when` / an empty matrix" (that belongs to contract 3, handled by [§4.1.5](#s4-1-5)). **It reads `status.pipelineSpec`, so its evidential force stops at "who can write `pipelineruns/status`"** — an identity holding write access to that subresource can write in a "compliant-looking" `pipelineSpec` directly and have the drift audit deliver a compliant verdict (the same trust boundary as [§4.4.1](#s4-4-1)); past that point, this section retains only the ability to "observe what the request wrote" and is no longer evidence of gate enforcement.

**The key criterion** — what is locked is the complete source, not the name; and **count first, then read**:

```yaml
        - name: scanTaskCount
          variable:
            jmesPath: "length((request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'])"
            default: 0
        - name: scanIdentityValid
          variable:
            # The count is folded in here rather than added as a separate deny
            # condition: both deny blocks below use `all:`, so an extra condition
            # would relax the rule instead of tightening it.
            jmesPath: >-
              scanTaskCount == `1` &&
              scanResolver == 'cluster' && scanKind == 'task' &&
              scanName == 'policy-demo-scanner' &&
              scanNamespace == 'tekton-templates'
      # ...
      validate:
        deny:
          conditions:
            all:
              - key: "{{ scanIdentityValid }}"
                operator: Equals
                value: false
```

:::warning Gate shapes are per-profile — do not transplant them across templates

In this document's fixture template `gated-build`, the gate is **built into `scan` (the sonar scanner) itself** (self-gating, no separate gate task). The official template `java-image-build-scan-deploy` likewise builds its gates into `sonarqube-scanner` / `trivy-scanner`, but the task aliases and reference shapes differ. Transplanting one concrete task contract onto another template **produces false positives** — and combined with [§4.6.2](#s4-6-2), can even wrongly cancel legitimate runs.

Drift Audits must therefore be **configured per template profile**: derive resolver / kind / name / namespace from the parent `PipelineRun.spec.pipelineRef` — which `taskRunSpecs` cannot override — then assert that profile's own gate task contract. **Do not treat the `tekton.dev/pipeline` label as trusted identity** — Tekton v1.12 allows a PipelineRun to override child TaskRun labels via `spec.taskRunSpecs[].metadata.labels`; even though this rule handles the parent PipelineRun, use the API spec as the first-hand identity source consistently.

The example below applies only to the fixture profile (`gated-build`).

:::

:::details Full policy YAML: pipeline-resolved-definition-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-resolved-definition-audit
spec:
  background: false
  rules:
    - name: resolved-definition-must-keep-scanner
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: tplName
          variable:
            jmesPath: "request.object.spec.pipelineRef.name || ((request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: pipelineNamespace
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: pipelineSpecPresent
          variable:
            # Key presence avoids evaluating the rule before resolution. Tekton
            # rejects a valid Pipeline with no ordinary tasks, so an empty list
            # here is only a defensive malformed/synthetic-status boundary.
            jmesPath: "contains(keys(request.object.status || `{}`), 'pipelineSpec')"
        # status.pipelineSpec keeps the complete taskRef. Lock every identity field;
        # comparing only `name` would accept a same-name Task from another source.
        # status.pipelineSpec.tasks carries no x-kubernetes-list-type in the CRD,
        # so two tasks named scan survive admission and [0] would only see the
        # first. Count first, then read.
        - name: scanTaskCount
          variable:
            jmesPath: "length((request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'])"
            default: 0
        - name: scanTaskRef
          variable:
            jmesPath: "(request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'] | [0].taskRef || `{}`"
        - name: scanResolver
          variable:
            jmesPath: "scanTaskRef.resolver || ''"
            default: ""
        - name: scanKind
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: scanName
          variable:
            jmesPath: "scanTaskRef.name || ((scanTaskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: scanNamespace
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # The same "count first, then read" rule applies one level down: inside a
        # resolver taskRef, `params` is an ordinary list in status, so a decoy
        # entry in front of the real one would win every [0] above. (In `spec`
        # Tekton's own webhook rejects two params sharing a name -- status carries
        # no such guarantee, which is why only the status reads need this.)
        - name: scanRefParamsUnique
          variable:
            jmesPath: >-
              length((scanTaskRef.params || `[]`)[?name=='kind']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='name']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='namespace']) == `1`
        - name: scanIdentityValid
          variable:
            # The counts are folded in here rather than added as separate deny
            # conditions: the deny block below uses `all:`, so an extra condition
            # would relax the rule instead of tightening it.
            jmesPath: >-
              scanTaskCount == `1` && scanRefParamsUnique &&
              scanResolver == 'cluster' && scanKind == 'task' &&
              scanName == 'policy-demo-scanner' &&
              scanNamespace == 'tekton-templates'
        # HUB-RESOLVER GUIDANCE (this fixture uses cluster resolver -> policy-demo-scanner;
        # production usually references the catalog task via the hub resolver, e.g.
        #   taskRef:
        #     resolver: hub
        #     params:
        #       - name: catalog
        #         value: catalog
        #       - name: kind
        #         value: task
        #       - name: name
        #         value: sonarqube-scanner
        #       - name: version
        #         value: "0.7"
        # To govern the hub form, build scanIdentityValid from the complete tuple:
        # resolver=hub, catalog=catalog, kind=task, name=sonarqube-scanner,
        # version=0.7. Omitting catalog/kind/version would re-open source drift.
      preconditions:
        all:
          # Evaluate only after resolution materialized pipelineSpec. The gate
          # check itself is scanIdentityValid; do not infer it from task count.
          - key: "{{ pipelineSpecPresent }}"
            operator: Equals
            value: true
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          # PROFILE SCOPE: only the fixture template
          - key: "{{ tplName }}"
            operator: Equals
            value: gated-build
          - key: "{{ pipelineNamespace }}"
            operator: Equals
            value: tekton-templates
      validate:
        failureAction: Audit
        message: >-
          resolved gated-build must keep scan ->
          cluster/task/tekton-templates/policy-demo-scanner; got
          '{{ scanResolver }}/{{ scanKind }}/{{ scanNamespace }}/{{ scanName }}'.
        deny:
          conditions:
            all:
              - key: "{{ scanIdentityValid }}"
                operator: Equals
                value: false
```

The **HUB-RESOLVER GUIDANCE comment** in the policy matters: the fixture uses the cluster resolver, but in production the gate task usually references the catalog's `sonarqube-scanner` via the hub resolver. When switching to the hub shape, `scanIdentityValid` must be built from the **complete tuple** (`resolver=hub` + `catalog` + `kind` + `name` + `version`) — omitting any one of catalog / kind / version reopens the source-drift loophole.

:::

**Where this Audit sits**: the allowlist blocks "unapproved identities"; this Audit watches for "an approved template broken after approval" — in production the two are layered together. What it backstops is **the gate being removed from the definition** (contract 1 identity drift); a gate still present in `status.pipelineSpec` but carrying a `when` passes the presence check — that belongs to contract 3 "must-run", picked up by the next section.

**Verification essentials**: a normal `gated-build` run records pass; changing `policy-demo-scanner`'s namespace to `policy-poc` (same name, different source) still records **fail**, proving that the complete source is locked; the variant with `scan` removed records fail as well; other `pipelineRef` profiles record skip — no false positives. Note that PolicyReports aggregate with a lag of seconds to minutes ([§6.1.5](#s6-1-5)).

One more platform boundary worth flagging: **only a Pipeline that "has finally tasks while its ordinary tasks are empty" is rejected outright by Tekton admission** (`spec.tasks is empty but spec.finally has 1 tasks`), so such a definition cannot serve as a test case for "the resolver will resolve out a definition".

#### 4.1.5 Gate must-run audit (`skippedTasks`, contract 3 "must-run") {#s4-1-5}

- **What it governs**: the gate is still in the definition, but **this run skipped it** — a `when` expression evaluated to false, or a matrix parameter was an empty array.
- **Why it is hard**: a skipped gate **produces no TaskRun**, so contract 2's TaskRun-level validation is completely blind to absence (admission cannot block what never happened); [§4.1.4](#s4-1-4)'s presence Audit cannot see it either, because the gate genuinely is still in the definition.
- **How the policy is layered**: ① scope to the concrete template by profile, as before → ② pull the gate's skip entry out of `status.skippedTasks` → ③ decide whether its `reason` belongs to the set of **config-driven deliberate skips** → ④ on a hit, record a PolicyReport violation.
- **What it cannot govern**: still a subresource, so **Audit-only** — it cannot stop this run; nor does it cover "the gate ran but its result was ignored" (that is the template's responsibility under contracts 4/5). Likewise, it trusts `status.skippedTasks` to be written by the trusted Tekton controller — **an identity that can write `pipelineruns/status` can erase the deliberate-skip record, or substitute a legitimate cascade-skip reason**, leaving this section with no violation record at all (the same trust boundary as [§4.4.1](#s4-4-1)).

The crux of the criterion is **distinguishing two classes of skips**; the values of `skippedTasks[].reason` come from Tekton's `SkippingReason` enum:

- **Config-driven "deliberate skips" = the gate was opted out — a violation**: `When Expressions evaluated to false` (when-skip) and `Matrix Parameters have an empty array` (empty-matrix skip).
  Their downstream behavior is not the same: after `when=false`, a release that depends on the gate only through `runAfter` **keeps executing**; an empty matrix instead makes release cascade-record `Parent Tasks were skipped` and create no TaskRun. **Whether or not downstream happens to be caught by the cascade, a gate skipped by configuration must leave an Audit record.**
- **Cascade- / termination-driven "passive skips" = legitimate, not a violation**: `Parent Tasks were skipped` / `PipelineRun was stopping` / `PipelineRun was gracefully cancelled` / `PipelineRun was gracefully stopped` / `PipelineRun timeout has been reached` (plus the two Tasks / Finally timeout variants). These mean the pipeline was already ending in failure, cancellation, or timeout; the gate being skipped along with it is not a gate bypass.
- `Results were missing` sits between the two — the gate's input result was never produced, which is mostly a contract 4 data-binding problem; fold it into the violation set as needed.

**The key criterion** — only "deliberate skips" count as violations, and **count entries, do not take `[0]`**:

```yaml
        - name: gateSkipCount
          variable:
            jmesPath: "length((request.object.status.skippedTasks || `[]`)[?name=='scan'])"
            default: 0
        - name: gateSkipViolatingCount
          variable:
            jmesPath: >-
              length((request.object.status.skippedTasks || `[]`)[?name=='scan'
              && (reason=='When Expressions evaluated to false'
              || reason=='Matrix Parameters have an empty array')])
            default: 0
        preconditions:
          all:
            # ...profile-scope preconditions omitted here (full YAML below); the one
            # that matters for reading the deny block: only evaluate once the scanner
            # actually shows up in skippedTasks. A normal run (gate executed, no scan
            # entry) never reaches the deny conditions -- the rule skips.
            - key: "{{ gateSkipCount }}"
              operator: NotEquals
              value: 0
        deny:
          conditions:
            any:
              # Deliberate, config-driven skip = the gate was opted out. Downstream
              # behavior differs by skip type; cascade/terminal reasons are excluded.
              # Counted, not [0]-indexed: a decoy scan entry carrying a cascade reason
              # placed ahead of the real one would otherwise hide the opt-out.
              - key: "{{ gateSkipViolatingCount }}"
                operator: NotEquals
                value: 0
              # more than one scan entry is itself malformed -> fail closed. With the
              # precondition above holding count >= 1, NotEquals 1 here means ">= 2":
              # the controller writes at most one skip entry per task, and skippedTasks
              # is an atomic list (no dedupe key), so duplicates = hand-crafted status.
              - key: "{{ gateSkipCount }}"
                operator: NotEquals
                value: 1
```

A more robust, strengthened criterion is "the gate was deliberately skipped **and** a downstream release task actually executed" (add an existence check on release's `childReferences`, per the template's known DAG). This example uses the former, which is already enough to catch the opt-out.

:::warning As in §4.1.4: the gate task name is per-profile

The gate task here is the fixture template's `scan` (the same-name note in [§4.1.4](#s4-1-4) applies as well). Other templates alias their gate tasks differently, and applying this policy verbatim would **miss violations** — give each template profile its own gate task name, and derive the profile precisely from the parent `PipelineRun.spec.pipelineRef`; do not substitute runtime labels that user input can influence for API-spec identity.

:::

:::details Full policy YAML: pipeline-gate-must-execute-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-gate-must-execute-audit
spec:
  background: false
  rules:
    - name: gate-must-not-be-skipped-by-config
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: tplName
          variable:
            jmesPath: "request.object.spec.pipelineRef.name || ((request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: pipelineNamespace
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # the scanner's skip entry for THIS profile (scan is the fixture gate task —
        # per-profile, see warning above). Kyverno treats a nil context result as an
        # evaluation error, so provide an explicit empty object for the normal case.
        # skippedTasks is x-kubernetes-list-type: atomic -- whole-list replace, NOT
        # dedupe-by-key -- so two entries named scan survive admission. Decide on the
        # counts, and keep gateSkip only for the message.
        - name: gateSkipCount
          variable:
            jmesPath: "length((request.object.status.skippedTasks || `[]`)[?name=='scan'])"
            default: 0
        - name: gateSkipViolatingCount
          variable:
            jmesPath: >-
              length((request.object.status.skippedTasks || `[]`)[?name=='scan'
              && (reason=='When Expressions evaluated to false'
              || reason=='Matrix Parameters have an empty array')])
            default: 0
        - name: gateSkip
          variable:
            jmesPath: "(request.object.status.skippedTasks || `[]`)[?name=='scan'] | [0]"
            default:
              name: ""
              reason: ""
        - name: gateSkipReason
          variable:
            jmesPath: "gateSkip.reason || ''"
            default: ""
      preconditions:
        all:
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          # PROFILE SCOPE: only the fixture template
          - key: "{{ tplName }}"
            operator: Equals
            value: gated-build
          - key: "{{ pipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          # only evaluate once the scanner actually shows up in skippedTasks
          - key: "{{ gateSkipCount }}"
            operator: NotEquals
            value: 0
      validate:
        failureAction: Audit
        message: >-
          mandatory scanner task `scan` was opted out this run
          (skippedTasks reason: {{ gateSkipReason }}); downstream release tasks
          may run ungated. Config-driven skips (when / empty-matrix) are
          violations; cascade skips (stopping / cancelled / timeout) are not.
        deny:
          conditions:
            any:
              # Deliberate, config-driven skip = the gate was opted out. Downstream
              # behavior differs by skip type; cascade/terminal reasons are excluded.
              # Counted, not [0]-indexed: a decoy scan entry carrying a cascade reason
              # placed ahead of the real one would otherwise hide the opt-out.
              - key: "{{ gateSkipViolatingCount }}"
                operator: NotEquals
                value: 0
              # more than one scan entry is itself malformed -> fail closed (the
              # precondition holds count >= 1, so NotEquals 1 here means ">= 2")
              - key: "{{ gateSkipCount }}"
                operator: NotEquals
                value: 1
```

:::

**How to reproduce "the gate was skipped"** (on the cluster running Tekton and Kyverno): the `gated-build` from [§3.3](#s3-3) carries a `demoSkipScan` parameter; set it to `"true"` and `scan` is skipped by `when` — exactly the shape this section is built to catch. Save as `skip-gate-probe.yaml`:

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: doc-gate-skipped
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: demoSkipScan
      value: "true"
```

```bash
kubectl create -f skip-gate-probe.yaml
kubectl wait -n policy-poc pipelinerun/doc-gate-skipped \
  --for=condition=Succeeded --timeout=5m

# 1) The skip itself: expect one entry, name=scan, reason "When Expressions evaluated to false"
kubectl get pipelinerun -n policy-poc doc-gate-skipped \
  -o jsonpath='{.status.skippedTasks}{"\n"}'
# 2) release ran anyway -- that is the point: the gate was opted out, not the pipeline
kubectl get pipelinerun -n policy-poc doc-gate-skipped -o json \
  | jq -r '[.status.childReferences[]?.pipelineTaskName] | join(",")'
# 3) The Audit verdict (wait for the report to catch up, §4.4.2's note applies here too)
kubectl get policyreport -n policy-poc -o json | jq -r '
  .items[] | select(.scope.name=="doc-gate-skipped") | .results[]
  | select(.policy=="pipeline-gate-must-execute-audit") | "\(.rule) \(.result)"'
```

Expected: command 1 gives `scan` + `When Expressions evaluated to false`; command 2's output contains **no** `scan` but **does** contain `release`; command 3 shows `fail`. **The first read of command 3 will most likely say `skip`** — the report row is written at the first status UPDATE, when the run has not yet reached its terminal state; **re-read that PolicyReport result** until it **turns from `skip` into a terminal result** before drawing a conclusion (reading only once, two identical walkthroughs can come back with `fail` and `skip` respectively). **Run a plain `demo-run-pass` as the negative control** — its `skippedTasks` is empty, and this rule records `skip` for it (not pass: the precondition `gateSkipCount != 0` does not hold, so the rule never evaluates at all). If no `fail` shows up, first work through [§6.1.2](#s6-1-2) — is the policy Ready, do the four profile fields match — before doubting the criterion.

**Division of labor with [§4.1.4](#s4-1-4)**: [§4.1.4](#s4-1-4) catches "the gate was removed" (definition drift); [§4.1.5](#s4-1-5) catches "the gate was skipped" (runtime opt-out) — only the two Audits together cover the full after-the-fact detection surface of contract 3 "must-run". In production the two are layered, complementing the parameter contracts of [§4.2](#s4-2) (against gate parameters being switched off) and the allowlist of [§4.1.1](#s4-1-1) (against template swapping).

#### Cleanup (§4.1)

Per the two rules of [§4.0.4](#s4-0-4): delete the three cluster-scoped policies by name (glance at their `creationTimestamp` before deleting); the runtime objects all live in self-created namespaces and are reclaimed with the namespace cascade — but `PipelineRun/doc-gate-skipped` is better deleted right now: when the next section is rerun under "each section standalone", `kubectl get policyreport` will show an extra `doc-gate-skipped` row belonging to the previous section, which is easily misread as the current section's verdict.

```bash
# §4.0.4's look-before-delete: cluster-scoped, so one glance at when they were created.
kubectl get clusterpolicy pipeline-template-allowlist \
  pipeline-resolved-definition-audit pipeline-gate-must-execute-audit \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'
kubectl delete clusterpolicy pipeline-template-allowlist \
  pipeline-resolved-definition-audit pipeline-gate-must-execute-audit
# Its TaskRuns / Pods cascade via ownerReference, and the PolicyReport rows go with it.
kubectl delete pipelinerun -n policy-poc doc-gate-skipped --ignore-not-found
```
### 4.2 Parameter Constraints: Validating Effective Values (Contract 2) {#s4-2}

**The general contract**: the **actual effective values** of gate-related parameters (switches, thresholds, target branches) must be compliant. Two paths:

- **Main path (the observation point where parameters are already expanded; universal)**: validate at **gate TaskRun CREATE**. At that moment `spec.params` already carries the expanded, effective values — `$(params.x)` has been resolved, and even references to upstream task results have been resolved into concrete values. The identity chain must start from the API-server-provided `request.userInfo` (the creator is the Tekton controller SA) and the controller `ownerReference`, use an `apiCall` to read the parent PipelineRun, check the owner UID and the parent's `spec.pipelineRef`, then lock down resolver, kind, catalog / name / version / namespace from the current `spec.taskRef`. This path puts **zero migration obligations** on template authors — it does not require surfacing task-level parameters at the PipelineRun level. Which profile, which Task it resolves to, and which parameters to validate **must be configured per template version** (see the version matrix in [§3.2](#s3-2)).
- **Auxiliary path (early blocking when the template already exposes the parameters)**: when an official template puts the critical switches in PipelineRun-level parameters, you can block right at **PipelineRun CREATE** — not a single task runs, and the user gets feedback on the spot. Better experience, but it depends on the template's parameter design and serves only as an optional optimization. There is also a trap: whether a same-named PipelineRun-level parameter **is actually wired to the gate** is decided by the template's wiring — when it is not, this layer of validation is a sham (the value is compliant, yet the gate never uses it), which is exactly why the main path judges by the expanded, effective values.

**Map of this section** (the largest section in the document — do not read it straight through):

- **[§4.2.1](#s4-2-1) main path** — the gate parameter contract, denying at the observation point where parameters are already expanded. **Read it first**; the later subsections are either another response shape of the same thing or complementary surfaces.
- **[§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3)** — two more response shapes for **the same criterion**: when finally must still run after blocking, use cancellation instead of deny (these two plus the cancellations of [§4.6](#s4-6) make four paths in total; the master table is in the [§4.6](#s4-6) introduction).
- **[§4.2.4](#s4-2-4)** — the protected-branch gate contract (a real `sonarqube-scanner` profile); it governs "analysis of protected branches must keep the gate strict"; PR / feature builds carry no branch admission constraint.
- **[§4.2.5](#s4-2-5) auxiliary path** — early blocking when official templates already expose the switches at the PipelineRun level: **the longest subsection, but not a must-install** — you only need it if you use that batch of official templates and want users to get feedback on the spot.
- **[§4.2.6](#s4-2-6)** — mutate injecting defaults: not blocking, but filling in what is absent.

:::warning Two disciplines — violate either one and the whole section can be bypassed

**① Never trust a child TaskRun's `tekton.dev/pipeline` / `pipelineTask` / `pipelineRun` labels.** Tekton lets a PipelineRun override these controller labels via `spec.taskRunSpecs[].metadata.labels`, which means these "identities" can be forged by the caller. Identity must be derived from the controller `ownerReference` + the live parent run + `spec.taskRef`.

**② Parameter absence must fail closed.** A parameter the pipeline did not bind **does not appear** in the TaskRun's `spec.params` (the Task definition's default takes effect). Only when `spec.taskRef` is already locked to an "exact Task version whose defaults are trusted" may the policy map absence to that trusted default; with identity unlocked or defaults unknown, absence is always a violation.

Also note: a gate skipped by `when` produces no TaskRun at all (contract 3), so this path is blind to an "absent gate" — that is picked up by the `skippedTasks` Audit of [§4.1.5](#s4-1-5).

:::

#### 4.2.1 The gate parameter contract (main path) {#s4-2-1}

- **What it governs**: **the gate switches must not be turned off** — in `gated-build`, `scan`'s `enableScanQualityGate` / `enableAnalyzeQualityGate` must be exactly the string `"true"`.
- **Why it is hard**: at PipelineRun CREATE you can only see what the caller **explicitly wrote**, not the **final effective values** after template defaults expand ([§2.1](#s2-1) observation point 2); the moment the effective values become visible is **the scanner's own TaskRun CREATE**. But that moment has its own trap — labels like `tekton.dev/pipelineTask` on the TaskRun can be overridden and forged through the parent run's `taskRunSpecs`, so **you must not use labels to decide "is this the gate task"**.
- **How the policy is layered**: ① first prove provenance — the creator must be the Tekton controller SA, carrying a controller ownerReference, and the **live** parent run is looked up by owner to check the UID; ② then lock identity — the parent run's `pipelineRef` must be exactly `tekton-templates/gated-build`, and the current `taskRef` must be exactly the trusted scanner; ③ only then judge the parameter values, treating **"absent" and "explicit empty string" separately** — only absence inherits the trusted Task's default `"true"`; an explicit `false` / empty string / `TRUE` / `1` all fail the bar.
- **What it cannot cover**: deny means the gate TaskRun simply cannot be created; the parent run's terminal state is `CreateRunFailed` and **finally does not run**; if finally must still run, switch to [§4.2.2](#s4-2-2) (cancel the parent run) or [§4.2.3](#s4-2-3) (mutate the gate TaskRun itself into a cancelled state).

**The key criterion** — establish the identity chain first, then judge values; keep "absent" apart from "explicit empty string" with a dedicated presence variable:

```yaml
        # Only an absent param inherits the trusted Task default "true";
        # an explicit empty string is NOT absence
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          # Identity chain: the parent run referenced by ownerReferences must be the
          # same live object
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          # Profile scope: both the parent template and the current Task must match
          # exactly (remaining identity fields are in the full YAML)
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
      validate:
        deny:
          conditions:
            all:
              - key: "{{ gateInvalid }}"
                operator: Equals
                value: true
```

:::warning When context.apiCall cannot reach its target it fails closed — and the error points at the APICall, not at your criterion

This rule uses `apiCall` to look up the parent PipelineRun by ownerReference and check its UID. **A failed lookup (parent object missing, API server unreachable, insufficient permissions) does not degrade into a "skip" — the entire rule errors and the request is denied.** Submitting, as the Tekton controller SA, a TaskRun whose ownerReference points at a nonexistent parent run gives:

```
failed to evaluate preconditions: failed to substitute variables in condition value:
failed to resolve parentRun.metadata.uid at path : failed to fetch data for APICall:
failed to GET resource with raw url
```

Know both consequences: ① **the direction is safe** — if the lookup cannot be completed, nothing is let through; an ownerless gate TaskRun is never silently admitted; ② **do not be misled by the message while troubleshooting** — it reports an `APICall` failure, not "parameter non-compliant"; on seeing it, first check API server reachability and Kyverno's read permissions rather than changing parameters. When the parent run has already been deleted (for example, midway through a cascading cleanup), this rule makes the leftover child TaskRun impossible to create — that is the expected behavior.

:::

**Expected shape**: run `gated-build` with `enableAnalyzeQualityGate: "false"` — the controller's attempt to create the `scan` TaskRun is rejected at admission (**a single attempt, no retry**); the PipelineRun promptly reaches the terminal state **`CreateRunFailed`** (submission to terminal state is typically on the order of tens of seconds, depending on the controller's scheduling and retry cadence — do not treat it as a fixed value), with the condition message carrying the **full policy message** (policy name / rule name / custom text with the actual values); `release` is never created and finally does not run either (first row of the [§2.3](#s2-3) comparison table). An explicit `false`, an explicit empty string, and the unrecognized value `TRUE` are all blocked; only runs where both switches are absent (inheriting the trusted default `"true"`) or both explicitly `"true"` are allowed through.

:::details Full policy YAML: gate-param-contract

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: gate-param-contract
spec:
  background: false
  rules:
    - name: scan-quality-gate-must-stay-on
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
                - policy-exempt-runs
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        # taskRunSpecs metadata can override Tekton's child labels. Derive the
        # parent from the controller ownerReference and verify the live UID.
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: parentRun
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "parentRun.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "parentRun.spec.pipelineRef.name || ((parentRun.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Task identity comes from spec.taskRef, never from user-overridable labels.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # This exact Task identity is trusted and defaults both switches to "true".
        # Track presence separately so explicit "" is not mistaken for absence.
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        # Absence uses the pinned Task default. Any explicit value must equal true;
        # false, empty, TRUE and 1 are all invalid.
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
      validate:
        failureAction: Enforce
        message: "every policy-demo-scanner child of gated-build must keep both quality-gate switches exactly equal to 'true' (got enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}')."
        deny:
          conditions:
            all:
              - key: "{{ gateInvalid }}"
                operator: Equals
                value: true
```

:::

This example focuses on the most critical "switches must not be turned off". The scanner's gate **thresholds / rules** (`analyzeQualityGateRules`) can be covered the same way with one more rule validating a baseline (for example, it must contain a coverage rule with a threshold ≥ 50), written after the numeric fail-closed pattern of [§4.4.2](#s4-4-2) (bound the value to 0–100 with a regex first, and only `to_number` once boundedness is confirmed, steering clear of the overflow and coercion traps of [§6.1.7](#s6-1-7)). Also, parameter expansion covers more than `$(params.x)` — **upstream result references get resolved too**, so "a result value bound as a downstream parameter" can equally be validated by admission at the downstream TaskRun's CREATE.

#### 4.2.2 Cancel instead of deny: when finally must still run after the gate blocks (RunFinally) {#s4-2-2}

- **What it governs**: **exactly the same thing** as [§4.2.1](#s4-2-1) (the gate switches must not be turned off), but with a different response — do not reject the creation; cancel the parent PipelineRun so finally runs as usual.
- **Why it is hard**: the deny of [§4.2.1](#s4-2-1) is a hard block, at the cost that the `scan` TaskRun cannot be created → the DAG never finishes → **finally does not run** (mechanism explained in [§2.3](#s2-3)). Teams that rely on finally for notifications / resource cleanup hit "finally silently not running when the gate blocks".
- **How the policy is layered**: ① the detection point is identical to [§4.2.1](#s4-2-1) (scan TaskRun CREATE + the same identity chain) → ② on a hit, do not deny — use **mutate-existing** to patch **the same parent PipelineRun** the owner points at → ③ write `spec.status: CancelledRunFinally` (the semantics of "cancel the DAG, still run finally") + a reason-bearing annotation.
- **What it cannot cover**: mutate-existing is **asynchronous** and has a race window (warning below); and the condition in the cancelled shape only carries the generic `was cancelled` text — it does not pass the full policy message through the way deny does — so the reason must be written into the annotation yourself.

**This is one of several cancellation paths in this document** (two more share the mechanism with different criteria: results below the bar in [§4.6.1](#s4-6-1), definition drift in [§4.6.2](#s4-6-2)); the master table of "when it is detected, what gets touched, synchronous or asynchronous, where to collect the evidence" is in the [§4.6](#s4-6) introduction — **that table is the authoritative list of the cancellation paths**.

:::warning Three prerequisites and boundaries — read before installing

**① RBAC prerequisite**: mutate-existing needs the background-controller to hold update permission on `pipelineruns`, and **Kyverno validates that RBAC at policy-creation time; without it the policy fails to install outright** — the ClusterRole, the grant-before-install ordering with its propagation check, and sample errors are all in the [§4.6](#s4-6) introduction (shared by the four cancellation paths; do not duplicate the configuration here). The one thing to remember specifically in this section: **the create-time authorization check does not evaluate `{{ request.namespace }}`** — when `mutate.targets[].namespace` is written as a variable, Kyverno only accepts **cluster-wide** update permission; so the shortcut of "governing a single fixed namespace with a namespaced Role" requires writing `targets[].namespace` as a **literal** as well (the listing in this section's body does exactly that; the `targets` comment shows the cross-namespace variant) — adding only the Role is not enough, and the error looks identical to "not authorized at all". **Do not conflate the two things**: `match.resources.namespaces` decides **which requests trigger the rule**; `targets[].namespace` decides **which namespace's object gets patched**; to "install once but only take effect in some namespaces", narrow the former (or use a `namespaceSelector`).

**①b Installing this section's policy makes Kyverno print one irrelevant warning** `Warning: You are matching on status but not including the status subresource...` — it is triggered by the `spec.status` in the patch (Tekton's cancellation field); this rule matches TaskRun **CREATE** and never touches the status subresource; ignore it.

**② The race**: mutate-existing is executed **asynchronously** by the background controller — by then the `scan` TaskRun has already been admitted and may even have started running; the cancellation patch lands a moment later. If the scanner finishes quickly (for example, with the gate off it no longer fails itself and goes straight to Succeeded), the release behind it may get scheduled before the cancellation lands. **This is not "zero-race hard blocking"; it is "cancel as soon as detected"** — for zero race, use the deny of [§4.2.1](#s4-2-1) or the admission mutate of [§4.2.3](#s4-2-3).

**③ Anti-forgery DoS**: because `taskRunSpecs[].metadata.labels` can override a child TaskRun's `tekton.dev/pipelineRun`, "forbidding bare TaskRuns" ([§4.5.4](#s4-5-4)) alone is not enough — otherwise an attacker could point the label at someone else's Pending run and have the policy cancel it on their behalf. This policy ignores that label entirely: it only accepts TaskRuns created by the Tekton controller SA, reads the controller ownerReference, `apiCall`s back to the parent run and checks the UID, then judges the profile from the parent's `spec.pipelineRef` and the current `spec.taskRef`. An attack run with forged labels can only cancel itself; the victim run it points at is unaffected.

:::

**The key criterion** — on a hit, the patch targets the parent run the owner points at, with `targets` double-locked by name + uid:

```yaml
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: policy-poc
        patchStrategicMerge:
          metadata:
            annotations:
              policy.alauda.io/cancel-reason: >-
                scan quality-gate switches were not exactly true
                (enableScanQualityGate='{{ scanQG }}',
                enableAnalyzeQualityGate='{{ analyzeQG }}'); cancelled in
                RunFinally mode so finally tasks still run
          spec:
            status: CancelledRunFinally
```

:::details Prerequisite RBAC: namespaced Role + RoleBinding

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: kyverno-background-pipelineruns
  namespace: policy-poc
rules:
  - apiGroups:
      - tekton.dev
    resources:
      - pipelineruns
    verbs:
      - get
      - list
      - watch
      - update
      - patch
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: kyverno-background-pipelineruns
  namespace: policy-poc
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: kyverno-background-pipelineruns
subjects:
  - kind: ServiceAccount
    name: kyverno-background-controller
    namespace: kyverno
```

:::

:::details Full policy YAML: gate-param-cancel-existing

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: gate-param-cancel-existing
spec:
  background: false
  rules:
    - name: cancel-parent-on-invalid-scan-gate
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        # Child labels are user-overridable through taskRunSpecs metadata.
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: parentRun
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "parentRun.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "parentRun.spec.pipelineRef.name || ((parentRun.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(parentRun.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Materialized switches on the scan TaskRun. The pinned Task defaults to true,
        # but explicit empty values are not absence and must remain invalid.
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ parentRun.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: gated-build-with-prep
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ parentName }}"
            operator: NotEquals
            value: ""
          # Fire only when either switch is not exactly the trusted value true.
          - key: "{{ gateInvalid }}"
            operator: Equals
            value: true
      mutate:
        # mutate-existing: patch a DIFFERENT resource (the parent PipelineRun) in
        # response to this TaskRun CREATE event. A literal namespace keeps the
        # create-time auth check satisfied by a namespaced Role; switch it to
        # "{{ request.namespace }}" plus the aggregated ClusterRole to govern
        # every namespace with one policy -- see the discussion above.
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: policy-poc
        patchStrategicMerge:
          metadata:
            annotations:
              policy.alauda.io/cancel-reason: >-
                scan quality-gate switches were not exactly true
                (enableScanQualityGate='{{ scanQG }}',
                enableAnalyzeQualityGate='{{ analyzeQG }}'); cancelled in
                RunFinally mode so finally tasks still run
          spec:
            status: CancelledRunFinally
```

:::

:::details Positive and negative PipelineRuns for verification

```yaml
# Negative case: prep completes, then the invalid scan switches trigger
# CancelledRunFinally. release is skipped and notify still runs.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: gate-cancel-invalid
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build-with-prep
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
    - name: enableScanQualityGate
      value: "false"
    - name: enableAnalyzeQualityGate
      value: "false"
    - name: demoDelaySeconds
      value: "30"
---
# Positive case: the same profile keeps both trusted defaults and completes.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: gate-cancel-compliant
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build-with-prep
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
    - name: demoDelaySeconds
      value: "1"
```

:::

**Expected shape**: in the violating run (explicit `false` or an explicit empty string), `prep` succeeds, `scan` is cancelled, `release` is skipped with `PipelineRun was stopping`, the parent run carries `spec.status=CancelledRunFinally` with terminal state `Cancelled`, the `cancel-reason` annotation is present, and **the finally `notify` succeeds normally**; in the compliant run, `prep / scan / release / notify` all succeed and the parent run is `Succeeded`.

Note this only proves the trigger wiring and the finally behavior are correct; **it does not eliminate the race window**. There is also one cost-related boundary: a TaskRun may already be marked `TaskRunCancelled` while its Pod, on the concurrent creation path, has already started and keeps running until the process exits — so this is not a strong "kill the computation immediately" guarantee; in cost-sensitive scenarios, still set a reasonable timeout on the task and verify against the actual Pod termination behavior.

**Why not simply cancel at PipelineRun CREATE?** There are really two questions here. **First, can you even decide at CREATE**: at that moment only the parameters explicitly written into the PipelineRun are visible (that part belongs to the early-deny auxiliary path; [§4.2.5](#s4-2-5) is the real-template instance); the **effective values** this section governs — an absent parameter whose inherited default has drifted, or been overridden — only become visible when the controller creates the `scan` TaskRun; at CREATE there is nothing to judge. **Second, would cancellation even be the right choice**: no — deny would be; the value of cancellation lies **precisely in real work having already run before the gate**, so that finally has something to notify about / clean up; at CREATE nothing has run, and an "empty finally" is just a more roundabout deny. In the [§3.3](#s3-3) baseline template `gated-build`, `scan` is the **first task** — squarely on the "nothing has run" side — so the synchronous deny of [§4.2.1](#s4-2-1) is cleaner there; this section deliberately uses `gated-build-with-prep`, letting `prep` complete first and then triggering the cancellation at scan CREATE. The selection rule is therefore simple: **scanner is the first task → use deny; real work needing finally wrap-up precedes the scanner → only then use cancellation.**

| Dimension | deny ([§4.2.1](#s4-2-1)) | Cancel · mutate-existing @ scan TaskRun ([§4.2.2](#s4-2-2)) |
|---|---|---|
| Run terminal state | `CreateRunFailed` | `Cancelled` |
| Tasks before the scanner (e.g. `build` / `test`) | Whatever already ran, ran | Whatever already ran, ran (completed before the scanner) |
| **finally** | **Does not run** | **Runs** (notification / cleanup for the real tasks that already ran) |
| Gate-reason visibility | Full policy message in the condition | Generic text + `cancel-reason` annotation |
| Requires gate switches at the PipelineRun level? | No | **No** (reads the expanded, effective values on the scan TaskRun) |
| Synchronous / race | Synchronous hard block | Asynchronous, with a race window |
| Prerequisites | None | background-controller `pipelineruns` update RBAC |
| Fits | Scanner is the first task, no finally wrap-up needed, you want an immediate hard block + full reason | Real work precedes the scanner and finally must notify / clean up; you accept "cancellation slightly later than detection" |

#### 4.2.3 Admission-mutate cancellation: the synchronous alternative to deny (cancelling the gate TaskRun itself) {#s4-2-3}

- **What it governs**: still the same thing (the gate switches must not be turned off), via a third response form — **do not reject the gate TaskRun's creation; mutate it into "already cancelled" within the same admission pass**.
- **Why it is hard**: deny makes this DAG node **not exist at all** — the DAG never reaches done and finally is starved; [§4.2.2](#s4-2-2) lets finally run, but at the price of an asynchronous race and extra RBAC. Neither is ideal.
- **How the policy is layered**: ① likewise lock the Tekton controller as the creator and the Task's resolver coordinates → ② on hitting a non-compliant switch, perform an admission `mutate` → ③ write `spec.status: TaskRunCancelled` and `spec.statusMessage: <reason>` onto that TaskRun.
- **The only synchronous one among this document's cancellation paths** — the others ([§4.2.2](#s4-2-2) cancelling the parent run, [§4.6.1](#s4-6-1) results below the bar, [§4.6.2](#s4-6-2) definition drift) all act asynchronously after the event; the full table is in the [§4.6](#s4-6) introduction.
- **What it cannot govern**: it **produces no PolicyReport violation record** (warning below); nor does it **apply to the bare-TaskRun entry point** — all three response forms in this section ([§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2) / [§4.2.3](#s4-2-3)) use `subjects` to match only child TaskRuns created by the Tekton controller, and **none of them can stop a bare TaskRun a user creates by hand**; that path is owned solely by the [§4.5.4](#s4-5-4) entry closure.

What makes it work is Tekton's state machine: mutating into cancellation lets the node **exist in a failed posture** — the TaskRun reconciler decides it is already cancelled before ever building a Pod and wraps it up directly; the node reaches the done state, the DAG completes, and finally is scheduled as usual. The governance effect equals deny (the gate's container never runs for a single second), but the state machine stays intact:

- **No container starts**: the cancellation verdict happens at the very front of reconcile — `podName` stays empty, no Pod is ever created, so no image gets pulled;
- **No retries consumed**: Tekton's retry branch explicitly excludes cancelled TaskRuns — cleaner even than a gate task's `exit 1` (which does consume `retries`);
- **The reason is visible**: `statusMessage` is spliced verbatim into the TaskRun's failure condition — `tkn` and the console show it directly, with no dependency on whatever HTTP code the webhook returns;
- **What you must adapt**: the parent run's terminal reason is `Cancelled`, **not** `Failed` — alerts / dashboards filtering on `Failed` must add `Cancelled`.

**The key criterion** — on a hit, write two fields; the cancellation reason travels with the object:

```yaml
      mutate:
        patchStrategicMerge:
          metadata:
            annotations:
              # Machine-readable trail: the TaskRun condition carries the human
              # message, this annotation carries the policy verdict.
              policy.alauda.io/cancel-reason: "a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); an ABSENT switch is not a violation -- it inherits the trusted Task default"
          spec:
            status: TaskRunCancelled
            statusMessage: "Cancelled by policy gate-param-mutate-to-cancel: a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); the values above show which."
```

:::warning Audit blind spot: mutate rules produce no PolicyReport violation records

In the PolicyReport, the cancelled TaskRun shows up as `result=skip` with the message `no patches applied` (by the time the reports-controller re-evaluates it, the object is already in the target state) — **not `fail`**. So "which runs were cancelled by policy" can only be traced through the TaskRun's `statusMessage` / annotation, or booked by a separate [§4.4](#s4-4) Audit rule set up for exactly that.

When you install this policy, Kyverno prints `You are matching on status but not including the status subresource in the policy` (because the patch touches `spec.status`) — a heuristic hint; it does not affect enforcement.

**Do not treat it as the defense for the bare-TaskRun entry point**: this rule's `subjects` matches only child TaskRuns created by the Tekton controller; a bare TaskRun a user creates by hand **never enters this rule** — closing the bare entry point is [§4.5.4](#s4-5-4)'s job.

Even if you removed `subjects` so that it also matched user-created TaskRuns, you should not use it that way: mutating into cancellation raises **no synchronous error** — the creator just gets an object that was "created successfully yet cancelled an instant later", and the troubleshooting cost far exceeds a single deny message. The bare entry point wants a deny, not a silent cancellation.

:::

:::details Full policy YAML: gate-param-mutate-to-cancel

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: gate-param-mutate-to-cancel
spec:
  # Admission-time mutation only. The subjects selector below is not allowed in
  # background mode, and no background scanning is needed for this response.
  background: false
  rules:
    - name: cancel-scan-taskrun-on-invalid-gate
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
            # Only TaskRuns materialized by the Tekton controller are in scope.
            # A bare TaskRun created by a user never reaches this rule -- closing that
            # entry point is §4.5.4's job, not this policy's.
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        # Identify the resolved Task by its resolver coordinates, never by child
        # labels: a PipelineRun can override those through taskRunSpecs.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Absence inherits the trusted Task default ("true"); an explicit empty
        # string is not absence and must stay invalid.
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        # Exact string comparison, computed in JMESPath so no Kyverno operator
        # coercion can touch it. BOTH switches are covered here, exactly as in §4.2.1:
        # this section is one of three interchangeable RESPONSES to the same criterion,
        # so it must judge the same criterion -- covering only one switch would let a run
        # that disables the OTHER one through, and the response-form table would be
        # comparing options that do not govern the same thing.
        - name: gateInvalid
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          # Do NOT write `key: {{ scanQG }} / operator: NotEquals / value: "true"`.
          # Kyverno operators coerce numeric-looking strings, so a forged value such
          # as "1" makes NotEquals return false and the cancellation never fires --
          # a fail-open. Compute the comparison as a JMESPath boolean instead (§6.1.7).
          # Absence is NOT a violation: an absent switch inherits the trusted Task
          # default "true" (§2.1 observation 4), so only an explicit non-true value
          # reaches this condition -- that is what the two `*Present` guards inside
          # gateInvalid are for.
          - key: "{{ gateInvalid }}"
            operator: Equals
            value: true
      mutate:
        patchStrategicMerge:
          metadata:
            annotations:
              # Machine-readable trail: the TaskRun condition carries the human
              # message, this annotation carries the policy verdict.
              policy.alauda.io/cancel-reason: "a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); an ABSENT switch is not a violation -- it inherits the trusted Task default"
          spec:
            status: TaskRunCancelled
            statusMessage: "Cancelled by policy gate-param-mutate-to-cancel: a quality-gate switch was explicitly set to a non-'true' value (enableScanQualityGate='{{ scanQG }}', enableAnalyzeQualityGate='{{ analyzeQG }}'); the values above show which."
```

:::

**Uninstall the [§4.2.1](#s4-2-1) policy before running this section's demo** (the full account of why the three response policies are a mutually exclusive choice sits in the warning before this chapter's cleanup passage; here it is pulled forward to the exact spot where you would trip): with `gate-param-contract` still installed, the same violating scan TaskRun is rejected by it first — mutate does run earlier in the admission chain and has already written `spec.status` to `TaskRunCancelled`, but the validate stage reads the params untouched and denies all the same — the run's terminal state is [§4.2.1](#s4-2-1)'s `CreateRunFailed`, and this section's cancellation shape is **entirely invisible**. Delete `gate-param-contract` per the look-before-delete of [§4.0.4](#s4-0-4) before going on; the [§4.2.2](#s4-2-2) policy does not conflict — its parent pin is `gated-build-with-prep`.

**Expected shape**: the non-compliant run (`enableScanQualityGate="false"`) — the `scan` TaskRun lands in the cluster with `spec.status=TaskRunCancelled` and `spec.statusMessage` preserved; its terminal condition is `False / TaskRunCancelled`, with the message `TaskRun "<name>" was cancelled. <statusMessage verbatim>`; `podName` is empty and the only Pod under the run belongs to finally (the gate container never started); `release` is skipped with `PipelineRun was stopping`; the finally `notify` reaches `Succeeded` normally; the parent run ends `False / Cancelled`, with a message like `Tasks Completed: 2 (Failed: 0, Cancelled 1), Skipped: 1`. In the compliant run all three tasks run to completion with no skips — no collateral damage from the policy. **Verify the second switch separately** — a run that sets only `enableAnalyzeQualityGate` to `"false"` while keeping the other at `"true"` is cancelled just the same (parent run `False / Cancelled`, gate TaskRun `spec.status=TaskRunCancelled`, and the `statusMessage` prints the actual values of both switches); if you only ever verify the first switch, the claim "this section judges the same thing as [§4.2.1](#s4-2-1) / [§4.2.2](#s4-2-2)" has never been verified.

**The trade-offs across the three response forms**:

| Dimension | deny ([§4.2.1](#s4-2-1)) | mutate-existing cancels the parent run ([§4.2.2](#s4-2-2)) | Admission-mutate cancels the gate TaskRun ([§4.2.3](#s4-2-3)) |
|---|---|---|---|
| Run terminal state | `CreateRunFailed` | `Cancelled` | `Cancelled` |
| **finally** | **Does not run** | **Runs** | **Runs** |
| Synchronous / race | Synchronous hard block | Asynchronous, with a race window | **Synchronous hard block, no race window** |
| Extra RBAC | None | background-controller `pipelineruns` update | **None** |
| Gate-reason visibility | Full policy message in the condition | Generic text + `cancel-reason` annotation | `statusMessage` verbatim in the TaskRun condition |
| PolicyReport violation record | Yes (in Audit mode) | No | No |
| For the bare-TaskRun entry point | **Not applicable** (equally bounded by `subjects`) | Not applicable | Not applicable |
| Who owns the bare entry point | [§4.5.4](#s4-5-4) entry closure | [§4.5.4](#s4-5-4) entry closure | [§4.5.4](#s4-5-4) entry closure |
| Fits | No finally wrap-up needed; immediate hard block + full reason | An existing mutate-existing setup; "cancellation slightly later than detection" is acceptable | finally must run as usual, synchronous with zero race, and no extra RBAC wanted |

#### 4.2.4 Protected-branch gate contract (real profile: sonarqube-scanner) {#s4-2-4}

- **What it governs**: **builds after a merge into a protected branch must keep their code scanning under a strict gate** — branch analysis of `main` / `release-*` must not have its gate switches explicitly turned off, nor its scan source swapped. **PR / feature-branch builds carry no branch admission constraint**: the PR-stage gate is best-effort (this section's rule ③, optional to install); the hard guarantee lives post-merge.
- **Why it is hard**: the admission layer has **no trusted "PR target branch" signal** — the platform has no independent targetBranch field; everything rides on PipelineRun parameters. And in PR analysis mode the `sonar.branch.name` parameter is itself **inert** (the Task removes it when it detects a non-empty `sonar.pullrequest.key`). Asserting unconditionally on a parameter that simply does not take effect in some scenarios inevitably blocks those scenarios wholesale — so the criterion must be **conditional**: it applies only to runs whose branch analysis really does target a protected branch. The decision point stays at the TaskRun layer (parameters are written into the scanner TaskRun as expanded values — zero template modification), and identity still locks onto the real taskRef (child labels can be forged via `taskRunSpecs`).
- **How the policy is layered**: ① `hub-source-integrity` — for **every** TaskRun of `catalog/sonarqube-scanner/0.7`, verify the Hub source has not been swapped out (reject a request-level `url`, reject multiple `type`s, an explicit `type` may only be `artifact`); **scenario-neutral**, Enforce → ② `protected-branch-gates-strict` — entered only when the **effective branch** matches `^(main|release-.*)$` (the effective branch is computed in the Task's own resolution order: a non-empty `sonar.pullrequest.key` ⇒ no branch analysis happens and the rule is not entered; otherwise take `sonarBranchName` when non-empty, and when it is absent take the `sonar.branch.name=` value injected via `sonarProperties`): either gate switch **explicitly passed and ≠ `"true"` denies** (absence = inherits the Task's trusted default `"true"`, allowed), Enforce; a PR / feature build's `sonarBranchName` parameter is the source branch / revision, the precondition misses, and the whole rule skips → ③ `pr-target-protected-gates-audit` (optional to install) — when the caller declares a **non-empty `sonar.pullrequest.key`** (real PR analysis; on plain push events the platform also injects the whole `sonar.pullrequest.*` group with an **empty key**, which does not enter this rule) and `sonar.pullrequest.base=` points at a protected branch, require for PRs too that the gate switches are not explicitly turned off, Audit. **Omitting it / passing it wrong simply skips — the direction is naturally fail-open** — the explicit trade-off accepted once you concede that "the PR target branch can only come from user-supplied parameters and is untrustworthy".
- **What it cannot govern**: ⓐ "a protected-branch build must **actually run** the scan" — when `sonarURL` is empty the scanner task is skipped wholesale by the template's `when`, no TaskRun is ever produced, and admission sees nothing (PipelineRun-level criterion in [§4.2.5](#s4-2-5), skip auditing in [§4.1.5](#s4-1-5)); ⓑ the trustworthiness of the PR gate — `sonar.pullrequest.base` is a user-controllable parameter; rule ③ can only be best-effort; ⓒ "a merge into a protected branch necessarily triggers a build" belongs to the platform's trigger configuration and is this section's **trust root** (governed at the same level as [§5.0](#s5-0)).

**Template wiring facts (the basis for the criterion anchors, taken from the catalog source: the `apply_branch_name_property` function in `task/sonarqube-scanner/0.7/sonarqube-scanner.yaml`, and the sonar parameter pass-through block of `pipeline/java-image-build-scan-deploy/0.3` — both live in your environment's catalog repository and can be checked line by line)**: the official 0.3 template hard-wires `sonarBranchName` to **`$(params.gitRevision)`** — whichever revision is built is what gets passed; the caller cannot specify the analysis target independently. The two gate switches `enableScanQualityGate` / `enableAnalyzeQualityGate` are **not passed through** (the template passes only the four parameters `sonarHostURL` / `sonarProjectKey` / `sonarBranchName` / `sonarProperties`), so they stay at the Task-side default `"true"`. Rule ② is therefore **defense in depth** for runs of the official template: absent switches always pass; what it really blocks are self-built / retrofitted shapes that bypass the template wiring and explicitly turn a switch off. And "is this a protected-branch build" is anchored on the value of `sonarBranchName`.

**Parameter mapping of the platform trigger chain (the premise behind rule ②'s anchor)**:

- **Post-merge trigger (push)**: the revision-class parameter is a **branch name** (e.g. `release-4.10`), not a commit SHA — the commit SHA travels in the separate `git-commit` parameter, and `pull-request-number` is an empty placeholder. → Rule ②'s "branch-name anchor" **holds** on the platform's PaC trigger chain (runs carrying `pipelinesascode.tekton.dev/*` labels).
- **PR trigger**: the revision is the **source branch name**, accompanied by `target-branch` (the target branch) and a non-empty `pull-request-number`. → The source branch name does not match the protected regex → rule ② skips and the PR build is not blocked — exactly the designed behavior.
- **The one premise that must hold when switching environments / trigger bindings**: the revision-class parameter maps to a branch name, not a SHA; if some environment's binding maps it to a SHA, rule ②'s anchor stops working — fix the trigger binding or change the anchor. **This is the only trust premise in this section that cannot be verified from the policy itself; how to check**: take one real platform-triggered run and see whether the revision-class parameter's value is a branch name or 40 hex characters (`kubectl -n <ns> get pipelinerun <run> -o jsonpath='{.spec.params}'`), or read the variable mapping in the trigger binding directly (PaC uses `{{revision}}` / `{{source_branch}}` / `{{target_branch}}` in `.tekton/*.yaml`).
- **An upgrade opportunity along the way**: PR events already carry `target-branch` at the trigger layer (closer to the event source than `sonar.pullrequest.base`, injected by the trigger rather than typed in by a user). The official template currently does not pass it through to the scanner; the day the template does pass target-branch through, rule ③ should switch its anchor to it and can be evaluated for promotion to Enforce — the trust root remains "runs created by the platform trigger chain"; a hand-crafted run can still forge that parameter, and that layer is backstopped by the [§4.5.4](#s4-5-4) entry closure.

**The key criterion** (rule ②) — first scope in "this is an analysis of a protected branch" by the branch value, then deny "gates explicitly turned off"; PR / feature builds skip already at the precondition:

```yaml
        # Absence stays out of gateWeakened on purpose: an absent switch inherits
        # the trusted Task default "true" (the official template does not pass
        # these params through at all). Only an EXPLICIT non-true value denies.
        - name: gateWeakened
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          # ...(identity preconditions omitted: resolver=hub / kind=task / catalog / name / version=0.7)
          # Scope gate: ONLY analyses targeting a protected branch enter this rule.
          # A PR / feature build carries its source ref (or nothing) here -> the
          # regex fails -> the rule SKIPS and the run is allowed. This is the
          # inverse of a branch allowlist: non-protected branches are out of
          # scope, not violations.
          # Two alternatives: the param value is bare, while a sonarProperties claim
          # still carries its 'sonar.branch.name=' prefix. Anchored either way so
          # 'main-x' or a smuggled 'sonar.branch.name=main;y=z' cannot pose as protected.
          - key: "{{ regex_match('^(main|release-.*)$', branch) || regex_match('^sonar[.]branch[.]name=(main|release-.*)$', branch) }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              - key: "{{ gateWeakened }}"
                operator: Equals
                value: true
```

**In this section the semantics of "absent" is skip, not deny** — the opposite of allowlists like [§4.1.1](#s4-1-1) / [§4.5.1](#s4-5-1): when `sonarBranchName` is absent or does not match the protected regex, rule ② simply skips (in PR mode the parameter is inert anyway — see the warning below); when a gate switch is absent, it inherits the trusted default and passes. The only unconditionally fail-closed piece is rule ① (a swapped hub source is denied in every scenario).

:::warning Why it must not be written as "the branch must be in the protected set" (this section's history lesson)

An early version of this section was written exactly that way: any `sonarBranchName` not matching `^(main|release-.*)$` was denied. Under the official template that is **wholesale collateral damage**: the template hard-wires the parameter to `$(params.gitRevision)`, so **feature-branch builds and PR-triggered builds were all rejected at admission** — a PR could never pass CI and therefore could never merge. Meanwhile the thing it wanted to prevent — "pointing the analysis at some other branch to game the results" — is already closed under the official-template profile (the parameter cannot be specified independently + [§4.1.1](#s4-1-1) locks the template + [§4.2.5](#s4-2-5) forbids `sonarProperties` overrides).

Remember the semantic boundary along with it: `sonarBranchName` is the target of **branch analysis**, **not the target of PR analysis**. When the final configuration carries a non-empty `sonar.pullrequest.key` (PR analysis mode), the Task **removes** `sonar.branch.name` — asserting unconditionally on such a **scenario-inert parameter** is the textbook failure shape of "a criterion that holds in only one scenario, Enforced onto all scenarios". The target branch of PR analysis lives in `sonar.pullrequest.base`, which is a user-controllable parameter — rule ③ handles it with the best-effort semantics of "validate only when a **non-empty** `sonar.pullrequest.key` (real PR analysis) is declared and the target is protected"; **with rule ③ not installed, the PR stage simply has no gate** — both shapes are accepted design (the hard guarantee is carried post-merge by rule ②).

:::

:::warning Before reusing this section as a paradigm, run the "scenario-selector field" through a sufficiency check

The generic shape this section demonstrates is "**conditionalize the criterion to the scenario, instead of Enforcing unconditionally**". Before transplanting it onto another parameter / another Task, first confirm that the "scenario-selector field" you picked **really does determine the final semantics** — three questions, none of them skippable:

1. **Is it the only entry point?** One semantic often has several configuration entries. This section stepped on exactly that: `sonarBranchName` looks like the sole source of the analysis target, yet injecting a single `sonar.branch.name=` line inside `sonarProperties` also sets it — **when the parameter is absent, the injected value is the effective value**. So rule ②'s scope criterion must compute the effective value in the Task's real resolution order; reading only the parameter "whose name looks right" leaves a bypass open.
2. **Will some scenario make the consumer ignore it?** This section's `sonar.branch.name` is deleted by the Task in PR mode (an inert parameter) — asserting on it unconditionally is wholesale collateral damage (see the previous warning).
3. **Is the value your criterion computes the same value the Task actually uses?** There is exactly one way to decide: **read the consumer's source code** (this section read the merge order of `apply_branch_name_property`); inferring from parameter names and documentation prose is not enough.

Only after all three pass can you talk about "conditionalizing". Missing question 1 is the more dangerous case: conditionalization then yields a criterion that looks guaranteed but has a hole — harder to discover than an unconditional Enforce.

:::

**What must change together when you extend / upgrade** (each of the three rules carries its own copy of the criteria; the consequence of missing one is always a **silent skip** — the policy is still there, the reports stay clean, and nothing is actually locked):

| The change you are making | Locations that must move in step | Consequence of missing one |
|---|---|---|
| Scanner version bump (0.7 → 0.8) | **The `taskVersion` precondition in each of the three rules** (one place per rule, 3 in total); at the same time re-verify against the new version that the PR-mode semantics and parameter names still hold | All three rules stop matching on identity → everything silently skips; source integrity and the gate guarantee vanish together |
| Adding / removing protected-branch patterns (e.g. adding `hotfix-*`) | **All three regex literals must change at the same time**: in rule ②'s precondition the bare form `^(main|release-.*)$` and the prefixed form `^sonar[.]branch[.]name=(main|release-.*)$` (OR-joined on the same line — open it and you see both), plus rule ③'s `prBaseProtected` regex `^sonar[.]pullrequest[.]base=(main|release-.*)$` — this section deliberately keeps three copies rather than extracting a shared variable, because they anchor different fields (the branch value / the injected branch token / the PR base token) | Changing only one or two → the rest still evaluate against the old branch set; the parameter-form and injected-form (or PR-side) verdicts silently diverge, and nothing errors |
| Adding a third gate switch | The `<switch>Present` / `<switch>` variable pair plus the `gateWeakened` expression in rules ② and ③ (one place per rule, 2 in total), and the echo in both `message`s | The new switch can be turned off at will; the criterion cannot see it |
| Changing the hub catalog name | The `taskCatalog` precondition in all three rules + the placeholder substitution table in [§4.0.3](#s4-0-3) (whose row also notes that **the parameter key `[?name=='catalog']` must not be substituted**) | Same as the version bump: everything silently skips |

:::details Full policy YAML: sonar-branch-analysis-branch-contract (three rules)

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: sonar-branch-analysis-branch-contract
spec:
  background: false
  rules:
    # Rule 1 -- scenario-neutral source integrity: the scanner's hub source must
    # not be swapped, no matter which branch or trigger produced the run.
    - name: hub-source-integrity
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
      validate:
        failureAction: Enforce
        # Name the three offending shapes separately: a single boolean tells the
        # blocked user WHAT rule fired but not WHICH taskRef param to fix.
        message: >-
          quality analysis must use the governed Artifact Hub source -- fix the
          taskRef params: request-level 'url' present={{ hubURLCount }}
          (must be 0), 'type' param count={{ hubTypeCount }} (must be 0 or 1),
          'type' value='{{ hubType }}' (must be empty or 'artifact').
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
    # Rule 2 -- the hard guarantee: an analysis TARGETING a protected branch
    # (the post-merge build; the official template wires sonarBranchName to
    # $(params.gitRevision)) must not have its quality-gate switches explicitly
    # disabled. PR / feature builds carry a non-protected value (or none) here
    # and SKIP -- out of scope, not violations.
    - name: protected-branch-gates-strict
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # to_array + [0] normalizes an array-typed param to its first element,
        # and the outer to_string JSON-encodes an object-typed ParamValue (Tekton
        # params are a string|array|object union) -- so regex_match below always
        # receives a string. A hand-crafted TaskRun passing an array or object
        # would otherwise make the precondition ERROR (= fail-closed deny with a
        # cryptic message) instead of skipping; an encoded object can never match
        # the protected-branch regex, so the weird-typed run just skips.
        - name: branchParam
          variable:
            jmesPath: "to_string(to_array((request.object.spec.params || `[]`)[?name=='sonarBranchName'].value | [0] || '') | [0] || '')"
            default: ""
        # sonarProperties can carry its own sonar.branch.name= line, and the Task
        # merges it BEFORE applying sonarBranchName. apply_branch_name_property then
        # overwrites that line only when sonarBranchName is NON-EMPTY -- so an ABSENT
        # sonarBranchName leaves the injected value as the analysed branch. Mirror the
        # Task's resolution order here, or the scope gate reads '' and skips while the
        # scan actually targets a protected branch.
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        - name: branchFromProps
          variable:
            jmesPath: "sonarPropsItems[?starts_with(@, 'sonar.branch.name=')] | [0] || ''"
            default: ""
        # A non-empty PR key makes the Task DELETE sonar.branch.name (PR analysis, no
        # branch analysis happens), so this rule is out of scope -- the PR stage is
        # rule 3's business.
        - name: prKeyNonEmpty
          variable:
            jmesPath: "length(sonarPropsItems[?starts_with(@, 'sonar.pullrequest.key=') && @ != 'sonar.pullrequest.key=']) > `0`"
        # Effective analysed branch, in the Task's own resolution order. branchFromProps
        # keeps its 'sonar.branch.name=' prefix, which the scope regex accounts for.
        - name: branch
          variable:
            jmesPath: "prKeyNonEmpty && 'PR-MODE-NO-BRANCH-ANALYSIS' || (branchParam != '' && branchParam || branchFromProps)"
            default: ""
        # Presence is tracked separately from the value: only an absent param
        # inherits the trusted Task default "true"; an explicit empty string or
        # any other non-true value is a weakened gate (same pattern as §4.2.1).
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        - name: gateWeakened
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
          # Scope gate: only protected-branch analyses enter this rule.
          # Two alternatives: the param value is bare, while a sonarProperties claim
          # still carries its 'sonar.branch.name=' prefix. Anchored either way so
          # 'main-x' or a smuggled 'sonar.branch.name=main;y=z' cannot pose as protected.
          - key: "{{ regex_match('^(main|release-.*)$', branch) || regex_match('^sonar[.]branch[.]name=(main|release-.*)$', branch) }}"
            operator: Equals
            value: true
      validate:
        failureAction: Enforce
        message: >-
          analysis of protected branch '{{ branch }}' must keep the quality gates
          on: enableScanQualityGate='{{ scanQG }}',
          enableAnalyzeQualityGate='{{ analyzeQG }}' (an absent switch inherits
          the trusted default "true"; an explicit non-true value is rejected).
        deny:
          conditions:
            any:
              - key: "{{ gateWeakened }}"
                operator: Equals
                value: true
    # Rule 3 (OPTIONAL, best-effort BY DESIGN) -- when the caller claims REAL
    # PR analysis (a NON-EMPTY sonar.pullrequest.key; the platform injects the
    # group with an empty key on plain push events, which must not enter) and
    # names a protected target via sonar.pullrequest.base=... in the
    # sonarProperties param, hold the same gate strictness. The claims are
    # user-supplied and absent by default: omission or a non-protected value
    # simply skips. That fail-open direction is the accepted trade-off for the
    # PR stage (the hard guarantee lives in rule 2, post-merge), which is also
    # why this rule audits instead of enforcing.
    - name: pr-target-protected-gates-audit
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # sonarProperties is an ARRAY param: [?name==...].value yields a list of
        # values, | [0] takes the first value which IS the array of items.
        # to_array keeps the rule from erroring out when a hand-crafted TaskRun
        # passes the param as a plain string (array -> unchanged, string ->
        # one-element array, absent -> []), and the per-element to_string(@)
        # projection JSON-encodes object-typed values so every starts_with
        # below always receives strings (an object param would otherwise make
        # the rule error; encoded objects match no sonar.pullrequest.* prefix,
        # so such a run simply skips).
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        # PR mode is claimed by a NON-EMPTY sonar.pullrequest.key. The platform
        # injects the whole sonar.pullrequest.* group with an EMPTY key on plain
        # push events -- a bare 'sonar.pullrequest.key=' must NOT drag a push
        # build into this rule.
        - name: prKeyTokens
          variable:
            jmesPath: "sonarPropsItems[?starts_with(@, 'sonar.pullrequest.key=')]"
            default: []
        - name: prKeyCount
          variable:
            jmesPath: "length(prKeyTokens)"
            default: 0
        - name: prKeyNonEmpty
          variable:
            jmesPath: "length(sonarPropsItems[?starts_with(@, 'sonar.pullrequest.key=') && @ != 'sonar.pullrequest.key=']) > `0`"
        - name: prBaseTokens
          variable:
            jmesPath: "sonarPropsItems[?starts_with(@, 'sonar.pullrequest.base=')]"
            default: []
        - name: prBaseCount
          variable:
            jmesPath: "length(prBaseTokens)"
            default: 0
        - name: prBaseClaim
          variable:
            jmesPath: "prBaseTokens | [0] || ''"
            default: ""
        # Match the WHOLE token so 'sonar.pullrequest.base=main;x=y' or an
        # embedded second assignment cannot pose as a protected claim.
        - name: prBaseProtected
          variable:
            jmesPath: "regex_match('^sonar[.]pullrequest[.]base=(main|release-.*)$', prBaseClaim)"
        - name: scanQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableScanQualityGate']) > `0`"
        - name: scanQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableScanQualityGate'].value | [0] || ''"
            default: ""
        - name: analyzeQGPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate']) > `0`"
        - name: analyzeQG
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='enableAnalyzeQualityGate'].value | [0] || ''"
            default: ""
        - name: gateWeakened
          variable:
            jmesPath: >-
              (scanQGPresent && scanQG != 'true') ||
              (analyzeQGPresent && analyzeQG != 'true')
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: sonarqube-scanner
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.7"
          # Only runs that CLAIM PR analysis (non-empty pullrequest.key) AND
          # name a target base enter. A plain push build carrying the
          # platform-injected group with an EMPTY key skips, and so does a PR
          # run with no base claim -- accepted fail-open for the PR stage.
          - key: "{{ prKeyNonEmpty }}"
            operator: Equals
            value: true
          - key: "{{ prBaseCount }}"
            operator: NotEquals
            value: 0
      validate:
        failureAction: Audit
        # Echo both claim counts: the three deny conditions (duplicated base,
        # duplicated key, protected base with weakened gates) otherwise render
        # the SAME report entry and cannot be told apart in a PolicyReport.
        message: >-
          PR analysis (non-empty sonar.pullrequest.key) claims target
          '{{ prBaseClaim }}' -- base claims={{ prBaseCount }},
          key claims={{ prKeyCount }} (each must be exactly 1), and a protected
          target must keep the quality gates on
          (enableScanQualityGate='{{ scanQG }}',
          enableAnalyzeQualityGate='{{ analyzeQG }}').
        deny:
          conditions:
            any:
              # More than one base or key claim: ambiguous / smuggled -- flag it.
              - key: "{{ prBaseCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ prKeyCount }}"
                operator: NotEquals
                value: 1
              # Exactly one claim each, protected target, gate explicitly weakened.
              - key: "{{ prBaseCount == `1` && prBaseProtected && gateWeakened }}"
                operator: Equals
                value: true
```

:::

:::details Verification probes (22 of them; every real trigger scenario has an allow case)

How to run: for 1-9, 14-16, and 18-22 use `kubectl create --dry-run=server` (the Enforce verdict is visible synchronously); 10-13 and 17 are observation items of Audit rules — **really create** them, then reconcile `fail` / `pass` / `skip` in the PolicyReport (the `skip` in #12 corresponds to "the push-injection shape with an empty key is not mis-recorded as a PR fail"); clean up the probe objects per [§4.0.4](#s4-0-4) when done. After deployment, re-run this table per skeleton B of [§3.5](#s3-5) to re-verify.

| # | Scenario / construction | Expected |
|---|---|---|
| 1 | Protected branch, official-template shape: `sonarBranchName: main`, gate switch **absent** | Allow (absence = trusted default) |
| 2 | Protected branch, explicitly compliant: `sonarBranchName: release-1.2` + `enableScanQualityGate: "true"` | Allow |
| 3 | Protected branch, gate explicitly off: `sonarBranchName: main` + `enableScanQualityGate: "false"` | **Deny** (`protected-branch-gates-strict`) |
| 4 | Protected branch, explicit empty string: `sonarBranchName: main` + `enableAnalyzeQualityGate: ""` | **Deny** (an explicit empty string ≠ absence) |
| 5 | **feature build, gate off**: `sonarBranchName: feature-x` + `enableScanQualityGate: "false"` | **Allow** (rule ② skips — the scenario's allow case, proving PR / feature builds are not blocked wholesale) |
| 6 | **Common PR shape**: `sonarBranchName` absent + `enableScanQualityGate: "false"` | Allow (rule ② skips; rule ③ not triggered) |
| 7 | hub source swapped (request-level `url`) + `sonarBranchName: feature-x` | **Deny** (`hub-source-integrity` — scenario-independent; a feature branch is denied just the same) |
| 8 | Approved quadruple + explicit `type: tekton` + `main` | **Deny** (`hub-source-integrity`) |
| 9 | A single explicit `type: artifact` + `main`, switch absent | Allow |
| 10 | PR best-effort positive case: `sonarProperties` contains `sonar.pullrequest.key=1770` + `sonar.pullrequest.base=main` + `enableScanQualityGate: "false"` (**in 10-13, `sonarBranchName` is always absent or a feature value** — that is what the PR shape looks like anyway; with a protected-branch value the request would first be Enforce-denied by rule ②, and the Audit expectation could never be observed) | PolicyReport **fail** (`pr-target-protected-gates-audit`; Audit does not block) |
| 11 | PR best-effort negative case: `key=1770` + `base=feature-y` + gate off | No fail (not a protected target; the accepted fail-open) |
| 12 | **push-injection shape**: `sonarProperties` contains `sonar.pullrequest.key=` (**empty key**) + `base=main` + gate off | No fail (rule ③ requires a non-empty key as a precondition — ordinary push builds are not mis-recorded as PR fails) |
| 13 | Duplicate declarations: `key=1770` ×1 + `base=main` ×2 (or `key=` stacked with another non-empty key) | PolicyReport **fail** (ambiguous / smuggled declaration, malformed) |
| 14 | Forged identical pipeline / pipelineTask labels, but the real Task identity is not `catalog/sonarqube-scanner/0.7` | All three rules skip; no false positives |
| 15 | Regression case: `sonarBranchName` passed as an **array** (`[feature-a, feature-b]`) + gate off | Allow (`to_array` normalization takes the first element, which does not match the protected regex → rule ② skips; **no rule error is produced**) |
| 16 | Regression case: `sonarBranchName` passed as an **object** (an object-typed ParamValue) + gate off | Allow (`to_string` encodes the object as a JSON string, which does not match the protected regex → rule ② skips; **no rule error is produced** — without this hardening it is a fail-closed false denial) |
| 17 | Regression case: `sonarProperties` passed as an **object** | PolicyReport **skip** (after per-element `to_string(@)` no `sonar.pullrequest.*` prefix matches → rule ③'s precondition does not hold; **no error entry is produced**) |
| 18 | **Injected branch anchor**: `sonarBranchName` **absent** + `sonarProperties` contains `sonar.branch.name=main` + gate off | **Deny** (`protected-branch-gates-strict` — when the parameter is absent the Task keeps the injected value, and the scoping criterion follows it) |
| 19 | Parameter overriding the injected value: `sonarBranchName: feature-x` + `sonarProperties` contains `sonar.branch.name=main` + gate off | Allow (the Task overrides the injected value with the parameter; what actually gets analyzed is feature-x — **no false positive**) |
| 20 | No false positive in PR mode: `sonarBranchName: main` + `sonar.pullrequest.key=1770` + gate off | Allow (a non-empty key ⇒ the Task deletes `sonar.branch.name` and does no branch analysis at all; the PR stage belongs to rule ③) |
| 21 | Smuggled suffix: `sonarProperties` contains `sonar.branch.name=main;sonar.foo=bar` + gate off | Allow (whole-token anchoring; a concatenated value does not impersonate a protected branch) |
| 22 | Protected branch injected but **without weakening the gate**: `sonarProperties` contains `sonar.branch.name=release-1.2`, switch absent | Allow (the scoping criterion only decides whether the request enters this rule; once in, only explicit weakening is denied — it has not become a branch allowlist) |

:::

#### 4.2.5 Early blocking for the official templates (auxiliary path, real profile) {#s4-2-5}

- **What it governs**: when the official template `java-image-build-scan-deploy` 0.3 **or** `python-image-build-scan-deploy` 0.3 is used, block — **at the moment the PipelineRun is created** — the calls that switch the gates off or hollow them out into a formality.
- **Why it is hard**: the gates in these two templates hide three escalating traps, and the naive approach of only aligning the `when` values is guaranteed to miss — ① **by default, nothing is scanned at all**: `sonarURL` defaults to empty and the sonar task is guarded by `when`, so the whole code scan is skipped (the opt-in trap, a real instance of contract 3); ② **scheduled ≠ actually scanned**: with `trivyExtraArgs` set to `--help`, trivy exits 0 without producing any report, and **the TaskRun is green all the same**; ③ **even a scan that ran may be fake**: `sonarProperties` can override the approved configuration, `tlsVerify=false` turns on `--insecure`, with multiple elements in `images` buildah pushes them all while trivy scans only the first, and workspaces can be swapped for unreviewed sources.
- **How the policy is layered**: ① lock the Hub source identity (deny request-level `url`; an explicit `type` may only be `artifact`) → ② force the gates to actually be on (`sonarURL` non-empty, `skipTrivyScan` exactly `"false"`, `trivyExitCode` not set to the report-only `""` / `"0"`, `trivySeverity` covering the required severities, `trivyExtraArgs` empty) → ③ force the effective configuration not to be hollowed out (no `sonarProperties` entry overriding a governed key, no `sonarProjectKey` override, `tlsVerify` only the trusted default or exactly `true`, `images` non-empty and shell-safe, the strict profile limited to a single image) → ④ restrict the sources of the gate-related workspaces to reviewed objects — **the 6 shared ones** (`sonar-settings` / `sonar-credentials` / `sonar-certificate` / `registry-config` / `ca-bundle` / `trivy-config`), plus the language-specific part: java adds 5 maven ones (11 total), python adds `pip-conf` (7 total).
- **What it cannot govern**: this is the **auxiliary path** — it only sees what is **explicitly written** on the PipelineRun; the final effective values are still decided at the TaskRun level ([§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)); and this section **cannot see run results** — what the scan actually reported is [§4.4.1](#s4-4-1)'s job.

:::info Before go-live, verify the workspaces the template actually declares

The workspace allowlist in this section is written against the **16** workspaces of `java-image-build-scan-deploy` 0.3 and the **12** of `python-image-build-scan-deploy` 0.3. **The allowlist enumerates names one by one; when the template changes its workspaces, the allowlist must follow** — so before go-live, verify against the actually resolved definition instead of copying this document's numbers:

```bash
# On the cluster running Tekton, list the workspaces the template actually declares and verify them. The two fill-in values come first:
PIPELINE_NS='<your-pipeline-namespace>'
REAL_RUN='<one-real-run>'
kubectl -n "$PIPELINE_NS" get pipelinerun "$REAL_RUN" \
  -o jsonpath='{.status.pipelineSpec.workspaces[*].name}'
```

If they do not match, re-enumerate per your own copy. Pay special attention to the case where **a workspace has disappeared**: the corresponding criterion becomes constantly false — it looks green, but locks nothing at all.

:::

The full profile of this section is split into **three rules**, because the only thing genuinely different between the two official templates is the small block of build inputs:

| rule | Templates covered | What it governs |
|---|---|---|
| `quality-gates-must-stay-enabled` | java 0.3 **and** python 0.3 | Hub source identity, the Sonar gate, the Trivy gate, TLS, `images`, and the **6 scan / configuration workspaces** (`sonar-settings`, `sonar-credentials`, `sonar-certificate`, `registry-config`, `ca-bundle`, `trivy-config`) |
| `java-build-inputs-must-stay-approved` | java 0.3 only | 5 maven parameters + 5 maven workspaces |
| `python-build-inputs-must-stay-approved` | python 0.3 only | 5 `preBuild*` / `pythonImage` parameters + the `pip-conf` workspace |

The gate surface can share one rule because the two templates have **identical parameter names and types for everything the gate criteria touch** — on the trivy side (`skipTrivyScan` / `trivyExitCode` / `trivySeverity` / `trivyExtraArgs`) even the defaults are identical field by field; on the sonar side the parameter names are the same (**but the default of `sonarProperties` differs**: java carries one extra entry, `sonar.java.binaries=target/classes`; the criteria in this section only require "not overridden by the request side" and never compare against defaults, so this does not matter). The differences are concentrated in the language-specific build inputs (java's maven group ↔ python's `preBuild*` group, workspaces 16 ↔ 12).

**The two templates share 11 same-named workspaces; this section governs only 6 of them.** The remaining 5 — `source`, `git-basic-auth`, `git-ssh-directory`, `git-ssl-ca-directory`, `kubeconfig` — **are not in the criteria of these three rules**; they are the responsibility of the Git / source policies and of the release-target policy in [§4.5.5](#s4-5-5) respectively (the per-workspace division of labor is in the workspace responsibility table below). Copying this section's rules does not mean all 11 are locked.

The real shape of template 0.3 is this: `sonarURL` defaults to empty and the sonar task is guarded by `when: sonarURL notin ["", " "]` — **by default the code scan is skipped entirely**; the trivy task is guarded by `when: skipTrivyScan in ["false"]`, i.e. **it is scheduled only when the value is exactly `"false"`**.

But "the task got scheduled" is still not "it actually scanned". The vulnerability gate is controlled by `trivyExitCode`, **default `"1"`, i.e. on by default** (the parameter-contract baseline is the version matrix in [§3.2](#s3-2)) — so what the policy must prevent is not "forgot to turn it on" but **being explicitly turned off** (set to `"0"` or an empty string). Separately, `trivySeverity` decides which severities count toward the gate; narrowing it down to just `LOW` likewise amounts to waving the high-severity findings through. Stuffing `--help`-style arguments into `trivyExtraArgs` makes trivy exit 0 without producing any report, and the TaskRun still succeeds. `tlsVerify=false` makes the Task run with `--insecure`. Buildah pushes **every** element of `images` while Trivy scans only the **first**, so the strict profile must restrict it to a single image. Sonar 0.7 keeps applying `sonarProperties` and credentials after the approved URL / project key; Maven 0.6's working directory, goals, run image, and the workspaces it actually consumes likewise change the build and its trust sources.

:::warning This section governs the scan gates, not build and push

The template passes `trivyExtraArgs` to `trivy-scanner` 0.6 in structured form (`scanType` / `scanTargets` / `severity` / `exitCode` / `extraArgs`), so on this side there is no longer a "parameters concatenated into a shell command string" injection surface.

**But do not read that as "the template has no injection surface left"**: in the same template, `buildExtraArgs` and `pushExtraArgs` **are still string-typed**, and their parameter documentation says in so many words that they "must be sanitized by the caller to avoid command injection"; `containerfilePath` / `buildContext` also still flow into the data path of subsequent scripts. This section's policy does **not** govern the build-and-push side — with every scan-gate parameter written correctly, the build may already have been tampered with.

:::

:::warning Align exactly with the final effective configuration, not just the when values

The naive approach — "deny only `sonarURL==''`, deny only `skipTrivyScan=='true'`" — has direct bypass values; going one step further and merely guaranteeing the task gets scheduled still misses three classes: explicitly switching `trivyExitCode` off to `"0"`, narrowing `trivySeverity` down to low severities only, and invocations like `trivyExtraArgs: ["--help"]` that "exit 0 but produce no report" — plus later parameter / workspace overrides of the approved configuration.

The full profile therefore forbids the PipelineRun from explicitly overriding `sonarProjectKey`, **forbids any `sonarProperties` entry that overrides governed configuration** (see the next paragraph), requires `tlsVerify` to use the trusted default or be exactly `true` and `images` to be non-empty and shell-safe, and restricts the optional Sonar / Maven / registry / pip workspaces to reviewed objects.

**`sonarProperties` is judged on content, not on presence** (the same lesson as [§4.2.4](#s4-2-4)): the parameter is the **only channel** for passing legitimate analysis settings (exclusion dirs, coverage report paths, and so on), and on the trigger path the platform additionally injects the whole `sonar.pullrequest.*` group through it — **"deny on presence" would block that entire class of normal requests**. Per scanner 0.7's merge order (task params → `sonarProjectKey` → **`sonarProperties`** → credentials → branch name → quality-gate normalization), only three classes of governed keys can genuinely be overridden here: the analysis endpoint `sonar.host.url`, the project identity `sonar.projectKey`, and `sonar.branch.name` when `sonarBranchName` is absent; the credential keys (`sonar.login` / `sonar.token` / `sonar.password`) are overwritten by the later credentials step and `sonar.qualitygate.*` by the final normalization — neither can currently be overridden, but the criterion lists them anyway, **so that a future reordering of the merge cannot silently open a hole**.

**The object names in the examples must be replaced with the Secrets / ConfigMaps actually approved in your environment** (the `approved-*` batch), **and the three values `<approved-sonar-url>` / `<approved-maven-mirror-url>` / `<approved-maven-cert-path>` must also be replaced with your own** — they are not object names, they are the easiest to miss, and the consequence of missing them is that **compliant requests get denied**: the `sonarURL` criterion is an unconditional comparison (**every** request would be denied), while the two maven criteria carry an "only judged when explicitly passed" precondition (only requests that explicitly configure a mirror / cert are denied). Per-item scopes are in the placeholder table in [§4.0.3](#s4-0-3). On a template upgrade, re-review every field and the merge order.

:::

:::info Transport verification in Sonar 0.7's analyze stage

The `sonar-scanner` step imports `sonar-certificate` into the Java truststore; the subsequent `sonar-analyze` step invokes the CLI with `--insecure-skip-tls-verify`.

**This does not affect the validity of the gate itself** — the quality threshold is still adjudicated by the Sonar server, and the `code-scan-results` the policy reads is still the server's conclusion. What is affected is only the certificate verification on the transport leg from the analyze stage to the Sonar server. In most deployments Sonar sits on the cluster-internal network and `sonarURL` is pinned by this section's allowlist, so the actual exposure narrows to an on-path attacker routable on the internal network; if your threat model includes that class, this is a Task-side property that admission policy cannot change — follow it up with the Task maintainers.

:::

The two templates share 11 same-named workspaces; java has another 5 maven ones and python another 1, `pip-conf` (java 16 / python 12). The responsibilities must be teased fully apart — do not misstate "this section locked these gate workspaces" as "all workspaces are governed":

| workspace | java / python | Responsibility boundary |
|---|---|---|
| `sonar-settings`, `sonar-credentials`, `sonar-certificate`, `registry-config`, `ca-bundle`, `trivy-config` | 6 / 6 | Locked by the shared rule: the admission-visible source type and object name; these workspaces are read by the Task, but the policy does not read the internal content of Secrets / ConfigMaps / PVCs. Among them, `trivy-config` carries trivy's centralized configuration (`trivy.yaml`) and ignore rules — **it is a workspace sitting on the scan gate: bind an object you control and you can relax the scan while every parameter criterion stays green** — so the criterion fails closed on "bound, but not that ConfigMap" (including PVC / Secret sources) |
| `maven-settings`, `maven-server-secret`, `maven-local-repo`, `maven-cert` | 4 / — | Locked by the java rule; boundary as above |
| `pip-conf` | — / 1 | Locked by the python rule; `pip.conf` decides where packages resolve from, so an unreviewed binding is a supply-chain input. Not binding it is allowed |
| `maven-trust-store` | 1 / — | Pipeline 0.3 binds it to Maven 0.6's same-named workspace, but Maven 0.6's execution logic never reads it; the source restriction here is a **conservative defense against upgrade drift**, not evidence that "the current version already alters Maven trust" |
| `source` | 1 / 1 | Shared source code and deployment manifests; source identity, content integrity, and the source-to-image linkage are the responsibility of the trusted checkout template, the Git / source policies, and supply-chain attestation — not this section |
| `git-basic-auth`, `git-ssh-directory`, `git-ssl-ca-directory` | 3 / 3 | Git credentials / SSH / CA; must be approved by separate Git URL / revision and workspace-source policies; not checked in this section |
| `kubeconfig` | 1 / 1 | Release identity and target; workspace source precisely approved by [§4.5.5](#s4-5-5), combined with RBAC controls |

The `trivy-config` criterion is already **written into the full policy below** (the four variables `trivyConfigCount` / `trivyConfigWorkspace` / `trivyConfigConfigMap` / `trivyConfigBad` plus the matching entry in `deny.conditions.any`); both the positive and the negative cells are in the probe table at the end of this section. When you extend other workspaces yourself, remember: **declaring the variable without wiring it into `deny.conditions.any` is the same as not adding it**.

**These criteria also lock the "source type"**: the shape is `xxxConfigMap != '<approved-object>'`, reading `.configMap.name`, so binding the same workspace as a **Secret / PVC / CSI / projected** source leaves that field empty — always denied. The template itself does **not** restrict source types (these are just optional workspaces); **this is an extra tightening added by this document's profile**. **If your site genuinely keeps some configuration in a Secret** (for example a `sonar-settings` carrying credentials), do not delete the criterion; change it to read the corresponding field while keeping the "if bound, it must be the approved object" shape — e.g. `(sonarSettingsWorkspace.configMap.name || sonarSettingsWorkspace.secret.secretName) != '<approved-object>'`, or use `contains([...], ...)` to approve the object names of both source types; after the change, run the positive/negative probe pair as before (compliant source allowed / a different object denied).

:::warning Why [0] is safe here: the three spec-side uniqueness guarantees come from Tekton

The criteria in this section use `[?name=='x'] | [0]` everywhere — parameters, resolver parameters, workspaces alike. Is that safe against "write the same name twice, the policy only sees the first"? **Yes — because Tekton's validating webhook rejects the request first**, and the policy never sees such an object:

| Construction | Tekton's verbatim error |
|---|---|
| `trivyExtraArgs` written twice in `spec.params` (first occurrence compliant, second `["--help"]`) | `expected exactly one, got both: spec.params[trivyExtraArgs].name` |
| `version` written twice in `pipelineRef.params` (first `0.3`, second `attacker-version`) | `expected exactly one, got both: spec.pipelineRef[version].name` |
| `trivy-config` bound twice in `spec.workspaces` (first the approved ConfigMap, second a malicious PVC) | `workspace "trivy-config" provided by pipelinerun more than once, at index 0 and 1: spec.workspaces[1].name` |

So `spec`-side uniqueness is guaranteed by Tekton and the policy need not count again (this section's `trivyConfigCount > 1` and the like are merely defense in depth kept in the same shape as the other workspace criteria, not a necessity).

**⚠️ This guarantee covers `spec` only and must never be extrapolated to `status`.** `status.results`, `status.conditions`, `status.skippedTasks`, and `status.pipelineSpec.tasks` are all written by controllers, and the CRD carries no uniqueness constraint on any of them (`conditions` and `pipelineSpec.tasks` are bare arrays; `results` and `skippedTasks` are `x-kubernetes-list-type: atomic` — that means "replace as a whole", not "dedupe by key"): **at admission time a same-named entry can appear twice, which is enough to bypass a policy that copies the `[0]` pattern**. So every policy that reads `status` must explicitly require "exactly one entry for the target result / condition", and the terminal-state guard likewise counts entries instead of taking `[0]` — construction, A/B evidence, and the fix are in the warning "never take `[0]` when reading status" in [§4.4.1](#s4-4-1).

**And this rule must be counted all the way down, not just at the outermost layer.** `status.pipelineSpec.tasks[].taskRef.params` is a **params list nested inside status**: even after the outer layer has counted "exactly one task named `scan`", if the inner `kind` / `name` / `namespace` still copy `[0]`, one decoy parameter inserted in front lets the identity criterion read a "clean" value. The `scanRefParamsUnique` in [§4.1.4](#s4-1-4) and [§4.6.2](#s4-6-2) is exactly that layer's counting guard; **for every layer you drill into status yourself, ask once per layer: "does this list have a uniqueness guarantee?"**

:::

##### The minimal version first: only guarantee the vulnerability gate is not switched off

If your requirement is simply "nobody may switch the trivy gate off", then **the whole policy takes six criteria** (four parameters + two override surfaces), covering both official templates together:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: trivy-gate-must-stay-on
spec:
  background: false
  rules:
    - name: trivy-gate-must-stay-on
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        # Pin the whole template identity, not just its name: a same-named
        # pipeline resolved through another resolver or catalog is a different
        # object with different defaults.
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # The scan task is guarded by `when: skipTrivyScan in ["false"]`, so this
        # switch turns the gate off by never creating the task at all -- the
        # parameter checks below would all be vacuously true.
        - name: skipTrivyPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='skipTrivyScan']) > `0`"
        - name: skipTrivy
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='skipTrivyScan'].value | [0] || ''"
            default: ""
        # A per-task override travels in the same request and is invisible to
        # every parameter judgment: podTemplate.env reaches every step container
        # (so it can narrow trivy's severity filter without touching a param),
        # and serviceAccountName changes what the gate step may do. stepSpecs /
        # sidecarSpecs carry computeResources only, so resource tuning stays
        # allowed -- rejecting that would be stricter than the gate needs.
        # The run-wide equivalent: taskRunTemplate.podTemplate applies to every
        # TaskRun of this run, so env set here reaches the governed task too.
        # Only env is judged. Besides nodeSelector / imagePullSecrets being
        # ordinary configuration, "deny any run-wide podTemplate" would deny
        # everything: Tekton's defaulting webhook merges config-defaults'
        # default-pod-template in before Kyverno sees the request, so this field
        # is never actually absent. Residual fields are in the boundary note.
        - name: runWideEnvCount
          variable:
            jmesPath: "length(request.object.spec.taskRunTemplate.podTemplate.env || `[]`)"
            default: 0
        # Scheduling a scanner onto dedicated nodes is ordinary operations, so the
        # per-task podTemplate is judged by *key*: anything outside the scheduling
        # allowlist (env, volumes, dnsConfig, securityContext, ...) is denied, and
        # unknown future keys stay denied by default. Measured: a per-task
        # podTemplate is NOT filled in by Tekton's defaulting webhook, so an absent
        # one really is absent here (unlike the run-wide one).
        - name: gateOverrideCount
          variable:
            jmesPath: >-
              length((request.object.spec.taskRunSpecs || `[]`)[?pipelineTaskName=='trivy-scanner'
              && (serviceAccountName
              || length(keys(podTemplate || `{}`)) != length(keys(podTemplate || `{}`)[?contains(['nodeSelector','tolerations','affinity','imagePullSecrets','priorityClassName'], @)]))])
            default: 0
        - name: trivySkipped
          variable:
            # Absence inherits the template default "false". An explicitly supplied
            # value, including empty, must equal the exact when value "false".
            jmesPath: "skipTrivyPresent && skipTrivy != 'false'"
        # Structured gate parameters. Absence is meaningful here: the template
        # default already turns the gate on, so only an explicitly supplied value
        # can weaken it.
        - name: trivyExitCodeCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='trivyExitCode'])"
            default: 0
        - name: trivyExitCode
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExitCode'].value | [0] || ''"
            default: ""
        - name: trivySeverity
          variable:
            # array-typed; the default must be an empty list, not '', or every
            # comparison below silently changes meaning
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivySeverity'].value | [0] || `[]`"
        - name: trivyExtraArgs
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExtraArgs'].value | [0] || `[]`"
        - name: trivyGateOff
          variable:
            # Report-only mode is exactly what the parameter contract calls "" or
            # "0"; any other non-zero code still fails the run, so it is not a way
            # to turn the gate off. A garbage value is fail-closed too -- trivy
            # errors out and the task fails. Sites that want one fixed code can
            # tighten this to `trivyExitCode != '1'`.
            jmesPath: >-
              trivyExitCodeCount > `0`
              && (trivyExitCode == '' || trivyExitCode == '0')
        - name: trivySeverityBad
          variable:
            # An empty list means trivy evaluates its own default severity set,
            # which is wider than CRITICAL+HIGH -- stricter, so it passes. A pinned
            # list must still cover both.
            jmesPath: >-
              length(trivySeverity) > `0`
              && !(contains(trivySeverity, 'CRITICAL') && contains(trivySeverity, 'HIGH'))
        - name: trivyExtraArgsBad
          variable:
            # The structured parameters are the gate interface. Anything left in
            # extraArgs either duplicates them, making the effective gate depend on
            # flag order, or disables scanning outright -- --help makes trivy print
            # usage and exit 0 without scanning anything.
            jmesPath: "length(trivyExtraArgs) > `0`"
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: AnyIn
            value:
              - java-image-build-scan-deploy
              - python-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the Trivy vulnerability gate must stay enabled: keep skipTrivyScan at
          "false", keep trivyExitCode off report-only mode ("" or "0"), keep
          trivySeverity either empty or covering CRITICAL and HIGH, do not pass
          gate switches through trivyExtraArgs, and do not attach a podTemplate
          or serviceAccountName override to the scanner task.
        deny:
          conditions:
            any:
              - key: "{{ trivySkipped }}"
                operator: Equals
                value: true
              - key: "{{ gateOverrideCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ runWideEnvCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ trivyGateOff }}"
                operator: Equals
                value: true
              - key: "{{ trivySeverityBad }}"
                operator: Equals
                value: true
              - key: "{{ trivyExtraArgsBad }}"
                operator: Equals
                value: true
```

**The fifth criterion, `gateOverrideCount`, guards a different path that bypasses the parameter surface entirely**: a PipelineRun can attach overrides to a single task via `spec.taskRunSpecs`, and **`podTemplate.env` is injected into every step container of that task**. So a request with all parameters green, merely by carrying

```yaml
  taskRunSpecs:
    - pipelineTaskName: trivy-scanner
      podTemplate:
        env:
          - name: TRIVY_SEVERITY
            value: LOW
```

narrows the scan's effective severity to `LOW` only — while leaving the `trivySeverity` parameter empty is **compliant** (empty means trivy's own default set), so none of the four parameter criteria fires. Same for `serviceAccountName`: it changes what the gate step is allowed to do. **`stepSpecs` / `sidecarSpecs` carry only `computeResources`, so resource tuning stays allowed** — that class of override cannot change scan behavior, and denying it would be stricter than needed.

**This criterion judges by podTemplate "key", not "deny on attach"**: the group of **scheduling keys** — `nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName` — is allowed: steering the scan task onto nodes with caches or dedicated taints is everyday operations, and denying it is a false positive; every other key (`env`, `volumes`, `dnsConfig`, `securityContext`, `automountServiceAccountToken`, etc., plus **any key added in the future**) is denied. Writing it as an allowlist rather than a denylist is deliberate: new fields land on the deny side by default, which is safer than missing them. `serviceAccountName` remains denied outright — **if your site genuinely wants a dedicated SA for the scanner**, carve it out of this criterion and turn it into an approved list in the style of [§4.5.5](#s4-5-5) (`contains(['<approved-scanner-service-account>'], serviceAccountName)`); do not delete the whole condition.

**One difference that is easy to trip over**: a per-task `podTemplate` is **not** filled in by Tekton's defaulting (absence really is absence), while the run-level `taskRunTemplate.podTemplate` is **never empty** (defaulting merges in `default-pod-template`). So the same "judge by key" pattern works only on the per-task side; at run level only `env` can be judged, on its own.

**The sixth criterion, `runWideEnvCount`, plugs the run-level entrance to the same thing**: `spec.taskRunTemplate.podTemplate` applies to **every** TaskRun of this run, so setting env there is equivalent to targeting the gate task in `taskRunSpecs` — and a criterion that only looks at `taskRunSpecs` is completely blind to it. This one **judges `env` only**: `nodeSelector` / `imagePullSecrets` / `tolerations` in a run-level podTemplate are normal configuration, and guilt by association would cause massive false denials.

**Of the four parameter criteria, `trivySkipped` is the one most easily missed**: `skipTrivyScan` is not "an option of the scan" — it is the `when` guard on the `trivy-scanner` task. Set it to `"true"` and the task is never created at all, so the other three parameter criteria **all idle to false** and the policy allows the request anyway. **Judging the scan parameters without judging "does the scan run at all" is the same as not judging.**

The trade-offs of the remaining three criteria are in the comments; here we only stress the semantics of "absence" — the opposite of most allowlist criteria:

| Criterion | When the parameter is not passed | Why it is defined this way |
|---|---|---|
| `trivySkipped` | **Allow** | The template default is `skipTrivyScan: "false"` — not passing it means scanning; an explicit value must equal `"false"` exactly (any other value, empty string included, is denied) |
| `trivyGateOff` | **Allow** | The template default is `trivyExitCode: "1"` — not passing it means the gate is on. Per the parameter contract, **only `""` and `"0"` are report-only**, so the criterion denies only those two values — a non-zero code like `"2"` still fails the run and is no way to switch the gate off |
| `trivySeverityBad` | **Allow** | An empty list means trivy uses its own default severity set, which is wider than `CRITICAL`+`HIGH` — stricter, not looser |
| `trivyExtraArgsBad` | **Allow** | An empty array simply means "no extra arguments"; non-empty is always denied, see the comment |
| `gateOverrideCount` | **Allow** | No `taskRunSpecs` means no overrides; denied are only "a `podTemplate` outside the scheduling keys, **targeting the gate task**" and any `serviceAccountName` — overrides of other tasks, `computeResources`-class overrides, and a purely scheduling `podTemplate` on the gate task are all unaffected |
| `runWideEnvCount` | **Allow** | No run-level `taskRunTemplate.podTemplate.env` means no injection; **only the `env` item is judged** — run-level `nodeSelector` / `imagePullSecrets` etc. remain allowed |

**The precondition locks the full template identity** (`resolver` + `kind` + `catalog` + `name` + `version`), not just the name. Leave any one of them unlocked and "a same-named Pipeline from another source" falls into this rule's judgment scope — and that is an object with entirely different defaults. The converse also needs to be clear: **a request whose identity does not match skips — which means it is allowed**. "Only approved templates may be used" is a different concern, owned by the template allowlist in [§4.1.1](#s4-1-1); the two layers must be installed together.

:::warning This policy's promise boundary: only what the request explicitly writes

The precise statement is: it guarantees that **nobody switches the vulnerability gate off through the PipelineRun's parameters or per-task overrides** — `skipTrivyScan` cannot skip the scan, `trivyExitCode` cannot be set to the report-only `""` / `"0"`, `trivySeverity` cannot be narrowed to miss the high severities, `trivyExtraArgs` cannot smuggle bypass flags, the gate task cannot carry a `podTemplate` override **outside the scheduling keys** or any `serviceAccountName` override (scheduling keys are allowed, per the "judge by key" note above), and no environment variables can be injected via the run-level `taskRunTemplate.podTemplate.env`.

**There is one deliberately retained residual risk worth spelling out**: the run-level podTemplate is judged only on `env`, yet it also has `dnsConfig` / `securityContext` / `volumes` / `automountServiceAccountToken` and other fields — in theory these too can change the gate step's resolution, run identity, or readable files. The criterion does not condemn them by association, because that would also deny everyday configuration like `nodeSelector` / `imagePullSecrets`; stricter sites can fold those fields in using the same shape, **but think first about which normal requests that will deny**. **Moreover, one mechanism fact makes "deny any run-level podTemplate" outright unworkable**: Tekton's defaulting webhook runs before Kyverno and merges `config-defaults`' `default-pod-template` into every run (in this document's environment, `securityContext.fsGroup=65532`), so the `taskRunTemplate.podTemplate` seen at admission is **never empty** — judging the single `env` item is the only shape that is both effective and free of false positives.

**Run-level `spec.taskRunTemplate.serviceAccountName` is likewise not judged** — for a reason, and readers need to know where the boundary lies. `taskRunTemplate` has exactly two fields, `podTemplate` and `serviceAccountName` (verified with `kubectl explain`), and what this policy governs is the **scan verdict**: the gate step runs the Task's own fixed script, which does not use cluster credentials, so a broader run identity **does not change the scan conclusion** — the tasks that genuinely care about identity are **the ones that operate the cluster with credentials**, i.e. the deployment stage of [§4.5.5](#s4-5-5), where the run-level SA is governed by an approved list. Correspondingly, "who may create runs, and what permissions a run can obtain" belongs to the entry closure and RBAC of [§4.5.4](#s4-5-4) and is not within this policy's promise. **One adjacent trap**: at admission this field is always explicit (the defaulting webhook fills the SA in — taken from `config-defaults`' `default-service-account`, or Tekton's built-in default `default` when that key is missing), so a "deny if non-empty" pattern would deny **all** requests; to genuinely govern it, use an approved list as in [§4.5.5](#s4-5-5), and put the default value on the list.

A side note on `gateOverrideCount`'s **strictness boundary**: it denies "a `podTemplate` outside the scheduling keys, targeting the gate task" (`dnsConfig` can change registry resolution, `volumes` can shadow mount points, `env` changes scan behavior directly) plus any `serviceAccountName`; **the scheduling keys (`nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName`) are explicitly allowed**. The one remaining cost is that "a dedicated SA for the scanner" gets denied — **when that legitimate need arises, carve `serviceAccountName` out of this criterion and turn it into an approved list as in [§4.5.5](#s4-5-5)**; do not delete the whole condition.

It does **not** guarantee any of the following:

- **The scan scope has not been relaxed.** The `trivy-config` workspace can bind a ConfigMap you control and filter findings away via `trivy.yaml` or ignore rules — all parameters green, the gate "on", yet the result no longer represents the full vulnerability surface. Plugging this requires stacking the `trivy-config` workspace allowlist on top (in the full profile; the criterion is `trivyConfigBad`), and the allowlist only governs "which object is bound" — **the object's content still relies on the admission and review of the configuration object itself**.
- **The scan actually ran to completion.** `--help`-style arguments make trivy exit 0 without producing a report; that class is only visible to [§4.4.1](#s4-4-1) reading the `status` of `trivy-summary-metadata`.
- **Evidence left on the platform side.** The same [§4.4.1](#s4-4-1) layer.
- **Every image built was scanned.** The template hands the **whole `images` array** to build-image (`$(params.images[*])`) but only **`images[0]`** to trivy (`scanTargets: [$(params.images[0])]`), and deployment also uses only `images[0]`. So a request with multiple elements in `images` **builds and pushes several unscanned images** — and the minimal version **does not judge the element count of `images`**. "The gate is on" still holds; "every image in the registry passed the gate" does not. The full profile's `imagesBad` therefore requires **exactly one** element (that is not over-strictness — it plugs this gap); to genuinely support multiple images, make the template scan each one, or add a separate audit policy of "every image must have a matching scan record".

In other words: the minimal version stops "the switch being flipped"; the full profile adds "uncontrolled configuration entrances"; [§4.4.1](#s4-4-1) adds "did it actually run, and what did it report". Three layers, each owning its stretch.

:::

##### Then the full profile: take it by group — no need to copy everything

The policy above governs exactly one thing, the vulnerability gate. The full profile welds shut the other governance surfaces of the same template as well, **with the criteria divided into groups that do not depend on one another** — take what your actual governance scope needs; deleting one group does not affect the others:

| Criterion group | Contains | What deleting it loses |
|---|---|---|
| **Trivy gate** | `trivySkipped` / `trivyGateOff` / `trivySeverityBad` / `trivyExtraArgsBad` / `gateOverrideCount` / `runWideEnvCount` | Exactly the **six** criteria of the minimal version — **none of the six can go**: without `trivySkipped`, a single `skipTrivyScan: "true"` idles the other three; without `gateOverrideCount` or `runWideEnvCount`, one `podTemplate.env` (attached per task or per run) changes scan behavior while all parameters stay green |
| **Sonar gate** | `sonarBad` / `sonarPropertiesBad` / `sonarProjectKeyBad` | The code scan can be skipped wholesale via an empty `sonarURL`, or hollowed out by a `sonarProperties` entry overriding a governed key (endpoint / project identity / branch anchor) |
| **Hub source identity** | `hubSourceBad` | A request can bring its own `url` and pull a same-named template from outside; the allowlist becomes decoration |
| **Scan target and transport** | `imagesBad` / `tlsVerifyBad` / `trivySkipped` | Several images can be pushed with only the first scanned; `--insecure` can be enabled; the trivy task can be skipped entirely |
| **Build inputs** | `mavenExecutionInputsBad` etc. / `pythonBuildInputsBad` | What executes during the build is decided by the requester (change goals, swap the build image, inject a pre-build script) |
| **Optional workspace allowlist** | `sonarCredentialsBad` / `trivyConfigBad` / `pipConfBad` etc. | The configuration entrances go uncontrolled; `trivy-config` in particular directly affects the scan scope — deleting it means the scan can be relaxed even with every gate parameter green |

**The group most likely to need per-environment tailoring is the last one** — the object names in the allowlist must be replaced with your own approved Secrets / ConfigMaps, and for workspaces that do not exist in your environment, simply delete the corresponding criterion.

**The key criteria** — each group computes its own boolean, and `deny.conditions.any` denies on any hit:

```yaml
        # (1) Source identity: request-level url / multiple type params / a non-artifact type
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
      validate:
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"          # (1) source was swapped
                operator: Equals
                value: true
              # (2) a gate is not actually enabled
              #     (empty sonarURL / skipTrivyScan != "false" / trivyExitCode turned off)
              # (3) the effective configuration was hollowed out
              #     (governed-key entries in sonarProperties / tlsVerify / images
              #      / trivySeverity / trivyExtraArgs)
              # (4) a workspace source is not in the approved list
              # ...every condition is in the full YAML below
```

:::details Full policy YAML: official-template-gates-on

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: official-template-gates-on
spec:
  background: false
  rules:
    - name: quality-gates-must-stay-enabled
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
        - name: sonarURL
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='sonarURL'].value | [0] || ''"
            default: ""
        - name: sonarProjectKeyCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='sonarProjectKey'])"
        - name: tlsVerifyCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='tlsVerify'])"
        - name: tlsVerify
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='tlsVerify'].value | [0] || ''"
            default: ""
        - name: imagesCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='images'])"
        - name: scanImages
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='images'].value | [0] || `[]`"
        - name: skipTrivy
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='skipTrivyScan'].value | [0] || ''"
            default: ""
        - name: skipTrivyPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='skipTrivyScan']) > `0`"
        - name: sonarCredentialsCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='sonar-credentials'])"
        - name: sonarCredentialsWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='sonar-credentials'] | [0] || `{}`"
        - name: sonarCredentialsSecret
          variable:
            jmesPath: "sonarCredentialsWorkspace.secret.secretName || ''"
            default: ""
        - name: sonarSettingsCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='sonar-settings'])"
        - name: sonarSettingsWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='sonar-settings'] | [0] || `{}`"
        - name: sonarSettingsConfigMap
          variable:
            jmesPath: "sonarSettingsWorkspace.configMap.name || ''"
            default: ""
        - name: registryConfigCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='registry-config'])"
        - name: registryConfigWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='registry-config'] | [0] || `{}`"
        - name: registryConfigSecret
          variable:
            jmesPath: "registryConfigWorkspace.secret.secretName || ''"
            default: ""
        - name: sonarCertificateCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='sonar-certificate'])"
        - name: sonarCertificateWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='sonar-certificate'] | [0] || `{}`"
        - name: sonarCertificateConfigMap
          variable:
            jmesPath: "sonarCertificateWorkspace.configMap.name || ''"
            default: ""
        - name: caBundleCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='ca-bundle'])"
        - name: caBundleWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='ca-bundle'] | [0] || `{}`"
        - name: trivyConfigCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='trivy-config'])"
        - name: trivyConfigWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='trivy-config'] | [0] || `{}`"
        - name: trivyConfigConfigMap
          variable:
            jmesPath: "trivyConfigWorkspace.configMap.name || ''"
            default: ""
        - name: caBundleConfigMap
          variable:
            jmesPath: "caBundleWorkspace.configMap.name || ''"
            default: ""
        # compute verdicts INSIDE JMESPath (exact string compare) to avoid the Kyverno
        # operator type-coercion gotcha where NotEquals treats "1" as if it equalled "false"
        - name: sonarBad
          variable:
            # Non-empty is insufficient: use the approved quality-gate endpoint.
            jmesPath: "sonarURL != '<approved-sonar-url>'"
        # Content, not presence: sonarProperties is the ONLY way to pass legitimate
        # analysis settings (exclusions, coverage report paths), and the platform
        # injects the sonar.pullrequest.* group through it on every triggered run --
        # banning the param outright would deny that whole class (the §4.2.4 lesson).
        # Scanner 0.7 merges these entries AFTER sonarHostURL / sonarProjectKey and
        # BEFORE the quality-gate normalisation, so exactly three governed keys can be
        # overridden here; sonar.qualitygate.* cannot (normalised last) but is listed
        # anyway so a future reordering cannot silently open it.
        - name: sonarPropsItems
          variable:
            jmesPath: "to_array((request.object.spec.params || `[]`)[?name=='sonarProperties'].value | [0] || `[]`)[].to_string(@)"
            default: []
        - name: sonarPropertiesBad
          variable:
            jmesPath: >-
              length(sonarPropsItems[?starts_with(@, 'sonar.host.url=')
                || starts_with(@, 'sonar.projectKey=')
                || starts_with(@, 'sonar.branch.name=')
                || starts_with(@, 'sonar.login=')
                || starts_with(@, 'sonar.token=')
                || starts_with(@, 'sonar.password=')
                || starts_with(@, 'sonar.qualitygate.')]) > `0`
        - name: sonarProjectKeyBad
          variable:
            # Absence uses the Pipeline's repository-derived default.
            jmesPath: "sonarProjectKeyCount > `0`"
        # A per-task override travels in the same request and is invisible to
        # every parameter judgment: podTemplate.env reaches every step container
        # (so it can narrow trivy's severity filter without touching a param),
        # and serviceAccountName changes what the gate step may do. stepSpecs /
        # sidecarSpecs carry computeResources only, so resource tuning stays
        # allowed -- rejecting that would be stricter than the gate needs.
        # The run-wide equivalent: taskRunTemplate.podTemplate applies to every
        # TaskRun of this run, so env set here reaches the governed task too.
        # Only env is judged. Besides nodeSelector / imagePullSecrets being
        # ordinary configuration, "deny any run-wide podTemplate" would deny
        # everything: Tekton's defaulting webhook merges config-defaults'
        # default-pod-template in before Kyverno sees the request, so this field
        # is never actually absent. Residual fields are in the boundary note.
        - name: runWideEnvCount
          variable:
            jmesPath: "length(request.object.spec.taskRunTemplate.podTemplate.env || `[]`)"
            default: 0
        - name: gateOverrideCount
          variable:
            jmesPath: >-
              length((request.object.spec.taskRunSpecs || `[]`)[?contains(['trivy-scanner','sonarqube-scanner'], pipelineTaskName)
              && (serviceAccountName
              || length(keys(podTemplate || `{}`)) != length(keys(podTemplate || `{}`)[?contains(['nodeSelector','tolerations','affinity','imagePullSecrets','priorityClassName'], @)]))])
            default: 0
        - name: trivySkipped
          variable:
            # Absence uses the Pipeline default "false". An explicitly supplied
            # value, including empty, must equal the exact when value "false".
            jmesPath: "skipTrivyPresent && skipTrivy != 'false'"
        - name: tlsVerifyBad
          variable:
            # Absence inherits true; explicit values must be exactly true.
            jmesPath: "tlsVerifyCount > `1` || (tlsVerifyCount == `1` && tlsVerify != 'true')"
        - name: imagesBad
          variable:
            # Buildah pushes every element but Trivy scans only images[0].
            jmesPath: >-
              imagesCount != `1`
              || length(scanImages) != `1`
              || length(scanImages[?regex_match('^[-A-Za-z0-9._:/@+]+$', @) == `false`]) > `0`
        - name: sonarCredentialsBad
          variable:
            jmesPath: >-
              sonarCredentialsCount > `1`
              || (sonarCredentialsCount == `1`
              && sonarCredentialsSecret != 'approved-sonar-credentials')
        - name: sonarSettingsBad
          variable:
            jmesPath: >-
              sonarSettingsCount > `1`
              || (sonarSettingsCount == `1`
              && sonarSettingsConfigMap != 'approved-sonar-settings')
        - name: registryConfigBad
          variable:
            jmesPath: >-
              registryConfigCount > `1`
              || (registryConfigCount == `1`
              && registryConfigSecret != 'approved-registry-config')
        - name: sonarCertificateBad
          variable:
            jmesPath: >-
              sonarCertificateCount > `1`
              || (sonarCertificateCount == `1`
              && sonarCertificateConfigMap != 'approved-sonar-certificate')
        - name: trivyConfigBad
          variable:
            # Absence is fine: without the workspace the Task falls back to its own
            # defaults. Bound to anything other than the reviewed ConfigMap -- including
            # a PVC or Secret, where configMap.name resolves to '' -- is a violation,
            # because trivy.yaml and the ignore file both relax the scan.
            jmesPath: >-
              trivyConfigCount > `1`
              || (trivyConfigCount == `1`
              && trivyConfigConfigMap != 'approved-trivy-config')
        - name: caBundleBad
          variable:
            jmesPath: >-
              caBundleCount > `1`
              || (caBundleCount == `1`
              && caBundleConfigMap != 'approved-ca-bundle')
        # Structured Trivy gate parameters. Absence is meaningful: the template
        # default already turns the gate on, so only an explicit value can weaken it.
        - name: trivyExitCodeCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='trivyExitCode'])"
            default: 0
        - name: trivyExitCode
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExitCode'].value | [0] || ''"
            default: ""
        - name: trivySeverity
          variable:
            # array-typed; the default must be an empty list, not '', or every
            # comparison below silently changes meaning
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivySeverity'].value | [0] || `[]`"
        - name: trivyExtraArgs
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='trivyExtraArgs'].value | [0] || `[]`"
        - name: trivyGateOff
          variable:
            # Report-only mode is exactly what the parameter contract calls "" or
            # "0"; any other non-zero code still fails the run, so it is not a way
            # to turn the gate off. A garbage value is fail-closed too -- trivy
            # errors out and the task fails. Sites that want one fixed code can
            # tighten this to `trivyExitCode != '1'`.
            jmesPath: >-
              trivyExitCodeCount > `0`
              && (trivyExitCode == '' || trivyExitCode == '0')
        - name: trivySeverityBad
          variable:
            # An empty list means trivy evaluates its own default severity set,
            # which is wider than CRITICAL+HIGH -- stricter, so it passes. A pinned
            # list must still cover both.
            jmesPath: >-
              length(trivySeverity) > `0`
              && !(contains(trivySeverity, 'CRITICAL') && contains(trivySeverity, 'HIGH'))
        - name: trivyExtraArgsBad
          variable:
            # The structured parameters are the gate interface. Anything left in
            # extraArgs either duplicates them, making the effective gate depend on
            # flag order, or disables scanning outright -- --help makes trivy print
            # usage and exit 0 without scanning anything.
            jmesPath: "length(trivyExtraArgs) > `0`"
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: AnyIn
            value:
              - java-image-build-scan-deploy
              - python-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the official template must keep its quality gates enabled: an approved
          Sonar endpoint, no sonarProperties entry overriding a governed key
          (sonar.host.url / sonar.projectKey / sonar.branch.name / credentials
          / sonar.qualitygate.*), no sonarProjectKey override, skipTrivyScan
          exactly "false", the Trivy gate kept out of report-only mode
          (trivyExitCode neither empty nor "0"), trivySeverity empty or covering
          CRITICAL and HIGH, no gate switches in trivyExtraArgs,
          TLS verification on, exactly one shell-safe image, and reviewed objects
          behind every optional workspace.
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarPropertiesBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarProjectKeyBad }}"
                operator: Equals
                value: true
              - key: "{{ trivySkipped }}"
                operator: Equals
                value: true
              - key: "{{ gateOverrideCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ runWideEnvCount }}"
                operator: NotEquals
                value: 0
              - key: "{{ trivyGateOff }}"
                operator: Equals
                value: true
              - key: "{{ trivySeverityBad }}"
                operator: Equals
                value: true
              - key: "{{ trivyExtraArgsBad }}"
                operator: Equals
                value: true
              - key: "{{ tlsVerifyBad }}"
                operator: Equals
                value: true
              - key: "{{ imagesBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarCredentialsBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarSettingsBad }}"
                operator: Equals
                value: true
              - key: "{{ registryConfigBad }}"
                operator: Equals
                value: true
              - key: "{{ sonarCertificateBad }}"
                operator: Equals
                value: true
              - key: "{{ trivyConfigBad }}"
                operator: Equals
                value: true
              - key: "{{ caBundleBad }}"
                operator: Equals
                value: true
    - name: java-build-inputs-must-stay-approved
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: mavenSubdirectoryCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenSubdirectory'])"
        - name: mavenGoalsCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenGoals'])"
        - name: mavenImageCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenImage'])"
        - name: mavenMirrorURLPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenMirrorURL']) > `0`"
        - name: mavenMirrorURL
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='mavenMirrorURL'].value | [0] || ''"
            default: ""
        - name: mavenCertPathPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='mavenCertPath']) > `0`"
        - name: mavenCertPath
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='mavenCertPath'].value | [0] || ''"
            default: ""
        - name: mavenSettingsCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-settings'])"
        - name: mavenSettingsWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-settings'] | [0] || `{}`"
        - name: mavenSettingsConfigMap
          variable:
            jmesPath: "mavenSettingsWorkspace.configMap.name || ''"
            default: ""
        - name: mavenCertCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-cert'])"
        - name: mavenCertWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-cert'] | [0] || `{}`"
        - name: mavenCertConfigMap
          variable:
            jmesPath: "mavenCertWorkspace.configMap.name || ''"
            default: ""
        - name: mavenServerSecretCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-server-secret'])"
        - name: mavenServerSecretWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-server-secret'] | [0] || `{}`"
        - name: mavenServerSecret
          variable:
            jmesPath: "mavenServerSecretWorkspace.secret.secretName || ''"
            default: ""
        - name: mavenLocalRepoCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-local-repo'])"
        - name: mavenLocalRepoWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-local-repo'] | [0] || `{}`"
        - name: mavenLocalRepoPVC
          variable:
            jmesPath: "mavenLocalRepoWorkspace.persistentVolumeClaim.claimName || ''"
            default: ""
        - name: mavenTrustStoreCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='maven-trust-store'])"
        - name: mavenTrustStoreWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='maven-trust-store'] | [0] || `{}`"
        - name: mavenTrustStoreSecret
          variable:
            jmesPath: "mavenTrustStoreWorkspace.secret.secretName || ''"
            default: ""
        - name: mavenExecutionInputsBad
          variable:
            # Absence preserves the pinned root/package/image defaults.
            jmesPath: >-
              mavenSubdirectoryCount > `0`
              || mavenGoalsCount > `0`
              || mavenImageCount > `0`
        - name: mavenMirrorURLBad
          variable:
            # Missing/empty uses the trusted default; explicit endpoints are allowlisted.
            jmesPath: "mavenMirrorURLPresent && mavenMirrorURL != '' && mavenMirrorURL != '<approved-maven-mirror-url>'"
        - name: mavenCertPathBad
          variable:
            # Missing inherits the pinned default ca.cert; explicit values are exact.
            jmesPath: "mavenCertPathPresent && mavenCertPath != '<approved-maven-cert-path>'"
        - name: mavenSettingsBad
          variable:
            # Maven copies a bound settings.xml before generated mirror handling.
            jmesPath: >-
              mavenSettingsCount > `1`
              || (mavenSettingsCount == `1`
              && mavenSettingsConfigMap != 'approved-maven-settings')
        - name: mavenCertBad
          variable:
            jmesPath: >-
              mavenCertCount > `1`
              || (mavenCertCount == `1`
              && mavenCertConfigMap != 'approved-maven-cert')
        - name: mavenServerSecretBad
          variable:
            jmesPath: >-
              mavenServerSecretCount > `1`
              || (mavenServerSecretCount == `1`
              && mavenServerSecret != 'approved-maven-server')
        - name: mavenLocalRepoBad
          variable:
            jmesPath: >-
              mavenLocalRepoCount > `1`
              || (mavenLocalRepoCount == `1`
              && mavenLocalRepoPVC != 'approved-maven-local-repo')
        - name: mavenTrustStoreBad
          variable:
            jmesPath: >-
              mavenTrustStoreCount > `1`
              || (mavenTrustStoreCount == `1`
              && mavenTrustStoreSecret != 'approved-maven-trust-store')
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: Equals
            value: java-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the java template must not override Maven execution inputs and must bind
          only reviewed objects to the Maven workspaces.
        deny:
          conditions:
            any:
              - key: "{{ mavenExecutionInputsBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenMirrorURLBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenCertPathBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenSettingsBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenCertBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenServerSecretBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenLocalRepoBad }}"
                operator: Equals
                value: true
              - key: "{{ mavenTrustStoreBad }}"
                operator: Equals
                value: true
    - name: python-build-inputs-must-stay-approved
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: resolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: refKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: refCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: refName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: refVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: preBuildScriptCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildScript'])"
        - name: pythonImageCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='pythonImage'])"
        - name: preBuildArgsCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildArgs'])"
        - name: preBuildRequirementsFileCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildRequirementsFile'])"
        - name: preBuildPipConfFileCount
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='preBuildPipConfFile'])"
        - name: pipConfCount
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='pip-conf'])"
        - name: pipConfWorkspace
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='pip-conf'] | [0] || `{}`"
        - name: pipConfConfigMap
          variable:
            jmesPath: "pipConfWorkspace.configMap.name || ''"
            default: ""
        - name: pythonBuildInputsBad
          variable:
            # The pre-build script and its interpreter image decide what actually
            # runs before the image is built, so the approved profile forbids
            # overriding them at request time.
            jmesPath: >-
              preBuildScriptCount > `0`
              || pythonImageCount > `0`
              || preBuildArgsCount > `0`
              || preBuildRequirementsFileCount > `0`
              || preBuildPipConfFileCount > `0`
        - name: pipConfBad
          variable:
            # pip.conf redirects package resolution, so an unreviewed binding is a
            # supply-chain input. Not binding it at all is fine.
            jmesPath: >-
              pipConfCount > `1`
              || (pipConfCount == `1`
              && pipConfConfigMap != 'approved-pip-conf')
      preconditions:
        all:
          - key: "{{ resolver }}"
            operator: Equals
            value: hub
          - key: "{{ refKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ refCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ refName }}"
            operator: Equals
            value: python-image-build-scan-deploy
          - key: "{{ refVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          the python template must not override pre-build execution inputs and must
          bind only the reviewed ConfigMap to pip-conf.
        deny:
          conditions:
            any:
              - key: "{{ pythonBuildInputsBad }}"
                operator: Equals
                value: true
              - key: "{{ pipConfBad }}"
                operator: Equals
                value: true
```

:::

:::details Self-check cases: after installing the policy, go through them one by one with --dry-run=server

Build one PipelineRun per row and submit it with `kubectl create --dry-run=server`; check whether the outcome matches "Expected". A mismatch means your policy differs from this section's — investigate along the last column.

| What you submit | Expected |
|---|---|
| The fully approved profile + all approved workspaces; and the same profile with a single explicit `type=artifact` | Allow |
| `trivyExitCode` / `trivySeverity` not passed (inheriting the template defaults, gate on) | Allow |
| The approved quadruple plus a request-level `url`, or an explicit `type=tekton` | Deny |
| Blank / unapproved Sonar endpoint; an explicit `sonarProjectKey` override | Deny |
| `sonarProperties` containing an entry that overrides a governed key (any hit among `sonar.host.url=` / `sonar.projectKey=` / `sonar.branch.name=` / the credential keys / the `sonar.qualitygate.` prefix) | Deny |
| `sonarProperties` containing only legitimate analysis settings (e.g. `sonar.exclusions=**/vendor/**`) or the platform-injected `sonar.pullrequest.*` group | Allow |
| `sonarProperties` passed as an **object** (type regression) | Allow — after per-element `to_string(@)` no governed-key prefix matches; no policy error is produced |
| An illegal `skipTrivyScan` | Deny |
| `trivyExitCode` explicitly set to `"0"` or an empty string (report-only, i.e. gate off) | Deny |
| `trivyExitCode` set to another non-zero code (e.g. `"2"`) | Allow — per the contract it still fails the run |
| `trivySeverity` non-empty but not covering both `CRITICAL` and `HIGH` | Deny |
| `trivyExtraArgs` non-empty — whether a no-report invocation like `["--help"]` or a duplicated `--exit-code` / `--severity` | Deny |
| `tlsVerify=false`, or `tlsVerify` as shell text | Deny |
| `images` missing / unsafe / multi-element | Deny |
| Build-input parameters overridden (java's `mavenSubdirectory` / `mavenGoals` / `mavenImage`; python's `preBuildScript` / `pythonImage`) | Deny |
| Unapproved or wrong-source-type Sonar credentials / settings / certificate, Maven settings / cert / server / local-repo, registry config, CA bundle, plus the conservatively restricted `maven-trust-store` | Deny |
| `trivy-config` not bound; or bound to the approved ConfigMap | Allow |
| `trivy-config` bound to a different ConfigMap; or bound as a PVC (`configMap.name` comes back empty) | Denied |
| A `taskRunSpecs[].podTemplate` attached to a gate task (`trivy-scanner` / `sonarqube-scanner`) containing **scheduling keys only** (`nodeSelector` / `tolerations`, etc.) | Allowed |
| `env` / `volumes` / `dnsConfig` in the same place (even mixed in with scheduling keys), or a `serviceAccountName` | All denied |
| The same overrides attached to a **different** task; or `computeResources` via `stepSpecs` on a gate task | Allowed |
| Run-level `taskRunTemplate.podTemplate.env`; versus a run-level `nodeSelector` only | Denied / Allowed |

**Where to look first when the outcome does not match**: everything allowed → most likely the precondition never matched; first check that the `pipelineRef` four-tuple (catalog / kind / name / version) matches what you submitted. Something that should be allowed gets denied → see which criterion the denial message names; most likely the object names in the workspace allowlist differ from the ones in your environment.

This set verifies the **contract visible at admission**; it does not prove that the Task actually consumes these workspaces at runtime (for example, it does not prove that Maven will go read `maven-trust-store`).

:::

:::warning Upgrade order: the policy must be upgraded together with the template, or compliant requests get denied by your own policy

This criterion pins the template's parameter surface. Once the template introduces new gate parameters (say, moving from "stuff the switch into `trivyExtraArgs`" to the structured `trivyExitCode` / `trivySeverity`), **a policy written against the old parameter surface does not "let things slip through" — it starts denying every compliant request**: the old criterion requires `trivyExtraArgs` to exactly equal some list, while under the new convention that parameter is supposed to be empty.

The symptom is that after the upgrade, pipelines are **stuck at admission across the board**, with the denial messages coming from your own ClusterPolicy. So when upgrading a template, follow this order:

1. First inspect the new template version's parameter surface. **Which copy to fetch depends on how the template is referenced**:
   - An in-cluster `Pipeline` object (`resolver: cluster`) — on **the cluster that runs Tekton**, `kubectl -n <ns> get pipeline <name> -o yaml`;
   - A template referenced via the hub / git resolver — it is **not a `Pipeline` resource in the cluster**, and `kubectl get pipeline` returns `NotFound` outright. Either fetch it from the hub / catalog side, or use the resolved result of one real run: `kubectl -n <ns> get pipelinerun <one-real-run> -o jsonpath='{.status.pipelineSpec}'` — that copy is the definition **actually in effect**;
2. Update the policy criteria, and confirm with `--dry-run=server` that the new version's compliant form is allowed through;
3. Only then switch the template version, updating the pinned `refVersion` value in step.

Doing it the other way around — switch the template first, fix the policy later — makes the interim window **deny-everything** rather than allow-everything: a large blast radius, but not a silent one, and therefore the safer direction to fail in.

:::

:::warning Capability boundary of this section

The policy can only constrain the **parameters and workspace references visible at PipelineRun admission**. The `sonar-project.properties` inside the source workspace, the actual contents of the approved Secret / ConfigMap / PVC, and whether the image was really built from the expected source must be constrained by trusted templates, configuration-object admission, and supply-chain attestation respectively — **do not mistake "references an approved object" for "the object's contents have been audited"**.

:::

**Relationship to [§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)**: early blocking governs "the parameter's value at the PipelineRun level"; the main path governs "the effective value ultimately expanded into the task". The two stack — early blocking improves the experience, while the TaskRun layer backstops every template shape.

#### 4.2.6 Injecting defaults (mutate) {#s4-2-6}

- **What it governs**: injecting platform defaults (a governance label, a default timeout) into PipelineRuns that did not set them explicitly.
- **Why it is hard**: the injection must not override the caller's explicit choices — otherwise it turns from "filling in defaults" into "forcibly rewriting user input".
- **How the policy is layered**: every injected field uses the `+()` anchor (add-if-absent) without exception — the label key and the `timeouts` field **both** need it; a plain label key would forcibly overwrite the caller's explicit value.
- **What it cannot govern**: mutate produces no PolicyReport violation records (same as [§4.2.3](#s4-2-3)); it is completion, not validation.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-run-defaults
spec:
  background: false
  rules:
    - name: inject-label-and-default-timeout
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              +(policy.alauda.io/gated): "true"
          spec:
            +(timeouts):
              pipeline: 1h0m0s
```

**Expected shape** (observe the mutation result directly with `--dry-run=server -o yaml`): a run without `timeouts` comes back with `policy.alauda.io/gated: "true"` and `timeouts.pipeline: 1h0m0s` in the output object; a run that explicitly wrote `timeouts.pipeline: 30m0s` keeps `30m0s`; a run that explicitly wrote `policy.alauda.io/gated: "false"` keeps `"false"`. It applies to resolver-referenced runs just the same.

#### Cleanup (§4.2)

Clean up per the two rules in [§4.0.4](#s4-0-4):

:::warning The first three policies are mutually exclusive alternatives — do not verify with them installed simultaneously

`gate-param-contract` (deny, [§4.2.1](#s4-2-1)), `gate-param-cancel-existing` (mutate-existing cancelling the parent run, [§4.2.2](#s4-2-2)), and `gate-param-mutate-to-cancel` (admission mutate cancelling the gate TaskRun, [§4.2.3](#s4-2-3)) are **three responses to the same non-compliant input**; in production, pick **exactly one** per the comparison table in [§4.2.3](#s4-2-3). With all three installed at once, the deny blocks the gate TaskRun's CREATE first, and the `Cancelled` terminal state the other two policies expect **never appears** — when verifying section by section, install one, verify it, delete it, or you will wrongly conclude the other two "don't work".

:::

Delete the seven cluster-scoped policies by name (**mind the mutual-exclusion note above** — verifying section by section means installing and deleting one at a time, so by this point only the ones you still have installed will remain).

⚠️ **The first `get` below is not a formality — its output decides which names go into the second `delete`** ([§4.0.4](#s4-0-4)'s look-before-delete): delete only **the ones you installed in this walkthrough** — any policy whose `creationTimestamp` falls outside your walkthrough window is someone else's governance rule; **remove it** from the `delete` name list before running. Be extra careful if you only ran one section of this chapter: the other six names are quite possibly not yours at all, and copying the whole `delete` verbatim on a shared cluster deletes policies that are in effect.

```bash
# §4.0.4's look-before-delete: cluster-scoped, so one glance at when they were created.
kubectl get clusterpolicy gate-param-contract gate-param-cancel-existing \
  gate-param-mutate-to-cancel sonar-branch-analysis-branch-contract \
  trivy-gate-must-stay-on official-template-gates-on pipeline-run-defaults \
  --ignore-not-found \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'
kubectl delete clusterpolicy gate-param-contract gate-param-cancel-existing \
  gate-param-mutate-to-cancel sonar-branch-analysis-branch-contract \
  trivy-gate-must-stay-on official-template-gates-on pipeline-run-defaults \
  --ignore-not-found
# The two runtime fixtures: their PolicyReport rows would otherwise read as this
# section's verdicts on a later section's re-run (§4.0.5).
kubectl delete pipelinerun -n policy-poc gate-cancel-invalid gate-cancel-compliant \
  --ignore-not-found
```

The `Role/kyverno-background-pipelineruns` in `policy-poc` and the RoleBinding of the same name are reclaimed by the namespace's cascading deletion; no separate delete is needed.

### 4.3 Genuine quality-gate failure (contracts 3–6 landed on the template side) {#s4-3}

**The general contract**: a hard gate's "failure" happens inside the pipeline — the gate task reads the preceding results, exits 1 when the bar is missed, Tekton natively marks the run `Failed`, and the tasks ordered after the gate are skipped by the DAG. Kyverno contributes **no new policy** in this section: its contribution lies in [§4.1](#s4-1) (guaranteeing template identity) and [§4.2](#s4-2) (guaranteeing gate parameters); the failure itself does not need to be — and must not be — manufactured by the admission system (the anti-mechanism of [§2.2](#s2-2)).

The template design checklist (the [§2.3](#s2-3) contracts as they land on template authors):

- **Data binding / gate cohesion** (contract 4): a self-gating scanner (such as `sonarqube-scanner`, or the [§3.3](#s3-3) fixture) keeps "read the data under test + judge it against the rules + fail itself when below the bar" cohesive inside a **single task** — the gate switches `enableScanQualityGate` / `enableAnalyzeQualityGate` plus the rules `analyzeQualityGateRules` are its contract. If your gate is a **standalone gate task** (consuming upstream results), wire the effective value into the gate explicitly with `$(tasks.<producer>.results.<name>)` instead;
- **DAG dominance** (contract 5): every release / push / promotion task `runAfter` the gate task (self-gating scanner or standalone gate; directly or transitively). The gate can only stop its successors — **whatever the tasks before or parallel to the gate have already executed will not be rolled back**. All side effects must be ordered after the gate; this is a template design responsibility that admission cannot remedy after the fact;
- **Must-run** (contract 3): leave the gate no skip path. A self-gating scanner's opt-out surface is "set the switch to `false`" (welded shut by [§4.2.1](#s4-2-1)) and "hang a `when` / an empty matrix on `scan` to skip it" (backstopped by the [§4.1.5](#s4-1-5) `skippedTasks` Audit); reference-style templates additionally have the "parameter-triggered wholesale skip" anti-pattern (e.g. `sonarURL` defaulting to empty + `when: sonarURL notin ["", " "]` ⇒ omit the parameter and the whole scan stage is skipped) — the fix follows the same idea: weld the parameter shut on the policy side, tighten the default on the template side, and add a drift Audit on top;
- **finally safety** (contract 6): finally executes on failure, or on cancellation via `CancelledRunFinally`; a plain `Cancelled` does not guarantee that finally tasks not yet started will be scheduled. Do not put any gate-protected side effect in finally.

**Baseline shape**: run the [§3.3](#s3-3) self-gating fixture with `coverage: "30"` (rule `coverage>=80`, `enableAnalyzeQualityGate=true`) —

- `scan`'s task-side quality gate misses → **the task itself does `exit 1`**, writing out `code-scan-results.result=Failed` (the real 0.7 Task checks SonarQube's `alert_status` internally, but that internal field is not part of the output contract);
- the PipelineRun's terminal state is **`Failed`**;
- `skippedTasks: [{name: release, reason: PipelineRun was stopping}]` — the release was physically never created;
- the finally `notify` executes successfully as usual.

This is the baseline shape of "a self-gating scanner dominating the release": the gate and the data under test are cohesive in the single `scan` task, and `release` transitively `runAfter`s it. The native gating capability of the platform catalog Tasks works the same way — with `sonarqube-scanner` (0.7), a miss on `enableScanQualityGate` / `enableAnalyzeQualityGate` means the task fails itself. **Mind the governance layer of these two switches**: neither official 0.3 template **exposes them as Pipeline parameters** — the Task-side default `"true"` takes effect — so a PipelineRun-level policy like [§4.2.5](#s4-2-5)'s **can neither see them nor pin them**; pinning is only possible at the TaskRun layer ([§4.2.1](#s4-2-1) / [§4.2.4](#s4-2-4)) — and note that the `spec.params` of a controller-created TaskRun likewise contains only the parameters the Pipeline explicitly passed, so a switch that is not passed through shows up at admission as **absent** (the Task default fills it in only at runtime), and the TaskRun-level criterion is therefore written as "deny only when explicitly passed and ≠ `true`; allow absence" (the shape of rule ② in [§4.2.4](#s4-2-4)). The day the template exposes them, the PipelineRun layer must gain the corresponding criteria; `trivy-scanner` (0.6) fails on above-threshold vulnerabilities via its exit code — the official templates control it through the `trivyExitCode` parameter, **whose default is `"1"`, i.e. the gate is on by default**; what the policy has to prevent is it being explicitly switched off to `"0"` or empty (see [§4.2.5](#s4-2-5)).

:::info The two official templates differ in DAG shape: which stages are ordered after the gate

**The vulnerability gate itself is on by default**: the template's `trivyExitCode` defaults to `"1"`, so when vulnerabilities matching `trivySeverity` are found, `trivy-scanner` fails and the pipeline fails with it. So "vulnerabilities slipped through and nobody knows" is not the worry here — the worry is **the stages ordered before the gate that have already produced side effects**.

Compare the two templates' real DAGs:

| | `sonarqube-scanner` | `build-image` | `deploy-or-upgrade` |
|---|---|---|---|
| java 0.3 | `runAfter: [maven]` | `runAfter: [maven]` (**parallel** with sonar) | `runAfter: [trivy-scanner]` |
| python 0.3 | `runAfter: [git-clone]` | `runAfter: [git-clone, pre-build]` | `runAfter: [sonarqube-scanner, trivy-scanner]` |

The difference is **whether "the Sonar verdict dominates release" is expressed in the DAG**: python 0.3 expresses it, java 0.3 does not. In addition, `build-image` in both templates runs parallel to Sonar — that is, **the image push is not ordered after the Sonar verdict**.

Whether that counts as a problem depends on which requirement you hold:

- If the requirement is **"quality problems must be seen and handled promptly"** — the official templates already suffice: a gate failure fails the whole pipeline, which blocks things as early as the PR stage; layer the result Audit of [§4.4.1](#s4-4-1) on top to leave platform-side evidence.
- If the requirement is **"the Sonar verdict must strictly dominate image push / release"** (the strong form of contract 5) — then either pick a template whose DAG already expresses that ordering (python 0.3's release side does), or add the `runAfter` on the template side, or use the shape of the [§3.3](#s3-3) fixture, which packs the gate and the data under test into one task.

:::

#### Cleanup (§4.3)

This section **creates no Kyverno objects** — it is a template-design checklist, not a policy asset. The only thing that lands in the cluster is the `coverage: "30"` PipelineRun from the "baseline shape" above — it lives in your self-created `policy-poc`, under whatever name you picked at creation time: cascading namespace deletion will reclaim it; if you are continuing with the later sections, delete it first under the name you used, so its PolicyReport rows do not interfere with the next section ([§4.0.5](#s4-0-5)). The `gated-build` template and the fixture Task themselves belong to [§3.3](#s3-3) — do not delete them if later chapters still need them.

### 4.4 Result Audit and PolicyReport (the after-the-fact line of defense) {#s4-4}

**The contract common to this chapter**: a task's run results (coverage, vulnerability counts, scan verdicts) exist only in the `results` of `TaskRun/status` ([§2.1](#s2-1), observation point 6). This observation point is **Audit-only** — its value is turning "which pipelines' results missed the bar" into PolicyReport records that are queryable and reportable in the cluster, complementing the hard failures of [§4.3](#s4-3): **hard failure does the blocking, Audit does the seeing**.

Two points that run through this chapter:

- **Terminal-state guard**: one run triggers many status UPDATEs, and results only appear near completion. Skipping the early events with "the target result is non-empty" reads conveniently, but it is **not a genuine terminal-state test** — if a Task has reached a terminal state yet **wrote no result** (it crashed, wrote garbage, was skipped), the non-empty test **silently skips** it, missing exactly the objects that most deserve attention. The correct form is to **first establish that the Task is terminal from the `Succeeded` entry of `status.conditions`**, then split three ways: result compliant = pass, result below the bar = fail, **result missing / malformed = fail** (fail-closed).
- **This chapter demonstrates two consumption shapes** (the three declared result types are in [§2.4](#s2-4)): object results, consumed by JMESPath drill-down ([§4.4.1](#s4-4-1), **recommended** — the two scanning Tasks in the catalog, sonar and trivy, both already provide them); and aggregate strings (the convention layered on `type: string`), parsed with `split` + `to_number` ([§4.4.2](#s4-4-2), **a compatibility measure**, only for when the target Task cannot be changed in the short term).

**Map of this section**:

- **[§4.4.1](#s4-4-1) The main shape** — object-result verdict audit (two real shapes, sonar and trivy), **the recommended form**; read it first.
- **[§4.4.2](#s4-4-2)** — the splitting paradigm for aggregate-string results: **a compatibility measure, not recommended** — only for when the target Task cannot be changed in the short term.
- **[§4.4.3](#s4-4-3)** — the counterexample: why you must never Enforce on status (the run wedges — it neither fails nor ends, and only manual intervention frees it; see [§6.1.4](#s6-1-4)).
- **[§4.4.4](#s4-4-4)** — taking stock of what already exists (background scans), and how to confirm how long the evidence stays queryable in the cluster.

#### 4.4.1 Object-result verdict audit (two real shapes, sonar and trivy) {#s4-4-1}

The two most commonly consumed scanning Tasks in the catalog both publish object results already, and consuming them looks the same: **drill straight down to the property with JMESPath** — no string slicing, no regex, no `to_number`. What needs auditing differs between them — sonar hands you a **verdict** (passed or not), trivy hands you a set of **counts plus an overall status** (did the scan succeed, and how much did it find) — so the layering of the judgment differs too; they are covered separately below.

##### The sonar shape: the scan verdict (`code-scan-results.result`)

- **What it governs**: **whether the scan verdict was actually a pass** — book-keep the verdict the scanner produces (object result `code-scan-results.result`) run by run; any run whose `code-scan-results.result` is not `Succeeded` counts as a violation. This is an Audit-class policy: it only produces PolicyReport entries and blocks no request (Enforce on status wedges, see [§4.4.3](#s4-4-3)).
- **Why it is hard**: the object under judgment is **status**, and status gets written many times; the naive "only judge when the result is non-empty" waves through "terminal yet never wrote a result" — exactly the objects most worth catching. On top of that, Kyverno's comparison operators coerce numeric-looking strings — a `NotEquals Succeeded` form silently allows the malformed verdict `"1"` ([§6.1.7](#s6-1-7)).
- **How the policy is layered**: ① lock onto the trusted scanner with the complete `taskRef` coordinates (no match → skip; no collateral damage) → ② evaluate only when **`status.conditions[Succeeded]` ∈ {True, False}**, i.e. already terminal → ③ judge with an **exact regex** on `^Succeeded$` — non-`Succeeded` values, illegal values, **and a terminal run with the result missing** all count as fail.
- **What it cannot govern**: it only answers "what was this run's verdict", not "did the scan itself actually do anything" (that rests on the gate-parameter contract of [§4.2](#s4-2)); and when switching to the hub `sonarqube-scanner`, the version must be locked along with the name — 0.5 publishes the uppercase `CODE_SCAN_RESULTS`, 0.7 the lowercase one; without the version lock, a normal 0.5 result is treated as "0.7's result is missing" and misreported as fail.

The object result `code-scan-results` declared by `sonarqube-scanner` (0.7) carries four properties — `result` / `reportURL` / `taskID` / `projectID` — of which `result` is the scan verdict, with the real value range `Succeeded` (pass) / `Failed` / `Skipped` / `Canceled`.

**The key criterion** — terminal-state guard plus exact string verdict; neither can be dropped:

```yaml
        # Terminal test as a JMESPath boolean (a comparison returns a real boolean).
        # Do NOT hand the strings "True"/"False" to a Kyverno operator -- operator
        # coercion swallows those (§6.1.7). Count the terminal conditions instead of
        # reading [0]: a decoy Unknown entry ahead of the real one would otherwise
        # make the whole rule skip (§4.4.1).
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Compare the exact string inside JMESPath. Kyverno condition operators coerce
        # numeric-looking strings, so `NotEquals Succeeded` would fail open on the
        # malformed verdict "1"
        # Every lookup below takes [0] of a filtered list, and status.results has no
        # uniqueness guarantee (the CRD declares it atomic, not a keyed list), so a
        # decoy entry carrying the same name in front of the real one would be read
        # instead. Require exactly one of each; anything else is malformed.
        - name: verdictResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='code-scan-results'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: verdictIsSucceeded
          variable:
            jmesPath: >-
              regex_match(
                '^Succeeded$',
                (request.object.status.results || `[]`)[?name=='code-scan-results'].value.result | [0] || ''
              )
      preconditions:
        all:
          # ...(full taskRef identity omitted)
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              # Once terminal, only Succeeded passes; malformed values and a missing
              # result (verdict == '') both fail closed
              # the verdict or the terminal condition is not unambiguous
              - key: "{{ verdictResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ verdictIsSucceeded }}"
                operator: Equals
                value: false
```

:::details Full policy YAML: scan-verdict-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: scan-verdict-audit
spec:
  background: false
  rules:
    - name: sonar-verdict-must-pass
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        # Scope only by the complete taskRef identity. Controller-owned-looking labels are
        # not trusted because PipelineRun taskRunSpecs can override child TaskRun labels.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskRefName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Terminal-guarded fail-closed: decide whether the TaskRun already reached a
        # terminal state (Succeeded condition True/False, not Unknown) BEFORE reading
        # the verdict, so "terminal but no result written" is never silently skipped.
        # Terminal test as a JMESPath boolean (a comparison returns a real boolean)
        # instead of handing the strings "True"/"False" to a Kyverno operator; operator
        # coercion swallows the latter (see FAQ on JMESPath pitfalls). Count terminal
        # conditions rather than reading [0] -- see the duplicate-condition warning
        # in §4.4.1.
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        - name: verdict
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='code-scan-results'].value.result | [0] || ''"
            default: ""
        # Compare the exact string inside JMESPath. Kyverno condition operators
        # coerce numeric-looking strings, so `NotEquals Succeeded` can fail-open
        # for an invalid verdict such as "1" (§6.1.7).
        # Every lookup below takes [0] of a filtered list, and status.results has no
        # uniqueness guarantee (the CRD declares it atomic, not a keyed list), so a
        # decoy entry carrying the same name in front of the real one would be read
        # instead. Require exactly one of each; anything else is malformed.
        - name: verdictResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='code-scan-results'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: verdictIsSucceeded
          variable:
            jmesPath: >-
              regex_match(
                '^Succeeded$',
                (request.object.status.results || `[]`)[?name=='code-scan-results'].value.result | [0] || ''
              )
      preconditions:
        all:
          # DEMO PROFILE: exact cluster-resolver fixture identity.
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskRefName }}"
            operator: Equals
            value: policy-demo-scanner
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          # evaluate ONLY on a terminal TaskRun. Earlier writes (Succeeded=Unknown / Running)
          # are skipped; a terminal run is always judged.
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        failureAction: Audit
        message: "SonarQube scan verdict is '{{ verdict }}' on a terminal TaskRun (expected Succeeded); missing / illegal verdict is fail-closed."
        deny:
          conditions:
            any:
              # real sonarqube-scanner ScanResult.Result = Succeeded (pass) / Failed / Skipped /
              # Canceled. Anything but Succeeded — INCLUDING a missing '' verdict on a terminal
              # TaskRun — is a violation. This is the fail-closed core: no silent skip.
              # the verdict or the terminal condition is not unambiguous
              - key: "{{ verdictResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ verdictIsSucceeded }}"
                operator: Equals
                value: false
```

:::

**When switching to the production hub reference**, the complete `taskRef` profile must change with it — `resolver=hub`, `catalog=catalog`, `kind=task`, `name=sonarqube-scanner`, `version=0.7` — and child TaskRun labels must be ignored entirely. 0.5 and 0.7 share the same Task name, but 0.5 publishes the uppercase `CODE_SCAN_RESULTS` while 0.7 publishes the lowercase `code-scan-results` — without the version lock, a normal 0.5 result is treated as "0.7's result is missing" and misreported as fail.

:::warning Value-range correction: alert_status is not code-scan-results.result

SonarQube's internal `alert_status=OK/ERROR` is **not** the `code-scan-results.result` that `sonarqube-scanner` 0.7 emits. The real `ScanResult.Result` value range is `Succeeded` / `Failed` / `Skipped` / `Canceled` (verify in the console under **Pipelines → Tasks** by opening the Task's README, "ScanResult Output" section).

Judging with `!= "OK"` would misclassify **every single** real 0.7 run as fail.

:::

##### The trivy shape: vulnerability aggregation and overall status (`trivy-summary-metadata`)

- **What it governs**: the results of image / filesystem scans must be book-kept — this example judges "any CRITICAL present" as below the bar, and **also** counts runs that **never scanned successfully at all** as below the bar.
- **Why it is hard**: in this Task's result, "are there vulnerabilities" and "did the scan succeed" are **two independent dimensions** — reading only one of them is guaranteed fail-open. Three traps: ① **when the scan fails, the count fields still read `0`** (not empty, not a dash) — judging only `critical > 0` treats "never scanned at all" as "zero vulnerabilities" and allows it through; ② **findings do not mean the Task failed**: 0.6 defaults to trivy's own `--exit-code 0`, so a run that found CRITICALs still shows a green TaskRun — that the vulnerabilities are over the bar is **invisible** at the pipeline level and can only be read out of the result; ③ **a call like `--help` — exit code 0 but no report produced — turns the TaskRun green**, yet the result's `status` is written as `failed` — which is exactly why this section can catch it while watching only the TaskRun terminal state cannot.
- **How the policy is layered**: ① lock onto the trusted Task with the complete hub `taskRef` coordinates → ② terminal-state guard (as in the previous subsection) → ③ **first test whether `status` is one of the "produced a usable report" values** → ④ cross-check that `failed` must be `0` (it and `status` corroborate each other) → ⑤ then confirm with a regex that the count is a bounded non-negative integer → ⑥ only after boundedness is confirmed does `to_number` compare against the threshold. Anything "unreadable" is judged below the bar.
- **What it cannot govern**: it only answers "what this scan reported", not "was the scan target right" (whether `scanTargets` really points at the image this build produced belongs to the parameter contract of [§4.2](#s4-2)); nor "should this vulnerability be exempted" (that belongs to `.trivyignore` and security review). It is also an Audit-class policy: it only produces PolicyReport entries and blocks no request (Enforce on status wedges, see [§4.4.3](#s4-4-3)).

The object result `trivy-summary-metadata` declared by `trivy-scanner` (0.6) carries 11 properties, all of type **string**:

| property | Meaning | How the policy uses it |
|---|---|---|
| `status` | The overall status of this scan; value range `passed` / `findings` / `failed` / `unknown` | **The first-tier criterion**: only `passed` / `findings` mean "a usable report was produced"; `failed` (at least one target could not be scanned) and `unknown` (**not one target scanned, or the counts unobtainable**) must be judged below the bar |
| `critical` / `high` / `medium` / `low` / `unknown` | The **full aggregate** count per severity level | Threshold criteria; bound them as non-negative integers with a regex before `to_number` |
| `total` | The sum across levels | Same as above; usable as a coarse "any findings at all" test |
| `scanType` | `image` / `fs` / `config` / `sbom` / a passed-through custom subcommand | The routing key when thresholds must differ per scan type |
| `targets` / `scanned` / `failed` | Total targets / scanned / failed | Use when "partial failure" must be distinguished more finely than `status` allows |

The first element of the same-named `trivy-summary` (array) is a string mirror of **the same aggregate**, provided for Overview rendering; both are generated from one internal state and cannot drift apart. **On the policy side, always use the object one** — do not parse the string one (that is the compatibility path of [§4.4.2](#s4-4-2)).

:::warning status and the counts must be judged together

The five typical run shapes of `trivy-scanner` 0.6, and the traces each leaves:

| Scenario | TaskRun terminal state | `status` | `critical` |
|---|---|---|---|
| Scan completed, zero findings | Succeeded | `passed` | `0` |
| Scan completed with findings, gate not enabled | **Succeeded** | `findings` | `1` |
| Scan completed with findings, `extraArgs` carries `--exit-code 1` | Failed | `findings` | `1` |
| `extraArgs` passes `--help` (exit 0 but no report produced) | **Succeeded** | **`failed`** | `0` |
| trivy itself errors (cannot pull the vulnerability DB / image not found) | Failed | `failed` | `0` |

Three corollaries: ① **`critical=0` does not mean safe** — the last two rows both carry `critical` `0`; judging by the count alone waves them straight through; ② **a green TaskRun does not mean a scan happened** — rows two and four are both green; ③ making vulnerabilities genuinely **stop** the pipeline relies on the gate parameter on the template — both official 0.3 templates default `trivyExitCode` to `"1"`, so by default they do stop; what needs defending against is it being explicitly switched to `"0"` / the empty string, or `skipTrivyScan` skipping the whole scan (see [§4.2.5](#s4-2-5)). The Audit in this section is only responsible for **seeing**.

The four `status` values have a clear division of labor — do not conflate them: `passed` is "every target scanned, zero findings"; `findings` is "scanned, vulnerabilities present"; `failed` is "at least one target could not be scanned"; `unknown` has **two** causes — not one target was scanned, **or the counts are simply unobtainable** (the Task's `compute_scan_status` returns the same value for both). To distinguish "partial failure" more finely than `status`, read the three counts `targets` / `scanned` / `failed` — by contract `scanned` includes the failed targets, and the number of usable reports is `scanned - failed`.

**The dash (`-`) really does appear in the count fields.** When counts are unobtainable (for example, a custom `toolImage` missing a JSON parser), the Task writes `total` / `critical` / `high` / `medium` / `low` / `unknown` **all as `"-"`** rather than `0` — and the code comments state this is **deliberate**: writing `0` would be misread as "clean, zero findings". The per-target lines of the `trivy-summary` array likewise use a dash to mark that line's report as missing.

**So the regex guard below is not optional defense in depth — it is required**: it keeps the dash and empty values out of `to_number`, matching exactly this real path. It also explains why `status` and the counts **must be judged together** — on the counts-unobtainable path, `status` is `unknown` and the counts are `-`; the two signals arrive as a pair.

:::

**The key criterion** — status guard first, regex guard in the middle, `to_number` last:

```yaml
        # Terminal guard first, same shape as the sonar excerpt above: counted, not
        # [0]-indexed, so a decoy Unknown condition cannot disarm it (see the
        # warning after this policy)
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Every lookup below takes [0] of a filtered list, so a second entry with the
        # same name or type would be invisible. Require exactly one of each.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary-metadata'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        # The raw counter, kept as a variable so the deny message and the threshold
        # comparison both read the same value.
        - name: criticalRaw
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''"
            default: ""
        # Only these two states mean "trivy produced a usable report". failed / unknown /
        # a missing result must never be read as a clean scan.
        - name: scanStatusUsable
          variable:
            jmesPath: >-
              regex_match(
                '^(passed|findings)$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.status | [0] || ''
              )
        # Cross-check the per-target failure counter against status: defence in depth
        # against a summary that claims "findings" while admitting a failed target.
        - name: noTargetFailed
          variable:
            jmesPath: >-
              regex_match(
                '^0$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.failed | [0] || ''
              )
        # Bounded non-negative integer only; the task writes '-' when counts are
        # unavailable, and '-' must stay out of to_number.
        - name: criticalIsNumeric
          variable:
            jmesPath: >-
              regex_match(
                '^[0-9]{1,9}$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''
              )
      preconditions:
        all:
          # ...(full hub taskRef identity omitted -- catalog / trivy-scanner / 0.6;
          # this is the precondition the warning below points at)
          # Terminal guard: while the run is still executing (results not written
          # yet) this precondition fails and the rule SKIPS -- the NotEquals-1
          # counts below never fire on an in-flight status write
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              # (1) every lookup below takes [0] of a filtered list, so a duplicate
              #     entry would be invisible -- require exactly one of each
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # (2) the scan never produced a usable report, or wrote no result at all
              - key: "{{ scanStatusUsable }}"
                operator: Equals
                value: false
              # (3) at least one target failed to produce a report
              - key: "{{ noTargetFailed }}"
                operator: Equals
                value: false
              # (4) counts unreadable ('-', empty, malformed) -> never treated as zero
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # (5) only a validated numeric value reaches to_number
              - key: "{{ criticalIsNumeric && to_number(criticalRaw) > `0` }}"
                operator: Equals
                value: true
```

:::warning What this policy trusts is "whatever the controller wrote into status"

It reads the result out of the TaskRun status, so its strength ends at "who can write that status". The policy itself cannot tell whether a result was genuinely produced by a scan or forged into place — so two things must accompany it:

- **In RBAC, do not grant business identities write access to `taskruns/status`** (normally only the Tekton controller writes it);
- **Lock the Task identity down to the version** (the precondition above already locks `catalog/trivy-scanner/0.6`); otherwise a same-named substitute Task can produce its own "compliant" result.

The cross-check between `failed` and `status` is the **defense in depth** on this line, not a substitute: it stops the crude forgery that edits only the `status` field, but not an adversary who rewrites the entire summary consistently. To go stricter, add `scanned == targets` and pin `scanType` as well — but **every addition must be walked through its positive and negative cases in your own environment** — what this section gives is the behavior of the criteria above.

:::

:::details Full policy YAML: vuln-summary-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: vuln-summary-audit
spec:
  background: false
  rules:
    - name: trivy-summary-metadata-must-pass
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        # Scope by the complete hub taskRef identity; child labels are not trusted.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: hubCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: hubKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: hubName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: hubVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        # Terminal guard first: reading the result before the TaskRun settles would
        # silently skip the runs that finished without writing any result at all.
        # It counts terminal conditions instead of reading [0], because a precondition
        # that reads [0] can be disarmed by a duplicate condition (see the warning
        # right after this policy).
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Every lookup below takes [0] of a filtered list, so a second entry with the
        # same name or type would be invisible. Require exactly one of each and treat
        # anything else as malformed rather than reading the first one and moving on.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary-metadata'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        # Object result: drill straight into the property, no split/regex parsing.
        - name: scanStatus
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.status | [0] || ''"
            default: ""
        - name: criticalRaw
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''"
            default: ""
        - name: failedRaw
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.failed | [0] || ''"
            default: ""
        # Only these two states mean "trivy produced a usable report". failed / unknown /
        # a missing result must never be read as a clean scan.
        - name: scanStatusUsable
          variable:
            jmesPath: >-
              regex_match(
                '^(passed|findings)$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.status | [0] || ''
              )
        # Cross-check the per-target failure counter against status. The two are
        # written from one internal state today, so this is defence in depth: it
        # keeps a hand-written or tampered summary from claiming "findings" while
        # admitting that a target never produced a report.
        - name: noTargetFailed
          variable:
            jmesPath: >-
              regex_match(
                '^0$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.failed | [0] || ''
              )
        # Bounded non-negative integer only; the task writes '-' when counts are
        # unavailable, and '-' must stay out of to_number.
        - name: criticalIsNumeric
          variable:
            jmesPath: >-
              regex_match(
                '^[0-9]{1,9}$',
                (request.object.status.results || `[]`)[?name=='trivy-summary-metadata'].value.critical | [0] || ''
              )
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ hubCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ hubKind }}"
            operator: Equals
            value: task
          - key: "{{ hubName }}"
            operator: Equals
            value: trivy-scanner
          - key: "{{ hubVersion }}"
            operator: Equals
            value: "0.6"
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        failureAction: Audit
        message: "trivy-summary-metadata on a terminal TaskRun reports status='{{ scanStatus }}' failed='{{ failedRaw }}' critical='{{ criticalRaw }}' (expected status passed/findings, failed 0 and critical 0); an unusable or missing summary is fail-closed."
        deny:
          conditions:
            any:
              # (1) the summary or the terminal condition is not unambiguous
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # (2) the scan never produced a usable report, or wrote no result at all
              - key: "{{ scanStatusUsable }}"
                operator: Equals
                value: false
              # (3) at least one target failed to produce a report
              - key: "{{ noTargetFailed }}"
                operator: Equals
                value: false
              # (4) counts unreadable ('-', empty, malformed) -> never treated as zero
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # (5) only a validated numeric value reaches to_number
              - key: "{{ criticalIsNumeric && to_number(criticalRaw) > `0` }}"
                operator: Equals
                value: true
```

:::

:::warning Never take [0] when reading status: one forged same-named entry disarms the whole rule

**Both `status.conditions` and `status.results` are written by controllers, and Kubernetes puts no uniqueness constraint on either.** In the `taskruns.tekton.dev` schema, `status.conditions` is a bare `type: array`, and `status.results` is `x-kubernetes-list-type: atomic` — `atomic` means "the whole list is replaced as a unit", **not** "deduplicated by key". Neither carries `x-kubernetes-list-type: map`. So a same-named entry can perfectly well appear twice: the echo of `kubectl patch --subresource=status --dry-run=server` shows both entries, and the API server accepts them as-is (a later controller reconcile will normalize them, but **at the admission moment** what is seen is the two entries — and admission is exactly when the policy evaluates).

This is the counterpart of [§4.2.5](#s4-2-5)'s "`[0]` on `spec.params` is safe": same-named duplicates in `spec.params`, `pipelineRef.params`, and `spec.workspaces` are all rejected by **Tekton's own validation webhook** (the verbatim error is in [§4.2.5](#s4-2-5)); the status side has no equivalent guarantee. **"Verified on `spec`" must never be extrapolated to "safe on `status` too".**

So if the terminal criterion is written as `[?type=='Succeeded'].status | [0]`, inserting one fake condition with `status: Unknown` **ahead of** the real one makes `isTerminal` `false` — the precondition is unmet → **the whole rule skips**, and the `succeededConditionCount != 1` guard further down never gets a chance to run. That is fail-open.

Take a terminal TaskRun that would be denied, replay its status verbatim as the control group, then add just one decoy — everything else untouched — as the experiment group. The three policies behave as follows:

| Policy under attack | Decoy construction | Control | Experiment (old form) | Experiment (hardened) |
|---|---|---|---|---|
| [§4.4.1](#s4-4-1) trivy shape (a `critical=1` run) | Insert `Succeeded=Unknown` at the front of `conditions` | Denied | **Allowed** | Denied |
| [§4.4.1](#s4-4-1) sonar shape (a `result=Failed` run) | Insert a same-named entry with `result=Succeeded` at the front of `results` | Denied | **Allowed** | Denied |
| [§4.4.2](#s4-4-2) string shape (a `critical=9` run) | Insert a same-named `critical=0` string at the front of `results` | Denied | **Allowed** | Denied |

The hardening does not hit normal runs: a clean run replayed verbatim is still allowed; insert a decoy into it and it is denied — the "duplicated entry" is itself the violation.

That is why the `isTerminal` above **counts the terminal conditions** instead of taking `[0]`:

```yaml
length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`
```

This way `[Unknown, True]` still judges as terminal and proceeds into `deny`, where `succeededConditionCount != 1` then judges the duplicated condition itself as a violation. **Residual boundary**: with both entries `Unknown` it still skips — that genuinely is not terminal yet, and it will be caught once it settles; an attacker who can pin the status at `Unknown` long-term already holds status write access, and that is RBAC's boundary, not this policy's (see the earlier warning in this subsection, "What this policy trusts is 'whatever the controller wrote into status'").

**Reading results needs the same guard.** Every policy in this document that reads `status.results` requires "exactly one entry for the target result": the `summaryResultCount` of the trivy shape and the `verdictResultCount` of the sonar shape in [§4.4.1](#s4-4-1), the `summaryResultCount` of [§4.4.2](#s4-4-2), plus each one's `succeededConditionCount` — all wired into `deny.conditions.any`. **Declaring the variable without wiring it in equals not adding it** — and this guard is precisely the kind most easily left unwired, because with it missing every normal sample still passes.

**The same fix must be applied to every policy that uses `isTerminal` as a precondition** — [§4.4.1](#s4-4-1) (both shapes), [§4.4.2](#s4-4-2), and [§4.6.1](#s4-6-1) in this document have all been switched to the counting form.

:::

:::details How to reproduce the construction (and why PolicyReport cannot be used to read the conclusion)

**Run this on the cluster that runs Tekton and Kyverno.** PolicyReport is eventually consistent: when the verdict for one status UPDATE gets written into the report is not guaranteed, so **a conclusion cannot be attributed to one specific request**. To obtain a synchronous, attributable verdict, temporarily install an **Enforce copy used solely for measurement**, pin it to the probe objects with a label, and read the return of `--dry-run=server` directly — nothing is persisted:

```bash
# 1. Derive the measurement copy from the live Audit policy -- do NOT hand-edit a
#    second copy of that YAML, or the thing you measure stops being the thing you run.
#    Exactly three edits: rename, flip every rule to Enforce, and pin EVERY rule to
#    the probe label so the Enforce copy can only ever see the object you labelled.
#    The flip writes rule-level validate.failureAction and drops the deprecated
#    top-level field if the live object still carries one (rule-level wins, but a
#    stale top-level line would only confuse whoever reads the copy).
#    ⚠️ A measurement device, not a deployment recommendation -- the §4.4 red line
#    (never Enforce on */status) still stands, so it matches only labelled probe objects and is deleted right after use.
MEASUREMENT_POLICY_NAME=vuln-summary-audit-probe-enforce
kubectl get clusterpolicy vuln-summary-audit -o json \
  | jq --arg n "$MEASUREMENT_POLICY_NAME" '
      {apiVersion, kind, metadata: {name: $n}, spec}
      | del(.spec.validationFailureAction)
      | .spec.rules |= map(.validate.failureAction = "Enforce")
      | .spec.rules |= map(.match.any[0].resources.selector.matchLabels.probe = "dupcond")
    ' > "$MEASUREMENT_POLICY_NAME.json"
# `create`, not `apply` (§4.0.4): a same-named policy already on the cluster is somebody
# else's Enforce rule on */status, and overwriting it is exactly the accident this
# section warns about -- an AlreadyExists here means STOP, not retry.
kubectl create -f "$MEASUREMENT_POLICY_NAME.json"
# It is not installed until it is Ready -- an unready policy simply does not evaluate,
# and step 3 would then be "not denied" for a reason that has nothing to do with the rule.
kubectl wait --for=condition=Ready "clusterpolicy/$MEASUREMENT_POLICY_NAME" --timeout=60s

# 2. Pick a terminal TaskRun with critical=1; its name is set only here (steps 3, 4, 5 all reference it)
TERMINAL_TASKRUN='<terminal-taskrun>'
kubectl -n policy-poc label taskrun "$TERMINAL_TASKRUN" probe=dupcond --overwrite

# 3. Replay its status verbatim (control group)
kubectl -n policy-poc get taskrun "$TERMINAL_TASKRUN" -o json   | jq '{status}' > normal.json
kubectl -n policy-poc patch taskrun "$TERMINAL_TASKRUN"   --subresource=status --type=merge --patch-file normal.json --dry-run=server

# 4. Insert a single decoy Unknown at the front of conditions (experiment group)
jq '.status.conditions = ([.status.conditions[0] | .status="Unknown" | .reason="Running"] + .status.conditions)'   normal.json > dup.json
kubectl -n policy-poc patch taskrun "$TERMINAL_TASKRUN"   --subresource=status --type=merge --patch-file dup.json --dry-run=server

# 5. Delete the measurement copy when done and remove the label. The §4.0.4 pre-delete check:
#    the name is this document's dedicated probe name; just confirm its creationTimestamp falls after step 1 above.
kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" \
  -o jsonpath='{.metadata.creationTimestamp} {.metadata.name}{"\n"}'
kubectl delete clusterpolicy "$MEASUREMENT_POLICY_NAME"
kubectl -n policy-poc label taskrun "$TERMINAL_TASKRUN" probe-
```

| Step | Old form (`[0]`) expectation | New form (counting) expectation | Where to look first on a mismatch |
|---|---|---|---|
| 3 control | Denied (deny fires) | Denied | Not denied = this TaskRun's `critical` is not `>0`, or the policy did not match: start with `kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" -o yaml` and check the `match` namespace / selector and the five hub-identity items |
| 4 experiment | **Allowed** (reproduces the fail-open) | Denied | If it is still allowed under the new form: first `kubectl get clusterpolicy "$MEASUREMENT_POLICY_NAME" -o jsonpath='{.spec.rules[0].context[?(@.name=="isTerminal")]}'` to confirm the line in effect really is the counting one (it only counts as installed once step 1's `kubectl wait` passed); then confirm the decoy entry really sits **in front** (placed behind, it is ineffective against the `[0]` form to begin with and constitutes no control) |
| 5 wrap-up | — | — | Forgetting to delete the measurement copy = an Enforce rule left on `*/status`, which will wedge objects carrying that label: confirm with `kubectl get clusterpolicy` that it is gone |

The hardening does not change the verdicts on normal shapes: run the seven standard shapes of the next details block through the same "verbatim replay + `--dry-run=server`", and the counting form and the `[0]` form give identical conclusions (allow / allow / deny / deny / deny / allow (skip) / deny). In other words, it **only** closes off the forged-condition path.

:::

:::details Self-check cases: what each of the seven run shapes should be judged as

| Probe | Produced `status` / `critical` | Expected PolicyReport |
|---|---|---|
| Scan a clean image | `passed` / `0` | pass |
| Findings, but CRITICAL filtered out by severity | `findings` / `0` | pass |
| CRITICAL found | `findings` / `1` | fail |
| CRITICAL found and `extraArgs` carries `--exit-code 1` (TaskRun fails) | `findings` / `1` | fail |
| `extraArgs` passes `--help` (TaskRun succeeds but no report produced) | `failed` / `0` | fail |
| trivy itself errors (cannot pull the vulnerability DB) | `failed` / `0` | fail |
| An unrelated TaskRun in the same namespace (not the trivy identity) | no such result | skip (no collateral damage) |

**How to reproduce** (run everything on **the cluster that runs Tekton and Kyverno**; where the two are deployed separately, that means the workload cluster, not the global management cluster):

The details block below, "The two minimal YAMLs for reproduction", gives the complete YAML for the source fixture and one probe. The first six probes change **only `params`** on top of it; the last one — the no-collateral control — is the exception: it must be replaced with an **unrelated TaskRun using an inline `taskSpec`** (its `taskRef` no longer pointing at `trivy-scanner`; otherwise the identity still matches and proves nothing about collateral damage). Save the full policy above as `vuln-summary-audit.yaml`, and the fixture and the probe as `trivy-source-fixture-cm.yaml` and `probe-findings-critical.yaml` respectively, then:

```bash
# 1. Install the policy (Audit; blocks no request)
# `create`, not `apply` (§4.0.4): a same-named ClusterPolicy is somebody else's
# governance rule, and an AlreadyExists here means STOP, not overwrite.
kubectl create -f vuln-summary-audit.yaml

# 2. Every probe except "clean image" needs no vulnerability DB: scanType=fs + scanners=[secret]
#    on a source ConfigMap holding fake keys finishes in seconds. Per probe, change only these params:
#      findings + CRITICAL      -> scanners=[secret]
#      findings, no CRITICAL    -> scanners=[secret] + severity=[HIGH]
#      gate takes effect        -> also add extraArgs=["--exit-code","1"]
#      no-scan bypass           -> extraArgs=["--help"]
#      scan failure             -> scanType=image pointing at an unpullable image
#      no-collateral control    -> an unrelated TaskRun with inline taskSpec
kubectl apply -n policy-poc -f trivy-source-fixture-cm.yaml
kubectl create -n policy-poc -f probe-findings-critical.yaml

# 3. The "clean image" probe really scans an image: explicitly set your environment's
#    vulnerability-DB image address, or the default pulls from the public internet and
#    is guaranteed to time out in an air-gapped environment (add the dbRepository / javaDbRepository params to the TaskRun)

# 4. Read the verdicts
kubectl get policyreport -n policy-poc \
  -o custom-columns=SUBJECT:.scope.name,RESULT:.results[*].result
```

:::

:::details The two minimal YAMLs for reproduction (source fixture + one probe)

`trivy-source-fixture-cm.yaml` — a source directory holding fake keys, used to produce findings reliably without network access and without pulling the vulnerability DB:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: trivy-source-fixture
  namespace: policy-poc
data:
  source-a.txt: |
    GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD
    SLACK_BOT_TOKEN=xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx
  source-b.txt: |
    hello catalog
```

`probe-findings-critical.yaml` — the "CRITICAL found" probe; the other probes change only `params` on top of it:

```yaml
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  generateName: probe-findings-critical-
  namespace: policy-poc
spec:
  timeout: 15m
  taskRef:
    resolver: hub
    params:
      - name: catalog
        value: catalog
      - name: kind
        value: task
      - name: name
        value: trivy-scanner
      - name: version
        value: "0.6"
  params:
    - name: scanType
      value: fs
    - name: scanTargets
      value:
        - .
    - name: scanners
      value:
        - secret
  workspaces:
    - name: source
      configMap:
        name: trivy-source-fixture
```

:::

**Where to look first when the results do not match**: everything recorded as `skip` → most likely the `taskRef` identity did not match (this policy is locked to `catalog/trivy-scanner/0.6`; switching versions or switching to the cluster resolver both produce skips); a `pass` where you expected `fail` → first run `kubectl -n <ns> get taskrun <name> -o jsonpath='{.status.results}'` to see what `trivy-summary-metadata` actually contains, then compare it against the criteria above; stuck at `skip` while the TaskRun is still `Running` → the terminal-state guard is doing its job — wait for the terminal state and read again.

While we are at it, this is what the terminal-state guard looks like in action: the `trivy`-errored case is recorded as `skip` (`preconditions not met`) while the run is **still `Running`**, and only flips to `fail` once it lands in a terminal state. That is exactly the desired behavior — no verdict is rendered on an intermediate status, and "the result has not been written yet" causes neither a false alarm nor a permanent silence.

:::warning PolicyReport is best-effort, not a complete ledger

Occasionally you will see an entry like this: the TaskRun has reached its terminal state and `trivy-summary-metadata` is fully written, yet in the PolicyReport it **sits at `skip`** (`preconditions not met`), with a timestamp right at the second the run went terminal — the evaluation at the terminal moment failed to land in the report. The very same run shape is recorded as `fail` the vast majority of the time, so this is a low-frequency missed record, not a mistake in the criteria.

The reason: `*/status` policies are evaluated only at the admission moment, and with `background: false` there is **no background backstop** ([§4.4.4](#s4-4-4)) — once an evaluation is lost on the reporting path, there is no chance to compensate.

**This dictates how PolicyReport may be used**: it works for **discovering** problems (a `fail` always means a real problem), but it **cannot be turned around and used as proof of compliance** — "no fail entries" does not equal "no violating runs". For any "everything must be compliant before release" decision, go back to the TaskRuns / PipelineRuns themselves, or use a hard gate inside the pipeline ([§4.3](#s4-3)).

:::

To judge on `high` or `total` instead, swap `criticalRaw` / `criticalIsNumeric` for the corresponding property; the decision structure stays the same.

**Division of labor with [§4.2.5](#s4-2-5)**: this section reads **run results** and answers "what did this scan find"; [§4.2.5](#s4-2-5) reads **template parameters** and answers "has the gate been switched off or hollowed out". The two are complementary and both necessary — with only the former, an over-threshold image ships anyway (the TaskRun is green); with only the latter, the parameters are correct but a scan that fails midway still goes unnoticed.

#### 4.4.2 The parsing pattern for unstructured string results (a compatibility measure, not the recommended style) {#s4-4-2}

:::warning Read this before the example: this section is not the recommended style

What this section demonstrates — splitting an aggregate string apart before judging it — is **not this document's recommended extension style**; it is a compatibility measure for consuming an **existing Task contract**. The recommended approach remains item 1 of [§2.4](#s2-4): have the Task emit a **structured result** (object result + `properties`) and let the policy drill straight into the fields — no regex needed, and no parsing mismatch possible.

**Specifically for trivy: do not use this section's style anymore.** `trivy-scanner` 0.6 already publishes the object result `trivy-summary-metadata` alongside; use the drill-down style of [§4.4.1](#s4-4-1) directly. This section is kept as a **generic pattern** — when you face a third-party or in-house Task that only emits an aggregate string and cannot be changed in the short term, copy the splitting and fail-closed structure here as-is. The text below still uses vulnerability counting as its subject matter because it hits every single trap, but **it demonstrates the shape, not the recommended way to use trivy**.

Why keep this section at all, then? Two practical reasons: ① Tasks and Task versions that only emit aggregate strings still exist in production, and governance cannot wait; ② the **fail-closed parsing pattern** here (first lock terminal state and Task identity → then use a regex to confirm a bounded non-negative integer → only then compare against the threshold, with every "cannot be read" case scored as not meeting the bar) is a safety baseline you can copy verbatim.

**If you are designing a new Task, go straight to object results — do not copy this section.**

:::

- **What it governs**: a Task that only publishes string results — when the count it reports exceeds the threshold, that must be put on record; this example judges `critical > 0`.
- **Why it is hard**: the count is packed into an aggregate string (shaped like `"scanType=image;…;critical=3;high=10;…"`), and three kinds of traps stack on top of each other — ① Tasks of this kind commonly use a **sentinel value** for "count unknowable" (this example uses `critical=-`, a dash); reading `-` as 0 amounts to allowing "the scan produced nothing" through as "no vulnerabilities"; ② **"take the first matching token" is a trap**: both `critical=0;critical=9` and `critical=0=9` are read by a naive parser as a clean `0`; ③ Kyverno operators coerce number-styled strings, which easily turns "cannot be read" into "scored as passing". The parsing path is fail-open everywhere.
- **How the policy is layered**: ① lock terminal state + Task identity → ② cut the `critical=` token out of the aggregate string and require **exactly one** → ③ **regex-match the whole token** (`^critical=[0-9]{1,9}$`, not just the value cut out of it) → ④ only after boundedness is confirmed, `to_number` and compare against the threshold. Every case where the value cannot be read, or more than one is read out, is treated as a violation.
- **What it cannot govern**: a string is not a stable contract — field order, separators, and newly added fields can all make the parsing **silently mismatch**, and a mismatch typically shows up as **falsely scored as passing**. So this is a transitional shape only. Moreover, an aggregate string usually carries **no** "overall scan status" dimension (the `status` in [§4.4.1](#s4-4-1) is precisely what fills that in), so this section's criteria can only cover "the count cannot be read" — not "the report was never produced but the count was written as 0".

**The key criterion** — the regex guard comes first, `to_number` second, and `-` and absence both fail closed:

```yaml
        # Terminal guard, counted not [0]-indexed (§4.4.1): only terminal TaskRuns
        # are judged, so the counts below never fire on an in-flight status write
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # exactly one token may claim the count: zero means it is missing, two or
        # more means a second value was smuggled in behind a benign first one
        # status.results carries no uniqueness guarantee either, so a decoy entry with
        # the same name in front of the real one would win the [0] below. Same for the
        # Succeeded condition. Require exactly one of each.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: criticalTokenCount
          variable:
            jmesPath: "length(split(aggregate, ';')[?starts_with(@, 'critical=')])"
            default: 0
        - name: criticalField
          variable:
            # isolate the critical= token; this shape uses 'critical=-' as the sentinel
            # for "counts unavailable", so the token may not be a number at all
            jmesPath: "split(aggregate, ';')[?starts_with(@, 'critical=')] | [0] || 'critical='"
            default: "critical="
        - name: criticalValue
          variable:
            jmesPath: "split(criticalField, '=')[1] || ''"
            default: ""
        - name: criticalIsNumeric
          variable:
            # match the WHOLE token, not just the value read out of it; a prefix-only
            # test reads 'critical=0;critical=9' and 'critical=0=9' as a clean zero
            jmesPath: >-
              criticalTokenCount == `1`
              && regex_match('^critical=[0-9]{1,9}$', criticalField)
      preconditions:
        all:
          # ...(taskRef identity omitted -- same-namespace policy-demo-trivy-summary,
          # no resolver; see the full YAML)
          # Terminal guard: in-flight status writes SKIP here instead of tripping
          # the NotEquals-1 counts below with a not-yet-written result
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        deny:
          conditions:
            any:
              # the summary or the terminal condition is not unambiguous
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # counts unavailable / missing / duplicated / malformed → fail closed;
              # never read '-' as zero, never trust the first of several tokens
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # validated numeric value only → to_number runs after the regex guard
              - key: "{{ criticalIsNumeric && to_number(criticalValue) > `0` }}"
                operator: Equals
                value: true
```

The fixture profile below uses the namespace-local `taskRef.name: policy-demo-trivy-summary` in `policy-poc` (no resolver). The `trivy` in the name merely **carries over the aggregate-string shape it simulates** — it is an emitter fixture built for this document, **not** the catalog's `trivy-scanner`; the latter already publishes object results, so go through [§4.4.1](#s4-4-1). When applying this to your own target Task, you must change it to that Task's full `taskRef` identity (for a hub reference, including catalog / name / version) — you must **not** identify it by child labels like `tekton.dev/task`.

:::details Full policy YAML: vuln-threshold-audit

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: vuln-threshold-audit
spec:
  background: false
  rules:
    - name: no-critical-vulns
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        # This fixture uses a direct, namespace-local Task reference. Lock both
        # the absence of a resolver and the Task name; child labels are untrusted.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskRefName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ''"
            default: ""
        # Judge every terminal TaskRun, including terminal runs that failed to write
        # the declared result. Earlier status updates remain out of scope. Counting
        # terminal conditions (rather than reading [0]) keeps a duplicate Succeeded
        # entry from disarming the guard -- see §4.4.1.
        - name: isTerminal
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        - name: summary
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='trivy-summary'].value | [0] || `[]`"
        - name: aggregate
          variable:
            jmesPath: "summary[0] || ''"
            default: ""
        # Count the tokens that claim to carry the critical count. A well-formed
        # summary has exactly one; zero means the field is missing and two or more
        # means the producer (or an attacker) smuggled a second value in.
        # status.results carries no uniqueness guarantee either, so a decoy entry with
        # the same name in front of the real one would win the [0] below. Same for the
        # Succeeded condition. Require exactly one of each.
        - name: summaryResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='trivy-summary'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: criticalTokenCount
          variable:
            jmesPath: "length(split(aggregate, ';')[?starts_with(@, 'critical=')])"
            default: 0
        - name: criticalField
          variable:
            # isolate the critical= token; this shape uses 'critical=-' as the sentinel
            # for "counts unavailable", so the token may not be a number at all
            jmesPath: "split(aggregate, ';')[?starts_with(@, 'critical=')] | [0] || 'critical='"
            default: "critical="
        - name: criticalValue
          variable:
            jmesPath: "split(criticalField, '=')[1] || ''"
            default: ""
        - name: criticalIsNumeric
          variable:
            # Match the WHOLE token, not just the value read out of it, and require
            # exactly one such token. Taking the first match of a leading-prefix test
            # would read 'critical=0;critical=9' and 'critical=0=9' as a clean 0.
            jmesPath: >-
              criticalTokenCount == `1`
              && regex_match('^critical=[0-9]{1,9}$', criticalField)
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: ""
          - key: "{{ taskRefName }}"
            operator: Equals
            value: policy-demo-trivy-summary
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
      validate:
        failureAction: Audit
        message: "image scan critical count is '{{ criticalValue }}' — unknown/non-numeric (e.g. '-') or above threshold 0; fail-closed on unknown counts."
        deny:
          conditions:
            any:
              # the summary or the terminal condition is not unambiguous
              - key: "{{ summaryResultCount }}"
                operator: NotEquals
                value: 1
              - key: "{{ succeededConditionCount }}"
                operator: NotEquals
                value: 1
              # counts unavailable / missing / malformed → fail closed, never read '-' as zero
              - key: "{{ criticalIsNumeric }}"
                operator: Equals
                value: false
              # validated numeric value only → apply the real threshold (to_number runs after the regex guard)
              - key: "{{ criticalIsNumeric && to_number(criticalValue) > `0` }}"
                operator: Equals
                value: true
```

:::

:::details Reproduction fixtures and probes: the string-shape emitter (policy-demo-trivy-summary)

The `trivy-*` rows in the table below use exactly this fixture — it **needs no network access and pulls no vulnerability database**; it just writes a few aggregate-string shapes verbatim into the result. Both objects must be created: the one in `policy-poc` is the policy's target, and the **same-named** Task in `tekton-templates` is the control for the last row, "same name, different source — must skip".

```yaml
# String-shape emitter fixture for the generic parsing pattern (§4.4.2). The dup
# and smuggled modes reproduce the bypasses a leading-token-only parser reads as
# a clean zero.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-trivy-summary
  namespace: policy-poc
spec:
  params:
    - name: mode
      type: string
  results:
    - name: trivy-summary
      type: array
  steps:
    - name: emit
      image: <registry>/busybox:latest
      env:
        - name: MODE
          value: $(params.mode)
      script: |
        #!/bin/sh
        set -eu
        case "$MODE" in
          clean)
            printf '["scanType=image;critical=0;high=0"]' > "$(results.trivy-summary.path)"
            ;;
          vuln)
            printf '["scanType=image;critical=3;high=10"]' > "$(results.trivy-summary.path)"
            ;;
          unknown)
            printf '["scanType=image;critical=-;high=-"]' > "$(results.trivy-summary.path)"
            ;;
          dup)
            # A second critical= token hides the real count behind a benign first one.
            printf '["scanType=image;critical=0;critical=9;high=0"]' > "$(results.trivy-summary.path)"
            ;;
          smuggled)
            # An extra '=' makes a naive split read only the leading zero.
            printf '["scanType=image;critical=0=9;high=0"]' > "$(results.trivy-summary.path)"
            ;;
          missing)
            # A successful terminal TaskRun without the declared result must fail closed.
            ;;
          *)
            exit 1
            ;;
        esac
---
# Same Task name, another namespace and resolver source. The policy pins the
# namespace-local taskRef.name shape, so this one must be skipped even though it
# emits a violating count.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-trivy-summary
  namespace: tekton-templates
spec:
  results:
    - name: trivy-summary
      type: array
  steps:
    - name: emit
      image: <registry>/busybox:latest
      script: |
        #!/bin/sh
        printf '%s' '["scanType=image;critical=9;high=9"]' > "$(results.trivy-summary.path)"
```

Save the two Tasks above as `trivy-summary-emitters.yaml` (replace `<registry>`) and create them first — the six probes below reference them by name:

```bash
# Both Tasks land in walkthrough-owned namespaces (§4.0.4): the namespace cascade
# takes them at cleanup, so a plain apply is fine here.
kubectl apply -f trivy-summary-emitters.yaml
# Expect both. NotFound on either one makes every probe below fail with
# `tasks.tekton.dev "policy-demo-trivy-summary" not found`, which looks like a
# broken probe rather than a missing fixture.
kubectl get task -n policy-poc policy-demo-trivy-summary
kubectl get task -n tekton-templates policy-demo-trivy-summary
```

The six `trivy-*` probes differ only in `mode` (`clean` / `vuln` / `unknown` / `dup` / `smuggled` / `missing`); the shape is:

```yaml
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: trivy-dup
  namespace: policy-poc
spec:
  taskRef:
    name: policy-demo-trivy-summary
  params:
    - name: mode
      value: dup
```

Create all six at once (each name matches its mode, so the report rows line up at a glance):

```bash
for mode in clean vuln unknown dup smuggled missing; do
  kubectl create -f - <<YAML
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: trivy-$mode
  namespace: policy-poc
spec:
  taskRef:
    name: policy-demo-trivy-summary
  params:
    - name: mode
      value: $mode
YAML
done

# All six must be TERMINAL before the report means anything (see the note at the end of
# §4.4.2). `kubectl get` alone does not wait -- read it after this loop, not instead of it.
for mode in clean vuln unknown dup smuggled missing; do
  kubectl wait -n policy-poc "taskrun/trivy-$mode" \
    --for=condition=Succeeded --timeout=5m
done

kubectl get taskrun -n policy-poc \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.conditions[0].status,REASON:.status.conditions[0].reason' \
  | grep '^trivy-'
# Expect ALL SIX Succeeded -- trivy-missing included. Measured on this environment:
# Tekton does NOT fail a TaskRun that skips writing a result it declared, so the run
# is green and nothing but the policy can catch it. That is exactly the case the
# fail-closed branch exists for; a "False" here instead means the fixture failed for
# some other reason (usually the image could not be pulled), so fix that first.
```

The control probe for the last row switches to the cluster resolver pointing at the same-named Task in another namespace (it has no `mode` parameter):

```yaml
apiVersion: tekton.dev/v1
kind: TaskRun
metadata:
  name: trivy-same-name-other-source
  namespace: policy-poc
spec:
  taskRef:
    resolver: cluster
    params:
      - name: kind
        value: task
      - name: name
        value: policy-demo-trivy-summary
      - name: namespace
        value: tekton-templates
```

Save it as `trivy-same-name-other-source.yaml` and create it:

```bash
kubectl create -f trivy-same-name-other-source.yaml
```

Once the runs finish, wait for the TaskRuns to reach terminal state, then read the verdicts (the policy is Audit — every request is allowed through; the conclusion lives only in the report):

```bash
# On the cluster that runs Tekton and Kyverno.
kubectl get policyreport -n policy-poc \
  -o custom-columns=SUBJECT:.scope.name,RESULT:.results[*].result
```

**Reading the report takes patience**: one TaskRun goes through multiple non-terminal status updates, each recorded as `skip` because of the `isTerminal` precondition; right after the run turns terminal you will usually still read that `skip`, and the terminal verdict only appears once the reporting chain catches up (tens of seconds on this document's verification environment). **Read once and conclude, and what you have measured is the race — not the policy.**

There is an even subtler shape: **the object that should be judged `skip` may not have a report row at all yet**. The "same name, different source — must skip" row at the bottom of the table is exactly this case — its verdict is always `skip`, so you cannot use "has it turned into fail yet" to decide whether its report has been written; you can end up with "all six verdicts correct, the seventh row entirely absent", which looks like "the no-collateral-damage control did not take effect" but is really just the report not having arrived. Write the wait condition as "**report rows exist for all seven objects**, and six of them have left `skip`" — do not wait for the first half only.

**Note that these probes are bare TaskRuns submitted by hand by you**: a cluster with [§4.5.4](#s4-5-4)'s `pipeline-entry-lockdown` installed will reject them up front ([§4.0.5](#s4-0-5)).

:::

:::details Expected PolicyReport for the two policies (sonar's four-value domain + six string-fixture scenarios + two no-collateral-damage controls)

| TaskRun | Result input | PolicyReport |
|---|---|---|
| `audit-sonar-terminal-pass` | `Succeeded` | pass |
| `audit-sonar-terminal-failed-verdict` | `Failed` | fail |
| `audit-sonar-terminal-skipped` | `Skipped` | fail |
| `audit-sonar-terminal-canceled` | `Canceled` | fail |
| `audit-sonar-terminal-numeric-invalid` | Invalid number-styled value `"1"` | fail |
| `audit-sonar-terminal-missing-result` | Terminal, `code-scan-results` missing | fail |
| `audit-sonar-terminal-non-scanner` | A different Task identity | skip |
| `trivy-clean` | `critical=0` | pass |
| `trivy-vuln` | `critical=3` | fail |
| `trivy-unknown` | `critical=-` | fail |
| `trivy-dup` | `critical=0;critical=9` (duplicate token) | fail |
| `trivy-smuggled` | `critical=0=9` (an extra `=` inside the token) | fail |
| `trivy-missing` | Terminal, `trivy-summary` missing | fail |
| `trivy-same-name-other-source` | Same-named Task, but `resolver=cluster` with namespace `tekton-templates` | skip |

The rows beginning with `trivy-*` use the **string-shape emitter** from [§4.4.2](#s4-4-2), not the catalog's `trivy-scanner` (for the latter see the use-case table in [§4.4.1](#s4-4-1)).

Five key conclusions: ① in sonar's real four-value domain only `Succeeded` scores pass, a terminal run missing its result likewise fails closed, and the non-scanner run skips because the full Task identity does not match; ② `critical=-` (the dash sentinel value for "count unknowable") scores **fail** — and a clean `fail` at that, with `error=0`: the regex guard plus the short-circuit expression never ran `to_number` on `-`; ③ **`trivy-dup` / `trivy-smuggled` are the reason the two guards — whole-token matching plus count-must-be-1 — exist**: swap the guards back to "match only the cut-out value, take the first token" and both of these inputs are **falsely scored as passing**; ④ a terminal TaskRun missing the target result still scores fail instead of silently skipping; ⑤ the same-named Task resolved from another namespace records skip, proving the profile locks both the resolver shape and the namespace-local name rather than comparing names alone.

:::

#### 4.4.3 Anti-demo: why you must never Enforce on status {#s4-4-3}

:::warning This section is a negative demonstration — do not imitate it in any environment

What happens when a [§4.4.1](#s4-4-1)-style policy is switched to `Enforce` (below, this demonstration-only policy is called `scan-verdict-enforce-wedge-demo` — same name as in the cleanup checklist): the emitter's Pod is already `Completed` (all the work is done), but the controller's write of the completion status is denied — the TaskRun sits at `Running` forever with no `completionTime`, and the events keep repeating:

```text
Warning  UpdateFailed  taskrun/…  Failed to update status for "…": admission webhook "validate.kyverno.svc-fail" denied the request: …
```

The run neither fails nor ends; only human intervention releases it: once the policy is deleted or relaxed, the controller retries on its backoff schedule and recovers to the normal terminal state by itself. Recovery time depends on the controller's retry cadence and load at that moment — usually within 1 minute, but **no fixed value can be promised**. Recognition and release steps are in [§6.1.4](#s6-1-4).

:::

As a bonus, a control that can falsify "was the label the culprit": `scan-verdict-enforce-wedge-demo` matches only the full fixture TaskRef (`resolver=cluster`, `kind=task`, `name=policy-demo-scanner`, `namespace=tekton-templates`) and never reads the `tekton.dev/task` label. An independent control TaskRun — even one that forges that label and writes out a same-named `code-scan-results.result=Failed` — reaches its normal terminal state and is not wedged, as long as its real TaskRef does not match.

#### 4.4.4 Inventorying pre-existing resources (background scan) {#s4-4-4}

- **What it governs**: the batch of objects that **already exist** in the cluster when a policy is **freshly installed** — admission only evaluates when a new CREATE/UPDATE event occurs, and pre-existing objects generate no new events, so admission sees none of them.
- **Why it is hard**: going straight to Enforce would indiscriminately block follow-up operations on old runs — and you have no idea how many violations the existing stock contains.
- **How the policy is layered**: ① `background: true` makes the reports-controller **periodically reconcile and scan pre-existing main resources** → ② `Audit` mode writes each object's evaluation result into a PolicyReport → ③ from that you obtain the violation baseline and set the governance pace (remediate the existing stock first, then switch to Enforce).
- **What it cannot govern**: the background scan **acts only on main resources** — `*/status` subresource policies ([§4.4.1](#s4-4-1) / [§4.4.2](#s4-4-2)) have no background backstop and are evaluated only at the admission moment ([§2.2](#s2-2)).

The example below inventories "which PipelineRuns do not carry the `policy.alauda.io/gated` marker" (that is, old runs created before the [§4.2.6](#s4-2-6) injection policy took effect):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: inventory-ungated-runs
spec:
  background: true
  rules:
    - name: pipelinerun-should-carry-gated-label
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              namespaces:
                - policy-poc
      validate:
        failureAction: Audit
        message: "PipelineRun does not carry the policy.alauda.io/gated label (created before the defaults policy?)."
        pattern:
          metadata:
            labels:
              policy.alauda.io/gated: "true"
```

**The full manifests for the two pre-existing runs** (save as `doc-inventory-runs.yaml`) — they differ by exactly one label, both use the trusted template from [§3.3](#s3-3), and they run fast:

```yaml
# Carries the platform marker -> background scan must record pass
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: doc-inventory-gated
  namespace: policy-poc
  labels:
    policy.alauda.io/gated: "true"
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
---
# No marker: this is the shape the inventory sweep is meant to surface
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: doc-inventory-ungated
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
```

Save the policy above as `inventory-ungated-runs.yaml`. **The order must not be reversed** — first create the runs and wait for their terminal states, **then** install the policy; the other way around, the two runs go through normal admission evaluation and what you measure is no longer an inventory of pre-existing resources:

```bash
kubectl create -f doc-inventory-runs.yaml
kubectl wait -n policy-poc pipelinerun/doc-inventory-gated \
  --for=condition=Succeeded --timeout=5m
kubectl wait -n policy-poc pipelinerun/doc-inventory-ungated \
  --for=condition=Succeeded --timeout=5m

# Only now install the policy above, then wait for the background scan to reach them.
# `create`, not `apply`: on a shared cluster an AlreadyExists error here is the answer
# you want -- somebody else already owns that policy name, so stop and pick your own
# rather than overwriting theirs (§4.0.4).
kubectl create -f inventory-ungated-runs.yaml
kubectl wait --for=condition=Ready clusterpolicy/inventory-ungated-runs --timeout=60s

# Read the two verdicts (background scan is periodic -- repeat until both rows appear).
# The kind filter is not decoration: each run also produces reports scoped to its
# TaskRuns (doc-inventory-gated-scan, ...), and those match the name prefix while
# carrying no verdict for this policy -- without it you get five blank rows.
kubectl get policyreport -n policy-poc -o json | jq -r '
  .items[]
  | select(.scope.kind=="PipelineRun")
  | select(.scope.name | startswith("doc-inventory-"))
  | "\(.scope.name)\t\([.results[] | select(.policy=="inventory-ungated-runs")
      | "\(.result) process=\(.properties.process // "-")"] | join(","))"'
```

**Expected shape**: the two PipelineRuns are created and reach terminal state first, and the policy is installed **afterwards** (the Policy's creation time is later than the resources under test). With **no new resource events whatsoever**, the PolicyReport records `pass` for the existing run carrying `policy.alauda.io/gated: "true"` and `fail` for the existing run missing the label, with the result properties explicitly stating `results[].properties.process: background scan`.

:::warning The policy.alauda.io/gated label is not evidence that the gate actually ran

This example only uses it to demonstrate "sweeping out old runs that lack the platform marker". The [§4.2.6](#s4-2-6) mutation injects `"true"` for requests that did not set the label explicitly, but **pipeline users can also write a same-named label on the PipelineRun themselves** — so all this can prove is that the label value existed on the object at scan time; it proves neither that the mutation ever executed nor that the run genuinely passed a hard gate.

To inventory "was it genuinely under gate constraints", verify real gate facts (whether the gate task exists and its result; the drift Audit of [§4.1.4](#s4-1-4)), or have a trusted entry point write a policy-version / configuration-hash marker that business users cannot forge.

:::

##### What PolicyReport is for (how to read it, how to consume it, and what not to expect from it)

PolicyReport is a **standard Kubernetes resource** (`wgpolicyk8s.io`) written by Kyverno — one per evaluated resource, named after that resource's UID: `summary` gives pass / fail / warn / error / skip counts, and `results[]` lists, entry by entry, "which rule of which policy, judged as what, with what message". It turns policy evaluation results into cluster data that is **queryable, aggregatable, and programmatically consumable** — which is exactly the only output form Audit policies have.

The three most common ways to read it:

```bash
# 1) Overall violation surface of one namespace: one row per resource, read the FAIL column
kubectl -n policy-poc get policyreport

# 2) Violation list for one policy (resource name + reason) -- feed it straight into remediation tickets
kubectl -n policy-poc get policyreport -o json | jq -r '
  .items[] | .scope as $s | .results[]
  | select(.policy=="inventory-ungated-runs")
  | "\(.result)\t\($s.kind)/\($s.name)\t\(.message)"'

# 3) How many violations of THIS policy are left before switching it to Enforce.
#    Filtered by policy on purpose: an unfiltered count sums every policy in the cluster, so
#    the number this procedure tells you to drive to zero would never be about the policy you
#    are deciding on -- other Audit policies' violations would keep it above zero forever.
kubectl get policyreport -A -o json | jq -r '
  [.items[].results[] | select(.policy=="inventory-ungated-runs" and .result=="fail")] | length'
#    (Drop the .policy filter only when you deliberately want the cluster-wide violation
#     surface across ALL policies -- that is a different question from this one.)
```

Paired with the "Audit first" rollout process of [§3.5](#s3-5), its value is turning governance into a **measurable process**: first inventory the baseline with Audit + `background: true` (reading 3 gives you a number), hand the list to the teams for remediation (reading 2), and switch to Enforce once the number drops to 0 or an acceptable level. After remediation the reports converge on their own — patch the label onto a violating run and its report flips from `fail: 1` to `pass: 1` at the next evaluation; no manual report cleanup is needed.

At the same time, be clear about its **boundaries**, or you will end up treating it as evidence it cannot be:

- **It is not an audit log.** Reports are named after the resource UID and garbage-collected together with the resource: delete the run and its report is gone too. Long-term retention requires external collection (export the reports into a logging / metrics system); do not expect to dig up history inside the cluster.
- **Requests rejected by Enforce leave no report.** An object denied at admission was never persisted at all, so there is no resource to attach a report to; the evidence on that path is Kyverno events plus the error message the caller received ([§6.2](#s6-2)).
- **`mutate` rules produce no violation records.** A TaskRun cancelled by [§4.2.3](#s4-2-3) shows up in the report as `result=skip` with message `no patches applied` (by the time of background re-evaluation the object is already in the target state) — not as `fail`. To make "which runs were touched by policy" queryable, add a separate Audit rule for bookkeeping, or rely on the annotation / `statusMessage` on the object.
- **It only answers "what did the evaluation conclude" — not "did this pipeline genuinely run its quality checks".** The strength of the verdict depends on what the policy itself read (the [§2.3](#s2-3) contracts); the report merely carries the conclusion out.
- **Finding no `fail` does not equal compliance** — this is the easiest step to get wrong in audit scenarios. An empty result has at least five meanings, and they all look exactly the same: ① genuine compliance; ② the policy **did not match** (a template / Task version change turned everything into `skip`, [§3.6](#s3-6)); ③ the request was **skipped wholesale** by `resourceFilters` (neither a denial nor a report, [§3.1](#s3-1) checklist item 7); ④ the report **has not converged yet** ([§6.1.5](#s6-1-5)); ⑤ the object — report and all — **has already been GC'd**. So an audit conclusion may only state "**no violation records available**", unless you can simultaneously produce: the matched policy and rule names (the `policy` field from reading 2), a snapshot of the `resourceFilters` at the time, confirmation that the report is past its convergence window, and the continued existence of the object itself.

:::warning To prove after the fact that a given release went through the gate, archiving PolicyReport alone is not enough

Reports are GC'd with their objects, and **a request rejected by Enforce has no object at all** — so the evidence is scattered across four places with four different lifecycles: **the PipelineRun / gate TaskRun terminal states and `status.results`** (proving "it ran, and what it concluded"), **PolicyReport** (proving "how the policy judged it"), **Events** (proving a cancellation / denial happened), and **the admission denial message** (which exists only at the caller and in Kyverno's logs). Long-term retention means collecting all four **while the objects are still alive**, keyed together by the PipelineRun UID (object names repeat; UIDs do not).

This document does not prescribe retention periods for these objects in your environment — **but you do not have to guess**: run the command below once and you get the timestamp of **the oldest `PipelineRun` still present**. ⚠️ **That is the horizon of one of the four evidence classes, not of the whole evidence chain**: as just noted, the four have different lifecycles — `PolicyReport` is GC'd with its object (for already-deleted runs it can only be nearer), and Events and admission denial messages each have their own retention policies (measured on this document's verification environment: the oldest `PipelineRun` and the oldest Event were 43 days apart, in the direction opposite to intuition). To answer "can that release still be looked up", **query each of the four classes once** and take the most recent horizon among them. (Run on the cluster that runs Tekton.)

```bash
# The oldest row is the horizon of THIS evidence class only. PolicyReport, Event and
# admission-denial messages each have their own retention, so query all four and take
# the most recent -- see the paragraph above.
kubectl get pipelinerun -A --sort-by=.metadata.creationTimestamp \
  -o custom-columns='CREATED:.metadata.creationTimestamp,NS:.metadata.namespace,NAME:.metadata.name,UID:.metadata.uid,VERDICT:.status.conditions[0].reason' \
  | head -5
```

:::

#### Cleanup (§4.4)

Clean up per the two rules in [§4.0.4](#s4-0-4). Delete the four cluster-scoped policies by name; if you built the anti-demo policy **yourself** following the description in [§4.4.3](#s4-4-3) (this document deliberately ships no installable YAML for it), delete it too under whatever name you actually used — and **first confirm that no TaskRun is wedged at `Running` because of it**:

```bash
# §4.0.4's look-before-delete: cluster-scoped, so one glance at when they were created.
kubectl get clusterpolicy scan-verdict-audit vuln-summary-audit \
  vuln-threshold-audit inventory-ungated-runs --ignore-not-found \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'
kubectl delete clusterpolicy scan-verdict-audit vuln-summary-audit \
  vuln-threshold-audit inventory-ungated-runs --ignore-not-found
```

The namespaced objects (the 14 TaskRuns from the table above, the real `trivy-scanner` 0.6 TaskRun with its source-code fixture ConfigMap, the two inventory PipelineRuns, and the two emitter fixture Tasks from [§4.4.2](#s4-4-2)) all live in self-created namespaces and are reclaimed by cascading deletion; if you are continuing with the later sections, delete the run-type objects by name first — otherwise their PolicyReport rows will surface in the next section's `kubectl get policyreport` ([§4.0.5](#s4-0-5)):

```bash
# A read loop, not `kubectl delete $(...)`: with no match the substitution would leave
# a delete with no names (an error), and an unquoted expansion is a paste trap anyway.
kubectl get taskrun -n policy-poc -o name \
  | grep -E '/(audit-sonar-terminal-|trivy-)' \
  | while read -r tr; do kubectl delete -n policy-poc "$tr"; done
kubectl delete pipelinerun -n policy-poc doc-inventory-gated doc-inventory-ungated \
  --ignore-not-found
```

### 4.5 Sources, images, and release targets (the runtime side of contract 1 "identity" / contract 7 "entry closure") {#s4-5}

This chapter covers three unauthorized surfaces: where artifacts come from (copy inputs), what images actually run (execution images), and where releases go (release targets) — plus entry closure.

**Map of this section** (ordered by the pipeline's material flow):

- **[§4.5.1](#s4-5-1)** — artifact copy source allowlist (the real `skopeo-copy` profile): which registry inputs are pulled from.
- **[§4.5.2](#s4-5-2)** — source image property validation: use `context.imageRegistry` to read the image config and judge the image's own properties, not just its name.
- **[§4.5.3](#s4-5-3)** — execution image allowlist: **a Pod-level hard block**, the only observation point in the whole document that can govern "what image this step actually runs".
- **[§4.5.4](#s4-5-4)** — closing the bare `TaskRun` / `CustomRun` entrances (contract 7): the [§4.2](#s4-2) criteria that derive identity from the parent run hold only for controller-created child TaskRuns; what this section seals is the entrance of creating Runs directly, bypassing any parent run (the Pod-level [§4.5.3](#s4-5-3) is unaffected by entrances — the two are complementary).
- **[§4.5.5](#s4-5-5)** — release target allowlist (the real `-image-build-scan-deploy` 0.3 profile): which namespace outputs may be released to / which set of credentials may be used.

#### 4.5.1 Artifact copy source allowlist (real profile: skopeo-copy) {#s4-5-1}

- **What it governs**: **artifacts may only be copied in from approved registries**. The scenario is image copy / promotion with the platform catalog's `skopeo-copy`; with the source uncontrolled, anyone can "copy" an external image into the internal registry — and from then on it counts as an "internal image". This is the cheapest entry point supply-chain poisoning has. Note that what is governed is **the copy's input parameters**, not what image this TaskRun itself runs on (that is [§4.5.3](#s4-5-3)).
- **Why it is hard**: `skopeo-copy` allows **three ways** to specify the source, and missing any one of them is a bypass loophole — ① simple mode, `srcTransport` + `srcImage` (a bare reference, **no** `docker://` prefix); ② inline mode, `imageMappings` (an array, each item `"SRC DST"`, **with** the `docker://` prefix); ③ file mode, a `copy-mappings` workspace (whose content is **entirely invisible** at admission). The three even spell their prefixes differently — which is why the policy below carries so many context variables.
- **How the policy is layered**: ① first lock "is this that Task" (the full resolver coordinates in `taskRef` — **never node aliases or child labels**, which can be overridden and forged via `taskRunSpecs`) → ② then lock "has the Task been swapped out" (deny a request-level `url`; an explicit `type` may only be `artifact` — against "still called by that name, content replaced with mine") → ③ only then the source allowlist (each mode's own prefix + `srcTransport` may only be `registry`; an explicit empty string does not count as absence and must not inherit the default) → ④ three fail-closed backstops: **newline smuggling**, **file mode denied outright**, **and deny when not a single source can be identified**.
- **What it cannot govern**: it is only effective when "**this Task is actually used**". Anyone who bypasses `skopeo-copy` and creates a bare TaskRun running a skopeo / crane image to push images by hand is completely out of this rule's reach — it only holds together with [§4.5.4](#s4-5-4) (closing the bare Tekton Run entrances) and [§4.5.3](#s4-5-3) (the Pod-level execution image allowlist).

**The generic contract**: constrain "the input parameters of copy-type tasks". Parameter validation is only effective in scenarios where "this task is used" — it must be paired with entry closure ([§4.5.4](#s4-5-4)); otherwise bypassing this task and pushing images directly defeats it.

All three source modes of `skopeo-copy` (0.1) must be covered (fields taken from the real Task definition): ① simple mode, `srcTransport` (default `registry`) + `srcImage` (**a bare image reference, no `docker://` prefix**); ② inline mode, `imageMappings` (an array, each item `"SRC DST"`, **with the `docker://` transport prefix**); ③ file mode, a `copy-mappings` workspace (whose content is **invisible** at admission).

**The key criterion** — each mode computes its own boolean, and any hit under `any` denies; note that the `mappingsMalformed` entry is not filler:

```yaml
        - name: mappingsMalformed
          variable:
            # The catalog parser consumes one SRC DST mapping per line. Reject
            # embedded line breaks before source allowlisting, otherwise one
            # array item can smuggle a second mapping past mappingSources.
            jmesPath: "length(mappings[?regex_match('^[^\\r\\n]*$', @) == `false`]) > `0`"
        - name: simpleBad
          variable:
            jmesPath: "srcImage != '' && !starts_with(srcImage, '<approved-registry>/')"
        - name: mappingsBad
          variable:
            jmesPath: "length(mappingSources[?!starts_with(@, 'docker://<approved-registry>/')]) > `0`"
        - name: noVisibleSource
          variable:
            jmesPath: "srcImage == '' && length(mappings) == `0` && !hasFileWorkspace"
```

**Why newline smuggling needs its own verdict**: the catalog's script reads mappings **line by line**. Stuff a `\r\n` into one array item — the first segment an approved source, the second segment smuggling an unauthorized one — and the allowlist only ever sees the first segment, while the second source slips through. So both modes must assert "single line" first, and only then apply the prefix allowlist.

:::details Full policy YAML: artifact-source-allowlist

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: artifact-source-allowlist
spec:
  background: false
  rules:
    - name: skopeo-sources-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskCatalog
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: taskVersion
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.taskRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
        # simple mode: srcTransport (default registry) + srcImage (bare ref, NO docker:// prefix)
        - name: srcTransportPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='srcTransport']) > `0`"
        - name: srcTransport
          variable:
            # Only an omitted parameter may inherit the trusted Task default.
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcTransport'].value | [0] || ''"
            default: ""
        - name: srcImage
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcImage'].value | [0] || ''"
            default: ""
        # inline mode: imageMappings, each "SRC DST" with a docker:// transport prefix
        - name: mappings
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='imageMappings'].value | [0] || `[]`"
        - name: mappingSources
          variable:
            jmesPath: "map(&split(@, ' ') | [0], mappings)"
        - name: mappingsMalformed
          variable:
            # The catalog parser consumes one SRC DST mapping per line. Reject
            # embedded line breaks before source allowlisting, otherwise one
            # array item can smuggle a second mapping past mappingSources.
            jmesPath: "length(mappings[?regex_match('^[^\\r\\n]*$', @) == `false`]) > `0`"
        # file mode: a copy-mappings workspace whose content admission cannot inspect
        - name: hasFileWorkspace
          variable:
            jmesPath: "length((request.object.spec.workspaces || `[]`)[?name=='copy-mappings']) > `0`"
        # verdicts computed inside JMESPath (exact string, no operator coercion)
        - name: simpleBad
          variable:
            jmesPath: "srcImage != '' && !starts_with(srcImage, '<approved-registry>/')"
        - name: simpleMalformed
          variable:
            # Simple mode writes srcImage into a line-oriented mapping file.
            # Reject CR/LF so an approved first line cannot smuggle a second source.
            jmesPath: "srcImage != '' && regex_match('^[^\\r\\n]*$', srcImage) == `false`"
        - name: transportBad
          variable:
            jmesPath: "srcImage != '' && srcTransportPresent && srcTransport != 'registry'"
        - name: mappingsBad
          variable:
            jmesPath: "length(mappingSources[?!starts_with(@, 'docker://<approved-registry>/')]) > `0`"
        - name: noVisibleSource
          variable:
            jmesPath: "srcImage == '' && length(mappings) == `0` && !hasFileWorkspace"
      preconditions:
        all:
          - key: "{{ taskResolver }}"
            operator: Equals
            value: hub
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskCatalog }}"
            operator: Equals
            value: catalog
          - key: "{{ taskName }}"
            operator: Equals
            value: skopeo-copy
          - key: "{{ taskVersion }}"
            operator: Equals
            value: "0.1"
      validate:
        failureAction: Enforce
        message: >-
          skopeo copy must use the governed Artifact Hub endpoint and sources
          from the approved registry. Simple mode: srcTransport must be
          'registry' and srcImage must start with the approved registry.
          Inline mode: every imageMappings source must be
          docker://<approved-registry>/... File mode (copy-mappings workspace)
          cannot be inspected at admission and is rejected. got srcImage='{{ srcImage }}',
          mappings sources {{ mappingSources }}, fileWorkspace={{ hasFileWorkspace }}.
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
              - key: "{{ simpleBad }}"
                operator: Equals
                value: true
              - key: "{{ simpleMalformed }}"
                operator: Equals
                value: true
              - key: "{{ transportBad }}"
                operator: Equals
                value: true
              - key: "{{ mappingsBad }}"
                operator: Equals
                value: true
              - key: "{{ mappingsMalformed }}"
                operator: Equals
                value: true
              # file mode is a blind spot at admission → reject (or gate via a dedicated approved workspace)
              - key: "{{ hasFileWorkspace }}"
                operator: Equals
                value: true
              - key: "{{ noVisibleSource }}"
                operator: Equals
                value: true
```

:::

:::details Verification probes (14, --dry-run=server)

| Probe | Expected |
|---|---|
| Simple mode: `srcImage` from the approved registry | Allow |
| Simple mode: `srcImage` from `docker.io` | Deny |
| Simple mode: approved `srcImage` but `srcTransport=oci-archive` | Deny |
| Simple mode: an explicitly empty `srcTransport` | Deny (an empty string is not absence; the default is not inherited) |
| Simple mode: `srcImage` with an approved first line smuggling an unauthorized source on the second | Deny |
| Inline mode: every `imageMappings` entry approved | Allow |
| Inline mode: one unauthorized source mixed in | Deny |
| Inline mode: a single mapping with an embedded newline smuggling a second source | Deny |
| File mode: with a `copy-mappings` workspace | Deny (admission blind spot) |
| No visible source at all | Deny (fail-closed) |
| Same node alias, but the Task identity is not `catalog/skopeo-copy/0.1` | Rule skips — no collateral damage |
| A single explicit `type=artifact` | Allow |
| Approved tuple + a request-level `url` | Deny |
| Approved tuple + an explicit `type=tekton` | Deny |

:::

**The file-mode trade-off**: the `SRC DST` list inside the `copy-mappings` workspace cannot be inspected at admission, so this policy **denies that mode outright**. If a team genuinely needs file mode, the correct answer is to move the governance of the list content **upstream** (govern the upstream task / artifact that produces the workspace), not to expect this admission policy to backstop it.

#### 4.5.2 Source image property validation (`context.imageRegistry` reads the image config) {#s4-5-2}

- **What it governs**: not just "which image the parameter names", but **the image's own properties** — for example "the base image being promoted must carry the `build=tekton` label", "it must declare `org.opencontainers.image.source`".
- **Why it is hard**: these properties live in the OCI image's config; **they are not fields of any Kubernetes object**, and `context.apiCall` cannot reach them.
- **How the policy is layered**: ① narrow to the copy Task, and only when it actually carries a source image reference → ② use `context.imageRegistry` to pull that image's manifest / config straight from the registry during admission → ③ drill into `configData.config.Labels` and friends with JMESPath to render the verdict — **a missing label must be explicitly defaulted to a value that can never pass**, or the rule fails open.
- **Layer ① is the easiest place to bury a mine**: the Task identity must be read from **both** `taskRef.name` and the resolver's `taskRef.params` — an in-cluster reference puts the name in `.name`, while in the hub / git / cluster resolver shapes `.name` is **empty** and the name lives in `params`. Matching on `.name` alone amounts to a **silent skip** of every resolver-shaped TaskRun (the policy installs, looks right, and blocks nothing). In production, tighten further to the full resolver coordinates as in [§4.5.1](#s4-5-1).
- **What it cannot govern**: **it can only read images that already exist at admission time** (so it can only validate the source, never the dest produced by this very operation); and it puts external network onto the admission path — the four limitations are in the warning below; weigh them before go-live.

For this class of requirement Kyverno provides another external data source, **`context.imageRegistry`**: during admission, Kyverno itself pulls the specified image's manifest / config from the registry, places the result into a variable, and JMESPath then drills into fields such as `configData.config.Labels` / `.Env` or `configData.architecture`.

**The key criterion** — a missing label is caught with `|| 'MISSING'` to make sure it lands on the deny side:

```yaml
      context:
        - name: srcRef
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcImage'].value | [0]"
        # Kyverno pulls the image config from the registry during admission.
        - name: imgdata
          imageRegistry:
            reference: "{{ srcRef }}"
        # A missing label must not fail open: default to MISSING so the comparison
        # below still denies. Compare inside JMESPath rather than with a Kyverno
        # NotEquals -- operator coercion would swallow a forged numeric-looking
        # label value such as "1" and let the image through (§6.1.7).
        - name: buildLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.build || 'MISSING') != 'tekton'"
      preconditions:
        all:
          # ...(skopeo-copy taskRef identity omitted; see the full YAML)
          # A TaskRun WITHOUT srcImage fails this precondition -> the rule skips it
          # (allowed), the opposite of the fail-closed instinct. Deliberate scope
          # cut: this rule only judges a srcImage that is present; the "no visible
          # source" case is owned by §4.5.1's noVisibleSource deny
          - key: "{{ (request.object.spec.params || `[]`)[?name=='srcImage'].value | [0] || '' }}"
            operator: NotEquals
            value: ""
      validate:
        deny:
          conditions:
            all:
              - key: "{{ buildLabelBad }}"
                operator: Equals
                value: true
```

A label key containing dots needs quoting to drill down in JMESPath — for example `{{ imgdata.configData.config.Labels."org.opencontainers.image.source" || 'MISSING' }}` — and then reads out normally.

:::warning Four limitations — weigh them before you use this

1. **It can only read images that already exist at admission time.** In a copy / promotion scenario the dest image is produced by this very operation and does not exist yet at admission — **only the source can be validated**; the dest's properties must wait until it has landed in the registry, to be validated by deployment-side admission ([§4.5.3](#s4-5-3)) or a dedicated gate task.
2. **Mutable tags race**: admission reads the config the tag points at right now; by the time the copy actually runs, the tag may have been re-pushed. To close that gap, have the upstream resolve tags into digests first, and have the policy validate only digest-form references.
3. **Private registries need credentials**: Kyverno pulls the image under **its own identity** and must be configured with the corresponding imagePullSecret / registry credentials, or the rule errors out on the failed pull. **The direction is fail-closed**: point `srcImage` at an unreachable address (`192.0.2.1/ops/nowhere:latest`) and the request is **denied**, with this policy's name in the denial message; the same policy allows a reachable image. **So the moment the registry becomes unreachable or the credentials expire, every pipeline passing through this policy is denied across the board** — decide before go-live whether that is the direction you want (if you want fail-open, the only option is not to use this class of criterion; Kyverno has no "allow when external data cannot be fetched" switch).
4. **It puts external network onto the admission path.** One admission verdict now waits for a registry round trip, which can push latency from ordinary admission's hundreds of milliseconds **up into the seconds**, with high variance (registry distance, image size, cache hits); **a cold-start first call can even run straight into the webhook timeout**: `failed calling webhook "validate.kyverno.svc-fail": context deadline exceeded`, passing only on retry. When the registry is slow, rate-limited, or unreachable, **every** request matched by this rule slows down or fails — load-test before go-live in air-gapped and large-scale environments, and narrow the match to only the Tasks that genuinely need it. Order-of-magnitude reference from this document's verification environment: the same `--dry-run=server` probe returns an allow in about **3 seconds** against a reachable image, and a deny after about **5 seconds** when pointed at an unreachable address (including the `kubectl` round trip) — **both figures far above any admission verdict that reads no external data**. Use them as a reference for "should this rule sit on the main path or not", but measure your own environment's actual numbers yourself.

:::

:::details Full policy YAML: promotion-source-image-labels

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: promotion-source-image-labels
spec:
  background: false
  rules:
    - name: src-image-must-carry-build-label
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      preconditions:
        all:
          # Narrow to the copy Task and require a source ref to exist.
          # Read the name from BOTH shapes: an in-cluster taskRef puts it in
          # .name, while a resolver-backed one (hub/git/cluster) leaves .name
          # empty and carries the name in .params. Matching only .name would
          # silently skip every resolver-backed TaskRun -- a fail-open.
          # For production, tighten this to the full resolver coordinates
          # (resolver + catalog + name + version) as shown in §4.5.1.
          - key: "{{ request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || '' }}"
            operator: Equals
            value: skopeo-copy
          - key: "{{ (request.object.spec.params || `[]`)[?name=='srcImage'].value | [0] || '' }}"
            operator: NotEquals
            value: ""
      context:
        - name: srcRef
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='srcImage'].value | [0]"
        # Kyverno pulls the image config from the registry during admission.
        - name: imgdata
          imageRegistry:
            reference: "{{ srcRef }}"
        # A missing label must not fail open: default to MISSING so the comparison
        # below still denies. Compare inside JMESPath rather than with a Kyverno
        # NotEquals -- operator coercion would swallow a forged numeric-looking
        # label value such as "1" and let the image through (§6.1.7).
        - name: buildLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.build || 'MISSING') != 'tekton'"
      validate:
        failureAction: Enforce
        message: "source image must carry label build=tekton (read from the image config via imageRegistry)."
        deny:
          conditions:
            all:
              - key: "{{ buildLabelBad }}"
                operator: Equals
                value: true
```

:::

**First establish what labels the image in your hands actually carries** — this section's criteria assert **concrete values**, and this document cannot prepare a labeled image for your environment. So the order is "read the image first, then write the criterion", not the other way around:

```bash
# Any image your own registry serves. Run this from a client that can reach it --
# it is the same read the policy performs at admission time, just done by hand.
# Fill the reference once; both commands read it.
IMAGE_REF='<image>:<tag>'
# macOS clients need --override-os linux --override-arch amd64 here: manifest lists
# carry no darwin entry, and skopeo picks by the CLIENT platform (hit live during validation).
skopeo inspect "docker://$IMAGE_REF" | jq '.Labels'
# crane instead of skopeo:
crane config "$IMAGE_REF" | jq '.config.Labels'
```

Write the positive case with the real key/value you read back, then write the negative case with **the same key paired with a value the image does not have**. **If the output is `null` or `{}`, or the key you want to assert is missing, this image is unsuitable as this section's positive case**: this rule's intended subjects are **product images built by your own pipelines, carrying metadata** (both `build` and `org.opencontainers.image.source` are injected at build time); against third-party base images without these labels it will simply deny everything. Either switch to a self-built image, or narrow this rule's match to cover only self-built products.

Two easily misread phenomena along the way: **① whether these labels exist at all depends entirely on your environment's base-image build pipeline** — there is no universal law that "internal images carry them by default". Before writing a criterion, use the `skopeo inspect` above (or an equivalent) to confirm which labels the target image **actually** carries: "it reads back empty" may simply be the norm in your environment — it means the image was built without this metadata injected, not that the command is wrong (the fixture busybox in this document's verification environment happens to carry `build=tekton` and `org.opencontainers.image.source` — a product of that environment's build pipeline, not a general rule). **② Having labels is not the same as having the key you want**: the Tekton controller image on the same cluster also carries `build=tekton`, but has **no** `org.opencontainers.image.source`. So confirm key by key; do not write the criterion just because "the labels are non-empty" — when the key is missing, this rule denies that image, and it is not a configuration error.

**Both complete YAML listings above assert only the single label `build`** (the `buildLabelBad` line) — do not assume they also govern `org.opencontainers.image.source` along the way. To switch to (or add) another key, the line you change is the one in context, identical in shape — a dotted key must be quoted to drill down:

```yaml
        - name: sourceLabelBad
          variable:
            jmesPath: "(imgdata.configData.config.Labels.\"org.opencontainers.image.source\" || 'MISSING') != 'ops/baseimage'"
```

Adding it also means wiring `sourceLabelBad` into `deny.conditions` (as a sibling of `buildLabelBad`; `any` means either miss denies, `all` means it denies only when both miss); **adding the variable in context without wiring it into conditions changes nothing about the criterion** — precisely the hardest-to-spot variant of "the policy is installed but not in effect" ([§6.1.2](#s6-1-2)). And when you wire it in, **change `validate.message` at the same time**: wire the criterion in, then hit it with an image that "has `build` but no source label" — it gets denied, yet the message still reads only `must carry label build=tekton`, and the person blocked goes off to investigate a label that was compliant all along ([§4.0.6](#s4-0-6)'s minimum standard). With both criteria in place, write the message like this (naming both keys, so people know which two to check):

```yaml
        message: >-
          source image must carry an approved value for BOTH labels build and
          org.opencontainers.image.source; read the labels in the image config to
          see what this image actually has.
```

Note that this message **names only the keys and never the approved values**: writing "the approved value is X" hands the allowlist to everyone who gets denied ([§4.0.6](#s4-0-6), third rule). The concrete value `build=tekton` appears in this document's prose because it is the verification environment's value — that does not make it fit for a denial message.

**Verification essentials**: run the same `skopeo-copy` TaskRun through `kubectl create --dry-run=server` — with the criterion filled with the image's real label value (`build=tekton` in this document's verification environment) it is allowed; with the requirement changed to `build=production`, which the image does not have, it is denied with the policy message passed through. The negative case is mandatory: it proves the value really is read out of the image config, rather than allowed by default because nothing could be read. If you added the source-label criterion per the paragraph above, run its positive and negative cells the same way — **a newly added criterion must be verified in its own right; do not expect the `build` cell to vouch for it**.
#### 4.5.3 Run-image allowlist (hard blocking at the Pod layer) {#s4-5-3}

- **What it governs**: **the container images that actually run in the pipeline must come from approved registries**. The previous sections all governed "what was written in the parameters"; this one governs "which image ultimately executes" — the only blocking point where a hard verdict can be rendered on the **images that actually run**.
- **Why it is hard**: ① the TaskRun layer **cannot see** the step images of a reference-style task ([§2.1](#s2-1) observation point 4); only on the Pod are the resolved, real values present; ② images have **three entry paths**, and missing any one of them leaves a bypass surface — Pod CREATE, plain Pod UPDATE (Kubernetes allows changing the image of `containers` / `initContainers`), and the `pods/ephemeralcontainers` subresource UPDATE that injects debug containers after the fact; ③ the scope must be limited to Tekton-created Pods, or every business Pod in the namespace gets caught in the crossfire — yet the value of that `managed-by` label is **platform-configurable**, so hardcoding it produces a silent mismatch.
- **How the policy is layered**: ① scope in Tekton Pods via Tekton's `managed-by` label, with the label value actually resolved from `config-defaults` (distinguishing a missing key from an explicitly empty value) → ② three rules cover CREATE / plain UPDATE / the `ephemeralcontainers` subresource respectively, with `foreach` asserting each image one by one → ③ besides the business registries, the allowlist must also include the five repository classes of **Tekton infrastructure images** (entrypoint / nop / shell / sidecar log results / workingdirinit), or compliant pipelines themselves fail to start → ④ while you are at it, lock the identity label as **immutable** — otherwise an attacker can first delete the label and then slip in through the subresource.
- **What it cannot govern**: what it guarantees is "the image comes from an approved repository" — **not that the image content is trustworthy**. Signature / attestation verification (verifyImages) also acts at the Pod layer, but belongs to the companion document. Also, placeholders such as `<approved-registry-regex>` are **regex fragments, not hostnames**; metacharacters must be escaped character by character at substitution time (see design point 2 below) — copying them verbatim widens the match surface.

**The key criterion** — the regex is **declared exactly once** and `foreach` references it per container; a single expression accommodates both classes, "business registries" and "Tekton infrastructure images":

```yaml
      context:
        # The only place either placeholder appears in this policy.
        - name: allowedImageRe
          variable:
            value: "^((<approved-registry-regex>)/.*|(<tekton-infra-image-regex>)(:|@).*)$"
      validate:
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
```

The two placeholders mean entirely different things: `<approved-registry-regex>` matches a **registry prefix** (followed by `/.*`), while `<tekton-infra-image-regex>` matches a **full repository** (followed by `(:|@)`, i.e. a tag or digest). How to generate them is covered in the two subsections below.

Six design points you must understand:

- **Scope to Tekton Pods, but never hardcode the label value.** Read the full JSON of `tekton-pipelines/config-defaults` and **distinguish a missing key from an explicitly empty value**: only when `default-managed-by-label-value` is **absent** does Tekton's default `tekton-pipelines` apply; a key that exists with an empty value does **not** take the default branch — the controller will write an empty label value, which is a deployment blocker: it must be changed to a non-empty value first, and the policy rendering must not fall back on its own. Substitute the exact, non-empty resolved value into every `<tekton-managed-by-label-value>` in the policy, and lock the label against deletion and modification on plain Pod UPDATE — otherwise a custom value silently mismatches every rule, or an attacker can first remove the label and then dodge the `ephemeralcontainers` subresource. Changes to that ConfigMap must be RBAC-controlled and released **atomically** with a policy re-render.
- **The placeholders are regex fragments, not raw hostnames.** At substitution time, escape RE2 metacharacters character by character; for the legal shapes of registries / repositories, at minimum apply `.` → `[.]`, `[` → `[[]`, `]` → `[]]`, so `[2001:db8::1]:5000` renders as `[[]2001:db8::1[]]:5000`. This backslash-free form also sidesteps the escaping problems of YAML double quotes; stuffing a hostname containing `.` or IPv6 brackets straight into `regex_match` either widens the match or breaks the expression.
- **The allowlist must include the current configuration of the five Tekton infrastructure image repository classes.** How to obtain the values is in the next subsection — **the two readings are combined**; using only one of them goes wrong either way.
- **The message must name the offending image**, and **the regex may be declared only once**. The first half is for users (seeing only `PodCreationFailed`, with a dozen containers in one Pod, you cannot tell which one to fix); the second half is for maintainers. Three real constraints dictate the current shape: ① **`element.*` cannot appear in `validate.message`** — Kyverno rejects the policy at creation time (`variable 'element.name' present outside of foreach at path /validate/message`), and `foreach` entries have no `deny.message` field either — so the only option is to recompute a `badImages` list in `context` with the same regex; ② that recomputation must **not copy the regex** — put the regex into a `variable` and reference it everywhere, and the placeholder remains in exactly **one place** (an early draft repeated the same regex 5 times; missing one spot during substitution raises no error, it just makes the message report images that do not match the ones actually denied); ③ referencing that variable inside `jmesPath` must be written as the **quoted `'{{ allowedImageRe }}'`** — written as the bare identifier `regex_match(allowedImageRe, image)`, JMESPath looks it up as a **field of the resource**, gets null, and the whole message renders as an empty string (the judgment stays correct, but the user gets no information at all). Two more traps: the `|` in `[a, b][] | [?...]` is required (**without it the filter silently returns `[]`** and the message becomes "offending images: []" — more misleading than saying nothing); and pick out only the non-compliant images — **do not print the whole allowlist into the message** (that leaks the approved list to pipeline users, [§4.0.6](#s4-0-6)).

:::warning Two directions a broken regex can take (opposite directions — learn to recognize both)

The regex now lives in a single place, but it can still be written wrong (a missed escape, unbalanced parentheses). The two failure modes present completely differently; sort out which one you have before troubleshooting:

- **The regex used by the `deny` criterion is invalid** (unbalanced parentheses, say) → **every request is denied**, compliant Pods included. **Fail-closed, and loud** — the first pipeline after switching to Enforce fails; you cannot miss it.
- **Only the `badImages` (message-side) computation is wrong** (invalid regex, or out of sync with the criterion) → **the judgment is entirely correct, but the message lists compliant images too**. For a Pod with a compliant sidecar plus a violating main container, both images appear in the message. **Fail-safe but quiet** — nobody suspects a policy that correctly blocks violating images, so users follow the message and go fix the image that was compliant all along.

So after substituting `<approved-registry-regex>`, **run both the positive and the negative probe**: the violating Pod must be denied **with only that one image in the message**, and the compliant Pod must be allowed (probes 1 and 2 of the 9 self-check probes in [§4.5.3](#s4-5-3)).

:::
- **What is asserted is the raw string `element.image` from the request, not Kyverno's parsed `images.*`.** The two are not the same thing: an image without a registry (`nginx:1`) is **kept as-is** in `element.image`, so it matches no `<registry>/...` prefix and is **denied** (fail-closed — the direction you want); whereas the `registry` Kyverno puts into the `images` context is its **normalized** value (`nginx:1` gets completed to `registry=docker.io`). Switching to `images.*` swaps the criterion's root of trust from "what the request says" to "how Kyverno normalizes" — an extra layer of configurable behavior out of thin air. **Keep asserting the raw field.**
- **`foreach` iterates the three container lists explicitly** (`containers` / `initContainers` / `ephemeralContainers`), asserting each image — clearer than `pattern`, and it can name the violating image in the message. A plain Pod UPDATE can modify the image of `containers` / `initContainers`, so the first rule must **match both CREATE and UPDATE**; `ephemeralContainers`, by contrast, are injected **after Pod CREATE** through the `pods/ephemeralcontainers` subresource UPDATE and require the separate `v1/Pod/ephemeralcontainers` rule.

:::details Full policy YAML: pod-image-registry-allowlist (three rules)

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pod-image-registry-allowlist
spec:
  background: false
  rules:
    - name: tekton-step-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - Pod
              operations:
                - CREATE
                - UPDATE
              namespaces:
                - policy-poc
              # scope to Tekton-created pods ONLY — do not touch ordinary workloads
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # The regex lives here ONCE; every judgment below references this
        # variable, so there is no second copy of the placeholders to forget.
        - name: allowedImageRe
          variable:
            value: "^((<approved-registry-regex>)/.*|(<tekton-infra-image-regex>)(:|@).*)$"
        # Name the offending image in the message: `element.*` is NOT allowed in
        # validate.message (Kyverno rejects the policy), so recompute the failing
        # images here. Two shapes matter: the `|` before the filter is required --
        # without it the flatten silently yields [] -- and the variable must be
        # written as a quoted '{{ ... }}', because a bare identifier inside
        # jmesPath resolves against the RESOURCE, not the context.
        - name: badImages
          variable:
            jmesPath: >-
              [request.object.spec.containers,
              request.object.spec.initContainers || `[]`][]
              | [?!regex_match('{{ allowedImageRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "pod image is not in the approved registry / tekton infra allowlist: {{ badImages }}"
        # foreach explicitly iterates each container list; each image must match an approved registry
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
          - list: "request.object.spec.initContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
    - name: tekton-managed-by-label-is-immutable
      match:
        any:
          - resources:
              kinds:
                - v1/Pod
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: oldManagedByMatches
          variable:
            jmesPath: >-
              (request.oldObject.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
        - name: newManagedByMatches
          variable:
            jmesPath: >-
              (request.object.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
      preconditions:
        all:
          # Once Tekton marks a Pod, keep that identity marker for every later
          # subresource gate, including ephemeralcontainers.
          - key: "{{ oldManagedByMatches }}"
            operator: Equals
            value: true
      validate:
        failureAction: Enforce
        message: The Tekton managed-by label is immutable for the lifetime of the Pod.
        deny:
          conditions:
            any:
              - key: "{{ newManagedByMatches }}"
                operator: Equals
                value: false
    - name: tekton-ephemeral-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - v1/Pod/ephemeralcontainers
              operations:
                - UPDATE
              namespaces:
                - policy-poc
              # Ephemeral containers are injected after Pod CREATE through a
              # dedicated subresource, so they need a separate admission rule.
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # Same one-copy rule as the first rule: the prefix regex is declared once
        # (this rule allows no infra repositories -- debug containers have no
        # business coming from there).
        - name: approvedRegistryRe
          variable:
            value: "^(<approved-registry-regex>)/.*$"
        - name: badImages
          variable:
            jmesPath: >-
              (request.object.spec.ephemeralContainers || `[]`)
              [?!regex_match('{{ approvedRegistryRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "Tekton Pod ephemeral containers must use an approved registry: {{ badImages }}"
        foreach:
          - list: "request.object.spec.ephemeralContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(approvedRegistryRe, element.image) }}"
                    operator: Equals
                    value: false
```

:::

##### How to generate `<tekton-infra-image-regex>` (complete worked example)

The section above only said "the allowlist must include the five infrastructure image classes"; here is the complete, followable procedure. **The key insight: the image addresses admission sees are the shape *after* the platform's image rewriting** — the controller start-up arguments (command A) give the **pre-rewrite** addresses but a complete inventory; sampling real Pods (command B) gives the post-rewrite shape but an inventory that is **necessarily incomplete** (you only see the classes that happened to run). So the correct source for the allowlist is: **A takes the inventory → A2 swaps the address prefix for the platform's private registry address → B does cross-checking only**:

```bash
# A. The five infrastructure image classes declared in the controller start-up args
#    (the complete candidate set)
# Derive it here, UNCONDITIONALLY: reusing whatever $TEKTON_NS the shell happens to
# hold would read another cluster's namespace, and an allowlist built from the wrong
# controller misses every real infrastructure image. Three outcomes again -- a failed
# query is not "the field is empty", so it must stop you rather than fall back.
# Clear it first: `infra` is only assigned inside the success path below, so in a REUSED
# interactive shell a failed A would leave the PREVIOUS run's value in place -- and A2's
# emptiness guard would happily build an allowlist from another controller's images.
unset infra
if ! ns=$(kubectl get tektonconfig config -o jsonpath='{.spec.targetNamespace}' 2>&1); then
  echo "cannot read TektonConfig ($ns) -- fix this before building the allowlist"
else
  TEKTON_NS=${ns:-tekton-pipelines}   # empty field = Tekton's own default
  echo "reading controller args from: $TEKTON_NS"
  # Capture before piping: a failed read piped into jq produces NO images and no error
  # of its own, which looks exactly like "this controller declares none" -- and an
  # allowlist built from that rejects every Tekton Pod.
  if ! controller=$(kubectl -n "$TEKTON_NS" get deploy tekton-pipelines-controller -o json 2>&1); then
    echo "cannot read the controller Deployment ($controller) -- stop here"
  else
    infra=$(printf '%s' "$controller" \
      | jq -r '.spec.template.spec.containers[0].args as $a
               | range(0; $a|length) as $i
               | select($a[$i] | test("^-(entrypoint|nop|shell|sidecarlogresults|workingdirinit)-image$"))
               | $a[$i+1]')
    # Read succeeded but matched nothing: a different container order, renamed flags or
    # a new packaging all produce an EMPTY list here, which reads as "this controller
    # declares no infrastructure images". Say so instead of returning silence.
    if [ -z "$infra" ]; then
      echo "no infrastructure image flags matched -- inspect the args by hand:"
      printf '%s' "$controller" | jq -r '.spec.template.spec.containers[].args'
    else
      printf '%s\n' "$infra"
      echo "matched $(printf '%s\n' "$infra" | wc -l) of the 5 flag classes"
    fi
  fi
fi

# A2. Rewrite A's entries into the form admission ACTUALLY sees: swap the registry
#     host for the platform's private registry address, keep the repository path.
#     The platform records that address in the global-info ConfigMap (kube-public,
#     field registryAddress). Same three-outcome discipline: a failed read must stop
#     you -- allowlisting the PRE-rewrite addresses rejects every Tekton Pod.
#     A2 also refuses when A produced nothing: A's failure branches only PRINT, and this is
#     a separate `if`, so without this guard a failed A leaves $infra unset and the pipe below
#     emits an empty allowlist -- indistinguishable from "this controller declares no
#     infrastructure images", which is exactly the reading that gets every Tekton Pod rejected.
if [ -z "${infra:-}" ]; then
  echo "command A produced no infrastructure images -- fix A first; do NOT build the allowlist"
elif ! REG=$(kubectl get cm -n kube-public global-info -o jsonpath='{.data.registryAddress}' 2>&1); then
  echo "cannot read global-info ($REG) -- stop here, do NOT allowlist pre-rewrite addresses"
elif [ -z "$REG" ]; then
  echo "global-info carries no registryAddress -- find your platform's private registry address first"
else
  printf '%s\n' "$infra" | sed "s#^[^/]*/#${REG}/#" | sort -u
fi

# B. CROSS-CHECK ONLY -- sample the images admission actually saw on real Tekton
#    Pods. Every repository listed here must appear in A2's output; anything extra
#    means the prefix-rewrite rule is wrong or a sixth image class exists, so stop
#    and investigate. B is NOT a source for the allowlist: a sample only contains
#    the classes that happened to run (nop only appears when a step was skipped).
# The label value is install-specific -- read it off any Tekton-created Pod and fill
# it in here, on its own line, instead of digging it out of the query below.
TEKTON_MANAGED_BY='<tekton-managed-by-label-value>'
# Same reason as elsewhere: quoted-but-unreplaced selects zero Pods, and B's own
# "no Tekton Pods sampled" branch would then read as "nothing is running" instead of
# "you did not fill this in".
case "$TEKTON_MANAGED_BY" in '<'*'>') echo "fill in TEKTON_MANAGED_BY first"; TEKTON_MANAGED_BY='';; esac
# Capture first, same reason as command A: a failed query piped into jq yields an
# empty list and no error, which reads as "no Tekton Pods use any image".
if ! pods=$(kubectl get pods -A -l app.kubernetes.io/managed-by="$TEKTON_MANAGED_BY" -o json 2>&1); then
  echo "cannot list Tekton Pods ($pods) -- stop here"
elif [ "$(printf '%s' "$pods" | jq -r '.items | length')" = 0 ]; then
  # An empty sample is not an empty answer: it just means no Tekton Pod is running
  # right now. The allowlist still comes from A2; an empty B only means the
  # cross-check has nothing to compare against -- it blocks nothing.
  echo "no Tekton Pods sampled -- cross-check unavailable (allowlist still comes from A2)"
else
  printf '%s' "$pods" \
    | jq -r '.items[].spec | ((.initContainers // []) + .containers) | .[].image' | sort -u
fi
```

:::warning A's and B's outputs will very likely differ — and that is exactly the easiest trap in this section

- **Copying A verbatim (skipping the prefix rewrite)**: ACP's image rewriting changes the registry host. The controller arguments may say `registry.example.com/pipelines/...`, while what admission actually sees is `192.0.2.10:11443/pipelines/...`. Generate the regex straight from the start-up arguments → **every Tekton Pod is denied on the spot**, and compliant pipelines cannot start either — this is why A2 is mandatory.
- **Treating B as the inventory**: any single sample only sees the classes this batch of runs happened to instantiate. The five infrastructure image classes are not all used on every run — a sample easily contains only two or three of them (`nop` is injected only when a step was skipped, and routinely never shows up); **if no TaskRun Pod has ever run, the sample is simply empty** (the guard in the code block says so outright). Build the values from Pods alone, and the day one of the unsampled classes is actually needed it gets wrongly blocked. B has exactly one correct use: **validating A2's rewrite result** — a repository that appears in B but not in A2's output means the rewrite rule is wrong, or a sixth image class exists; find out before continuing.

The correct procedure: **A's inventory, after A2's prefix rewrite, is the sole source**; B cross-checks. Strip the tag / digest, keep only the repository, then escape character by character.

:::

```bash
# C. Strip tag/digest, escape RE2 metacharacters, join into one alternation.
#    Escape . [ ] in a SINGLE pass: replacing one of them introduces new brackets, so
#    multiple sed passes corrupt each other -- the python below guarantees one pass.
python3 - <<'EOF'
import re
# paste A2's de-duplicated repository list (NO tag, NO digest) here
repos = [
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-entrypoint",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-nop",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-shell-image",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-sidecarlogresults",
    "192.0.2.10:11443/pipelines/tektoncd-pipeline-workingdirinit",
]
esc = lambda s: re.sub(r'[.\[\]]', lambda m: {'.': '[.]', '[': '[[]', ']': '[]]'}[m.group()], s)
print("|".join(esc(r) for r in repos))
EOF
```

The generated result (for this example) — substitute it at `<tekton-infra-image-regex>` in the policy (now a single spot: the `allowedImageRe` `variable`):

```text
192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-entrypoint|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-nop|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-shell-image|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-sidecarlogresults|192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-workingdirinit
```

When the five classes share the same host and path, you can compact it by hand into the equivalent form (the two shapes behave identically):

```text
192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)
```

Paired with the business registries (example: `registry[.]example[.]com|192[.]0[.]2[.]20:60070`), the full expression in the policy renders as:

```text
^((registry[.]example[.]com|192[.]0[.]2[.]20:60070)/.*|(192[.]0[.]2[.]10:11443/pipelines/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit))(:|@).*)$
```

**Self-check after substituting** — hit the real Kyverno with `kubectl create --dry-run=server`, with one set of positive and one set of negative cases:

:::details Self-check probes (9 of them, including three near-neighbor cases proving the escaping works)

| Probe image | Expected |
|---|---|
| `…:11443/pipelines/tektoncd-pipeline-entrypoint:v1.12.0` | Allow |
| `…:11443/pipelines/tektoncd-pipeline-sidecarlogresults@sha256:0000…` | Allow (digest form) |
| `…:11443/pipelines/tektoncd-pipeline-nop:v1.12.0` | Allow (usually absent from B's sample — `nop` is injected only when a step was skipped; inventory completeness is guaranteed by commands A + A2) |
| `192.0.2.**100**:11443/…/tektoncd-pipeline-entrypoint:v1.12.0` | Deny (near-neighbor host) |
| `192.0.2.10:**11444**/…/tektoncd-pipeline-entrypoint:v1.12.0` | Deny (near-neighbor port) |
| `…:11443/pipelines/tektoncd-pipeline-**evil**:v1.12.0` | Deny (same host but not among the five classes) |
| `192**X**0.2.10:11443/…/tektoncd-pipeline-entrypoint:v1.12.0` | Deny (**proves `.` is escaped**: unescaped, this host would match via the wildcard) |
| `…/tektoncd-pipeline-entrypoint` (no tag, no digest) | Deny (the expression requires a trailing `(:\|@)` segment) |
| `docker.io/library/busybox:latest` | Deny |

:::

:::warning Do not miss the sixth class: Windows nodes

Beyond the five arguments above, the controller also has `-shell-image-win`, pointing by default at a Windows base image. If the cluster has Windows nodes running Tekton, **it must be added to the allowlist as well**, or steps on Windows get denied. A pure-Linux cluster can leave it out, but after an upgrade it is recommended to re-run command A (and A2's prefix rewrite) to re-verify whether the argument set has changed.

:::

##### Making one policy work across environments (no prefixes hardcoded in the policy)

The example above rendered the prefixes straight into the YAML; the problem is that **every environment has different registry hosts and repository paths**, so the policy body forks per environment. The better approach: **write no prefix in the policy at all, and concentrate the environment differences into one ConfigMap** — the same ClusterPolicy ships to every environment as-is, and each environment fills in only this one piece of configuration (the values are still generated by the method above: A inventory → A2 prefix rewrite, B cross-check).

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: pipeline-image-allowlist
  namespace: policy-poc
data:
  # Business registries allowed to provide step images (escaped RE2 alternation).
  approvedRegistryRegex: "<approved-registry-regex>"
  # Tekton infrastructure image repositories, WITHOUT tag or digest.
  # Generated from the live cluster: controller args UNION images seen on real Tekton pods.
  tektonInfraRepoRegex: "<tekton-infra-image-regex>"
```

Save it as `pipeline-image-allowlist.yaml`. **This ConfigMap must exist before the policy** — the policy fails closed when the ConfigMap is missing, meaning that with the install order reversed, every Tekton Pod in scope gets denied. It looks like "the allowlist is wrong" when in fact the configuration just is not in place yet:

```bash
# The ConfigMap lands in a walkthrough-owned namespace (§4.0.4): the namespace
# cascade takes it at cleanup, so a plain apply is fine here.
kubectl apply -f pipeline-image-allowlist.yaml
# Verify BOTH keys are non-empty before installing the policy below.
kubectl get cm -n policy-poc pipeline-image-allowlist \
  -o jsonpath='{.data.approvedRegistryRegex}|{.data.tektonInfraRepoRegex}{"\n"}'
# Empty on either side means the placeholder was not substituted -- go back to
# commands A and B above. With an empty value the composed expression cannot match
# any normal image reference, so every Pod in scope gets denied.
```

On the policy side, pull it in with `context.configMap` and expand the variable inside `regex_match`. **The key criterion** is these two lines — the regex is no longer a literal; it expands from the ConfigMap variables:

```yaml
      context:
        # Environment-specific values live here, not in the policy body.
        - name: allowlist
          configMap:
            name: pipeline-image-allowlist
            namespace: policy-poc
        # Assembled once from the ConfigMap; the judgments below reference it.
        - name: allowedImageRe
          variable:
            value: "^(({{ allowlist.data.approvedRegistryRegex }})/.*|({{ allowlist.data.tektonInfraRepoRegex }})(:|@).*)$"
      validate:
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
```

:::warning When switching to this form, all three rules must be switched together

This policy carries the **same name** as the one above (`pod-image-registry-allowlist`), so installing it is a **wholesale replacement**, not an addition. All three rules must therefore come along: carrying over only the first (the container image allowlist) while dropping `tekton-managed-by-label-is-immutable` and `tekton-ephemeral-images-from-approved-registries` opens two bypass paths with your own hands — an attacker deletes the scoping label so the rules mismatch, or injects unapproved images straight through the `pods/ephemeralcontainers` subresource. What follows is the complete three-rule version.

:::

:::details Full policy YAML: the ConfigMap form of pod-image-registry-allowlist (three rules)

The only difference from the literal version above: each rule that uses a regex carries its own `context.configMap`, and the regex expands from `{{ allowlist.data.* }}`. `<tekton-managed-by-label-value>` still lives in the policy body (explained at the end of this section).

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pod-image-registry-allowlist
spec:
  background: false
  rules:
    - name: tekton-step-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - Pod
              operations:
                - CREATE
                - UPDATE
              namespaces:
                - policy-poc
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # Environment-specific values live here, not in the policy body.
        - name: allowlist
          configMap:
            name: pipeline-image-allowlist
            namespace: policy-poc
        # Name the offending image in the message. The SAME regex as the deny
        # conditions below -- keep the two in sync. `[a, b][] | [?...]` needs the
        # pipe: without it the filter silently yields [] and the message lies.
        # Assembled once from the ConfigMap, then referenced everywhere below.
        - name: allowedImageRe
          variable:
            value: "^(({{ allowlist.data.approvedRegistryRegex }})/.*|({{ allowlist.data.tektonInfraRepoRegex }})(:|@).*)$"
        - name: badImages
          variable:
            jmesPath: >-
              [request.object.spec.containers,
              request.object.spec.initContainers || `[]`][]
              | [?!regex_match('{{ allowedImageRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "pod image is not in the approved registry / tekton infra allowlist: {{ badImages }}"
        foreach:
          - list: "request.object.spec.containers"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
          - list: "request.object.spec.initContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(allowedImageRe, element.image) }}"
                    operator: Equals
                    value: false
    # Unchanged from the literal-prefix variant: this rule uses no registry regex,
    # so it needs no ConfigMap context.
    - name: tekton-managed-by-label-is-immutable
      match:
        any:
          - resources:
              kinds:
                - v1/Pod
              operations:
                - UPDATE
              namespaces:
                - policy-poc
      context:
        - name: oldManagedByMatches
          variable:
            jmesPath: >-
              (request.oldObject.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
        - name: newManagedByMatches
          variable:
            jmesPath: >-
              (request.object.metadata.labels."app.kubernetes.io/managed-by" || '') ==
              '<tekton-managed-by-label-value>'
      preconditions:
        all:
          # Once Tekton marks a Pod, keep that identity marker for every later
          # subresource gate, including ephemeralcontainers.
          - key: "{{ oldManagedByMatches }}"
            operator: Equals
            value: true
      validate:
        failureAction: Enforce
        message: The Tekton managed-by label is immutable for the lifetime of the Pod.
        deny:
          conditions:
            any:
              - key: "{{ newManagedByMatches }}"
                operator: Equals
                value: false
    - name: tekton-ephemeral-images-from-approved-registries
      match:
        any:
          - resources:
              kinds:
                - v1/Pod/ephemeralcontainers
              operations:
                - UPDATE
              namespaces:
                - policy-poc
              # Ephemeral containers are injected after Pod CREATE through a
              # dedicated subresource, so they need a separate admission rule.
              selector:
                matchLabels:
                  app.kubernetes.io/managed-by: "<tekton-managed-by-label-value>"
      context:
        # Same ConfigMap, declared again: context is per-rule, not policy-wide.
        - name: allowlist
          configMap:
            name: pipeline-image-allowlist
            namespace: policy-poc
        - name: approvedRegistryRe
          variable:
            value: "^({{ allowlist.data.approvedRegistryRegex }})/.*$"
        - name: badImages
          variable:
            jmesPath: >-
              (request.object.spec.ephemeralContainers || `[]`)
              [?!regex_match('{{ approvedRegistryRe }}', image)].image
      validate:
        failureAction: Enforce
        message: "Tekton Pod ephemeral containers must use an approved registry: {{ badImages }}"
        foreach:
          - list: "request.object.spec.ephemeralContainers || `[]`"
            deny:
              conditions:
                all:
                  - key: "{{ regex_match(approvedRegistryRe, element.image) }}"
                    operator: Equals
                    value: false
```

:::

Note that `<tekton-managed-by-label-value>` **still lives in the policy body**: what this form consolidates is the environment-specific registry prefixes; the scoping label value is a different class of configuration (how to obtain it is in the placeholder table in [§4.0.3](#s4-0-3)), and if it too needs central management, it can move into this same ConfigMap.

Three actual behaviors worth knowing:

- **The variables expand correctly inside `regex_match`**: compliant infra images (tag form and digest form) are allowed; `…/tektoncd-pipeline-evil` on the same host but outside the five classes, and `docker.io/library/busybox`, are both denied; a forged `evil.example/anything/tektoncd-pipeline-entrypoint:v1` is denied too — the host anchor still holds.
- **Changing environments changes only the ConfigMap**: patch `tektonInfraRepoRegex` from one environment's prefix to another and it takes effect (Kyverno's ConfigMap context has a short-lived cache — wait a moment after the change before verifying); not a single character of the policy YAML changes: the new prefix is allowed, the old prefix is immediately denied.
- **A missing ConfigMap is fail-closed, not fail-open**: delete the ConfigMap and Pods that were compliant get denied too, with an error that explicitly states `failed to retrieve config map for context entry allowlist`. The security direction is right, but **mind the availability**: the deployment order must put the ConfigMap before the policy, and the ConfigMap must come under GitOps and RBAC protection — **whoever can change it == whoever can change the image allowlist**; the permission bar equals changing the policy itself.

##### Two relaxed forms when you do not want to maintain hosts (with a strength comparison)

Some environments are unwilling to maintain a registry host per cluster (image rewriting changes the host, see above) and want the policy text to carry no environment information at all. In that case, **do not fall straight back to "any prefix"** — there is a clearly safer intermediate tier: **the host is open, but only one segment is allowed, and the project path and image names are all pinned**.

```text
# Form B (the recommended relaxation): host contains no '/', project path and image names are pinned
^[^/]+/<project-path>/tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)(:|@).*$

# Form C (widest, not recommended as a default): the prefix is unconstrained
^(.*/)?tektoncd-pipeline-(entrypoint|nop|shell-image|sidecarlogresults|workingdirinit)(:|@).*$
```

The key difference is `[^/]+` versus `.*`: the former allows only **one segment** of host (shapes like `registry.example.com:5000`), sealing off the entire "sneak in an extra path level" space; the latter tolerates any depth. Strength comparison across the three forms (form A being the ConfigMap form above):

| Probe image | A pinned host | B `[^/]+` + fixed path | C any prefix |
|---|:---:|:---:|:---:|
| `192.0.2.10:11443/pipelines/tektoncd-pipeline-entrypoint:v1.12.0` | ✅ Allow | ✅ Allow | ✅ Allow |
| `harbor.example.net:5000/pipelines/tektoncd-pipeline-nop@sha256:…` (**another environment's host**) | ❌ Deny (requires a ConfigMap change) | ✅ Allow (exactly the point of the relaxation) | ✅ Allow |
| `evil.example/**anything**/tektoncd-pipeline-entrypoint:v1` | ❌ Deny | ❌ **Deny** | ⚠️ **Allow** |
| `192.0.2.10:11443/pipelines/**sub**/tektoncd-pipeline-entrypoint:v1` (an extra level inserted) | ❌ Deny | ❌ **Deny** | ⚠️ **Allow** |
| `…/pipelines/tektoncd-pipeline-**evil**:v1` | ❌ Deny | ❌ Deny | ❌ Deny |
| `docker.io/library/busybox:latest` | ❌ Deny | ❌ Deny | ❌ Deny |
| `**evil.example**/pipelines/tektoncd-pipeline-entrypoint:v1` | ❌ Deny | ⚠️ **Allow** | ⚠️ Allow |

:::warning The cell form B does not close (the last row of the comparison table)

As soon as an attacker pushes an image as `<their own host>/<project-path>/tektoncd-pipeline-entrypoint`, form B still allows it — **the image name is a caller-controlled string, not an identity**.

Form B's value is raising the bypass cost from "name it whatever" to "must replicate the project path and image name exactly, with not one extra directory level", while being **entirely environment-free and directly reusable across clusters**; it does not stop someone bypassing on purpose. Truly closing this cell means going back to form A (pin the host, and stay generic via the ConfigMap scheme above).

**Do not make form C the default**: it even allows the "extra path level" case; in practice it only stops unintentional overreach of the "casually wrote `docker.io/library/busybox`" kind.

:::

:::details Full verification checklist (end-to-end + subresources + no scope collateral damage)

- A Tekton TaskRun with a violating image (`docker.io/library/busybox`) → the Pod is denied, **TaskRun terminal state `PodCreationFailed`** (the message carries the full policy text; the Pod was never created);
- An **ordinary non-Tekton Pod** in the same namespace (also using a `docker.io` image) **is created as usual, no collateral damage** — the scoping works;
- A Tekton-labeled Pod forging `evil.example/<project-path>/tektoncd-pipeline-entrypoint:fake` is denied, proving that an arbitrary host is not trusted on repository path alone;
- With the policy active, a full pipeline using compliant images runs end-to-end to `Succeeded`;
- Create a separate live Pod carrying the Tekton label: a patch deleting the label is denied; a subsequent `pods/ephemeralcontainers` patch with `docker.io/library/busybox` is denied while a patch with an approved-registry image succeeds, and the approved ephemeral container is visible in the live Pod; a plain Pod UPDATE with an approved main image is allowed, while an unapproved main image and an unapproved init image are both denied;
- With the legal managed-by string `"false"`, a plain UPDATE attempting to change the label to the number-like string `"1"` is denied; an unapproved ephemeral image is still denied afterwards — proving the identity label cannot first be bypassed via type coercion and then escape the subresource selector;
- A server dry-run using a workingdirinit repository on a bracketed IPv6 registry: the exact host is allowed, the near-neighbor host differing by one character is denied.

**Parameterization boundary**: `"1"`, `"false"`, `"null"` are all legal, non-empty Kubernetes label strings. `<tekton-managed-by-label-value>` in the policy and the probes must sit inside YAML quotes, or it gets parsed as an integer, a boolean, or null. The label immutability check must likewise first compute an exact string-equality boolean in JMESPath and hand Kyverno a boolean comparison — never compare number-like strings directly with `NotEquals`.

:::

Image **signature / attestation** verification (verifyImages) likewise acts at the Pod layer — see the companion document *Software Supply Chain Security of ACP with Tekton and Kyverno*.
#### 4.5.4 Closing the bare Tekton Run entrance (contract 7) {#s4-5-4}

- **What it governs**: **plug the gap of "bypassing the pipeline by creating bare TaskRuns / CustomRuns directly"**. Every gate so far hangs on the pipeline path; if someone can create a bare TaskRun of their own to run builds, push images, or deploy, all of those gates are bypassed at once.
- **Why it is hard**: how do you tell "a legitimate child Run created by the controller" from "a Run a user created bare, by hand"? The most intuitive answer is to look at `ownerReferences` — a legitimate child Run carries a PipelineRun owner ref with `controller: true` from the instant it is created. **But that field is written by whoever creates the object**: an attacker creating a bare TaskRun can forge an owner ref pointing at a real PipelineRun (the uid is readable in their own namespace), and Kubernetes does not verify its authenticity by default — trusting it amounts to fail-open.
- **How the policy is layered**: ① the hard guarantee is anchored in **`request.userInfo`** — filled in by the API server from the authenticated request and unforgeable by clients; "the creator == the Tekton controller SA" is an unforgeable proof of origin; ② `ownerReferences` is then used as an **additional AND condition for defense in depth** — **added only on the controller-SA path** (the legitimate path carries it anyway, at zero cost; and even a successful forgery is still caught by the userInfo check); ③ the platform-administrator identity is an **independent OR branch** that **does not require an owner ref** — it is this entrance's break-glass clause: whoever is on that list can bypass this section's closure.
- **What it cannot govern**: what it closes is **only the bare Tekton Run path** — it does not mean "no workload may ever run outside the pipeline": anyone with the API permissions can still create Pods / Jobs / Deployments directly, or use the deployment credentials somewhere else. **"The pipeline cannot be bypassed" is the joint product of RBAC plus this policy**: RBAC narrows business identities' direct permissions on workload APIs and deployment credentials; this policy only fills in the bare-Run piece.

**Key criterion** — on the **Tekton controller path**, userInfo is the anchor and the owner ref an additional AND; **the platform-administrator identity is a separate OR branch that does not require an owner ref** (the break-glass clause: whoever is on this list is exactly who can bypass the entry closure):

```yaml
        - name: allowed
          variable:
            jmesPath: "(creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller' && hasControllerOwner) || contains(['<platform-admin-identity>'], creator)"
      validate:
        deny:
          conditions:
            all:
              - key: "{{ allowed }}"
                operator: Equals
                value: false
```

:::warning ownerReference is defense in depth, not an identity boundary

Do not treat "forged owners get cleaned up by garbage collection" as a line of defense; it has two gaps:

- **GC is asynchronous.** Once the TaskRun passes admission, its Pod is scheduled and running almost immediately; by the time GC deletes it, that ungated build / release may already have finished — the bypass has already happened.
- **The owner can point at a real object.** As long as the forged uid points at a PipelineRun that exists, GC never triggers at all.

So the **hard guarantee of identity lives in `request.userInfo`**; `ownerReference` is only a layer stacked on top of it.

:::

:::details Full policy YAML: pipeline-entry-lockdown

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-entry-lockdown
spec:
  background: false
  rules:
    - name: only-controller-creates-runs
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
                - tekton.dev/v1beta1/CustomRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        - name: creator
          variable:
            jmesPath: "request.userInfo.username || ''"
            default: ""
        # defense-in-depth: does this Run carry a real controller PipelineRun
        # owner? the reconciler sets it via SetControllerReference on every child
        - name: hasControllerOwner
          variable:
            jmesPath: "length((request.object.metadata.ownerReferences || `[]`)[?controller==`true` && kind=='PipelineRun']) > `0`"
        # allowed iff: controller SA AND owned by a controller PipelineRun (the
        # governed path), OR an explicit break-glass admin identity. userInfo is
        # the unforgeable anchor. The owner ref is an added AND condition ON THE
        # CONTROLLER BRANCH ONLY -- the admin branch is a bare identity check, so
        # anyone on that list can create a bare TaskRun with no owner reference.
        - name: allowed
          variable:
            jmesPath: "(creator=='system:serviceaccount:tekton-pipelines:tekton-pipelines-controller' && hasControllerOwner) || contains(['<platform-admin-identity>'], creator)"
      validate:
        failureAction: Enforce
        message: >-
          TaskRun/CustomRun may only be created by the Tekton controller as part
          of a governed PipelineRun (controller SA AND a controller PipelineRun
          ownerReference), or by a break-glass platform admin identity — bare or
          orphan runs bypass the pipeline gates.
        deny:
          conditions:
            all:
              - key: "{{ allowed }}"
                operator: Equals
                value: false
```

:::

:::details Verification checklist (probes + end to end)

| Scenario | Expected |
|---|---|
| Bare TaskRun created under a non-controller identity | Denied |
| Bare CustomRun | Denied |
| **Forged `ownerReferences`, but userInfo is not the controller** | **Still denied** (an owner ref cannot make up for userInfo) |
| Controller identity + a controller PipelineRun owner | Allowed |
| Controller identity but **no** owner ref (anomaly / spoof) | Denied |
| A dedicated break-glass ServiceAccount (first granted minimal TaskRun create permission in RBAC) | Explicitly allowed by this policy |
| A normal PipelineRun end to end | `Succeeded`; the real child TaskRuns created by the controller are unaffected |

break-glass is **dual-layer authorization**: Kubernetes RBAC and the Kyverno allowlist are both required.

:::

This policy and RBAC are complementary: RBAC decides "who has API permission — whether they can create Pods / Jobs / Deployments directly"; among the identities that do have permission, this policy further plugs the bare Tekton Run gap. For production, the allowlist should also include the legitimate platform automation identities (triggers / GitOps controllers, and so on) — and note that **every identity you allowlist is an identity you have opened the bare-Run entrance for**, so evaluate that identity's own RBAC along with it.

#### 4.5.5 Release-target allowlist (real profile: java / python `-image-build-scan-deploy` 0.3) {#s4-5-5}

- **What it governs**: **the release's target parameters and credential source may only be the approved ones** — constrain the deployment-stage target parameters (namespace / workload / images, etc.) and the source of the `kubeconfig` in the two official 0.3 templates. Both templates' `deploy-or-upgrade` is the same hub `kubectl` 0.1 with the same parameter surface, so **a single rule must pin both template identities at once**; pin only one, and releases through the other template are completely ungoverned.
- **Why it is hard**: ① **the judgment point must be at PipelineRun CREATE — it cannot be pushed down to the TaskRun layer**: `deploy-or-upgrade` in the template is only a node alias; after resolution the real Task is hub `catalog/kubectl/0.1`, and its TaskRun receives only `args` and an **already-rendered `script`** — there is no `workloadNamespace` parameter to read at all; ② this version splices the target parameters **into the shell `script` by plain text substitution, unquoted**, so "just check that the namespace is on the allowlist" leaves a **command injection** open; ③ looking only at `.secret.secretName` on the `kubeconfig` workspace can be bypassed — with a PVC / CSI / configMap binding that field is empty, a naive policy simply allows it, and an attacker can plant an arbitrary kubeconfig.
- **How the policy is layered**: ① the hub source identity is validated **whether or not deployment is enabled**; ② mirror the image template's `when` — `workloadName` empty or a single space means deployment is not enabled, so target checks are skipped; ③ when deployment is enabled, `workloadNamespace` must **explicitly** hit the allowlist — **absence is denied as well**. That is deliberate: the template's semantics for absence is "use the namespace the run lives in", which hands "where does this release go" to the run's location to decide implicitly — an auditor looking at the request cannot see the target. **If your site deploys same-namespace by design**, the fix is not to delete this criterion but to normalize absence before comparing against the list (treat `targetNs == '' && contains([...], request.namespace)` as compliant), and to add a probe row for "namespace absent + current namespace on the list → allow"; ④ restrict every input that gets spliced into the shell to a **conservative grammar** (DNS-1123 label, canonical workload Kind, shell-safe image references, relative directories, integer-second timeout); ④' `workloadContainers` — although handed to the kubectl Task as an **args array** (`--containers <name>…`), quoted at every use site, and **not an injection surface** — is still validated as container-name syntax; the reason is not injection but that **only a real name takes effect**, see the "which container got updated" boundary note below; ⑤ a kubeconfig workspace that is **"bound but not a Secret" is fail-closed across the board**; ⑥ **deny any `taskRunSpecs` override on the deploy task beyond the scheduling keys** (same judgment as [§4.2.5](#s4-2-5): `nodeSelector` / `tolerations` / `affinity` / `imagePullSecrets` / `priorityClassName` allowed; any other key, and any `serviceAccountName`, denied) — `podTemplate.env` is injected into the step containers, and the kubectl Task **only `export`s `KUBECONFIG` itself when the kubeconfig workspace is bound**, so a compliant "deploy to the current cluster" request needs just one injected `KUBECONFIG` to redirect the entire release elsewhere, taking the namespace allowlist down with it; ⑦ **the two run-level entrances are handled separately** — `spec.taskRunTemplate` has exactly two fields (verified with `kubectl explain`): `podTemplate` and `serviceAccountName`. The former's `env` is fully equivalent to ⑥ (it applies to every TaskRun of this run, the deploy step included) — **denied outright**; the latter decides **under whose identity** the deploy step executes `kubectl apply` — with no kubeconfig bound, that is exactly what it uses, and pointing it at a wider-privileged SA bypasses the sentence "the constraint rests on the deploy credential's RBAC" — so it is governed by an **approved list** rather than denied outright: a run-level SA is **normal configuration**, and blanket denial would falsely reject plenty of legitimate requests. **The list must include the SA that Tekton defaulting fills in** (the first placeholder in the criterion, `<tekton-default-service-account>`) — this is established mechanism, not inference: Tekton's defaulting webhook runs before Kyverno, so admission **never sees `taskRunTemplate` absent**; it arrives already carrying the defaulting-filled SA (taken from `config-defaults`' `default-service-account`, **falling back to Tekton's built-in default when that key is missing** — this document's environment is exactly the missing case, effective value `default`) and `default-pod-template` (in this document's environment, `securityContext.fsGroup=65532`). The first version of this criterion listed only the site-approved SAs, and **every compliant request in the probes was denied** — precisely because that defaulted name was missing.
- **What it cannot govern**: it constrains **the target parameters and credential source written in the request** — it neither guarantees that the manifest content touches only that namespace (see the boundary note below) nor that the released artifact itself is trustworthy (that belongs to [§4.5.1](#s4-5-1) / [§4.5.3](#s4-5-3) and supply-chain attestation); and its strength depends on the template version — this profile is written against 0.3's real substitution behavior (this part of the data flow is identical in 0.2 and 0.3: `deploy-or-upgrade` is still `kubectl` 0.1, and the target parameters are still spliced into `script` as unquoted text), so **a template upgrade requires re-reviewing every field and the merge order**.

**General contract**: `workloadName`, `workloadKind`, `workloadNamespace`, `images`, `workloadManifestsDir`, `workloadRolloutTimeout`, and the `kubeconfig` workspace all belong to the **PipelineRun** contract. Written against TaskRun CREATE, the rule cannot read the target namespace and never takes effect against the real shape.

:::warning Why these parameters deserve a second check at admission (isn't "the pipeline will fail on its own" enough?)

Because they **are not parameters that "error out when written wrong" — they are injection surfaces spliced into shell**. A value like `workloadName` enters the kubectl Task's `script` via text substitution, unquoted — a value shaped like `x; <arbitrary command>` does not "fail", it **executes**, and it executes in a container that **already has the deployment kubeconfig mounted**. By the time the pipeline reports failure, the injected command has long since finished: **pipeline failure is an availability mechanism, not a security mechanism against hostile input.**

An admission denial, by contrast, happens at PipelineRun CREATE with zero side effects — nothing is built, no image is pushed, no credential enters any container.

Conversely, this is also this document's **criterion for choosing which parameters to govern**: govern at admission only the inputs that "admission can see, and whose failure cost is unacceptable" (those that reach the shell, decide the release target, or decide the credential source). Parameters that merely "error out on bad format, with no injection surface and no effect on privilege" should be left to fail in the pipeline itself — re-validating them in policy only adds coupling between the policy and the template version.

:::

There is one more, better-hidden bypass: **do not look only at the `kubeconfig` workspace's `.secret.secretName`**. If that workspace is bound by a **PVC / CSI / configMap** or another non-Secret source, `secretName` is empty and a naive policy allows the request — an attacker can then use a PVC to plant an arbitrary kubeconfig. A kubeconfig workspace that is "bound but not a Secret" must be **fail-closed**.

**Key criterion** — two booleans: the source identity is always validated; the deployment profile only when deployment is enabled:

```yaml
      validate:
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"        # hub source swapped (checked whether or not deploy is enabled)
                operator: Equals
                value: true
              - key: "{{ deployProfileBad }}"    # target / parameter syntax / kubeconfig source / per-task and run-wide overrides
                operator: Equals
                value: true
```

:::details Full policy YAML: release-target-allowlist

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: release-target-allowlist
spec:
  background: false
  rules:
    - name: deploy-targets-must-be-approved
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-poc
      context:
        # Lock the exact official Pipeline identity. The deployment parameters
        # are visible here, before Tekton renders them into kubectl Task script.
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: pipelineCatalog
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='catalog'].value | [0] || ''"
            default: ""
        - name: pipelineName
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0] || ''"
            default: ""
        - name: pipelineVersion
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='version'].value | [0] || ''"
            default: ""
        - name: hubTypeCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='type'])"
        - name: hubType
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='type'].value | [0] || ''"
            default: ""
        - name: hubURLCount
          variable:
            jmesPath: "length((request.object.spec.pipelineRef.params || `[]`)[?name=='url'])"
        - name: hubSourceBad
          variable:
            jmesPath: >-
              hubURLCount > `0`
              || hubTypeCount > `1`
              || (hubTypeCount == `1` && hubType != 'artifact')
        - name: workloadName
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadName'].value | [0] || ''"
            default: ""
        - name: deploymentEnabled
          variable:
            # Mirror the Pipeline when expression inside JMESPath so numeric-
            # looking names cannot trigger Kyverno condition coercion.
            jmesPath: "!contains(['', ' '], workloadName)"
        - name: workloadKindPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='workloadKind']) > `0`"
        - name: workloadKind
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadKind'].value | [0] || ''"
            default: ""
        - name: deployImages
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='images'].value | [0] || `[]`"
        - name: targetNs
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadNamespace'].value | [0] || ''"
            default: ""
        - name: workloadManifestsDir
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadManifestsDir'].value | [0] || ''"
            default: ""
        - name: workloadRolloutTimeoutPresent
          variable:
            jmesPath: "length((request.object.spec.params || `[]`)[?name=='workloadRolloutTimeout']) > `0`"
        - name: workloadRolloutTimeout
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadRolloutTimeout'].value | [0] || ''"
            default: ""
        - name: workloadContainers
          variable:
            jmesPath: "(request.object.spec.params || `[]`)[?name=='workloadContainers'].value | [0] || `[]`"
        - name: kubeconfigWs
          variable:
            jmesPath: "(request.object.spec.workspaces || `[]`)[?name=='kubeconfig'] | [0] || `{}`"
        - name: kubeconfigSecret
          variable:
            jmesPath: "kubeconfigWs.secret.secretName || ''"
            default: ""
        # An absent workspace is allowed and means the current cluster. If a
        # kubeconfig binding exists, only an approved Secret is inspectable here.
        - name: kubeconfigNonSecret
          variable:
            jmesPath: "length(keys(kubeconfigWs)) > `0` && kubeconfigSecret == ''"
        - name: nsBad
          variable:
            # Site-specific allowlist: list every approved deployment namespace
            # here (two shown). An unreplaced value rejects all compliant runs.
            jmesPath: "!contains(['<approved-deploy-namespace-a>','<approved-deploy-namespace-b>'], targetNs)"
        - name: workloadNameBad
          variable:
            # This production profile deliberately narrows names to one DNS-1123
            # label before the Pipeline substitutes the value into shell text.
            jmesPath: "!regex_match('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', workloadName) || length(workloadName) > `63`"
        - name: workloadKindBad
          variable:
            # Absence uses the trusted Pipeline default Deployment. Explicit
            # values use canonical casing because manifest kind matching is exact.
            jmesPath: "workloadKindPresent && !contains(['Deployment','StatefulSet','DaemonSet'], workloadKind)"
        - name: imagesBad
          variable:
            # images[0] is inserted unquoted into the deploy script. Validate the
            # complete array so malformed later entries cannot reach other tasks.
            jmesPath: "length(deployImages) == `0` || length(deployImages[?regex_match('^[-A-Za-z0-9._:/@+]+$', @) == `false`]) > `0`"
        - name: manifestsDirBad
          variable:
            # Empty means no manifests. Non-empty paths must be relative, contain
            # no parent traversal, and use only a shell-safe path alphabet.
            jmesPath: "workloadManifestsDir != '' && (!regex_match('^[-A-Za-z0-9._/]+$', workloadManifestsDir) || starts_with(workloadManifestsDir, '/') || contains(split(workloadManifestsDir, '/'), '..'))"
        # This array param is wired into the kubectl Task as
        # `args: [--containers, <name>...]` and used as
        # `kubectl set image <kind>/<name> "$container"="$NEW_IMAGE"` (and as a
        # yq strenv match on the manifest path). Every use site is quoted, so it
        # is not an injection surface -- it is judged because only a real
        # container name takes effect: a name that matches nothing leaves the
        # workload on its previous image while the run still reports success.
        # Leave the list empty to update every container; the Task substitutes
        # "*" itself, which is why an explicit "*" is rejected here.
        - name: workloadContainersBad
          variable:
            jmesPath: >-
              length(workloadContainers[?regex_match('^[a-z0-9]([-a-z0-9]*[a-z0-9])?$', @) == `false`
              || length(@) > `63`]) > `0`
        - name: rolloutTimeoutBad
          variable:
            # The Pipeline appends "s" at the kubectl call site. Absence uses the
            # trusted default 0; explicit values are integer seconds only.
            jmesPath: "workloadRolloutTimeoutPresent && !regex_match('^(0|[1-9][0-9]*)$', workloadRolloutTimeout)"
        - name: secretBad
          variable:
            # Site-specific Secret name; absence means "deploy to the current
            # cluster" and stays allowed (see kubeconfigNonSecret above).
            jmesPath: "kubeconfigSecret != '' && kubeconfigSecret != '<approved-deploy-kubeconfig-secret>'"
        # A per-task override rides in the same request and no parameter judgment
        # can see it. podTemplate.env reaches the step container, and the kubectl
        # Task only exports KUBECONFIG itself when the kubeconfig workspace is
        # bound -- so on a compliant "deploy to the current cluster" request an
        # injected KUBECONFIG would silently redirect the whole deployment.
        # The run-wide equivalent: taskRunTemplate.podTemplate applies to every
        # TaskRun of this run, so env set here reaches the governed task too.
        # Only env is judged. Besides nodeSelector / imagePullSecrets being
        # ordinary configuration, "deny any run-wide podTemplate" would deny
        # everything: Tekton's defaulting webhook merges config-defaults'
        # default-pod-template in before Kyverno sees the request, so this field
        # is never actually absent. Residual fields are in the boundary note.
        - name: runWideEnvCount
          variable:
            jmesPath: "length(request.object.spec.taskRunTemplate.podTemplate.env || `[]`)"
            default: 0
        # taskRunTemplate carries exactly two fields (verified with kubectl
        # explain): podTemplate and serviceAccountName. The identity one bites
        # hardest on the compliant "deploy to the current cluster" path, where
        # the kubectl Task acts with this run's ServiceAccount -- a wider SA
        # defeats the deploy-credential RBAC the boundary note relies on.
        # Unlike env, a run-wide SA is ordinary configuration, so it is
        # allowlisted rather than denied outright.
        - name: runWideSa
          variable:
            jmesPath: "request.object.spec.taskRunTemplate.serviceAccountName || ''"
            default: ""
        - name: runWideSaBad
          variable:
            # Measured, not assumed: Tekton's defaulting webhook runs before
            # Kyverno, so admission never sees this field absent -- it arrives
            # holding config-defaults' default-service-account. The allowlist
            # must therefore carry that defaulted name as well, otherwise every
            # ordinary release run is rejected.
            jmesPath: "runWideSa != '' && !contains(['<tekton-default-service-account>','<approved-deploy-service-account>'], runWideSa)"
        - name: deployOverrideBad
          variable:
            # Same key-level judgment as the gate policies: scheduling keys stay
            # allowed, everything else on the deploy task (env, volumes,
            # dnsConfig, ...) and any per-task serviceAccountName is denied.
            jmesPath: >-
              length((request.object.spec.taskRunSpecs || `[]`)[?pipelineTaskName=='deploy-or-upgrade'
              && (serviceAccountName
              || length(keys(podTemplate || `{}`)) != length(keys(podTemplate || `{}`)[?contains(['nodeSelector','tolerations','affinity','imagePullSecrets','priorityClassName'], @)]))]) > `0`
        - name: deployProfileBad
          variable:
            # The Hub source is always governed. Target checks apply only when
            # the Pipeline's deployment branch is enabled.
            jmesPath: >-
              deploymentEnabled
              && (deployOverrideBad
              || runWideEnvCount > `0`
              || runWideSaBad
              || nsBad
              || workloadNameBad
              || workloadKindBad
              || workloadContainersBad
              || imagesBad
              || manifestsDirBad
              || rolloutTimeoutBad
              || secretBad
              || kubeconfigNonSecret)
      preconditions:
        all:
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: hub
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ pipelineCatalog }}"
            operator: Equals
            value: catalog
          # Both official 0.3 templates carry the same deploy-or-upgrade task
          # with the same workload parameters, so pinning one of them would let
          # the other deploy with no target governance at all.
          - key: "{{ pipelineName }}"
            operator: AnyIn
            value:
              - java-image-build-scan-deploy
              - python-image-build-scan-deploy
          - key: "{{ pipelineVersion }}"
            operator: Equals
            value: "0.3"
      validate:
        failureAction: Enforce
        message: >-
          release Pipeline source or deployment target not approved: the Hub
          source must be governed; when deployment is enabled, namespace and
          kubeconfig source must be allowlisted, workloadContainers must hold
          real container names, the deploy task may carry only scheduling keys in
          a per-task podTemplate and no serviceAccountName override, the
          run-wide podTemplate must carry no env and the run-wide
          ServiceAccount must be allowlisted, and every Pipeline parameter
          substituted into the kubectl shell script must match this production
          profile's safe grammar.
        deny:
          conditions:
            any:
              - key: "{{ hubSourceBad }}"
                operator: Equals
                value: true
              - key: "{{ deployProfileBad }}"
                operator: Equals
                value: true
```

:::

:::details Verification probes (37 probes, real hub PipelineRun shapes, --dry-run=server)

The table below packs **21 rows = 37 probes**: probes of the same shape are merged into one row (for example, "both denied" is two probes and "denied / allowed / allowed" is three); when running them one by one, expand each row per its in-row enumeration.

"Approved namespace A / B", "approved Secret", and "approved SA" in the table are the values of the policy's five placeholders after replacement — **replace first, then run the probes**, otherwise even the allow case in the first row is denied (a placeholder itself never equals a real parameter value).

| Probe | Expected |
|---|---|
| Deployment enabled + approved namespace A (no kubeconfig, explicit `timeout=1` second); plus the same profile with a sole explicit `type=artifact` | Allowed |
| The approved quadruple plus a request-level `url`, or an explicit `type=tekton` | Denied |
| Deployment not enabled (`workloadName` absent or equal to a single space) | Target checks skipped; but the same request is still denied if it carries a request-level `url` or `type=tekton` |
| Deployment enabled but namespace absent | Denied |
| namespace = `kube-system` (or any namespace not on the allowlist) | Denied |
| Approved namespace B + approved Secret | Allowed |
| Approved namespace A + **PVC workspace** | Denied |
| Approved namespace A + an unauthorized Secret | Denied |
| A compliant request + `taskRunSpecs[].podTemplate.env` on the deploy task, or a `serviceAccountName` on it | Both denied |
| A `podTemplate` on the deploy task holding **only scheduling keys** (`nodeSelector` / `tolerations`) | Allowed (same judgment as [§4.2.5](#s4-2-5)) |
| The same per-task override, but with **deployment not enabled** | Allowed (the criterion does not overreach — that task never runs anyway) |
| The **python 0.3** template: an off-allowlist namespace / the same fully compliant profile | Denied / allowed (the identity covers both templates) |
| Run-level `taskRunTemplate.podTemplate.env` (deployment enabled) | Denied |
| Run-level podTemplate setting only `nodeSelector` | Allowed (only `env` is judged) |
| Run-level `serviceAccountName` off the approved list / on the approved list / equal to `config-defaults`' default | Denied / allowed / allowed |
| Run-level unapproved SA, but with **deployment not enabled** | Allowed |
| `workloadContainers` holding an illegal container name / an explicit `*` | Both denied |
| `workloadContainers` holding legal container names | Allowed (the "parameter absent = update every container" shape is every compliant probe above) |
| A non-target Pipeline identity | Not falsely denied |
| A side-effect-free shell fragment injected into each of `workloadName`, `workloadKind`, `images[0]`, `workloadManifestsDir`, `workloadRolloutTimeout` | All five denied |
| Lowercase `deployment` (manifest kind comparison is case-sensitive), `1s` with a unit (the template splices it into `1ss`), numeric-style `workloadName: "1"` + an unapproved namespace | All denied |

:::

:::warning Lossy boundaries — required reading

**`workloadNamespace` is only the default namespace for `kubectl apply -n`; it is not a guarantee that "this release may only touch that namespace".** What the template ultimately executes is `kubectl apply -f "$PATCHED_YAML" -n "$NAMESPACE"` — **a `metadata.namespace` carried inside a manifest overrides `-n`, and cluster-scoped resources (`ClusterRole` / `ClusterRoleBinding` / `Namespace`, etc.) have nothing to do with `-n` at all**. In other words: whatever the content under `workloadManifestsDir` in the source repository declares is what may get applied, and this policy cannot see those files at admission. **What actually constrains that layer is the deployment credential's own RBAC** (narrow the deploy ServiceAccount to least privilege in the target namespace and deny cluster-scoped resources), plus review / admission of the manifest content itself.

**There is also a "what got released" layer, distinct from "released to where": `workloadContainers` decides which container the new image is written into.** The template passes it to the kubectl Task as `--containers <name>…`, and the Task then runs `kubectl set image "$KIND"/"$NAME" "$container"="$NEW_IMAGE"` (on the manifest branch, `yq` matches the container name via `strenv(container)` and rewrites the image); **left empty**, the Task fills in `*` itself = update every container. The policy validates that "every entry is a legal container name" (which is why an explicit `*` is denied — to update every container, leave the list empty), **but "which container should be updated" is business semantics that admission cannot judge**:

- on the `kubectl set image` branch, a nonexistent name makes the command error out and the pipeline fail (fail-closed — noisy but safe);
- on the **manifest branch**, when `yq` matches nothing it **changes nothing** — so what gets applied is the image the manifest **already carried**, not the image just built and scanned, **and the pipeline still succeeds**. That is, the inference "the gate passed ⇒ the cluster runs the image that passed the gate" does not hold on this path;
- when the name points at **another container** (a sidecar, for example), the business container keeps running the old image — again "looks like a successful release, nothing actually swapped".

To lock down this layer as well, you can only supplement outside the pipeline: narrow container names to a site-approved list (same shape as `<approved-deploy-service-account>`), or apply review of the manifest content / admission on the target cluster.

**And "constrain it with RBAC" itself has a premise: the request must not get to pick its own identity.** With no kubeconfig bound, `kubectl apply` runs as this run's ServiceAccount, and a PipelineRun has two places to set it — `taskRunSpecs[].serviceAccountName` (targeted at the deploy task; this policy denies it outright) and `spec.taskRunTemplate.serviceAccountName` (run-level; this policy requires it to hit the `<approved-deploy-service-account>` list). **Govern neither, and "the deploy SA has been narrowed to least privilege" merely describes one particular SA — the request simply swaps in a wider one.** Conversely, a run-level SA is normal configuration and denying it outright would cause false denials, so an approved list is used here instead of a deny — maintain that list together with the deployment-credential RBAC you actually hand out: when you add an SA, add it to the list at the same time, and **you must also list the SA Tekton fills in by default** (see the mechanism note above).

Even with the workspace source narrowed, **the target cluster's final security boundary must still be carried by the target cluster's own admission / RBAC** — this policy constrains "which kubeconfig Secret is used, which namespace parameter is deployed to", but the **content** of the kubeconfig Secret (which cluster it really points at, with what permissions) is invisible to admission; it can only be closed off indirectly through "which Secrets may be referenced".

**Replace the five site values before copying** (`<approved-deploy-namespace-a>` / `-b`, `<approved-deploy-kubeconfig-secret>`, `<tekton-default-service-account>`, `<approved-deploy-service-account>`) — for how to pick the values, the list-style syntax, and the failure direction (all reversed: a missed replacement = **all compliant deployment requests denied**), see the corresponding four rows of the [§4.0.3](#s4-0-3) reference table; not repeated here.

**One special heads-up for operators on `workloadRolloutTimeout`: the template's own parameter description is wrong.** It says "other values should carry a time unit (e.g. `1s`, `2m`, `3h`)", but at the call site the script splices `--timeout=${ROLLOUT_TIMEOUT}s` — filling in `1s` becomes `1ss` and fails at execution time. **The only correct form is integer seconds (`0` = never time out)**, which is why this policy accepts integers only; at rollout, write this line into the fill-in instructions you give business teams, or you will get the round trip of "fill in per the template docs → denied by policy → bypass the policy → fail inside the Task".

Moreover, both the target-namespace and the shell-safe parameter constraints depend on Pipeline 0.3's real parameter / script contract; **on a template upgrade, re-review every `$(params.*)`-to-shell data flow**. The workload Kind, name, path, integer-second timeout, and image grammar in the example are a deliberately conservative production profile — when business teams need a wider legal set, **widen the allowlist and add adversarial probes** rather than removing the validation.

:::

#### Cleanup (§4.5)

Per the two rules of [§4.0.4](#s4-0-4), delete the five cluster-scoped policies by name:

```bash
# §4.0.4's look-before-delete: cluster-scoped, so one glance at when they were created.
kubectl get clusterpolicy artifact-source-allowlist \
  promotion-source-image-labels pod-image-registry-allowlist \
  pipeline-entry-lockdown release-target-allowlist --ignore-not-found \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'
kubectl delete clusterpolicy artifact-source-allowlist \
  promotion-source-image-labels pod-image-registry-allowlist \
  pipeline-entry-lockdown release-target-allowlist --ignore-not-found
```

Namespaced objects are reclaimed with the cascade delete of the self-created namespace: the `pipeline-image-allowlist` ConfigMap (**it exists only if you adopted the ConfigMap variant of [§4.5.3](#s4-5-3)**), and the PipelineRuns / standalone TaskRuns this section ran plus their derived objects. If you are going on to later sections, delete the run-type objects by name first, to avoid PolicyReport interference ([§4.0.5](#s4-0-5)).
### 4.6 (Advanced) Automatically cancelling a running pipeline {#s4-6}

**The general contract**: hard gates ([§4.3](#s4-3)) are the mainline for "results below the bar → failure"; but some scenarios need to **request cancellation as early as possible** of a pipeline that is already running (for example, to stop expensive later steps early). The technique is mutate-existing — on a status-event trigger, patch the target PipelineRun's `spec.status: CancelledRunFinally` (Tekton's native cancellation field).

This section presents **two trigger conditions**: **[§4.6.1](#s4-6-1) results below the bar** (reading a result written out by a TaskRun) and **[§4.6.2](#s4-6-2) definition drift** (reading the `pipelineSpec` written back into status and finding the resolved definition does not match the approved identity). Same mechanism, different criteria — and **both write, in the same patch, an annotation stating the reason** ([§4.6.1](#s4-6-1) records which result went out of bounds, [§4.6.2](#s4-6-2) records where the drift is): a cancellation that leaves no reason on the object cannot be told apart from a manual one — the rationale is in [§4.0.6](#s4-0-6), and how to read it during troubleshooting is in [§6.2.3](#s6-2-3).

**First, the global picture: this document has four paths in total that cancel a pipeline — two here, two in [§4.2](#s4-2)** — and they differ not in the act of cancelling, but in **when the problem is detected and which object gets touched**. Use this table for both selection and troubleshooting (it is the crossroads; each row's complete policy still lives in its own section):

| Section | When it is detected, on what condition | What it acts on | Mechanism (synchronous / asynchronous) | Where the evidence is (step number in [§6.2.3](#s6-2-3)) |
|---|---|---|---|---|
| [§4.2.3](#s4-2-3) | At gate TaskRun **admission**: gate switch / threshold parameters non-compliant | **The gate TaskRun itself** | Admission `mutate` writes `spec.status: TaskRunCancelled` + `statusMessage` — **synchronous, race-free, no extra RBAC needed** | The TaskRun's `spec.statusMessage` and terminal condition — **the full reason lives here** (step 1) |
| [§4.2.2](#s4-2-2) | Same moment, same criterion (gate parameters non-compliant) | **The parent PipelineRun** | mutate-existing patch `spec.status: CancelledRunFinally` — asynchronous, needs the background controller's update RBAC | The parent run's `cancel-reason` annotation (step 2) |
| [§4.6.2](#s4-6-2) | When the PipelineRun writes status: in the resolved definition the trusted gate has been **removed, or the whole Task identity swapped out** (definition drift — the same name in a different namespace also counts) | **The run itself** (self-targeting, no cross-run lookup) | Same patch as above, `CancelledRunFinally` | The parent run's `cancel-reason` annotation, its text stating the drift (step 3) |
| [§4.6.1](#s4-6-1) | When a TaskRun reaches its terminal state: a result out of bounds (coverage / vulnerability count, etc.); **a missing or malformed result hits the same way** (fail-closed) | **The parent PipelineRun** (a five-link identity chain against misidentifying the parent run) | Same patch as above, `CancelledRunFinally` | The parent run's `cancel-reason` annotation, naming the triggering TaskRun and the out-of-bounds value (step 4) |

Three points are the easiest to overlook during selection: **① the first two rows are two of the three response shapes for the same criterion** (the third is [§4.2.1](#s4-2-1)'s direct deny, at the cost of finally not running; the three-way trade-off is in [§4.2.3](#s4-2-3)); **② only [§4.2.3](#s4-2-3) is synchronous** — the other three act only after the event, and side effects that already happened are not rolled back; **③ the terminal state is not necessarily `Cancelled`** — in [§4.6.1](#s4-6-1), when the result was never written out at all, Tekton's failure verdict outranks the cancellation and the terminal state is `Failed`; the evidence of the cancellation lives only in `spec.status` and the annotation (see the end of [§4.6.1](#s4-6-1)).

**Shared prerequisite** (missing it, the policies either fail to install or never take effect): the background controller needs update RBAC on the target `pipelineruns`, and **Kyverno validates that RBAC at policy-creation time — if it is missing, creation of the policy is rejected outright**, with an error like this:

```text
admission webhook "validate-policy.kyverno.svc" denied the request:
path: spec.rules[0].mutate.targets.: auth check fails, additional privileges are
required for the service account 'system:serviceaccount:kyverno:kyverno-background-controller':
... requires permissions update for resource tekton.dev/v1/PipelineRun
in namespace {{ request.namespace }}
```

**Note that the final `in namespace {{ request.namespace }}` was never evaluated** — this authorization check happens at policy creation time, when `request` does not yet exist, so when `mutate.targets[].namespace` is written as a **variable**, Kyverno only accepts **cluster-wide** update permission; a namespaced Role suffices only when the namespace is a **literal** (which is why the single-namespace variant in [§4.2.2](#s4-2-2) must write `targets` as literals as well — adding the Role alone is not enough). The rules in this chapter use `subjects` / request context, so the policies must set `background: false` (otherwise creation is rejected with `only select variables are allowed in background mode`) — yet the mutate-existing target is still executed by the background controller.

When you govern only one fixed namespace, you can reuse the namespaced Role from [§4.2.2](#s4-2-2) and write the mutate target namespace as a literal; when you need dynamic cross-namespace targets, use the aggregated ClusterRole below — **and note this is a privilege escalation**: it grants the background controller update / patch on `pipelineruns` **across the whole cluster**, from which point the rule's own identity validation (`subjects` + owner-UID lookback + the full TaskRef) is the only constraint left on that permission — none of it can be dropped:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: kyverno-background-update-pipelineruns
  labels:
    # merge into the background-controller's aggregated ClusterRole
    rbac.kyverno.io/aggregate-to-background-controller: "true"
rules:
  - apiGroups:
      - tekton.dev
    resources:
      - pipelineruns
    verbs:
      - get
      - list
      - watch
      - update
      - patch
```

Save it as `kyverno-background-update-pipelineruns.yaml`, then **grant first, confirm the aggregation took effect, and only then install this section's two policies** — in the reverse order you get an error identical to "never granted at all" ([§6.1.1](#s6-1-1)):

```bash
# `create`, not `apply` (§4.0.4): this ClusterRole is cluster-scoped, and a
# same-named one already on the cluster is somebody else's grant -- an
# AlreadyExists here means STOP, not overwrite.
kubectl create -f kyverno-background-update-pipelineruns.yaml

# Aggregation is asynchronous: this must print `yes` BEFORE you install either policy.
# It is the same check as §3.1's item 3; repeat it for a few seconds if it says no.
kubectl auth can-i update pipelineruns.tekton.dev \
  --as=system:serviceaccount:kyverno:kyverno-background-controller -A
```

On `no`, do not rush to change the policy: re-run the command above first (the aggregation may simply not have propagated yet), then check that the `rbac.kyverno.io/aggregate-to-background-controller: "true"` label on the ClusterRole is spelled correctly. **The authorization error reported when installing the policy looks exactly like "never granted"**, which is why this step must be confirmed on its own before any policy is installed.

**Shared boundary**: cancellation is an event-driven response action, not an admission rejection — it happens **after** results have already been produced; side effects executed earlier are not rolled back, and finally still runs (row three of the comparison table in [§2.3](#s2-3)). It is therefore a **complement** to the hard gate, not a replacement for the gate task of [§4.3](#s4-3).

:::warning Cancellation ≠ immediately stopping computation

In every mutate-existing cancellation scenario, **a TaskRun being marked cancelled does not mean its Pod terminates synchronously**. A Pod already on the concurrent-creation path may keep running until its process exits; even writing the downstream task as `runAfter` leaves a race between "downstream Pod CREATE" and "parent run cancelled".

Cost-sensitive scenarios must not treat cancellation as a guarantee of "compute reclaimed immediately": **set sensible timeouts on tasks**, and measure the termination latency of Running Pods on your own target capacity and runtime.

:::

#### 4.6.1 Result-triggered cancellation (the main usage, with anti-forgery validation) {#s4-6-1}

- **What it governs**: **when the results are already out and only then found below the bar, stop this pipeline** — watch the moment a TaskRun writes status, read the result it produced (coverage in the example), and on an out-of-bounds value cancel the **parent PipelineRun** so the build / release steps that follow do not keep running.
- **Why it is hard**: you must first answer "which run is actually this TaskRun's parent", and the answer must be **unforgeable** — the `tekton.dev/pipelineRun` label on a TaskRun is completely untrustworthy: a bare TaskRun can write it itself, and a real PipelineRun can override the child Run's label through `taskRunSpecs[].metadata.labels`. Cancellation means **reaching out and modifying somebody else's object**; misidentifying the parent run hands out a "cancel any pipeline" button.
- **How the policy is layered**: ① match only status requests written by the **Tekton controller SA**; ② take the parent run's name/UID from the controller `ownerReference`, then use an `apiCall` to fetch the **live** PipelineRun and verify the UID (defeats same-name recreation); ③ additionally require the trigger to actually appear in the parent run's `status.childReferences`; ④ lock the full Pipeline / Task identity — otherwise any pipeline producing a same-named result could trigger the cancellation; ⑤ only when all of these hold does `mutate-existing` set the parent run to cancelled.
- **What it cannot govern**: it is an **after-the-fact response**, not an admission rejection — side effects executed **before** the result was produced are not rolled back (the image may already have been pushed), and finally still runs.

This section demonstrates with a `coverage-cancel-demo` Pipeline and a `policy-demo-coverage-emitter` Task (producing a sample `coverage-lines` result) in the trusted namespace, and **does not depend on the sonar scanner of [§3.3](#s3-3)**. Putting the definitions in an RBAC-protected namespace and then locking the full Pipeline / Task identity is what prevents arbitrary other pipelines that produce a same-named result from triggering the cancellation. When adapting to the sonar shape, change the trigger condition to read `code-scan-results.result == 'Failed'` (or some numeric metric in `code-scan-metrics` going out of bounds), and keep the identity-locking and anti-forgery parts exactly as they are.

:::warning apiCall executes before preconditions

`subjects` only proves the status writer is the Tekton controller — **the status of a direct (bare) TaskRun is written by that same controller**, so bare TaskRuns also enter context evaluation. With no parent, `parentName` is empty and the `apiCall` degrades into querying the PipelineRun collection; the preconditions on parent UID, exact parent profile, current TaskRef, and `childReferences` then all fail, and the request is safely skipped.

Get the causality straight here: **it is "safely skipped after context has run", not "the selector excluded it before the apiCall"**. Genuine child Runs, in turn, rely on the owner UID equalling the live parent UID to rule out confusion from same-name recreation or user label injection.

:::

**The key criterion** — the five-link identity chain must all hold, and the terminal-state ruling must actually be a violation, before anything is touched (identity only selects *what* to act on; *when* to act is decided by the verdict precondition in (3)):

```yaml
      preconditions:
        all:
          # (1) the parent run referenced by owner must be the same live object
          #     (defeats same-name recreation)
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ targetPlr.metadata.uid }}"
          # (2) parent profile and current TaskRef must both match exactly
          #     (omitted here; see the full YAML)
          # (3) the verdict itself -- identity alone never cancels anything: only a
          #     TERMINAL emitter TaskRun whose coverage-lines result violates the
          #     gate (out of range / malformed / missing / duplicated) triggers
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
          - key: "{{ coverageViolates }}"
            operator: Equals
            value: true
          # (4) the trigger must actually appear in the parent run's childReferences
          - key: "{{ request.object.metadata.name }}"
            operator: AnyIn
            value: "{{ childNames }}"
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: "{{ request.namespace }}"
        patchStrategicMerge:
          metadata:
            annotations:
              # A cancellation with no reason on the object cannot be told apart
              # from a manual one afterwards (§4.0.6 / §6.2.3). Echo the trigger
              # and the value that violated, both resolved from this request.
              policy.alauda.io/cancel-reason: >-
                coverage gate not met on TaskRun {{ request.object.metadata.name }}:
                coverage-lines='{{ coverage }}'
          spec:
            status: CancelledRunFinally
```

:::details Trusted demo Task and Pipeline definitions

```yaml
# Trusted result producer. Keep this definition in an RBAC-protected namespace.
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: policy-demo-coverage-emitter
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
    - name: omitResult
      type: string
      default: "false"
  results:
    - name: coverage-lines
  steps:
    - name: emit
      image: <registry>/busybox:latest
      env:
        - name: COVERAGE
          value: $(params.coverage)
        - name: OMIT_RESULT
          value: $(params.omitResult)
      script: |
        #!/bin/sh
        sleep 5
        # This switch demonstrates a terminal TaskRun which omits the declared
        # result entirely; an empty result value is a separate negative case.
        if [ "$OMIT_RESULT" != "true" ]; then
          printf '%s' "$COVERAGE" > "$(results.coverage-lines.path)"
        fi
---
# Trusted parent profile. The sleeper and notifier are part of this protected
# definition; the emitter is also locked independently by the policy below.
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: coverage-cancel-demo
  namespace: tekton-templates
spec:
  params:
    - name: coverage
      type: string
    - name: omitResult
      type: string
      default: "false"
  tasks:
    - name: emit
      taskRef:
        resolver: cluster
        params:
          - name: kind
            value: task
          - name: name
            value: policy-demo-coverage-emitter
          - name: namespace
            value: tekton-templates
      params:
        - name: coverage
          value: $(params.coverage)
        - name: omitResult
          value: $(params.omitResult)
    - name: sleeper
      taskSpec:
        steps:
          - name: sleep
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              sleep 60
  finally:
    - name: notify
      taskSpec:
        steps:
          - name: notify
            image: <registry>/busybox:latest
            script: |
              #!/bin/sh
              echo "finally ran"
---
# The emit task publishes low coverage. The sleeper should be cancelled, while
# the final notifier must still execute under CancelledRunFinally.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: cancel-low-coverage-demo
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: coverage-cancel-demo
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
---
# A terminal emitter which never writes coverage-lines is also a violation.
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: cancel-missing-coverage-demo
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: coverage-cancel-demo
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
    - name: omitResult
      value: "true"
```

:::

:::details Full policy YAML: cancel-on-failed-verdict

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cancel-on-failed-verdict
spec:
  background: false
  rules:
    - name: cancel-parent-on-low-coverage
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        - name: parentRef
          variable:
            jmesPath: "request.object.metadata.ownerReferences[?kind=='PipelineRun' && controller==`true`] | [0]"
            default:
              name: ""
              uid: ""
        - name: parentName
          variable:
            jmesPath: "parentRef.name || ''"
            default: ""
        - name: parentUID
          variable:
            jmesPath: "parentRef.uid || ''"
            default: ""
        - name: coverage
          variable:
            jmesPath: "(request.object.status.results || `[]`)[?name=='coverage-lines'].value | [0] || ''"
            default: ""
        # status.results has no uniqueness guarantee, so a decoy coverage-lines entry
        # ahead of the real one would win the [0] above. Here the count must feed the
        # violation itself, not a deny block: this rule drives mutate-existing, so a
        # malformed status has to reach the CANCEL path to stay fail-closed.
        - name: coverageResultCount
          variable:
            jmesPath: "length((request.object.status.results || `[]`)[?name=='coverage-lines'])"
            default: 0
        - name: succeededConditionCount
          variable:
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded'])"
            default: 0
        - name: coverageIsNumeric
          variable:
            jmesPath: "regex_match('^[0-9]{1,3}$', coverage)"
        - name: coverageViolates
          variable:
            jmesPath: >-
              coverageResultCount != `1`
              || succeededConditionCount != `1`
              || !coverageIsNumeric
              || to_number(coverage) > `100`
              || to_number(coverage) < `50`
        - name: isTerminal
          variable:
            # Wait for the terminal write so an early status without results does
            # not cancel, while terminal missing/empty results still fail closed.
            # Counted, not [0]-indexed, for the reason given in §4.4.1.
            jmesPath: "length((request.object.status.conditions || `[]`)[?type=='Succeeded' && (status=='True' || status=='False')]) > `0`"
        # Lock the current TaskRef itself; labels can be overridden through
        # PipelineRun taskRunSpecs and are not an identity boundary.
        - name: taskResolver
          variable:
            jmesPath: "request.object.spec.taskRef.resolver || ''"
            default: ""
        - name: taskKind
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: taskName
          variable:
            jmesPath: "request.object.spec.taskRef.name || ((request.object.spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: taskNamespace
          variable:
            jmesPath: "(request.object.spec.taskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # anti-forgery: fetch the owner parent, verify UID, and require this
        # TaskRun to be one of its genuine children
        - name: targetPlr
          apiCall:
            urlPath: "/apis/tekton.dev/v1/namespaces/{{ request.namespace }}/pipelineruns/{{ parentName }}"
        - name: parentPipelineResolver
          variable:
            jmesPath: "targetPlr.spec.pipelineRef.resolver || ''"
            default: ""
        - name: parentPipelineKind
          variable:
            jmesPath: "(targetPlr.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: parentPipelineName
          variable:
            jmesPath: "targetPlr.spec.pipelineRef.name || ((targetPlr.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: parentPipelineNamespace
          variable:
            jmesPath: "(targetPlr.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: childNames
          variable:
            # Filter on apiVersion/kind: a childReference entry declares both, and a
            # bare name match would also accept e.g. a CustomRun sharing the name.
            # This API exposes no uid, so name + the parent UID check above + the
            # exact Pipeline/Task identity are the whole identity story here -- see
            # the trust-boundary note after this policy.
            jmesPath: "(targetPlr.status.childReferences || `[]`)[?apiVersion=='tekton.dev/v1' && kind=='TaskRun'].name"
      preconditions:
        all:
          - key: "{{ parentUID }}"
            operator: Equals
            value: "{{ targetPlr.metadata.uid }}"
          - key: "{{ parentPipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ parentPipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ parentPipelineName }}"
            operator: Equals
            value: coverage-cancel-demo
          - key: "{{ parentPipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ taskResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ taskKind }}"
            operator: Equals
            value: task
          - key: "{{ taskName }}"
            operator: Equals
            value: policy-demo-coverage-emitter
          - key: "{{ taskNamespace }}"
            operator: Equals
            value: tekton-templates
          - key: "{{ isTerminal }}"
            operator: Equals
            value: true
          # At terminal status, missing/empty/non-numeric/out-of-range values all
          # fail closed. Unrelated tasks were already excluded by full TaskRef.
          - key: "{{ coverageViolates }}"
            operator: Equals
            value: true
          # the triggering TaskRun MUST be a real child of the target run
          - key: "{{ request.object.metadata.name }}"
            operator: AnyIn
            value: "{{ childNames }}"
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ parentName }}"
            uid: "{{ parentUID }}"
            namespace: "{{ request.namespace }}"
        patchStrategicMerge:
          metadata:
            annotations:
              # A cancellation with no reason on the object cannot be told apart
              # from a manual one afterwards (§4.0.6 / §6.2.3). Echo the trigger
              # and the value that violated, both resolved from this request.
              policy.alauda.io/cancel-reason: >-
                coverage gate not met on TaskRun {{ request.object.metadata.name }}:
                coverage-lines='{{ coverage }}'
          spec:
            status: CancelledRunFinally
```

:::

:::details Verification checklist (five violation shapes + three no-false-positive controls)

**Violation shapes** (verify each one independently; every one must trigger a fail-closed cancellation at terminal status): `coverage-lines=30` (out of bounds), `not-a-number` (the malformed guard), `101` (the numeric-range guard), an explicit empty string, and reaching the terminal state without writing `coverage-lines` at all. The last two respectively prove that an "explicit empty value" and an "absent result" are not silently skipped as if they were an early status write.

**The sixth: the same result written twice** (blocked by the `coverageResultCount` guard). This one **must** be carried by `coverageViolates` and must not be stuffed into `deny` — this rule drives `mutate-existing`, and a malformed status has to walk into the **cancellation** path to count as fail-closed:

| Injected `status.results` | Before the guard | After the guard |
|---|---|---|
| A single `coverage-lines=30` (positive control) | Cancelled | Cancelled |
| `[coverage-lines=85, coverage-lines=30]` (clean decoy first) | **Not cancelled** ← fail-open | Cancelled |
| A single `coverage-lines=85` (no-false-positive control) | Not cancelled | Not cancelled |

**The probe is only meaningful if it impersonates the Tekton controller**: this rule's `match` carries `subjects: tekton-pipelines-controller`, so patching a TaskRun status under your own identity means the rule **does not match at all** — even the positive control will not cancel, which is easily misread as "the policy is not working". Add `--as=system:serviceaccount:tekton-pipelines:tekton-pipelines-controller` before patching. (This incidentally demonstrates that the `subjects` door really does keep business identities from forging status directly.)

**No-false-positive controls**:

- A non-numeric run uses `taskRunSpecs` to **forge all** of the child's pipeline / pipelineTask / pipelineRun labels, yet still only cancels its own parent run as pointed to by the owner — proving the policy does not depend on those labels;
- Another genuine controller child uses the same trusted emitter and also produces `coverage-lines=30`, but its parent Pipeline's exact identity is `coverage-cancel-unrelated`: it completes `Succeeded` normally and is not cancelled, and the companion Audit records a skip — proving the trigger condition locks both the live parent profile and the current TaskRef, rather than firing on any same-named result;
- The label-forging TaskRun and the parentless TaskRun are created by business identities, but their subsequent status requests are still issued by the Tekton controller and do enter context — they end up safely skipped because owner / live parent / current TaskRef / childReferences all fail, and each completes normally on its own.

**What a successful cancellation looks like**: the target parent run's `spec.status` is patched to `CancelledRunFinally` → the run's terminal state is `Cancelled`, the `sleeper` TaskRun becomes `TaskRunCancelled`, and the finally notify runs as usual. The same patch also writes the `cancel-reason` annotation, **whose variables are resolved from the triggering request** (reading like `coverage gate not met on TaskRun <emit TaskRun name>: coverage-lines='30'`) — this is the only thing that can distinguish a policy cancellation from a manual one after the fact ([§6.2.3](#s6-2-3)). Run the reverse control as well: **the compliant run (`coverage-lines=85`) must, after emit reaches its terminal state, be neither cancelled nor carry this annotation** — otherwise the annotation is being written unconditionally.

:::

:::warning The annotation embeds untrusted raw text, and the terminal state is not necessarily Cancelled

Two easy traps:

- **The content of `{{ coverage }}` is not decided by the policy** — whoever writes the result decides it. Write `coverage-lines` as something like `30' bad: injected` or `first\nsecond: value` and: the patch renders as usual, the cancellation happens as usual, and the annotation contains that **raw, inert text verbatim** (it neither becomes YAML structure nor fails the patch). **So the annotation is "policy-generated diagnostics + a piece of untrusted raw text"**: the prefix (which policy, why) is trustworthy; the quoted value is only evidence material — do not treat it as an independent audit conclusion, because an attacker can write anything that looks like a conclusion into it.
- **When the result cannot be written at all, the terminal state is `Failed`, not `Cancelled`**. Inflate the result to 4 KiB (past Tekton's result capacity) and: the emit step itself `exited with code 1`, the result is absent → the policy still renders its fail-closed verdict and the patch succeeds (`spec.status=CancelledRunFinally`, the annotation is written too, with an empty value), but **the PipelineRun's terminal reason is `Failed`** — because the genuine task failure outranks the cancellation in Tekton's ruling. **When troubleshooting, do not look for cancellations only under terminal state `Cancelled`**: the evidence of a cancellation is `spec.status` and the annotation; the terminal state may be `Failed` ([§6.2.3](#s6-2-3)).

:::

**On the parallel shape**: the PipelineRun above keeps the generic parallel shape. On capacity-constrained environments (unable to schedule two TaskRun Pods with Tekton-injected init containers at the same time), you can keep the sleeper Pod Pending with a `taskRunSpecs.podTemplate.nodeSelector` that matches no node, which stably verifies "an already-created child TaskRun gets cancelled" — but be clear that **this does not prove a Running Pod stops immediately**. Also, writing `sleeper` as `runAfter: emit` races "downstream Pod CREATE" against "parent run cancelled", and you may see the TaskRun cancelled while its concurrently created Pod keeps Running.

:::warning Two migration boundaries

**① When the parent run has already been deleted**, the `apiCall` errors with a 404 — fail-safe for the cancellation scenario (with the parent gone, there is nothing to cancel anyway), but it leaves error lines in the background-controller log; no need to panic during troubleshooting ([§6.1](#s6-1)).

**② The profile must be replaced**: this example locks the exact profile from `targetPlr.spec.pipelineRef` and the current `spec.taskRef`; when migrating to a real template, swap in that template's own full identity — **do not narrow instead with the pipelineTask label, which `taskRunSpecs` can override**.

:::

**A sibling variant (parameter-triggered cancellation)**: switch the match to `TaskRun` **CREATE** and the coverage check to a check on the expanded parameters, and you get "cancel the parent run when gate parameters are non-compliant" — but the main path for contract 2 of [§2.3](#s2-3) is to Enforce-deny the gate TaskRun's CREATE directly (simpler, synchronous, failure shape fixed as `CreateRunFailed`); the cancellation variant only adds value when already-started earlier tasks must go through finally cleanup (that is, [§4.2.2](#s4-2-2)).
#### 4.6.2 Self-cancellation triggered by definition drift (self-targeting, controller identity constraint) {#s4-6-2}

- **What it governs**: **when a run is already underway and the gate turns out to have been removed from the template, stop that run itself**. [§4.1.1](#s4-1-1) can only verify "who is being referenced" and never sees the definition's content; only once the resolver has resolved the definition into `status.pipelineSpec` do you get the first look at "is that trusted scanner still in there" — if it is gone, cancel the run itself.
- **Why it is hard**: the detection signal is exactly the same as the drift Audit in [§4.1.4](#s4-1-4); the difference is that here we **actually cancel**, so the identity constraint cannot be loosened: the status request must be locked to the Tekton controller ServiceAccount — otherwise anyone who can write status can **forge a drift event** to cancel somebody else's pipeline.
- **How the policy is layered**: ① match `PipelineRun/status`, and the writer must be the controller SA → ② in the resolved `status.pipelineSpec`, check whether the trusted scanner is still present (**removed or swapped for a different task** both count as drift) → ③ on a hit, cancel — the target is taken directly from the current request object (**self-targeting**, no cross-run lookup, so it is naturally free of the misidentified-parent-run risk of [§4.6.1](#s4-6-1)).
- **What it cannot govern**: this too is an **after-the-fact response** — the drift is only discovered after the run has already started; side effects up to that point are not rolled back.

:::warning The scan + trusted scanner identity is the fixture profile's gate shape, not a universal identity

Like the drift Audit in [§4.1.4](#s4-1-4), this self-cancellation **must be configured per template profile** (branch on the parent `PipelineRun.spec.pipelineRef`, each profile with its own scanner identity); never assert a gate shape on all runs without a guard — that would **mis-cancel** everything that uses templates with other gate shapes. Do not substitute the `tekton.dev/pipeline` label for the spec identity.

:::

:::details Full policy YAML: cancel-run-without-gate

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: cancel-run-without-gate
spec:
  background: false
  rules:
    - name: self-cancel-on-missing-gate
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun/status
              operations:
                - UPDATE
              namespaces:
                - policy-poc
            subjects:
              - kind: ServiceAccount
                name: tekton-pipelines-controller
                namespace: tekton-pipelines
      context:
        - name: pipelineResolver
          variable:
            jmesPath: "request.object.spec.pipelineRef.resolver || ''"
            default: ""
        - name: pipelineKind
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: tplName
          variable:
            jmesPath: "request.object.spec.pipelineRef.name || ((request.object.spec.pipelineRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: pipelineNamespace
          variable:
            jmesPath: "(request.object.spec.pipelineRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        - name: pipelineSpecPresent
          variable:
            # Key presence avoids evaluating the rule before resolution. Tekton
            # rejects a valid Pipeline with no ordinary tasks, so an empty list
            # here is only a defensive malformed/synthetic-status boundary.
            jmesPath: "contains(keys(request.object.status || `{}`), 'pipelineSpec')"
        # Same full resolved identity as §4.1.4; name-only comparison is fail-open.
        # status.pipelineSpec.tasks carries no x-kubernetes-list-type in the CRD,
        # so two tasks named scan survive admission and [0] would only see the
        # first. Count first, then read.
        - name: scanTaskCount
          variable:
            jmesPath: "length((request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'])"
            default: 0
        - name: scanTaskRef
          variable:
            jmesPath: "(request.object.status.pipelineSpec.tasks || `[]`)[?name=='scan'] | [0].taskRef || `{}`"
        - name: scanResolver
          variable:
            jmesPath: "scanTaskRef.resolver || ''"
            default: ""
        - name: scanKind
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='kind'].value | [0] || ''"
            default: ""
        - name: scanName
          variable:
            jmesPath: "scanTaskRef.name || ((scanTaskRef.params || `[]`)[?name=='name'].value | [0]) || ''"
            default: ""
        - name: scanNamespace
          variable:
            jmesPath: "(scanTaskRef.params || `[]`)[?name=='namespace'].value | [0] || ''"
            default: ""
        # Same one-level-down count guard as §4.1.4: inside the resolver taskRef,
        # `params` is an ordinary list in status, so a decoy entry in front of the
        # real one would win every [0] above. (In `spec` Tekton's own webhook
        # rejects two params sharing a name; status carries no such guarantee.)
        - name: scanRefParamsUnique
          variable:
            jmesPath: >-
              length((scanTaskRef.params || `[]`)[?name=='kind']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='name']) == `1` &&
              length((scanTaskRef.params || `[]`)[?name=='namespace']) == `1`
        - name: scanIdentityValid
          variable:
            # The counts are folded in here rather than added as separate
            # conditions: the preconditions below use `all:`, so an extra condition
            # would relax the rule instead of tightening it.
            jmesPath: >-
              scanTaskCount == `1` && scanRefParamsUnique &&
              scanResolver == 'cluster' && scanKind == 'task' &&
              scanName == 'policy-demo-scanner' &&
              scanNamespace == 'tekton-templates'
        - name: governedProfile
          variable:
            # The second name is the deliberately drifted fixture used for the
            # negative test. Production should list only governed identities.
            jmesPath: "contains(['gated-build','gated-build-rogue'], tplName)"
      preconditions:
        all:
          # Evaluate only after resolution materialized pipelineSpec. The gate
          # check itself is scanIdentityValid; do not infer it from task count.
          - key: "{{ pipelineSpecPresent }}"
            operator: Equals
            value: true
          - key: "{{ pipelineResolver }}"
            operator: Equals
            value: cluster
          - key: "{{ pipelineKind }}"
            operator: Equals
            value: pipeline
          - key: "{{ pipelineNamespace }}"
            operator: Equals
            value: tekton-templates
          # PROFILE guard: only the governed fixture profiles. Other templates use
          # their own gate shape and must be governed per-profile.
          - key: "{{ governedProfile }}"
            operator: Equals
            value: true
          # DRIFT = any field of the mandatory scanner identity changed.
          - key: "{{ scanIdentityValid }}"
            operator: Equals
            value: false
          # idempotency: skip once a cancel is already in flight
          - key: "{{ request.object.spec.status || '' }}"
            operator: Equals
            value: ""
      mutate:
        targets:
          - apiVersion: tekton.dev/v1
            kind: PipelineRun
            name: "{{ request.object.metadata.name }}"
            uid: "{{ request.object.metadata.uid }}"
            # Single namespace: use a literal; cross-namespace: change to "{{ request.namespace }}"
            # and grant §4.6's aggregated ClusterRole instead (trade-offs in §4.2.2)
            namespace: policy-poc
        patchStrategicMerge:
          metadata:
            annotations:
              policy.alauda.io/cancel-reason: >-
                resolved scan task drifted from the approved full Task identity
          spec:
            status: CancelledRunFinally
```

:::

:::details Positive and negative PipelineRuns for verification

```yaml
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: self-cancel-compliant
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "85"
    - name: demoDelaySeconds
      value: "1"
---
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: self-cancel-rogue
  namespace: policy-poc
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build-rogue
      - name: namespace
        value: tekton-templates
```

:::

**Expected shape (multi-way comparison)**:

- the normal `gated-build` (`scan` → `cluster/task/tekton-templates/policy-demo-scanner`) reaches terminal state `Succeeded`, with `scan / release / notify` all succeeding;
- the drifted fixture `gated-build-rogue` **keeps the very same Task name** `policy-demo-scanner` and only swaps the namespace to `policy-poc` — after resolution the full identity check still recognizes it: the parent run is patched to `CancelledRunFinally` with terminal state `Cancelled`, the running `prep` gets `TaskRunCancelled`, `scan / release` are skipped, the finally `notify` succeeds, and the cancel-reason annotation is present;
- the full-removal fixture (delete `scan`, keep the ordinary `prep`) is likewise cancelled, with finally succeeding;
- the status-subresource control submitted by a **non-controller identity** neither has `spec.status` set nor carries the cancel annotation, nor does it produce any background mutation — proof that the subject constraint holds;
- only a definition **with a finally section but empty ordinary tasks** is rejected outright by Tekton admission; that is not a normal running path the self-cancellation policy can handle.

**Timing note**: the trigger fires **after resolution**, so early tasks may already have started — this is "cancel as early as possible", not "prevent starting"; to prevent starting, use the admission allowlist of [§4.1](#s4-1).

#### Cleanup (§4.6)

Per the two rules of [§4.0.4](#s4-0-4), cluster-scoped objects are deleted by name — besides its two policies, this section also has a `ClusterRole`, and deleting the namespace does not take that away either:

```bash
# §4.0.4's look-before-delete, as a BRANCH: these are cluster-scoped objects and the whole
# block gets pasted in one go, so a `get` printed above an unconditional `delete` is read only
# AFTER the delete has run. Set the window you started this walkthrough in (any ISO prefix).
WALKTHROUGH_WINDOW='<your-walkthrough-date-prefix>'
# Filled in ONCE for the whole block, and read through one helper so both silent failure
# modes are refused in one place. UNREPLACED: every comparison fails, so every object is
# reported as somebody else's -- safe, but false. EMPTY: a bare anchored pattern matches
# EVERYTHING, so the window would authorise deleting other people's objects.
#
# Three details that each looked like a nicety and are not:
#   * the prefix is compared as a LITERAL, not as a regex. `grep "^$WINDOW"` would treat
#     the window as a pattern, and an ISO timestamp with fractional seconds contains `.`,
#     which matches any character -- a window can then cover more than the reader meant.
#   * the name is prefixed. A block a reader pastes into their own shell must not silently
#     replace a function they already have called `mine`; the block also removes it at the
#     end, so nothing survives the paste.
#   * the return value distinguishes "not yours" from "you have not filled the window in",
#     because only the second one means the whole block should stop.
walkthrough_owns() {  # <creationTimestamp> -- 0 = yours, 1 = somebody else's, 2 = unusable window
  case "$WALKTHROUGH_WINDOW" in
    '<'*'>'|'') echo "fill in WALKTHROUGH_WINDOW first -- nothing will be deleted" >&2; return 2;;
  esac
  [ "$(printf '%s' "$1" | cut -c1-${#WALKTHROUGH_WINDOW})" = "$WALKTHROUGH_WINDOW" ]
}
window_ok=yes
for pol in cancel-on-failed-verdict cancel-run-without-gate; do
  [ "$window_ok" = yes ] || continue
  created=$(kubectl get clusterpolicy "$pol" --ignore-not-found \
    -o jsonpath='{.metadata.creationTimestamp}' 2>&1)
  if [ -z "$created" ]; then
    echo "$pol: absent -- nothing to delete"
  elif walkthrough_owns "$created"; rc=$?; [ "$rc" != 0 ]; then
    # rc=2 means the window itself is unusable, which is not a statement about THIS
    # object: stop the whole block rather than repeat the same complaint per object.
    [ "$rc" = 2 ] && window_ok=no
    echo "$pol was created $created, which is not inside your window ($WALKTHROUGH_WINDOW) --"
    echo "  it is somebody else's. Skipping it; ask its owner before deleting anything."
  else
    kubectl delete clusterpolicy "$pol" --ignore-not-found
  fi
done
# The §4.2.2 alternative (namespaced Role / RoleBinding) belongs to §4.2's namespace and
# cascades with it -- do not delete twice.
#
# Same look-before-delete BRANCH for the ClusterRole, reusing the window and the helper set
# above -- re-assigning WALKTHROUGH_WINDOW here would silently reset it to the placeholder
# for anyone who filled in only the first occurrence, and this branch would then refuse to
# delete an object that IS theirs.
CR_CREATED=$(kubectl get clusterrole kyverno-background-update-pipelineruns \
  --ignore-not-found -o jsonpath='{.metadata.creationTimestamp}' 2>&1)
if [ -z "$CR_CREATED" ]; then
  echo "kyverno-background-update-pipelineruns: absent -- nothing to delete"
elif [ "$window_ok" != yes ] || ! walkthrough_owns "$CR_CREATED"; then
  echo "kyverno-background-update-pipelineruns was created $CR_CREATED, OUTSIDE your window"
  echo "($WALKTHROUGH_WINDOW) -- it is somebody else's. STOP and ask its owner; do NOT delete."
else
  kubectl delete clusterrole kyverno-background-update-pipelineruns --ignore-not-found
fi
# Leave the reader's shell as it was found.
unset -f walkthrough_owns
unset window_ok
```

The namespaced objects (the four demo PipelineRuns, plus `Pipeline/coverage-cancel-demo` and `Task/policy-demo-coverage-emitter` in `tekton-templates`) are reclaimed by the cascade of the self-created namespaces; if you are going on to the later sections, delete the four runs by name first to keep PolicyReport interference out of the way ([§4.0.5](#s4-0-5)):

```bash
kubectl delete pipelinerun -n policy-poc cancel-low-coverage-demo \
  cancel-missing-coverage-demo self-cancel-compliant self-cancel-rogue \
  --ignore-not-found
```
## 5. Scope Control {#s5}

Different projects need different constraints, but **the way scoping is implemented decides whether the policy system leaves a loophole to bypass it**. This chapter turns the two-tier model of [§1.3](#s1-3) into runnable policies.

**Read [§5.0](#s5-0) first**: every guarantee in this chapter (and in the whole document) rests on "the people who can modify the policy system are controlled" — no matter how tightly the scope is written, any identity that can modify policies, sign exemptions, change the scoping labels, or change Kyverno's own configuration can bypass it wholesale. That is why this trust root sits at the head of the chapter instead of being buried at the end.

### 5.0 Self-protection of the policy system (read this first) {#s5-0}

The foundation of scope governance is that the people who can modify the policy system are controlled. That does not mean every policy may only be maintained by platform administrators; permissions should be layered by resource scope:

- **ClusterPolicy**: only platform administrators may create, modify, and delete it. Project administrators should not be granted this permission — otherwise they could affect other projects, or dismantle the platform baseline;
- **Policy**: can be delegated to designated project administrators, with RBAC allowing creation, modification, and deletion only inside their own namespace. Regular business developers should not have this permission by default — **whoever can modify the project `Policy` can modify the project's gates**;
- **PolicyException** (**being able to create / modify exemption objects = being able to allow things through**) — that is, write access to the namespace pointed at by `--exceptionNamespace` in [§5.3](#s5-3);
- **the namespaces' scoping labels** (such as `cpaas.io/project`) — **being able to change the label = being able to move a run into or out of a given tier of constraints**. The first choice is to close off via RBAC who can modify `Namespace`; where finer per-identity control is genuinely needed, Kyverno can also validate UPDATEs of `Namespace` to lock changes to these labels (a userInfo / creator allowlist, written the same way as [§4.5.4](#s4-5-4)).
- **Kyverno's own runtime configuration** (the `kyverno` ConfigMap in the `kyverno` namespace) — **it sits earlier in the chain than any policy, and it is quieter**. Its `resourceFilters` take effect before any policy is even consulted: a filtered request is not denied, lands in no PolicyReport, and leaves no log line (see checklist item 7 in [§3.1](#s3-1)). Adding a filter entry that covers some namespace or `PipelineRun` amounts to **opening an exemption slot for the entire chapter's policies — with no TTL, no trace, and none of the [§5.3](#s5-3) approval flow** — so write access to this ConfigMap must be ranked with `ClusterPolicy` and brought under change auditing.
- **Kyverno's webhook objects and the configuration they are generated from** — the `ValidatingWebhookConfiguration` is maintained by Kyverno itself ([§3.1](#s3-1) checklist item 6), but **an identity that can flip its `failurePolicy` to `Ignore`, shrink its match surface, or simply delete it has effectively acquired demolition rights over every admission guarantee in this chapter**: the template allowlist ([§4.1.1](#s4-1-1)), the gate parameter contracts ([§4.2.1](#s4-2-1)), bare-Run entry closure ([§4.5.4](#s4-5-4)), and the Pod-level image allowlist ([§4.5.3](#s4-5-3)) all fall into a policy vacuum at once, while on the surface the cluster reads "the policies are all still there, all still Ready". So do not protect `ClusterPolicy` alone — **Kyverno's deployment entry point (the `ModuleInfo` of [§3.1.1](#s3-1-1)), its ConfigMap, and its webhook objects are three links on the same trust chain, and must be controlled together.**

**This section gives permission boundaries, not change history**: the items above guarantee "who can change what **now**", but what an audit usually asks is "what policies, exemptions, and Kyverno configuration were **actually in effect at the time of a given release**" — and that question **cannot be answered from the cluster**: what you query is always the current object, which cannot rule out a brief loosening, replacement, and revert in between. To be able to answer it, two anchor points must be fixed at deployment time: ① **all policies and exemptions go through GitOps** (the version history is the change history — already required by [§3.6](#s3-6); name PolicyExceptions with the approval date / ticket number, [§5.3](#s5-3)); ② **the Kubernetes API server's audit log** — the only source that can prove "this object was created / modified / deleted within a time window", but **whether it is enabled and how long it is retained depend on your environment** — confirm that before writing it into your audit criteria.

**Advanced (`generate`; not developed in this document)**: a `generate` rule can automatically lay down a namespaced `Policy` for each newly created project namespace, so that new projects automatically inherit a baseline set. Lifecycle management (sync, deletion) is complex; evaluate before introducing it.

### 5.1 Scope matching methods {#s5-1}

| Method | What it matches | Typical use |
|---|---|---|
| a namespaced `Policy`'s `metadata.namespace` | Resources inside that namespace only | Project administrators' self-service tightening; no `ClusterPolicy` permission needed |
| `match.resources.namespaces` | Namespace names (literal / wildcard) | Precisely scoping in a small set of fixed namespaces |
| `namespaceSelector` | **The Namespace's own labels** | Per-project differentiation by project label, when the platform manages policies centrally |
| `exclude.resources.namespaces` | Namespace names | Carving the system namespaces out of "everything" (the workhorse of the platform baseline) |
| `match.resources.selector` | **The validated resource's own labels** | Subdividing by labels on the PipelineRun / TaskRun itself |

### 5.2 The two-tier governance model {#s5-2}

- **What it governs**: make the platform baseline cover every single workload namespace, while allowing each project to **tighten** on top of it.
- **Why it is hard**: the baseline must **not** depend on "this namespace carries a certain label" — newly created, unlabeled, or relabeled namespaces would naturally escape the baseline.
- **How the policy is layered**: ① the baseline `match`es all namespaces + a **negative `exclude`** carving out the system namespaces → ② tightening uses a **positive `namespaceSelector`** (platform-managed) or a namespaced `Policy` (project self-service) → ③ when multiple policies match the same resource the relationship is **AND** — tightening can only tighten, never loosen.
- **What it cannot govern**: permission to change the scoping labels themselves does not live at this layer — that falls to RBAC, or to the policy system's self-protection in [§5.0](#s5-0).

**The baseline**: match all namespaces, and `exclude` the system namespaces. The rule body below uses an annotation probe in place of a real constraint (for a real baseline, substitute any hard constraint from [§4.1](#s4-1)–[§4.5](#s4-5)):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: pipeline-baseline
spec:
  background: false
  rules:
    - name: baseline-for-every-business-namespace
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
                - kube-public
                - kube-node-lease
                - kyverno
                - tekton-pipelines
                - tekton-operator
                - cpaas-system
      validate:
        failureAction: Enforce
        message: "baseline pipeline policy applies in every business namespace (labeled or not)."
        deny:
          conditions:
            all:
              - key: "{{ request.object.metadata.annotations.\"policy.test/violate-baseline\" || '' }}"
                operator: Equals
                value: "true"
```

**Platform-managed per-project tightening**: when project policies are maintained centrally by the platform team, a `namespaceSelector` can select only the namespaces labeled `cpaas.io/project: alpha` and stack stricter rules on them:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: project-alpha-tightening
spec:
  background: false
  rules:
    - name: alpha-extra-restriction
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaceSelector:
                matchLabels:
                  cpaas.io/project: alpha
      validate:
        failureAction: Enforce
        message: "project alpha forbids this (per-project tightening on top of the baseline)."
        deny:
          conditions:
            all:
              - key: "{{ request.object.metadata.annotations.\"policy.test/violate-project\" || '' }}"
                operator: Equals
                value: "true"
```

**First create the three probe namespaces** — the six probe cells of this section rely entirely on their label differences, and `rogue-ns` having no label is itself one of the cells. The guards match [§3.3](#s3-3): a pre-existing namespace is left alone and not marked, so the cleanup below cannot delete it:

```bash
# $WALKTHROUGH_ID comes from §3.3. In a fresh shell, re-export the value you wrote
# down there. This line stops the loop if it is unset -- otherwise the label would be
# written with an empty value and the cleanup would later refuse to touch it.
# Deliberately an if, not `: "${WALKTHROUGH_ID:?...}"` and not `exit 1`: pasted into
# an interactive shell the first only prints and lets the next line run anyway, and
# the second closes your terminal.
if [ -z "${WALKTHROUGH_ID:-}" ]; then
  echo "WALKTHROUGH_ID is unset -- run the namespace block in §3.3 first, or re-export the id it printed"
else
  for spec in proj-a:alpha proj-b:beta rogue-ns:; do
    name=${spec%%:*}; project=${spec#*:}
    if ! out=$(kubectl get namespace "$name" -o name --ignore-not-found 2>&1); then
      echo "$name: CHECK FAILED ($out)"
    elif [ -n "$out" ]; then
      # Same STOP as §3.3: the cleanup below is a namespace cascade, and a namespace
      # this run did not create has no removal path -- runs you create in it (if you
      # switch the probes from dry-run to real creates) would be stranded.
      echo "$name: pre-existing -- STOP: pick your own namespace names (§4.0.4) and"
      echo "  substitute them in the probes and the cleanup below."
    elif ! kubectl create namespace "$name" >/dev/null 2>&1; then
      echo "$name: create failed -- do NOT label it, and treat it as pre-existing (STOP)"
    elif ! kubectl label namespace "$name" "policy.alauda.io/walkthrough=$WALKTHROUGH_ID" >/dev/null; then
      # Same as §3.3: unlabelled means the cleanup loop below will skip it. The
      # namespace is seconds old, empty, and certainly yours -- delete it by hand
      # and re-run this loop rather than going on without the marker.
      echo "$name: created but LABEL FAILED -- the cleanup loop will not touch it."
      echo "  Run: kubectl delete namespace $name   # then re-run this loop"
    elif [ -n "$project" ] && ! kubectl label namespace "$name" cpaas.io/project="$project" >/dev/null; then
      # The project label is what the six probe cells below discriminate on: if it did
      # not land, the table's expectations no longer describe this namespace.
      echo "$name: created but PROJECT LABEL FAILED -- do not run this section's probes yet"
    else
      echo "$name: created project=${project:-<none, on purpose>}"
    fi
  done
fi

kubectl get namespace proj-a proj-b rogue-ns \
  -o custom-columns='NAME:.metadata.name,PROJECT:.metadata.labels.cpaas\.io/project'
# Expect alpha / beta / <none>. A project value on rogue-ns invalidates the last two
# rows of the table below -- the tightening would then legitimately apply to it, and
# "Allowed" would be the wrong expectation rather than a policy bug.
```
**If the output above reads "WALKTHROUGH_ID is unset"**: every subsequent command in this section will report namespace-not-found or failing probes — that is **unfinished preparation**, not the policy judging wrongly. Go back to [§3.3](#s3-3), run that block once (or re-`export` the id you wrote down), then continue. We deliberately do not wrap each subsequent command in its own check: that would turn the whole section into flow control instead of a readable walkthrough, and this failure is **noisy** (a NotFound you can spot at a glance), not silent.

**Then install the two policies above** — they are this section's objects under test; run the probes without them and all six cells come back **Allowed**, which looks exactly like "the policy is written wrong":

```bash
# Save the two YAML blocks above as pipeline-baseline.yaml and
# project-alpha-tightening.yaml. `create`, not `apply` (§4.0.4): a same-named
# ClusterPolicy is somebody else's governance rule, and overwriting it is a
# cluster-wide change -- an AlreadyExists here means STOP, not retry.
kubectl create -f pipeline-baseline.yaml
kubectl create -f project-alpha-tightening.yaml

# A policy that is not Ready does not evaluate, so an unready one would make every
# probe cell below read "Allowed" for a reason that has nothing to do with scoping.
kubectl wait --for=condition=Ready clusterpolicy/pipeline-baseline --timeout=60s
kubectl wait --for=condition=Ready clusterpolicy/project-alpha-tightening --timeout=60s
```

**Verification probes** (namespaces: `proj-a` with `cpaas.io/project=alpha`, `proj-b` with `=beta`, `rogue-ns` unlabeled):

| Probe | Expected |
|---|---|
| Violate the baseline @ `rogue-ns` (no label) | Denied (the baseline does not look at labels) |
| Violate the baseline @ `proj-a` | Denied |
| Violate the baseline @ `tekton-operator` (excluded) | Allowed |
| Violate the project rule @ `proj-a` | Denied (the tightening applies) |
| Violate the project rule @ `proj-b` (a different project) | Allowed |
| Violate the project rule @ `rogue-ns` (no label) | Allowed |

**The key conclusion**: with the baseline built on a negative `exclude`, an unclassified namespace has **nowhere to escape to**; with the tightening built on a positive `namespaceSelector`, it applies only to the target project. When multiple policies match the same resource the relationship is AND — a run in `proj-a` is constrained by the baseline and the tightening at once.

**Project administrators' self-service governance**: the `project-alpha-tightening` above is only the platform-managed spelling. Under the project-autonomy model, put the same `spec.rules` into a `kind: Policy`, set `metadata.namespace` to the project namespace, and drop the `namespaceSelector` from the rule (a namespaced `Policy` naturally applies only to that namespace). Platform RBAC grants only the designated project administrators the right to manage `Policy` inside their namespace, and **does not grant `ClusterPolicy` permissions**. The prerequisites are that Kyverno has been installed by the platform and that the project role has been granted management of `policies.kyverno.io` inside this namespace; once that one-time platform configuration is done, project administrators' day-to-day rule adjustments need no platform-administrator role.

| Deployment mode | Policy resource | Maintainer | Effective scope |
|---|---|---|---|
| Platform baseline | `ClusterPolicy` | Platform administrator | All workload namespaces, with the system namespaces excluded negatively |
| Platform-managed per-project tightening | `ClusterPolicy` + `namespaceSelector` | Platform administrator | The namespaces the selector matches |
| Project self-service tightening (the recommended project-administrator path) | `Policy` | Project administrator | The single namespace named by `metadata.namespace` |

A `Policy` **can only tighten; it cannot override or switch off** a `ClusterPolicy` that has matched — every matching validate rule must pass. Nor can it govern cluster-scoped resources such as `Namespace`; the PipelineRun, TaskRun, and Pod of this document are all namespaced resources, so the main validate / mutate scenarios can all be implemented with a `Policy`. When a rule uses `mutate-existing` or `generate` and needs extra RBAC for the Kyverno controller, that controller RBAC is still pre-approved and granted by the platform administrator — project administrators must not acquire cross-namespace or cluster-scoped permissions through self-service policies.

**Platform-mandated requirements must not live only in a `Policy` the project can modify or delete on its own** — they must remain in platform-managed `ClusterPolicy` resources; the project `Policy` carries the project's own, self-adjustable tightening rules.

#### Cleanup (§5.2)

Clean up per the two rules in [§4.0.4](#s4-0-4). **The six probe cells left no objects to clean** — per [§3.4.1](#s3-4-1) they are `kubectl create --dry-run=server` and never persist anything; only if you switched to real `create`s are there runs left behind, and those are reclaimed by the namespace cascade below.

Delete the two cluster-scoped policies first (both are Enforce — miss one and it keeps adjudicating everyone's admission requests, so read the output and do not let a failure scroll past silently):

```bash
# §4.0.4's look-before-delete for cluster-scoped objects: one glance at when they
# were created, then delete by name.
kubectl get clusterpolicy pipeline-baseline project-alpha-tightening \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp'
kubectl delete clusterpolicy pipeline-baseline project-alpha-tightening
```

Delete the three namespaces by the marker the creation loop stamped on them — **the pre-existing ones carry no marker, and this loop cannot touch them**:

```bash
# Per namespace, with THIS run's id as the precondition -- §3.3's two carry the same
# label key and must NOT go yet, so a blanket label selector would be wrong here.
# (kubectl also refuses a label selector together with resource names.)
for ns in proj-a proj-b rogue-ns; do
  if ! json=$(kubectl get namespace "$ns" -o json 2>&1); then
    case "$json" in
      *NotFound*) echo "$ns: gone already -- nothing to do" ;;
      # Forbidden and a connection error must not read as "gone": an unreadable
      # namespace is not a deleted one, and walking away here would leave it (and
      # everything in it) behind while the output reads like a finished pass.
      *) echo "$ns: could not be read -- $json"
         echo "  Left alone. Resolve the read error and run this loop again." ;;
    esac
    continue
  fi
  # jq's exit code too: a parse failure would produce an empty marker, and the branch
  # below would then report a labelling mistake that never happened.
  if ! marker=$(printf '%s' "$json" | jq -r '.metadata.labels."policy.alauda.io/walkthrough" // ""'); then
    echo "$ns: could not parse the namespace JSON -- left alone"
    continue
  fi
  if [ -n "${WALKTHROUGH_ID:-}" ] && [ "$marker" = "$WALKTHROUGH_ID" ]; then
    # The label check is the ownership evidence (§4.0.4): only a namespace THIS run
    # created and marked gets deleted, cascade and all.
    kubectl delete namespace "$ns"
  else
    echo "$ns: label '${marker:-<none>}' is not this run's id '${WALKTHROUGH_ID:-<unset>}' -- left alone"
  fi
done
```
### 5.3 PolicyException controlled exemption {#s5-3}

- **What it governs**: when a pipeline genuinely needs to bypass a particular gate for a while (an emergency release, coverage to be back-filled later), use a **controlled exemption** — do not write "allow on sight of some label" into the policy.
- **Why it is hard**: **the exemption's match key must not be anything business-controllable.** A PipelineRun's name, its labels, and `spec.taskRunSpecs[].metadata.labels` are all business input; Tekton moreover lets same-named values in `taskRunSpecs` override and propagate onto the child TaskRun's labels. Using these fields as the approval credential = self-service bypass.
- **How the policy is layered**: ① use a **dedicated execution namespace** as the exemption boundary — the PolicyException matches only TaskRuns inside that namespace → ② lock down **every run entry point** of that namespace with Enforce policies: who may create / update PipelineRuns, who may create TaskRuns, and **who may create CustomRuns** (leave out any one of the three entry classes and you have left a door open for self-service bypass — same reasoning as [§4.5.4](#s4-5-4)) → ③ the PolicyException is precise to "a single rule of a single policy"; every other rule keeps blocking as usual.
- **What it cannot govern**: PolicyException natively has **no TTL** — "temporary" must be enforced by an external process or an expiring CleanupPolicy; do not treat it as a permanent bypass.

:::warning RBAC is additive — "no explicit RoleBinding" does not mean denied

Adding a Role for the approver identity **cannot revoke** the PipelineRun permissions the business identity already holds from ACP's baseline ClusterRoles. In real environments the business ServiceAccount usually already has create permission in a newly created namespace, so the Enforce policy below must be **stacked on top of** RBAC — the absence of a RoleBinding cannot be taken as evidence of denial.

:::

This section uses two namespaces: `policy-exempt-runs` (the exemption execution boundary) and `policy-exceptions` (holding nothing but the `PolicyException` objects). **The latter usually already exists from when the platform configured `--exceptionNamespace`** and is somebody else's trusted namespace — so, as before, create only the one that does not exist, and label only what you created yourself.

**First read which namespace the platform actually trusts**, then decide whether to create anything: read it too late and you may already have created a namespace for nothing — and then have to go back and change the `namespace` in every YAML of this section.

```bash
# The PolicyException below is only honoured inside the namespace Kyverno was told to
# trust. Read that first -- an exception outside the trusted namespace is created
# happily and then does nothing, and you would read "still denied" as a cache or
# policy problem. If it names something other than policy-exceptions, do NOT create
# your own. The rule: substitute it everywhere §5.3 uses `policy-exceptions` AS A
# VALUE -- in a command, a YAML field, or a resource path. Prose that merely talks
# about the default name (this comment, the Expect note below, the Chinese text)
# keeps the literal: it describes the name rather than acting on it. The value sites
# are
#   1. both `for ns in ...` loops (the creation one just below, and the cleanup one)
#      -- drop it from both lists, since the namespace already exists;
#   2. `metadata.namespace` in the PolicyException YAML and in the approver
#      Role / RoleBinding YAML;
#   3. every `-n policy-exceptions` in this section's commands (the six steps AND
#      the cleanup).
# `policy-exempt-runs` is a DIFFERENT namespace and is NOT affected -- that one is
# this document's own, and you do create it.
kubectl -n kyverno get deploy kyverno-admission-controller \
  -o jsonpath='{.spec.template.spec.containers[0].args}{"\n"}' | tr ',' '\n' | grep -i exception
# Expect TWO lines: --enablePolicyException=true, and --exceptionNamespace=<a name>.
# Whatever that second line prints IS the trusted namespace -- this document writes
# policy-exceptions throughout because that is what §3.1.1 configures, but do not
# expect that literal: the printed value is the answer, not a value to match against.
# Only the first line printed is the untouched ACP default (measured) -- then this
# whole section cannot work yet: go do §3.1.1 first.
```

Create the namespaces only after that confirmation:

```bash
# $WALKTHROUGH_ID comes from §3.3; re-export the value you wrote down if this is a
# fresh shell. Same guard as §5.2: an empty id would produce a marker nobody can claim.
# Deliberately an if, not `: "${WALKTHROUGH_ID:?...}"` and not `exit 1`: pasted into
# an interactive shell the first only prints and lets the next line run anyway, and
# the second closes your terminal.
if [ -z "${WALKTHROUGH_ID:-}" ]; then
  echo "WALKTHROUGH_ID is unset -- run the namespace block in §3.3 first, or re-export the id it printed"
else
  for ns in policy-exempt-runs policy-exceptions; do
    if ! out=$(kubectl get namespace "$ns" -o name --ignore-not-found 2>&1); then
      echo "$ns: CHECK FAILED ($out)"
    elif [ -n "$out" ]; then
      # The two namespaces differ here. policy-exceptions pre-existing is the NORMAL
      # case (the platform's trusted namespace): it gets no label, the cleanup's
      # namespace loop leaves it alone, and the demo exception inside it is deleted
      # by name. policy-exempt-runs is this document's own execution boundary: the
      # cleanup cascades it, so a pre-existing one has no removal path -- STOP.
      if [ "$ns" = policy-exceptions ]; then
        echo "$ns: pre-existing -- fine (the platform's trusted namespace); it will not"
        echo "  be labelled, and the cleanup will not delete it"
      else
        echo "$ns: pre-existing -- STOP: this walkthrough must own $ns (§4.0.4)."
        echo "  Finish the earlier walkthrough that left it behind, or pick another name"
        echo "  and substitute it in this section's YAML and commands."
      fi
    elif ! kubectl create namespace "$ns" >/dev/null 2>&1; then
      echo "$ns: create failed -- do NOT label it, and treat it as pre-existing"
    elif ! kubectl label namespace "$ns" "policy.alauda.io/walkthrough=$WALKTHROUGH_ID" >/dev/null; then
      # Same as §3.3 and §5.2: unlabelled means the cleanup loop skips it, and a
      # re-run reads it as pre-existing and skips it again. It is seconds old, empty,
      # and certainly yours -- delete it by hand and re-run this loop.
      echo "$ns: created but LABEL FAILED -- the cleanup loop will not touch it."
      echo "  Run: kubectl delete namespace $ns   # then re-run this loop"
    else
      echo "$ns: created"
    fi
  done
fi
```
**If the block above printed "WALKTHROUGH_ID is unset"**: every later command in this section will report a missing namespace or a failed probe — that is **unfinished preparation**, not a wrong policy verdict. Go back to [§3.3](#s3-3), run that block once (or re-`export` the id you wrote down), then continue. We deliberately do not wrap every subsequent command in a guard of its own: that would turn the whole section into flow control instead of a readable walkthrough, and this failure is **noisy** (the NotFound is obvious at a glance), not silent.

:::details Full policy YAML: exempt-namespace-approver-only (four rules)

```yaml
# The exception namespace is a trusted execution boundary. RBAC grants the
# approver's positive permission; this policy supplies the negative boundary
# even when platform baseline ClusterRoles already grant broader access.
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: exempt-namespace-approver-only
spec:
  background: false
  rules:
    - name: only-approver-creates-exempt-runs
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - CREATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the designated policy approver may create PipelineRuns in the
          exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - <approver-identity>
    - name: only-trusted-identities-update-exempt-runs
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/PipelineRun
              operations:
                - UPDATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the approver or the required Tekton control-plane controllers may
          update PipelineRuns in the exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - <approver-identity>
                  - system:serviceaccount:tekton-pipelines:tekton-pipelines-controller
                  - system:serviceaccount:tekton-pipelines:tekton-chains-controller
                  # When Tekton Results is enabled, append the exact live
                  # watcher identity discovered from its Deployment.
    - name: only-tekton-controller-creates-exempt-taskruns
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1/TaskRun
              operations:
                - CREATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the Tekton Pipelines controller may create TaskRuns in the
          exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - system:serviceaccount:tekton-pipelines:tekton-pipelines-controller
    # CustomRun is a second, equivalent run entry point (§4.5.4). Leaving it out
    # here would let any identity that kept CustomRun create through cumulative
    # baseline RBAC walk into the trusted namespace without approver admission.
    - name: only-tekton-controller-creates-exempt-customruns
      match:
        any:
          - resources:
              kinds:
                - tekton.dev/v1beta1/CustomRun
              operations:
                - CREATE
              namespaces:
                - policy-exempt-runs
      validate:
        failureAction: Enforce
        message: >-
          Only the Tekton Pipelines controller may create CustomRuns in the
          exception target namespace.
        deny:
          conditions:
            all:
              - key: "{{ request.userInfo.username }}"
                operator: AnyNotIn
                value:
                  - system:serviceaccount:tekton-pipelines:tekton-pipelines-controller
```

:::

:::warning The ServiceAccount identities above must be checked against your environment

Substitute them if your install namespace or controller SA names differ; **do not copy identities of optional components that are not installed**. Do not check from memory — read both identities out:

```bash
# TEKTON_NS comes from §3.1; the line below only covers a fresh shell. Print the
# identity string in the exact form the policy wants, so it can be pasted verbatim
# instead of assembled by hand.
: "${TEKTON_NS:=tekton-pipelines}"
kubectl get deploy -n "$TEKTON_NS" tekton-pipelines-controller \
  -o jsonpath='system:serviceaccount:{.metadata.namespace}:{.spec.template.spec.serviceAccountName}{"\n"}'

# Results watcher: only if Tekton Results is enabled. NO OUTPUT means the Deployment
# does not exist -- then leave that identity OUT of the list rather than adding it
# "just in case" (an identity that exists nowhere still widens the exemption if the
# component is installed later under that name).
kubectl get deploy -n "$TEKTON_NS" tekton-results-watcher --ignore-not-found \
  -o jsonpath='system:serviceaccount:{.metadata.namespace}:{.spec.template.spec.serviceAccountName}{"\n"}'
```

The first command prints exactly the full identity to put on the allowlist (of the form `system:serviceaccount:tekton-pipelines:tekton-pipelines-controller`, with the namespace taken from the actual deployment); no output from the second means Tekton Results is not enabled — precisely the "when disabled, keep the identity out of the list" case in the next paragraph.

`tekton-results-watcher` **applies only when Tekton Results is enabled**: it needs to update PipelineRuns to manage the `results.tekton.dev/pipelinerun` finalizer, and **omitting a watcher that really exists blocks the finalizer cleanup after archival, wedging runs that are being deleted**. When enabled, append the exact ServiceAccount of the live Results watcher Deployment to the `value` list of `only-trusted-identities-update-exempt-runs`; when disabled (`TektonConfig.spec.result.disabled=true` — neither the Deployment nor the ServiceAccount exists), keep the identity out of the list.

:::

The six steps of this section write a few **local state files** between them (`gate-snapshot.txt`, `step3-verdict.txt`, `step4-verdict.txt`, `step6-delete.txt`, `exemption-id.txt`) — they record how far the verification has got and what the verdicts were, so you can pick up in a different terminal; **delete last round's files before you start** (`rm -f` is enough), so that a previous round's verdict is never read as this round's own.

**Install this entrance-lock policy only after the identities check out** — it is the object under test in step ② of this section. Without it, the business identity's PipelineRun create will **simply succeed**, and as the warning at the top of [§5.3](#s5-3) already said, ACP baseline RBAC usually allows that create anyway — so the success cannot be explained as "RBAC is misconfigured", and you would be off debugging a problem that does not exist:

```bash
# Save the four-rule YAML above as exempt-namespace-approver-only.yaml, AFTER
# substituting <approver-identity> and the ServiceAccount identities you just read.
# `create`, not `apply` (§4.0.4). An AlreadyExists means the policy is somebody
# else's object: find out whose before going on, and do NOT let this section's
# cleanup delete it.
kubectl create -f exempt-namespace-approver-only.yaml
kubectl wait --for=condition=Ready clusterpolicy/exempt-namespace-approver-only --timeout=60s
```

:::warning The rule being exempted must genuinely be installed right now, or all six steps are false passes

**`gate-param-contract` ([§4.2.1](#s4-2-1)) must already be installed at this moment, with a scope that covers both the normal execution namespace and `policy-exempt-runs`.** On the section-by-section independent path of [§4.0.5](#s4-0-5) you deleted it at the end of [§4.2](#s4-2), and nothing in this section so far has reinstalled it — with the target rule absent, steps ③ and ⑤ below both simply succeed, and you would read "not denied" as "the exception took effect". So install it first, and read out two things to confirm:

```bash
# Save the §4.2.1 YAML as gate-param-contract.yaml first. `create`, not `apply`:
# an AlreadyExists just means it is still installed from §4.2 -- that is fine, it is
# this document's own demo policy either way.
kubectl create -f gate-param-contract.yaml

# Two things must hold, and neither is visible from "the policy exists":
kubectl get clusterpolicy gate-param-contract -o jsonpath='{range .spec.rules[*]}{.name}{" ns="}{.match.any[0].resources.namespaces}{"\n"}{end}'
kubectl get clusterpolicy gate-param-contract -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}{"\n"}'
# Expect the rule's namespace list to contain BOTH policy-poc and policy-exempt-runs
# (the §4.2.1 YAML ships that way -- if you narrowed it while adapting the policy to
# your own profile, widen it back), and Ready=True. A missing namespace or Ready!=True
# means step ③ below cannot fail for the reason you are about to attribute it to.
```

Keep this policy **until the very end of this section**: the final ⑤ re-check at the end of the cleanup depends on it too (see the [§5.3](#s5-3) cleanup).

:::

The PolicyException matches only TaskRuns in the dedicated execution namespace — no reliance on run names or labels any more:

```yaml
apiVersion: kyverno.io/v2
kind: PolicyException
metadata:
  # Treat each approval as immutable. Use a new name for a new approval instead
  # of deleting and immediately recreating the same name during cache propagation.
  # Encoding the approval date or ticket id in the name (e.g. <yyyymmdd>-<seq>)
  # makes the audit trail self-describing.
  name: approved-exemption-001
  namespace: policy-exceptions   # Must equal the trusted --exceptionNamespace.
spec:
  exceptions:
    # ruleNames must exactly match spec.rules[].name in the target policy.
    - policyName: gate-param-contract
      ruleNames:
        - scan-quality-gate-must-stay-on
  match:
    any:
      - resources:
          kinds:
            - TaskRun
          namespaces:
            - policy-exempt-runs
```

Save the YAML above as `approved-exemption.yaml`. **Before creating it, confirm the name is not in use** — `policy-exceptions` is usually a **trusted namespace the platform created long ago** and may already hold real, in-force exemptions; and this section's final cleanup deletes by name. So:

```bash
# Fix the name ONCE, here. Everything below -- the collision probe and the create --
# reads it from this variable, so changing your mind later means editing one line
# instead of hunting for the literal. (The cleanup reads the name back from the
# exemption-id.txt file the create between ③ and ④ writes.)
EXC_NAME=approved-exemption-001

kubectl get policyexception -n policy-exceptions "$EXC_NAME" -o name --ignore-not-found
# Expect no output. Anything printed is somebody's real approval: DO NOT apply over it
# and DO NOT delete it -- pick your own name (the comment above suggests
# <yyyymmdd>-<ticket>) and set EXC_NAME to it. Only this variable needs editing.

# Generate the manifest FROM the variable rather than trusting yourself to edit the
# name in two places. That is what makes the "fix the name once" claim above true:
# the create below reads a generated file, not a second copy of the name. Editing
# only EXC_NAME and forgetting the YAML would otherwise create one name and clean up
# another -- and the leftover is a permanent bypass (see this section's cleanup).
sed "s/^  name: approved-exemption-001\$/  name: $EXC_NAME/" \
  approved-exemption.yaml > approved-exemption.generated.yaml
grep '^  name:' approved-exemption.generated.yaml   # must print your EXC_NAME

# STOP HERE -- do NOT create it yet. Step ③ of the walkthrough below has to show that
# a violating run fails WITHOUT an exception; creating it now would destroy that
# baseline and make step ③ prove nothing. The create happens between ③ and ④.
```

`ruleNames` must match the target policy's current `spec.rules[].name` **verbatim**: with a stale name the object is still created, but it **silently exempts no rule at all**.

Three key properties: **dual entry control** (the right to create PolicyExceptions is closed off by the RBAC of `policy-exceptions`; the run entry is closed off jointly by RBAC + admission policy, and the admission side must cover **all three entry classes — PipelineRun / TaskRun / CustomRun — at once**: miss any one of them and this property no longer holds), **precision to a single rule of a single policy** (every other rule keeps blocking), and **auditability** (the exception object, the approver identity, and the runs in the dedicated namespace can all be queried).

**Enabling it (ACP-specific)**:

1. PolicyException needs the controller argument `--enablePolicyException=true` (already on by default in ACP) **plus** `--exceptionNamespace=<trusted-namespace>` — **neither alone is enough**. With only the former, PolicyException objects can be created (with a warning) but have **no effect whatsoever**; add the latter and the very same exemption takes effect immediately. The namespace named by `--exceptionNamespace` is where exemption authority is closed off; it accepts a **single** namespace or `*` — no lists. The two deployment shapes for multi-project environments (central approval / `*` + a meta-policy) are in [§3.1.1](#s3-1-1); this section demonstrates the **central approval** model — the trusted namespace belongs to the approving party, and project members never enter it.
2. **Persistent enablement must go through the platform module's chart values override surface** — patching the controller Deployment directly with `kubectl patch` is reverted by the next reconcile. The verbatim steps (including confirmation and rollback) are in **[§3.1.1](#s3-1-1)**.
3. `ClusterPolicy.status.conditions[].reason=Succeeded` **only proves the policy compiled; it does not prove the webhook informer has loaded it** — and PolicyException creation / deletion has its own propagation window. Rollouts and automated tests must probe **behaviour with real, controlled requests**: first prove "with no exception, a violating run = `CreateRunFailed`", then create an exception under a **brand-new name** and declare it usable only after an approved run actually reaches `Succeeded`; after deleting it, likewise wait until the same kind of approved run turns back into `CreateRunFailed`. **Do not delete and immediately recreate an object under the same name inside the propagation window** — stability numbers derived that way mean nothing.

**Prepare the two identities before running the six steps** — step ① wants "the business identity is refused by RBAC", which presupposes that **the approver identity really has been granted access**; otherwise both identities are refused and all you have proven is that nobody can create anything. The approval grant is just a namespaced Role + RoleBinding (fill in the two real identities **exactly once**, in `APPROVER_IDENTITY` / `BUSINESS_IDENTITY` at the top of the code block below, as `system:serviceaccount:<ns>:<sa>` or a username; the six steps and the cleanup all reference these two variables):

```bash
# The two identities every later block of this section uses, filled ONCE here as
# full identity strings (system:serviceaccount:<ns>:<sa> or a username).
APPROVER_IDENTITY='<approver-identity>'
BUSINESS_IDENTITY='<business-identity>'
# Names carry the walkthrough id: nothing on the cluster can legitimately reference
# policy-exception-approver-<your id>, so a name collision -- and with it the whole
# "somebody's same-named RoleBinding suddenly points at YOUR new Role" capture that a
# fixed name invites -- is structurally impossible rather than checked for. This is
# §4.0.4's "give your demo copy its own prefixed name" discipline, applied to RBAC.
if [ -z "${WALKTHROUGH_ID:-}" ]; then
  echo "WALKTHROUGH_ID is unset -- run the namespace block in §3.3 first, or re-export the id it printed"
else
  APPROVER_RBAC_NAME="policy-exception-approver-$WALKTHROUGH_ID"
  cat > policy-exception-approver-role.yaml <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $APPROVER_RBAC_NAME
  namespace: policy-exceptions
rules:
  - apiGroups:
      - kyverno.io
    resources:
      - policyexceptions
    verbs:
      - get
      - list
      - create
      - update
      - delete
YAML
  cat > policy-exception-approver-rolebinding.yaml <<YAML
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $APPROVER_RBAC_NAME
  namespace: policy-exceptions
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: $APPROVER_RBAC_NAME
subjects:
  # Only the approval identity. Business identities are deliberately absent -- and
  # absence is the whole control here, so verify it rather than assume it.
  # Written as a User subject so the same full identity string this document uses
  # everywhere else works verbatim (system:serviceaccount:<ns>:<sa> is a valid User).
  - kind: User
    name: $APPROVER_IDENTITY
    apiGroup: rbac.authorization.k8s.io
YAML
  echo "generated Role + RoleBinding YAML under the name: $APPROVER_RBAC_NAME"
fi
```

**Why the name must be unique**: a fixed name has real collision targets in this trusted namespace — `policy-exceptions` may well **already contain** a same-named approval grant maintained by somebody else, and `apply` would modify it in place; even the "first `kubectl get` to confirm the name is free, then `create`" variant leaves a window between the get and the create in which somebody else can still create the same name. Once the name carries the walkthrough id, this whole class of incidents loses its premise: nothing on the cluster can legitimately reference this name — **and that is also why the cleanup can safely delete these two objects by name**; the only thing to collide with is this same walkthrough's own earlier attempt.

```bash
# `create`, not `apply`. Role first, so on the happy path the RoleBinding never
# points at a Role that does not exist yet. The name embeds this walkthrough's id,
# so an AlreadyExists can only be an earlier attempt of this same walkthrough:
# delete the pair by name and re-run --
#   kubectl delete rolebinding,role -n policy-exceptions "$APPROVER_RBAC_NAME"
# Guarded on the generation block above having run in THIS shell: without it,
# APPROVER_RBAC_NAME is unset and the yaml files -- if present at all -- are STALE
# leftovers of an earlier walkthrough, and pasting on would silently create objects
# under the old id.
if [ -z "${APPROVER_RBAC_NAME:-}" ]; then
  echo "APPROVER_RBAC_NAME is unset -- run the generation block above first."
else
  kubectl create -f policy-exception-approver-role.yaml \
  && kubectl create -f policy-exception-approver-rolebinding.yaml \
  || { echo "the approver grant is NOT in place -- fix the error above before the six"
       echo "steps: with no grant at all, step ①'s refusal would prove nothing (both"
       echo "identities would be refused, including the one meant to pass ③-⑥)."; }
fi

# Verify BOTH directions before running the six steps -- "no/no" proves nothing.
kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${APPROVER_IDENTITY:?fill it in the RBAC block above}"    # expect: yes
kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${BUSINESS_IDENTITY:?fill it in the RBAC block above}"    # expect: no
```

**Every `kubectl create` in the six steps must carry `--as`**: ① / ② use `$BUSINESS_IDENTITY`, ③–⑥ use `$APPROVER_IDENTITY`. **Without `--as` you are acting as your own kubeconfig identity** (most likely an administrator): all six steps "pass", and that proves nothing (the identity self-checks of [§4.0.3](#s4-0-3) make the same point).

**The remaining commands deliberately carry no `--as`** — the code blocks below are written that way — for two distinct reasons:

- **Reads (`kubectl wait` / `kubectl get`)**: what is under test is "who can write"; reading is just evidence collection. Besides, the business identity does not necessarily hold `get pipelineruns` permission — reading as it would only produce a `forbidden` irrelevant to the conclusion. Read as yourself: you read the same state of the same object.
- **The delete in ⑥**: what ⑥ verifies is "does revocation propagate", not "who may revoke" (that was step ①'s business), so deleting as your own identity is correct.

:::details End-to-end verification checklist (six steps; the violation trigger is both gate switches set to "false")

| Step | Expect |
|---|---|
| ① Business identity creates a PolicyException | **Refused by RBAC** |
| ② Business identity creates a PipelineRun in `policy-exempt-runs` | **Rejected by admission** (even though ACP baseline RBAC already allows the create) |
| ③ With no exception, the approver identity creates a violating run in the dedicated namespace | `CreateRunFailed` |
| ④ After a new-named exception is confirmed by a behavioural probe, the approver identity creates a same-configuration run | `Succeeded`, with all three TaskRuns `scan / release / notify` successful |
| ⑤ The same-configuration violating run in a normal namespace | Still `CreateRunFailed`, with 0 child TaskRuns |
| ⑥ After the exception is deleted and cache revocation has settled, the same kind of approved run in the dedicated namespace | Back to `CreateRunFailed` |

The six steps use **one and the same violating run**, differing only in namespace and name — so first define a function that generates it, reused by all six:

```bash
# Both gate switches explicitly "false" is the violation: gate-param-contract rejects
# the `scan` TaskRun when the controller tries to create it, and the parent run then
# ends CreateRunFailed. Same shape as §3.3's demo-run-gates-off, parameterised so the
# six steps below differ only in namespace and name.
exempt_run() {  # <namespace> <run-name>
  cat <<YAML
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  name: $2
  namespace: $1
spec:
  pipelineRef:
    resolver: cluster
    params:
      - name: kind
        value: pipeline
      - name: name
        value: gated-build
      - name: namespace
        value: tekton-templates
  params:
    - name: coverage
      value: "30"
    - name: enableScanQualityGate
      value: "false"
    - name: enableAnalyzeQualityGate
      value: "false"
YAML
}

# Two more helpers the six steps share. Both exist because of the same trap: a command
# that FAILED can look exactly like one that succeeded and had nothing to say.
# No per-run bookkeeping: every run created below lives in a walkthrough-owned
# namespace, and the cleanup deletes the namespaces -- cascade takes the runs.
create_run() {  # <namespace> <run-name> <identity>
  # Every step's conclusion hinges on WHO creates the run, so refuse to run without
  # an explicit identity instead of falling through to the kubeconfig identity.
  [ -n "$3" ] || { echo "create_run: empty identity -- fill APPROVER_IDENTITY / BUSINESS_IDENTITY (RBAC prep block) first" >&2; return 1; }
  exempt_run "$1" "$2" | kubectl create --as="$3" -f - -o name
}

run_denial() {  # <namespace> <run-name>; prints the Succeeded condition's message
  # CreateRunFailed on its own says "a child could not be created" -- it does not say
  # which policy said no. Any other Enforce policy in the cluster produces the same
  # terminal shape, so a step that checks only the reason can credit its own policy
  # with somebody else's refusal. Measured, the message carries both names:
  #   admission webhook "validate.kyverno.svc-fail" denied the request:
  #   resource TaskRun/policy-poc/<run>-scan was blocked due to the following policies
  #   gate-param-contract:
  #     scan-quality-gate-must-stay-on: every policy-demo-scanner child of gated-build ...
  kubectl get pipelinerun -n "$1" "$2" \
    -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].message}' 2>/dev/null
}

run_verdict() {  # <namespace> <run-name>; prints the verdict, or why there is none
  if ! j=$(kubectl get pipelinerun -n "$1" "$2" -o json 2>&1); then
    case "$j" in
      # Same order and reasoning as §4.0.4's helper: a wrong API path also answers
      # NotFound, so it must be matched BEFORE the absent-object case.
      *'could not find the requested resource'*) echo "READ-FAILED (the API path is wrong)" ;;
      *NotFound*) echo "ABSENT (no such run -- the create was rejected)" ;;
      *) echo "READ-FAILED ($j)" ;;
    esac
    return 1
  fi
  # Measured on every degenerate shape a young run passes through -- {}, .status
  # missing, conditions empty -- all give rc 0 and "reason=<no Succeeded condition yet
  # -- still running> children=0", which is the honest answer. Only genuinely
  # unparseable input fails (rc 5), and that is what the fallback below reports. So a
  # run that has not started yet never masquerades as a verdict.
  printf '%s' "$j" | jq -er '"reason=\((.status.conditions[]?|select(.type=="Succeeded")|.reason)
      // "<no Succeeded condition yet -- still running>") children=\((.status.childReferences//[])|length)"' \
    || { echo "READ-FAILED (the run was read but its JSON could not be parsed)"; return 1; }
}
```

**Before starting the six steps, confirm the prerequisites actually hold.** The blocks above were all "install it and read it back", but nothing that was read became control flow — even if the two policies were never installed and the approver identity never actually granted, the six steps would still run to completion and hand you a full set of meaningless conclusions:

```bash
# Re-read the live state rather than remembering whether the earlier blocks looked ok.
# This is the difference between "I ran the install command" and "the thing is in force".
PREREQS_OK=yes
# Snapshot the gate policy as it is RIGHT NOW -- uid and generation. ④ compares
# against this, so "the gate ③ measured" and "the gate ④ ran under" are provably the
# same object whether it was installed by §4.2 or by this section's own create.
# generation, not resourceVersion: it bumps on spec changes and ignores status writes,
# so it catches "somebody edited the rule" without firing on ordinary reconciliation.
GPC_SNAPSHOT=$(kubectl get clusterpolicy gate-param-contract \
  -o jsonpath='{.metadata.uid}/{.metadata.generation}' 2>/dev/null)
echo "gate-param-contract snapshot: ${GPC_SNAPSHOT:-<absent>}"
printf '%s\n' "$GPC_SNAPSHOT" > gate-snapshot.txt
for pol in gate-param-contract exempt-namespace-approver-only; do
  ready=$(kubectl get clusterpolicy "$pol" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>&1)
  [ "$ready" = True ] || { echo "$pol: Ready=$ready -- not in force"; PREREQS_OK=no; }
done
can_approve=$(kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${APPROVER_IDENTITY:?fill it in the RBAC prep block}" 2>&1)
[ "$can_approve" = yes ] || { echo "approver cannot create exceptions ($can_approve)"; PREREQS_OK=no; }
echo "PREREQS_OK=$PREREQS_OK"
# Expect PREREQS_OK=yes. Anything else: go back and fix that block before step ①.
# Steps ③-⑥ read this variable, so a `no` here stops them rather than letting them
# produce confident answers about policies that are not actually installed.
```

**① Business identity creates a PolicyException — expect an RBAC refusal**

```bash
# On the branch where this does NOT fail you have just created a live exemption --
# a bypass nobody approved. Capture its name from the response and persist it into
# exemption-id.txt IMMEDIATELY: the cleanup's step ① reads that file, so the stray
# object stays deletable even if you close this shell before acting on the message.
step1_out=$(kubectl create -f approved-exemption.generated.yaml \
  --as="${BUSINESS_IDENTITY:?fill it in the RBAC prep block}" \
  -o jsonpath='{.metadata.name}' 2>&1)
step1_rc=$?
if [ "$step1_rc" -eq 0 ]; then
  printf '%s\n' "$step1_out" > exemption-id.txt
  echo "① FAILED: the business identity CREATED an exemption -- a live bypass nobody"
  echo "approved. Its name is recorded in exemption-id.txt. Delete it NOW and fix RBAC"
  echo "before going on:"
  echo "  kubectl delete policyexception -n policy-exceptions \"$step1_out\""
else
  # "It was refused" only counts if the refusal was a permission decision.
  # An unreachable API, a malformed manifest and an unknown resource type all fail
  # here too, and reading any of them as "RBAC did its job" confirms step ① on
  # evidence that has nothing to do with RBAC.
  case "$step1_out" in
    *impersonate*)
      # A Forbidden that names impersonation is about YOUR account, not about the
      # business identity: the request never reached the authorization check this
      # step is testing. Reading it as a pass confirms the wrong subject entirely.
      echo "① NOT CONFIRMED: YOU are not allowed to impersonate that identity, so the"
      echo "request never got as far as testing what the business identity may do:"
      echo "$step1_out" ;;
    *[Ff]orbidden*policyexception*|*policyexception*[Ff]orbidden*)
      echo "① confirmed: refused by RBAC --"; echo "$step1_out" ;;
    *[Ff]orbidden*)
      echo "① NOT CONFIRMED: a permission error that does not name policyexceptions --"
      echo "read it before assuming it is the refusal this step is looking for:"
      echo "$step1_out" ;;
    *) echo "① NOT CONFIRMED: the create failed, but not with a permission error:"
       echo "$step1_out"
       echo "Fix that first -- this step proves nothing about RBAC otherwise." ;;
  esac
fi
# Expect: Error from server (Forbidden). If it SUCCEEDED, the approval Role is not
# the only way in: delete the stray exemption as printed above, then fix RBAC before
# going on -- do not continue with a bypass live in the trusted namespace.
```

**② Business identity creates a run in the dedicated namespace — expect an admission rejection**

```bash
# This is supposed to be refused. The branch where it is NOT refused leaves a real
# run behind -- in the walkthrough-owned namespace, so the namespace cleanup will
# take it; what matters is fixing the policy, not the leftover.
step2_out=$(create_run policy-exempt-runs step2-business "$BUSINESS_IDENTITY" 2>&1)
step2_rc=$?
printf '%s\n' "$step2_out"
if [ "$step2_rc" -eq 0 ]; then
  echo "② FAILED: the run was CREATED. The admission lock is not stopping the business"
  echo "identity -- fix the policy before reading anything into ③-⑥."
else
  # "It was rejected" is not the claim this step makes -- the claim is "the admission
  # POLICY rejected it". An API outage, a bad manifest and a plain RBAC forbidden all
  # produce a non-zero return here, and each means something different.
  case "$step2_out" in
    *exempt-namespace-approver-only*)
      echo "② confirmed: rejected by the entrance-lock policy." ;;
    *[Ff]orbidden*)
      echo "② NOT CONFIRMED: this is a plain RBAC forbidden, not the admission policy."
      echo "Baseline RBAC happens to deny this identity here, so the lock is unproven." ;;
    *) echo "② NOT CONFIRMED: the create failed for some other reason -- read it above." ;;
  esac
fi
# Expect a denial naming exempt-namespace-approver-only / only-approver-creates-exempt-runs.
# A plain RBAC `forbidden` is a DIFFERENT answer: it means baseline RBAC happens to
# deny this identity here, so the admission lock is still unproven. Read the message.
```

**③ With no exception, the approver identity creates a violating run — expect `CreateRunFailed`**

```bash
BASELINE_OK=no
if [ "$PREREQS_OK" != yes ]; then
  echo "SKIPPED: the prerequisites above are not in force, so a failure here would not"
  echo "mean what ③ claims it means."
elif ! create_run policy-exempt-runs step3-no-exception "$APPROVER_IDENTITY"; then
  echo "③ NOT CONFIRMED: the run could not even be created. That is an RBAC or"
  echo "admission answer about YOU, not the gate contract this step is testing."
else
  # Succeeded=false is the terminal-failure wait; a plain --for=condition=Succeeded
  # would sit here until the timeout and tell you nothing. Its exit code matters:
  # a timeout means the run never reached a terminal state, which is not a verdict.
  if ! kubectl wait -n policy-exempt-runs pipelinerun/step3-no-exception \
         --for=condition=Succeeded=false --timeout=5m; then
    echo "③ NOT CONFIRMED: the run never reached a terminal state within 5m."
  else
    v=$(run_verdict policy-exempt-runs step3-no-exception)
    echo "③: $v"
    msg=$(run_denial policy-exempt-runs step3-no-exception)
    case "$v" in
      "reason=CreateRunFailed children=0")
        case "$msg" in
          *gate-param-contract*) BASELINE_OK=yes; echo "③ confirmed -- denied by gate-param-contract" ;;
          *) echo "③ NOT CONFIRMED: the run failed as expected, but the denial does not"
             echo "  name gate-param-contract, so something ELSE rejected it and this"
             echo "  step credits the wrong policy. The message was:"
             echo "  $msg" ;;
        esac ;;
      *) echo "③ NOT CONFIRMED: expected reason=CreateRunFailed children=0."
         echo "  Especially if it says Succeeded: the target rule is not in force, and"
         echo "  every step after this would be measuring nothing. Re-read the"
         echo "  gate-param-contract install block above." ;;
    esac
  fi
fi

# Persist it for the same reason ④ persists its own verdict: a reader who takes a
# break between ③ and ④ comes back to an empty variable, ④ says SKIPPED, and the
# temptation is to set BASELINE_OK=yes by hand -- which throws away the proof.
printf '%s\n' "$BASELINE_OK" > step3-verdict.txt
echo "③ verdict recorded: $BASELINE_OK"
```

**Create the exception (between ③ and ④)**

```bash
# Write the created name to a file, then read it back out of it. Step ⑥ and the
# cleanup both delete this object by that name, and they may well run in a later
# shell -- a name that exists only as a shell variable is one you will not have when
# it matters. The file is written only by THIS create succeeding, which is what makes
# deleting by its content safe later: it can only ever name your own object.
if [ "$PREREQS_OK" != yes ] || [ "$BASELINE_OK" != yes ]; then
  echo "SKIPPED: creating an exemption while the prerequisites or ③'s baseline are"
  echo "unproven would put a live bypass on the cluster to observe nothing."
  echo "It would also have to be cleaned up. Fix those first."
  EXC_CREATED=
else
  EXC_CREATED=$(kubectl create -f approved-exemption.generated.yaml \
    --as="${APPROVER_IDENTITY:?fill it in the RBAC prep block}" \
    -o jsonpath='{.metadata.name}{"\n"}')
fi
[ -n "$EXC_CREATED" ] && printf '%s\n' "$EXC_CREATED" > exemption-id.txt
echo "created ${EXC_CREATED:-<none>}"
# Expect the name. An empty result means the create failed -- and ④ below guards on
# EXC_CREATED rather than trusting you to have read this comment, because ④ can only
# prove anything if this exception actually exists.
[ -n "${EXC_CREATED:-}" ] || echo "STOP: no exception was created. Re-read the errors above;
④ / ⑤ / ⑥ all assume it exists."
```

**④ With the exception in place, the same-configuration run — expect `Succeeded`**

```bash
# Propagation is not instant, and there is NO synchronous way to observe it: the deny
# happens when the controller creates the gate TaskRun, so a --dry-run on the
# PipelineRun cannot see it either way. Probe by behaviour, with a NEW NAME each
# attempt -- reusing one name inside the propagation window is exactly the pattern
# this section warns against.
# Reload before the guard, not after: without this a reader who took a break between
# creating the exception and running ④ is told "no exception was created", ⑤ and ⑥
# lock too, and the exemption stays live on the cluster until they reach the cleanup.
if [ -z "${EXC_CREATED:-}" ] && [ -s exemption-id.txt ]; then
  read -r EXC_CREATED < exemption-id.txt
  echo "reloaded exception ${EXC_CREATED:-<none>} from exemption-id.txt"
fi
BASELINE_OK=${BASELINE_OK:-$(cat step3-verdict.txt 2>/dev/null)}

EXEMPTION_LIVE=no
if [ "$BASELINE_OK" != yes ]; then
  echo "SKIPPED: ③ did not establish that a violating run fails WITHOUT an exception."
  echo "Without that baseline a success here proves nothing -- it might always have"
  echo "succeeded. Fix ③ first."
elif [ -z "${EXC_CREATED:-}" ]; then
  echo "SKIPPED: no exception was created, so there is nothing here to observe. Five"
  echo "runs would fail and you would read that as 'propagation is slow'. Go back to"
  echo "the create block between ③ and ④."
else
  for i in 1 2 3 4 5; do
    if ! create_run policy-exempt-runs "step4-attempt-$i" "$APPROVER_IDENTITY"; then
      echo "attempt $i: the create itself was rejected -- that is an admission answer"
      echo "  about the PipelineRun, not about the gate TaskRun this step observes."
      sleep 10
      continue
    fi
    if kubectl wait -n policy-exempt-runs "pipelinerun/step4-attempt-$i" \
       --for=condition=Succeeded --timeout=5m; then
      EXEMPTION_LIVE=yes; LIVE_RUN=step4-attempt-$i
      echo "exemption is live (attempt $i)"; break
    fi
    # A non-zero `wait` is not by itself "the run was rejected": it also covers a plain
    # timeout and an object that was never created. Name what actually happened, because
    # the three call for different fixes.
    echo "attempt $i: $(run_verdict policy-exempt-runs "step4-attempt-$i")"
    # Expect Succeeded=False reason=CreateRunFailed while the exemption has not landed.
    # "still running" means 5m was not enough and the wait timed out -- that is a slow
    # cluster, not a policy verdict. "could not read" with a NotFound means the create
    # itself was rejected; with anything else it is your access to the cluster.
    sleep 10
  done

  # Exhausting the loop is a RESULT, not a quieter version of success. Without this
  # branch the read below would run against the last -- failed -- attempt and print an
  # empty task list, which reads exactly like "the pipeline was skipped".
  if [ "$EXEMPTION_LIVE" != yes ]; then
    echo "NOT CONFIRMED: five attempts, none reached Succeeded (up to ~25 minutes of"
    echo "waiting -- 5 attempts x the 5m timeout -- so this is not 'give it a moment')."
    echo "First re-read the per-attempt lines above: if they say 'still running' the"
    echo "cluster was just slow and nothing is proven either way. If they say"
    echo "CreateRunFailed, check in this order: does the"
    echo "PolicyException exist (kubectl get policyexception -n policy-exceptions);"
    echo "does its ruleNames match gate-param-contract's current spec.rules[].name"
    echo "verbatim; is --exceptionNamespace really set to policy-exceptions (§3.1.1)."
    echo "STOP here -- steps ⑤ and ⑥ both assume the exemption took effect."
  else
    # On the successful attempt, all three TaskRuns must be there -- the exemption is
    # supposed to let the run proceed, not to skip the pipeline. Compared, not printed:
    # a run that "succeeded" with an empty task list is the failure mode this check
    # exists for, and it looks like a pass to anyone skimming the output.
    if ! kids=$(kubectl get pipelinerun -n policy-exempt-runs "$LIVE_RUN" -o json 2>&1); then
      echo "④ NOT CONFIRMED: the successful run could not be read -- $kids"
      EXEMPTION_LIVE=no
    elif ! names=$(printf '%s' "$kids" \
      | jq -er '[.status.childReferences[]?.pipelineTaskName] | sort | join(",")'); then
      echo "④ NOT CONFIRMED: could not parse the run's childReferences"
      EXEMPTION_LIVE=no
    elif [ "$names" != "notify,release,scan" ]; then
      :   # handled below
    elif ! gpc_now=$(kubectl get clusterpolicy gate-param-contract \
        -o jsonpath='{.metadata.uid}/{.metadata.generation}' 2>&1) \
       || [ "$gpc_now" != "${GPC_SNAPSHOT:-$(cat gate-snapshot.txt 2>/dev/null)}" ]; then
      # ③ proved the gate rejects this run. That proof is only transferable to ④ if the
      # gate is STILL the same object and still Ready: if it was deleted, edited or
      # re-created between the two steps, ④ succeeds because the gate is gone, and
      # crediting that success to the PolicyException is the wrong conclusion entirely.
      echo "④ NOT CONFIRMED: gate-param-contract is no longer what the preflight saw"
      echo "  (now: '$gpc_now', then: '${GPC_SNAPSHOT:-$(cat gate-snapshot.txt 2>/dev/null)}')."
      echo "  A changed generation means the RULE was edited; a changed uid means the"
      echo "  policy was replaced. Either way ③'s baseline no longer applies here."
      echo "  This run may have succeeded because the gate went away. Re-run ③ first."
      EXEMPTION_LIVE=no
    else
      echo "④ confirmed: child TaskRuns = $names, and the gate is still the object ③ measured"
    fi
    if [ "$EXEMPTION_LIVE" = yes ] && [ "$names" != "notify,release,scan" ]; then
      echo "④ NOT CONFIRMED: child TaskRuns = '${names:-<none>}', expected notify,release,scan"
      echo "  (sorted). The run reached Succeeded WITHOUT running the pipeline, so the"
      echo "  exemption is not doing what this step claims. Do not go on to ⑤."
      EXEMPTION_LIVE=no
    fi
  fi
fi

# Persist the verdict. ⑤ and ⑥ guard on it, and a reader who takes a break between
# steps comes back to a shell where the variable is gone -- which would look exactly
# like "④ failed" and lock the rest of the walkthrough out for good.
printf '%s\n' "$EXEMPTION_LIVE" > step4-verdict.txt
echo "④ verdict recorded: $EXEMPTION_LIVE"
```

**⑤ The same-configuration run in a normal namespace — expect `CreateRunFailed`, still**

```bash
# ⑤ and ⑥ both ask "compared with ④, what changed?" -- so if ④ never confirmed, they
# have nothing to compare against and their results mean nothing. The guard is the
# variable, not ④'s "do not go on to ⑤" sentence -- and it falls back to the file, so
# a new shell does not read as "④ failed".
EXEMPTION_LIVE=${EXEMPTION_LIVE:-$(cat step4-verdict.txt 2>/dev/null)}
if [ "${EXEMPTION_LIVE:-no}" != yes ]; then
  echo "SKIPPED: ④ was not confirmed, so there is no working exemption to bound."
  echo "⑤ would fail exactly as ③ did and prove nothing new. Fix ④ first."
elif ! create_run policy-poc step5-normal-ns "$APPROVER_IDENTITY"; then
  echo "⑤ NOT CONFIRMED: the run could not be created at all. ⑤ needs a run that is"
  echo "admitted and then fails at the gate -- a rejected create is a different answer."
elif ! kubectl wait -n policy-poc pipelinerun/step5-normal-ns \
        --for=condition=Succeeded=false --timeout=5m; then
  echo "⑤ NOT CONFIRMED: the run never reached a terminal state within 5m."
else
  v5=$(run_verdict policy-poc step5-normal-ns)
  echo "⑤: $v5"
  msg5=$(run_denial policy-poc step5-normal-ns)
  case "$v5" in
    "reason=CreateRunFailed children=0")
      case "$msg5" in
        *gate-param-contract*) echo "⑤ confirmed -- denied by gate-param-contract" ;;
        *) echo "⑤ NOT CONFIRMED: rejected, but not by gate-param-contract. ⑤ has to"
           echo "  show the SAME policy still applies outside the exempt namespace;"
           echo "  a different policy rejecting it proves nothing. Message:"
           echo "  $msg5" ;;
      esac ;;
    *) echo "⑤ NOT CONFIRMED: expected reason=CreateRunFailed children=0. A success"
       echo "  here would mean the exemption is NOT bounded by namespace." ;;
  esac
fi
# This is the step that proves the exemption is bounded by namespace rather than by
# the run's configuration.
```

**⑥ After deleting the exception — expect `CreateRunFailed` again**

```bash
# This is a GATE, not a step: if the delete did not happen the exemption is still
# live, and every attempt below would then legitimately succeed -- you would be
# measuring "the exemption works", read it as "revocation has not propagated yet",
# and run out of attempts without ever learning that nothing was deleted.
# Same reload as ⑤, plus the exception's name: both may have been set in a shell you
# have since closed.
EXEMPTION_LIVE=${EXEMPTION_LIVE:-$(cat step4-verdict.txt 2>/dev/null)}
if [ -z "${EXC_CREATED:-}" ] && [ -s exemption-id.txt ]; then
  read -r EXC_CREATED < exemption-id.txt
fi

EXC_DELETED=no
EXC_DELETE_CAUSAL=no
if [ "${EXEMPTION_LIVE:-no}" != yes ]; then
  echo "SKIPPED: ④ was not confirmed, so there is no established 'exemption works'"
  echo "baseline for ⑥ to observe going away. Deleting the exception here would just"
  echo "restore a state you never left. Fix ④ first."
elif [ -z "${EXC_CREATED:-}" ]; then
  echo "SKIPPED: no record that this walkthrough created the exception (exemption-id.txt"
  echo "is missing or empty), so there is nothing of yours to delete. Find that file."
else
  # Look first: "already gone" and "deleted by you just now" support different claims
  # about propagation, and the probe below needs to know which one it is observing.
  # By name is safe here: exemption-id.txt is written only by this walkthrough's own
  # create, and the name's collision-freedom was checked before ④.
  if ! exc_seen=$(kubectl get policyexception -n policy-exceptions "$EXC_CREATED" \
        -o name --ignore-not-found 2>&1); then
    # A failed READ is not an absent object: denied permission and an API blip print
    # nothing on stdout too, and only the exit code tells them apart.
    echo "could not read the exception: $exc_seen"
    echo "STOP: an unreadable object is not a deleted one -- fix your access first."
  elif [ -z "$exc_seen" ]; then
    EXC_DELETED=yes
    # Deliberately NOT causal: something else removed it, at an unknown time. The
    # probe can still show "no exemption, run rejected", but that is a statement
    # about the current state, not evidence that a deletion propagated.
    echo "the exception was already gone -- the probe below can still run, but it"
    echo "  will not be evidence that YOUR deletion propagated."
  elif kubectl delete policyexception -n policy-exceptions "$EXC_CREATED"; then
    EXC_DELETED=yes; EXC_DELETE_CAUSAL=yes
    echo "exception deleted -- go on to the probe below"
  else
    echo "The delete request itself failed. STOP: re-run this block."
  fi
fi
# Same reason as ③ and ④: the probe below is a separate block, and a reader who takes
# a break between them comes back to EXC_DELETED unset -- which reads as "the delete
# was refused" and skips the revocation check entirely.
printf '%s %s\n' "$EXC_DELETED" "$EXC_DELETE_CAUSAL" > step6-delete.txt
```

The guard is the `EXC_DELETED` variable, not the `STOP` message — a comment saying "only run this once …" does not stop anyone who pastes the whole block:

```bash
# Revocation propagates on the same terms as the grant did, so probe it the same way.
if [ -z "${EXC_DELETED:-}" ] && [ -s step6-delete.txt ]; then
  read -r EXC_DELETED EXC_DELETE_CAUSAL < step6-delete.txt
fi
if [ "${EXC_DELETED:-no}" != yes ]; then
  echo "SKIPPED: the exception was not deleted, so there is no revocation to observe."
  echo "Every attempt below would legitimately succeed and you would read that as"
  echo "'revocation has not propagated yet' -- the exact misreading this gate prevents."
else
  REVOCATION_LIVE=no
  for i in 1 2 3 4 5; do
    if ! create_run policy-exempt-runs "step6-attempt-$i" "$APPROVER_IDENTITY"; then
      echo "attempt $i: the create was rejected -- that is not the revocation this step"
      echo "  is looking for, which happens later, at the gate TaskRun."
      sleep 10
      continue
    fi
    if kubectl wait -n policy-exempt-runs "pipelinerun/step6-attempt-$i" \
         --for=condition=Succeeded=false --timeout=5m; then
      # Succeeded=False is NOT the same claim as "the gate rejected it": a task that
      # genuinely failed also ends Succeeded=False, and reading that as a revocation
      # would confirm the wrong thing. Only CreateRunFailed means the TaskRun never
      # got created, which is what admission denial looks like from here.
      if ! r=$(kubectl get pipelinerun -n policy-exempt-runs "step6-attempt-$i" \
                 -o jsonpath='{.status.conditions[?(@.type=="Succeeded")].reason}' 2>&1); then
        # An unreadable run is not a failed one -- without this the empty `r` would be
        # reported below as "a broken pipeline", which is a different diagnosis.
        echo "attempt $i: the wait said Succeeded=False but the run cannot be read -- $r"
        break
      fi
      if [ "$r" = CreateRunFailed ]; then
        REVOCATION_LIVE=yes
        if [ "${EXC_DELETE_CAUSAL:-no}" = yes ]; then
          echo "revocation is live (attempt $i)"
        else
          echo "the run is rejected again (attempt $i), but the exception was already"
          echo "  gone before ⑥ ran -- this shows the current state, NOT that a"
          echo "  revocation propagated. ⑥ is UNPROVEN on this path."
        fi
        break
      fi
      echo "attempt $i failed with reason=$r, not CreateRunFailed -- that is a broken"
      echo "  pipeline, not a revocation. Fix the run before reading anything into ⑥."
      break
    fi
    # Same caveat as ④, mirrored: a non-zero `--for=condition=Succeeded=false` is not
    # automatically "the run succeeded". Read the verdict instead of naming it.
    echo "attempt $i: $(run_verdict policy-exempt-runs "step6-attempt-$i")"
    # Expect Succeeded=True while the revocation has not landed. "still running" is a
    # timeout and "could not read" is a missing object or a broken connection -- none
    # of the three is a policy verdict.
    sleep 10
  done
  # Same rule as ④: running out of attempts is a result. Five consecutive successes
  # after the object is gone is not "slow" -- it means these runs were never being
  # exempted by that object, so ④'s pass was measuring something else.
  [ "$REVOCATION_LIVE" = yes ] || {
    echo "NOT CONFIRMED: the exception is gone, yet five attempts never came back"
    echo "CreateRunFailed (up to ~25 minutes of waiting, so not 'give it a moment')."
    echo "Read the per-attempt lines first: 'still running' is a timeout and proves"
    echo "nothing. Succeeded=True means re-read gate-param-contract -- rule Ready, and"
    echo "its namespace list still covering policy-exempt-runs. If both hold, then ④"
    echo "did not prove what it claimed."
  }
fi
```

**After a normal run of ⑥ the exception is already gone**; if the delete failed or the loop was skipped, it is still there — which is why the cleanup below is "confirm first, then decide whether to delete", not an unconditional catch-up delete. Whichever step you got to, the runs the six steps created are still sitting in the two namespaces — the cleanup's namespace deletion reclaims them by cascade.

A side note on why we do not fall back to the old practice of marking exemptions with a label: the label's **write paths** can indeed be protected — use policies to forbid business identities from setting the exemption label at CREATE, forbid injecting it via `taskRunSpecs`, forbid adding it on UPDATE, and let only the approver identity change it. But "the write paths can be protected" **is not the same as "a label may serve as the exemption match key"**: the match key must be something an attacker cannot reach at all, and a label's writable surface shifts with template capabilities (such as `taskRunSpecs`) — every new write path demands one more prohibition. So this document keeps the boundary at the controlled dedicated namespace, not at a label.

:::

#### Cleanup (§5.3)

Clean up per the two rules of [§4.0.4](#s4-0-4), but **in this section the order matters**. This section's leftovers are also more dangerous than other sections': a `PolicyException` natively has no TTL — forget to delete it and it is a permanent bypass.

:::warning Run this part even if you give up midway

If any of the six steps fails, or you decide to stop, **run this part to the end anyway** — it is safe for objects you never got to (what cannot be read is reported as unreadable; what was never created has nothing to delete). Stop midway without cleaning up and the cluster is left holding, all at once: `gate-param-contract` (Enforce — it keeps rejecting real pipelines), `exempt-namespace-approver-only` (Enforce), the approver identity's `Role` + `RoleBinding` (**able to sign exemptions = able to allow through**), and possibly an already-created `PolicyException` (**no TTL**). Not one of these four goes away on its own.

:::

**① First confirm the exemption is gone**. On the normal path step ⑥ already deleted it; and when `policy-exceptions` is the platform's pre-existing trusted namespace, step ④ below (deleting the namespaces) never reaches it — so confirm separately here, and delete if it is still there:

```bash
# The name comes from exemption-id.txt, written only by this walkthrough's own
# creates -- the approved one between ③ and ④, or step ①'s should-have-been-refused
# stray (its branch persists the name for exactly this moment). Its collision-freedom
# was checked before either create, so deleting by the file's content can only ever
# hit your own object. Nothing here deletes by a guessed name.
[ -z "${EXC_CREATED:-}" ] && [ -s exemption-id.txt ] && read -r EXC_CREATED < exemption-id.txt
if [ -z "${EXC_CREATED:-}" ]; then
  echo "no record of an exception created by this walkthrough (exemption-id.txt missing"
  echo "or empty) -- nothing to delete here. Still read the listing below."
else
  kubectl delete policyexception -n policy-exceptions "$EXC_CREATED" --ignore-not-found
fi
# Then LOOK: anything still listed is somebody's real approval -- leave it alone.
kubectl get policyexception -n policy-exceptions
# Expect no demo exception of yours in the output.
```

**② Revoke the approval grant** (the names carry the walkthrough id and belong to this run alone, so deleting by name is fine; RoleBinding first — revoke the grant before deleting the Role it points at):

```bash
# The name is derived, not random: the generation block built it from the walkthrough
# id, so a fresh shell that re-exported the id can rebuild it here without re-running
# that block.
if [ -z "${APPROVER_RBAC_NAME:-}" ] && [ -n "${WALKTHROUGH_ID:-}" ]; then
  APPROVER_RBAC_NAME=policy-exception-approver-$WALKTHROUGH_ID
fi
if [ -z "${APPROVER_RBAC_NAME:-}" ]; then
  echo "APPROVER_RBAC_NAME is unset and so is WALKTHROUGH_ID -- re-export the id §3.3"
  echo "printed, or find the name with:"
  echo "  kubectl get role -n policy-exceptions | grep policy-exception-approver-"
else
  kubectl delete rolebinding -n policy-exceptions "$APPROVER_RBAC_NAME" --ignore-not-found
  kubectl delete role -n policy-exceptions "$APPROVER_RBAC_NAME" --ignore-not-found
fi
# Prove the grant is gone rather than assume it: this must go back to `no`.
kubectl auth can-i create policyexceptions.kyverno.io -n policy-exceptions \
  --as="${APPROVER_IDENTITY:?set it again -- the cleanup may run in a fresh shell}"
```

**③ Only after the exemption and the grant are both confirmed gone, delete the entrance-lock policy** — the other way round opens a window in which the entrance lock is already gone while the exemption still exists:

```bash
# §4.0.4's look-before-delete for cluster-scoped objects: a creationTimestamp inside
# your walkthrough window is yours; anything older is somebody else's -- STOP and ask.
kubectl get clusterpolicy exempt-namespace-approver-only \
  -o jsonpath='{.metadata.creationTimestamp} {.metadata.name}{"\n"}'
kubectl delete clusterpolicy exempt-namespace-approver-only
```

**④ Delete the two namespaces**. Of the runs the six steps created, everything — including the failed attempts of ④ / ⑥ — is reclaimed by the cascade, except the step-⑤ run left in `policy-poc`; `policy-exceptions` carries the walkthrough label only when **this round created it** — one pre-created by the platform is never touched by this loop:

```bash
for ns in policy-exempt-runs policy-exceptions; do
  if ! json=$(kubectl get namespace "$ns" -o json 2>&1); then
    case "$json" in
      *NotFound*) echo "$ns: gone already -- nothing to do" ;;
      # Forbidden and a connection error must not read as "gone": an unreadable
      # namespace is not a deleted one.
      *) echo "$ns: could not be read -- $json"
         echo "  Left alone. Resolve the read error and run this loop again." ;;
    esac
    continue
  fi
  # jq's exit code too: a parse failure would produce an empty marker, and the branch
  # below would then report a labelling mistake that never happened.
  if ! marker=$(printf '%s' "$json" | jq -r '.metadata.labels."policy.alauda.io/walkthrough" // ""'); then
    echo "$ns: could not parse the namespace JSON -- left alone"
    continue
  fi
  if [ -n "${WALKTHROUGH_ID:-}" ] && [ "$marker" = "$WALKTHROUGH_ID" ]; then
    # The label check is the ownership evidence (§4.0.4): only a namespace THIS run
    # created and marked gets deleted, cascade and all.
    kubectl delete namespace "$ns"
  else
    # A pre-existing policy-exceptions legitimately carries no marker of ours, and
    # leaving it is the correct, finished outcome -- step ① already removed the demo
    # exception inside it.
    echo "$ns: label '${marker:-<none>}' is not this run's id '${WALKTHROUGH_ID:-<unset>}' -- left alone"
  fi
done
```

The step-⑤ run left in `policy-poc` belongs to the shared namespace of [§3.3](#s3-3) and is reclaimed with its final cleanup; to re-verify right away, delete it first: `kubectl delete pipelinerun -n policy-poc step5-normal-ns --ignore-not-found`.

**⑤ Re-check, then delete `gate-param-contract` last**. First run row ⑤ of the six-step table above once more — the violating run in the normal namespace must still end `CreateRunFailed`; the re-check is meaningful precisely because this policy is still installed — delete it first and all you have left is a run bound to "succeed", which proves nothing. Once the re-check passes:

```bash
# Installed by §4.2 or by this section's own create -- either way it is this
# document's demo policy. Same look-before-delete: a creationTimestamp you cannot
# place inside your own walkthrough means STOP and ask.
kubectl get clusterpolicy gate-param-contract \
  -o jsonpath='{.metadata.creationTimestamp} {.metadata.name}{"\n"}'
kubectl delete clusterpolicy gate-param-contract
```

The local state files left behind (`gate-snapshot.txt`, `step3-verdict.txt`, `step4-verdict.txt`, `step6-delete.txt`, `exemption-id.txt`, `*.err`) are untouched by the cluster cleanup — keeping them as evidence is your call; just delete them before the next walkthrough round starts (the reminder is at the top of this section).


## 6. FAQ and Troubleshooting {#s6}

### 6.1 Platform / project administrators (policy side) {#s6-1}

#### 6.1.1 The policy fails to install (rejected at creation) {#s6-1-1}

- **mutate-existing missing RBAC**: the error says the background-controller lacks update permission on the target resource. Kyverno validates the RBAC of mutate.targets at policy admission time — grant `update pipelineruns` per [§4.6](#s4-6).
- **Subresource + background conflict**: a validate rule matching `*/status` cannot carry `background: true` (result-type policies stay `background: false`).

#### 6.1.2 The policy installed but does not take effect {#s6-1-2}

Work through these in order:

```bash
# Is the policy Ready?
CLUSTER_POLICY_NAME=gate-param-contract
NAMESPACED_POLICY_NAME=project-pipeline-policy
NAMESPACED_POLICY_NAMESPACE=policy-poc
TARGET_NAMESPACE=policy-poc
kubectl get clusterpolicy "$CLUSTER_POLICY_NAME" \
  -o jsonpath='{.status.conditions}'
# A namespaced Policy must be queried in its own namespace
kubectl get policies.kyverno.io "$NAMESPACED_POLICY_NAME" \
  -n "$NAMESPACED_POLICY_NAMESPACE" -o jsonpath='{.status.conditions}'
# Does match hit? A subresource must be written as kind/subresource (tekton.dev/v1/TaskRun/status)
# Does namespaceSelector hit? Confirm the target namespace really carries the label
kubectl get ns "$TARGET_NAMESPACE" --show-labels
# Is there a matching PolicyReport entry? (aggregation lags by seconds to minutes)
kubectl get policyreport -n "$TARGET_NAMESPACE"
```

#### 6.1.3 Pinpointing a wrongful block {#s6-1-3}

Reproduce the blocked request with `--dry-run=server`, read the policy name / rule name in the deny message, then go back to that rule's preconditions and the values its context variables took. For JMESPath variables, observe the mutate result with `kubectl create --dry-run=server -o yaml`, or run the fixtures offline with the kyverno CLI ([§6.1.6](#s6-1-6)).

#### 6.1.4 ⚠️ Recognizing and clearing a wedged pipeline {#s6-1-4}

**Symptom**: the TaskRun / PipelineRun sits in `Running` and never ends, the Pod is already `Completed`, and the events keep repeating:

```text
Warning  UpdateFailed  taskrun/<name>  Failed to update status for "<name>": admission webhook "validate.kyverno.svc-fail" denied the request: ...
```

**Root cause**: some policy applied `Enforce` to a `*/status` subresource, blocking the Tekton controller's status write-back (the anti-mechanism of [§2.2](#s2-2)).

**Clearing it**: find the policy combining `Enforce` with a match on `*/status`, switch it to `Audit` or delete it; the controller retries on its current backoff schedule and writes the terminal state automatically — but do not phrase the recovery time as a fixed promise: usually within 1 minute, depending on the retry rhythm and load at the time. **The lasting fix**: result-type constraints always use Audit ([§4.4](#s4-4)) or mutate-existing ([§4.6](#s4-6)); never use Enforce on status.

#### 6.1.5 PolicyReport has no entries / lags behind {#s6-1-5}

- A background inventory requires the controller to be able to read the corresponding **main resource**; but a status Audit with `background: false` is aggregated through the admission report chain and does not require the reports-controller to get/list/watch `*/status` directly. If you see a permission warning, do the SubjectAccessReview correctly — the base resource plus `--subresource=status` — and judge by whether the real PolicyReport converges; the warning by itself is not sufficient evidence that "the feature is missing RBAC". Status policies must be `background: false`; there is no background-rescan backstop for status.
- PolicyReport aggregation lags; for a run that just finished, wait a moment before querying.

#### 6.1.6 Offline testing with the kyverno CLI, and its limits {#s6-1-6}

**This section requires the `kyverno` command line installed locally** (the tool verification in [§3.1](#s3-1) prints whether it is present) — it is a different thing from the Kyverno running in the cluster; having it installed in the cluster does not mean the command exists on your machine. If you don't have it, skip this section; no other step on the walkthrough path depends on it.

```bash
POLICY_FILE=./policy.yaml
FIXTURE_FILE=./fixture.yaml
kyverno apply "$POLICY_FILE" --resource "$FIXTURE_FILE"
```

Good for verifying JMESPath / preconditions / deny logic (especially useful on already-expanded TaskRun fixtures). **Limits**: `request.userInfo` **can** be fed a hand-built identity via `-u/--userinfo` (username / groups / clusterRoles all reach the expressions), but the CLI **takes whatever you give it on faith — it performs no real authentication or authorization** — so you can regression-test the decision logic of identity policies offline, but you cannot verify "what identity this person actually holds in the cluster"; `context.apiCall` (the anti-forgery checks) errors out immediately offline, and the real timing of `*/status` subresource updates and the actual patch of mutate-existing must all be verified end to end in the cluster.

#### 6.1.7 Common JMESPath traps {#s6-1-7}

- A variable may not exist: always add a `|| ''` / `|| \`[]\`` fallback, otherwise "Unknown key" turns the rule into an error;
- Call `to_number()` before numeric comparison; parse strings with `split(x, ';')`;
- Quote escaping: when a label name contains `/` or `.`, write `request.object.metadata.labels."policy.alauda.io/exemption"`; where identity decisions are involved, still confirm first whether that label can be forged by business input;
- ⚠️ **The pipe `|` binds looser than `||`; when writing "either of two shapes", you must add parentheses**. Trying to accept both the in-cluster shape (`taskRef.name`) and the resolver shape (the name sitting in `taskRef.params`), it is easy to write:

  ```text
  spec.taskRef.name || (spec.taskRef.params || `[]`)[?name=='name'].value | [0] || ''
  ```

  It actually parses as `(A || B) | ([0] || '')`: in the in-cluster shape `A` is a **string**, taking `[0]` of a string yields `null`, and the whole expression falls through to `''` — **the very half it was meant to accept gets scored as empty and the rule silently skips (fail-open)**. The resolver shape works fine, so testing only hub references will never surface it. The correct form **locks the pipe inside parentheses**, scoped to the list side only:

  ```text
  spec.taskRef.name || ((spec.taskRef.params || `[]`)[?name=='name'].value | [0]) || ''
  ```

  **Keep the criterion precise — do not overgeneralize.** The **only** case that needs parentheses is "a top-level `||` to the left of the pipe": there, `||` first merges a **string** with a **list**, then `[0]` is applied to the result, and indexing a string yields `null`.

  Conversely, the trailing form `list-expression | [0] || 'fallback-value'` **is already correct as far as parentheses go — do not add any**: no top-level `||` sits to the left of the pipe; `|| 'fallback-value'` belongs to the pipe's right side and acts on the extracted element, falling back normally when the list is empty.

  **But "the parentheses are right" does not mean "reading the value this way is safe".** `[0]` takes only the first item of the filtered result, so it is usable only when **the list being read carries a uniqueness guarantee**:

  - `spec.params` / `pipelineRef.params` / `spec.workspaces` — **`[0]` is fine**: Tekton's validation webhook itself rejects duplicate names (the exact error text is in [§4.2.5](#s4-2-5)).
  - `status.results` / `status.conditions` / `status.skippedTasks` / `status.pipelineSpec.tasks` — **never use `[0]`**: these lists are written by controllers, and the CRD imposes no uniqueness constraint whatsoever (`conditions` and `pipelineSpec.tasks` are bare arrays; `results` and `skippedTasks` are `x-kubernetes-list-type: atomic` — which means "replace as a whole", **not** "dedupe by key"), so at admission a duplicate-named entry can appear twice. **Inserting a `Succeeded=Unknown` in front of the real condition, a clean same-named result in front of the real result, a same-named skip with a legitimate reason in front of the real skip record, or a compliant same-named task in front of the hollowed-out gate task — any of these bypasses a policy that copy-pastes `[0]`** (construction, A/B evidence, and the fix in [§4.4.1](#s4-4-1), [§4.1.4](#s4-1-4), [§4.1.5](#s4-1-5)).
  - **The tell for the criterion**: check `x-kubernetes-list-type` — only `map` gets per-key uniqueness guaranteed by the API server; `atomic` and a bare array that omits the field have **no** uniqueness guarantee. Before writing a new policy that reads `status`, run `kubectl get crd <name> -o yaml` first and check which kind the list you are about to read belongs to.
  - **How to wire the count in depends on whether `deny.conditions` uses `any` or `all`**: under `any` the count can be added as an independent condition; **under `all` it absolutely must not be** — adding another `all` condition **loosens** the criterion; the count must be folded into the boolean variable itself (this document's [§4.1.4](#s4-1-4) / [§4.6.2](#s4-6-2) use `all`, with the count folded into `scanIdentityValid`).

  So do not write the terminal-state criterion as `contains(['True','False'], (…)[?type=='Succeeded'].status | [0] || 'Unknown')`; count entries instead: `length((…)[?type=='Succeeded' && (status=='True' || status=='False')]) > \`0\``; and when reading a result, likewise pair it with a guard that "the target result may only appear once".

  The one-line criterion: **look for a top-level `||` to the left of the pipe** — parenthesize only if it is there; otherwise leave it alone.
- ⚠️ **Kyverno's comparison operators type-coerce "number-looking strings"** — `NotEquals value: "false"` gives the wrong verdict on `"1"` (treating `"1"` as a number, the comparison against the string `"false"` returns "equal" instead of denying). **For exact string checks, compute the boolean in JMESPath** (e.g. `contains(['', ' '], x)`, or `x != 'false'` evaluated to true/false via `variable.jmesPath`), then trigger the deny with `Equals true` — sidestepping the operator coercion. This document uses that pattern in [§4.2.3](#s4-2-3) / [§4.2.5](#s4-2-5) / [§4.5.1](#s4-5-1) / [§4.5.2](#s4-5-2) / [§4.5.5](#s4-5-5).

#### 6.1.8 Observing the control plane {#s6-1-8}

```bash
kubectl logs -n kyverno deploy/kyverno-admission-controller     # admission decisions
kubectl logs -n kyverno deploy/kyverno-background-controller    # mutate-existing / background scan
kubectl get validatingwebhookconfiguration -o custom-columns=\
'NAME:.metadata.name,FAIL:.webhooks[*].failurePolicy' | grep kyverno   # failure policy
```

`failurePolicy: Fail` = reject the relevant requests while Kyverno is unavailable (safety first — but with too few controller replicas, or inside a rolling-update window, requests may be briefly rejected; Tekton retries); `Ignore` = allow them through (availability first, at the cost of a brief policy vacuum). **The actual value is whatever the webhook configuration in your target ACP environment says** (do not assume a fixed default), and plan controller replica count and HA accordingly (production should not sit on a single replica for long).

### 6.2 Pipeline users (whose runs are blocked) {#s6-2}

#### 6.2.1 How to read a denial message {#s6-2-1}

The admission error reported by `kubectl` / the UI directly contains: `<policy name>: <rule name>: <custom message>`. The message usually spells out the requirement (e.g. "threshold must be ≥ 50, got 10").

#### 6.2.2 What should I change {#s6-2-2}

- Template-type denial ([§4.1](#s4-1)): switch to an approved template reference shape (one of the cluster/hub/git channels, version pinned);
- Parameter-type denial ([§4.2](#s4-2)): change the gate parameters back to compliant values (do not turn off the scan, do not lower the threshold). **A special reminder on [§4.2.4](#s4-2-4): what it blocks is "the analysis of a protected branch had its quality-gate switch explicitly turned off"; the right move is to set `enableScanQualityGate` / `enableAnalyzeQualityGate` back to `"true"` or simply not pass them (inheriting the trusted defaults) — never to go change the branch parameter**; builds on PR / feature branches were never blocked by this rule in the first place, whereas changing `sonarBranchName` to `main` is exactly what would run into it;
- If a temporary bypass is genuinely needed: go through the PolicyException approval flow ([§5.3](#s5-3)) and have the approving identity create the run in the controlled execution namespace; do not change labels yourself or walk into that namespace directly.

**Match on the field names in the message** (one rule often validates several fields at once, so identify the field first — don't guess):

| Field appearing in the message | What to change |
|---|---|
| `pipelineRef` / `resolver` / `catalog` / `version` / `pathInRepo` | The template reference shape ([§4.1.1](#s4-1-1)) — note that the `url` parameter is itself forbidden; do not add one |
| `enableScanQualityGate` / `enableAnalyzeQualityGate` / `skipTrivyScan` / `trivyExtraArgs` / threshold-type parameters | Gate switches and thresholds ([§4.2.1](#s4-2-1) / [§4.2.5](#s4-2-5)); restore the template defaults |
| `request-level 'url' present` / `'type' param count` / `'type' value` | **Not a branch problem**: the scan Task's reference source was tampered with. Each of the three counts in the message maps to one spot in `taskRef.params` — delete the request-level `url`, collapse the duplicated `type` down to one, and `type` may only be `artifact` or simply absent ([§4.2.4](#s4-2-4) rule ①) |
| `protected branch '...'` | This run's **effective analysis branch** is a protected branch and a gate switch was explicitly altered — restore the switch to `"true"` or drop the explicit override ([§4.2.4](#s4-2-4) rule ②). **Note the value in the message may carry a `sonar.branch.name=` prefix**: that means the branch came not from the `sonarBranchName` parameter but from that injected line inside `sonarProperties` — and that line is what you need to fix |
| `base claims=N` / `key claims=M` (in the PolicyReport) | The PR analysis declarations are off ([§4.2.4](#s4-2-4) rule ③; Audit does not block the request): either count not equal to 1 means `sonar.pullrequest.base` / `.key` is duplicated or smuggled in; when both are 1, look at the gate-switch value in the same message |
| `srcImage` / `mappings` / registry prefixes | Artifact source ([§4.5.1](#s4-5-1)) or run image ([§4.5.3](#s4-5-3)) — the message lists **the specific image** |
| namespace / Secret / ServiceAccount names | Release target ([§4.5.5](#s4-5-5)); these allowlists are platform-maintained — ask the platform for the currently approved values |
| `ownerReference` / controller identity | You are hand-creating a bare `TaskRun` / `CustomRun` ([§4.5.4](#s4-5-4)) — submit a PipelineRun instead |

**Pod-level denials (`PodCreationFailed`) take one extra step**: that message hangs on the TaskRun's condition — find it with `kubectl describe taskrun <name>` first; the message lists **the non-compliant images** (the `badImages` of [§4.5.3](#s4-5-3)); the approved-prefix list is not in the message — ask the platform when you need it.

⚠️ **`--dry-run=server` is not necessarily a self-test you can run**: what [§3.4](#s3-4) gives is a verification method for **policy maintainers**, and it is still an API request carrying the `create` verb — someone holding only `get` / `describe` permissions cannot run it. Without `create` permission on the resource, hand the error message and the fixed manifest to the platform / pipeline-governance owner to run on your behalf, or use the product-side pre-check entry (out of scope for this document; see the "orchestration-time 'applicable-policy preview'" row in [§7.1](#s7-1)).

#### 6.2.3 Why was my pipeline auto-cancelled {#s6-2-3}

If the run turned `Cancelled` and it was not your doing, some policy chose "cancel" rather than "deny". **A terminal state other than `Cancelled` can still be a policy cancellation**: when the gate task itself fails first, Tekton's failure verdict outranks the cancellation — the run's terminal state is `Failed`, yet `spec.status` has already been written to `CancelledRunFinally` (see [§4.6.1](#s4-6-1)) — so when you see `Failed` with a non-empty `spec.status`, work through the same table below. **Note that `spec.status` only proves "a cancellation was requested", not who requested it** (a manual cancel writes the very same field): calling it a policy cancellation requires the markers in the table below; if no marker can be found, it can only be recorded as origin unknown. **Four paths in this document produce `Cancelled`, and each stores its evidence in a different place** — check in the order below; the first hit is the cause (for how the four differ mechanically — when it is detected, what gets touched, synchronous or asynchronous — see the summary table in the [§4.6](#s4-6) introduction):

| Check order | Origin | Trigger | Where to find the evidence |
|---|---|---|---|
| 1 | [§4.2.3](#s4-2-3) admission mutate cancelling the gate TaskRun | Gate switch / threshold parameters non-compliant | That gate TaskRun's `spec.statusMessage` and terminal condition message — **the full reason lives here**; the easiest to recognize |
| 2 | [§4.2.2](#s4-2-2) mutate-existing cancelling the parent run | Same as above, just in the cancel-the-parent-run shape | The parent PipelineRun's `cancel-reason` annotation |
| 3 | [§4.6.2](#s4-6-2) definition-drift self-cancellation | The resolved pipeline definition does not match the approved identity | The parent PipelineRun's `cancel-reason` annotation (the text states it is drift) |
| 4 | [§4.6.1](#s4-6-1) result-triggered cancellation | Results below the bar (coverage / vulnerability count, etc.); **a missing or malformed result triggers it just the same** (fail-closed — in that case the value in the annotation may be empty) | The parent PipelineRun's `cancel-reason` annotation (the text names the triggering TaskRun and the out-of-bounds value, e.g. `coverage-lines='30'`) + that result itself; with the companion Audit rule deployed, the PolicyReport also holds a fail record |

Troubleshoot in exactly that order: **first look for a TaskRun carrying a `statusMessage`** (if one exists, it is shape 1), **then read the text of the parent run's `cancel-reason` annotation** (shapes 2 / 3 / 4 all write this annotation; the text tells them apart: gate parameters / definition drift / result out of bounds).

⚠️ **All of this presumes the policy actually wrote the markers**: `cancel-reason` is something the policy **writes into the object itself** when cancelling — not a field Tekton provides. If, when copying the policies, you dropped that `metadata.annotations` block (all four cancellation policies in this document carry it), then afterwards **nothing can distinguish "policy cancellation" from "someone cancelled it by hand"** — the `Cancelled` terminal state is exactly identical in both cases. All you can do then is **infer** from "some result is clearly out of bounds" — and inference is not evidence; in an audit context it can only be recorded as "cause unknown" ([§4.0.6](#s4-0-6), [§4.4.4](#s4-4-4)).

The commands below pull the evidence:

```bash
PIPELINERUN=cancel-low-coverage-demo
NAMESPACE=policy-poc
run_uid=$(kubectl get pipelinerun "$PIPELINERUN" -n "$NAMESPACE" \
  -o jsonpath='{.metadata.uid}')
kubectl get events -n "$NAMESPACE" \
  --field-selector involvedObject.uid="$run_uid"
# First find which child TaskRuns have a fail/warn/error summary, then expand the
# matching policy/rule/message.
kubectl get pipelinerun "$PIPELINERUN" -n "$NAMESPACE" \
  -o jsonpath='{range .status.childReferences[?(@.kind=="TaskRun")]}{.name}{"\n"}{end}' | \
while IFS= read -r taskrun; do
  taskrun_uid=$(kubectl get taskrun "$taskrun" -n "$NAMESPACE" \
    -o jsonpath='{.metadata.uid}')
  kubectl get policyreport -n "$NAMESPACE" -o json | jq -r \
    --arg taskrun "$taskrun" --arg taskrun_uid "$taskrun_uid" '
    .items[]
    | select(.scope.kind == "TaskRun" and .scope.uid == $taskrun_uid)
    | .results[]
    | select(.result == "fail" or .result == "warn" or .result == "error")
    | [$taskrun, .policy, .rule, .result, .message]
    | @tsv'
done
```

> ⚠️ **Traceability prerequisite**: the [§4.6](#s4-6) cancellation is a pure mutate-existing rule — it **produces no** "below the bar" PolicyReport record of its own. So to make "why was it cancelled" traceable, you must **also deploy the corresponding [§4.4](#s4-4) Audit policy** (recording the result verdict that triggered the cancellation into the PolicyReport), or have the cancellation write a controlled annotation / event onto the parent run recording the triggering policy and evidence. Install only the cancellation rule without the Audit, and the PolicyReport holds no cancellation cause to be found.

> ⚠️ **This section is "troubleshooting", not "audit"**: every command above presumes **the objects are still alive**. The `cancel-reason` annotation, `spec.statusMessage`, Events, and PolicyReports all hang off the PipelineRun / TaskRun — the moment the objects are cleaned up, everything vanishes with them. **It is not "found but untrustworthy"; it is simply not findable.** Nor does this document provide any entry point for "spot-checking historical releases by time window": in-cluster PolicyReports are reclaimed along with their objects — they are not a historical archive. For a real quarterly spot check, first run the "oldest record" command in [§4.4.4](#s4-4-4) to learn how far back the in-cluster evidence actually reaches; releases older than that can only be looked up in your external archive, keyed by the PipelineRun UID archived at the time.

## 7. Migrating from the Legacy Pipeline Policy {#s7}

The v3 platform-engineering pipeline policy acted on the proprietary resource model of its day (Build / Delivery, etc.); the v4 policies act on native Tekton `PipelineRun` / `TaskRun` / `Pod` — **the two generations' resource models are entirely different, so this chapter does not map resource fields one to one; it only answers "does each legacy governance capability have an equivalent in the new scheme"**. The right way to migrate: rebuild equivalent constraints with the new mechanisms, scenario by scenario per [§4](#s4) — do not attempt a field-by-field transcription.

### 7.1 Capability equivalence table {#s7-1}

Legend: ✅ capability equivalent; 🟡 an equivalent implementation exists, but with preconditions / different semantics; 🔴 lossy — supplementary notes required.

| Legacy governance capability | v4 equivalent | Degree |
|---|---|---|
| Mandate official / designated pipeline templates | [§4.1.1](#s4-1-1) template allowlist (cluster / hub / git channels, version pinned) | 🟡 Identity-equivalent; content assurance follows the three tiers of strength in [§2.1](#s2-1) — in-cluster definitions strongest, remote references need external governance to fill the gap |
| Template must carry a designated marker / must contain a certain class of task | Change permission on in-cluster definitions closed off via RBAC ([§4.1.2](#s4-1-2)) + the [§4.1.4](#s4-1-4) `status.pipelineSpec` Audit | 🟡 In-cluster definitions rely on RBAC to lock write permission; remote references get only after-the-fact Audit depth + reliance on external template governance |
| Template must come from a designated git source | [§4.1.1](#s4-1-1) git-channel allowlist (pinned commit SHA) | 🟡 Only a pinned SHA locks content; content constraints on branch/tag must be filled in by repository permission controls |
| Quality gate (coverage / vulnerability threshold) — miss the bar, fail the run | [§2.3](#s2-3) gate task `exit 1` ([§4.3](#s4-3)) + the [§4.2](#s4-2) parameter contract guaranteeing the gate was not switched off | 🟡 Both schemes decide only after the scan results exist; what changes is **who decides and what the failure looks like** — the legacy engine evaluated result snapshots in the platform controller and cancelled the underlying run **immediately** (an explicit platform ruling), whereas here it is an in-DAG gate-task failure / DAG-skip, and the failure shape is a task failure (use [§4.3](#s4-3) to tell it from an ordinary one) |
| No coverage regression + restricted to target branches | [§4.3](#s4-3) absolute coverage floor + [§4.2.4](#s4-2-4) protected-branch gate contract (TaskRun level) | 🟡 Only the absolute coverage threshold is implemented today; **no-regression against a baseline (coverage delta) is not yet implemented**. The gate on protected-branch analysis can be nailed down (`sonarBranchName` anchored), but the **PR-stage gate is best-effort only** (`sonar.pullrequest.base` is a user-supplied parameter — fail-open, Audit; see [§4.2.4](#s4-2-4) rule ③ and "parameter mapping of the platform trigger chain") |
| Gate switches must not be turned off by business teams | [§4.2.1](#s4-2-1) main path (effective values at the TaskRun level) + [§4.2.5](#s4-2-5) auxiliary path (early blocking at the PipelineRun level) | 🟡 The validation site costs template authors zero changes; but the recognition contract (which task alias, which parameter name) must be configured per template version |
| Artifact source allowlist | [§4.5.1](#s4-5-1) copy-task parameter allowlist | 🟡 Covers the parameter entry of the designated copy task; only unbypassable when combined with the [§4.5.4](#s4-5-4) entry closure |
| Run-image registry / integrity constraints | [§4.5.3](#s4-5-3) Pod-level image allowlist + verifyImages (companion document) | ✅ The Pod level is the reliable blocking point for the images that actually run (the legacy scheme usually could not reach this layer) |
| Release-target allowlist | [§4.5.5](#s4-5-5) target-ns parameter + kubeconfig secret allowlist | 🟡 Governable along the namespace dimension; the target "cluster" dimension can only be governed indirectly through the kubeconfig secret |
| Per-project / per-namespace differentiated constraints | [§1.3](#s1-3) / [§5.2](#s5-2) two-tier governance (negative-exclude baseline + positive per-project tightening) | ✅ And it adds the negative-coverage semantics of "an unclassified namespace necessarily falls under the baseline" |
| Turning report-style checks into numeric gates (e.g. lint counts) | The [§2.4](#s2-4) extension model: a custom task emits declarative results + [§4.3](#s4-3)/[§4.4](#s4-4) | 🟡 The check task needs a data contract added (result retrofit) |
| Artifact attributes (label / env / tag) | [§4.5.2](#s4-5-2) `context.imageRegistry` reads `Labels` / `Env` from the source image's config; the tag lives in the image reference string, judged by the [§4.5.1](#s4-5-1) parameter allowlist | 🟡 Can only read images that **already exist at admission time** (validates the source, not the target artifact this very run is about to produce); and it puts external network calls on the admission path (the four limits in [§4.5.2](#s4-5-2)) |
| Rule expressions (the legacy scheme evaluated event snapshots) | Kyverno `match` + `preconditions` + JMESPath, evaluated on the **admission request object**; run-result criteria move to reading `*/status` ([§4.4](#s4-4)) | 🟡 The visible fields changed: you only see fields genuinely present in the request — an unbound parameter **does not appear** in the request, and an explicit empty string ≠ absence (handling principle: "parameter absence must fail closed" in [§4.2.1](#s4-2-1)); derived fields from the event snapshot have no counterpart; cross-object information must be looked up live with `context.apiCall` ([§4.2.1](#s4-2-1)) |
| Evaluation records and visualization | PolicyReport ([§4.4](#s4-4)) | 🟡 Recording capability is equivalent; but **reports are GC'd along with the evaluated object, carry no TTL / retention semantics, and Enforce-denied requests leave no report at all** (the [§4.4.4](#s4-4-4) boundary) — long-term retention requires external collection, and **more than reports must be collected**: proving "this release went through the gate" needs four kinds archived together — PipelineRun / gate TaskRun terminal states and results, PolicyReports, Events, and admission denial messages (threaded by run UID; the warning in [§4.4.4](#s4-4-4)). User-facing visualization needs product-side wiring |
| Distributing policies to multiple clusters | **No corresponding mechanism**: `ClusterPolicy` / `Policy` are both **per-cluster objects** and must be installed cluster by cluster (GitOps or platform-module distribution) | 🔴 A new cluster starts with zero policies, and this "policy vacuum" is invisible from the old clusters — see the new-cluster row in [§3.6](#s3-6) |
| Orchestration-time "applicable-policy preview" | **No equivalent**: `--dry-run=server` only answers "will this one request be denied"; it does not list "which policies would hit" | 🔴 Pipeline users still see the denial message only at run creation; orchestration-time hints must be wired separately on the product side |
| Staged lifecycle evaluation (multi-phase gating) | Taken over in layers across three moments: admission (definition / parameters) + execution (gate task) + after the fact (Audit / cancellation) | 🔴 No unified "phase" abstraction; reimplemented in layers along the lifecycle observation points ([§2.1](#s2-1)) — weakened semantics |

### 7.2 Capabilities new to this scheme (absent from the legacy one; not migration items) {#s7-2}

The following capabilities come naturally with the native resource model plus Kyverno; the legacy scheme did not have them, and they are listed as the net gains of migrating:

- **Entry identity constraints** ([§4.5.4](#s4-5-4) `request.userInfo`): distinguishing the PAC bot / humans / platform automation;
- **Run-image source constraints** ([§4.5.3](#s4-5-3) Pod level): what gets judged is **the registry prefix of the image that actually executes** (the legacy scheme usually could not reach the Pod layer); the same layer could also constrain `securityContext` / digest / signatures, but **this document does not ship those policies**;
- **Injecting defaults** ([§4.2.6](#s4-2-6) mutate): uniform timeouts / labels / SA;
- **Controlled exemption** ([§5.3](#s5-3) PolicyException): auditable, RBAC-governed temporary allowance;
- **Inventorying pre-existing resources** ([§4.4.4](#s4-4-4) background Audit): scan the current state before policies take effect;
- **Staged policy rollout** ([§3.5](#s3-5) Audit→Enforce): observe first, enforce later.

### 7.3 Supplementary notes on the lossy items (🔴 / key 🟡) {#s7-3}

- **Staged evaluation (🔴)**: if the legacy scheme had "gate orchestration advancing phase by phase", v4 has no first-class abstraction for it. Mitigation: decompose the phases across the three moments — definition / parameters at admission ([§4.1](#s4-1)/[§4.2](#s4-2)), the quality gate in the pipeline's gate task ([§4.3](#s4-3)), result verification and response after the fact ([§4.4](#s4-4)/[§4.6](#s4-6)); and use the [§2.3](#s2-3) contracts to guarantee the three layers combined cannot be bypassed.
- **Quality-gate semantics change (🟡)**: the deciding party moves from the platform controller into the DAG. The legacy engine likewise judged only after the scan results existed (rule evaluation over result snapshots), but the verdict happened **outside the pipeline**, and a violation made the controller cancel the underlying run **immediately** — an explicit platform ruling; here the verdict is an in-DAG gate-task failure, or an after-the-fact cancellation ([§4.6](#s4-6), Kyverno mutate-existing, **asynchronous, seconds-level**), and the failure shape is a task failure — use [§4.3](#s4-3) to tell it from an ordinary one. Side effects of earlier or parallel tasks that already started are not rolled back under either scheme ([§2.3](#s2-3) contract 5). Mitigation: in template design, order every side effect after the gate (DAG dominance), and layer on [§4.6](#s4-6) early cancellation when necessary.
- **Multi-cluster distribution (🔴)**: in the legacy scheme a platform sync component pushed the rules down to each workload cluster; v4 has no such layer — a Kyverno policy object exists only in the cluster it lives in. Mitigation: treat the policies as **cluster baseline configuration** under GitOps / platform-module management; add a step to the new-cluster onboarding flow — "install the minimal set + run the positive/negative probes" (the new-cluster row in [§3.6](#s3-6)) — and periodically compare the `kubectl get clusterpolicy` inventories across clusters, so no cluster quietly falls behind.
- **Orchestration-time applicable-policy preview (🔴)**: the legacy scheme could list "which policies would hit" before the pipeline ever ran; v4 has no equivalent API. Mitigation: make the "how to read the message when blocked" of [§6.2](#s6-2) the first entry point for pipeline users; where up-front hints are needed, have the product side build front-end hints against **known template profiles** — do not expect Kyverno to produce an applicability list.
- **Remote template content assurance (🟡)**: under hub / git references, Kyverno can only lock identity; trust in the content comes from external governance. Mitigation: prefer the in-cluster template namespace ([§4.1.2](#s4-1-2): change permission closed off via RBAC); for remote references, always pin immutable versions + rely on catalog / repository release governance + the [§4.1.4](#s4-1-4) drift Audit.

## 8. Conclusion {#s8}

### 8.1 Decision tree: I want to block something — which mechanism do I use {#s8-1}

```text
The thing you want to constrain
├─ Which pipeline template is used ………………… PipelineRun CREATE + allowlist (§4.1.1)
├─ The template definition's own content / change permission … change permission on in-cluster definitions closed off via RBAC (§4.1.2); remote references get after-the-fact Audit only (§4.1.4)
├─ Gate switches / thresholds / protected-branch gate … gate TaskRun CREATE expanded parameters (§4.2.1 switches and thresholds / §4.2.4 protected-branch gate, main path); if the template exposes them, block early at PipelineRun CREATE (§4.2.5)
├─ Fail when quality results miss the bar ………… in-pipeline gate task exit 1 (§4.3) — not Kyverno's job
├─ Gate skipped / opted out (when/matrix) ……… PipelineRun/status `skippedTasks` Audit (§4.1.5)
├─ Quality-result visibility / inventory ………… TaskRun/status Audit + PolicyReport (§4.4)
├─ Artifact sources ………………………………… copy-task parameter allowlist (§4.5.1)
├─ The images that actually run ……………………… Pod CREATE + plain UPDATE + `Pod/ephemeralcontainers` UPDATE allowlist / signatures (§4.5.3 + companion document)
├─ Closing the bare Tekton Run entrances ……… TaskRun/CustomRun entry closure (§4.5.4) + RBAC convergence on Pod/Job/Deployment and deployment credentials
├─ Release targets …………………………………… deployment parameters on official PipelineRun CREATE + kubeconfig workspace allowlist (§4.5.5)
├─ Cancel a running run on substandard results … TaskRun/status → mutate-existing cancellation (§4.6, supplementary measure)
└─ Per-project differentiation ………………………… platform-managed: ClusterPolicy + selector; project self-service: namespaced Policy (§5.2)
```

To close in one sentence: **hard gates are failures manufactured by the gate task inside the pipeline; Kyverno's value is making sure that gate "is definitely there, its parameters cannot be switched off, sources and targets stay within policy, and the bare Tekton Run entrances are sealed" — plus providing audit and controlled cancellation.** Two boundaries must be stated together: ① "the pipeline cannot be bypassed" is **Kyverno + RBAC combined** — Kyverno seals bare Tekton Runs, RBAC converges direct permissions on Pod/Job/Deployment and the deployment credentials; neither alone suffices; ② what Kyverno guarantees is "the gate is there and its parameters are not off"; **whether it truly dominates the release depends on the trusted template's DAG** (for example, in the official java 0.3 template `deploy-or-upgrade` is ordered after `trivy-scanner` but not after `sonarqube-scanner`; the two templates' shapes are contrasted in [§4.3](#s4-3)). Never block `*/status` with Enforce (wedge); result-type constraints are always Audit or cancellation.

### 8.2 References {#s8-2}

- Kyverno official documentation: the scopes of `ClusterPolicy` and namespaced `Policy` — https://kyverno.io/docs/policy-types/cluster-policy/overview/
- Kyverno official documentation: mutate-existing, PolicyException, JMESPath — https://kyverno.io/docs/introduction/
- Tekton Pipelines: resolvers, results, `spec.status` cancellation semantics — https://tekton.dev/docs/
- The parameter and results contract of `sonarqube-scanner` 0.7: **the version actually installed in your environment is authoritative**. A Hub-provided Task is not a Kubernetes resource in the cluster (`kubectl` cannot fetch it); view it in the ACP console: in the left navigation, **Pipelines → Tasks**, locate the target Task in the list by its `Source` column (`catalog` / `Hub`) and open its detail page to see the parameters and results that version declares. Field names in policies must align with the real contract shown on that page; the contract matrix for the profiles used in this document is in [§3.2](#s3-2).
- ACP 4.3 Compliance Management (Kyverno plugin) installation: https://docs.alauda.io/container_platform/4.3/security/security_and_compliance/compliance/install.html
- ACP 4.3 Kyverno use cases: https://docs.alauda.io/container_platform/4.3/security/security_and_compliance/compliance/howto/kyverno_use_cases.html
- Alauda DevOps Pipelines installation and `TektonConfig`: https://docs.alauda.io/alauda-devops-pipelines/4.14/install.html
- Kyverno official PolicyException: https://kyverno.io/docs/guides/exceptions/
- Kyverno official mutate-existing: https://kyverno.io/docs/policy-types/cluster-policy/mutate/

> Image signing / attestation (verifyImages) and deploy-side supply-chain verification are out of scope for this document — see the companion document [Software Supply Chain Security of Alauda Container Platform with Tekton and Kyverno](./Software_Supply_Chain_Security_of_Alauda_Container_Platform_with_Tekton_and_Kyverno.md); Kyverno official verifyImages documentation: https://kyverno.io/docs/policy-types/cluster-policy/verify-images/overview/
