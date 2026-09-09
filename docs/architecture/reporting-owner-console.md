# Reporting and Owner Console Foundation

Slice 8 derives reports directly from canonical Task Core data. It does not create snapshots or a second business truth store.

## Canonical definition

`TASK_STATUS` is the canonical report and accepts customer-defined Divisi, category, status, and time-window filters. Category is nullable for compatibility and is written only through TaskService or its intake paths. Titles, descriptions, sources, and external references never classify a task.

`AFFILIATE_TASK_STATUS` is a deprecated compatibility alias for the historical `CONTENT_CREATOR`/`AFFILIATE` report. It is registered only for `LEGACY` or `UNKNOWN` installation lineage and is absent for `FRESH`; it is not a product default. The database validates category as an uppercase code instead of a closed database enum, so fresh installations use customer-defined active categories. Existing historical tasks remain unclassified and are not backfilled.

## Metrics

The report window filters task `created_at`. `TODAY` starts at local business midnight; `LAST_7_DAYS` and `LAST_30_DAYS` include the current business date plus the preceding 6 or 29 dates, ending at evaluation time. `BUSINESS_TIME_ZONE` is validated at startup and must be selected for the customer; the safe fallback is `UTC`, while the historical staged installation explicitly uses `Asia/Jakarta`. Stored timestamps remain UTC.

Total and completion-rate denominator include OPEN, IN_PROGRESS, BLOCKED, and COMPLETED tasks. CANCELLED and DRAFT are explicitly excluded and counted separately in the service result. Completion rate is COMPLETED divided by that total and is null when the denominator is zero. OVERDUE is derived for active tasks with `deadline < now`; it is never stored. Upcoming deadlines are active tasks due from now through the next seven days.

## Authorization and interfaces

Business reporting requires an active, fully onboarded normalized user whose business role is OWNER. SYSTEM_ADMIN alone never grants report access. Telegram `/owner` resolves the current normalized Telegram identity and re-authorizes every callback. The protected report API uses the same ReportingService and a separate Owner actor resolver; Telegram handlers contain no report SQL.

Drill-down is limited to five tasks per page and contains only safe Task Core fields. Task activities, Telegram identities, integration metadata, audit payloads, and technical mutation controls are not exposed. Critical Alerts, Approval, and Automation Status remain placeholders for later explicitly authorized work.
