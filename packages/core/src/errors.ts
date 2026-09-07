export class AppError extends Error {
  public readonly status: number;
  public readonly type: string;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    status: number,
    type: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.type = type;
    this.details = details;
  }
}

export const validationError = (message: string): AppError =>
  new AppError(422, "urn:aqua:error:validation", message);

export const upstreamError = (message: string): AppError =>
  new AppError(502, "urn:aqua:error:upstream", message);
