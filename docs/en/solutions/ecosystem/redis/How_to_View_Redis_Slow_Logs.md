---
products:
  - Alauda Application Services
kind:
  - Solution
---

# How to View Redis Slow Logs

## Introduction

This guide describes how to inspect, manage, and configure the Redis slow log. The slow log records commands that exceed a configurable execution time threshold, making it a key tool for diagnosing performance issues and identifying inefficient queries.

## Prerequisites

- Access to the Redis instance via `redis-cli` or another Redis client.
- Authentication credentials (if the instance has password authentication enabled).

## Procedure

### 1. Connect to Redis

Use `redis-cli` to enter the Redis shell:

```bash
redis-cli -h <redis-host> -p <redis-port> -a <password>
```

### 2. View the Number of Slow Log Entries

Check how many entries are currently stored in the slow log:

```text
SLOWLOG LEN
```

### 3. View Slow Log Entries

Retrieve the most recent slow log entries. The argument specifies how many entries to return:

```text
SLOWLOG GET <count>
```

Example output:

```text
redis 127.0.0.1:6379> SLOWLOG GET 2
1) 1) (integer) 14            // Unique entry identifier
   2) (integer) 1309448221    // Unix timestamp of command execution
   3) (integer) 15            // Execution time in microseconds (15 μs)
   4) 1) "ping"               // The command and its arguments
2) 1) (integer) 13
   2) (integer) 1309448128
   3) (integer) 30            // Execution time in microseconds (30 μs)
   4) 1) "slowlog"
      2) "get"
      3) "100"
```

Each entry contains:

| Field | Description |
|-------|-------------|
| Index 1 | Unique identifier for the slow log entry |
| Index 2 | Unix timestamp when the command was executed |
| Index 3 | Time taken to execute the command (in microseconds) |
| Index 4 | The command and its arguments |

### 4. Reset the Slow Log

Clear all slow log entries:

```text
SLOWLOG RESET
```

## Configuration Parameters

Configure the slow log behavior with the following Redis parameters. These can be set via the instance `customConfig` or with the `CONFIG SET` command at runtime:

| Parameter | Description | Notes |
|-----------|-------------|-------|
| `slowlog-log-slower-than` | Minimum execution time (in microseconds) for a command to be recorded as a slow log entry. | Set to `0` to log every command. Set to `-1` to disable slow log recording. |
| `slowlog-max-len` | Maximum number of entries retained in the slow log. When the limit is reached, the oldest entry is removed. | Default: `0` (no entries retained). Set to a positive value such as `128` or `1024` for production use. |

Example: set the threshold to 1 millisecond (`1000` microseconds) and retain up to 1024 entries:

```text
CONFIG SET slowlog-log-slower-than 1000   # 1000 microseconds = 1 millisecond
CONFIG SET slowlog-max-len 1024
```

To persist these settings across restarts, configure them in the instance `customConfig`:

```yaml
spec:
  customConfig:
    slowlog-log-slower-than: "1000"
    slowlog-max-len: "1024"
```

## Important Considerations

- The slow log is stored in memory and is cleared on instance restart unless persisted via your monitoring stack.
- Setting `slowlog-log-slower-than` to `0` records every command and can have a noticeable performance impact. Use only for short diagnostic windows.
- Increasing `slowlog-max-len` consumes additional memory. Choose a value appropriate to your instance size.
- For long-term analysis, periodically scrape `SLOWLOG GET` output and forward it to a centralized logging or APM system.
