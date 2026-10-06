'use strict';

/** An error the client may see: HTTP status + short code + a public message. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const bad = (code, msg) => new HttpError(400, code, msg);
const forbidden = (code, msg) => new HttpError(403, code, msg);
const conflict = (code, msg) => new HttpError(409, code, msg);

module.exports = { HttpError, bad, forbidden, conflict };
