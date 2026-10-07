'use client';

import { useEffect, useState } from 'react';
import { initParser, isParserReady, neverAsAny } from 'movement-lang';

/** Where the browser fetches the parser: next.config.ts copies the artifact
 *  into public/ under a content-hashed name and injects that URL. */
export const PARSER_URL = requiredUrl(process.env.NEXT_PUBLIC_PARSER_URL);

function requiredUrl(url: string | undefined): string {
  if (url === undefined) throw new Error('NEXT_PUBLIC_PARSER_URL is not set; next.config.ts injects it');
  return url;
}

let loading: Promise<void> | undefined;

/** Loads the parser once per page, however many providers mount; a failed
 *  load is forgotten so "Try again" fetches afresh. */
export function loadParser(): Promise<void> {
  loading ??= initParser(PARSER_URL).catch((failure: unknown) => {
    loading = undefined;
    throw failure;
  });
  return loading;
}

type ParserState = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; failure: unknown };

/**
 * Renders its children only once the movement parser has loaded. The
 * editors and the listeners panel parse during their first render, and a
 * browser can only load the parser asynchronously (it refuses a large
 * synchronous WASM compile on the main thread), so until then this renders
 * nothing. It wraps only the movement routes, so a failed load shows its
 * own error there and never reaches the pages that do not parse.
 */
export function ParserProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ParserState>(() =>
    isParserReady() ? { status: 'ready' } : { status: 'loading' },
  );

  useEffect(() => {
    if (state.status !== 'loading') return;
    let mounted = true;
    loadParser().then(
      () => mounted && setState({ status: 'ready' }),
      (failure: unknown) => mounted && setState({ status: 'failed', failure }),
    );
    return () => {
      mounted = false;
    };
  }, [state.status]);

  switch (state.status) {
    case 'loading':
      return null;
    case 'ready':
      return <>{children}</>;
    case 'failed':
      return (
        <div role="alert" className="p-6 text-sm text-gray-700">
          <p>The movement editor could not load its parser.</p>
          <p className="mt-1 text-gray-500">{state.failure instanceof Error ? state.failure.message : String(state.failure)}</p>
          <button
            type="button"
            className="mt-3 rounded border border-gray-300 px-3 py-1.5 text-gray-900 hover:bg-gray-50"
            onClick={() => setState({ status: 'loading' })}
          >
            Try again
          </button>
        </div>
      );
    default:
      return neverAsAny(state);
  }
}
