---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
---

# Helm chart template upload fails, or the template directory cannot be selected, in Catalog on ACP

## Issue

Uploading a Helm chart so that it appears in Catalog does not work:

- A plain chart package (`.tgz`) uploaded with `violet` fails, and the chart never appears under Catalog → Helm Charts.
- The template upload does not become usable, and the `captain-controller` log shows that it cannot connect to port 80 of the Harbor VIP.
- The template repository has no template directory to select, or the upload dialog cannot select one.

Related articles: [Catalog does not list a Helm chart that is already in Harbor, or a newly uploaded chart version, on ACP](Catalog_does_not_list_a_Helm_chart_that_is_already_in_Harbor_or_a_newly_uploaded_chart_version_on_ACP.md).

## Root Cause

### Cause 1: a plain chart is uploaded with violet

A plain Helm chart uploaded with `violet` can fail and never reach Catalog → Helm Charts. `violet push` also cannot target a chosen template repository: charts pushed that way go to the default `public-charts` repository only. The working path for a plain chart is a template repository of type Chart or OCI Chart and the upload in Catalog → Helm Charts.

### Cause 2: captain-controller cannot reach the Harbor VIP on port 80

The forwarding policy of the VIP in front of Harbor does not forward port 80, so `captain-controller` cannot connect to Harbor and the template upload fails. Opening port 80 on the VIP forwarding policy and then restarting `captain-controller-manager` makes the upload work.

### Cause 3: the template directory is not created or the repository address hides it

A template directory is created by typing its name in the template-directory field of the upload dialog; that creates the directory under the chart repository. For an OCI repository, an address that is only the Harbor host lets the upload dialog offer the Harbor projects (for example `library`) as directories, while an address that includes a project path prevents that selection.

## Resolution

### Cause 1

1. A platform administrator adds a template repository of type Chart or OCI Chart and grants Management on it to the user or project.
2. Open Catalog → Helm Charts, choose Add Template, and associate that template repository.
3. For OCI Chart, fill in the chart storage directory.
4. Upload Template and confirm. View and deploy the chart from Catalog → Helm Charts, not from the plugin list.

### Cause 2

1. Confirm the log line:

   ```bash
   kubectl get deploy -A | grep captain-controller
   kubectl -n <namespace> logs deploy/captain-controller-manager --tail=200
   ```

2. From a global cluster node, check port 80 of the Harbor VIP. Any HTTP status (Harbor answers `401` without credentials) means the port is open; a timeout or refusal matches this cause.

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' --connect-timeout 5 http://<harbor-vip>:80/v2/
   ```

3. Open TCP port 80 on the forwarding policy that publishes the Harbor VIP, and run the check again.

4. Restart `captain-controller-manager`.

   > **Warning:** Only after the log shows the port 80 failure and the port has been opened. Impact: HelmRequest reconciliation pauses until the new Pod is Ready. Precondition: note the current image with the first command. Rollback: `kubectl -n <namespace> rollout undo deployment/captain-controller-manager`. The restart does not delete charts.

   ```bash
   kubectl -n <namespace> get deploy captain-controller-manager -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
   kubectl -n <namespace> rollout restart deployment/captain-controller-manager
   kubectl -n <namespace> rollout status deployment/captain-controller-manager
   ```

5. Retest the template upload. If it succeeds and the chart is hidden only in an ARM cluster namespace, the chart's architecture label is the remaining filter, not the port.

### Cause 3

1. Type the directory name in the template-directory field; this creates the directory under the chart repository.
2. If the repository is OCI and its address includes a project path (`library` or another project name), change the address to the Harbor host only and open the upload dialog again. The Harbor projects are then offered as directories.
3. If the address contains a Harbor web UI path such as `/harbor/projects/<id>/repositories`, remove that path first.

A bare host address does not by itself list charts that were pushed straight to Harbor; see the related article for that case.

## Diagnostic Steps

```bash
kubectl get chartrepo -n cpaas-system -o custom-columns=NAME:.metadata.name,TYPE:.spec.type,URL:.spec.url,PHASE:.status.phase,REASON:.status.reason
```

| Check | Conclusion |
| --- | --- |
| The attempted upload used `violet`, and the package is a plain chart `.tgz` | Cause 1 |
| `captain-controller` log cannot connect to the Harbor VIP on port 80; `curl` to port 80 times out or is refused | Cause 2 |
| No template directory to select, or an OCI repository whose `URL` includes a project path | Cause 3 |
| Upload succeeds but the chart or version is not listed | Related article above |
