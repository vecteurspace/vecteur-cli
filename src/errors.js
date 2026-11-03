/**
 * The CLI's one typed error, in its own module.
 *
 * It used to live in `client.js`, which `credentials.js` had to import for it while `client.js`
 * needed `credentials.js` to resolve a stored login — a cycle whose first workaround was a
 * function reached through `globalThis`. An error type is not part of either concern; it is
 * shared vocabulary, so it owns a file and neither side reaches through the other.
 */
export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
