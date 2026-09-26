import path from "node:path";
import { restoreBackup } from "./backup-recovery.js";

await restoreBackup({ artifactPath: path.resolve(process.env.SOTOAYAM_BACKUP_ARTIFACT ?? ""),
  databaseUrl: process.env.SOTOAYAM_RESTORE_DATABASE_URL ?? "",
  expectedProjectRef: process.env.SOTOAYAM_RESTORE_EXPECTED_PROJECT_REF ?? "",
  recoveryTarget: process.env.SOTOAYAM_RESTORE_TARGET ?? "",
  confirmation: process.env.SOTOAYAM_RESTORE_CONFIRM ?? "" });
