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

# Alert notifications are not delivered because courier-api or apollo cannot reach the receiver on ACP

## Issue

The real-time alert page shows a firing alert, but the mailbox, Feishu bot, DingTalk group, or external monitoring center receives nothing. A test send times out, a webhook POST fails with `tls: failed to verify certificate`, or webhook messages to a receiver addressed by host name only start working after DNS entries are added. A related question is which component, and which nodes, need network access to the mail server or the webhook endpoint for an egress allow-list.

On Alauda Container Platform:

- **Mail** notifications are sent by `apollo`. Its Pod is not pinned to a node and can move after a restart, so the mail server must be reachable from **all nodes of the `global` cluster**.
- **DingTalk, Feishu, and webhook** notifications are sent by `courier-api`, which can be scheduled onto any node of the cluster it runs on (normally `global`). A firewall rule that allows only one node is not enough.

If the receiver answers with an HTTP error such as `errcode` or `InvalidJson`, the request already left the cluster; see [Webhook alert notifications rejected as InvalidJson or sent without the notification template on ACP](Webhook_alert_notifications_rejected_as_InvalidJson_or_sent_without_the_notification_template_on_ACP.md) or [DingTalk robot rejects alert notifications with errcode 300001 or 310000 on ACP](DingTalk_robot_rejects_alert_notifications_with_errcode_300001_or_310000_on_ACP.md). Email failures with `535` or emails marked as sent that never arrive are in [Email alert notifications fail with 535 or never arrive, or only Email is offered as a method on ACP](Email_alert_notifications_fail_with_535_or_never_arrive_or_only_Email_is_offered_as_a_method_on_ACP.md). A missing custom header or `invalid header field value` is in [Webhook alert notifications fail with invalid header field value or miss a required custom header on ACP](Webhook_alert_notifications_fail_with_invalid_header_field_value_or_miss_a_required_custom_header_on_ACP.md).

## Root Cause

### Cause 1: the sender cannot reach the SMTP or webhook server and times out

A test send to Feishu, DingTalk, a webhook, or email times out, for example a `courier-api` connect timeout to the Feishu bot webhook on port 443 that still fails after retries. Email fails the same way when the `global` cluster cannot open the configured SMTP server. Connectivity from a laptop, or from a single node, does not prove the path: the sending Pod can run on any node, so every node needs the route, and an allow-list that names a Pod does not match this traffic.

For QQ Mail, the working settings are SMTP over SSL on port 465 or 587, the full mailbox address as the user name, and the generated authorization code, not the account password, as the password.

### Cause 2: tls: failed to verify certificate because the certificate does not name the webhook host

The webhook POST fails and the notification shows `status: False`, `type: Ready`, `phase: Failed` with a message of this shape:

```text
tls: failed to verify certificate: x509: certificate is valid for 127.0.0.1, 192.0.2.50, not 192.0.2.4
```

The certificate presented by the webhook endpoint does not list the host used in the webhook URL. On platform v3.18.2, HTTPS certificate verification for webhook notifications cannot be skipped.

### Cause 3: the webhook host name does not resolve inside the cluster

Webhook-forwarded alerts to an external system are not delivered, and they are delivered as soon as host entries for the receiver are added to CoreDNS on the `global` cluster. `courier-api` runs as a Pod and resolves the webhook host through cluster DNS (CoreDNS). A name that is known only to a resolver that CoreDNS does not forward to, or only to `/etc/hosts` on a workstation, is not resolvable from the Pod.

## Resolution

### Cause 1: the sender cannot reach the SMTP or webhook server and times out

1. Find the sending Pods and their nodes, then read the send log. Do not restart `courier-api` to "refresh" a timeout; the next schedule lands on the same blocked path.

   ```bash
   kubectl get pods -A -o wide | grep -E 'courier-api|apollo'
   kubectl logs -n cpaas-system deploy/courier-api --tail=200 | grep -i -E 'Failed to send|timeout|dial|refused|errcode'
   kubectl logs -n cpaas-system <apollo-pod> --tail=200 | grep -i -E 'timeout|dial|refused'
   ```

   Use the namespace from the first command if the Pods are not in `cpaas-system`. For a mail failure, read both logs.

2. From the node that hosts the Pod (or from a debug Pod with `hostNetwork` on that node), open the same host and port that the log names, using the real webhook URL or SMTP host:

   ```bash
   curl -sv --max-time 10 "https://<webhook-host>/<webhook-path>"
   ```

3. A timeout here, matching the timeout in the log, is the firewall or the route. Allow the webhook port (443 for a Feishu or DingTalk robot) and the SMTP port from every node of the cluster that runs the sender, or from the NAT address those nodes share. Allow by node address, not by Pod; the Pod name changes on every reschedule.

4. Send one test notification. Success is a send log line without a timeout and a message at the receiver. An HTTP response with `errcode` means the path works and the payload is wrong.

