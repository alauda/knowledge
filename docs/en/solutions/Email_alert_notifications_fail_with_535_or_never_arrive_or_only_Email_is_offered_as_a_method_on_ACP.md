---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "3.18"
  - "4.0"
  - "4.2"
  - "4.3"
---

# Email alert notifications fail with 535 or never arrive, or only Email is offered as a method on ACP

## Issue

One of the following is seen when alert notifications are set up on Alauda Container Platform:

- The notification method picker on the **Create Notification Policy** page (**Operations Center** > **Notification**) shows only `Email`. Feishu, DingTalk, and webhook are not offered, or a Feishu group stays empty.
- Configured email alerts keep reporting a notification failure. Alert history shows the notification with method `Email`, `status: False`, `type: Ready`, `phase: Failed`, and the message `535 "Error: authentication failed"`.
- Alert records show the email notification as sent (`完成`, Done: `"method": "Email"`, `"status": "True"`, `"phase": "Done"`), but no email arrives for many hours, then some arrive, and the gap repeats.

Timeouts to the mail server, TLS errors, and DNS problems on the send path are covered in [Alert notifications are not delivered because courier-api or apollo cannot reach the receiver on ACP](Alert_notifications_are_not_delivered_because_courier-api_or_apollo_cannot_reach_the_receiver_on_ACP.md).

## Root Cause

### Cause 1: only Email is listed until the other notification server is configured

The other notification methods are not removed; their notification server is not configured or not enabled. The method list stays email-only until that server exists. A Feishu group that stays empty until Feishu webhook notification is switched on, and the policy is saved again, is the same gap.

The notification server types under **Platform Management** > **Operations Center** > **Notification** > **Notification Server** are:

- Enterprise communication tool server: WeCom, DingTalk, and Feishu built-in apps, sending to individuals.
- Email server.
- Webhook-type server: WeCom, DingTalk, and Feishu group robots, or a webhook to a specified server.
- Extensible forwarding server, for other notification channels.

Pushing platform alerts to DingTalk is therefore possible in two ways: a DingTalk built-in app on an enterprise communication tool server, or a DingTalk group robot on a webhook-type server.

### Cause 2: 535 Error: authentication failed

`535` is the SMTP server rejecting the user name or password configured on the email notification server that the notification policy uses. It is not a connection timeout; a timeout with no SMTP reply is a network problem.

### Cause 3: the mail provider bounced the message after accepting it

`Done` means that the SMTP server accepted the message. The provider can still return it afterwards. When the sending account exceeds the provider's outbound frequency limit, the provider bounces the message and the recipients never receive it, while the platform log for the send shows no SMTP error. The bounce notice appears in the `courier-api` log on the `global` cluster, for example with the reason `您的账号外发频率超过邮件系统限制，导致邮件被系统退回` (your account's outbound frequency exceeds the mail system limit, so the message was returned) and the reference `ESO_FRECTRL: Frequency of sending is controlled.`

## Resolution

### Cause 1: only Email is listed until the other notification server is configured

1. Configure the notification server for the channel under **Operations Center** > **Notification** > **Notification Server**.
2. For a webhook-type server, check that the feature gate `webhook-notification-server` is `true`, and that `webhook-template` is `true` when the body must be rendered from a notification template:

   ```bash
   kubectl get alaudafeaturegates.alauda.io webhook-notification-server -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
   kubectl get alaudafeaturegates.alauda.io webhook-template -n cpaas-system -o jsonpath='{.spec.enabled}{"\n"}'
   ```

   > **Warning:** Enabling `webhook-notification-server` or `webhook-template` changes how alerts leave the cluster. Receivers that parse the current body see a different payload as soon as a template is bound. Do this only when the webhook URL and a valid JSON template are ready. To roll back, set `spec.enabled` back to `false` with the same patch.

   ```bash
   kubectl patch AlaudaFeatureGate webhook-notification-server -n cpaas-system \
     --type='json' -p='[{"op": "replace", "path": "/spec/enabled", "value": true}]'
   ```

   Feishu and email servers are enabled in the Operations Center notification settings, not by this gate. When the webhook-type server option itself is missing from the console, it is controlled by the `enable` field of the Secret `platform-wechat-server` in `cpaas-system`.

3. Edit the notification policy, select the channel, save, and run the platform test send. A successful test that later fails in production with a timeout is a network problem, not a missing server.

### Cause 2: 535 Error: authentication failed

1. Confirm the signature before changing a password:

   ```bash
   kubectl get pods -A | grep -E 'courier-api|apollo'
   kubectl logs -n <namespace> deploy/courier-api --tail=300 | grep -F '535'
   kubectl logs -n <namespace> <apollo-pod> --tail=300 | grep -F '535'
   ```

2. Correct the SMTP user name and password on the email notification server used by the failing policy (Operations Center notification settings) so that they match what the SMTP server accepts.

   > **Warning:** The new credentials are used by every later mail notification for that server, and a wrong value keeps the phase `Failed`. Do this only when the message is `535 "Error: authentication failed"` and you can sign in to the SMTP server with the new credentials from outside the cluster. Note the previous user name first; to roll back, restore the previous credentials on the same notification server.

3. Send one test. Success is a notification phase that is no longer `Failed` with `535`.

### Cause 3: the mail provider bounced the message after accepting it

1. Confirm that the platform marked the send `Done`, then look for the bounce. Notification policies are `notifications.ait.alauda.io` objects on the `global` cluster (there is no `notificationpolicy` resource type):

   ```bash
   kubectl get pods -n cpaas-system | grep -E 'apollo|courier'
   kubectl get notifications.ait.alauda.io -A
   kubectl logs -n cpaas-system <courier-api-pod> > /tmp/courier-api.log
   grep -n -i -E 'ESO_FRECTRL|Frequency of sending|bounce' /tmp/courier-api.log
   ```

   Run the `logs` command for every `courier-api` Pod, and check the sending mailbox for bounce notices.

2. Reduce the number of alert emails the account sends, or have the mail administrator raise the limit or provide another sender account. Platform options include a longer alert sending interval on noisy policies, fewer recipients, and silencing alerts that nobody acts on.

3. Confirm over one full day that every `Done` notification arrives.

## Diagnostic Steps

1. Only `Email` in the method list, and no send line for the other channel in the logs: Cause 1.

2. Read the notification condition of a failed alert in alert history:
   - `phase: Failed` with `535 "Error: authentication failed"`: Cause 2.
   - `phase: Done` on an email that never arrives: Cause 3. Expected in the `courier-api` log: a bounce line that cites a sending-frequency limit.
   - `phase: Failed` with a timeout or `dial` error: a network problem; see the related article in the Issue section.

3. Run the log search for every `courier-api` replica; the bounce can be in the log of any of them.
