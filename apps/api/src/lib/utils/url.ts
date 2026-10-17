type ToUrlOpts =
  | {
      log?: boolean;
      lowerCase?: boolean;
    }
  | undefined;

function safeToUrl(url: string, opts?: ToUrlOpts): URL | null {
  const { log = true, lowerCase = false } = opts ?? {};

  const trimmedUrl = url.trim();
  const preparedUrl = lowerCase ? trimmedUrl.toLowerCase() : trimmedUrl;
  for (const candidate of [preparedUrl, `https://${preparedUrl}`]) {
    try {
      return new URL(candidate);
    } catch (err) {
      if (log) console.error(err);
    }
  }

  return null;
}

function toUrl(url: string, opts?: ToUrlOpts): URL {
  const parsedUrl = safeToUrl(url, opts);
  if (!parsedUrl) {
    throw new Error(`Could not make a URL from "${url}"`);
  }

  return parsedUrl;
}

// Shared with the web plugins, which decline a file address for the same
// reason the scraper does.
export { looksLikeNonHtmlAddress } from '@lf/web/addresses';

export { toUrl, safeToUrl };
