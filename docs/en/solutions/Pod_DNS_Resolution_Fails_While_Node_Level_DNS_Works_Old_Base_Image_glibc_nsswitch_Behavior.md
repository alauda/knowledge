---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---
## Issue

Application pods cannot resolve an external hostname, while the same lookup works cleanly from the host OS on the same node. A typical failure from inside the pod is:

```text
$ curl https://example.service.internal/
curl: (6) Could not resolve host
```

A DNS packet capture makes the situation more confusing rather than less:

- Queries do leave the pod — they show up on the wire, destination `10.96.0.10:53` (the cluster DNS service IP) as expected.
- The cluster DNS (CoreDNS) replies with a valid answer — A records, non-zero TTL, `rcode: NOERROR`.
- `kubectl exec` into a debug pod on the same node resolves the name successfully.
- `dig`/`nslookup` directly from inside the affected pod also succeed.

But the application itself — any call that goes through `getaddrinfo(3)` — returns "could not resolve". This mismatch between "DNS over the wire works" and "resolution via the C library fails" is the signature of a libc / NSS configuration issue inside the container image, not a CoreDNS, CNI, or Service-networking issue.

## Root Cause

`getaddrinfo(3)` does not go straight to UDP:53. It consults the Name Service Switch (NSS) configuration — `/etc/nsswitch.conf` inside the container — which controls which back-ends the C library asks in which order: `files`, `dns`, `mdns`, `myhostname`, `resolve`, etc. It also consults `/etc/resolv.conf` (which is overlaid by kubelet into the pod) to pick nameservers and search domains, plus `/etc/host.conf` and a small set of compile-time defaults built into the libc.

Old base images — those built on glibc versions several years behind current upstream, or whose `/etc/nsswitch.conf` was produced by a package layout that no longer ships by default — can exhibit any of the following:

1. **`nsswitch.conf` missing the `dns` entry.** In its absence, glibc's compiled-in defaults still do DNS on most platforms, but specific older glibc builds either fail silently or emit `EAI_NONAME`.
2. **`nsswitch.conf` still references providers that the image no longer ships** (for example, `myhostname` or `resolve` when `libnss-resolve` was removed). Older glibc returns a lookup error on the first unsatisfied provider rather than falling through.
3. **Stale `resolv.conf` behavior** — old glibc silently capped `options ndots:` or ignored `single-request-reopen`, leading to different truncation/retry semantics than a modern CoreDNS client would expect.
4. **A bug in the compiled glibc's EDNS0 handling** causing responses larger than 512 bytes to be dropped inside the resolver.

All four of these are specifically *inside-the-container-image* failure modes. From the cluster's point of view, DNS is working: the query goes out, the answer comes back. From the application's point of view, `getaddrinfo` returns `EAI_AGAIN` / `EAI_NONAME` and the hostname is treated as unresolvable.

Probing with `dig` or `nslookup` bypasses NSS entirely (those tools implement DNS client logic directly), which is why they succeed while the application fails — they are not a representative test of what the application does.

## Resolution

### Rebuild the container on a current base image

The durable fix is to refresh the application's base image to a current release of its distribution. Modern glibc (>= 2.34) and a distribution-provided `nsswitch.conf` produced in the last year or two do the right thing in all four scenarios above. Concrete steps for the team owning the image:

1. In the application's `Dockerfile`, move `FROM` from a multi-year-old tag to a current one (for example, from an older Debian release to `debian:12-slim`, or from an older minimal base to its current-year LTS equivalent). Rebuild and retag.
2. Re-run the application smoke test. `getaddrinfo` from inside the new image should resolve the same hostnames that failed on the old one; the DNS packet capture should look the same on the wire (queries go out, answers come back) but now the application sees them.

For images that cannot immediately move forward, a fallback is to **bump only the glibc package** inside the existing base and regenerate `/etc/nsswitch.conf` from the up-to-date distribution package. This is a smaller change set than a full base-image swap, but it leaves other old packages (OpenSSL, curl, CA bundles) in place that can cause their own issues later — it is a short-term patch rather than a durable fix.

### If the base image must be kept as-is

Sometimes the application cannot move off the pinned base (regulatory reasons, vendor-certified image, etc.). In that case the operator's levers are:

1. **Fix `/etc/nsswitch.conf` inside the image.** The minimum working configuration for a cluster pod is:

   ```text
   hosts: files dns
   ```

   Bake this into the image rather than mutating it at runtime — kubelet will not override it.

2. **Verify `/etc/resolv.conf` that kubelet injects is acceptable.** The pod's `dnsPolicy` (default `ClusterFirst`) causes kubelet to write a `resolv.conf` that lists the cluster DNS IP and a set of search domains. `ndots:5` is the default. If the application is sensitive to this (for example, a legacy application that assumes `ndots:1`), set `dnsConfig` on the pod spec:

   ```yaml
   spec:
     dnsPolicy: ClusterFirst
     dnsConfig:
       options:
         - name: ndots
           value: "2"
         - name: single-request-reopen
   ```

3. **Clear any libc DNS caches at image build time.** Some old images ship a populated NSCD cache; stale entries in it take precedence over live DNS.

### Not the fix

Do not change the CNI, CoreDNS, or kubelet configuration in response to this symptom. All three are working correctly — the evidence is that the DNS query and reply are on the wire, that CoreDNS is returning the right answer, and that other pods on the same node resolve successfully. The variable that differs between working and non-working pods is the container image.

## Diagnostic Steps

1. **Confirm the failure is inside the libc, not on the wire.**

   ```bash
   # Inside the affected pod: tools that bypass NSS should succeed.
   kubectl exec -n <ns> <pod> -- dig +short example.service.internal
   kubectl exec -n <ns> <pod> -- nslookup example.service.internal
   ```

   If both succeed while `curl` / the application fails with "could not resolve", the problem is NSS / glibc inside the image. If they also fail, CoreDNS, CNI, or the pod's `resolv.conf` is the next place to look.

2. **Inspect the image's NSS configuration.**

   ```bash
   kubectl exec -n <ns> <pod> -- cat /etc/nsswitch.conf | grep '^hosts'
   kubectl exec -n <ns> <pod> -- cat /etc/resolv.conf
   kubectl exec -n <ns> <pod> -- ldd --version | head -n1
   ```

   A missing or unusual `hosts:` line, a glibc version older than 2.28, or a `resolv.conf` without a `nameserver` pointing at the cluster DNS IP, each point at the image as the cause.

3. **Run the same call the application makes, from the image, but with libc tracing.**

   ```bash
   kubectl exec -n <ns> <pod> -- sh -c '
     LD_DEBUG=libs getent hosts example.service.internal 2>&1 | head -n 40
   '
   ```

   `getent hosts` exercises exactly the `getaddrinfo` path the application uses. `LD_DEBUG=libs` exposes which NSS module glibc actually loaded. Absence of `libnss_dns.so.2` being loaded, or an error loading it, confirms the root cause.

4. **Verify a current base image resolves in the same environment.**

   ```bash
   kubectl run dns-probe-new --rm -it \
     --image=debian:12-slim --restart=Never -- \
     sh -c 'apt-get update >/dev/null 2>&1 && apt-get install -y curl >/dev/null 2>&1; curl -sSI https://example.service.internal/'
   ```

   If this probe pod resolves the same hostname successfully, the delta is demonstrably the base image, not the cluster networking.

Treat those four signals as a decision tree: once all four point at the image, stop investigating the cluster layer and focus on the Dockerfile.
