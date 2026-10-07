'use client';

import { ParserProvider } from '@/lib/parser-provider';

// The editor routes parse as they render; every other page stays free of the
// parser fetch (the /movements index only redirects).
export default function MovementsLayout({ children }: { children: React.ReactNode }) {
  return <ParserProvider>{children}</ParserProvider>;
}
