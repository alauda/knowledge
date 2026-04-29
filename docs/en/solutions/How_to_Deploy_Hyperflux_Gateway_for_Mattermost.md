---
products:
  - Alauda AI
kind:
  - Solution
---

# How to Deploy Hyperflux Gateway for Mattermost

## Issue

This solution describes how to deploy Hyperflux Gateway so that Mattermost users can ask questions in direct messages or by mentioning a bot in a channel. It is intended for operators who need a Kubernetes-based deployment method that works with the packaged release bundle and supports standard post-install verification.

## Environment

Prepare the following before deployment:

- A reachable Mattermost service URL.
- A Mattermost administrator account with permission to access **System Console**.
- A running Hyperflux environment.
- A Kubernetes cluster where Hyperflux Gateway can be installed.
- The Hyperflux Gateway release bundle that contains `install-k8s.sh`, `uninstall-k8s.sh`, `install.env`, and `image-metadata.json`.

You can download the current release bundle from either of the following URLs:

- `https://cloud.alauda.cn/attachments/knowledge/hyperflux-gateway/hyperflux-gateway-v0.1.3.tar.gz`
- `https://cloud.alauda.io/attachments/knowledge/hyperflux-gateway/hyperflux-gateway-v0.1.3.tar.gz`

If the bundle includes an `images/` directory, import the bundled image before installation.

```bash
nerdctl load -i images/hyperflux-gateway-<version>.tar
nerdctl tag <loaded-image> <customer-registry>/hyperflux-gateway:<version>
nerdctl push <customer-registry>/hyperflux-gateway:<version>
IMAGE=<customer-registry>/hyperflux-gateway:<version> ./install-k8s.sh
```

## Resolution

### 1. Enable bot account creation in Mattermost

Open the Mattermost administrator console:

```text
System Console -> Integrations -> Integration Management
```

Enable the following option:

```text
Enable Bot Account Creation = true
```

If this option is disabled, the **Add Bot Account** button is not shown on the **Bot Accounts** page.

### 2. Create a bot account

Open:

```text
Integrations -> Bot Accounts
```

Click:

```text
Add Bot Account
```

Recommended values:

```text
Username: system-bot
Display Name: System Bot
Description: hyperflux-gateway bot
```

After the bot is created, record its user ID and username.

### 3. Create a bot token

On the **Bot Accounts** page, locate the target bot and click:

```text
Create New Token
```

For example:

```text
Token Description: hyperflux-gateway
```

Copy the generated token immediately because Mattermost only shows it once.

### 4. Add the bot to the target team and channel

Add the bot to the team and channel where users will interact with Hyperflux Gateway.

Default behavior in bot mode:

- Direct messages to the bot are processed directly.
- Channel messages must mention the bot, for example `@system-bot hello`.
- When the bot is mentioned in a thread, Hyperflux Gateway reuses the same thread session.

### 5. Configure Hyperflux authentication

Add the authentication settings required by Hyperflux Gateway to the `cpaas-system/smart-doc-config` ConfigMap. The value of `<hyperflux-api-secret>` must match the value used later during Hyperflux Gateway installation.

```bash
kubectl -n cpaas-system patch configmap smart-doc-config --type merge -p '{
  "data": {
    "HYPERFLUX_API_AUTH": "<hyperflux-api-secret>",
    "HYPERFLUX_API_AUTH_HEADER": "X-API-KEY"
  }
}'
```

After the ConfigMap is updated, verify that the `smart-doc` deployment is rolled out successfully.

```bash
kubectl -n cpaas-system rollout status deployment/smart-doc --timeout=180s
```

### 6. Prepare installation parameters

The release bundle installer reads `install.env` automatically when the file exists in the bundle root. Fill in the required values:

| Variable | Description |
| --- | --- |
| `MATTERMOST_URL` | Mattermost service URL without a trailing `/`. |
| `MATTERMOST_BOT_USER_ID` | The Mattermost bot user ID. |
| `MATTERMOST_BOT_USERNAME` | The Mattermost bot username without `@`. |
| `MATTERMOST_TOKEN` | The bot personal access token. |
| `HYPERFLUX_API_URL` | The Hyperflux API endpoint used by the gateway. |
| `HYPERFLUX_API_AUTH` | The authentication value configured in `smart-doc-config`. |

