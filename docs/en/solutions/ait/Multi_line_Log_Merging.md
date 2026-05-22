---
products: 
  - Alauda Container Platform
kind:
  - Solution
---

# nevermore Multi-line Log Merging Production Change Plan

## 1. Background

After the `nevermore` log collection component is deployed, it uses the `nevermore-config` ConfigMap in the `cpaas-system` namespace as the Filebeat configuration source by default.

This ConfigMap contains multiple types of log collection configurations, for example:

```yaml
filebeat-log-containers.yml
filebeat-log-file.yml
filebeat-log.yml
filebeat-audit.yml
filebeat-event.yml
filebeat-log-system.yml
filebeat-log-systemd.yml
```

Business container standard output logs are mainly controlled by:

```yaml
filebeat-log-containers.yml
```

If business logs are collected from mounted files, also pay attention to:

```yaml
filebeat-log-file.yml
```

This plan is based on modifying the existing `nevermore-config`. It does not require creating a new ConfigMap or changing the DaemonSet volume mount configuration.

---

## 2. Environment Information

Applicable Versions: 4.3.x

---

## 3. Scope

This plan applies to Kubernetes clusters where the `nevermore` log collection component has already been deployed. It is used to handle multi-line log merging for container logs or file-based logs.

Typical applicable scenarios include:

1. Application exception stacks from Java, Go, Python, and similar languages are split into multiple log entries.
2. A single business log contains multiple lines, such as SQL, JSON, XML, or detailed error information.
3. Multiple lines belonging to the same exception or request are displayed as separate records in the log platform.
4. Subsequent log lines with specific characteristics need to be merged into the previous main log line.

Scenarios where this plan is not applicable or should be used with caution:

1. Logs do not have stable first-line or continuation-line characteristics, making it difficult to distinguish them accurately with regular expressions.
2. The log volume is very large and the multi-line content is long. The impact on collection latency, memory usage, and single-log size must be evaluated.
3. Log formats vary significantly across business applications. Do not use an overly broad regular expression to cover all business logs.

---

## 4. Expected Result

By adding `multiline.*` configuration to the corresponding Filebeat input, continuation lines that match the regular expression can be merged into the previous main log line. This prevents the same exception, request, or business event from being split into multiple records in the log platform.

The following example uses a Java exception stack.

Before configuration, the Java exception stack may be collected as multiple independent log records and displayed as multiple logs in the log platform:

```text
Log record 1:
[2026-05-21 10:00:00] ERROR request failed

Log record 2:
java.lang.RuntimeException: test error

Log record 3:
    at com.example.DemoService.test(DemoService.java:12)

Log record 4:
    at com.example.DemoController.test(DemoController.java:25)

Log record 5:
Caused by: java.lang.IllegalArgumentException: invalid argument

Log record 6:
    at com.example.Validator.check(Validator.java:8)
```

After configuration, continuation lines that match `multiline.pattern` are merged into the previous main log line and displayed as one complete log record:

```text
Log record 1:
[2026-05-21 10:00:00] ERROR request failed
java.lang.RuntimeException: test error
    at com.example.DemoService.test(DemoService.java:12)
    at com.example.DemoController.test(DemoController.java:25)
Caused by: java.lang.IllegalArgumentException: invalid argument
    at com.example.Validator.check(Validator.java:8)
```

> The above is only an example of the display effect. Which lines are actually merged depends on whether the configured `multiline.pattern` accurately matches the continuation-line characteristics of the logs.

---

## 5. Multi-line Merging Rule Description

The core of multi-line merging is `multiline.pattern`. This field is a regular expression used to determine which log lines should be merged into the previous log line.

> Note: The `multiline.pattern` in this document is only an example for Java exception stack scenarios. It is not a universal fixed configuration. In a production environment, customers must write the regular expression based on their own log format, exception format, and log line characteristics, and verify it in a test environment before applying it to production.

Example configuration:

```yaml
multiline.type: pattern
multiline.pattern: '<regular expression based on the actual log format>'
multiline.negate: false
multiline.match: after
multiline.timeout: 3s
multiline.max_lines: 500
```

Example regular expression for Java exception stacks:

```yaml
multiline.pattern: '^[[:space:]]+(at|\.{3})[[:space:]]+\b|^Caused by:|^java\.'
```

Field descriptions:

| Configuration Item | Description |
|---|---|
| `multiline.type: pattern` | Uses a regular expression pattern for multi-line matching. |
| `multiline.pattern` | Matches log lines that need to be merged. This must be written based on the customer's actual log format. |
| `multiline.negate: false` | Lines matching the regular expression are the lines to be merged. |
| `multiline.match: after` | Appends matching lines to the previous unmatched log line. |
| `multiline.timeout: 3s` | Outputs the current merged result after waiting up to 3 seconds. |
| `multiline.max_lines: 500` | Merges up to 500 lines into a single multi-line log. Excess lines are discarded. |

