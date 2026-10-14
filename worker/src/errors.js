// An error whose message is safe to show to the customer, with its HTTP status
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
