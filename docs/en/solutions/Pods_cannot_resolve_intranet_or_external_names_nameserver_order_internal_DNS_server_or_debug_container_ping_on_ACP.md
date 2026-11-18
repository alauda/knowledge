---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - "4.2"
  - "4.3"
---

# Pods cannot resolve intranet or external names: nameserver order, internal DNS server or debug container ping on ACP

## Issue

Pods fail to resolve names outside the cluster. Typical reports:

- External names from Pods succeed and then fail. The node `/etc/resolv.conf` lists several `nameserver` lines, mixing an intranet DNS that does not recurse to the public Internet with one that does.
- The node scale-out precheck stops and says `/etc/resolv.conf` may contain only two `nameserver` entries, while the site needs intranet and public resolution.
- Applications must reach external systems by domain name, and those names are served only by an internal DNS server: `nslookup <external-system-domain>` from a Pod returns `NXDOMAIN` or times out.
- `ping <domain>` in a container debug session reports that the name cannot be resolved, while `ping <address>` of the same host works.

Related articles: "Pods fail to resolve Service names or resolve them to external addresses: search domains and ndots on ACP"; "Host DNS changes do not reach CoreDNS: systemd-resolved, kubelet resolvConf, missing nameserver or a new upstream on ACP".

## Root Cause

### Cause 1: a list of nameservers is not split-horizon

A list of nameservers in `/etc/resolv.conf` is not "ask the next server when this one says no such name". A resolver stops at the first definitive `NXDOMAIN`. Putting an intranet server that does not recurse in front of a public server therefore fails public names, and the reverse order fails intranet names. CoreDNS inherits the same list through `forward . /etc/resolv.conf`. ACP nodes also do not accept more than two `nameserver` lines: the scale-out precheck refuses a longer list, and that limit is not bypassed by a sysctl or a kubelet flag.

### Cause 2: external system names exist only on an internal DNS server

The lookup path is: business Pod, then `kube-dns` (CoreDNS), then `forward`, then the nameservers in `/etc/resolv.conf` of the node that runs the CoreDNS Pod. If neither the Corefile `forward` target nor those node nameservers is the internal DNS server, the internal zone cannot be answered. Either pointing the CoreDNS `forward` at the internal DNS server, or adding the server to the node resolver file on every node and restarting CoreDNS, makes the names resolvable.

### Cause 3: ping by name fails in a musl-based debug container

The container debug image is built on the musl C library. Its `ping` requests IPv6 by default and fails at once when the name has no `AAAA` record; a glibc-based `ping` falls back to IPv4. Cluster DNS is not failing. This is a property of the base image, not a CoreDNS setting.

## Resolution

### Cause 1: a list of nameservers is not split-horizon

Give the nodes one resolver address that forwards by zone (intranet zones to the intranet servers, everything else to the public servers); publish it twice if a second address is needed for redundancy, and point every node's `/etc/resolv.conf` at those addresses only.

When only Pods need the split and the node file must keep two lines, put per-zone `forward` stanzas in the Corefile instead. Example shape with documentation addresses:

```text
intranet.example.com:1053 {
    forward . 192.0.2.53 192.0.2.54
}
.:1053 {
    errors
    kubernetes cluster.local in-addr.arpa ip6.arpa {
        fallthrough in-addr.arpa ip6.arpa
    }
    forward . /etc/resolv.conf
}
```

> **Warning:** A broken zone stanza black-holes that zone for every Pod. Confirm each upstream answers a known name with `dig` from a node before adding it, and save the ConfigMap. The platform turns the ConfigMap edit into a ResourcePatch; wait until it is applied before testing. Roll back with `kubectl apply -f /tmp/cpaas-coredns.before.yaml`.

```bash
kubectl -n kube-system get cm cpaas-coredns -o yaml > /tmp/cpaas-coredns.before.yaml
kubectl -n kube-system edit cm cpaas-coredns
```

Static names that are not a whole zone belong in a CoreDNS Host Alias (an IP, then domains separated by spaces), not in a third `nameserver` line.

### Cause 2: external system names exist only on an internal DNS server

Only when the internal DNS server answers the name (`dig @<internal-dns-ip> <external-system-domain>` from a node) and the Pod does not. Use one of the two approaches.

**Corefile forward.** When the internal server should answer every non-cluster name, replace the target of the default `forward`; when it should answer only some zones, add a per-zone stanza as in Cause 1 and keep `forward . /etc/resolv.conf`:

```text
.:1053 {
    # other plugins unchanged
    forward . 192.0.2.53
}
```

> **Warning:** Changing the default `forward` sends every external lookup in the cluster to the new server; if it does not recurse for public names, public lookups fail for all Pods. Save the ConfigMap and confirm with `dig` that the server answers both internal names and the public names the cluster needs. Wait for the ResourcePatch to be applied. Roll back with `kubectl apply -f /tmp/cpaas-coredns.before.yaml`.

```bash
kubectl -n kube-system get cm cpaas-coredns -o yaml > /tmp/cpaas-coredns.before.yaml
kubectl -n kube-system edit cm cpaas-coredns
kubectl exec -n <namespace> <pod> -- nslookup <external-system-domain>
```

**Node resolver.** Add the server as a `nameserver` line in `/etc/resolv.conf` on every node, then restart CoreDNS so its Pods receive the new list. The two-line limit and the first-`NXDOMAIN` behavior of Cause 1 apply to this file. The full procedure is Cause 4 of "Host DNS changes do not reach CoreDNS: systemd-resolved, kubelet resolvConf, missing nameserver or a new upstream on ACP".

> **Warning:** Restarting CoreDNS briefly delays lookups cluster-wide. Back up `/etc/resolv.conf` on each node; restoring it and restarting CoreDNS again is the rollback.

```bash
cp -a /etc/resolv.conf /root/resolv.conf.before
kubectl -n kube-system rollout restart deploy/coredns
kubectl -n kube-system rollout status deploy/coredns
```

Adding the server to `spec.dnsConfig.nameservers` of individual workloads is a third possibility that affects only those workloads; a hand edit of the file inside a running container is lost on the next recreate.

### Cause 3: ping by name fails in a musl-based debug container

No cluster change fixes this. Test name resolution directly, and reachability by address:

```bash
nslookup <domain>
ping -c 3 <address-from-nslookup>
```

A glibc-based image resolves the IPv4 address and pings it.

## Diagnostic Steps

1. Ask each node nameserver for the failing name; a definitive `NXDOMAIN` from the first one explains a failure even when the second one knows the name:

   ```bash
   cat /etc/resolv.conf
   dig @<first-nameserver> <failing-name> +short
   dig @<second-nameserver> <failing-name> +short
   kubectl -n kube-system get pod -l k8s-app=kube-dns -o wide
   ```

2. Read the Corefile forward targets:

   ```bash
   kubectl -n kube-system get cm cpaas-coredns -o jsonpath='{.data.Corefile}{"\n"}' | grep -B2 -A5 forward
   ```

3. Map the result:

   - Public names flap, the node has several nameservers, or the precheck says only two are allowed: Cause 1.
   - The name is answered by the internal DNS server and returns `NXDOMAIN` or a timeout from the Pod: Cause 2.
   - `ping` by name fails only in the debug container while `nslookup` of the same name works: Cause 3.

If `nslookup` to `kube-dns` times out instead of returning `NXDOMAIN`, check NetworkPolicies and the Pod's route to the CoreDNS ClusterIP before changing resolvers.
