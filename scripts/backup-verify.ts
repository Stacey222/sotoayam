import path from "node:path";
import { verifyBackup } from "./backup-recovery.js";

await verifyBackup(path.resolve(process.env.SOTOAYAM_BACKUP_ARTIFACT ?? ""));
