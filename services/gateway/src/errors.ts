/**
 * HttpError: a failure the caller should see, with its HTTP status. The
 * message is sent to the client, so it must never contain request text.
 */
export class HttpError extends Error {
  status: number;
  headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
