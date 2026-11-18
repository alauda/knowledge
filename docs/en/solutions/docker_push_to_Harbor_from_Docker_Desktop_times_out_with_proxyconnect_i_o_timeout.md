---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.3"
---

# docker push to Harbor from Docker Desktop times out with proxyconnect i/o timeout

## Issue

`docker push` from a workstation running Docker Desktop (for example on macOS) to the platform Harbor times out. The error names a proxy rather than Harbor:

```text
proxyconnect tcp: dial tcp <proxy-address>:3128: i/o timeout
```

The proxy on port `3128` is Docker Desktop's own HTTP proxy (`http.docker.internal:3128`). `docker info` shows an `HTTP Proxy` / `HTTPS Proxy`, and its `No Proxy` list contains only entries such as `hubproxy.docker.internal`, not the Harbor address.

Related articles: [Harbor push of large image layers fails with unexpected EOF, timeout awaiting response headers, or 408 on ACP](Harbor_push_of_large_image_layers_fails_with_unexpected_EOF_timeout_awaiting_response_headers_or_408_on_ACP.md) and [Harbor image push fails while harbor-nginx restarts, or is rejected with too large on a NodePort Harbor](Harbor_image_push_fails_while_harbor-nginx_restarts_or_is_rejected_with_too_large_on_a_NodePort_Harbor.md).

## Root Cause

### Cause 1: Docker Desktop sends the registry traffic to its proxy

Docker Desktop is configured with an HTTP/HTTPS proxy, and the Harbor address is not in its `No Proxy` (bypass) list. The engine therefore sends the push to the proxy instead of connecting to Harbor directly. The proxy cannot reach the internal Harbor address, so the connection times out before any layer is uploaded. Adding the Harbor address to the `No Proxy` list in Docker Desktop stops the timeout.

## Resolution

### Cause 1: Docker Desktop sends the registry traffic to its proxy

1. In Docker Desktop, open the proxy settings (**Settings > Resources > Proxies** in current releases) and add the Harbor host or IP address, with and without the port as your clients use it, to the bypass / `No Proxy` list. Keep the existing entries.
2. Apply the change. Docker Desktop restarts its engine, which stops running containers on that workstation until it is back.
3. Check that the address is now bypassed and retry:

   ```bash
   docker info | grep -iE 'HTTP Proxy|HTTPS Proxy|No Proxy'
   docker login <harbor-host>:<port>
   docker push <harbor-host>:<port>/<project>/<repository>:<tag>
   ```

On a Linux host with `dockerd`, the same rule applies: the daemon's proxy configuration must list the Harbor address in `NO_PROXY` / `no-proxy`.

If the timeout is gone but large layers now stop in `Pushing` and the push ends with `unexpected EOF`, the proxy is fixed and the remaining failure is on the network path; continue with Cause 2 of [Harbor push of large image layers fails with unexpected EOF, timeout awaiting response headers, or 408 on ACP](Harbor_push_of_large_image_layers_fails_with_unexpected_EOF_timeout_awaiting_response_headers_or_408_on_ACP.md). Increasing the Docker Desktop memory does not fix that.

## Diagnostic Steps

1. Read the engine's proxy settings and the shell's proxy environment:

   ```bash
   docker info | grep -iE 'HTTP Proxy|HTTPS Proxy|No Proxy'
   env | grep -iE 'http_proxy|https_proxy|no_proxy'
   ```

   An `HTTP Proxy` / `HTTPS Proxy` entry, with a `No Proxy` list that does not contain the Harbor address, matches this cause.

2. Test Harbor directly, bypassing any proxy:

   ```bash
   curl -vk --noproxy '*' --connect-timeout 5 https://<harbor-host>:<port>/v2/
   ```

   A response (`401` is normal without credentials) proves that Harbor is reachable directly and only the proxy path fails. A timeout here as well means the workstation cannot reach Harbor at all; check the network path and firewall instead, see [Image registry or Harbor unreachable or slow because of firewall rules, blocked ports, or the network path](Image_registry_or_Harbor_unreachable_or_slow_because_of_firewall_rules_blocked_ports_or_the_network_path.md).
