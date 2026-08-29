import { DatabaseError, type DatabaseDiagnostic } from "../errors.js";

export function governanceDatabaseError(message: string, error: DatabaseDiagnostic): DatabaseError {
  return new DatabaseError(message, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}
