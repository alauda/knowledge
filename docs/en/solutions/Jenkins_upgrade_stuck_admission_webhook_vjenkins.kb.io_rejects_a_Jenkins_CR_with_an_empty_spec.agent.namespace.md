---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - 4.0.x
---

# Jenkins upgrade stuck: admission webhook vjenkins.kb.io rejects a Jenkins CR with an empty spec.agent.namespace

## Issue

During a toolchain upgrade (for example while the platform moves from 3.16 to 4.0), the Jenkins instance upgrade does not finish. The Jenkins operator controller log repeats a reconcile error of this form:

```text
"msg"="Reconciler error" "error"="admission webhook \"vjenkins.kb.io\" denied the request: Jenkins.operator.devops.alauda.io \"<jenkins-name>\" is invalid: spec.agent.namespace: Invalid value: \"\": a lowercase RFC 1123 ...
```

The Jenkins Deployment itself still shows `1/1` ready, so Jenkins keeps serving; only the operator cannot apply the upgrade to it.

## Root Cause

### Cause 1: the Jenkins CR created by the older version has no spec.agent.namespace

The new Jenkins operator installs a validating admission webhook, `vjenkins.kb.io`, that requires `spec.agent.namespace` of every `Jenkins` resource (`jenkins.operator.devops.alauda.io`) to be a valid lowercase RFC 1123 name. A Jenkins CR created by the older version never had this field, so it is empty.

The webhook validates every update of the CR, not only updates made by users. When the operator reconciles the instance it writes its own management information back to the CR; that update is rejected because the field is empty, the reconcile fails, and the upgrade of the instance stops. The running Deployment is not touched, which is why Jenkins stays `1/1`.

Setting `spec.agent.namespace` on the CR to the namespace where the build agents run makes the CR valid, and the operator can reconcile again.

## Resolution

### Cause 1

1. Find the Jenkins CR and confirm the field is empty (Diagnostic Steps, step 2).

2. Decide the agent namespace. It is the namespace in which this Jenkins instance creates its build agent Pods. When the build agents already run in the same namespace as the Jenkins instance (for example `operators`), use that namespace.

3. Set the field:

   ```bash
   kubectl patch jenkins.operator.devops.alauda.io <jenkins-name> -n <jenkins-namespace> --type merge \
     -p '{"spec":{"agent":{"namespace":"<agent-namespace>"}}}'
   ```

   For an instance named `devops-jenkins` in `operators` whose build agents run in `operators`:

   ```bash
   kubectl patch jenkins.operator.devops.alauda.io devops-jenkins -n operators --type merge \
     -p '{"spec":{"agent":{"namespace":"operators"}}}'
   ```

   Once the CR is valid, the operator resumes the upgrade that was blocked, so the Jenkins instance can be updated and restarted by the operator right after the patch. Run it at a time when a Jenkins restart is acceptable. If the namespace is wrong, patch the field again with the correct namespace; an empty value is rejected by the webhook and is not a way back.

4. Watch the operator log again (Diagnostic Steps, step 1). The `vjenkins.kb.io` denial no longer appears, and the toolchain upgrade continues.

## Diagnostic Steps

1. Find the Jenkins operator Pod and look for the webhook denial:

   ```bash
   kubectl get pods -A | grep -i jenkins
   kubectl logs -n <operator-namespace> <jenkins-operator-pod> --tail=200 | grep -i 'vjenkins.kb.io'
   ```

   A line containing `denied the request` and `spec.agent.namespace: Invalid value: ""` confirms this cause.

2. Show the agent namespace of every Jenkins CR:

   ```bash
   kubectl get jenkins.operator.devops.alauda.io -A \
     -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,AGENT_NS:.spec.agent.namespace'
   ```

   `<none>` in `AGENT_NS` marks a CR that the webhook rejects.

3. Confirm the webhook is installed:

   ```bash
   kubectl get validatingwebhookconfiguration -o yaml | grep -n 'vjenkins.kb.io'
   ```

4. Check that Jenkins itself is still running, which separates this cause from a Jenkins instance that is down:

   ```bash
   kubectl get deploy -n <jenkins-namespace>
   ```

   The Jenkins Deployment shows `1/1`. If it is not ready, look at the Jenkins Pod events and logs first; this cause leaves the running instance untouched.
