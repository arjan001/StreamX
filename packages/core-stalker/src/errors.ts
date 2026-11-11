export type StalkerErrorCode =
  | 'bad_url' // portal URL could not be parsed
  | 'bad_mac' // MAC address is not 12 hex digits
  | 'network' // the transport threw
  | 'aborted' // the caller's AbortSignal fired
  | 'http' // non-2xx status
  | 'auth' // the portal rejected the MAC / token / login
  | 'bad_body' // not JSON (HTML error page, empty body, ...)
  | 'no_endpoint' // none of the candidate API paths answered a handshake
  | 'unsupported' // the portal has no such module or action
  | 'no_link'; // create_link answered without a usable URL

export class StalkerError extends Error {
  readonly code: StalkerErrorCode;
  readonly status: number | null;
  constructor(code: StalkerErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'StalkerError';
    this.code = code;
    this.status = status;
  }
}
