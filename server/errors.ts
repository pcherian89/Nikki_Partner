/** An error whose message is safe and useful to show the user. `data` carries structured detail (for example the timer that is running). */
export class UserFacingError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "bad_request",
    public details?: string[],
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}
