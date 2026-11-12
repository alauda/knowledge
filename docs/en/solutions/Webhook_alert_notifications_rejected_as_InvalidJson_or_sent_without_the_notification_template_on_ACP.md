---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.14"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# Webhook alert notifications rejected as InvalidJson or sent without the notification template on ACP

## Issue

Webhook alert notifications reach the receiver, but the receiver rejects the body or the body does not follow the configured notification template. Typical symptoms:

- Feishu or another webhook receiver returns `InvalidJson`, often `invalid character 'å' looking for beginning of value`. The message that does arrive has empty severity, cluster, target, and description, and a zero timestamp.
- A third-party receiver gets some alerts and not others; `webhook-business` logs a render failure for the missing ones.
- The receiver gets the raw Alertmanager alert (top-level `labels`, `annotations`, `startsAt`, `endsAt` = `0001-01-01T00:00:00Z` while firing, `fingerprint`, `generatorURL`, `status`) instead of the fields in the template, for example after an upgrade.
- On v3.18.2 a customized webhook template has no effect, the courier logs never mention the target address, and alert history shows `notifications: null` with Ready reason `NoNotifications`.
- Webhook alerts are not sent according to the template while the `webhook-template` feature gate is on.

The webhook body is rendered from the alert's labels, annotations, and status fields. For workload alerts that includes the resources that triggered it, such as `.labels.alert_involved_object_namespace` and the involved object's name, so a receiver can identify the target from those fields. No other identifier is added.

Related article: [DingTalk robot rejects alert notifications with errcode 300001 or 310000 on ACP](DingTalk_robot_rejects_alert_notifications_with_errcode_300001_or_310000_on_ACP.md).

## Root Cause

### Cause 1: InvalidJson because the template is still Markdown or HTML

Webhook rendering requires the rendered string to be one JSON value. When the notification template is still the default Markdown or HTML sample, the receiver's parser fails at the first character, so the fields it would have read stay empty and the timestamp is zero. `apollo` logs `InvalidJson`.

### Cause 2: invalid JSON because printf "%q" is wrapped in extra quotes

`webhook-business` renders some alerts and drops others with invalid JSON. The field that breaks is typically:

```text
"meta_info": "{{ printf "%q" .labels.alert_involved_object_namespace }}"
```

`printf "%q"` already emits a double-quoted string, so wrapping it in another pair of quotes produces `""value""`, which is not valid JSON. Alerts whose labels do not exercise that branch still send, so the failure looks intermittent. Field names that the receiver requires (for example `severity`, `alarm_name`, `alarm_content`) belong to the receiver's schema, not to the platform.

### Cause 3: the webhook-template feature gate is off on 4.x, so the template is ignored

When the `AlaudaFeatureGate` `webhook-template` in `cpaas-system` has `spec.enabled` other than `true` (or its console switch is off), rendering never runs: `notificationmessage.spec.body`, the raw Alertmanager alert, is posted and the template has no effect. This can appear after an upgrade, for example from 3.14.2 to 4.2.4. The `Webhook begin` entry in the `apollo` log then shows the untransformed alert. The gate is Alpha and was added in 3.14; its description warns that enabling it may change the format of existing webhook alerts.

### Cause 4: webhookTemplate is off on v3.18.2

On platform v3.18.2, custom webhook alert templates are supported, but the feature gate `webhookTemplate` is disabled by default. With it off, alert history shows `notifications: null` and Ready reason `NoNotifications`, and the courier logs do not contain the target webhook address. This is the 3.18 values key `global.featureGate.webhookTemplate`, not the 4.x object of Cause 3.

### Cause 5: the receiver does not need rendering, but webhook-template is on

Webhook processing includes a JSON rendering step. Some receivers need it and others do not. A receiver that does not expect a rendered body can fail while `webhook-template` is on, and work again once the gate is off. This is the reverse of Cause 3: the same gate, in the other state, fixes a different receiver.

## Resolution

### Cause 1: InvalidJson because the template is still Markdown or HTML

