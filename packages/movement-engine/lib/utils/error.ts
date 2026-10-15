// Shamelessly taken from https://kentcdodds.com/blog/get-a-catch-block-error-message-with-typescript

type ErrorWithMessage = {
  message: string;
};

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
  if (isErrorWithMessage(maybeError)) return maybeError;

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

function getErrorMessage(error: unknown) {
  return toErrorWithMessage(error).message;
}

/**
 * Like getErrorMessage, but follows the `cause` chain — the detail a bare
 * message hides. undici throws `TypeError: fetch failed` and puts the real
 * reason (DNS failure, connection reset, TLS error) on `error.cause`; this
 * unwinds that into `fetch failed: getaddrinfo ENOTFOUND host`, so run
 * failure reasons and logs say WHY, not just "fetch failed".
 */
function describeError(error: unknown): string {
  let message = getErrorMessage(error);
  const seen = new Set<unknown>([error]);
  let current: unknown = (error as { cause?: unknown } | null)?.cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const detail = getErrorMessage(current);
    if (detail && !message.includes(detail)) message += `: ${detail}`;
    current = (current as { cause?: unknown }).cause;
  }
  return message;
}

export { getErrorMessage, describeError };
