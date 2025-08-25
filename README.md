# ASEG → Table (Vite + React)

Convert a batch of per-subject ASEG `.txt` files into one wide CSV table, using
`participants.tsv` (or `covariates.csv`) to define the subject list and order.

## How it works
- Upload N subject files (e.g., `sub-001.txt`, `sub-002.txt`, …)
- Upload `participants.tsv` or `covariates.csv`
- Choose which column holds the subject IDs (defaults to the first column)
- The app matches `<id>` to `<id>.txt`, parses each file for metrics, unifies columns,
  and downloads `aseg_merged.csv`

## Parsing rules
The subject `.txt` files can be:
- Two-line **header + values** (e.g., `Col1\tCol2\t...` then a single values line)
- `key:value`
- `key\tvalue`
- `key  value` (two or more spaces). We treat the last token as the value; the rest form the key.

Numbers are coerced when possible; otherwise plain text is kept.

## Local dev
```bash
npm install
npm run dev
```

## Build for GitHub Pages
1. In `vite.config.ts`, set `base: '/<your-repo>/'`
2. `npm run build` → deploy the `dist/` folder to Pages (or use an action)

## Notes
- We only match by **base file name**: `<id>.txt` (extension removed). Case-sensitive.
- If a subject has no matching file, its row will be included with blank metric cells and a warning.
- If a file has no matching ID in the table, we warn about it but still proceed.
