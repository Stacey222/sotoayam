# BigSeller Discovery Contract

No API endpoint, credential type, or account capability is assumed. Vendor support and account eligibility must be verified before connector design.

## Must have for beta

- Confirm actual beta use case and accountable business owner.
- Confirm supported API/export availability, authentication, sandbox/test path, quotas, and permitted data use.
- Stable order, SKU/variant, inventory location, and fulfillment identifiers.
- Order status lifecycle including cancellation, return, and partial fulfillment semantics.
- Inventory quantity definitions, warehouse mapping, timestamp/timezone, pagination, incremental sync, and reconciliation behavior.
- Minimum required fields for orders, inventory, sales, and fulfillment; data minimization and retention rules.
- Error, retry, idempotency, duplicate, deletion, and source-correction behavior.

## Nice to have

- Listing health and listing-content attributes.
- Near-real-time webhooks where supported and operationally justified.
- Historical performance aggregates beyond the beta reporting window.
- Automated reconciliation dashboards and source-latency metrics.

## Not required for beta

- Automated listing mutation or bulk publishing.
- Price or promotion automation.
- Broad raw-data replication without a confirmed Sotoayam use case.
- Any user, role, Divisi, collaboration-rule, OWNER, or SYSTEM_ADMIN management.

All sections remain `MISSING_INPUT`. BigSeller must use a machine identity and approved capabilities; it must not write Sotoayam tables directly.