Replace the Markdown or HTML sample with one JSON object that the receiver accepts. For a Feishu custom bot, a text message has this shape (match the receiver's own documentation if it differs):

```json
{
  "msg_type": "text",
  "content": {
    "text": "{{ .labels.alertname }} {{ .annotations.description }}"
  }
}
```

If a value can contain quotes or newlines, use the quoting form in Cause 2. Send again and confirm that `apollo` no longer logs `InvalidJson`.

### Cause 2: invalid JSON because printf "%q" is wrapped in extra quotes

Remove the extra quotes, because `%q` already adds them:

```text
"meta_info": {{ printf "%q" .labels.alert_involved_object_namespace }}
```

For a single token with no quote and no newline, plain interpolation is also valid; do not mix the two forms:

```text
"meta_info": "{{ .labels.alert_involved_object_namespace }}"
```

Use the receiver's key names. Re-send an alert that previously failed. `webhook-business` logs a successful render and the receiver accepts the body. A body that is valid JSON but still lacks a key the receiver requires is a schema mismatch; compare it with a payload the receiver accepts.

### Cause 3: the webhook-template feature gate is off on 4.x, so the template is ignored

1. Read the gate:

   ```bash
   kubectl get alaudafeaturegates.alauda.io webhook-template -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
   ```

2. Enable it on the console page `/console-platform/feature-gate`, or patch the object.

   > **Warning:** Enabling `webhook-template` changes the body of every webhook notification that has a template. Receivers that parse today's raw body receive the rendered template instead, and a template that is still Markdown starts failing with `InvalidJson` (Cause 1). Do this only when the webhook section of the notification template is valid JSON for the receiver. To roll back, run the same patch with `false`.

   ```bash
   kubectl patch AlaudaFeatureGate webhook-template -n cpaas-system \
     --type='json' -p='[{"op": "replace", "path": "/spec/enabled", "value": true}]'
   ```

   If the object was changed through the API and the console switch still shows off, turn the console switch on as well.

3. Trigger an alert. The body follows the template. When no template is bound at all, the native Alertmanager body is posted; bind a notification template if the receiver needs a specific schema.

### Cause 4: webhookTemplate is off on v3.18.2

Confirm the version and the empty notification row first. Then set the platform values key:

```yaml
global:
  featureGate:
    webhookTemplate: true
```

> **Warning:** This turns on custom webhook template rendering. Receivers that parsed the previous body see the template instead, and a template that is not JSON fails as in Cause 1. Do this only on v3.18.2 with `NoNotifications` and the gate still off. To roll back, set the key back to `false`.

Apply it in the platform values that already carry `global.featureGate`. Check the template format, trigger one alert, and confirm that the courier logs now contain the target webhook address.

### Cause 5: the receiver does not need rendering, but webhook-template is on

1. Confirm that the gate is on:

   ```bash
   kubectl get alaudafeaturegates.alauda.io webhook-template -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
   ```

2. Turn the gate off on `/console-platform/feature-gate`, or patch the object.

   > **Warning:** `webhook-template` is platform-wide. Turning it off stops template rendering for every webhook notification, so receivers that depend on a rendered body (for example a DingTalk robot that needs `msgtype`, or a receiver whose schema the template builds) start receiving the native alert body. Do this only when no other webhook receiver relies on a rendered template; list the notification policies that use a webhook method and confirm with their owners first. To roll back, set the gate back to `true`.

   ```bash
   kubectl patch AlaudaFeatureGate webhook-template -n cpaas-system \
     --type='json' -p='[{"op": "replace", "path": "/spec/enabled", "value": false}]'
   ```

3. Trigger one alert and confirm that the receiver accepts it. No per-receiver setting for this gate is available.

## Diagnostic Steps

1. Copy the response line of one failed send:

   ```bash
   kubectl get pods -n cpaas-system | grep -E 'apollo|courier-api'
   kubectl logs -n cpaas-system deploy/courier-api --tail=300 | grep -i -E 'errcode|InvalidJson|Webhook begin|invalid header'
   kubectl logs -n cpaas-system <apollo-pod> --tail=200 | grep -i -E 'InvalidJson|Webhook begin'
   ```

2. Map it to a cause:
   - `InvalidJson`, or a rendered body that starts with `#`, `<`, or a letter: Cause 1.
   - A render error in `webhook-business` on some alerts only, on a field wrapped with `printf "%q"`: Cause 2.
   - The receiver gets the raw Alertmanager alert, or `Webhook begin` shows it: Cause 3. Expected gate value: not `true`.
   - `notifications: null` and `NoNotifications` on v3.18.2: Cause 4.
   - Messages not sent as expected while the gate is already `true`, for a receiver that does not need rendering: Cause 5.

3. A `courier-api` `Failed to send webhook` error with no HTTP response, such as `invalid header field value`, means nothing was posted; the gate is not the cause. See [Webhook alert notifications fail with invalid header field value or miss a required custom header on ACP](Webhook_alert_notifications_fail_with_invalid_header_field_value_or_miss_a_required_custom_header_on_ACP.md).
