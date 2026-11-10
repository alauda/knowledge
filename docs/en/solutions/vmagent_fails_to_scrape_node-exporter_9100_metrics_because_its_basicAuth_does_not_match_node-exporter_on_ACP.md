---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion: []
---

# vmagent fails to scrape node-exporter 9100 metrics because its basicAuth does not match node-exporter on ACP

## Issue

After the VictoriaMetrics monitoring plugin is deployed, vmagent reports errors when it scrapes the node-exporter endpoint `https://<node-ip>:9100/metrics`, and the node-exporter targets are down. A manual request to the endpoint without credentials is refused with HTTP `401 Unauthorized`. The node-exporter DaemonSet `kube-prometheus-exporter-node` in `cpaas-system` itself is healthy, with all Pods scheduled, ready and available.

## Root Cause

The node-exporter of the VictoriaMetrics plugin protects `:9100/metrics` with TLS and HTTP basic authentication. The DaemonSet starts node-exporter with `--web.config.file=/etc/node-exporter/config.yaml`, mounted from the ConfigMap `victoriametrics-exporter-node-config` (key `config.yaml`). The TLS certificate and key come from the Secret `victoriametrics-exporter-node-ca`. The web config lists the users that are accepted (`basic_auth_users`, with a bcrypt hash of each password).

vmagent sends the username and password configured in the `basicAuth` section of its node-exporter scrape object. When that username and password do not match a user in the node-exporter web config, every scrape is answered with `401` and all node-exporter targets go down. Nothing on the node is broken. The two sides of the credential simply disagree.

## Resolution

> **Warning:** Restarting vmagent and the node-exporter DaemonSet causes a short gap in node metrics. Save the objects you change first. Rollback: apply the saved YAML and restart the same components again. Do this only after the diagnostic steps show that a request with the vmagent credentials returns `401`.

1. Save the node-exporter web config and the Secret that vmagent uses (see Diagnostic Steps for how to find it):

   ```bash
   kubectl -n cpaas-system get cm victoriametrics-exporter-node-config -o yaml > /tmp/victoriametrics-exporter-node-config.yaml
   kubectl -n cpaas-system get secret <scrape-basic-auth-secret> -o yaml > /tmp/<scrape-basic-auth-secret>.yaml
   ```

2. Make the two sides consistent. Use one of these:

   - Set the username and password in the Secret that the vmagent scrape object references to a user that the node-exporter web config accepts.
   - Or put the vmagent username into `basic_auth_users` of `config.yaml` in `victoriametrics-exporter-node-config`, with a bcrypt hash of the vmagent password. A bcrypt hash can be generated, for example, with:

     ```bash
     htpasswd -nbBC 10 "" '<password>' | tr -d ':\n'; echo
     ```

3. Restart node-exporter and vmagent so that both load the new configuration:

   ```bash
   kubectl -n cpaas-system rollout restart ds/kube-prometheus-exporter-node
   kubectl -n cpaas-system get deploy,sts | grep -i vmagent
   kubectl -n cpaas-system rollout restart <deploy|sts>/<vmagent-name>
   ```

4. Check that the node-exporter targets are up again, and that a request with the vmagent credentials now returns metrics (see Diagnostic Steps, step 3).

If the change is reverted after a plugin reconcile or upgrade, make the same change through the plugin configuration instead of editing the generated objects only.

## Diagnostic Steps

1. Read how the node-exporter is started and where its web config comes from:

   ```bash
   kubectl -n cpaas-system get ds kube-prometheus-exporter-node -o yaml | grep -n -E 'web.config.file|configMap|secretName|name: '
   kubectl -n cpaas-system get cm victoriametrics-exporter-node-config -o jsonpath='{.data.config\.yaml}'; echo
   ```

   Expected: `--web.config.file=/etc/node-exporter/config.yaml`, and a `basic_auth_users` map in `config.yaml`. Note the username(s).

2. Find the basicAuth that vmagent uses for node-exporter, and decode its username and password:

   ```bash
   kubectl -n cpaas-system get servicemonitor,vmnodescrape,vmservicescrape 2>/dev/null | grep -i node
   kubectl -n cpaas-system get <kind>/<node-exporter-scrape-object> -o yaml | grep -n -A6 basicAuth
   kubectl -n cpaas-system get secret <scrape-basic-auth-secret> -o jsonpath='{.data.username}' | base64 -d; echo
   kubectl -n cpaas-system get secret <scrape-basic-auth-secret> -o jsonpath='{.data.password}' | base64 -d; echo
   ```

   A username that is not in `basic_auth_users` already confirms the mismatch.

3. Test the endpoint from a node with and without the vmagent credentials:

   ```bash
   curl -k -s -o /dev/null -w '%{http_code}\n' https://<node-ip>:9100/metrics
   curl -k -s -o /dev/null -w '%{http_code}\n' -u '<username>:<password>' https://<node-ip>:9100/metrics
   ```

   Expected for this issue: `401` for both requests. After the fix, the request with credentials returns `200`.

4. Rule out look-alikes. A connection error or timeout instead of `401` points to the network or to the node-exporter Pod, not to credentials. A `200` with credentials but down targets points to the scrape configuration (port, scheme, timeout), not to basicAuth.
