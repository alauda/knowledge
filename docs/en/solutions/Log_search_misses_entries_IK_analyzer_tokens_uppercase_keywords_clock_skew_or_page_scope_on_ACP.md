---
kind:
  - Troubleshooting
products:
  - Alauda Container Platform
ProductsVersion:
  - 3.16.x
  - 3.18.x
  - 4.0.x
  - 4.1.x
  - 4.2.x
  - 4.3.x
  - 4.4.x
---

# Log search misses entries: IK analyzer tokens, uppercase keywords, clock skew, or page scope on ACP

## Issue

Elasticsearch or ClickHouse log storage is up, the indices or tables exist, and the console still shows nothing, the wrong time window, or lines that do not match the keyword. Typical reports:

- "A Chinese sentence I copied from the log cannot be found."
- "Searching `ERROR` in uppercase shows unrelated logs, but lowercase works."
- "The project filter also shows another project."
- "Logs from `cpaas-system` cannot be seen in the console."
- "Only the last 30 minutes are shown."

Use this article when a keyword that you can see in `kubectl logs` does not match, when two nodes disagree on the date, or when the page shows a different scope from the line you are looking for. If logs cannot be viewed at all, first check the per-node agent: an `OOMKilled` or restarting `nevermore` is a collection problem, not a query problem. If the Kafka consumer lag is hours, fix the lag first; a deployment name that appears only after you widen the time range is a sign of lag, not of a query bug.

## Root Cause

### Cause 1: On Elasticsearch storage, the IK analyzer lowercases text and splits long Chinese strings

With Elasticsearch and the IK analyzer, the console search is a token query, not a `grep` of the raw line.

- **Uppercase does not match.** The tokens are lowercase, so searching the lowercase form returns the line. Wrapping the original text in quotes does not turn it into an exact-string query. For example, logs that contain `CN=cluster-operator,O=io.strimzi` are found by `cn` and not by `CN` (`共 0 条日志`, "0 logs in total").
- **A Chinese compound fails when the dictionary did not emit that compound.** `资产` ("asset") and `管理` ("management") match, but `资产管理` ("asset management") does not. Two-character pieces match more often than a long phrase, so split the phrase (for example search `没有` ("not") instead of `没有执行` ("not executed")).
- **Chinese quotation marks, URLs and `/` are split as well**, so the original string misses. An unquoted search that returns nothing and a quoted search that returns inaccurate rows are the same keyword-matching limitation.
- **A long alphanumeric ID can lose its digits at query time, depending on the IK build.** For example, `RF20260928140102047100190` matched only `RF` on one 4.2 environment and matched exactly on another. With one IK build (8.19.10), the query-time `ik_smart` analyzer drops the numeric part, so the query becomes `rf`. Another build (8.19.14) keeps the whole string. The index-time `ik_max_word` analyzer keeps the full string and its fragments on both. On the affected build, quoted searches returned hundreds of thousands of entries that merely share the `RF` prefix. The unquoted lowercase ID returned only exact matches, and the unquoted uppercase ID returned nothing.
- **A Chinese sentence copied from a displayed line returns nothing, while showing all logs displays it.** Log queries follow the Elasticsearch tokenization, so some Chinese phrases can be found and others cannot. This behavior cannot be changed while the log storage is Elasticsearch. ClickHouse log storage supports full-text search and does not use IK. The log content field accepts `AND` or `OR` combinations, for example `"the connection is unavailable" AND "rpc error"`, but not both operators in one query.

No index setting is known that disables IK in place.

### Cause 2: Node clocks disagree, so the selected range is empty

`nevermore` stamps records with one node's clock, and the store is queried with another. When those clocks are far apart (for example months), searching either window returns nothing, because the pipeline's "now" and the application's "now" are not the same range.

On an Elasticsearch cluster, the same skew creates indices whose names and `@timestamp` values do not line up. The cluster stays `yellow`. Deleting the data does not help, because the next index is wrong again until the clocks match. An existing yellow index cannot be repaired into a correct time range.

The clock that matters can also be the client's. When node clocks agree and the pipeline is healthy, a wrong system time on the computer that runs the browser leaves Operations Center empty. See [Log query shows no logs, HTTP 500, slow long ranges, or an empty real-time log on ACP](./Log_query_shows_no_logs_HTTP_500_slow_long_ranges_or_an_empty_real-time_log_on_ACP.md).

### Cause 3: The page has a different scope from the line you are searching

Several "no data" reports are about the console scope, not a broken indexer:

