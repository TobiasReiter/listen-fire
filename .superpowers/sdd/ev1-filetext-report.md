# ev1-filetext (C5) report

Done. File text extraction now lives in `packages/file-text` (source package, like `principal`).

- Package holds: PDF (text layer, per page density rule, size caps), PPTX, XLSX/CSV (formula eval, layout blocks), audio size rules, kind classification, NUL scrub, unreadable reasons.
- Injected: `openBytes` (+ `isRefusal` so the team refusal still propagates), `ocrPdf`, `transcribe`, `analyzeSheet` (the spreadsheet model call; host chooses model and meter label), `rawText`, `logger`.
- apps/api `movement/file_text.ts` is now a thin binding (same exports: `makeFileTextResolver`, `extractPdfText`, `FileTextReader`; new `analyzeSheet`). `lib/utils/excel.ts` and `powerpoint.ts` were moved (git mv) into the package; their two other callers (document tool, parseExcel script) import `file-text`.
- Build and install wiring: apps/api dependency + build step (vendored into build/node_modules/file-text), both Dockerfiles copy the package manifest, lockfile hand-trimmed to only the new importer (offline resolve had churned unrelated entries).

Before/after: old code from 4ba5f821 vs new, plain node (tsx): PPTX deck, CSV (stub model answer) and a real jsPDF text-layer PDF all give byte-identical text. Goldens committed in the package test with the fixtures.

Tests: package 8 pass; apps/api scoped (file_text, files_by_envelope, file_ref_resume, engine_host, extract_document) 5 suites / 88 pass; apps/api `code:type-check` (incl. oracle) clean; package type-check clean. No integration tests, no dev-loop run (no production path changed beyond import binding).
Not run: build (`pnpm build`) and docker image build; Dockerfile.web edit is for workspace closure only.
