---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.3"
  - "4.4"
---

# Webhook alert notifications fail with invalid header field value or miss a required custom header on ACP

## Issue

A webhook alert notification that needs custom HTTP request headers (for example an app ID and an access key for an SMS gateway or a third-party alert platform) does not reach the receiver:

- Alert history shows the webhook notification with `"type":"Ready"`, `"status":"False"`, `"phase":"Failed"`, and `courier-api` logs `Failed to send webhook ... net/http: invalid header field value for "X-Open-Api-App-Access-Key"` (the header name differs per receiver). The receiver logs nothing.
- Or the receiver rejects the request because a required header is missing, for example:

  ```text
  {"data":null,"status":"fail","msg":"Required request header 'appkey' for method parameter type String is not present","code":"400"}
  ```

  The platform side can still show the webhook send as successful.

Custom headers are not template variables. The header names and Base64-encoded values are stored under `data` in a Secret of `type: NotificationSender` (for example `webhook-header-secret` in `cpaas-system` on the `global` cluster), and the receiver group (`notificationgroups.ait.alauda.io`) that holds the webhook URL references that Secret with the annotation `cpaas.io/notification.webhook.config`. The platform has no built-in SMS method; an SMS gateway is called through a webhook notification with custom headers.

For receiver groups created under **Project Management**, the Secret must be in the project's namespace; see [Project webhook alert notifications miss custom headers because webhook-header-secret is only in cpaas-system on ACP](Project_webhook_alert_notifications_miss_custom_headers_because_webhook-header-secret_is_only_in_cpaas-system_on_ACP.md).

## Root Cause

### Cause 1: invalid header field value because the Base64 value ends with a newline

The header values in the Secret were Base64-encoded from the output of a plain `echo`, which appends a newline, so each decoded value ends with `\n`. HTTP header values cannot contain a newline, and the Go HTTP client in `courier-api` refuses to build the request. Nothing is sent, and the notification phase is `Failed`. The header name in the error is printed in canonical form: `X-OPEN-API-APP-ACCESS-KEY` in the Secret appears as `X-Open-Api-App-Access-Key` in the log.

### Cause 2: the receiver reports the header as not present because the value was built without echo -n

The receiver answers `400` with `Required request header '<header-name>' ... is not present`, while the platform side shows the send as successful. The value of the header (for example an encrypted `appKey`) was produced from a plain `echo` without `-n`, so the stray characters from the trailing newline broke it and the request went out without a usable header. This is the same mistake as Cause 1, with a different signature: here the request is sent and rejected by the receiver.

### Cause 3: the receiver group is not associated with the header Secret

The receiver group has a webhook URL but no `cpaas.io/notification.webhook.config` annotation, so the platform sends the alert without the custom headers and the receiver rejects it. This also explains a header that suddenly goes missing after the receiver group was recreated or edited.

## Resolution

### Cause 1: invalid header field value because the Base64 value ends with a newline

1. Confirm the signature:

   ```bash
   kubectl get pods -A | grep courier-api
   kubectl logs -n cpaas-system deploy/courier-api --tail=500 | grep -F 'invalid header field value'
   ```

2. Decode every value in the header Secret and check for a line break. `true` in the second column means the value carries a newline:

   ```bash
   kubectl get secret -n cpaas-system webhook-header-secret -o json \
     | jq -r '.data | to_entries[] | "\(.key)\t\(.value | @base64d | test("[\\r\\n]"))"'
   ```

   Without `jq`, decode one key and look for `\n` at the end of the output:

   ```bash
   kubectl get secret -n cpaas-system webhook-header-secret -o jsonpath='{.data.X-OPEN-API-APP-ACCESS-KEY}' | base64 -d | od -c | tail -n 3
   ```

3. Export the Secret:

   ```bash
   kubectl get secret -n cpaas-system webhook-header-secret -o yaml > /tmp/webhook-header-secret.yaml
   ```

4. Re-encode each affected value with `echo -n` and write it back. Repeat for every key that showed `true`:

   > **Warning:** The new values are sent to the receiver on the next notification, for every receiver group that references this Secret. Do this only when `courier-api` logs `invalid header field value` and the decoded value ends with a newline, and only with the exact plaintext the receiver issued. To roll back, run `kubectl apply -f /tmp/webhook-header-secret.yaml`.

   ```bash
   kubectl patch secret -n cpaas-system webhook-header-secret --type merge \
     -p "{\"data\":{\"X-OPEN-API-APP-ACCESS-KEY\":\"$(echo -n '<access-key>' | base64 -w0)\"}}"
   kubectl patch secret -n cpaas-system webhook-header-secret --type merge \
     -p "{\"data\":{\"X-OPEN-API-APPID\":\"$(echo -n '<app-id>' | base64 -w0)\"}}"
   ```

