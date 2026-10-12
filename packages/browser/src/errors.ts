const NET_ERRORS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "the address couldn't be found",
  ERR_CONNECTION_REFUSED: 'nothing answered there. If it is a dev server, check that it is running',
  ERR_CONNECTION_RESET: 'the connection was cut off',
  ERR_CONNECTION_CLOSED: 'the connection was closed',
  ERR_CONNECTION_TIMED_OUT: 'it took too long to answer',
  ERR_TIMED_OUT: 'it took too long to answer',
  ERR_INTERNET_DISCONNECTED: "there's no internet connection",
  ERR_ADDRESS_UNREACHABLE: "the address can't be reached",
  ERR_BLOCKED_BY_CLIENT: "it isn't allowed for this clank",
  ERR_ABORTED: 'the page stopped loading. It may have started a download, or gone somewhere else',
  ERR_TOO_MANY_REDIRECTS: 'it redirects in a loop',
  ERR_SSL_PROTOCOL_ERROR: "its secure connection didn't work",
  ERR_EMPTY_RESPONSE: 'it sent nothing back',
  ERR_INVALID_URL: "it isn't a valid address",
  ERR_UNSAFE_PORT: 'browsers refuse that port',
};

/** A Chromium network error, such as `ERR_NAME_NOT_RESOLVED (-105)`, in plain words. */
export function netErrorText(message: string): string {
  const code = /ERR_[A-Z0-9_]+/.exec(message)?.[0];
  if (!code) return message;
  if (code.startsWith('ERR_CERT_')) return "its security certificate isn't valid";
  return NET_ERRORS[code] ?? code;
}

/** Whether a failed load was only cut short, which a redirect or a download also does. */
export function isAborted(message: string): boolean {
  return /ERR_ABORTED/.test(message);
}
