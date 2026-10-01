# Contributing to StudyAgent

## Local setup

Use Node.js 24 or newer, then run:

```powershell
npm ci
npm start
```

Open `http://127.0.0.1:4173/` in a browser. The application creates its local SQLite database and runtime data on first start.

## Before opening a change

Run the checks below from the project root:

```powershell
npm run check:syntax
npm test
npm run check:http
```

For PDF/OCR/parser changes, place a local regression PDF in `uploads/` and run:

```powershell
npm run check:pdf
```

The local regression PDF, `uploads/`, `data/`, model configuration, SQLite files and runtime artifacts are intentionally ignored by Git. Do not commit API keys, personal learning memory, or private course documents.

## Change boundaries

- Keep document parsing, retrieval, memory and provider logic on the server side.
- Preserve page/slide/sheet locators and source citations when changing the pipeline.
- Add or update a test when changing a persistence or API route.
- Keep the local fallback honest: it must identify itself as local mode and must not be presented as a remote model response.
