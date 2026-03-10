// /src/utils/errors.ts

export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function notFound(message = "Not Found"): HttpError {
  return new HttpError(404, message);
}

export function badRequest(message = "Bad Request", details?: unknown): HttpError {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized"): HttpError {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden"): HttpError {
  return new HttpError(403, message);
}