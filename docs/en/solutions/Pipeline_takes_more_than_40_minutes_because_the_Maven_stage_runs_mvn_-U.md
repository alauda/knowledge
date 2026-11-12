---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.3"
---

# Pipeline takes more than 40 minutes because the Maven stage runs mvn -U

## Issue

A pipeline needs more than 40 minutes to finish, and releases slip because of the wait. The run does complete: it is not stuck in Pending, and it does not fail with `index-pack` or `OOMKilled`. Per-stage timing shows that the Maven stage is the long part, and the Maven command in that stage includes `-U` (for example `mvn -U clean package`).

## Root Cause

### Cause 1: the Maven stage forces dependency updates with `-U`

`-U` (`--update-snapshots`) makes Maven check the remote repositories for updated snapshots and for missing releases on every run. When the Maven stage is the stage that dominates the run and its command contains `-U`, that forced update check is the extra time in the stage, and removing it is the change to make. Removing `-U` is the optimization direction that matches the stage timing; measure the result on your own pipeline.

## Resolution

### Cause 1: the Maven stage forces dependency updates with `-U`

1. Time the stages before changing the command. Continue only when Maven is the long stage and the command contains `-U`:

   ```bash
   kubectl get pipelinerun -n <namespace>
   kubectl logs -n <namespace> <maven-pod> | grep -E 'mvn |BUILD '
   ```

2. Remove `-U` from the Maven invocation in the stage script, so that the stage uses the dependencies already resolved instead of forcing an update on every run.

   > **Warning:** Without `-U`, a newly published snapshot is not picked up until the local repository is refreshed or `-U` is added back for one run. Precondition: only when stage timing shows the Maven stage takes tens of minutes and the command includes `-U`. Rollback: restore `-U` on that Maven step. Leave the Maven cache volume in place.

3. Compare the duration of the next run's Maven stage with the previous run. If Maven is still the long stage after `-U` is gone, the force update was not the only cost. Measure the remaining Maven log (download and compile phases) instead of changing clone memory or Pod scheduling.

## Diagnostic Steps

```bash
kubectl get pipelinerun -n <namespace>
kubectl logs -n <namespace> <maven-pod> | grep -E 'mvn |BUILD |Downloading|Downloaded'
```

- A completed run whose Maven stage dominates the total time, with `mvn -U` in the command and many `Downloading` lines for metadata on every run: Cause 1.
- A run that never starts is a scheduling problem (Pod Pending), not Maven.
- A Node.js task killed for memory, or a clone failing in `index-pack`, is not related to the Maven `-U` flag.
