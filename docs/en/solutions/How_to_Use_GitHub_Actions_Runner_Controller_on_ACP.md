---
products:
   - Alauda Container Platform
kind:
   - Solution
---

# Deploying GitHub Actions Self-Hosted Runners on Alauda Container Platform with ARC

## Overview

GitHub Actions runs workflows on GitHub-hosted runners by default. Those runners
live on the public internet and cannot reach your internal services.
**Self-hosted runners** let you run workflows inside your own cluster, so jobs
can use cluster compute, access internal resources, and execute in air-gapped
environments. Each workflow trigger spawns an ephemeral runner pod in the
cluster that is destroyed when the job completes. When the workflow uses the
`container:` field, ARC uses runner-container-hooks to spin up the
corresponding job pod / Kubernetes job in the runner namespace; when DinD mode
is enabled, the runner pod itself carries the DinD sidecar / init container.

This document describes how to deploy and use GitHub Actions self-hosted
runners on Alauda Container Platform (ACP). The implementation is based on
GitHub's upstream Actions Runner Controller (ARC) project, which Alauda
repackages as two ACP cluster plugins:

- **Alauda Support for GitHub Actions Runner Controller** (referred to below
  as the **controller plugin**) — the ARC control plane. Install once per ACP
  cluster.
- **Alauda Support for GitHub Actions Runner Scale Set** (referred to below as
  the **scale-set plugin**) — provides one set of self-hosted runners bound to
  a GitHub organization or repository. **The ACP cluster-plugin entry only
  supports a single default instance per cluster**; for multiple isolated
  runner pools on the same cluster, install additional copies of the
  upstream `gha-runner-scale-set` chart through the platform's
  **Catalog → Helm Chart** entry (still inside the ACP UI; **no `helm`
  CLI required**). See
  [Chapter 4. Multi-Team / Multi-Project Isolation](#chapter-4-multi-team--multi-project-isolation),
  Method 3.

Both plugins ship the **scale-set mode** of ARC only (not the legacy
runner-deployment mode). The rationale is in
[Why scale-set mode (not legacy)](#why-scale-set-mode-not-legacy).

### What this document covers

- Installing both plugins and verifying first workflow ([Chapter 1](#chapter-1-installing-the-controller-plugin)
  through [Chapter 2](#chapter-2-installing-the-scale-set-plugin)) — new users
  can complete the first deployment by reading this section alone.
- The runner image: pre-installed CLI tools, runtime identity, third-party
  action handling. See [The runner image](#the-runner-image).
- Advanced customization through Extra Values — ServiceAccount, resource
  limits, PVC cache, DinD mode, custom images, and more. See
  [Chapter 3](#chapter-3-customizing-runners-via-extra-values).
- Multi-team / multi-project isolation strategies. See
  [Chapter 4](#chapter-4-multi-team--multi-project-isolation).
- Workflow examples: running jobs in custom containers, triggering an
  in-cluster Tekton Pipeline, and building images with Buildah in
  daemonless mode (still privileged).
  See [Chapter 5](#chapter-5-workflow-examples).
- Troubleshooting and uninstall. See [Chapter 6](#chapter-6-troubleshooting)
  and [Chapter 7](#chapter-7-uninstall).

### Two plugins at a glance

| Plugin | Purpose | Default install namespace | Multiple instances per cluster |
|---|---|---|---|
| Controller plugin | Hosts the ARC control plane (controller deployment, CRDs) | `arc-systems` | No |
| Scale-set plugin | Defines one runner scale-set bound to a GitHub org / repo | `arc-runners` | No via the cluster-plugin entry; yes via **Catalog → Helm Chart** with the upstream chart (see Chapter 4 Method 3) |

### Applicability

| Item | Current baseline |
|---|---|
| Upstream ARC version | `gha-runner-scale-set-0.14.1` (chart values reference links are pinned to this tag) |
| Alauda cluster plugin version | The Alauda packaging tracking upstream 0.14.1; the exact version number is shown on the plugin detail page in the ACP Marketplace |
| Validated GitHub form factors | Verified against the public `github.com` only. GitHub Enterprise Cloud shares the same registration endpoint and is **theoretically supported** but not separately validated in this document; GHES is likewise **not** in this document's validation scope. Verify any form-factor-specific details against your live cluster |
| Install path | Via the ACP Marketplace cluster-plugin entry; the **Catalog → Helm Chart** path is not the main subject of this document (see Chapter 4 Method 3) |

> **Note:** Concrete details in this document (form fields, pre-installed
> tools, UID/GID, chart values defaults, error-message literals, etc.) are
> all relative to the baseline above. **Some details may shift after
> plugin or upstream ARC upgrades**; when reality diverges from the
> document, trust the live cluster (`kubectl get autoscalingrunnerset -o
> yaml`, the matching upstream `values.yaml`) over what is written here.

### Terminology

| Abbreviation | Full name | Meaning in this document |
|---|---|---|
| ARC | Actions Runner Controller | GitHub's upstream Kubernetes controller for self-hosted runners |
| ACP | Alauda Container Platform | This platform |
| ARS | AutoscalingRunnerSet | The core ARC CRD that describes one pool of scalable runners |
| ER / ERS | EphemeralRunner / EphemeralRunnerSet | CRDs for individual runner pods and their owning sets |
| SA | ServiceAccount | A Kubernetes ServiceAccount |
| GHES | GitHub Enterprise Server | GitHub's self-hosted distribution |
| PAT | Personal Access Token | A GitHub access token |
| ECV | Extra Chart Values | The top-level YAML textarea on the plugin form for advanced overrides |
| EGV | Extra Global Values | Same as ECV but the content is embedded under the chart's `global:` block |

---

## Understanding Architecture

### Why scale-set mode (not legacy)

ARC has two upstream deployment modes: **scale-set** and **legacy**
(runner-deployment mode). The two Alauda plugins package the scale-set mode
only, for the following reasons:

- **GitHub's recommended direction.** Scale-set is the new ARC mode that
  GitHub has been pushing since 2023; legacy mode is in maintenance and no
  longer receives new features. New deployments should use scale-set.
- **Better authentication model.** Scale-set recommends GitHub App
  installation-level credentials (PAT is also supported), with finer
  granularity than PAT, easier to scope per repo / org, and easier to rotate.
- **Native autoscaling.** Scale-set talks directly to GitHub's Actions Service
  via a long-poll job-acquisition protocol. When a job arrives, an ephemeral
  pod is created and destroyed when the job ends; scale-from-zero is the
  default — no idle runners required.
- **Simpler architecture.** Legacy mode requires GitHub-to-cluster webhook
  delivery, which means exposing the cluster to the internet. Scale-set is
  fully outbound (cluster → GitHub) and does not require any inbound
  exposure.

### How the components fit together

When both plugins are installed, the cluster runs four logical components
across two namespaces:

| Component | Where it runs | Pod type | Owned by |
|---|---|---|---|
| Controller | `arc-systems` | Deployment | Controller plugin |
| Listener (one per scale-set) | `arc-systems` | Pod (managed by controller) | Controller (on behalf of scale-set) |
| AutoscalingRunnerSet (ARS) | `arc-runners` | CRD object | Scale-set plugin |
| EphemeralRunner pod | `arc-runners` | Pod (lifecycle: per workflow job) | Controller |

A few non-obvious points new users frequently hit:

- The **listener pod runs in the controller namespace** (`arc-systems`), not
  in the scale-set's own `arc-runners`. This is because the listener is
  created by the controller and reuses the controller's ServiceAccount /
  RBAC.
- With `minRunners=0`, no runner pod exists in `arc-runners` until a workflow
  triggers — that is normal.
- The CRDs (`AutoscalingRunnerSet`, `AutoscalingListener`,
  `EphemeralRunnerSet`, `EphemeralRunner`) are created by the controller
  plugin and are cluster-scoped.

### Images bundled in the install package

The following table clarifies which ARC component images are pre-bundled in
the Alauda marketplace install package vs. which need to be synced manually:

| Component | Image | Bundled | Air-gap action |
|---|---|---|---|
| Controller | `gha-runner-scale-set-controller` | ✅ in controller plugin | None |
| Listener | uses the controller image (forked by controller) | ✅ | None |
| Runner main | `gha-runner-scale-set-runner-extension` | ✅ in scale-set plugin | None |
| DinD sidecar | `docker:<tag>-dind` | ❌ | Sync upstream image to platform registry; see [Recipe 8](#recipe-8-dind-mode-run-docker-build-inside-runner) and [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry) |

**Conclusion:** Without DinD mode, the install package runs end-to-end inside
air-gapped clusters. DinD mode requires syncing one extra image to the
platform registry.

> **Note on third-party actions in air-gap:** Workflows that use
> `uses: actions/checkout@v4` and other community actions need network access
> to fetch action source from `github.com` at runtime. The runner image does
> not bundle action source, and the platform plugins do not provide an action
> mirror. See
> [Using third-party actions (`uses:`)](#using-third-party-actions-uses) for
> air-gap workarounds.

### Platform-injected runtime defaults

When installed via the ACP marketplace, the plugin chart receives the
following values automatically. You do **not** need to configure them by
hand:

- `global.registry.address` — platform image registry prefix; ARC component
  images are pulled from this prefix automatically.
- `global.registry.imagePullSecrets` — credentials for the platform registry,
  managed by the platform controller.
- `global.images.<component>.repository` — defaults to the bundled image
  paths inside the platform registry.

You only need to set `images:` in the **Extra Global Values** field when you
want to override the image source — for example, custom upstream version,
private registry sub-path, or DinD image. See
[Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry).

> **Warning:** Do not write a `registry:` sub-key under EGV. The platform
> already renders `global.registry`; if you write `  registry:` (2-space
> indent inside EGV) it is silently dropped. The override has no effect and
> no error is reported.

### The runner image

After both plugins are installed, you may want to know what is available
inside the runner image and how it executes.

#### Pre-installed CLI tools

The runner image bundles common CI/CD command-line tools. You can call them
directly from a workflow `run:` step:

| Category | Tools |
|---|---|
| Kubernetes | `kubectl`, `helm` |
| Tekton | `tkn` |
| General CLI | `git` (with git-lfs), `curl`, `jq`, `yq` |
| Shell / archive | `bash`, `tar`, `unzip`, `zip`, `gzip`, `zstd` |
| Node.js runtime | Node 20 / Node 24 (runtime only — see note below) |
| OpenSSH | `ssh` |

Notes:

- **Docker is NOT pre-installed.** The Alauda runner image is built on
  `almalinux:9-minimal` and intentionally excludes `docker` /
  `docker-compose` / `dockerd` / `containerd` / `buildx` / `runc` to keep
  the image small and the CVE surface narrow. DinD mode (Container Mode =
  `dind`) launches a separate `docker:dind` sidecar provisioned by the
  upstream chart, but its docker CLI does not become available inside
  the runner pod automatically. If a workflow step needs to call
  `docker` / `docker-compose`, the standard path is to build a custom
  runner image that bundles the docker CLI and point
  `images.runnerExtension` at it via
  [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry).
  - **Do not try to install at step time with
    `microdnf install -y docker-ce-cli`.** The default runner runs as the
    non-root `runner` user (UID/GID 1001), so ordinary workflow steps are
    already the wrong place for system-package installs; on top of that, the
    runner image enables only AlmaLinux BaseOS / AppStream by default, and
    `docker-ce-cli` is in neither repo. Step-time installs would have to solve
    both the root-permission problem and the extra docker.io repo setup —
    fragile and repeated per step.
  - **Do not switch to `jobs.<id>.container.image:`** to bring in
    docker CLI under DinD — DinD is not compatible with the GHA
    `container:` field (see the Warning under
    [Example 1](#example-1-run-a-job-in-a-custom-container)).
- **Node.js (20 / 24) is the embedded runtime only** — the bundled Node
  is stripped down (no `npm` / no `corepack` / no Alpine variant). This
  is the minimum needed to run JavaScript actions; for a full Node dev
  environment within a step, call `actions/setup-node@v5` which installs
  the corresponding full toolchain on demand.
- **`kubectl` / `tkn` only have a small baseline permission set by
  default, which is not the same as business RBAC.** The binaries are
  installed in the runner image, but the default ServiceAccount used by
  the runner pod mainly carries the namespace-scoped baseline
  permissions required by runner container hooks (for example `pods`,
  `pods/log`, `pods/exec`, `secrets`; the exact set still depends on the
  current container mode). That does **not** automatically mean the
  workflow can freely inspect or modify cluster resources. If the
  workflow needs Tekton, Deployment, CRD, or business-namespace access,
  still configure an explicit ServiceAccount with the required RBAC —
  see [Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs).
  Also note that the effective permission set may be widened by
  additional RoleBindings / ClusterRoleBindings in the environment, so
  do not rely on documentation impressions alone; verify it in-cluster
  with `kubectl auth can-i --list --as system:serviceaccount:<runner-ns>:<runner-sa> -n <runner-ns>`.

#### What if the tool you need is missing

If the workflow needs a tool that is not in the table above, take one of the
following approaches:

1. **Prefer step-level setup actions** such as `actions/setup-node@v5`,
   `actions/setup-go@v5`, or `actions/setup-java@v4`. Only when you
   intentionally switch to a custom job container that allows root package
   installation should you consider calling a package manager inside `run:`.
   The default Alauda runner image is built on `almalinux:9-minimal`, which
   ships **`microdnf`, not `dnf`**, but the runner itself executes as the
   non-root UID/GID 1001 user, so a plain
   `microdnf install -y <pkg>` in a normal workflow step usually fails on
   permissions.
2. **Use a workflow `container:` to switch to a custom image** — set
   `jobs.<id>.container.image` to an image that contains the tool. **This
   applies only to** `kubernetes-novolume` (default) or `kubernetes`
   container mode; `dind` does not support the GHA `container:` field.
   See [Example 1](#example-1-run-a-job-in-a-custom-container).
3. **Replace the default runner image** — build a customized runner image and
   point `images.runnerExtension` at it via
   [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry).

#### Runtime identity

- **UID / GID:** 1001 / 1001 (non-root `runner` user).
- **`HOME`:** `/home/runner`.
- **Current startup path:** the chart / overlay explicitly runs
  `command: ["/home/runner/run.sh"]`, and `run.sh` then starts the runner
  process. `entrypoint.sh` / `startup.sh` belong to the traditional upstream
  runner-image startup path, but they are not the main execution entry point
  of the current Alauda runner-extension image.
- **Resource limits:** when adding `resources` to the runner container in
  [Recipe 4](#recipe-4-limit-cpu--memory-of-runners), you **must keep**
  `command: ["/home/runner/run.sh"]` (the chart default). Omitting it makes
  the pod start but the runner process never runs `run.sh` (it falls back to
  the base image's default startup behavior), causing workflows to stay queued.

#### Using third-party actions (`uses:`)

GitHub Actions steps like `uses: actions/checkout@v4` make the workflow call
a community-maintained reusable action. Before executing the step, the
runner downloads the action source from GitHub to
`/home/runner/_work/_actions/` inside the pod, then hands it to Node.js for
execution. **This is runtime behavior, not part of the runner image.**

##### Method 1: Direct connectivity / HTTPS proxy

When the cluster has direct outbound access to `github.com`, the workflow
just works:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v5
    with:
      node-version: '20'
  - run: npm ci
```

If the cluster has no direct access but has an HTTPS egress proxy
(common in enterprise networks), inject `HTTPS_PROXY` into the runner pod
via [Recipe 2](#recipe-2-inject-secrets--custom-env-into-runner). Paste the
following into Extra Chart Values on the scale-set plugin form (the
`image:` and `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` entries are required
fallbacks under helm's array-replace semantics — see the safe skeleton
warning in [Chapter 3, Step 1](#step-1-understanding-ecv-vs-egv)):

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>          # required; see Recipe 9 to discover the live path
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                         # required for kubernetes-novolume / dind modes
      - name: HTTPS_PROXY
        value: "http://proxy.example.com:3128"
      - name: NO_PROXY
        value: "<internal-domain>,localhost,127.0.0.1"
```

##### Method 2: Air-gap — mirror actions to internal GHES

When the cluster has no outbound access to `github.com` at all, ARC has no
built-in action mirror — the runner image bundles no action source and the
platform plugins offer no "action source URL forwarding" option.

The first option is to fork (or mirror) `actions/checkout` and other needed
action repos to **the same GitHub instance the runner is registered against**
(i.e. the host referenced by `githubConfigUrl` — typically your internal
GHES), then change `uses:` to the internal path:

```yaml
steps:
  - uses: my-org/checkout@v4   # mirrored to the same GHES instance
```

The runner resolves `uses:` against the base URL derived from
`githubConfigUrl`, so `my-org/checkout` must live on the **same GitHub
instance** (github.com or GHES) — and that host must be reachable from
the cluster.

> **Note — internal git is GitLab / Gitea / Gitee.** The GitHub Actions
> `uses: owner/repo@ref` protocol resolves only against GitHub instances;
> it cannot fetch from GitLab / Gitea / Gitee. In those environments
> Method 2 does not apply — switch to Method 3 below (write `git clone`
> in `run:` instead).

##### Method 3: Air-gap — replace `uses:` with `run:` shell scripts

Skip `uses:` entirely and write the equivalent shell yourself. The
functionality of `actions/checkout@v4` can be replaced with one `git clone`:

```yaml
steps:
  - name: checkout
    env:
      GIT_TOKEN: ${{ secrets.INTERNAL_GIT_TOKEN }}
    run: |
      git clone --depth=1 \
        "https://oauth2:${GIT_TOKEN}@my-internal-git.example.com/${GITHUB_REPOSITORY}" .
```

Workflows are slightly longer, but **depend on neither github.com nor any
action mirror** — the most robust air-gap path.

> **Warning — runner registered to github.com but no cluster outbound:**
> Method 2 only works if the host referenced by `githubConfigUrl` is
> reachable from the cluster. If the runner is registered to github.com but
> the runner pod has no outbound, **`uses:` cannot work directly** — you
> must use Method 3 or grant the cluster a proxy to github.com.

---

## Common Basic Configuration

### Environment Preparation

#### System Requirements

- ACP cluster (global cluster or workload cluster, either is fine).
- Cluster has outbound access to the GitHub domains required by self-hosted
  runners. For GitHub.com, that at least includes `github.com:443`,
  `api.github.com:443`, and `*.actions.githubusercontent.com:443`. For the
  broader domain list and GHES-specific requirements, follow GitHub's official
  self-hosted runner communication requirements rather than assuming you only
  replace two hostnames.
- For air-gap clusters, see
  [Images bundled in the install package](#images-bundled-in-the-install-package)
  for which images need pre-syncing, and
  [Using third-party actions (`uses:`)](#using-third-party-actions-uses) for
  workflow `uses:` workarounds.

#### Required Components

- Controller plugin (Alauda Support for GitHub Actions Runner Controller).
- Scale-set plugin (Alauda Support for GitHub Actions Runner Scale Set).
- A GitHub credential — either GitHub App or PAT.

#### Permission Requirements

- Cluster administrator privileges to install both plugins.
- Permission to create namespaces (`arc-systems` and `arc-runners` by
  default).
- A GitHub identity (App or PAT). Pick the auth method based on the
  `githubConfigUrl` scope:

| `githubConfigUrl` scope | GitHub App | PAT |
|---|---|---|
| Repository (`https://github.com/<org>/<repo>`) | supported | supported |
| Organization (`https://github.com/<org>`) | supported | supported |
| Enterprise (`https://github.com/enterprises/<enterprise>`) | **not supported** (GitHub platform limit) | supported (**only choice**) |

> **Note — enterprise-level ARC requires a PAT.** GitHub does not accept
> GitHub App authentication for runner registration at the enterprise
> level ([upstream docs](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api)
> are explicit on this). If your scale-set's `githubConfigUrl` is
> enterprise-scoped, skip Method 1 (GitHub App) below and go directly to
> Method 2 (PAT).

With the chosen auth method, grant the minimum permissions:

- **GitHub App, repo-level scale-set** —
  - Repository: `Administration: Read & Write`, `Metadata: Read`
- **GitHub App, org-level scale-set** —
  - Repository: `Metadata: Read`
  - Organization: `Self-hosted runners: Read & Write`
- **PAT (Classic)** — pick the scope by `githubConfigUrl` level: `repo`
  for repository, `admin:org` for organization (already covers
  self-hosted runner writes), and `manage_runners:enterprise` for
  enterprise (**enterprise-level ARC requires a Classic PAT** —
  fine-grained tokens are not supported at enterprise level).
- **PAT (Fine-grained)** — **repo-level**: Repository permissions
  `Administration: Read and write`. **Org-level**: Repository
  permissions `Administration: Read` + Organization permissions
  `Self-hosted runners: Read and write`. **Enterprise-level: not supported.**

> **Source:** the canonical scope names and combinations are documented
> in [GitHub's ARC authentication guide](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api).
>
> GitHub's own note is easy to miss: `Administration: Read & Write` is
> **required only for repository-scoped registration**; org-scoped
> registration does not need it.

### GitHub Credential Setup

Pick one of the two methods below to create a Secret that lets the runner
authenticate to GitHub. This Secret can be created **before or after**
installing the scale-set plugin: a pre-existing Secret is not overwritten
by the plugin. If this is the **initial Secret created after installation**,
the related pods usually recover automatically once the Secret appears; if they
still do not recover after a few minutes, delete the listener pod once to
force a rebuild. If you are **rotating an existing Secret's contents**, the
listener pod **does not pick up the change automatically** — the controller
does not watch Secret resources. Force a restart by deleting the listener pod,
e.g.:

```shell
$ kubectl -n arc-systems delete pod \
    -l actions.github.com/scale-set-name=<scale-set-name>
```

The controller will recreate the listener pod and reconnect with the new
credential.

The default Secret name is `gha-runner-scale-set-github-config`. To use a
different name, set the **GitHub Credentials Secret Name** field on the scale-set
plugin form ([Chapter 2 Step 2](#step-2-install-via-marketplace-1)).

> **Note:** If you plan to install the scale-set plugin into a custom
> namespace, replace `arc-runners` with that namespace in both Method 1 and
> Method 2 below. **The GitHub credential Secret must live in the scale-set's
> Install Namespace.**

#### Method 1: GitHub App (recommended)

```shell
$ kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -

$ kubectl -n arc-runners create secret generic gha-runner-scale-set-github-config \
    --from-literal=github_app_id=<your-app-id> \
    --from-literal=github_app_installation_id=<your-installation-id> \
    --from-file=github_app_private_key=/path/to/your-app.private-key.pem
```

How to obtain the three values (the first two come from the same GitHub App
settings page, the third comes from the App's installation URL after
installing it on the target org / repo):

- **`github_app_id`** — In the GitHub UI **Settings → Developer settings →
  GitHub Apps → your App**, the `App ID` field in the "About" block. It is
  a number. If you create the Secret using a YAML manifest instead of
  `kubectl create secret --from-literal`, **wrap the value in quotes**
  (e.g., `github_app_id: "123456"`); otherwise ARC reports
  `failed to get app id: strconv.ParseInt`.
- **`github_app_private_key`** — At the bottom of the same App settings
  page, under "Private keys", click "Generate a private key" to download a
  `.pem` file. Pass the path with `--from-file=github_app_private_key=...`.
  **Use `--from-file`, not `--from-literal`** — the PEM file requires line
  breaks; `--from-literal` collapses multiple lines into one and the
  listener log reports `failed to parse private key`.
- **`github_app_installation_id`** — Install the App to the target org /
  repo first. Go to **GitHub Apps → your App → Install App** tab, choose the
  organization / repository to install. After installation, click
  "Configure" on that row; the browser navigates to a URL like
  `https://github.com/organizations/<org>/settings/installations/12345678`,
  and the trailing `12345678` is the `installation_id`. Wrong values cause
  `Could not find any installation` errors in the listener log.

#### Method 2: Personal Access Token

**Generate a PAT** in GitHub UI **Settings → Developer settings → Personal
access tokens**. Two types are available; pick permissions by
`githubConfigUrl` scope (canonical list and rationale in
[GitHub's ARC authentication guide](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api)):

- **Fine-grained (recommended)** — scoped to specific repositories or
  organizations. When creating, pick Resource owner (user or org) and
  target repositories (All / Only select repositories).
  **Fine-grained tokens do not support enterprise-level ARC.**
  - **Repository-level `githubConfigUrl`** — Repository permissions:
    `Administration: Read and write`.
  - **Organization-level `githubConfigUrl`** —
    - Repository permissions: `Administration: Read`
    - Organization permissions: `Self-hosted runners: Read and write`
- **Classic** — coarser scope; **the only option for enterprise-level ARC**.
  - **Repository-level** — `repo`.
  - **Organization-level** — `admin:org`.
  - **Enterprise-level** — `manage_runners:enterprise`.

For details, see GitHub's official documentation on
[Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

After obtaining the token, write it into the Secret:

```shell
$ kubectl -n arc-runners create secret generic gha-runner-scale-set-github-config \
    --from-literal=github_token=ghp_xxxxxxxxxxxxxxxxxxxxx
```

### Workflow side: `runs-on:` requirements

This document (Alauda's current validated path) only covers the
**single-string** form — `runs-on:` set to the `runnerScaleSetName`
configured on the scale-set plugin form:

```yaml
# Alauda-validated: single string
runs-on: my-runners
```

> **Note — want one scale-set to cover multiple label sets?** The
> upstream chart's `scaleSetLabels` field combined with the array form
> of `runs-on:` does exactly this, **but with a critical
> install-time-only constraint**: changing labels after the scale-set
> is already installed does not propagate to GitHub. Full path,
> injection method, and "what to do if I already installed it" are in
> [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels).

**The most common mistake** is writing `runs-on: [self-hosted, label]`
(legacy ARC syntax) without configuring `scaleSetLabels` on the
scale-set, leaving GitHub with nothing to match. Note that this is
distinct from the new scale-set-mode array form (where the first
element is `runnerScaleSetName`, not `self-hosted`). See
[Issue 3](#issue-3-workflow-stays-queued-runner-never-arrives) for the
diagnostic path.

### Workflow side: `runs-on:` array form with `scaleSetLabels`

When you want one scale-set to handle multiple kinds of jobs (for
example, the same runner pool serving both general jobs and GPU-only
jobs) without splitting it into separate scale-sets, you can use the
**array form** of `runs-on:` together with the chart's `scaleSetLabels`
field. This section gives the full injection and matching rules and
makes one **easy-to-miss constraint** explicit: on chart 0.14.1
`scaleSetLabels` is **only honoured at scale-set creation time**;
changing it after install does not propagate to GitHub.

> **⚠️ Critical constraint — `scaleSetLabels` is install-time-only**
>
> This is the upstream ARC design on chart 0.14.1: the labels are
> registered with GitHub once, when the scale-set is first created.
> Changing `scaleSetLabels` later in the local chart values does
> **not** push the new labels to GitHub.
>
> Consequence: changing `scaleSetLabels` after install (whether via
> ECV, moduleinfo, or `helm upgrade`) updates the local ARS spec, but
> GitHub's advertised label set for this scale-set stays the same —
> array-form `runs-on:` matches against GitHub's stale set and stays
> `Queued` forever. The "What if I want to change labels after
> install" section below covers the two paths around this constraint.

**End-to-end path (at first install):**

1. Chart values top-level field `scaleSetLabels: [...]` (default `[]`).
2. The chart template writes the array verbatim into
   `AutoscalingRunnerSet.spec.runnerScaleSetLabels`.
3. **First** reconcile: the controller registers
   `runnerScaleSetName` together with `runnerScaleSetLabels` on the
   GitHub side.
4. A workflow with `runs-on: [<scale-set-name>, A, B]`: the first
   element MUST equal `runnerScaleSetName` (the **Runner Scale-Set
   Name** field on the Scale-Set plugin form); every subsequent
   element MUST be present in the advertised set on GitHub
   (subset-of-advertised, AND semantics).

**Injection — write it into ECV before installing (the ACP form does not surface this field):**

The reliable approach is to put the labels into ECV **before** clicking
Install on the Scale-Set plugin, so the first reconcile registers them
with GitHub:

1. In Marketplace → Cluster Plugins, find the ARC Scale-Set plugin,
   but **do not click Install yet**.
2. In the form's **Extra Chart Values** field (i.e. ECV), enter:

   ```yaml
   scaleSetLabels:
     - linux
     - gpu
   ```

3. Submit the install.
4. After ARS reconcile completes, verify:

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
       -o jsonpath='{.spec.runnerScaleSetLabels}'
   # Expect: every label you wrote into the ECV
   ```

If the scale-set is **already installed** and you only now want to add
labels, see "What if I want to change labels after install?" below.

**Workflow YAML:**

```yaml
# Array form — first element MUST equal runnerScaleSetName,
# every remaining element MUST have been advertised to GitHub at
# scale-set registration time.
jobs:
  build:
    runs-on: [my-runners, linux, gpu]
```

**What if I want to change labels after install:**

Because of the upstream constraint, the **only reliable way** is to
make GitHub forget this scale-set and let the controller register it
again:

- **Option A (recommended, clean):** uninstall the Scale-Set plugin
  (see [Chapter 7](#chapter-7-uninstall)), edit the ECV
  `scaleSetLabels:`, and reinstall. In-flight workflows fail during
  the gap, so do this in a maintenance window.
- **Option B (only when you have GitHub-side permissions):** use a
  PAT to delete the scale-set's GitHub registration directly; the
  controller's next reconcile will treat it as missing and re-register
  with the current ARS spec labels. **The upstream code path is not
  fully idempotent** — the listener may CrashLoop briefly until the
  controller recreates the registration.

**Chart-side validation upper bound:**

- Each label MUST be **non-empty** and **less than 256 characters**;
  violations fail chart rendering and surface as an error in the
  moduleinfo status.

**Common misconceptions about the workflow array form:**

- The array form is **AND**: every element must be in the advertised
  set; if any element is missing, GitHub never finds a match and the
  workflow stays `Queued` forever, with no proactive error from the
  listener.
- **Do not** make the first element `self-hosted`: that is the legacy
  ARC (`RunnerDeployment`) syntax; scale-set mode does not recognise
  it.
- "I changed the ECV, the labels show up in the ARS spec, why is my
  workflow still stuck in Queued?" — see the ⚠️ critical constraint
  above; almost certainly because labels changed after install never
  reached GitHub.

**Troubleshooting: workflow stuck in Queued?**

1. Check what labels the ARS actually carries:

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
       -o jsonpath='{.spec.runnerScaleSetLabels}'
   ```

2. Compare against every entry in the workflow's `runs-on:` array —
   the first element must equal `runnerScaleSetName`; every other
   element must appear in step 1's output.
3. **If step 1 already shows your labels and the workflow is still
   Queued**, this is almost certainly the install-time-only constraint
   (you installed the scale-set first, then added labels). Go back to
   "What if I want to change labels after install" and follow Option
   A or B.
4. The listener log shows whether GitHub is dispatching the job at
   all:

   ```shell
   $ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=50
   # On a successful match: "Acquired job ..."
   # If nothing: GitHub side is not matching — go back to step 3.
   ```

---

## Chapter 1. Installing the Controller Plugin

### Step 1: Prerequisites

Before installing, confirm the following:

- The `arc-systems` namespace is created on the target cluster (the
  installer does not create it for you):
  ```shell
  $ kubectl create namespace arc-systems --dry-run=client -o yaml | kubectl apply -f -
  ```
- You have cluster administrator privileges and can install cluster plugins.

### Step 2: Install via marketplace

In the ACP UI, go to **Administrator → Marketplace → Cluster Plugins**,
locate **Alauda Support for GitHub Actions Runner Controller**, click into
the plugin and select the target cluster, then install.

Form fields:

| Field | Default | Editable after install | Notes |
|---|---|---|---|
| Install Namespace | `arc-systems` | No | Must exist on the cluster before install; otherwise the install fails with `namespaces "<name>" not found`. If you change this name, the scale-set plugin's Controller Namespace must match. |
| Log Level | `info` | Yes | Set to `debug` for troubleshooting. |
| Log Format | `json` | Yes | JSON aligns with platform log aggregation; switch to `text` for readability when troubleshooting. |
| Enable Metrics | `false` | Yes | Set to `true` to expose port 8080 on controller and listener pods for Prometheus. |
| Runner Max Concurrent Reconciles (advanced) | `2` | Yes | Increase when the EphemeralRunner count exceeds 50. |
| Update Strategy (advanced) | `immediate` | Yes | `immediate` rebuilds runners on upgrade; `eventual` waits for current jobs to drain. |
| Extra Chart Values (YAML) (advanced) | empty | Yes | See [Chapter 3](#chapter-3-customizing-runners-via-extra-values). |
| Extra Global Values (YAML) (advanced) | empty | Yes | See [Recipe 9 — controller plugin section (A)](#a--controller-plugin). |

### Step 3: Verify the controller is running

When the controller plugin reaches `Installed`, the cluster should have:

- The `arc-systems` namespace.
- A `Deployment/arc-gha-rs-controller`.
- A `ServiceAccount/arc-gha-rs-controller`.
- A set of ARC CRDs: `AutoscalingRunnerSet`, `AutoscalingListener`,
  `EphemeralRunnerSet`, `EphemeralRunner`.

> **Note:** The commands below use the default controller namespace
> `arc-systems`. If you installed the controller into a custom namespace,
> replace `arc-systems` with the real value before running them.

Verify:

```shell
$ kubectl -n arc-systems get pod
# expected: arc-gha-rs-controller-...   1/1   Running

$ kubectl get crd | grep actions.github.com
# expected: 4 CRDs listed
```

> **Note:** Installing the controller alone does not start any runner. The
> next chapter installs the scale-set plugin, which actually creates a
> runner pool.

---

## Chapter 2. Installing the Scale-Set Plugin

> **Note — Plan the install namespace before you start.** The form's
> **Install Namespace** field (default `arc-runners`) is locked once the
> plugin is installed; changing it later requires uninstalling and
> reinstalling. The default `arc-runners` is fine for most clusters; if
> you split runners by team or business line, pick a stable name up front
> (for example `team-a-runners`, `team-b-runners`) and use it for the
> rest of this chapter.
>
> The **GitHub credential Secret must live in the same namespace as the
> Scale-Set plugin** — i.e. the `kubectl create namespace ...` and
> `kubectl -n <ns> create secret ...` commands below must use the same
> `<ns>`. If you decide to install into `team-a-runners`, replace
> `arc-runners` with `team-a-runners` in both commands.

### Step 1: Prerequisites

- The controller plugin is installed and `Running`
  ([Chapter 1](#chapter-1-installing-the-controller-plugin)).
- The `arc-runners` namespace exists on the target cluster:
  ```shell
  $ kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f -
  ```
- The GitHub credential Secret is created in `arc-runners`. See
  [GitHub Credential Setup](#github-credential-setup).

### Step 2: Install via marketplace

Back in **Cluster Plugins**, locate **Alauda Support for GitHub Actions
Runner Scale Set**, click into the plugin, select the **same cluster** as
the controller, then install.

Form fields:

| Field | Default | Required | Editable after install | Notes |
|---|---|---|---|---|
| Install Namespace | `arc-runners` | Yes | No | Where runner pods run. Must exist; otherwise install fails. |
| GitHub URL | (none) | Yes | No | See [GitHub URL formats](#github-url-formats) below. **This field is read-only after install and is not supported for in-place updates.** If you need to switch the target repo / org / enterprise, recreate the scale-set (or uninstall and reinstall) and manually verify / remove the old GitHub-side scale-set registration under **Settings → Actions → Runners**. |
| GitHub Credentials Secret Name | `gha-runner-scale-set-github-config` | Yes | No | Must match the Secret name created in [GitHub Credential Setup](#github-credential-setup); **read-only after install**. |
| Controller Namespace | `arc-systems` | Yes | No | **Must match the controller plugin's Install Namespace**, otherwise the scale-set points its controller-facing reference / RBAC at the wrong subject and listener / runner reconciliation fails. The listener pod actually runs in this namespace, not in `arc-runners`; verify with `kubectl -n arc-systems get pod`. |
| Controller ServiceAccount Name (advanced) | `arc-gha-rs-controller` | Yes | No | The SA created by the controller plugin; do not change when installed via the plugin. |
| Runner Scale-Set Name | empty | No | No | **The name GitHub uses to identify this runner pool; the workflow `runs-on:` field must match this value.** When empty, the chart falls back to the Helm release name (default `arc-runner-set`). If the release name later changes, GitHub registers a new scale-set and the old one keeps occupying a registration slot — must be deleted manually from GitHub UI **Settings → Actions → Runners**. Recommend setting an explicit name aligned with your business scenario. |
| Min Runners | `0` | No | Yes | Minimum number of resident runner pods. `0` means pure on-demand. |
| Max Runners | `5` | No | Yes | Maximum number of concurrent runner pods. |
| Container Mode (advanced) | `kubernetes-novolume` | No | Yes | See [Container Mode selection](#container-mode-selection) below. **Leave empty** for full custom (you must then set `containerMode:` in ECV). |
| Extra Chart Values (YAML) (advanced) | empty | No | Yes | See [Chapter 3](#chapter-3-customizing-runners-via-extra-values). |
| Extra Global Values (YAML) (advanced) | empty | No | Yes | See [Recipe 9 — scale-set plugin section (B)](#b--scale-set-plugin). |

#### GitHub URL formats

| Scope | URL format | Use case |
|---|---|---|
| Single repo | `https://github.com/<org>/<repo>` | Project-level self-hosted runner |
| Organization | `https://github.com/<org>` | Shared across all repos in the org |
| Enterprise | `https://github.com/enterprises/<enterprise>` | GHEC enterprise |

For self-hosted GitHub Enterprise Server (GHES), replace `https://github.com`
with your GHES URL.

#### Container Mode selection

Choose one of the three options on the form:

| Form option | Use case |
|---|---|
| `kubernetes-novolume` (default) | Most workflows that do not need Docker inside the runner and do not need a persistent work directory. Use this as the default unless you have a specific need. |
| `dind` | When the workflow runs `docker build` / `docker push`. |
| **(empty)** | Advanced — fully take over `containerMode:` via Extra Chart Values (e.g., kubernetes mode with PVC, or custom containerMode fields). |

> **Warning — do not pick `kubernetes` directly on the form.** Although the
> form has a `kubernetes` option, choosing it renders an ARS without the
> required `kubernetesModeWorkVolumeClaim` field, which the CRD rejects.
> If you need kubernetes mode (persistent work dir, container-job,
> `actions/cache@v4`, and other PVC-dependent capabilities), **leave the
> form empty** and write the full `containerMode:` block under Extra Chart
> Values — see [Recipe 7](#recipe-7-kubernetes-mode-with-persistent-work-volume).

#### Min / Max Runners sizing

- `minRunners=0` — pure on-demand; no pods when idle. The first workflow
  trigger has ~10s latency (pod start + GitHub registration).
- `minRunners=1` — keeps one idle runner; first-trigger latency is < 1s but
  occupies resources.
- `maxRunners` — upper bound. Size based on cluster resources and concurrent
  workflow count (recommend pairing with
  [Recipe 4](#recipe-4-limit-cpu--memory-of-runners) to add `resources` to
  runners).

### Step 3: Verify listener and AutoscalingRunnerSet

Wait until the plugin instance reaches `Installed`, then check the
following resources:

> **Note:** The commands below assume the controller lives in `arc-systems`
> and the scale set in `arc-runners`. If you customized either namespace,
> replace them consistently.

```shell
# controller in arc-systems
$ kubectl -n arc-systems get pod
# expected: arc-gha-rs-controller-...     1/1     Running

# listener pod also in arc-systems (NOT in arc-runners)
$ kubectl -n arc-systems get pod -l app.kubernetes.io/component=runner-scale-set-listener
# expected: <scaleset>-...-listener     1/1     Running
```

> **Note:** The listener pod runs in the **controller namespace** (default
> `arc-systems`), not in the scale-set's own `arc-runners`. This is by ARC
> design — the listener is forked by the controller and reuses the
> controller's SA/RBAC. With `minRunners=0`, `arc-runners` has no pods at
> this point, which is normal.

Verify the AutoscalingRunnerSet status:

```shell
$ kubectl -n arc-runners get autoscalingrunnerset
# columns: MAXIMUM RUNNERS / CURRENT RUNNERS / STATE
```

Verify on the GitHub side that the runner is registered: open your GitHub
repo (or org / enterprise) **Settings → Actions → Runners**. A runner
named after your `runnerScaleSetName` should appear with state `Online`
(connected and idle — referred to as the "idle" state in upstream docs) or
`Active` (currently executing a job).

### Step 4: Trigger a smoke workflow

Place the following minimal workflow at `.github/workflows/smoke.yaml` in
your GitHub repo:

```yaml
name: ARC Smoke
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  smoke:
    runs-on: my-runners      # safest currently-validated form in this doc: runnerScaleSetName as a single string
    steps:
      - name: runner identity
        # Prefer GitHub-provided context and shell built-ins over
        # image-specific OS utilities; this avoids depending on whether a
        # given base image happens to ship `hostname`. Use ${HOSTNAME}
        # directly instead.
        run: |
          echo "runner_name: ${RUNNER_NAME:-unknown}"
          echo "hostname:    ${HOSTNAME:-unknown}"
          echo "workspace:   ${GITHUB_WORKSPACE:-unknown}"
          echo "job:         ${GITHUB_JOB:-unknown}"
          echo "whoami:      $(whoami)"
          id
          echo "pwd:         $(pwd)"
```

Commit, then trigger via push or `workflow_dispatch`. Watch the runner
pod appear, run, and disappear:

```shell
$ kubectl -n arc-runners get pod -w
# expected: an EphemeralRunner pod transitions Pending → Running → completed → deleted
```

If the workflow stays `Queued`, see
[Issue 3](#issue-3-workflow-stays-queued-runner-never-arrives).

---

## Chapter 3. Customizing Runners via Extra Values

The platform UI exposes the most-used chart fields as form inputs, but the
chart has many more configurable fields (especially nested pod / container
spec fields). The remainder is reached through two **escape hatches**:

- **Extra Chart Values (ECV)** — top-level textarea on the form. The content
  is appended to the end of the form-rendered values document, adding new
  top-level keys. **It cannot override** keys already rendered by the form;
  same-key conflicts cause the install to fail and the plugin instance never
  reaches `Installed`.
- **Extra Global Values (EGV)** — also a textarea, but its content is embedded
  under the `global:` block as `global.*` sub-keys.

> **Warning — indent contract for Extra Global Values.** Every YAML line in
> EGV **must start with 2 spaces** — this field has no indent template
> helper, your content is inserted verbatim into a 2-space-indented context.
> Lines starting at column 0 become new top-level keys and corrupt the YAML;
> the install fails outright. When pasting EGV snippets from this document,
> verify the leading 2 spaces line by line before saving.

> **Warning — Helm array fields must be provided in full.** Fields like
> `tolerations`, `containers`, `volumes`, `volumeMounts`, `env`, and
> `topologySpreadConstraints` are arrays. Helm merges arrays by **whole
> replacement**, not element-wise. If you provide only your custom element,
> the chart's default elements are **all lost**.
>
> The YAML in each Recipe below is already the complete form of the array
> field — copy as-is. To add new elements on top of what we provide, append
> your new elements into the existing list rather than writing a separate
> snippet that contains only the new element.
>
> Recipes affected and the array fields they touch:
>
> - [Recipe 2](#recipe-2-inject-secrets--custom-env-into-runner) — `containers` / `containers.env`
> - [Recipe 3](#recipe-3-pin-runners-to-dedicated-nodes) — `tolerations`
> - [Recipe 4](#recipe-4-limit-cpu--memory-of-runners) — `containers` / `containers.resources`
> - [Recipe 5](#recipe-5-spread-runners-across-nodes) — `topologySpreadConstraints`
> - [Recipe 6](#recipe-6-mount-maven-cache--extra-configmap--ca-bundle) — `volumes` / `volumeMounts`

> **Warning — when overriding `template.spec.containers[0]`, keep the
> safe skeleton below.** Because Helm replaces the entire `containers`
> array, any field you do not write is dropped. The chart's runner-
> container helper auto-supplies most `ACTIONS_RUNNER_*` env entries
> when missing, but it does **not** supply `image:` or `command:`, and
> its `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` default is `"true"`, but the
> Alauda-default `kubernetes-novolume` mode requires `"false"` — you must
> write that line back yourself. Always
> start from this skeleton when writing ECV that touches `containers[0]`:
>
> ```yaml
> template:
>   spec:
>     containers:
>       - name: runner
>         image: <runner-extension-image>          # required — see Recipe 9, or read the live value:
>                                                  #   kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
>                                                  #     -o jsonpath='{.spec.template.spec.containers[0].image}'
>         command: ["/home/runner/run.sh"]         # required — chart does not auto-supply; missing it leaves the runner process not started
>         env:
>           - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
>             value: "false"                       # required for kubernetes-novolume / dind modes; without it every job that does not declare a `container:` is rejected
>         # add your custom fields (resources / volumeMounts / extra env entries / ...) below this line
> ```
>
> Symptoms of forgetting `image:`: runner pod fails with
> `spec.containers[0].image: Required value` and never schedules.
> Symptoms of forgetting `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=false`:
> workflow log shows `Jobs without a job container are forbidden on
> this runner`.
>
> Self-check after editing ECV:
>
> ```shell
> $ kubectl -n arc-runners get autoscalingrunnerset <scale-set-name> \
>     -o yaml | yq '.spec.template.spec.containers[0]'
> # confirm `image`, `command`, and the `env` entries you expect are all present
> ```

### Step 1: Understanding ECV vs EGV

ECV applies to the chart's top-level keys; EGV applies under `global:`. As
a rule of thumb:

- Use **ECV** for runner pod template fields: `template.spec.*` for
  serviceAccount / nodeSelector / tolerations / containers / volumes; also
  `containerMode:` (conditional — only write this in ECV when the form's
  Container Mode field is left empty; see the forbidden-key list below for
  details), `listenerTemplate.spec.*`, and `scaleSetLabels:` (an array;
  each element must be non-empty and shorter than 256 characters; this
  field is **install-time-only** — see
  [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels)) etc.
- Use **EGV** for image overrides: `images.*` (controller / runnerExtension
  / dind).

A common mistake is writing a top-level key that is already rendered by the
form. The forbidden top-level keys are listed below.

**Do not write these top-level keys in ECV:**

- Controller plugin: `flags`, `metrics`, `namespaceOverride`, `replicaCount`,
  `global`.
- Scale-set plugin: `namespaceOverride`, `global`, `githubConfigUrl`,
  `githubConfigSecret`, `runnerScaleSetName`, `minRunners`, `maxRunners`,
  `controllerServiceAccount`.
  - `containerMode` is **conditional**: forbidden when the form's
    Container Mode field is non-empty (the plugin already renders it);
    when the form Container Mode is **left empty**, you must instead
    write the full `containerMode:` block in ECV — see
    [Recipe 7](#recipe-7-kubernetes-mode-with-persistent-work-volume).

If you need to override anything under `global.*` (such as `global.images.*`),
use EGV instead — see [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry).

> **The full chart-values reference (per plugin, with upstream comments preserved) has been moved to [Appendix: Full chart values reference](#appendix-full-chart-values-reference) at the end of this document.** The main tutorial continues directly to [Step 2: Verifying a config change took effect](#step-2-verifying-a-config-change-took-effect) and the Recipes below.

### Step 2: Verifying a config change took effect

After each change to ECV / EGV, confirm the change actually reaches runner
pods using these three steps:

1. **Confirm the plugin instance reached `Installed`.** After saving the
   form, wait ~30 seconds. The platform offers two entry points to check
   status:
   - **Marketplace → Cluster Plugins** — the plugin row should show
     `Installed` (green check).
   - **Clusters → \<your cluster\> → Functional Components** — make sure
     the breadcrumb selects the target cluster, then switch to the
     **Functional Components** tab. The
     `Alauda Support for GitHub Actions Runner Scale Set` row should show
     `Running` (green arrow) with the version on the right.

   If the status remains stuck or shows install failure, click the plugin
   detail and inspect the events / status block (most common causes: ECV
   conflict on a top-level key, or EGV indentation error).

2. **Inspect the rendered AutoscalingRunnerSet template.** When the plugin
   reconciles, it updates the `AutoscalingRunnerSet` in the install
   namespace. You can read the merged spec directly:

   ```shell
   $ kubectl -n arc-runners get autoscalingrunnerset -o yaml \
       | grep -A 3 <new-field-name>
   ```

   Seeing your field in the merged spec confirms ECV / EGV merged into the
   chart values successfully.

3. **Trigger a test workflow and confirm the new runner pod actually carries
   the config.** Any `workflow_dispatch` with a single `echo` step will do.
   While the workflow runs:

   ```shell
   $ kubectl -n arc-runners get pods -w
   # wait for the ephemeral runner pod to appear, note the pod name
   $ kubectl -n arc-runners get pod <pod-name> -o yaml \
       | grep -A 3 <new-field-name>
   ```

   Seeing the new field in the pod spec confirms end-to-end propagation.

### Step 3: Update / Upgrade / View — three different entry points

The platform UI exposes three different entry points for "maintaining a
plugin", each handling a different concern:

| Goal | Entry point | Result |
|---|---|---|
| **Modify ECV / EGV / other editable fields** | **Marketplace → Cluster Plugins** → ⋮ on the plugin row → **Update** | Updates editable fields only; **does not upgrade chart version**. |
| **View the full configuration panel (including version metadata)** | **Marketplace → Cluster Plugins** → click the plugin **name** to enter the detail page | The detail page lists Install Namespace, Log Level, Log Format, Enable Metrics, and the Advanced block (including ECV / EGV) together with the installed version. |
| **Upgrade plugin version (chart / images)** | **Clusters → \<cluster\> → Functional Components** → top **Upgrade** button | Pulls the newer version from the chart repository and performs the actual upgrade. |

Two details that catch users:

- **The Update form shows install-time fields as read-only.** Fields like
  `Install Namespace` are decided at install time and cannot be changed
  online, but the Update form lists them as read-only labels so you can
  confirm the current values without leaving the page. The plugin detail
  page (third row above) shows the same information together with version
  metadata, useful when you need a single full-panel view.
- **Update cannot upgrade the version.** Update reuses the currently
  installed chart version; it only reconciles. To pull a new version, use
  the **Upgrade** button under Functional Components.

The remaining sections of this chapter group recipes by common needs.
Each recipe has been validated against an ACP cluster, with three parts:
**When to use → YAML → Expected effect**. Copy and paste into the
appropriate field as needed.

### Recipe 1: Custom ServiceAccount for in-cluster jobs

**When to use:** the workflow runs `kubectl apply -f manifest.yaml` or calls
the cluster API. The default SA only carries the baseline permissions needed
by runner container hooks; it is not the same thing as the business RBAC your
workflow actually needs.

First create an SA in the install namespace and bind permissions
(`my-runner-sa` is the example name; rename per your conventions):

```shell
$ kubectl create serviceaccount my-runner-sa -n arc-runners

# Recommended: enumerate exactly the verbs the workflow needs in a
# namespace-scoped Role, then bind it to the SA. The example below
# allows the workflow to list/get pods, read pod logs, and `kubectl
# exec` into pods within the arc-runners namespace.
$ cat <<EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-runner-sa-role
  namespace: arc-runners
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create"]
EOF

$ kubectl create rolebinding my-runner-sa-binding \
    --role=my-runner-sa-role \
    --serviceaccount=arc-runners:my-runner-sa \
    -n arc-runners
```

If the workflow needs to manage deployments, CRDs, or cross-namespace
resources, extend the Role's `rules:` with those specific verbs (or
switch to a ClusterRole + ClusterRoleBinding for cross-namespace use,
still listing concrete resources). **Do NOT bind `ClusterRole/edit`
directly** — `edit` includes read/write on Secrets, mutating ConfigMaps,
deleting Deployments, and other high-impact verbs, which effectively
hands the entire namespace's write surface to anyone who can modify a
workflow YAML in the GitHub repository.

Then point the runner pod at this SA via Extra Chart Values:

```yaml
template:
  spec:
    serviceAccountName: my-runner-sa
```

**Expected effect:** the runner pod uses `my-runner-sa` instead of the
chart default `<release>-gha-rs-kube-mode`. `kubectl` calls inside the
workflow authorize against `my-runner-sa`'s RBAC.

> **Warning — be careful in kubernetes / kubernetes-novolume modes.** In
> these modes, the default `<release>-gha-rs-kube-mode` SA is not a blank
> SA; it carries the runner-container-hooks baseline permissions for
> `pods`, `pods/exec`, `pods/log`, `secrets`, and, in `kubernetes` mode,
> `jobs`. If you replace it with your own SA, you must add back the
> permissions your workflows still need; otherwise container-hook-backed
> flows (such as `container:` jobs, log access, or k8s-mode job / secret
> operations) will fail.
>
> Also note that having this default SA baseline does **not** mean it
> already carries the business permissions your workflows need. Whether
> it can read Tekton Pipelines, create PipelineRuns, or access resources
> in other namespaces still depends on what extra RBAC is bound in the
> environment. The safest approach remains preparing an explicit custom
> SA for the workflow scenario and validating it once with
> `kubectl auth can-i`.
>
> **Known issue (current baseline):** in `kubernetes` /
> `kubernetes-novolume` mode, if you **temporarily** switch
> `template.spec.serviceAccountName` to a custom SA and later clear the
> field or switch back to the default path, the platform / upstream cleanup
> flow can leave the generated default
> `<scaleset>-gha-rs-kube-mode` `ServiceAccount` / `Role` / `RoleBinding`
> stuck in `Terminating` (`metadata.deletionTimestamp` remains set and the
> finalizer is still `actions.github.com/cleanup-protection`). When this
> happens, later workflows that depend on the default SA may fail with
> `HTTP-Code: 401 Unauthorized` during `container:` job initialization, or
> `kubectl auth can-i` from inside the runner container may return `error`
> directly. If this runner pool needs long-lived in-cluster access, prefer
> keeping an explicit custom SA in place instead of switching back and
> forth between the default SA and a custom one. If you do switch back to
> the default SA, review the known issue note later in this chapter and
> validate that the default kube-mode resources were recreated cleanly.

#### Permission model notes

**Scope.** The SA configured via `template.spec.serviceAccountName` is at
**runner pod level**, meaning **all workflows under one scale-set instance
share the same SA and its RBAC**. The actual resources the SA can access
are determined by the Role / ClusterRole binding you grant it — the example
above (`--role=my-runner-sa-role` + `rolebinding -n arc-runners`) is
namespace-scoped.

For production, follow least privilege:

- **Prefer Role + RoleBinding** (namespace-scoped, limited to the runner
  install namespace) over ClusterRole / ClusterRoleBinding (cluster-scoped).
- Define a custom Role listing exactly the resources / verbs the workflow
  needs; do not directly bind broad ClusterRoles like `cluster-admin` or
  `edit`.

**Can different workflows use different SAs?** Under the current
architecture, the runner pod's SA is fixed by plugin-level config — **all
workflows under one scale-set instance share the same SA**. If you need
per-workflow permission separation, common approaches:

- Inside the workflow, use `kubectl --token=...` or mount a kubeconfig
  explicitly pointing at another SA's token, bypassing the pod default.
- Move permission-sensitive steps to triggering a Tekton PipelineRun
  ([Example 2](#example-2-trigger-an-in-cluster-tekton-pipeline-from-a-workflow));
  inside the PipelineRun, individual Tasks use their own SAs.
- On the GitHub side, use
  [environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
  / branch protection to limit which workflows can use this runner pool.

### Recipe 2: Inject secrets / custom env into runner

**When to use:** the workflow needs to access a private npm registry, a
private Maven repo, a backend API, or any other resource requiring secrets.

First create the Secret in the install namespace (e.g. `npm-credentials`),
then write into Extra Chart Values:

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>           # required — see Chapter 3 array warning
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                          # required for kubernetes-novolume / dind modes
      - name: NPM_TOKEN
        valueFrom:
          secretKeyRef:
            name: npm-credentials
            key: token
            optional: true                      # true: pod start is not blocked if the Secret is briefly missing during rotation
      - name: BUILD_PROFILE
        value: production
```

**Expected effect:** every runner pod's runner container reads
`$NPM_TOKEN` and `$BUILD_PROFILE`. Because helm replaces the entire
`containers` array (see [Chapter 3 array warning](#chapter-3-customizing-runners-via-extra-values)),
the chart-default `ACTIONS_RUNNER_*` env entries are dropped — the
chart's runner-container helper auto-supplies `ACTIONS_RUNNER_POD_NAME`
and `ACTIONS_RUNNER_CONTAINER_HOOKS` when missing, but
`ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` defaults to `"true"` and must be
overridden as shown above.

### Recipe 3: Pin runners to dedicated nodes

**When to use:** the cluster has dedicated nodes for CI runners (e.g. labeled
`workload=arc-runner` and tainted `arc-dedicated:NoSchedule`); other
workloads should not land on these nodes.

**Extra Chart Values** (on the scale-set plugin form):

```yaml
template:
  spec:
    nodeSelector:
      workload: arc-runner
    tolerations:
    - key: arc-dedicated
      operator: Exists
      effect: NoSchedule
```

**Expected effect:** runner pods schedule only on nodes labeled
`workload=arc-runner` and tolerate `arc-dedicated:NoSchedule` taints. If no
such nodes exist, the runner pod stays Pending with a `FailedScheduling`
event — useful for "reverse-verifying the rule actually applied".

### Recipe 4: Limit CPU / memory of runners

**When to use:** prevent a single runner pod from consuming all node
resources, or to integrate with ResourceQuota.

**Extra Chart Values:**

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>      # required — see Chapter 3 array warning
      command: ["/home/runner/run.sh"]     # required — chart does not auto-supply
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                     # required for kubernetes-novolume / dind modes
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: "4"
          memory: 8Gi
```

**Expected effect:** every EphemeralRunner pod's runner container carries
the specified resources.

> **Warning — two details:**
>
> - `command: ["/home/runner/run.sh"]` must be kept. Helm replaces arrays
>   wholesale (see the array warning at the top of this chapter); omitting
>   this line lets the pod start but the runner container falls back to
>   the image default entrypoint instead of `run.sh`, which means the
>   runner process never starts and workflows stay Queued.
> - **Quote integer CPU values:** `cpu: "4"`, not `cpu: 4`. The bare-number
>   form is accepted by Kubernetes, but some clients reject it on
>   re-serialization. Always use double quotes.

### Recipe 5: Spread runners across nodes

**When to use:** prevent all 20 runners from piling onto one node when
`maxRunners=20`; or HA deployment across multi-AZ clusters.

**Extra Chart Values:**

```yaml
template:
  spec:
    affinity:
      podAntiAffinity:
        preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                actions.github.com/scale-set-name: my-runners   # your runnerScaleSetName
            topologyKey: kubernetes.io/hostname
    topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          actions.github.com/scale-set-name: my-runners
```

**Expected effect:** the scheduler prefers spreading runner pods across
different hostnames; falls back to scheduling on the same node when
necessary (soft anti-affinity).

> **Note:** For hard spreading (refuse to schedule when nodes are
> insufficient), change `preferredDuringSchedulingIgnoredDuringExecution`
> to `requiredDuringSchedulingIgnoredDuringExecution` and
> `whenUnsatisfiable` to `DoNotSchedule`.

### Recipe 6: Mount maven cache / extra ConfigMap / CA bundle

**When to use:** speed up Maven builds with a shared `.m2` PVC; inject
extra-cluster CA certificates; share other ConfigMap / Secret files.

Create the PVC / ConfigMap in the install namespace first, then write into
Extra Chart Values:

```yaml
template:
  spec:
    containers:
    - name: runner
      image: <runner-extension-image>      # required — see Chapter 3 array warning
      command: ["/home/runner/run.sh"]
      env:
      - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
        value: "false"                     # required for kubernetes-novolume / dind modes
      volumeMounts:
      - name: maven-repo
        mountPath: /home/runner/.m2
      - name: ca-bundle
        mountPath: /etc/ssl/extra-ca/ca.crt
        subPath: ca.crt
        readOnly: true
    volumes:
    - name: maven-repo
      persistentVolumeClaim:
        claimName: maven-cache-pvc         # create this PVC in arc-runners first
    - name: ca-bundle
      configMap:
        name: extra-ca-bundle              # create this ConfigMap in arc-runners first
```

**Expected effect:** runner pods mount the Maven cache and the CA file at
the specified paths. Your volumes coexist with chart-managed defaults
(such as the `dind-sock` volume in DinD mode or the `work` PVC in
kubernetes mode).

> **Note:** if the PVC's StorageClass uses `volumeBindingMode:
> WaitForFirstConsumer` (commonly used by local-disk-backed SC
> implementations, e.g. some TopoLVM deployments), the PVC stays
> `Pending` until the first runner pod consumes it. This is expected
> behavior, not a misconfiguration — `kubectl describe pvc maven-cache-pvc`
> will show `waiting for first consumer to be created before binding`.

### Recipe 7: Kubernetes mode with persistent work volume

**When to use:** the workflow needs
[container-job](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#jobsjob_idcontainer),
`actions/cache@v4`, or other capabilities that require a PVC inside the
runner.

**Three configuration steps:**

1. **Leave the Container Mode form field empty** so the plugin does not
   render a `containerMode:` block.
2. Write the full `containerMode:` block in Extra Chart Values:
   ```yaml
   containerMode:
     type: kubernetes
     kubernetesModeWorkVolumeClaim:
       storageClassName: <existing-sc-name>      # e.g. sc-topolvm
       accessModes: [ReadWriteOnce]
       resources:
         requests:
           storage: 1Gi
   ```
3. Save.

**Expected effect:** for every EphemeralRunner pod, Kubernetes creates a
generic ephemeral PVC `<pod-name>-work` mounted at `/home/runner/_work`,
cleaned up when the pod is deleted. The Scale-Set plugin chart provides
two helpers — `kubernetes-mode-runner-container` and
`kubernetes-novolume-mode-runner-container` (both in
`gha-runner-scale-set/templates/_helpers.tpl`) — that inject
`ACTIONS_RUNNER_CONTAINER_HOOKS` into the runner container whenever
`containerMode.type` is `kubernetes` or `kubernetes-novolume`, pointing
to the corresponding hook script (default `/home/runner/k8s/index.js` or
`/home/runner/k8s-novolume/index.js`).

#### Demo workflow: verify the workspace PVC is read-write

After `kubernetesModeWorkVolumeClaim` is set, you do not need to reference
this StorageClass explicitly in the workflow YAML — ARC creates a temporary
PVC for each runner pod automatically and mounts it at
`/home/runner/_work`. The following workflow verifies the workspace lands
on the PVC and that files persist across steps:

```yaml
name: K8s Mode Persistent Work Volume Demo

on:
  workflow_dispatch:

jobs:
  pvc-smoke:
    # Alauda-validated path: runs-on uses the single-string form
    runs-on: my-runners
    steps:
      - name: inspect workspace mount
        run: |
          set -eux
          POD_NAME="${ACTIONS_RUNNER_POD_NAME:-${HOSTNAME:-$(cat /proc/sys/kernel/hostname 2>/dev/null || echo unknown)}}"
          echo "runner_name=${RUNNER_NAME:-unset}"
          echo "pod_name=${POD_NAME}"
          echo "workspace=${GITHUB_WORKSPACE}"
          id
          pwd
          mkdir -p "${GITHUB_WORKSPACE}"
          ls -ld "${GITHUB_WORKSPACE}"
          ls -ld /home/runner/_work
          # df proves workspace lands on a separate mount (not the container rootfs);
          # the write + read-back steps below prove the mount is writable and stable.
          df -h "${GITHUB_WORKSPACE}"
          df -h /home/runner/_work
          # mountinfo gives the source device (most authoritative); fall back to mount / proc/mounts
          grep " /home/runner/_work " /proc/self/mountinfo || \
            mount | grep -E "(/__w/|/home/runner/_work|${GITHUB_WORKSPACE})" || \
            cat /proc/mounts | grep -E "(/__w/|/home/runner/_work|${GITHUB_WORKSPACE})"

      - name: write payload into workspace PVC
        run: |
          set -eux
          DEMO_DIR="${GITHUB_WORKSPACE}/pvc-demo"
          mkdir -p "${DEMO_DIR}"
          # timestamp file: used in step 3 to prove cross-step persistence
          date -u +%FT%TZ > "${DEMO_DIR}/timestamp.txt"
          dd if=/dev/zero of="${DEMO_DIR}/payload.bin" bs=1M count=16 status=none
          sha256sum "${DEMO_DIR}/payload.bin" | tee "${DEMO_DIR}/payload.bin.sha256"
          sync
          ls -lah "${DEMO_DIR}"

      - name: read back payload from workspace PVC
        run: |
          set -eux
          DEMO_DIR="${GITHUB_WORKSPACE}/pvc-demo"
          test -s "${DEMO_DIR}/payload.bin"
          sha256sum -c "${DEMO_DIR}/payload.bin.sha256"
          # the timestamp written in step 2 is readable here, proving cross-step persistence on the PVC
          cat "${DEMO_DIR}/timestamp.txt"
          du -sh "${DEMO_DIR}"
          df -h "${GITHUB_WORKSPACE}"
```

**Expected on success:**

- `runner_name` / `pod_name` / `id` outputs can be matched against
  `kubectl -n arc-runners get pods` / `kubectl describe pod`.
- `GITHUB_WORKSPACE` lands at `/home/runner/_work/<repo>/<repo>`.
- `df -h ${GITHUB_WORKSPACE}` and `/proc/self/mountinfo` agree on a block
  device provided by your StorageClass (e.g. `/dev/topolvm/<volume-id>`,
  not the node-local overlay rootfs).
- 16 MiB file `pvc-demo/payload.bin` is written successfully.
- Step 3 `sha256sum -c` passes; `cat timestamp.txt` returns the UTC time
  from step 2 (proving cross-step persistence).
- `du -sh pvc-demo` shows about 17M.

> **Note:** This demo intentionally avoids `container:` and
> `actions/checkout` — the point of Recipe 7 is to verify the workspace is
> on persistent PVC, and the simpler the steps, the easier to reproduce.
> If you also want to verify a job container (`jobs.<id>.container`) works
> alongside, see [Example 1](#example-1-run-a-job-in-a-custom-container).

Observe the cluster-side PVC creation and cleanup:

```shell
# while the workflow runs
$ kubectl -n arc-runners get pvc
# expected: <runner-pod-name>-work   Bound   <storageClassName>   ...

# after the workflow finishes, the PVC is automatically released
$ kubectl -n arc-runners get pvc
# expected: no resources found (or only PVCs for other still-running workflows)
```

> **Note:** If a PVC stays `Pending`, most likely `storageClassName` is
> wrong or the SC does not support dynamic provisioning. List SCs with
> `kubectl get sc`, and inspect events with `kubectl describe pvc <name>`.

### Recipe 8: DinD mode (run docker build inside runner)

**When to use:** the workflow needs `docker build` / `docker push` / any
docker CLI calls.

> **Warning — DinD image is not bundled.** The install package does not
> include the DinD image (to avoid carrying upstream Docker CVEs into the
> Alauda patch bundle). You must first sync the upstream
> `docker:<docker-tag>-dind` image into the platform registry, then point
> `global.images.dind.repository` / `tag` at it via Extra Global Values
> (see [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry)).

**Two configuration steps:**

1. **Sync and override the DinD image.** In the scale-set plugin's
   Extra Global Values, write:
   ```yaml
     images:
       dind:
         repository: <dind-path-inside-platform-registry>   # e.g. devops/actions/docker
         tag: <your-docker-dind-tag>                         # e.g. 28.0.4-dind
   ```
2. **On the form, set Container Mode to `dind`.**

**Expected effect:** every runner pod gains an init container
(`init-dind-externals`, exits after copying the docker CLI into a shared
volume), a sidecar (`dind`, runs the docker daemon), and the runner main
container. The runner container has `DOCKER_HOST=unix:///var/run/docker.sock`
pointing to the DinD sidecar; `docker build` calls inside the workflow
work directly.

> **Note:** On Kubernetes 1.29+, the upstream chart renders `dind` using the
> native sidecar semantics (so it appears under `initContainers` with
> `restartPolicy: Always`); on lower versions it usually appears as a regular
> sidecar container. The runtime intent is the same, so troubleshoot against
> the actual pod spec you see.

> **Note — safer alternative:** If your cluster forbids privileged pods, or
> you do not want to grant the runner pod full Docker daemon capability,
> see [Example 3](#example-3-advanced-buildah-daemonless-image-build-still-privileged) which
> uses Buildah rootless inside a regular job container.

### Recipe 9: Override ARC images (custom version / private registry)

**When to use:** the install package by default includes **controller** and
**runner-extension** images that match the plugin version, so the ACP
cluster **already supports air-gap by default** (controller + scale-set
just work). Override the images only in the following scenarios:

- Using DinD mode — **the DinD image is not bundled and must be
  overridden** (see [Recipe 8](#recipe-8-dind-mode-run-docker-build-inside-runner)).
- Using a newer upstream ARC version than the plugin ships (upgrading
  controller / runner-extension).
- Switching to a different DinD image (e.g. `docker:dind-alpine`).
- Security audit requires the image to come from a team's private registry
  sub-path.

**Prerequisites:**

1. **Sync the target image to the ACP platform registry first.** The path
   must match the `repository` field below. For example, if the snippet
   says `repository: devops/actions/docker` + `tag: dind-alpine`, you must
   push `docker:dind-alpine` to
   `<global.registry.address>/devops/actions/docker:dind-alpine` in the
   platform registry. Otherwise the runner pod hits ImagePullBackOff.
2. **Do not include a registry domain in `repository`.** The platform
   automatically prepends `global.registry.address`; the runner combines
   the prefix at pull time.
3. **`tag` must actually exist in the platform registry.** The
   `<your-target-tag>` placeholder below must be replaced with your actual
   target tag. The current chart version is visible on the cluster plugin
   detail page; the ARC three-image set's tags align with the chart
   version.

**Configuration:** write one of the snippets below into the **Extra Global
Values** field.

> **Warning — leading 2 spaces required.** All YAML in this recipe goes
> into the **Extra Global Values** field (embedded under `global:`). The
> field has no indent template helper and your content is inserted verbatim
> into a 2-space-indented context — **every line must start with 2 spaces**,
> or the install fails outright. Verify line by line before saving.

The two snippet groups A and B target the two plugins respectively. Pick
the right group and paste into that plugin's Extra Global Values
(it is **not** either-or; each plugin manages its own).

#### A — Controller plugin

The controller plugin accepts one image key (`controller`).

Tag override only (the most common upgrade scenario):

```yaml
  images:
    controller:
      repository: devops/actions/gha-runner-scale-set-controller
      tag: <your-target-tag>          # target ARC version tag, must already be synced to the platform registry
```

Or override `repository` as well (team private registry sub-path / security
audit):

```yaml
  images:
    controller:
      repository: my-team/private-mirror/gha-runner-scale-set-controller
      tag: <your-target-tag>
```

#### B — Scale-set plugin

The scale-set plugin accepts two image keys:

- **`runnerExtension`** — runner main image; **bundled** in the install
  package; override only when upgrading the version or switching the image
  source.
- **`dind`** — DinD sidecar image; **not bundled** (see
  [Recipe 8](#recipe-8-dind-mode-run-docker-build-inside-runner)
  prerequisites). Write this section only when DinD mode is enabled, and
  the image must already be synced to the platform registry.

Tag override only:

```yaml
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
```

When DinD mode is enabled (append to the `images:` block above):

```yaml
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
    dind:
      repository: <dind-path-inside-platform-registry>     # e.g. devops/actions/docker
      tag: <your-docker-dind-tag>                          # e.g. 28.0.4-dind
```

Or override everything to a team private registry sub-path:

```yaml
  images:
    runnerExtension:
      repository: my-team/private-mirror/gha-runner-scale-set-runner-extension
      tag: <your-target-tag>
    dind:
      repository: my-team/private-mirror/docker
      tag: <your-docker-dind-tag>
```

**Expected effect:** controller / listener / runner / dind images are
pulled from your specified path inside the platform registry.

> **Warning — `registry:` sub-key cannot be written.** The platform already
> renders `global.registry`. Writing `  registry:` (2-space indent inside
> EGV) is silently dropped; no error is reported but your override has no
> effect.

---

## Chapter 4. Multi-Team / Multi-Project Isolation

Through the ACP **cluster-plugin entry**, each plugin supports only **one
default instance per cluster**. That means the plugin-install path is not the
right fit when you want multiple isolated runner pools on one cluster. For
team / project isolation, choose one of the following:

### Quick decision guide

Start with one question: **can all teams / projects share the same runner
runtime identity** (same ServiceAccount, same node pool, same GitHub
credential)?

- **Yes** → pick **Method 1**: install a single ARC and use GitHub
  runner-group policies to narrow access. Nothing changes on the ACP side.
- **No, and teams already use separate clusters** → pick **Method 2**:
  install one set of plugins per cluster; resources / network / nodes are
  isolated by construction.
- **No, but only one cluster is available** → pick **Method 3**: install
  the upstream chart multiple times via ACP **Catalog → Helm Chart**.
- **Repositories accept fork PRs / external contributions** → regardless
  of the choice above, run a **separate** runner pool for those repositories
  so they do not share secrets / SA with the main pool (see item 4 of the
  security checklist later in this chapter).

| Isolation goal | Who configures it | Recommended | Isolation granularity |
|---|---|---|---|
| "Only these repos / workflows may dispatch to this pool"; all workflows can share one SA / credential / node pool | GitHub admin (org → Settings → Actions → Runner groups; enterprise → Policies → Actions → Runner groups) | **Method 1** | GitHub-side authorization only; runtime still shared |
| Team A and team B already use different ACP clusters | ACP admin (install controller + scale-set plugin in each cluster) | **Method 2** | Cluster-level (resource / network / node fully independent) |
| Single cluster but need multiple independent runner pools (different GitHub URL / credential / SA / node pool) | ACP admin (install upstream chart multiple times via Catalog → Helm Chart) | **Method 3** | Multi-instance within one cluster |

### Method 1: One ARC instance, narrow access with GitHub runner groups (recommended)

Bind a single scale-set instance to an org-level or enterprise-level
`githubConfigUrl`, then use GitHub **runner group** policies to define
who may use that runner pool.

- **GitHub App / PAT are ARC authentication methods.** They decide how ARC
  talks to the GitHub API, registers runners, and acquires jobs; they do
  **not** by themselves define which repositories / workflows may use the
  runner pool.
- **Organization runners**: in GitHub **Settings → Actions → Runner
  groups**, place the runners in a dedicated runner group and narrow
  access with `Selected repositories` / `Selected workflows`.
- **Enterprise runners**: in GitHub enterprise **Policies → Actions →
  Runner groups**, first narrow access with `Selected organizations` /
  `Selected workflows`; if the enterprise runner group is shared to an
  organization, the organization owners can further narrow repository /
  workflow access where applicable.

This method solves the **GitHub-side usage boundary** of a shared runner
pool. It does **not** provide runtime isolation such as separate nodes or
namespaces. If your main goal is "only these repositories / workflows may
dispatch to this pool," this is usually the right first choice.

> **About GitHub App and enterprise runners:** GitHub does not accept a
> GitHub App for enterprise-level runner registration (see
> [Permission Requirements](#permission-requirements)); ARC must use a
> Classic PAT with `manage_runners:enterprise` instead. Even then, the
> control of "which organizations / workflows may use this runner pool"
> should still be handled primarily by runner-group policy, not by the
> PAT itself.

### Method 2: Multi-cluster ARC deployment (strong isolation)

Team A uses cluster A, team B uses cluster B. **Each cluster installs its
own controller plugin + scale-set plugin**, with separate
`runnerScaleSetName`, separate `githubConfigUrl`, and separate GitHub
credential Secret. Runner pools live in their own clusters with full
resource / network / node isolation. Suitable when teams already deploy
separate clusters for business / security reasons — single-cluster
"one scale-set plugin only" does not affect **cross-cluster** multi-instance
deployment.

### Method 3: Direct Helm chart deployment (special needs)

If you require strong isolation but want only one cluster, deploy
multiple independent ARC instances through the platform's
**Catalog → Helm Chart** entry (not the Marketplace cluster-plugin
entry) by installing the upstream `gha-runner-scale-set` chart — the
entire flow stays within the ACP UI; **no `helm` CLI required**. This
path **does not offer the form-based configuration fields** of the
cluster-plugin path (such as "Container Mode" and "GitHub URL"
dropdowns); all parameters must be set in the chart values (YAML), and
upgrades / parameter changes happen via the corresponding instance in
the Catalog.

> **Note — label routing is not a substitute for real multi-instance.**
> The upstream chart supports `scaleSetLabels` + array-form `runs-on:`,
> letting one scale-set respond to multiple label names (usage and the
> install-time-only constraint covered in
> [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels))
> — but every matched workflow still runs on the **same** scale-set
> instance, sharing one controller, one SA / RBAC, and one GitHub
> credential. If you actually want "team A's workflow cannot touch team
> B's resources" **runtime isolation**, label routing does not solve it;
> you normally need Method 2 / 3 above. Method 1 only controls who may
> use the runner pool on the GitHub side.

### Security checklist

Before running ARC in production, walk through the four items below.
Each is also covered in scattered Recipes / Examples; this checklist is
just a consolidated audit reference.

- **`githubConfigUrl` scope = registration boundary; runner-group policy =
  actual usage boundary.** The wider the `githubConfigUrl`, the broader
  the GitHub-side registration boundary for ARC. The real control of
  "which repositories / workflows may use this pool" should come from
  runner-group policy: `Selected repositories` / `Selected workflows`
  (and `Selected organizations` for enterprise runners). With an
  enterprise- or org-level `githubConfigUrl` plus a shared SA, **any
  workflow author who is allowed into that runner group** can run code on
  this pool. Narrow both the `githubConfigUrl` and the runner-group
  policy together.
- **A custom SA hands cluster privileges to workflow authors.** Once
  [Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)
  attaches a custom SA to the runner, **anyone who can edit a workflow
  YAML** inherits the SA's full RBAC. **Do not** bind broad roles like
  `ClusterRole/edit`; grant verbs per workflow demand (see the
  minimum-privilege Role example in Recipe 1).
- **DinD / privileged Buildah only for controlled repositories.**
  [Recipe 8 (DinD)](#recipe-8-dind-mode-run-docker-build-inside-runner)
  and [Example 3 (Buildah)](#example-3-advanced-buildah-daemonless-image-build-still-privileged)
  give the runner root or a wider container-escape surface. **Only let
  trusted internal repositories** target this runner pool; route
  open-contribution repositories to a separate, non-privileged
  scale-set.
- **Isolate the runner pool for fork PRs / external contributions.**
  GitHub triggers such as `pull_request_target` allow external PRs to
  run code in the main branch's secrets / SA context, which is a known
  supply-chain attack surface. If your repository accepts external
  contributions, **provision a separate runner pool** (via Method 2 /
  Method 3 above) for them and do not share the main runners' secrets
  or SA.

---

## Chapter 5. Workflow Examples

The following three examples cover common workflow patterns using
runner-bundled tools or native GitHub Actions capability. All YAML can be
copy-pasted as-is — replace `my-runners` with your `runnerScaleSetName`
and replace image paths with images reachable from your cluster.

> **Note:** Examples are for reference; adjust workflow structure to your
> project's needs.

### Example 1: Run a job in a custom container

**When to use:** the default runner image lacks a runtime (e.g. you need
Maven, a specific JDK version); you do not want to modify the runner
image; you also do not want DinD. GitHub Actions native
[`jobs.<id>.container`](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container)
field works fully under ACP scale-set mode — ARC uses
runner-container-hooks to dynamically create the corresponding job pod /
Kubernetes job in the runner namespace, and the steps execute in that
container environment rather than by simply adding a sidecar inside the same
runner pod. **This pattern requires the scale set to use
`kubernetes-novolume` (default) or `kubernetes` container mode; `dind` does
not support the GHA `container:` field.**

**Full workflow:**

```yaml
name: Container Job Example
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  container-job:
    runs-on: my-runners
    container:
      image: docker.io/library/ubuntu:24.04
    steps:
      - name: identify the container
        # Avoid depending on whether the job container image happens to
        # ship `hostname`; use the shell built-in ${HOSTNAME} instead.
        run: |
          echo "runner_name: ${RUNNER_NAME:-unknown}"
          echo "hostname:    ${HOSTNAME:-unknown}"
          echo "workspace:   ${GITHUB_WORKSPACE:-unknown}"
          cat /etc/os-release
          echo "whoami:      $(whoami)"
          id
```

**Expected effect:** the job's steps run inside the `ubuntu:24.04`
container environment, leaving the runner main container untouched. On the
cluster side, you will usually see extra job pod / Kubernetes job resources
for that workflow job.

#### Extra permissions / credentials for the job container

- **Access cluster API (`kubectl` inside the container):** the job
  container inherits the runner pod's ServiceAccount by default
  (Kubernetes auto-mounts the SA token at
  `/var/run/secrets/kubernetes.io/serviceaccount/`). For a custom SA on
  the runner pod, see
  [Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs).
  Note that the `image:` referenced **must include the `kubectl` binary**
  — the community `ubuntu:24.04` does not; use an image that bundles
  `kubectl`, or download it on the fly inside a step.
- **Pull from a private registry:** the job container's image pull still
  depends on the runner-side image pull credential path. In the current
  Alauda plugin install path, the supported runner-side routes are the
  platform-injected `global.registry.imagePullSecrets`, or attaching
  credentials indirectly via a custom SA. The upstream chart does pass
  `template.spec.imagePullSecrets` through to the runner pod spec, but this
  document does not treat that path as the primary validated / recommended
  plugin-install route; if you use it, verify the rendered spec and the
  actual pull behavior on your target cluster.
- **Inject business credentials:** prefer putting `${{ secrets.X }}` in a
  step-level `env:` block (or `jobs.<id>.env` if multiple steps share it);
  reserve `container.env` for non-sensitive constants. In ARC's Kubernetes
  container mode, passing secrets through step `env:` is the more reliable
  path. For example:

  ```yaml
  jobs:
    container-job:
      runs-on: my-runners
      container:
        image: docker.io/library/ubuntu:24.04
        env:
          APP_REGION: cn-north-1
      steps:
        - name: use business secret
          env:
            NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          run: |
            echo "region=$APP_REGION"
            echo "token length=${#NPM_TOKEN}"
  ```

> **Warning — Container Mode requirement.** This pattern requires
> `kubernetes-novolume` (default) or `kubernetes` (Recipe 7). The
> `dind` mode does not support GHA's `container:` field.
>
> **Warning — air-gap.** The `image:` you specify must be a path the
> platform image registry or cluster can pull.
> `docker.io/library/ubuntu:24.04` is usually unreachable in internal
> clusters — replace with the corresponding image you have already synced
> to the platform registry.

### Example 2: Trigger an in-cluster Tekton Pipeline from a workflow

**When to use:** GitHub Actions handles trigger and orchestration;
Tekton runs the actual heavy work (build, test, deploy) on the cluster.
Real deployments keep the Tekton `Pipeline` resource in the cluster as a
versioned, reusable definition; the workflow only creates a fresh
`PipelineRun` referencing it.

**Prerequisites:**

- **Tekton Pipelines is deployed in the cluster.** This example assumes
  the `tekton.dev/v1` CRDs (`Pipeline` / `PipelineRun` / `Task` /
  `TaskRun`) are installed. On ACP, install via the ACP DevOps module
  or upstream
  [tektoncd/pipeline](https://github.com/tektoncd/pipeline). Without it
  the `kubectl apply` below returns
  `no matches for kind "Pipeline" in version "tekton.dev/v1"`.
- **Runner pod uses a ServiceAccount with Tekton operation permissions.**
  Use [Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)
  to create a custom SA (e.g. `my-runner-sa`), then bind the following
  Role for creating / tracking PipelineRuns:

  ```shell
  $ kubectl apply -n arc-runners -f - <<'EOF'
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: tekton-pipelinerun-runner
  rules:
  - apiGroups: ["tekton.dev"]
    resources: ["pipelines"]                  # `tkn pipeline start` GETs the Pipeline first to discover its params
    verbs: ["get", "list", "watch"]
  - apiGroups: ["tekton.dev"]
    resources: ["pipelineruns"]
    verbs: ["create", "get", "list", "watch"]
  - apiGroups: ["tekton.dev"]
    resources: ["taskruns"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: my-runner-sa-tekton
  subjects:
  - kind: ServiceAccount
    name: my-runner-sa
    namespace: arc-runners
  roleRef:
    kind: Role
    name: tekton-pipelinerun-runner
    apiGroup: rbac.authorization.k8s.io
  EOF
  ```

  The role grants **read** on Pipelines (so `tkn pipeline start` can
  resolve the Pipeline's params), **create + read** on PipelineRuns, and
  **read** on TaskRuns plus pods, and **get** on pod logs (so
  `tkn pipeline start --showlog` and `tkn pr logs -f` can tail the run).
  This document's scenario does not require `create` on TaskRuns. Without the
  Pipelines read rule,
  `tkn pipeline start` fails with
  `Pipeline name <pipeline> does not exist in namespace <ns>` — even
  though the Pipeline is present from a cluster-admin perspective.

- **Pre-create a minimal Pipeline in the cluster.** Apply the manifest
  below. By default everything lives in `arc-runners` (the same
  namespace as the runner pod, avoiding cross-namespace RBAC). To use a
  different namespace, replace `arc-runners` here and in the workflow
  `env` block.

  > **Note:** The `image:` below uses `docker.io/library/busybox:1.36`
  > for the demo. **For air-gap clusters, replace it with a path your
  > platform registry can pull** before applying.

  ```shell
  $ kubectl apply -n arc-runners -f - <<'EOF'
  apiVersion: tekton.dev/v1
  kind: Pipeline
  metadata:
    name: gh-trigger-demo
  spec:
    params:
    - name: git-url
      type: string
    - name: git-revision
      type: string
    tasks:
    - name: greet
      params:
      - name: git-url
        value: $(params.git-url)
      - name: git-revision
        value: $(params.git-revision)
      taskSpec:
        params:
        - name: git-url
          type: string
        - name: git-revision
          type: string
        steps:
        - name: echo
          image: docker.io/library/busybox:1.36   # air-gap: replace with an internally-reachable image
          script: |
            #!/bin/sh
            echo "triggered for $(params.git-url) @ $(params.git-revision)"
  EOF
  ```

  In real deployments this Pipeline would be a full build-and-deploy
  flow (`git-clone` → `buildah` → `kubectl-deploy` etc.).

**Full workflow:**

```yaml
name: Trigger Tekton PipelineRun
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  trigger-tekton:
    runs-on: my-runners
    steps:
      - name: start tekton pipeline
        # `env` carries the platform-specific values for this trigger.
        # Defaults match the prerequisites above; override here (or
        # promote to GitHub repo variables for multi-pipeline use).
        env:
          TEKTON_NS: arc-runners
          PIPELINE_NAME: gh-trigger-demo
          GIT_URL: ${{ github.server_url }}/${{ github.repository }}
          GIT_SHA: ${{ github.sha }}
        run: |
          # Use the runner-bundled `tkn` CLI to start the pipeline.
          # `tkn pipeline start` creates a PipelineRun (with a server-
          # generated name); `--showlog` tails its logs until the run
          # completes — replacing manifest rendering, kubectl create,
          # and a separate `tkn pr logs -f` step.
          tkn pipeline start "${PIPELINE_NAME}" \
            -n "${TEKTON_NS}" \
            -p git-url="${GIT_URL}" \
            -p git-revision="${GIT_SHA}" \
            --showlog
```

**Expected effect:** `tkn pipeline start` creates a `PipelineRun`
referencing the in-cluster `gh-trigger-demo` Pipeline; the Tekton
controller resolves `pipelineRef.name` to the current Pipeline spec and
runs it. `--showlog` tails the run's logs back to the GitHub Actions
console; when the PipelineRun finishes the step exits with the
PipelineRun's success status. **The Pipeline definition lives in the
cluster, owned by your platform team; the workflow is just a thin
trigger using the runner image's bundled CLI.**

> **Note — why `tkn pipeline start` instead of `kubectl create -f`?**
> The runner image bundles `tkn`; `tkn pipeline start` covers the entire
> "create a PipelineRun + tail its logs" flow in one command, with no
> need to render a YAML manifest, juggle `metadata.generateName`, or
> chain a separate `tkn pr logs -f`. The RBAC requirement remains the
> minimal Role listed above: read on Pipelines, create + read on
> PipelineRuns, read on TaskRuns plus pods, and get on pod logs, so
> Recipe 1's custom SA still applies. Use `tkn pipeline start --help` to discover
> `--serviceaccount`, `--workspace`, `--use-param-defaults`, and other
> flags as your real Pipeline grows.

### Example 3 (advanced): Buildah daemonless image build (still privileged)

**When to use:** the workflow needs `buildah build` / `docker build` style
operations, but you do not want to enable DinD
([Recipe 8](#recipe-8-dind-mode-run-docker-build-inside-runner) requires
a privileged sidecar). Buildah rootless can build inside a regular job
container, friendlier to cluster security policy. Here **rootless** means the
Buildah process itself runs as a non-root user inside the container; it does
**not** automatically mean the whole job pod is free from extra capabilities /
privileged requirements.

**Key challenge:** Buildah rootless inside a container needs a non-root
writable storage path that does not collide with the host's root-owned
default. Redirecting `CONTAINERS_STORAGE_CONF` to `/tmp` works around it.

**Prerequisite:** in your GitHub repo, **Settings → Secrets and variables
→ Actions**, create two repository secrets: `REGISTRY_USERNAME` and
`REGISTRY_PASSWORD` for your platform registry login (used to push the
build artifact).

This example also relies on GHA's `container:` field, so it applies only
to `kubernetes-novolume` (default) or `kubernetes` mode; `dind` does not
support it.

**Full workflow** (community Buildah image + generic secret names):

```yaml
name: Buildah Rootless Example
on:
  workflow_dispatch:

jobs:
  build:
    runs-on: my-runners
    container:
      image: quay.io/buildah/stable:latest
      options: --privileged
      env:
        STORAGE_DRIVER: vfs
        BUILDAH_ISOLATION: chroot
        # redirect buildah storage to /tmp (mode 1777, writable to non-root)
        HOME: /tmp
        CONTAINERS_STORAGE_CONF: /tmp/storage.conf

    steps:
      - name: prepare buildah storage config
        run: |
          mkdir -p /tmp/.buildah-root /tmp/.buildah-runroot
          cat > /tmp/storage.conf <<'EOF'
          [storage]
          driver = "vfs"
          runroot = "/tmp/.buildah-runroot"
          graphroot = "/tmp/.buildah-root"
          EOF

      - name: write Containerfile and build
        run: |
          mkdir -p /tmp/build && cd /tmp/build
          cat > Containerfile <<'EOF'
          FROM docker.io/library/alpine:3.20
          RUN echo "built by buildah at $(date -u)" > /built.txt
          EOF
          buildah bud --storage-driver vfs -t my-image:${{ github.sha }} .
          buildah images

      - name: push to your registry
        env:
          REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
        run: |
          buildah login -u "$REGISTRY_USERNAME" -p "$REGISTRY_PASSWORD" \
            --tls-verify=false my.registry.example.com
          buildah push --storage-driver vfs --tls-verify=false \
            my-image:${{ github.sha }} \
            my.registry.example.com/my/repo:${{ github.sha }}
```

**Notes:**

- `options: --privileged` — Buildah rootless still needs some
  capabilities; the simplest path is privileged. In other words,
  **rootless != unprivileged**: the process identity can be non-root while the
  pod still needs extra capabilities. For stricter production, grant only
  SYS_ADMIN, but the configuration is more complex.
- `HOME=/tmp` + `CONTAINERS_STORAGE_CONF=/tmp/storage.conf` — force
  Buildah's storage path to `/tmp` (which is mode 1777 inside the job
  container, writable to non-root).
- `STORAGE_DRIVER=vfs` + `BUILDAH_ISOLATION=chroot` — most-compatible
  storage / isolation combination for nested-container scenarios
  (performance is not the best, but compatibility is highest).
- The `image: quay.io/buildah/stable:latest`,
  `docker.io/library/alpine:3.20` paths above are community paths.
  **Air-gap clusters must first sync these images to the platform registry
  and update `image:` to the corresponding internal path**, or pods will
  not start.
- `quay.io/buildah/stable:latest` is acceptable for a demo, but not as a
  long-term reproducible documentation recommendation. For real adoption,
  switch it to a fixed tag (or digest) that your team has validated and
  mirrored into the internal registry.

> **Warning — for demonstration; not recommended for production as is.**
> The combination `--privileged` + `STORAGE_DRIVER=vfs` +
> `BUILDAH_ISOLATION=chroot` is the most compatible and easiest to set up,
> but:
>
> - On clusters with PSA `restricted` / OpenShift SCC `restricted`
>   policies, `--privileged` is rejected by admission and this workflow
>   cannot start.
> - The `vfs` storage driver is slow; complex builds will be slow.
> - Air-gap image building still requires handling base image path
>   substitution, registry credential injection, caching, and so on.
>
> **Production recommendation:** push image-building tasks **down to ACP's
> Tekton Pipelines** (use [Example 2](#example-2-trigger-an-in-cluster-tekton-pipeline-from-a-workflow)
> pattern; from the GitHub workflow, `tkn pipeline start` triggers a
> PipelineRun containing a Buildah / Kaniko Task). The Tekton community's
> buildah / kaniko Tasks have more mature handling of permission
> boundaries, caching, and signing than ad-hoc Buildah inside a GHA
> workflow.

---

## Chapter 6. Troubleshooting

Issues are ordered by **frequency observed in customer deployments**, most
common first.

> **Note:** Commands in this chapter assume the controller namespace is
> `arc-systems` and the scale-set namespace is `arc-runners`. If your
> deployment uses custom namespaces, rewrite the commands first and then
> compare the observed behavior.

### Issue 1: Install fails — chosen Install Namespace does not exist

**Symptoms:** in the platform UI, after installing the controller plugin
or scale-set plugin, the plugin instance does not reach `Installed` after
a few seconds; the detail page shows
`namespaces "<your-ns>" not found`.

**Cause:** the namespace specified in the Install Namespace form field
does not exist on the target cluster, and the platform does not create
it for you.

**Resolution:** create the namespace first, then install. Two ways:

```shell
# Option 1: kubectl
$ kubectl create ns arc-systems   # for controller plugin
$ kubectl create ns arc-runners   # for scale-set plugin
```

Or pre-create on the platform UI: Cluster → Namespaces page.

> **Note — The two plugins live in separate namespaces.** By default the
> controller installs into `arc-systems` and the scale-set into
> `arc-runners` (these are ACP form defaults, not hard requirements —
> your actual deployment can use other names, e.g. `arc-controller-prod`
> / `team-a-runners`). If you change the defaults, **make sure the
> scale-set form's Controller Namespace field points at the controller's
> actual install namespace**; otherwise the scale-set points its
> controller-facing reference / RBAC at the wrong subject and the listener
> cannot be created or updated correctly.

### Issue 2: Listener pod fails to come up (Pending or CrashLoopBackOff) — GitHub credential problem

**Symptoms:** `kubectl -n arc-systems get pod` shows `<scaleset>-...-listener`
in Pending for a long time, or it starts and CrashLoopBackOff with `401`,
`Bad credentials`, `Could not find any installation`, or `PEM` errors in
the logs.

**Common causes:**

| Symptom | Cause | Resolution |
|---|---|---|
| `secret "gha-runner-scale-set-github-config" not found` | The Secret in Step 1 was not created, or is in the wrong namespace | Recreate per [GitHub Credential Setup](#github-credential-setup); **the namespace must be the scale-set plugin's Install Namespace** (default `arc-runners`). |
| The Secret is created only after installation, and the scale-set had been failing with `not found` / the listener never came up | Initial credentials were missing when the scale-set started | Create the Secret per [GitHub Credential Setup](#github-credential-setup); it usually recovers automatically once the Secret appears, and if not, delete the listener pod once to force a rebuild. |
| Listener log `401 Unauthorized` or `Bad credentials` | Wrong `app_id` / `installation_id` for the GitHub App | Verify App ID in GitHub UI (**Settings → Developer settings → GitHub Apps → your App**); the trailing number on the "Install App" → Configure URL is the installation_id. |
| Listener log `failed to parse private key` or similar PEM error | Private key is not a valid PEM (typical: stored on a single line via `--from-literal`, line breaks lost) | Recreate the Secret using `--from-file=github_app_private_key=app.pem`. |
| Listener log `Could not find any installation` | The App is not yet installed on the target org / repo | In GitHub UI "Install App", install the App on the org / repo referenced by `githubConfigUrl`. |
| Listener log `401 Unauthorized` / `Bad credentials` when using PAT | The PAT is expired, revoked, or the token value in the Secret is wrong | Recreate / re-inject the PAT and verify the Secret key is `github_token`. |
| Listener keeps reporting old credentials / still returns `401` after you rotated the Secret | Listener does not hot-reload updated contents from an existing Secret | Delete the listener pod so the controller recreates it with the new credential. |
| Listener log `403 Forbidden`, `Resource not accessible by personal access token`, or enterprise registration keeps failing | PAT scopes / permissions are insufficient; for example the Classic PAT is missing `repo` / `admin:org` / `manage_runners:enterprise`, or a fine-grained PAT is being used at the enterprise level | Recreate the PAT per [Permission Requirements](#permission-requirements); **enterprise runners support Classic PAT + `manage_runners:enterprise` only**. |
| Fine-grained PAT keeps failing with permission errors even though the token looks valid | The token's owner / repository selection does not cover the repo / org referenced by `githubConfigUrl` | Recreate the fine-grained PAT and make sure its owner and repository selection cover the target scope; if unsure, cross-check with a Classic PAT first. |

Diagnostic commands:

```shell
# current listener status
$ kubectl -n arc-systems get pod -l app.kubernetes.io/component=runner-scale-set-listener

# recent logs (GitHub errors usually appear at listener startup)
$ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=50
```

### Issue 3: Workflow stays "Queued", runner never arrives

**Symptoms:** the GitHub UI shows the workflow as `Queued`; the listener
pod is Running with normal logs; no runner pod ever appears.

**Cause:** `runs-on:` in the workflow YAML did not match the scale-set.
For the Alauda path validated in this document, the **safest** form is a
**single string** equal to the `runnerScaleSetName` on the scale-set
plugin form.

**Resolution:** simplest fix — use the single-string form:

```yaml
# safest currently-validated form in this doc: single string
runs-on: my-runners       # equal to scale-set plugin's Runner Scale-Set Name field
```

> **Note:** The upstream chart supports `scaleSetLabels` + array-form
> `runs-on:` for serving multiple label sets from a single scale-set;
> the full usage, injection method, install-time-only constraint, and
> "what to do if I already installed" are in
> [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels).

**Diagnostic steps:**

```shell
# 1. Confirm the scale-set registration name
$ kubectl -n arc-runners get autoscalingrunnerset \
    -o jsonpath='{range .items[*]}{.metadata.name}: {.spec.runnerScaleSetName}{"\n"}{end}'

# 2. After pushing the workflow, listener log should show "Acquired job ...";
#    its absence means runs-on did not match
$ kubectl -n arc-systems logs -l app.kubernetes.io/component=runner-scale-set-listener --tail=20
```

> **Note:** Need separate runner pools per team / project? See
> [Chapter 4. Multi-Team / Multi-Project Isolation](#chapter-4-multi-team--multi-project-isolation).

### Issue 4: Listener missing / unavailable — controller reference mismatch or insufficient node resources

**Symptoms:** the listener is not becoming available; either it never
appears, or the pod stays Pending (and not the GitHub credential problem
from Issue 2).

| Cause | What you usually see | Resolution |
|---|---|---|
| Scale-set form's **Controller Namespace** / **Controller ServiceAccount Name** does not match the controller plugin | The listener may never appear, or controller logs / events show RBAC or reconcile failures. Here `arc-gha-rs-controller` is the subject referenced by the scale-set's controller-facing binding, not the SA mounted by the listener pod itself | Restore the controller plugin's actual namespace / SA (defaults: `arc-systems` / `arc-gha-rs-controller`) |
| Insufficient node resources | The listener pod exists but stays Pending; `kubectl describe pod` shows `0/N nodes are available: insufficient cpu/memory` | Add nodes / reduce listener resources / verify a global nodeSelector did not pin it to insufficient nodes. |

### Issue 5: Runner pod ImagePullBackOff or stuck ContainerCreating

**Symptoms:** the workflow triggers, the runner pod appears, then stays
in `ContainerCreating` or `ImagePullBackOff`.

**Common causes and resolutions:**

- **Overrode ARC images but did not sync the target image to the
  platform registry.** Verify the `repository` written in
  [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry)
  is actually pullable from the ACP platform registry. **The default
  install package contains matching images, so override is not required
  in principle.**
- **PVC not ready** (kubernetes mode): verify the `storageClassName` from
  Recipe 7 exists and supports dynamic provisioning.
- **Private registry imagePullSecrets:** the default
  `global.registry.imagePullSecrets` is platform-injected. If pulling
  from your own private registry, prefer the platform-injected
  `global.registry.imagePullSecrets` or attach credentials indirectly via
  a custom SA. `template.spec.imagePullSecrets` is not this document's
  recommended diagnostic path; see the `imagePullSecrets` entry under
  [Known Limitations](#known-limitations).

### Issue 6: Form changes do not propagate

**Symptoms:** you edit Extra Chart Values (or another field) on the
platform UI; after save, the cluster's ARS / Deployment / Pod is not
updated.

**Most common cause:** ECV contains a top-level key that the form has
already rendered, breaking the chart's helm parse. Examples:

```yaml
# ❌ wrong: `flags` is a controller form-rendered top-level key
flags:
  watchSingleNamespace: my-team-namespace
```

```yaml
# ❌ wrong: `global` is form-rendered (override global.images.* via EGV instead — see Recipe 9)
global:
  images:
    runnerExtension:
      repository: x/y
```

**Resolution:**

- **Check the plugin instance status.** In the platform UI
  (**Marketplace → Cluster Plugins**), find the plugin instance. If it is
  not `Installed`, the detail page shows an error like
  `yaml: unmarshal errors: mapping key "<key>" already defined`.
- **Use Extra Global Values (not Extra Chart Values) to override
  `global.*`.** Write `images:` at the top level (each line indented 2
  spaces) instead of `global.images.*` — see
  [Recipe 9](#recipe-9-override-arc-images-custom-version--private-registry).
- **Do not write the following top-level keys in ECV** (already
  form-rendered):
  - Controller plugin: `flags`, `metrics`, `namespaceOverride`,
    `replicaCount`, `global`.
  - Scale-set plugin: `namespaceOverride`, `global`, `githubConfigUrl`,
    `githubConfigSecret`, `runnerScaleSetName`, `minRunners`, `maxRunners`,
    `controllerServiceAccount`.
  - `containerMode` is **conditional**: when the form's Container Mode field
    is **non-empty**, do not write `containerMode:` again in ECV; write
    `containerMode:` only when you intentionally leave the form field
    **empty** and fully take over that block in ECV. See
    [Container Mode selection](#container-mode-selection).

#### Known issue: after switching back to the default runner SA, the default kube-mode RBAC objects remain stuck in `Terminating`

**Applies to:** the current baseline version, in `kubernetes` /
`kubernetes-novolume` mode, when you first point
`template.spec.serviceAccountName` at a custom SA per
[Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs), then later
clear the field or switch back to the default path.

**Symptoms:**

- later workflows that use the default SA fail during
  `container:` job initialization with `HTTP-Code: 401 Unauthorized`;
- or the runner pod still contains `kubectl`, but
  `kubectl auth can-i ...` returns `error` directly;
- or `kubectl get sa,role,rolebinding -n arc-runners` still shows the
  default `<scaleset>-gha-rs-kube-mode` objects, but one or more of them
  remain with `metadata.deletionTimestamp`.

**How to confirm:**

```shell
$ kubectl -n arc-runners get sa,role,rolebinding \
    <runner-scale-set-name>-gha-rs-kube-mode -o yaml
```

If the output still contains:

```yaml
metadata:
  deletionTimestamp: "..."
  finalizers:
    - actions.github.com/cleanup-protection
```

you have hit this known issue.

**Workaround:**

1. **Prefer to avoid the state transition:** if this runner pool needs
   long-lived in-cluster access, keep a dedicated custom runner SA in place
   rather than switching back and forth between the default SA and a custom
   one.
2. **Validate once after switching back to the default SA:** in ACP UI,
   **Marketplace → Cluster Plugins → this scale-set plugin → Update**,
   save a harmless change to trigger a reconcile (for example temporarily
   increase `Maximum Runners` by 1, save, then change it back and save
   again), then verify that the three default kube-mode resources were
   recreated and no longer carry `deletionTimestamp`.
3. **If they are already stuck:** first clear the
   `actions.github.com/cleanup-protection` finalizer from the three default
   kube-mode resources, then trigger the reconcile above so the platform
   recreates the default SA / Role / RoleBinding. For example:

```shell
$ kubectl -n arc-runners patch sa <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
$ kubectl -n arc-runners patch role <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
$ kubectl -n arc-runners patch rolebinding <runner-scale-set-name>-gha-rs-kube-mode \
    --type=merge -p '{"metadata":{"finalizers":[]}}'
```

This is a known limitation in the same family as the current
cleanup/finalizer issues upstream. It does **not** mean
`template.spec.serviceAccountName` itself is unsupported; the primary
behavior still works as expected: runner pods switch to the custom SA and
authorize against that SA's RBAC.

---

## Chapter 7. Uninstall

### Pre-uninstall checklist

Confirm the following before running any of the steps below:

- All workflows on the GitHub side are stopped (in-flight workflows fail
  during uninstall).
- No business workload depends on PVC / ConfigMap / Secret resources in
  `arc-runners`.
- The corresponding runner registrations on the GitHub side
  (**Settings → Actions → Runners**) are noted; you will need to delete
  them after uninstall (only if the controller-side cleanup did not
  remove them automatically — see the Note under Step 1).

### Step 1: Uninstall Scale-Set plugin

In the platform UI, **Marketplace → Cluster Plugins**, locate the
scale-set plugin instance, click ⋮ → **Uninstall**.

> **Note:** If your controller / scale set is not installed in the default
> `arc-systems` / `arc-runners` namespaces, replace those namespace values in
> every `kubectl -n ...` and `kubectl delete namespace ...` command below with
> your real deployment namespaces. These are destructive commands; do not copy
> the defaults blindly.

Wait until pods in `arc-runners` (default Install Namespace) are cleaned
up:

```shell
$ kubectl -n arc-runners get autoscalingrunnerset
# expected: no resources found

$ kubectl -n arc-runners get pod
# expected: no resources found (or only your own non-ARC workloads)
```

> **Note:** In the current ARC version, a **normal** scale-set uninstall
> causes the controller to delete the corresponding runner scale set from
> GitHub during `AutoscalingRunnerSet` finalization, so **manual GitHub UI
> cleanup is usually unnecessary**. You only need to inspect and remove a
> leftover entry in **Settings → Actions → Runners** when that cleanup path
> did not complete (for example, the controller was removed first, GitHub
> credentials had already broken, or finalization failed and the resource got
> stuck). This scale-set entry is distinct from a GitHub "runner group"
> (runner access-control grouping).

### Step 2: Uninstall Controller plugin

> **Warning — uninstall the scale-set plugin first.** With the controller
> uninstalled while a scale-set still exists, the listener pod enters a
> reconcile loop and the controller's CRDs may leave residual finalizers.

Marketplace → Cluster Plugins, locate the controller plugin, click ⋮ →
**Uninstall**.

Verify the controller resources are gone:

```shell
$ kubectl -n arc-systems get pod
# expected: no resources found

$ kubectl get crd | grep actions.github.com
# expected: empty (the four ARC CRDs are removed by the controller plugin)
```

### Step 3: Clean up residual resources

Some resources are not deleted by the plugin uninstall and need manual
cleanup:

```shell
# the GitHub credential Secret (the plugin does not delete user-created Secrets)
$ kubectl -n arc-runners delete secret gha-runner-scale-set-github-config

# any custom SA / Role / RoleBinding from Recipe 1
$ kubectl -n arc-runners delete sa my-runner-sa
$ kubectl -n arc-runners delete rolebinding my-runner-sa-binding
$ kubectl -n arc-runners delete role my-runner-sa-role

# any custom PVC / ConfigMap from Recipe 6
$ kubectl -n arc-runners delete pvc maven-cache-pvc
$ kubectl -n arc-runners delete configmap extra-ca-bundle

# namespaces (after confirming no residual pods)
$ kubectl delete namespace arc-runners arc-systems
```

> **Warning:** The delete commands above use the default namespaces for
> illustration. If your deployment uses custom namespaces, replace them line by
> line before execution, especially before deleting `arc-runners` /
> `arc-systems`.

---

## Known Limitations

- **Controller single-namespace watch is not configurable.** The upstream
  chart's `flags.watchSingleNamespace` cannot currently be set via Extra
  Chart Values (the `flags` top-level key is form-rendered). Contact the
  platform support team if needed.
- **This document's primary recommended path for runner-side private image
  pulls is the platform-injected `global.registry.imagePullSecrets`, or
  attaching `imagePullSecrets` indirectly via the ServiceAccount.** The
  upstream chart does pass `template.spec.imagePullSecrets` through to the
  runner pod spec, but this document does not treat it as a separately
  validated plugin-install matrix. If you want to rely on that path, inspect
  the rendered ARS / runner pod spec and validate an actual image pull on
  your target cluster first. The SA-based route below is usually easier to
  govern consistently:

  ```shell
  $ kubectl create secret docker-registry my-private-registry \
      --docker-server=my.registry.com \
      --docker-username=<u> --docker-password=<p> \
      -n arc-runners
  $ kubectl create serviceaccount runner-puller -n arc-runners
  $ kubectl patch sa runner-puller -n arc-runners \
      -p '{"imagePullSecrets":[{"name":"my-private-registry"}]}'
  ```

  Then refer to [Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)
  to set `template.spec.serviceAccountName: runner-puller`. The
  listener-side imagePullSecrets is not subject to this limit and can be
  written directly via Extra Chart Values as
  `listenerTemplate.spec.imagePullSecrets`.
- **Scale-Set cluster-plugin entry supports only one default instance per
  cluster.** Installing a second instance via the ACP cluster-plugin
  entry on the same cluster is rejected. To run multiple isolated runner
  pools on the same cluster, install additional copies of the upstream
  `gha-runner-scale-set` chart through the platform's
  **Catalog → Helm Chart** entry — see
  [Chapter 4 Method 3](#method-3-direct-helm-chart-deployment-special-needs).

---

## Appendix: Full chart values reference

> **Tip — this is reference material, not required reading.** If you
> just want to follow a Recipe and tweak configuration, skip this
> section and jump straight to
> [Step 2: Verifying a config change took effect](#step-2-verifying-a-config-change-took-effect)
> or [Recipe 1](#recipe-1-custom-serviceaccount-for-in-cluster-jobs)
> below. This section inlines the full upstream chart values for both
> plugins (`gha-runner-scale-set-0.14.1`, comments preserved) so you can
> look up field semantics and defaults without leaving the document
> while writing ECV / EGV.

ARC ships as two independent Cluster Plugins — the **controller plugin**
and the **Scale-Set plugin** — and each carries its own chart with its
own values schema. The Alauda overlay tunes their defaults differently;
most visibly, `global.images.*` differs per plugin (the controller
plugin only carries `images.controller`, while the Scale-Set plugin
carries `images.runnerExtension` and, for DinD users, `images.dind`).
The two plugins are documented separately below.

For each plugin, the values are presented in two layers:

- **Alauda overlay** — fields that the Alauda Cluster Plugin adds (most
  notably the `global:` block carrying platform registry rewrite +
  pull-secret injection) or for which it sets a default that differs
  from upstream.
- **Upstream chart** — the unmodified `gha-runner-scale-set-controller`
  / `gha-runner-scale-set` chart that ARC publishes. The current Alauda
  plugin ships the upstream `gha-runner-scale-set-0.14.1` release; the
  links and inlined values below are pinned to that tag. Treat this
  layer as the authoritative reference for every configurable field
  and its default — anything not explicitly listed in the Alauda
  overlay above keeps the upstream default.

Read the Alauda layer first to understand what platform-specific
behavior is already in place; consult the upstream layer when you need
to write an ECV / EGV override for a field the form does not expose.

### Controller plugin

<details>
<summary>Alauda overlay — controller-specific additions / default overrides (click to expand)</summary>

The `global:` block below is the most visible Alauda addition — it is
**not** part of the upstream chart, and the Alauda Cluster Plugin
populates it on install so every controller image pull resolves through
the platform registry:

```yaml
# Provided by the Alauda Cluster Plugin; not present in the upstream chart.
global:
  registry:
    address: registry.alauda.cn:60070   # platform-injected on ACP install
    imagePullSecrets: []                # platform-managed; do not write directly
  labelBaseDomain: alauda.io
  images:
    controller:
      repository: devops/actions/gha-runner-scale-set-controller
      tag: "latest"
```

In addition, the following upstream fields ship with Alauda-tuned
defaults on this plugin (field names match upstream — only the default
differs):

- `resources` / `podSecurityContext` / `securityContext` — set to
  PSS-`restricted`-compatible values, sized for the default ACP
  control-plane node.
- `flags.logFormat: "json"` (upstream default `text`).

</details>

<details>
<summary>Upstream chart values — gha-runner-scale-set-0.14.1 (click to expand)</summary>

Source: [`charts/gha-runner-scale-set-controller/values.yaml` @ `gha-runner-scale-set-0.14.1`](https://github.com/actions/actions-runner-controller/blob/gha-runner-scale-set-0.14.1/charts/gha-runner-scale-set-controller/values.yaml).
The full file is reproduced below verbatim, with upstream comments
preserved so you don't have to leave the doc to read them.

```yaml
# Default values for gha-runner-scale-set-controller.
# This is a YAML-formatted file.
# Declare variables to be passed into your templates.
labels: {}

# leaderElection will be enabled when replicaCount>1,
# So, only one replica will in charge of reconciliation at a given time
# leaderElectionId will be set to {{ define gha-runner-scale-set-controller.fullname }}.
replicaCount: 1

image:
  repository: "ghcr.io/actions/gha-runner-scale-set-controller"
  pullPolicy: IfNotPresent
  # Overrides the image tag whose default is the chart appVersion.
  tag: ""

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

env:
## Define environment variables for the controller pod
#  - name: "ENV_VAR_NAME_1"
#    value: "ENV_VAR_VALUE_1"
#  - name: "ENV_VAR_NAME_2"
#    valueFrom:
#      secretKeyRef:
#        key: ENV_VAR_NAME_2
#        name: secret-name
#        optional: true

serviceAccount:
  # Specifies whether a service account should be created for running the controller pod
  create: true
  # Annotations to add to the service account
  annotations: {}
  # The name of the service account to use.
  # If not set and create is true, a name is generated using the fullname template
  # You can not use the default service account for this.
  name: ""

podAnnotations: {}

podLabels: {}

podSecurityContext: {}
# fsGroup: 2000

securityContext: {}
# capabilities:
#   drop:
#   - ALL
# readOnlyRootFilesystem: true
# runAsNonRoot: true
# runAsUser: 1000

resources: {}
## We usually recommend not to specify default resources and to leave this as a conscious
## choice for the user. This also increases chances charts run on environments with little
## resources, such as Minikube. If you do want to specify resources, uncomment the following
## lines, adjust them as necessary, and remove the curly braces after 'resources:'.
# limits:
#   cpu: 100m
#   memory: 128Mi
# requests:
#   cpu: 100m
#   memory: 128Mi

nodeSelector: {}

tolerations: []

affinity: {}

topologySpreadConstraints: []

# Mount volumes in the container.
volumes: []
volumeMounts: []

# Leverage a PriorityClass to ensure your pods survive resource shortages
# ref: https://kubernetes.io/docs/concepts/configuration/pod-priority-preemption/
# PriorityClass: system-cluster-critical
priorityClassName: ""

## If `metrics:` object is not provided, or commented out, the following flags
## will be applied the controller-manager and listener pods with empty values:
## `--metrics-addr`, `--listener-metrics-addr`, `--listener-metrics-endpoint`.
## This will disable metrics.
##
## To enable metrics, uncomment the following lines.
# metrics:
#   controllerManagerAddr: ":8080"
#   listenerAddr: ":8080"
#   listenerEndpoint: "/metrics"

flags:
  ## Log level can be set here with one of the following values: "debug", "info", "warn", "error".
  ## Defaults to "debug".
  logLevel: "debug"
  ## Log format can be set with one of the following values: "text", "json"
  ## Defaults to "text"
  logFormat: "text"

  ## Restricts the controller to only watch resources in the desired namespace.
  ## Defaults to watch all namespaces when unset.
  # watchSingleNamespace: ""

  ## The maximum number of concurrent reconciles which can be run by the EphemeralRunner controller.
  # Increase this value to improve the throughput of the controller.
  # It may also increase the load on the API server and the external service (e.g. GitHub API).
  runnerMaxConcurrentReconciles: 2

  ## Defines how the controller should handle upgrades while having running jobs.
  ##
  ## The strategies available are:
  ## - "immediate": (default) The controller will immediately apply the change causing the
  ##   recreation of the listener and ephemeral runner set. This can lead to an
  ##   overprovisioning of runners, if there are pending / running jobs. This should not
  ##   be a problem at a small scale, but it could lead to a significant increase of
  ##   resources if you have a lot of jobs running concurrently.
  ##
  ## - "eventual": The controller will remove the listener and ephemeral runner set
  ##   immediately, but will not recreate them (to apply changes) until all
  ##   pending / running jobs have completed.
  ##   This can lead to a longer time to apply the change but it will ensure
  ##   that you don't have any overprovisioning of runners.
  updateStrategy: "immediate"

  ## Defines a list of prefixes that should not be propagated to internal resources.
  ## This is useful when you have labels that are used for internal purposes and should not be propagated to internal resources.
  ## See https://github.com/actions/actions-runner-controller/issues/3533 for more information.
  ##
  ## By default, all labels are propagated to internal resources
  ## Labels that match prefix specified in the list are excluded from propagation.
  # excludeLabelPropagationPrefixes:
  #   - "argocd.argoproj.io/instance"

# Overrides the default `.Release.Namespace` for all resources in this chart.
namespaceOverride: ""

## Defines the K8s client rate limiter parameters.
  # k8sClientRateLimiterQPS: 20
  # k8sClientRateLimiterBurst: 30
```

</details>

### Scale-Set plugin

<details>
<summary>Alauda overlay — scale-set-specific additions / default overrides (click to expand)</summary>

The `global:` block below is the most visible Alauda addition — it is
**not** part of the upstream chart, and the Alauda Cluster Plugin
populates it on install so every runner / runner-extension image pull
resolves through the platform registry:

```yaml
# Provided by the Alauda Cluster Plugin; not present in the upstream chart.
global:
  registry:
    address: registry.alauda.cn:60070   # platform-injected on ACP install
    imagePullSecrets: []                # platform-managed; do not write directly
  labelBaseDomain: alauda.io
  images:
    runnerExtension:
      repository: devops/actions/gha-runner-scale-set-runner-extension
      tag: "latest"
    # `dind` image is intentionally NOT pre-declared — DinD mode is
    # opt-in and the upstream Docker CVE surface is best kept off the
    # Alauda patch backlog. Customers using DinD must mirror an upstream
    # image and override `global.images.dind.{repository,tag}` themselves.
```

In addition, the following upstream fields ship with Alauda-tuned
defaults on this plugin (field names match upstream — only the default
differs):

- `githubConfigUrl` — set to a visibly-invalid placeholder so installs
  fail fast instead of rendering with an empty URL.
- `githubConfigSecret: gha-runner-scale-set-github-config` — default
  Secret name expected by the form.
- `containerMode.type: kubernetes-novolume`.
- `template.spec.containers[0]` — pre-populated with the platform
  runner image + `command: ["/home/runner/run.sh"]` +
  `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER=false`.
- `minRunners: 0` / `maxRunners: 5`.
- `controllerServiceAccount` — pinned to `arc-systems` /
  `arc-gha-rs-controller`.

</details>

<details>
<summary>Upstream chart values — gha-runner-scale-set-0.14.1 (click to expand)</summary>

Source: [`charts/gha-runner-scale-set/values.yaml` @ `gha-runner-scale-set-0.14.1`](https://github.com/actions/actions-runner-controller/blob/gha-runner-scale-set-0.14.1/charts/gha-runner-scale-set/values.yaml).
The full file is reproduced below verbatim, with upstream comments
preserved so you don't have to leave the doc to read them.

> **Warning:** The excerpt below is reproduced verbatim from upstream
> `values.yaml`, including one known flaw in the pre-defined GitHub App Secret
> example. The sample line that shows `github_app_private_key='-----BEGIN
> CERTIFICATE-----...'` is not correct for real use: this value must be the
> GitHub App private-key PEM, not a certificate. Use
> [Method 1: GitHub App (recommended)](#method-1-github-app-recommended) in
> the main text as the executable procedure.

```yaml
## githubConfigUrl is the GitHub url for where you want to configure runners
## ex: https://github.com/myorg/myrepo or https://github.com/myorg or https://github.com/enterprises/myenterprise
githubConfigUrl: ""

scaleSetLabels: []

## githubConfigSecret is the k8s secret information to use when authenticating via the GitHub API.
## You can choose to supply:
##   A) a PAT token,
##   B) a GitHub App, or
##   C) a pre-defined secret.
## The syntax for each of these variations is documented below.
## (Variation A) When using a PAT token, the syntax is as follows:
githubConfigSecret:
  # Example:
  # github_token: "ghp_sampleSampleSampleSampleSampleSample"
  github_token: ""
#
## (Variation B) When using a GitHub App, the syntax is as follows:
# githubConfigSecret:
#   # NOTE: IDs MUST be strings, use quotes
#   # The github_app_id can be an app_id or the client_id
#   github_app_id: ""
#   github_app_installation_id: ""
#   github_app_private_key: |
#      private key line 1
#      private key line 2
#      .
#      .
#      .
#      private key line N
#
## (Variation C) When using a pre-defined secret.
## The secret can be pulled either directly from Kubernetes, or from the vault, depending on configuration.
## Kubernetes secret in the same namespace that the gha-runner-scale-set is going to deploy.
## On the other hand, if the vault is configured, secret name will be used to fetch the app configuration.
## The syntax is as follows:
# githubConfigSecret: pre-defined-secret
## Notes on using pre-defined Kubernetes secrets:
##   You need to make sure your predefined secret has all the required secret data set properly.
##   For a pre-defined secret using GitHub PAT, the secret needs to be created like this:
##   > kubectl create secret generic pre-defined-secret --namespace=my_namespace --from-literal=github_token='ghp_your_pat'
##   For a pre-defined secret using GitHub App, the secret needs to be created like this:
##   > kubectl create secret generic pre-defined-secret --namespace=my_namespace --from-literal=github_app_id=123456 --from-literal=github_app_installation_id=654321 --from-literal=github_app_private_key='-----BEGIN CERTIFICATE-----*******'

## proxy can be used to define proxy settings that will be used by the
## controller, the listener and the runner of this scale set.
#
# proxy:
#   http:
#     url: http://proxy.com:1234
#     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
#   https:
#     url: http://proxy.com:1234
#     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
#   noProxy:
#     - example.com
#     - example.org

## maxRunners is the max number of runners the autoscaling runner set will scale up to.
# maxRunners: 5

## minRunners is the min number of idle runners. The target number of runners created will be
## calculated as a sum of minRunners and the number of jobs assigned to the scale set.
# minRunners: 0

# runnerGroup: "default"

## name of the runner scale set to create.  Defaults to the helm release name
# runnerScaleSetName: ""

## A self-signed CA certificate for communication with the GitHub server can be
## provided using a config map key selector. If `runnerMountPath` is set, for
## each runner pod ARC will:
## - create a `github-server-tls-cert` volume containing the certificate
##   specified in `certificateFrom`
## - mount that volume on path `runnerMountPath`/{certificate name}
## - set NODE_EXTRA_CA_CERTS environment variable to that same path
## - set RUNNER_UPDATE_CA_CERTS environment variable to "1" (as of version
##   2.303.0 this will instruct the runner to reload certificates on the host)
##
## If any of the above had already been set by the user in the runner pod
## template, ARC will observe those and not overwrite them.
## Example configuration:
#
# githubServerTLS:
#   certificateFrom:
#     configMapKeyRef:
#       name: config-map-name
#       key: ca.crt
#   runnerMountPath: /usr/local/share/ca-certificates/

# keyVault:
  # Available values: "azure_key_vault"
  # type: ""
  # Configuration related to azure key vault
  # azure_key_vault:
  #   url: ""
  #   client_id: ""
  #   tenant_id: ""
  #   certificate_path: ""
    # proxy:
    #   http:
    #     url: http://proxy.com:1234
    #     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
    #   https:
    #     url: http://proxy.com:1234
    #     credentialSecretRef: proxy-auth # a secret with `username` and `password` keys
    #   noProxy:
    #     - example.com
    #     - example.org

## Container mode is an object that provides out-of-box configuration
## for dind and kubernetes mode. Template will be modified as documented under the
## template object.
##
## If any customization is required for dind or kubernetes mode, containerMode should remain
## empty, and configuration should be applied to the template.
# containerMode:
#   type: "dind"  ## type can be set to "dind", "kubernetes", or "kubernetes-novolume"
#   ## the following is required when containerMode.type=kubernetes
#   kubernetesModeWorkVolumeClaim:
#     accessModes: ["ReadWriteOnce"]
#     # For local testing, use https://github.com/openebs/dynamic-localpv-provisioner/blob/develop/docs/quickstart.md to provide dynamic provision volume with storageClassName: openebs-hostpath
#     storageClassName: "dynamic-blob-storage"
#     resources:
#       requests:
#         storage: 1Gi
#   kubernetesModeAdditionalRoleRules: []
#

## listenerTemplate is the PodSpec for each listener Pod
## For reference: https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#PodSpec
# listenerTemplate:
#   spec:
#     containers:
#     # Use this section to append additional configuration to the listener container.
#     # If you change the name of the container, the configuration will not be applied to the listener,
#     # and it will be treated as a side-car container.
#     - name: listener
#       securityContext:
#         runAsUser: 1000
#     # Use this section to add the configuration of a side-car container.
#     # Comment it out or remove it if you don't need it.
#     # Spec for this container will be applied as is without any modifications.
#     - name: side-car
#       image: example-sidecar

## listenerMetrics are configurable metrics applied to the listener.
## In order to avoid helm merging these fields, we left the metrics commented out.
## When configuring metrics, please uncomment the listenerMetrics object below.
## You can modify the configuration to remove the label or specify custom buckets for histogram.
##
## If the buckets field is not specified, the default buckets will be applied. Default buckets are
## provided here for documentation purposes
# listenerMetrics:
#   counters:
#     gha_started_jobs_total:
#       labels:
#         ["repository", "organization", "enterprise", "job_name", "event_name", "job_workflow_ref", "job_workflow_name", "job_workflow_target"]
#     gha_completed_jobs_total:
#       labels:
#         [
#           "repository",
#           "organization",
#           "enterprise",
#           "job_name",
#           "event_name",
#           "job_result",
#           "job_workflow_ref",
#           "job_workflow_name",
#           "job_workflow_target",
#         ]
#   gauges:
#     gha_assigned_jobs:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_running_jobs:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_registered_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_busy_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_min_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_max_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_desired_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#     gha_idle_runners:
#       labels: ["name", "namespace", "repository", "organization", "enterprise"]
#   histograms:
#     gha_job_startup_duration_seconds:
#       labels:
#         ["repository", "organization", "enterprise", "job_name", "event_name","job_workflow_ref", "job_workflow_name", "job_workflow_target"]
#       buckets:
#         [
#           0.01,
#           0.05,
#           0.1,
#           0.5,
#           1.0,
#           2.0,
#           3.0,
#           4.0,
#           5.0,
#           6.0,
#           7.0,
#           8.0,
#           9.0,
#           10.0,
#           12.0,
#           15.0,
#           18.0,
#           20.0,
#           25.0,
#           30.0,
#           40.0,
#           50.0,
#           60.0,
#           70.0,
#           80.0,
#           90.0,
#           100.0,
#           110.0,
#           120.0,
#           150.0,
#           180.0,
#           210.0,
#           240.0,
#           300.0,
#           360.0,
#           420.0,
#           480.0,
#           540.0,
#           600.0,
#           900.0,
#           1200.0,
#           1800.0,
#           2400.0,
#           3000.0,
#           3600.0,
#         ]
#     gha_job_execution_duration_seconds:
#       labels:
#         [
#           "repository",
#           "organization",
#           "enterprise",
#           "job_name",
#           "event_name",
#           "job_result",
#           "job_workflow_ref",
#           "job_workflow_name",
#           "job_workflow_target"
#         ]
#       buckets:
#         [
#           0.01,
#           0.05,
#           0.1,
#           0.5,
#           1.0,
#           2.0,
#           3.0,
#           4.0,
#           5.0,
#           6.0,
#           7.0,
#           8.0,
#           9.0,
#           10.0,
#           12.0,
#           15.0,
#           18.0,
#           20.0,
#           25.0,
#           30.0,
#           40.0,
#           50.0,
#           60.0,
#           70.0,
#           80.0,
#           90.0,
#           100.0,
#           110.0,
#           120.0,
#           150.0,
#           180.0,
#           210.0,
#           240.0,
#           300.0,
#           360.0,
#           420.0,
#           480.0,
#           540.0,
#           600.0,
#           900.0,
#           1200.0,
#           1800.0,
#           2400.0,
#           3000.0,
#           3600.0,
#         ]

## template is the PodSpec for each runner Pod
## For reference: https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#PodSpec
template:
  ## template.spec will be modified if you change the container mode
  ## with containerMode.type=dind, we will populate the template.spec with following pod spec
  ## template:
  ##   spec:
  ##     initContainers:
  ##     - name: init-dind-externals
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["cp", "-r", "/home/runner/externals/.", "/home/runner/tmpDir/"]
  ##       volumeMounts:
  ##         - name: dind-externals
  ##           mountPath: /home/runner/tmpDir
  ##     - name: dind
  ##       image: docker:dind
  ##       args:
  ##         - dockerd
  ##         - --host=unix:///var/run/docker.sock
  ##         - --group=$(DOCKER_GROUP_GID)
  ##       env:
  ##         - name: DOCKER_GROUP_GID
  ##           value: "123"
  ##       securityContext:
  ##         privileged: true
  ##       restartPolicy: Always
  ##       startupProbe:
  ##         exec:
  ##           command:
  ##             - docker
  ##             - info
  ##         initialDelaySeconds: 0
  ##         failureThreshold: 24
  ##         periodSeconds: 5
  ##       volumeMounts:
  ##         - name: work
  ##           mountPath: /home/runner/_work
  ##         - name: dind-sock
  ##           mountPath: /var/run
  ##         - name: dind-externals
  ##           mountPath: /home/runner/externals
  ##     containers:
  ##     - name: runner
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["/home/runner/run.sh"]
  ##       env:
  ##         - name: DOCKER_HOST
  ##           value: unix:///var/run/docker.sock
  ##         - name: RUNNER_WAIT_FOR_DOCKER_IN_SECONDS
  ##           value: "120"
  ##       volumeMounts:
  ##         - name: work
  ##           mountPath: /home/runner/_work
  ##         - name: dind-sock
  ##           mountPath: /var/run
  ##     volumes:
  ##     - name: work
  ##       emptyDir: {}
  ##     - name: dind-sock
  ##       emptyDir: {}
  ##     - name: dind-externals
  ##       emptyDir: {}
  ######################################################################################################
  ## with containerMode.type=kubernetes, we will populate the template.spec with following pod spec
  ## template:
  ##   spec:
  ##     containers:
  ##     - name: runner
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["/home/runner/run.sh"]
  ##       env:
  ##         - name: ACTIONS_RUNNER_CONTAINER_HOOKS
  ##           value: /home/runner/k8s/index.js
  ##         - name: ACTIONS_RUNNER_POD_NAME
  ##           valueFrom:
  ##             fieldRef:
  ##               fieldPath: metadata.name
  ##         - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
  ##           value: "true"
  ##       volumeMounts:
  ##         - name: work
  ##           mountPath: /home/runner/_work
  ##     volumes:
  ##       - name: work
  ##         ephemeral:
  ##           volumeClaimTemplate:
  ##             spec:
  ##               accessModes: [ "ReadWriteOnce" ]
  ##               storageClassName: "local-path"
  ##               resources:
  ##                 requests:
  ##                   storage: 1Gi
  ######################################################################################################
  ## with containerMode.type=kubernetes-novolume, we will populate the template.spec with following pod spec
  ## template:
  ##   spec:
  ##     containers:
  ##     - name: runner
  ##       image: ghcr.io/actions/actions-runner:latest
  ##       command: ["/home/runner/run.sh"]
  ##       env:
  ##         - name: ACTIONS_RUNNER_CONTAINER_HOOKS
  ##           value: /home/runner/k8s-novolume/index.js
  ##         - name: ACTIONS_RUNNER_POD_NAME
  ##           valueFrom:
  ##             fieldRef:
  ##               fieldPath: metadata.name
  ##         - name: ACTIONS_RUNNER_IMAGE
  ##           value: ghcr.io/actions/actions-runner:latest # should match the runnerimage
  ##         - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
  ##           value: "true"
  spec:
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
        command: ["/home/runner/run.sh"]
## Optional controller service account that needs to have required Role and RoleBinding
## to operate this gha-runner-scale-set installation.
## The helm chart will try to find the controller deployment and its service account at installation time.
## In case the helm chart can't find the right service account, you can explicitly pass in the following value
## to help it finish RoleBinding with the right service account.
## Note: if your controller is installed to only watch a single namespace, you have to pass these values explicitly.
# controllerServiceAccount:
#   namespace: arc-system
#   name: test-arc-gha-runner-scale-set-controller

# Overrides the default `.Release.Namespace` for all resources in this chart.
namespaceOverride: ""

## Optional annotations and labels applied to all resources created by helm installation
##
## Annotations applied to all resources created by this helm chart. Annotations will not override the default ones, so make sure
## the custom annotation is not reserved.
# annotations:
#   key: value
##
## Labels applied to all resources created by this helm chart. Labels will not override the default ones, so make sure
## the custom label is not reserved.
# labels:
#   key: value

## If you want more fine-grained control over annotations applied to particular resource created by this chart,
## you can use `resourceMeta`.
## Order of applying labels and annotations is:
## 1. Apply labels/annotations globally, using `annotations` and `labels` field
## 2. Apply `resourceMeta` labels/annotations
## 3. Apply reserved labels/annotations
# resourceMeta:
#   autoscalingRunnerSet:
#     labels:
#       key: value
#     annotations:
#       key: value
#   githubConfigSecret:
#     labels:
#       key: value
#     annotations:
#       key: value
#   kubernetesModeRole:
#     labels:
#       key: value
#     annotations:
#       key: value
#   kubernetesModeRoleBinding:
#     labels:
#       key: value
#     annotations:
#       key: value
#   kubernetesModeServiceAccount:
#     labels:
#       key: value
#     annotations:
#       key: value
#   managerRole:
#     labels:
#       key: value
#     annotations:
#       key: value
#   managerRoleBinding:
#     labels:
#       key: value
#     annotations:
#       key: value
#   noPermissionServiceAccount:
#     labels:
#       key: value
#     annotations:
#       key: value
#   autoscalingListener:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerServiceAccount:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerRole:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerRoleBinding:
#     labels:
#       key: value
#     annotations:
#       key: value
#   listenerConfigSecret:
#     labels:
#       key: value
#     annotations:
#       key: value
#   ephemeralRunnerSet:
#     labels:
#       key: value
#     annotations:
#       key: value
#   ephemeralRunner:
#     labels:
#       key: value
#     annotations:
#       key: value
#   ephemeralRunnerConfigSecret:
#     labels:
#       key: value
#     annotations:
#       key: value
```

</details>

---

## References

- [Alauda Container Platform documentation](https://docs.alauda.io/) — general platform UI operations.
- [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps) — GitHub App creation steps.
- [GitHub Actions Runner Controller (upstream)](https://github.com/actions/actions-runner-controller) — upstream project, includes complete chart values documentation.
- [Self-hosted runner concepts](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners-with-actions-runner-controller/about-actions-runner-controller) — GitHub's official conceptual introduction to ARC scale-set mode.
- [Communicating with self-hosted runners](https://docs.github.com/en/enterprise-cloud@latest/actions/reference/runners/self-hosted-runners) — GitHub's official network communication requirements for self-hosted runners, including `github.com`, `api.github.com`, and `*.actions.githubusercontent.com` ([System Requirements](#system-requirements) cites it).
- [Authenticate to the GitHub API (ARC)](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/use-actions-runner-controller/authenticate-to-the-api) — canonical source for PAT scopes and fine-grained permission matrix; cited by [Permission Requirements](#permission-requirements) and [Method 2: PAT](#method-2-personal-access-token).
- [Managing access to self-hosted runners using groups](https://docs.github.com/en/enterprise-cloud@latest/actions/how-tos/manage-runners/self-hosted-runners/manage-access) — GitHub's official guidance for runner groups, `Selected repositories`, `Selected workflows`, and enterprise `Selected organizations` ([Chapter 4](#chapter-4-multi-team--multi-project-isolation) cites it).
- [Use ARC in a workflow](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/use-arc-in-a-workflow) — official guidance on `runs-on:` string vs. array form and `scaleSetLabels`; cited by [Workflow side: runs-on requirements](#workflow-side-runs-on-requirements), [Workflow side: runs-on array form with scaleSetLabels](#workflow-side-runs-on-array-form-with-scalesetlabels), and [Issue 3](#issue-3-workflow-stays-queued-runner-never-arrives).
