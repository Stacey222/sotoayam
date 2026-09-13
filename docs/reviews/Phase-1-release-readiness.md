# Phase 1 Release-Readiness Review

## Executive Summary
An independent software quality and reliability review was conducted on Phase 1 implementation (P1-01 through P1-09), strictly avoiding offensive security testing and vulnerability scanning as requested. The review evaluated admin session authentication, rate limiting, HTTP/Telegram retry semantics, deduplication, and readiness endpoints for state consistency and idempotency.

Overall, the architecture displays high software engineering standards. State management, deduplication via sliding window offsets (`complete_telegram_update`), and process-level concurrency limits are robust. However, two significant reliability flaws require remediation before release: a cross-module assumption bug causing permanent Telegram failures to endlessly retry, and a caching design flaw in the readiness probe that will induce false negatives during brief network blips.

## Blocking Correctness Issues

### 1. Inconsistent Error Handling: Permanent Telegram Failures Retried Endlessly
- **Location**: `src/services/notification-delivery.service.ts` (`classify`) and `src/services/telegram.service.ts`
- **Description**: When `TelegramApiClient` encounters a permanent 4xx error (e.g., chat not found, bot blocked), it correctly marks it `retryable: false`. `TelegramSender.sendMessage` then wraps this in a `TelegramOperationError` with the code `"TELEGRAM_SEND_FAILED"`. However, `NotificationDeliveryService.classify` blindly checks `error.code === "TELEGRAM_SEND_FAILED"` and returns `{ class: "TRANSIENT" }` without inspecting the underlying `classification.retryable` flag.
- **Impact**: Permanent delivery failures to deactivated/blocked users are treated as transient network errors. They are retried up to `max_attempts` across spaced intervals, wasting database queue bandwidth, risking unnecessary rate limits, and creating duplicate operational side effects.
- **Fix**: Update `NotificationDeliveryService.classify` to inspect `error.classification.retryable`. If `retryable` is false, it should return a `PERMANENT` failure class.

### 2. Readiness False Negatives: Caching Failed State
- **Location**: `src/readiness/readiness.service.ts` (`check`)
- **Description**: The `ReadinessService.check()` method indiscriminately caches both successful (`READY`) and failed (`NOT_READY`) results for `cacheMs`.
- **Impact**: A momentary database or network blip will cause a failed probe. Because this failure is cached, the application will broadcast `503 Service Unavailable` for the full duration of `cacheMs`, even if the database recovers instantly. This introduces severe false negatives for orchestrators (like Kubernetes or load balancers), potentially triggering restart loops or eviction.
- **Fix**: Modify the caching logic to either bypass caching when `result.ready === false` or use a significantly shorter TTL for failed checks.

## Non-Blocking Issues

### 1. Ambiguous Trust Proxy Fallback
- **Location**: `src/http/rate-limit-plugin.ts`
- **Description**: If the application is deployed behind a reverse proxy and `TRUST_PROXY=false`, all traffic falls into a single IP bucket (`127.0.0.1`). The system correctly warns about this and scales the capacity (`rateLimitSharedOriginFactor`), which is a good defensive degradation. However, administrators should be heavily warned that accidentally adding `127.0.0.1` to `RATE_LIMIT_TRUSTED_IPS` under this configuration will completely disable all rate limits, failing open.

## Test-Quality Concerns

### 1. Flaky Test: `install-env timeout`
- **Assessment**: **Environment-Sensitive Jitter (Not a Product Defect)**
- **Root Cause**: The test uses `spawnSync` to execute Git Bash on Windows. Windows shell process creation latency is exceptionally high compared to POSIX systems. When running in parallel under Vitest, this overhead frequently exceeds standard test timeouts. This does not indicate a flaw in the installer script itself.

### 2. Flaky Test: `password timing-ratio variance`
- **Assessment**: **Flaky Test Design (Not a Product Defect)**
- **Root Cause**: The test micro-benchmarks the `scrypt` verification delay between valid and invalid usernames. It runs only 2 iterations per branch and expects the timing ratio to fall within `[0.5, 2]`. This is statistically insignificant for Node.js, where standard event-loop jitter, GC pauses, and CI load will easily skew the results of a 4-sample benchmark, causing intermittent failures.

## Verdict
**READY WITH FIXES**

## Ordered Next Actions
1. **Fix Telegram Retry Classification**: Update `NotificationDeliveryService.classify` to read the `retryable` flag inside `TelegramOperationError` and correctly return `PERMANENT`.
2. **Fix Readiness Cache**: Update `ReadinessService.check` to avoid caching `NOT_READY` states or to cache them with a drastically reduced TTL.
3. **Stabilize Flaky Tests**: Increase the sample size and allowable variance in the password timing-ratio test, and increase the timeout (or mock the spawn) for the `install-env` test.
4. **Deploy**: Once these fixes are committed, the release candidate is safe to proceed from an engineering reliability standpoint.

## P1-10 Follow-up Reconciliation

- **Telegram permanent failure classification — CONFIRMED, CLOSED.** A focused reproducer proved that wrapped HTTP 400, 403, and 404 Telegram failures were persisted as `PENDING/TRANSIENT`. The delivery classifier now reads the preserved transport classification and makes definite non-retryable client rejections permanent. Network failures, HTTP 429, HTTP 5xx, timeout, and other ambiguous transport outcomes remain transient for the separate durable delivery retry policy. End-to-end coverage proves the path from `TelegramApiClient` through delivery persistence.
- **Readiness NOT_READY caching — REJECTED, ACCEPTED BOUNDED STALENESS.** The default cache is 1000 ms and bounds both positive and negative unauthenticated probe amplification. A failed result is re-probed at expiry. Release and rollback polling wait 2 seconds between attempts, make 15 retries, and allow 5 seconds per attempt, so one cached failure cannot by itself cause premature rollback. Removing negative caching would weaken the intentional database-amplification bound without demonstrating a contract defect.
- **Test stability — CLOSED.** Windows Git Bash installer tests receive a platform-specific 15-second process-start allowance. The password timing regression now uses four interleaved observations per branch, compares robust medians, and retains both a minimum-cost assertion and a bounded ratio.

Follow-up verdict: **CLOSE**.