The Java exception example regular expression matches:

```regex
^[[:space:]]+(at|\.{3})[[:space:]]+\b|^Caused by:|^java\.
```

It can match lines such as:

```text
    at com.example.Service.method(Service.java:10)
    ... 20 more
Caused by: java.lang.RuntimeException
java.lang.NullPointerException
```

> Compared with the original `^java.` pattern, `^java\.` is recommended in production to avoid incorrectly matching non-Java exception lines such as `javaX` or `javascript`.

### 5.1 Regular Expression Writing Recommendations

When writing `multiline.pattern`, first identify the characteristics of the “main log line” and the “continuation lines”:

1. Main log lines usually contain fixed timestamps, log levels, request IDs, or similar fields.
2. Continuation lines usually do not contain a complete timestamp and may start with spaces, tabs, `at`, `Caused by`, `...`, and similar content.
3. It is recommended to match the continuation-line characteristics first, and then use `multiline.negate: false` with `multiline.match: after` to append continuation lines to the previous main log line.
4. Avoid overly broad regular expressions, otherwise unrelated log lines may be incorrectly merged into one record.
5. Before making changes, use real business log samples to validate the regular expression and confirm that it does not cause incorrect merges or missed merges.

---

## 6. Pre-change Preparation

### 6.1 Check the nevermore Running Status

```bash
kubectl get ds -n cpaas-system nevermore
kubectl get pods -n cpaas-system | grep -i nevermore
```

### 6.2 Back Up the Current ConfigMap

Before making changes in production, back up `nevermore-config`:

```bash
kubectl get cm -n cpaas-system nevermore-config -o yaml > nevermore-config-backup-$(date +%Y%m%d%H%M%S).yaml
```

It is also recommended to record the current DaemonSet and Pod status:

```bash
kubectl get ds -n cpaas-system nevermore -o wide
kubectl get pods -n cpaas-system | grep -i nevermore
```

---

## 7. Configuration Modification Locations

### 7.1 Container Standard Output Logs

If multi-line merging is required for container standard output logs, modify:

```yaml
filebeat-log-containers.yml: |
```

In this configuration block, find:

```yaml
paths:
  - /var/log/containers/*.log
processors:
```

Add the multi-line merging configuration between `paths` and `processors`. The `multiline.pattern` must be written based on the customer's actual log format. The following example is for Java exception stacks:

```yaml
multiline.type: pattern
multiline.pattern: '^[[:space:]]+(at|\.{3})[[:space:]]+\b|^Caused by:|^java\.'
multiline.negate: false
multiline.match: after
multiline.timeout: 3s
multiline.max_lines: 500
```

Example after modification:

```yaml
filebeat-log-containers.yml: |
  - type: container
    id: containers
    {{if .FirstRun}}
    # for first run, the tail_files should be true.
    tail_files: true
    {{end}}
    symlinks: true
    ignore_older: 30m
    close_inactive: 15m
    scan_frequency: 30s
    paths:
      - /var/log/containers/*.log
    multiline.type: pattern
    multiline.pattern: '^[[:space:]]+(at|\.{3})[[:space:]]+\b|^Caused by:|^java\.'
    multiline.negate: false
    multiline.match: after
    multiline.timeout: 3s
    multiline.max_lines: 500
    processors:
      - add_size: ~
      - add_fields:
          target: ""
          fields:
            source: container
```

### 7.2 Mounted File Logs, Optional

If business logs are collected from mounted files, also modify:

```yaml
filebeat-log-file.yml
```

Find:

```yaml
scan_frequency: 30s
processors:
```

Add the multi-line merging configuration between them. The `multiline.pattern` must be written based on the customer's actual log format. The following example is for Java exception stacks:

```yaml
multiline.type: pattern
multiline.pattern: '^[[:space:]]+(at|\.{3})[[:space:]]+\b|^Caused by:|^java\.'
multiline.negate: false
multiline.match: after
multiline.timeout: 3s
multiline.max_lines: 500
```

Example after modification:

```yaml
filebeat-log-file.yml: |
  {{range $cid, $fileConfigs := .Files}}
  {{range $fileConfigs}}
  - type: log
    paths:
      - {{.Path}}
    {{if .ExcludePaths }}
    exclude_files:
    {{range .ExcludePaths }}
    - {{.}}
    {{end}}
    {{end}}
    ignore_older: 30m
    close_inactive: 15m
    scan_frequency: 30s
    multiline.type: pattern
    multiline.pattern: '^[[:space:]]+(at|\.{3})[[:space:]]+\b|^Caused by:|^java\.'
    multiline.negate: false
    multiline.match: after
    multiline.timeout: 3s
    multiline.max_lines: 500
    processors:
      - add_size: ~
      - add_fields:
          target: ""
          fields:
            source: container
            container_id: {{.ContainerID}}
```