- **Product logs.** Namespace `cpaas-system` holds platform product logs. Observability, Logs lists application logs only. With product-log collection enabled, those lines are under Platform Management, Operations Center, Logs.
- **Default time window.** Observability, Logs opens on the last 30 minutes, which hides every earlier line. Change the time range in the upper-right corner. The lines were not removed by retention.
- **Pod filter.** A pod chosen in the query filter applies only after the confirm button in that filter is clicked. Without it, results come from other pods.
- **Wrong project.** A project named `default` reached through a non-standard entry path may not exist, so a namespace's logs look empty there. Switch to the project that owns the namespace and select the namespace there.
- **One cluster at a time.** An administrator query covers one cluster at a time. There is no cross-cluster aggregate.
- **Export limit.** Export stops at one million rows. Narrow the time range and the workload, export in batches, and merge the files outside the platform. To export one project's logs from the built-in Elasticsearch, filter Operations Center, Logs by that project and export the result.
- **Missing component on 4.0.** A data-service component such as RabbitMQ is missing from the component dropdown on 4.0 when its pod has no Project label, because the query joins pod, namespace and project by that label. This is fixed in 4.1. On 4.0, add the Project label that the other visible components carry.
- **ALB history.** An ALB pod in `cpaas-system` shows only its real-time log under the cluster's pods. Its history is under Platform Management, Operations Center, Logs, with Log Type `Product Logs`, a wider time range, and a filter for the ALB pod. The page shows only the first 10,000 matched logs.
- **ALB access logs.** Inbound ALB access logs are product logs. Set the log type to Product Logs, filter by the load balancer's component name as the component dropdown lists it (for example `alb2-cpaas-system`), and enter `client_addr` in Log Content. Each match is a JSON access record with fields such as `client_addr`, `host`, `request`, `status` and `upstream_addr`. Without product-log collection, read the recent records from the `nginx` container of the ALB pod (`kubectl logs -c nginx`).
- **GBK bytes.** The raw-log view shows GBK bytes, while the live tail, which is decoded as UTF-8, looks fine. Forcing the raw response to UTF-8 fixes the display. The file on disk is not corrupt.
- **NUL bytes.** A line full of `0x00` bytes renders as empty or as `NUL`, depending on the viewer. The zeros come from the application's write or its log rotation, not from the store.
- **Garbled live view before 4.0.** Chinese characters that are intermittently garbled only in the pod's real-time log view come from one UTF-8 character being split across two transmissions. This is fixed in platform 4.0.

### Cause 4: On ClickHouse storage, an uppercase keyword returns unrelated lines, or a project filter also returns a project with a longer name

Two behaviors of a ClickHouse-backed query page:

- Searching the log content for an uppercase keyword such as `ERROR` returns lines that do not contain it (`[WARN ]` lines, retry messages, stack-trace lines), while the same keyword in lowercase works. A direct ClickHouse query with `log_data ILIKE '%ERROR%'` for the same pod and time range returns only correct lines, so the stored data is right. This is a product bug in the log query parsing. It affects v4.3.1 to v4.3.5 and v4.4.0 to v4.4.1, and it is fixed in v4.4.2 and later and in v4.5.
- Filtering by project `<project>` also returns logs of a project named `<project>-<suffix>`. The project keyword is matched fuzzily by design.

## Resolution

### Cause 1: On Elasticsearch storage, the IK analyzer lowercases text and splits long Chinese strings

1. Search with the lowercase English token, or with the short Chinese token that IK emits. Quotes around the original uppercase or compound string do not change the analyzer. For a long alphanumeric ID on an IK build that drops the digits, use the unquoted lowercase ID.

2. To see which tokens a build produces, run `_analyze` with `ik_smart` against a log index:

   ```bash
   ES_USER=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.username}' | base64 -d)
   ES_PASS=$(kubectl -n cpaas-system get secret elasticsearch-basic-auth -o jsonpath='{.data.password}' | base64 -d)
   kubectl -n cpaas-system exec cpaas-elasticsearch-0 -c cpaas-elasticsearch -- \
     curl -sS -u "${ES_USER}:${ES_PASS}" -H 'Content-Type: application/json' \
     'http://cpaas-elasticsearch:9200/<log-workload-index>/_analyze?pretty' \
     -d '{"analyzer": "ik_smart", "text": "<id-or-text>"}'
   ```

3. If the requirement is an exact raw substring, move that cluster's log storage to ClickHouse. Confirm which store the cluster has before you treat this as a bug:

   ```bash
   kubectl -n cpaas-system get pods | grep -Ei 'elastic|clickhouse'
   ```

### Cause 2: Node clocks disagree, so the selected range is empty

