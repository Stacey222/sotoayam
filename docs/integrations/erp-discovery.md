# ERP Discovery Contract

No ERP connector or endpoint is assumed. Every item is `MISSING_INPUT` until verified against the actual ERP and authoritative vendor documentation.

| Discovery item | Required evidence / decision | Status |
|---|---|---|
| Product/platform and version | Exact deployed ERP product, edition, hosting model, and owner | `MISSING_INPUT` |
| API availability and documentation | Supported API type, version, environments, and official documentation | `MISSING_INPUT` |
| Authentication | Supported machine authentication, scopes, rotation, expiry, and revocation | `MISSING_INPUT` |
| Webhooks | Supported events, signing, replay protection, delivery guarantees | `MISSING_INPUT` |
| Export support | Supported scheduled/manual formats and delivery mechanism | `MISSING_INPUT` |
| Rate limits | Quotas, concurrency, backoff, and vendor retry guidance | `MISSING_INPUT` |
| Product identifiers | Stable SKU/product keys and variant semantics | `MISSING_INPUT` |
| Inventory identifiers | Stock units, availability semantics, and adjustment identity | `MISSING_INPUT` |
| Warehouse identifiers | Stable warehouse/location keys and mapping ownership | `MISSING_INPUT` |
| Purchase data | Required documents, statuses, line semantics, and corrections | `MISSING_INPUT` |
| Sales/order data | Required orders, statuses, cancellations, returns, and currency | `MISSING_INPUT` |
| Time | Timestamp formats, source timezone, update semantics, and business boundary | `MISSING_INPUT` |
| Pagination | Cursor/page behavior, ordering guarantees, and maximum page size | `MISSING_INPUT` |
| Incremental sync | Watermark/change token, deletion/tombstone behavior, and reconciliation | `MISSING_INPUT` |

Before design, confirm data ownership, business purpose, required freshness, acceptable outage behavior, historical import scope, privacy classification, sandbox availability, and who approves field mappings. The adapter must call Sotoayam canonical services and use a machine integration identity.
