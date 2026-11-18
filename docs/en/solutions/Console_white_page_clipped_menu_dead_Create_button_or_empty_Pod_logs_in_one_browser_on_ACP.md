---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# Console white page, clipped menu, dead Create button, or empty Pod logs in one browser on ACP

## Issue

The platform API is up and the `cpaas-system` Pods are Running, but in one browser or on one PC the console misbehaves:

- a white page, a partly drawn administrator menu, or the container platform UI does not open while another management UI on the same address does;
- **Create** for an Ingress or gateway does nothing, with no error in the browser console;
- the login page at `/console-portal` stays blank with `证书错误` (certificate error) in the address bar;
- EXEC and DEBUG open only a `文件传输` (File Transfer) button, or a `platform.cfc` download fails;
- every Pod log view is empty, and entering EXEC reports `连接失败` (connection failed);
- the console is very slow and needs manual refreshes in one browser;
- monitoring charts are blank on one PC only.

Another browser, a private window, or another PC works. If every browser fails and the browser developer tools (F12) show HTTP 500 or 502, the problem is on the server side, for example [Console returns HTTP 500 or a blank page because apollo or courier on the global cluster fails on ACP](Console_returns_HTTP_500_or_a_blank_page_because_apollo_or_courier_on_the_global_cluster_fails_on_ACP.md).

Related articles: [Console returns 404, shows old pages, or misses menus after an upgrade on ACP](Console_returns_404_shows_old_pages_or_misses_menus_after_an_upgrade_on_ACP.md), [Debug container blocked or left running, and console file upload or download fails on ACP](Debug_container_blocked_or_left_running_and_console_file_upload_or_download_fails_on_ACP.md).

## Root Cause

### Cause 1: stale browser cache or an expired idle session

The browser holds cached static files or a session that expired while the tab was idle. Logging out and in restores a clipped menu; a private window loads the container platform at once; a different browser opens the page. There is no server-side fault.

### Cause 2: the browser is older than the platform version supports

The supported browser versions depend on the platform version; check the browser compatibility list in the documentation of the installed version. An older build causes client-side failures without a server error:

- **Create** does nothing, also in a private window of the same old browser;
- a `platform.cfc` download fails on 4.3.1 in a browser below Chrome 145, while Edge succeeds;
- EXEC and DEBUG show only a **File Transfer** button in a UnionTech (UOS) browser 5.4.38 based on Chromium `83.0.4103.116`;
- the login page stays blank with `证书错误` for a `kube-ca`-issued certificate in an old browser, and displays in a newer version;
- the console is very slow in a Firefox build that is not in the validated set, while Google Chrome on the same client loads quickly; API timings in the browser trace are fast (the slowest XHR about 152 ms) and server-side checks are clean.

### Cause 3: the PC clock is wrong

Monitoring charts are blank on one PC while the same OS and browser draw them elsewhere, and installing another browser does not help. The query time range is likely built from the client clock. This is described in Cause 4 of [Monitoring dashboard panels are blank or drop to zero while the backend has data on ACP](Monitoring_dashboard_panels_are_blank_or_drop_to_zero_while_the_backend_has_data_on_ACP.md).

### Cause 4: Pod logs are empty and EXEC fails because the browser is below the 4.1 requirement

Every Pod log view is empty, including start-up and error logs, and EXEC reports a connection failure, although the application writes to standard output. On 4.1 the browser requirement includes Firefox 140 or later; a lower Firefox version produces exactly this, and both views work after the browser is upgraded.

## Resolution

### Cause 1: stale browser cache or an expired idle session

1. Sign out and sign in again, then try a private window.
2. If the private window works, clear the site data for the platform address only.
3. If a second browser works and the first does not, reset or replace the broken browser profile.

No platform Pod restart is needed when F12 shows no 5xx and `cpaas-system` is Running.

### Cause 2: the browser is older than the platform version supports

1. Read the browser version and its engine version on its **About** page and compare it with the compatibility list of the installed platform version.
2. Move the user to a current Google Chrome (or another browser from the list) and retry.
3. For a slow console, capture a Network trace in the slow browser and in Chrome on the same client; fast API timings and a fast Chrome load point at the browser, not the platform.

If **Create** works but a new Layer 4 Ingress gets no address, check whether its host port (for example `32320`) is already used by another Layer 4 rule; a Layer 4 port cannot be shared, so no second address is allocated. That is not a browser fault.

### Cause 3: the PC clock is wrong

Compare the PC clock and time zone with a PC that renders the charts, correct them, and reload the monitoring view. Cluster NTP and the monitoring stack need no change.

### Cause 4: Pod logs are empty and EXEC fails because the browser is below the 4.1 requirement

1. Confirm that the application has standard output:

   ```bash
   kubectl logs -n <namespace> <pod> -c <container> --tail=20
   ```

2. Check the browser version on its **About** page. On 4.1, Firefox below 140 matches this cause.
3. Upgrade the browser and reopen the page; logs and EXEC display normally.

## Diagnostic Steps

1. Confirm the server side is healthy:

   ```bash
   kubectl get pods -n cpaas-system | grep -E 'frontend|archon|apollo'
   ```

   Expected: all Running. Then in the browser open F12 > **Network** and reload once.

2. Map the result:

   ```text
   private window or another browser works, no 5xx                      -> Cause 1
   Create is a dead click, platform.cfc fails, only File Transfer shown  -> Cause 2
   blank login page with 证书错误 in an old browser only                  -> Cause 2
   console slow in one browser, fast in Chrome on the same client       -> Cause 2
   charts blank on one PC only                                          -> Cause 3
   all Pod logs empty, EXEC connection fails, kubectl logs has output   -> Cause 4
   every browser fails, F12 shows 500 or 502                            -> not this article
   ```

3. Sign-in redirects and 401 from the identity provider are an authentication problem. A 403 with a clear `forbidden` message on one API is authorization, not a browser problem.