### Cause 2: tls: failed to verify certificate because the certificate does not name the webhook host

1. Confirm the error before changing a URL or a certificate:

   ```bash
   kubectl logs -n cpaas-system deploy/courier-api --tail=300 | grep -F 'failed to verify certificate'
   ```

2. Use one of the two recoveries:
   - Issue a certificate on the webhook endpoint that includes the host used in the URL. This is done on the webhook server, not in the cluster.
   - Change the webhook address to a host that the certificate already lists (the names in the `x509` message).

   > **Warning:** Changing the webhook address stops posts to the previous endpoint as soon as the next alert fires. Do this only when the log says the certificate is valid for names other than the host in the current URL. Write down the current URL first; to roll back, put it back.

### Cause 3: the webhook host name does not resolve inside the cluster

1. Check whether the webhook host resolves from a Pod on the `global` cluster:

   ```bash
   kubectl logs -n cpaas-system deploy/courier-api --tail=300 | grep -i -E 'lookup|no such host'
   kubectl run dns-check -n cpaas-system --rm -it --restart=Never --image=<image-with-nslookup> -- nslookup <webhook-host>
   ```

   `NXDOMAIN` or no answer from the debug Pod, while the same host resolves from the site's own resolver, matches this cause.

2. Preferably, make the name resolvable on the DNS servers that the nodes use, so that CoreDNS forwards it. If that is not possible, add a static record to cluster DNS. The persistent way is a **Host Alias** entry in the **Alauda Container Platform Cluster DNS** plugin, as described in [Platform console does not open because the cluster VIP domain name cannot be resolved inside the cluster on ACP](Platform_console_does_not_open_because_the_cluster_VIP_domain_name_cannot_be_resolved_inside_the_cluster_on_ACP.md).

3. To add the record directly to the Corefile, find the ConfigMap that the `coredns` Deployment mounts (for example `kube-system/cpaas-coredns`, data key `Corefile`) and export it:

   ```bash
   kubectl get deploy -n kube-system coredns -o jsonpath='{.spec.template.spec.volumes}{"\n"}'
   kubectl get cm -n kube-system cpaas-coredns -o yaml > /tmp/cpaas-coredns.yaml
   ```

   > **Warning:** The Corefile drives DNS for every Pod in the cluster. A syntax error makes CoreDNS fail to parse it and crash-loop, which breaks name resolution cluster-wide. Do this only when the webhook host does not resolve from a Pod and the site's DNS cannot serve it. A manual edit can be overwritten when the Cluster DNS plugin is reconciled. To roll back, run `kubectl apply -f /tmp/cpaas-coredns.yaml` and confirm the `coredns` Pods are `Running` and `Ready`.

   ```bash
   kubectl edit cm -n kube-system cpaas-coredns
   ```

   Add a `hosts` block to the existing server block, before the `forward` line, and keep `fallthrough` so that every other name still resolves:

   ```text
   hosts {
       192.0.2.10 <webhook-host>
       fallthrough
   }
   ```

   If the Corefile has the `reload` plugin, CoreDNS picks up the change on its own; otherwise run `kubectl rollout restart deploy -n kube-system coredns`.

4. Repeat the `nslookup` from the debug Pod, then trigger one alert. Success is a `courier-api` send for that webhook with phase `Done` and the message at the receiver.

## Diagnostic Steps

1. Locate the sender. For mail it is `apollo`; for DingTalk, Feishu, and webhooks it is `courier-api`. List where it runs and where it can run:

   ```bash
   kubectl get pods -A -o wide | grep -E 'courier-api|apollo'
   kubectl get deploy -A | grep courier-api
   kubectl get deploy -n <namespace> courier-api -o jsonpath='{.spec.template.spec.nodeSelector}{"\n"}{.spec.template.spec.affinity}{"\n"}'
   ```

   The destination port is the one in the webhook URL (443 for `https://`).

2. Read the `courier-api` log, and the `apollo` log for mail, for one failed send:
   - `dial` or `i/o timeout`: Cause 1.
   - `failed to verify certificate`: Cause 2.
   - `lookup` or `no such host`, or a host name that a debug Pod cannot resolve: Cause 3.
   - `errcode` or `InvalidJson`: the path works; use the payload articles linked in the Issue section.
   - `invalid header field value`: nothing was sent; use the header article.

3. If a webhook receiver gets some alerts and not others, read the `webhook-business` log. A render failure with invalid JSON means the alert was discarded before sending, which is a template problem, not the network:

   ```bash
   kubectl get pods -A | grep webhook-business
   kubectl logs -n <namespace> <webhook-business-pod> --tail=300 | grep -i -E 'json|render|invalid'
   ```

4. After a network or DNS change, repeat the test from a Pod on a different node. One successful node does not cover the scheduler.
