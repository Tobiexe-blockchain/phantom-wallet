export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Thrown by the withdrawal processor when the job should be retried later. */
export class RetryableError extends Error {}
