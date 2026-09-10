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

export class RateLimitedError extends AppError {
  constructor(public readonly retryAfterSeconds: number,
    public readonly rateLimit?: { limit: number; remaining: number; resetSeconds: number }) {
    super(429, "RATE_LIMITED", "Too many requests");
    this.name = "RateLimitedError";
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
