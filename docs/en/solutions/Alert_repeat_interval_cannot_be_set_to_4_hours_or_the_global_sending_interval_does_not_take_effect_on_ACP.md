---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 4.0.x
  - 4.3.x
---

# Alert repeat interval cannot be set to 4 hours, or the global sending interval does not take effect on ACP

## Issue

One of these is reported about how often alert notifications repeat:

- The repeat interval should be 4 hours. On an alert policy, **Policy Configuration** (`策略配置`) > **Alert Sending Interval** (`告警发送间隔`) offers **Global** (`全局`) or **Custom** (`自定义`). With Custom, each level (`灾难告警` disaster, `严重告警` critical, `警告告警` warning, `提示告警` info) has a dropdown with 3 hours and 6 hours, and no 4-hour choice.
- The interval should be changed for all alerts at once.
- The sending interval is changed in the UI (for example to 3 hours, or the global interval), and the notifications keep the old rhythm; the change is visible only after editing the configuration from the backend. The VictoriaMetrics Alertmanager configuration is Secret `vmalertmanager-alertmanager` in `cpaas-system`.

Related article: [Node zombie process alert keeps switching between firing and resolved on ACP](Node_zombie_process_alert_keeps_switching_between_firing_and_resolved_on_ACP.md).

## Root Cause

### Cause 1: 4 hours is not one of the offered repeat intervals

The per-policy dropdown offers 3 hours and 6 hours; a 4-hour repeat interval is not supported. The interval for all alerts is set globally on **Operations Center > Alerts > Alert Settings** (`运维中心 / 告警 / 告警设置`), section **Alert Sending Interval (Global)** (`告警发送间隔 (全局)`). Example values there: disaster 5 minutes, critical 15 minutes, warning 1 hour, info 2 hours. Policies whose sending interval is **Global** use these values; policies set to **Custom** keep their own per-level values. The same page has a separate monitoring-component exception alert section (`监控组件异常告警`) with its own check interval (5 minutes) and notification interval (1 day).

### Cause 2: the UI interval is not written through to the Alertmanager configuration

On ACP 4.0 (for example 4.0.11), a sending interval changed in the UI is not written to the `alertmanager.yaml` key of Secret `vmalertmanager-alertmanager`, so Alertmanager keeps the old configuration. This is a known product issue, fixed in ACP 4.2, where the manual procedure below is no longer needed.

The `warlock` Deployment in `cpaas-system` writes that Secret back. A manual edit therefore has to be made while `warlock` is scaled to 0, and the checksum annotation on ConfigMap `alert-repeat-config` (key `alertmanager.yamMD5`, with that spelling) has to match the file. Any later change of the sending interval in the UI rewrites the Secret and undoes the manual change, so the procedure has to be repeated after each such UI change.

## Resolution

### Cause 1: 4 hours is not one of the offered repeat intervals

Pick 3 hours or 6 hours on each alert policy. To change the interval for all alerts, open **Operations Center > Alerts > Alert Settings**, click **Update** in **Alert Sending Interval (Global)**, set each level, and make sure the policies that should follow it have their sending interval set to **Global**. If the saved global value does not show on the Alertmanager status page, see Cause 2. The backend procedure in Cause 2 does not add a 4-hour choice.

### Cause 2: the UI interval is not written through to the Alertmanager configuration

1. Read the current state and keep copies:

   ```bash
   kubectl get deploy -n cpaas-system warlock -o jsonpath='{.spec.replicas}{"\n"}'
   kubectl get secret -n cpaas-system vmalertmanager-alertmanager -o go-template='{{index .data "alertmanager.yaml"}}' | base64 -d > /tmp/alertmanager.yaml
   cp /tmp/alertmanager.yaml /tmp/alertmanager.yaml.bak
   kubectl get cm -n cpaas-system alert-repeat-config -o yaml > /tmp/alert-repeat-config.yaml
   ```

2. Edit `/tmp/alertmanager.yaml` and set the value that should be live, for example `group_interval: 1m`.

3. Apply it with `warlock` stopped.

   > **Warning:** With `warlock` at 0 replicas the platform does not reconcile alert configuration until it is scaled back, and patching `vmalertmanager-alertmanager` changes the configuration every notification uses. Precondition: the UI value is missing from the Alertmanager status page, `/tmp/alertmanager.yaml.bak` and `/tmp/alert-repeat-config.yaml` exist, and the `warlock` replica count is written down. Rollback: patch the Secret from the backup file with the same command, `kubectl apply -f /tmp/alert-repeat-config.yaml`, and scale `warlock` back.

   ```bash
   kubectl scale deploy -n cpaas-system warlock --replicas=0
   kubectl patch secret vmalertmanager-alertmanager -n cpaas-system --type=merge \
     -p "{\"data\":{\"alertmanager.yaml\":\"$(base64 < /tmp/alertmanager.yaml | tr -d '\n')\"}}"
   md5sum /tmp/alertmanager.yaml | awk '{print $1}'
   kubectl edit cm -n cpaas-system alert-repeat-config
   kubectl scale deploy -n cpaas-system warlock --replicas=<previous>
   ```

   In `kubectl edit`, set the annotation `alertmanager.yamMD5` to the hash printed by `md5sum` (the hash only, not the file name).

4. Wait about five minutes, open the Alertmanager status page, and confirm that the value matches the file. If the old value is still shown, the Secret key or the annotation was not the one `warlock` reads; do not patch other keys.

5. After any later change of the sending interval in the UI, check the status page again and repeat the procedure if the value was reverted. On ACP 4.2 and later, set the interval in the UI only.

## Diagnostic Steps

1. A request for 4 hours, with the dropdown showing 3 hours and 6 hours: Cause 1.

2. Decode the live configuration and compare it with the UI value:

   ```bash
   kubectl -n cpaas-system get secret vmalertmanager-alertmanager -o jsonpath='{.data.alertmanager\.yaml}' | base64 -d | grep -n -E 'group_interval|repeat_interval'
   ```

   Expected for Cause 2: the interval saved in the UI does not appear in the file or on the Alertmanager status page.

3. If notifications for one alert alternate between firing and resolved, the interval is not the problem; see the related article.
