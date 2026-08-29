export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface DatabaseDiagnostic {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export class DatabaseError extends AppError {
  constructor(message: string, public readonly diagnostic: DatabaseDiagnostic) {
    super(503, "DATABASE_ERROR", message);
    this.name = "DatabaseError";
  }
}
