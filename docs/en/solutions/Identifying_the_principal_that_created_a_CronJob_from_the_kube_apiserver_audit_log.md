---
kind:
   - How To
products:
   - Alauda Container Platform
ProductsVersion:
   - 4.1.0,4.2.x
---

# Identifying the principal that created a CronJob from the kube-apiserver audit log

## Issue

On Alauda Container Platform, an unexpected `CronJob` is sometimes found running in a namespace and the team needs to determine which user or workload created it. The CronJob resource itself does not answer this question: the creating principal is not surfaced by `kubectl get cronjob` output and the resource YAML carries no field naming who created it. The CronJob (`cronjobs.batch/v1`, short name `cj`) exposes only `metadata.annotations`, `metadata.creationTimestamp`, and `metadata.ownerReferences` — none of which records the authenticated identity that issued the create request. The identity that created a Kubernetes object is recorded only in the kube-apiserver audit log, not in the object itself; the object's `managedFields` tracks field managers and operations but never the authenticated principal, so the creator can be recovered only from the audit record.

## Root Cause

The kube-apiserver, when an API request matches the active audit policy, records that request as an audit event, and that event — not the stored object — is the authoritative source for the requesting identity. On this platform auditing is enabled by default, and the apiserver is configured with `--audit-log-format=json`, so the log is a stream of JSON-lines records, each an `audit.k8s.io/v1` `Event` carrying the `user`, `verb`, and `objectRef` of the request. The create request that produced the CronJob is recoverable from this log provided the active audit policy logs `create` events on `cronjobs` at a level that records the request user (Metadata level or above); when it does, the matching event's `user.username` field identifies the principal that issued it.

## Resolution

Given access to the kube-apiserver audit log — a JSON-lines stream where each line is an `audit.k8s.io/v1` `Event` — recover the creator by isolating the event that created the CronJob and reading its `user.username` field. This was confirmed against the kube-apiserver running image `registry.alauda.cn:60080/tkestack/kube-apiserver:v1.34.5` (Kubernetes `v1.34.5`).

Each audit event includes a `verb` field naming the API operation, where object creation is recorded as `verb=create`, and an `objectRef.resource` field naming the targeted resource type, which is `cronjobs` for CronJob objects. Filtering the event stream for `verb=create` together with `objectRef.resource=cronjobs` isolates the audit record(s) for CronJob creation. With `jq` over the JSON-lines stream this reduces to selecting matching events and printing the identity, target name, and timestamp:

```bash
jq -c 'select(.verb=="create" and .objectRef.resource=="cronjobs" and .objectRef.apiGroup=="batch")
  | {user: .user.username, name: .objectRef.name, ns: .objectRef.namespace, time: .requestReceivedTimestamp}' \
  audit.log
```

Read the `user.username` field on the matching event to identify the creator. The interpretation of that value follows the standard Kubernetes username convention. When the CronJob was created by an automated pipeline acting as a ServiceAccount, `user.username` has the form `system:serviceaccount:<namespace>:<name>`. When it was created interactively by a person, `user.username` is that human user's username rather than a ServiceAccount form.

This recovery depends on the create event having been recorded and still being present in the audit log. If kube-apiserver auditing is disabled, if the active audit policy does not log `create` events on `cronjobs` at a level that records the request user (so the create was never written, or written without `user.username`), or if the relevant audit log segment has been rotated away, the create event is not available and the creator cannot be determined from the audit log.

## Diagnostic Steps

Confirm that auditing is in effect before relying on the log. On this platform the audit policy is managed by the platform itself (the `base-central` chart, `v4.3.5-cn`), which keeps auditing on out of the box and owns the policy lifecycle; the apiserver is started with `--audit-log-format=json`, so the events it writes are `audit.k8s.io/v1` JSON records carrying `user.username`, `verb`, and `objectRef`. The audit log is rotated under a bounded retention (capped backup count, per-file size, and maximum age), so events older than the retention window are no longer present and a create event that has aged out cannot be recovered.

When an audit event for the CronJob create is located, validate the three fields the lookup depends on: `verb` should read `create`, `objectRef.resource` should read `cronjobs`, and `user.username` carries the principal — either a `system:serviceaccount:<namespace>:<name>` value for an automated workload or a plain username for an interactive human user.
