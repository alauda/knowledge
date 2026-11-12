---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.10"
  - "3.14"
  - "3.18"
  - "4.0"
  - "4.1"
  - "4.2"
  - "4.3"
---

# DingTalk robot rejects alert notifications with errcode 300001 or 310000 on ACP

## Issue

Alert notifications to a DingTalk group robot are not delivered. `courier-api` reaches the robot, and the DingTalk server rejects the request with one of:

- `errcode: 300001`, `errmsg: msgtype is null`.
- `errcode: 310000` with a signature-mismatch message.
- `errcode: 310000` with `ip 不在白名单中` (IP address is not in the allow-list). In alert history the notification condition for the DingTalk method shows `type: "Ready"`, `status: "False"`, `phase: "Failed"` and:

  ```text
  webhook error code is not zero, map[errcode:310000 errmsg:错误描述:ip 不在白名单中;解决方案:请联系对应群的管理员，设置机器人安全ip地址段]
  ```

Connectivity works, because the DingTalk server answered. A connect timeout is covered in [Alert notifications are not delivered because courier-api or apollo cannot reach the receiver on ACP](Alert_notifications_are_not_delivered_because_courier-api_or_apollo_cannot_reach_the_receiver_on_ACP.md).

Related article: [Webhook alert notifications rejected as InvalidJson or sent without the notification template on ACP](Webhook_alert_notifications_rejected_as_InvalidJson_or_sent_without_the_notification_template_on_ACP.md) covers template rendering, `InvalidJson`, and the `webhook-template` feature gate.

## Root Cause

### Cause 1: errcode 300001, msgtype is null

The JSON body has no `msgtype` field, so DingTalk discards it. This happens when webhook template rendering is off (the `webhook-template` feature gate is not `true`), or when the template is not a DingTalk `text` or `markdown` object. A body that contains `"msgtype": "text"` returns HTTP 200 and `errcode: 0`.

### Cause 2: errcode 310000, the robot signature does not match

In sign mode, DingTalk requires every request to carry a fresh `timestamp` and `sign` query parameter computed from the robot secret. The notification configuration only supports a static webhook URL and static headers, so it cannot generate those two values, and no header added to the contact group fixes this.

DingTalk uses the same `errcode: 310000` for its other robot security checks. Read `errmsg`: if it names the IP allow-list, it is Cause 3.

### Cause 3: errcode 310000, IP not in the allow-list, because the SNAT address is not allow-listed

The robot's security setting `IP地址(段)` (IP address range) is on. DingTalk checks the source IP of the request that reaches its public service. When the alerts go out through a proxy or NAT, that source IP is the public SNAT address of the egress path, not the internal segment of the proxy or of the cluster nodes. Allow-listing internal segments therefore never matches.

## Resolution

### Cause 1: errcode 300001, msgtype is null

1. Write the notification template body as JSON with a `msgtype`. A minimal DingTalk text body:

   ```json
   {
     "msgtype": "text",
     "text": {
       "content": "{{ .labels.alertname }} status={{ .status }} namespace={{ .labels.alert_involved_object_namespace }}"
     }
   }
   ```

   A markdown robot uses `"msgtype": "markdown"` and a `markdown` object with `title` and `text`. Store the body on the notification template (**Operations Center** > **Notification** > **Templates**, message type **Alert Message**, webhook body). The object is a `NotificationTemplate`:

   ```bash
   kubectl get notificationtemplate -A
   ```

2. Enable rendering only after the body is valid JSON. Check the gate, and see the related article for how to enable it and what that changes:

   ```bash
   kubectl get alaudafeaturegates.alauda.io webhook-template -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
   ```

3. Post one test to the robot directly. Replace `<token>` with the robot access token.

   > **Warning:** This POST writes a message into the DingTalk group bound to the token, visible to everyone in the group. It does not change cluster state. Use it only for the robot you intend to test, with sign mode off. A posted message cannot be rolled back; delete it in the DingTalk client if needed.

   ```bash
   curl -sS -X POST 'https://oapi.dingtalk.com/robot/send?access_token=<token>' \
     -H 'Content-Type: application/json' \
     -d '{"msgtype":"text","text":{"content":"acp alert template test"}}'
   ```

   HTTP 200 and `errcode: 0` means the robot accepts this shape. If the same URL returns `310000`, continue with Cause 2 or Cause 3; do not keep rewriting `msgtype`.

### Cause 2: errcode 310000, the robot signature does not match

1. Confirm the error and read `errmsg`:

   ```bash
   kubectl logs -n cpaas-system deploy/courier-api --tail=200 | grep -F '310000'
   ```

2. No ACP setting signs the request. Turn off the robot's sign security mode and protect the robot with a keyword filter, an IP allow-list of the public egress address (Cause 3), or both. An unsigned robot URL works as a bearer secret: anyone who has it can post, so prefer keyword plus allow-list.

3. If sign mode is mandatory, put a signing proxy that you operate in front of DingTalk and point the contact group at it. Do not add a static `timestamp` header; DingTalk rejects it as stale.

### Cause 3: errcode 310000, IP not in the allow-list, because the SNAT address is not allow-listed

1. Confirm the `errmsg` in the notification condition in alert history (expand the notification of the failed alert), or in the sender log:

   ```bash
   kubectl logs -n cpaas-system deploy/courier-api --tail=300 | grep -F '310000'
   ```

2. Ask the network team which public address the proxy or NAT uses for traffic to DingTalk. That is the source IP DingTalk sees.

3. Add that public address to the robot's IP allow-list in the DingTalk group robot settings.

   > **Warning:** Any client behind that public IP can post to the group if it also has the robot URL. Do this only when `errmsg` is `ip 不在白名单中` and the address is the SNAT address of the path your alerts use. The group administrator makes the change; to roll back, remove the address from the robot's security settings.

4. Trigger an alert. The group receives it, showing status `告警中` (firing), the cluster, the object, and the policy name.

## Diagnostic Steps

1. Copy the response of one failed send from the `courier-api` log:

   ```bash
   kubectl get pods -n cpaas-system | grep courier-api
   kubectl logs -n cpaas-system deploy/courier-api --tail=300 | grep -i -E 'errcode|msgtype|timeout'
   ```

2. Map the response to a cause:
   - `errcode: 300001`: Cause 1.
   - `errcode: 310000` with a signature message: Cause 2.
   - `errcode: 310000` with `ip 不在白名单中`: Cause 3.
   - A timeout with no HTTP response: not a robot rejection; see the delivery article in the Issue section.

3. For Cause 1, confirm the gate state before blaming the template text:

   ```bash
   kubectl get alaudafeaturegates.alauda.io webhook-template -n cpaas-system -o yaml
   ```