Other parameters use the defaults embedded in `install-k8s.sh`. Override them only when necessary.

### 7. Perform pre-deployment checks

Before installation, confirm the following:

1. `MATTERMOST_URL` is reachable from the target environment.
2. `MATTERMOST_TOKEN` is a bot token instead of a regular user token.
3. `MATTERMOST_BOT_USER_ID` and `MATTERMOST_BOT_USERNAME` belong to the same bot account.
4. `HYPERFLUX_API_AUTH` matches the value configured in Hyperflux.

### 8. Install Hyperflux Gateway

After `install.env` is prepared, run:

```bash
./install-k8s.sh
```

The installer creates or updates the following resources:

- Namespace
- Secret
- ConfigMap
- Service
- Web deployment
- Mattermost worker deployment

### 9. Override the image when needed

If the customer environment uses a different registry or image location, override the image explicitly during installation:

```bash
IMAGE=<your-image-ref> ./install-k8s.sh
```

### 10. Validate generated resources without applying them

Use dry-run mode to validate the Kubernetes manifests:

```bash
DRY_RUN=true ./install-k8s.sh
```

### 11. Enable slash command or outgoing webhook only when required

The default deployment mode is the WebSocket listener bot mode. If slash command or outgoing webhook integration is also required, add or override the following settings in `install.env`, then rerun the installer:

```bash
MATTERMOST_WEBHOOK_TOKEN=<slash-command-or-outgoing-webhook-token>
ENABLE_WEBSOCKET_WORKER=false
```

If both the bot mode and slash command or webhook mode must remain enabled, use:

```bash
MATTERMOST_WEBHOOK_TOKEN=<slash-command-or-outgoing-webhook-token>
ENABLE_WEBSOCKET_WORKER=true
```

In Mattermost, also confirm:

```text
Enable Commands = true
Enable Outgoing Webhooks = true
```

Use the following callback URL:

```text
https://<gateway-domain>/mattermost/webhook
```

### 12. Uninstall Hyperflux Gateway

To remove the release:

```bash
./uninstall-k8s.sh
```

To also remove the namespace:

```bash
DELETE_NAMESPACE=true ./uninstall-k8s.sh
```

## Diagnostic Steps

### Check deployment rollout status

```bash
kubectl -n hyperflux rollout status deployment/hyperflux-gateway-web --timeout=180s
kubectl -n hyperflux rollout status deployment/hyperflux-gateway-mattermost-worker --timeout=180s
```

### Check the health endpoint

```bash
curl https://<gateway-domain>/healthz
```

Expected output:

```json
{"message":"ok"}
```

### Verify bot interaction behavior

Channel mention test:

```text
@system-bot hello
```

Expected result: the bot replies in the same thread.

Direct message test:

```text
hello
```

Expected result: the bot replies directly in the DM conversation.

Non-mention channel message:

```text
hello everyone
```

Expected result: the bot does not reply.

### Troubleshoot common issues

**The Add Bot Account button is missing**

Verify that the following Mattermost setting is enabled:

```text
System Console -> Integrations -> Integration Management -> Enable Bot Account Creation
```

**The bot replies multiple times**

This usually means multiple listeners are connected to Mattermost at the same time. Keep the WebSocket listener deployment single-threaded and verify the worker count configuration.

**Channel messages do not trigger the bot**

By default, channel messages must mention the bot. Verify that the message includes `@<bot-name>`.

**Slash command or webhook requests do not get a response**

Check the following:

- The callback URL is `https://<gateway-domain>/mattermost/webhook`.
- Mattermost can access the gateway endpoint.
- `MATTERMOST_WEBHOOK_TOKEN` matches the token generated by Mattermost.
- `MATTERMOST_TOKEN` is a valid bot token.
- `HYPERFLUX_API_AUTH` and `HYPERFLUX_API_AUTH_HEADER` match the Hyperflux-side configuration.