5. Run the decode check again; every key prints `false`. Trigger one alert and confirm that the log no longer shows `invalid header field value`.

If the receiver then returns `InvalidJson`, the header is fixed and the body is the next problem; see [Webhook alert notifications rejected as InvalidJson or sent without the notification template on ACP](Webhook_alert_notifications_rejected_as_InvalidJson_or_sent_without_the_notification_template_on_ACP.md). A template for an SMS gateway maps the gateway's JSON fields to platform variables; the keys and the phone number belong to the receiver:

```text
{
  "requestId": "{{ .fingerprint }}",
  "requestTime": "{{ dateFormatWithZone .startsAt "2006-01-02 15:04:05" "Asia/Shanghai" }}",
  "messageTarget": "<phone-number>",
  "messageContent": "{{ .externalLabels.summary }}"
}
```

### Cause 2: the receiver reports the header as not present because the value was built without echo -n

1. Confirm the `400` text and find the header Secret:

   ```bash
   kubectl logs -n <namespace> deploy/courier-api --tail=300 | grep -F "appkey"
   kubectl get secret -n cpaas-system --field-selector type=NotificationSender
   kubectl get secret -n cpaas-system <secret-name> -o yaml > /tmp/<secret-name>.yaml
   ```

2. Produce the plaintext without a trailing newline, and pass that output to the encryption or encoding the receiver requires:

   ```bash
   echo -n '<appKey>'
   ```

3. Write the new value into the Secret.

   > **Warning:** The new value is sent to the third party on the next notification. Do this only when the receiver reports the header as missing with code `400` and the previous value was produced with plain `echo`. To roll back, run `kubectl apply -f /tmp/<secret-name>.yaml`. If the header is still missing after `echo -n` was used, check the receiver-group association (Cause 3).

4. Send one test and confirm that the `400` line is gone and the receiver gets the notification.

### Cause 3: the receiver group is not associated with the header Secret

1. On the `global` cluster, find the receiver group that holds the webhook URL and check for the annotation:

   ```bash
   kubectl get notificationgroups.ait.alauda.io -n cpaas-system
   kubectl get notificationgroups.ait.alauda.io -n cpaas-system <notification-group-name> -o yaml | grep -n -E 'notification.webhook.config|webhook'
   kubectl get secret -n cpaas-system webhook-header-secret
   ```

2. Add the annotation, with the name of the header Secret as its value.

   > **Warning:** Every webhook notification sent to this receiver group then carries the headers stored in the Secret. Do this only when the receiver reports the header as missing and the group has no `cpaas.io/notification.webhook.config` annotation. Export the group first with `kubectl get notificationgroups.ait.alauda.io -n cpaas-system <notification-group-name> -o yaml > /tmp/notificationgroup.yaml`. To roll back, run `kubectl annotate notificationgroups.ait.alauda.io -n cpaas-system <notification-group-name> cpaas.io/notification.webhook.config-`.

   ```bash
   kubectl annotate notificationgroups.ait.alauda.io -n cpaas-system <notification-group-name> \
     cpaas.io/notification.webhook.config=webhook-header-secret
   ```

3. Trigger one alert. Notifications return to normal as soon as the association exists.

## Diagnostic Steps

1. Read the sender log for the header:

   ```bash
   kubectl logs -n <namespace> deploy/courier-api --tail=300 | grep -i -E 'appkey|header|400|Failed to send'
   ```

   - `Failed to send webhook` with `net/http: invalid header field value for "<Header-Name>"` and phase `Failed`: Cause 1. Nothing reached the receiver, so do not change the template or the network for this error.
   - `Required request header '<header-name>'` with code `400`: Cause 2 or Cause 3.

2. List the receiver groups with their header annotation. A group without the annotation is Cause 3; a group in a project namespace is the project article linked in the Issue section:

   ```bash
   kubectl get notificationgroups.ait.alauda.io -A \
     -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,HEADER_SECRET:.metadata.annotations.cpaas\.io/notification\.webhook\.config'
   ```

3. Run the decode check from Cause 1. Expected after the fix: every key prints `false`.

4. The header arrives and the receiver still rejects the body: the payload is the problem; see the InvalidJson article.
