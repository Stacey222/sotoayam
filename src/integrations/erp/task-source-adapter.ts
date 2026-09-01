import type { TaskSourceAdapter } from "../../ingestion/types.js";

/** ERP-specific adapters must normalize payloads into canonical intake and never write Task Core directly. */
export type ErpTaskSourceAdapter<TPayload = unknown> = TaskSourceAdapter<TPayload>;
