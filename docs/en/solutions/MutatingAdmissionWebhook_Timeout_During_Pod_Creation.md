---
kind:
   - Troubleshooting
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x,4.3.x
id: KB260500015
---

# MutatingAdmissionWebhook admission timeouts on ACP — webhook, network, and etcd as causes

## Issue

On Alauda Container Platform (validated on Kubernetes `v1.34.5` with the upstream etcd v3 static-pod control plane) the kube-apiserver runs the upstream Kubernetes admission chain, and any registered mutating webhook that fails to return inside its configured per-call timeout causes the apiserver to fail the entire admission decision. Callers (controllers and `kubectl` clients) observe an `Internal error occurred: admission plugin "MutatingAdmissionWebhook" failed to complete mutation in <N>s` response, where the literal `<N>s` value is the timeout that the webhook configuration declared at the time of the call. Because admission denial is synchronous, every workload-creation path that traverses the slow webhook — pod creation by controllers, direct `kubectl apply`, CR reconciliation that spawns child objects — surfaces the same error and stops making progress on the affected objects.

The symptom is not localised to one component, so the same error string can appear in the logs of any control-plane or workload controller that drives object creation through admission. The shape of the message is fixed by the upstream Kubernetes apiserver; only the timeout value and the failing-webhook identity vary between occurrences.

## Root Cause

The timeout does not by itself identify which side of the webhook call is slow. A webhook responds to an admission request by reading and writing cluster state, and on the apiserver side that round-trip lands on etcd; if any link in the chain — the webhook pod, the network path between the apiserver and the webhook service, or the etcd backend the webhook pod depends on — is slow enough to push the request past the declared timeout, admission fails with the same wording. The reverse is also true: a webhook pod that is `Running` and reports no error in its own logs can still be the cause, because admission throughput is bound by the slowest step in the request path rather than by pod readiness alone.

Etcd performance is therefore a candidate root cause, but it is not the only one and not the first one to investigate. Webhook-pod-side faults (the webhook process is healthy as a process but is itself slow, deadlocked on its own dependencies, or undersized for the request rate) and pod-to-pod network problems between the apiserver pods and the webhook service must be ruled out before the investigation turns to etcd.

## Resolution

Work the causes in the order their evidence weight dictates. First, confirm webhook-pod health beyond simple readiness: the pods backing the failing webhook service may be `Running` and emit no errors of their own while admission requests through them still time out, so liveness alone is not a discharge of suspicion. Inspect the webhook pods directly — list them in their namespace, read their logs across all replicas, and confirm they are actually serving the admission endpoint that the `MutatingWebhookConfiguration` points at.

Identify the failing webhook and its pods:

```bash
kubectl get mutatingwebhookconfiguration -o yaml \
  | grep -E 'name:|service:|namespace:|timeoutSeconds:' | head -40
kubectl get pods -A -l <webhook-app-label>
kubectl logs -n <webhook-ns> <webhook-pod> --previous --tail=200
```

Second, rule out pod-to-pod network problems between the apiserver and the webhook service. The apiserver dials the webhook over the cluster service network, so the round-trip latency, DNS resolution to the webhook Service, and any CNI-level loss on that path all factor into the budget.

Third — and only after the first two are clean — turn to etcd. Validate that the cluster's etcd meets the documented backend performance requirements that apply to the platform. Etcd backend performance is the upstream-published bar for fsync / commit latency that must be cleared before any control-plane component can be expected to behave predictably; the same backend bar applies on ACP because the control plane runs the upstream etcd v3 binary. Graph etcd metrics with Prometheus to gauge actual performance against that bar, using the standard upstream etcd histograms that the etcd binary exports on its metrics endpoint. The Prometheus instance that scrapes those series on this platform is the kube-prometheus stack in the `cpaas-system` namespace; per-instance dashboarding follows the upstream etcd dashboard shape.

If the metrics show a backend that has outgrown its disk envelope, defragmenting etcd to decrease the on-disk database size is a remediation worth attempting. Defragmentation reclaims space released by tombstones and historical revisions and shrinks the `db` file; it is performed per-member, in sequence, to avoid taking quorum down. The operation uses the etcdctl client distributed with the same etcd v3 release, invoked against each member's local client URL with the member's own peer/client TLS certificates — the exact certificate paths come from the etcd container's own command-line flags, which set `--cert-file`, `--key-file`, and `--trusted-ca-file` on the server side and require matching client-side `--cacert / --cert / --key` arguments for any etcdctl invocation that targets the TLS-only listen-client URL.

The same first-webhook-then-network-then-etcd ordering applies regardless of which workload component first surfaced the timeout — controllers that create pods, CR reconcilers, and ad-hoc `kubectl` callers all share the single admission chain, so a fix that restores the slowest link restores all of them.

## Diagnostic Steps

Start from the error string itself. The apiserver-emitted message `admission plugin "MutatingAdmissionWebhook" failed to complete mutation in <N>s` is the canonical signal that a registered mutating webhook is at fault; capture both the literal timeout value and any caller-side wrapping context (which controller / which object) from the log line where it appears.

Enumerate the registered mutating webhooks and the namespaces that host them:

```bash
kubectl get mutatingwebhookconfiguration -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.webhooks[*].clientConfig.service.namespace}/{.webhooks[*].clientConfig.service.name}{"\n"}{end}'
```

For each candidate webhook, check the backing pods and confirm that "pod Running" is not the only signal being relied on; correlate request volume and any internal latency the webhook exports with the time window when admission was timing out. A webhook pod whose process is alive but stalled on its own backend is the most common shape of this failure and is invisible to a readiness probe.

When neither the webhook pods nor the network path between apiserver and webhook show a problem, broaden the scope to etcd performance before declaring the cause unknown. Validating etcd against the documented backend performance requirements, plus graphing the etcd histograms in Prometheus, gives a defensible answer for whether etcd-side slowness is making otherwise-healthy webhooks miss their admission budget. If that investigation shows backend growth as a contributor, the per-member defragmentation procedure is the targeted remediation.
