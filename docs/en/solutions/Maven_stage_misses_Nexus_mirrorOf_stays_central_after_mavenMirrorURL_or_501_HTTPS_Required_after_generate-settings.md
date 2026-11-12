---
kind:
  - Troubleshooting
products:
  - Alauda DevOps
ProductsVersion:
  - "4.0"
  - "4.3"
---

# Maven stage misses Nexus: mirrorOf stays central after mavenMirrorURL, or 501 HTTPS Required after generate-settings

## Issue

The Maven stage of a DevOps (Tekton) pipeline does not use the built-in Nexus as intended. One of these symptoms is shown:

- The standard Maven task is given `mavenMirrorURL` for the built-in Nexus, but the generated settings keep `<mirrorOf>central</mirrorOf>`. Changing that parameter so that `mirrorOf` becomes `*` is not possible.
- Connectors created from the `maven-settings` workspace do not put dependency downloads on Nexus.
- The `generate-settings` step succeeds, Nexus was not selected for the run, and the Maven stage then fails with `Non-resolvable import POM` and `501 HTTPS Required`. The transfer names `https://maven.aliyun.com/repository/spring` and `https://repo.maven.apache.org/maven2/`.

Maven settings travel in the `maven-settings` workspace. The built-in Nexus is the Service `nexus-nxrm-ha` in the namespace `devops-system`. Related articles: "DevOps Node.js or apt downloads fail: gnutls_handshake failed, npm install hangs, or the Nexus connection is reset" covers npm and network failures.

## Root Cause

### Cause 1: `mavenMirrorURL` always generates `mirrorOf` `central`

The `mavenMirrorURL` parameter of the Maven task always generates a mirror with `mirrorOf` `central`. No value of that parameter yields `*`. Artifacts requested from any other repository id skip the mirror. The workspace Maven connector mounts `settings.xml` and is limited to proxy and authentication unless `useAsMirror=true` is set and the connector URL is a repository that can serve as a mirror.

### Cause 2: `501 HTTPS Required` after `generate-settings` when Nexus is not set

When Nexus is not specified, the pipeline generates default Maven settings, and `generate-settings` still succeeds. With those defaults the Maven stage fails to resolve an import POM, for example:

```text
Non-resolvable import POM: org.springframework.boot:spring-boot-dependencies:pom:2.1.11.RELEASE
... could not be transferred from https://maven.aliyun.com/repository/spring ...
501 HTTPS Required ... https://repo.maven.apache.org/maven2/
```

Specifying Maven settings, so that the generated default configuration is not used, clears the failure. This is not Cause 1: `mavenMirrorURL` is not involved, and the failure comes from the generated defaults, not from a mirror left at `central`.

## Resolution

### Cause 1: `mavenMirrorURL` always generates `mirrorOf` `central`

Apply this only when the settings rendered by the task contain `<mirrorOf>central</mirrorOf>`, or the connector is mounted and traffic still misses Nexus.

1. Stop using `mavenMirrorURL` for a full mirror. Put a `settings.xml` into the `maven-settings` workspace, or change the Task template so that it uses that file. To make the connector itself the mirror, set `useAsMirror=true` and aim the connector at the mirror repository URL.

   > **Warning:** A `mirrorOf` of `*` sends every repository id to one Nexus URL. Precondition: only when Nexus already proxies those artifacts, you have a copy of the old settings, and the rendered settings show `central` (or a connector that is not a mirror). Rollback: put the old settings back and run the pipeline again.

   ```xml
   <settings>
     <mirrors>
       <mirror>
         <id>internal-nexus</id>
         <url>http://nexus-nxrm-ha.devops-system.svc.cluster.local/repository/maven-public/</url>
         <mirrorOf>*</mirrorOf>
       </mirror>
     </mirrors>
   </settings>
   ```

   `maven-public` stands for the repository path on your Nexus; replace it with the real one.

2. Run the pipeline again. The downloads appear in Nexus.

### Cause 2: `501 HTTPS Required` after `generate-settings` when Nexus is not set

Apply this only when `generate-settings` succeeded, Nexus was not selected on that run, and the Maven log contains `Non-resolvable import POM`, `https://maven.aliyun.com/repository/spring`, and `501 HTTPS Required`.

1. Specify Maven settings so that the pipeline does not apply the generated defaults. Place the file in the `maven-settings` workspace, and point it at a repository that already contains the artifacts this build resolves. The mirror block shown for Cause 1 is one way to do it.

   > **Warning:** `<mirrorOf>*</mirrorOf>` sends every repository id, including plugin repositories, to that one URL. Precondition: only when the log signature above is in this run, Nexus was not selected, and that URL already proxies or hosts the artifacts the build needs. Keep the previous settings file. Rollback: restore that file and run the pipeline again. If the rendered `<mirrorOf>` is already `central` because `mavenMirrorURL` was set, use Cause 1 instead of adding a second mirror.

2. Run the pipeline again. The Maven stage no longer prints `501 HTTPS Required` or the Aliyun spring repository URL. If `<mirrorOf>` later shows `central` and downloads still miss Nexus, that is Cause 1.

## Diagnostic Steps

From the Maven step, find the settings file and read the effective settings:

```bash
find /workspace /root /home -name settings.xml -print
mvn help:effective-settings -N
```

- `<mirrorOf>central</mirrorOf>` after `mavenMirrorURL` was set, and downloads that never appear in Nexus: Cause 1. `*` already present, with failures after that, is a Nexus content or network problem, not this parameter.
- `generate-settings` is green, the Maven stage is red, Nexus was left unset, and the log shows the lines below: Cause 2.

  ```text
  Non-resolvable import POM
  https://maven.aliyun.com/repository/spring
  501 HTTPS Required
  ```

A Maven stage that ends in `taskruntimeout`, or a JAR that is produced but omits files with Chinese names, is not a mirror problem.
