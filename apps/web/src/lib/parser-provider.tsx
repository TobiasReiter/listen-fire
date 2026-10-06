'use client';

import { useEffect, useState } from 'react';
import { initParser, isParserReady, neverAsAny } from 'movement-lang';

/** Where the browser fetches the parser: next.config.ts copies the artifact
 *  into public/ under this name. */
export const PARSER_URL = '/movement_parser.wasm';

let loading: Promise<void> | undefined;

/** Loads the parser once per page, however many providers mount; a failed
 *  load is forgotten so the error boundary's "Try again" fetches afresh. */
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
 * nothing, as the app layout does while auth loads. A failed load throws to
 * the error boundary.
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
      throw new Error(`could not load the movement parser from ${PARSER_URL}`, { cause: state.failure });
    default:
      return neverAsAny(state);
  }
}