---

## 8. Recommended Production Change Procedure

### Step 1: Back Up the Current Configuration

```bash
kubectl get cm -n cpaas-system nevermore-config -o yaml > nevermore-config-backup-$(date +%Y%m%d%H%M%S).yaml
```

### Step 2: Export the Configuration to Be Modified

Compared with directly using `kubectl edit`, exporting the configuration first is recommended in production because it is easier to review, compare, and roll back.

```bash
kubectl get cm -n cpaas-system nevermore-config -o yaml > nevermore-config-edit.yaml
```

### Step 3: Modify the Configuration File

```bash
vi nevermore-config-edit.yaml
```

Add the multi-line merging rules to the corresponding configuration block based on the log source.

Container standard output logs:

```yaml
data:
  filebeat-log-containers.yml: |
```

Mounted file logs:

```yaml
data:
  filebeat-log-file.yml: |
```

If both types of logs require multi-line merging, modify both configuration blocks.

### Step 4: Apply the Modification

```bash
kubectl apply -f nevermore-config-edit.yaml
```

### Step 5: Wait for the nevermore Pod to Update Automatically

After `nevermore-config` is updated, the `nevermore` Pod automatically restarts and loads the new configuration. Manual Pod deletion is not required.

### Step 6: Confirm That the DaemonSet Has Recovered

```bash
kubectl rollout status ds/nevermore -n cpaas-system
```

Check Pods:

```bash
kubectl get pods -n cpaas-system | grep -i nevermore
```

---

## 9. Verification Method

### 9.1 Prepare Test Logs

Output Java exception logs from a test business container, for example:

```text
[2026-05-21 10:00:00] ERROR test exception
java.lang.RuntimeException: test error
    at com.example.DemoService.test(DemoService.java:12)
    at com.example.DemoController.test(DemoController.java:25)
Caused by: java.lang.IllegalArgumentException: invalid argument
    at com.example.Validator.check(Validator.java:8)
```

### 9.2 Verify the Collection Result

Query the corresponding Pod logs in the log platform and confirm whether the exception stack is merged into one log record.

Key checks:

1. Whether `java.lang.RuntimeException` is merged with the previous ERROR log line.
2. Whether multiple `at ...` lines are no longer split into independent log records.
3. Whether `Caused by:` is merged into the same log record.
4. Whether normal logs are still collected correctly.
5. Whether log time parsing remains normal.

---

## 10. Rollback Plan

If log collection issues, log display issues, or nevermore startup failures occur after the change, roll back using the backup file.

### 10.1 Roll Back the ConfigMap

```bash
kubectl apply -f nevermore-config-backup-YYYYMMDDHHMMSS.yaml
```

Replace the file name with the actual backup file name.

### 10.2 Wait for the nevermore Pod to Update Automatically

After `nevermore-config` is rolled back, the `nevermore` Pod automatically restarts and reloads the rolled-back configuration. Manual Pod deletion is not required.

### 10.3 Confirm Recovery

```bash
kubectl rollout status ds/nevermore -n cpaas-system
kubectl get pods -n cpaas-system | grep -i nevermore
```

---

## 11. Production Notes

1. **Modify the existing `nevermore-config`**
   This plan directly updates the Filebeat input configuration in `nevermore-config`. It does not create a new ConfigMap or change the DaemonSet volume mount configuration.

2. **Choose the modification location based on the log source**
   For container standard output logs, modify `filebeat-log-containers.yml`. For mounted file logs, modify `filebeat-log-file.yml`. If both types of logs need multi-line merging, modify both configuration blocks.

3. **Validate in a test environment first**
   Confirm that log merging, log platform display, alert rules, and searchable fields are all normal before applying the change in production.

4. **Customize `multiline.pattern` based on the log format**
   The Java exception regular expression in this document is only an example. Customers should write and validate the regular expression based on actual log content, first-line characteristics, and exception stack formats to avoid incorrect merges or missed merges.

5. **Avoid overly broad regular expressions**
   If using the Java exception example, `^java\.` is recommended instead of `^java.` to reduce incorrect matches.

6. **Pay attention to log latency**
   `multiline.timeout: 3s` may introduce up to approximately 3 seconds of waiting time for multi-line logs.

7. **Pay attention to very long stack traces**
   `multiline.max_lines: 500` means that up to 500 lines are merged into one log record. Excess lines are discarded.

8. **Observe the collection pipeline after the change**
   After `nevermore-config` is updated, the Pod automatically restarts and loads the new configuration. After the change, observe the nevermore Pod status, log ingestion volume, and business log integrity.

9. **The configuration only affects newly collected logs**
   After the multi-line merging configuration takes effect, it usually only affects newly collected logs. Logs that have already been collected and stored will not be automatically re-merged.
