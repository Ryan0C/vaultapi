// /src/utils/errors.ts
export class HttpError extends Error {
    status;
    details;
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}
export function notFound(message = "Not Found") {
    return new HttpError(404, message);
}
export function badRequest(message = "Bad Request", details) {
    return new HttpError(400, message, details);
}
export function unauthorized(message = "Unauthorized") {
    return new HttpError(401, message);
}
export function forbidden(message = "Forbidden") {
    return new HttpError(403, message);
}
//# sourceMappingURL=errors.js.map