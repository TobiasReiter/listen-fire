"use client";

// The Library — a shelf of handbooks, one per system capability.
// Deep-linkable: /library?book=<bookId> opens a book directly (the
// movement editor's help affordance links here).

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, BookOpen } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { usePageTitle } from "@/components/page-title";
import { usePublishPageContext } from "@/components/page-context";
import { AgentMarkdown } from "@/components/agent-markdown";
import { Badge, PageBody, PageHeader, PageIntro } from "@/components/ui";

type Book = {
  bookId: string;
  title: string;
  description: string;
  status: "available" | "legacy" | "coming_soon";
  statusNote?: string;
  link?: { label: string; url: string };
  chapters: { id: string; title: string; content: string }[];
  intentIndex: { intent: string; chapter: string; section?: string }[];
};

function BookBadge({ status }: { status: Book["status"] }) {
  if (status === "available") return null;
  const tones = { legacy: "amber", coming_soon: "gray" } as const;
  const labels = { legacy: "Legacy", coming_soon: "Coming soon" } as const;
  return <Badge tone={tones[status]}>{labels[status]}</Badge>;
}

function BookCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const readable = book.chapters.length > 0;
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-gray-900">{book.title}</h2>
        <BookBadge status={book.status} />
      </div>
      <p className="mt-2 flex-1 text-[12.5px] leading-relaxed text-gray-500">
        {book.description}
      </p>
      <div className="mt-4 flex items-center gap-1.5 text-[12px] font-medium">
        {readable ? (
          <span className="flex items-center gap-1.5 text-gray-600">
            <BookOpen size={13} />
            {book.chapters.length} chapter{book.chapters.length === 1 ? "" : "s"}
          </span>
        ) : book.link ? (
          <a
            href={book.link.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-gray-600 hover:text-gray-900"
          >
            {book.link.label}
            <ArrowUpRight size={13} />
          </a>
        ) : (
          <span className="text-gray-400">Not yet written</span>
        )}
      </div>
    </>
  );

  if (!readable) {
    return (
      <div className="flex h-full flex-col rounded-xl border border-dashed border-gray-200 bg-gray-50/40 p-5">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-full flex-col rounded-xl border border-gray-200 bg-white p-5 text-left transition-shadow hover:border-gray-300 hover:shadow-sm"
    >
      {body}
    </button>
  );
}

function BookReader({ book, onBack }: { book: Book; onBack: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const current =
    book.chapters.find((c) => c.id === selectedId) ?? book.chapters[0] ?? null;

  // Tell the global assistant which handbook and chapter is open.
  usePublishPageContext(
    useMemo(
      () => ({
        page: "Library — reading a handbook",
        entities: [{ kind: "handbook", id: book.bookId, name: book.title }],
        ...(current ? { extras: { chapter: current.title } } : {}),
      }),
      [book.bookId, book.title, current],
    ),
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-64 shrink-0 overflow-y-auto border-r border-gray-100 p-4">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 flex items-center gap-1.5 text-[12px] text-gray-400 hover:text-gray-700"
        >
          <ArrowLeft size={13} />
          All handbooks
        </button>

        <div className="mb-1 text-[13px] font-semibold text-gray-900">
          {book.title}
        </div>
        <p className="mb-4 text-[12px] leading-relaxed text-gray-500">
          {book.description}
        </p>
        {book.status === "legacy" && book.statusNote && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
            {book.statusNote}
          </p>
        )}

        <nav className="space-y-0.5">
          {book.chapters.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-[13px] ${
                current?.id === c.id
                  ? "bg-primary/10 font-medium text-gray-900"
                  : "text-gray-600 hover:bg-gray-50"
              }`}
            >
              {c.title}
            </button>
          ))}
        </nav>

        {book.intentIndex.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              When you need to…
            </div>
            <ul className="space-y-1.5">
              {book.intentIndex.map((e, i) => (
                <li key={i}>
                  <button
                    onClick={() => setSelectedId(e.chapter)}
                    className="text-left text-[12px] leading-snug text-gray-500 hover:text-gray-800"
                  >
                    {e.intent}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {current && (
          <article className="prose prose-sm mx-auto max-w-3xl">
            <AgentMarkdown content={current.content} />
          </article>
        )}
      </main>
    </div>
  );
}

export default function LibraryPage() {
  usePageTitle("Library — TARS");
  const router = useRouter();
  const searchParams = useSearchParams();

  const { data, isLoading } = trpc.views.handbook.getShelf.useQuery();
  const books = useMemo(() => data?.books ?? [], [data]);

  const openBookId = searchParams.get("book");
  const openBook =
    books.find((b) => b.bookId === openBookId && b.chapters.length > 0) ?? null;

  // Shelf view: publish the page + available handbooks. When a book is
  // open, BookReader (mounted instead) publishes the book + chapter.
  usePublishPageContext(
    useMemo(
      () =>
        openBook
          ? null
          : {
              page: "Library",
              entities: books.map((b) => ({
                kind: "handbook",
                id: b.bookId,
                name: b.title,
              })),
            },
      [openBook, books],
    ),
  );

  const open = (bookId: string) => router.push(`/library?book=${bookId}`);
  const back = () => router.push("/library");

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Library" />

      {isLoading || !data ? (
        <div className="flex-1 p-5 text-[13px] text-gray-400">Loading…</div>
      ) : openBook ? (
        <BookReader key={openBook.bookId} book={openBook} onBack={back} />
      ) : (
        <PageBody width="wide">
          <PageIntro>
            Handbooks for each part of the platform — how to write movements,
            design and query your knowledge model, and build on top of TARS.
          </PageIntro>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {books.map((book) => (
              <BookCard
                key={book.bookId}
                book={book}
                onOpen={() => open(book.bookId)}
              />
            ))}
          </div>
        </PageBody>
      )}
    </div>
  );
}
