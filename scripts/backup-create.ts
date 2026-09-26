import path from "node:path";
import { createBackup } from "./backup-recovery.js";

if (process.env.SOTOAYAM_BACKUP_SOURCE !== "customer") throw new Error("SOTOAYAM_BACKUP_SOURCE=customer is required");
await createBackup({ databaseUrl: process.env.SOTOAYAM_BACKUP_DATABASE_URL ?? "",
  expectedProjectRef: process.env.SOTOAYAM_BACKUP_EXPECTED_PROJECT_REF ?? "",
  outputDirectory: path.resolve(process.env.SOTOAYAM_BACKUP_OUTPUT_DIR ?? "backups") });