1. On each node that runs `nevermore` or the log store, compare the clocks:

   ```bash
   date -u
   ```

   A gap of minutes is enough to push a short window off the record. A gap of months means the log center cannot be the source of truth until NTP is fixed.

2. Fix time synchronization.

   > **Warning:** Stepping a node clock affects certificates, leases and audit order, not only log search. Precondition: the skew is confirmed with `date -u` on the `nevermore` node and on the ClickHouse or Elasticsearch node, and you have a maintenance window for chrony or the hypervisor clock. Rollback: restore the previous NTP configuration. Do not set the clock of a single control-plane node by hand.

3. If the business requires clocks that differ, use the workload's live log (`kubectl logs`), and do not expect the log center to reconcile the ranges. Yellow Elasticsearch indices created by the skew stay yellow, and deleting them without fixing NTP recreates them.

### Cause 3: The page has a different scope from the line you are searching

Use the entry and filter that match the line, as listed in Root Cause:

- For `cpaas-system` product logs, use Platform Management, Operations Center, Logs.
- Widen the upper-right time range before you investigate Kafka or the store.
- Click the confirm button after you choose a pod.
- Export in windows that stay under one million rows.
- For GBK, set the raw-log request charset to UTF-8.
- For NUL bytes, count them in the file inside the container:

  ```bash
  kubectl exec -n <namespace> <pod> -c <container> -- \
    python3 -c 'import pathlib; b=pathlib.Path("<log-file>").read_bytes(); print(b.count(b"\x00"))'
  ```

  A large count means the application or its log rotation wrote the zeros. Fix that writer, because reindexing stores the same bytes.

### Cause 4: On ClickHouse storage, an uppercase keyword returns unrelated lines, or a project filter also returns a project with a longer name

1. Confirm that the stored rows are correct by querying ClickHouse directly from a replica pod:

   ```bash
   kubectl -n cpaas-system exec -it chi-cpaas-clickhouse-replicated-0-0-0 -c clickhouse -- clickhouse-client
   ```

   ```sql
   SELECT timestamp, log_data
   FROM observability.log_workload_all
   WHERE match(namespace, '<namespace>') AND match(workload, '<workload>')
     AND timestamp > now() - INTERVAL 1 HOUR
     AND log_data ILIKE '%ERROR%'
   ORDER BY timestamp DESC
   LIMIT 20;
   ```

   If the database name differs on this version, list it with `SHOW DATABASES`.

2. Correct rows here, and unrelated rows on the page for the same uppercase keyword, match the parsing bug. Until the platform is upgraded to v4.4.2 or later (or v4.5), search with the lowercase form.

3. To trace one page request, open the browser console (F12) and run the search. Copy the `request-id` from the response headers of the search request, and look it up in the `razor-api` logs on the global cluster:

   ```bash
   kubectl -n cpaas-system get pods | grep razor-api
   kubectl -n cpaas-system logs <razor-api-pod> | grep '<request-id>'
   ```

4. For the project filter, nothing needs fixing. When two project names share a prefix, narrow the result with the namespace or workload filter.

## Diagnostic Steps

1. Decide whether the record exists. A green Elasticsearch `_cat/indices`, or a ClickHouse table with today's rows, means the indexer ran, and this article applies. An empty index together with Kafka lag means a collection or consumption problem.

2. Repeat the query with the lowercase or short token (Cause 1) and with a wide time range. A page left on the default last 30 minutes is Cause 3, not a missing index. If the wide range works and the node clocks differ, it is Cause 2.

3. On ClickHouse storage, an uppercase keyword that returns unrelated lines while a direct `ILIKE` query returns the right rows is Cause 4. So is a project filter that also returns a project whose name starts with the same text.

4. A single namespace or component missing while everything else is searchable is Cause 3. For one business cluster that returns nothing, test the 6443 path from the global cluster as described in [Log query shows no logs, HTTP 500, slow long ranges, or an empty real-time log on ACP](./Log_query_shows_no_logs_HTTP_500_slow_long_ranges_or_an_empty_real-time_log_on_ACP.md).

## Related Information

- [Log query shows no logs, HTTP 500, slow long ranges, or an empty real-time log on ACP](./Log_query_shows_no_logs_HTTP_500_slow_long_ranges_or_an_empty_real-time_log_on_ACP.md)
- [Log Kafka lag from Elasticsearch write hot spots, breaker trips, IK analyzer errors, or too few partitions on ACP](./Log_Kafka_lag_from_Elasticsearch_write_hot_spots_breaker_trips_IK_analyzer_errors_or_too_few_partitions_on_ACP.md)
