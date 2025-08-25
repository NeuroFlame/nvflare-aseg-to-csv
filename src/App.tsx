import React, { useMemo, useState } from 'react'
import Papa from 'papaparse'
import { saveAs } from 'file-saver'

type ParsedTable = { data: any[]; meta: { fields?: string[] } }
type SubjectMap = Record<string, File>
type SubjectMetrics = Record<string, number | string>
type ParsedSubject = { metrics: SubjectMetrics; order: string[] }

function sniffDelimiterFromFilename(name: string): string {
  const n = name.toLowerCase()
  if (n.endsWith('.tsv')) return '\t'
  if (n.endsWith('.csv')) return ','
  return ',' // default
}

function normalize(s: string): string {
  return String(s || '').trim()
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function splitByAny(line: string): string[] {
  // Split by tab OR comma OR (two+ spaces OR one+ space)
  const tab = line.split('\t')
  if (tab.length > 1) return tab
  const csv = line.split(',')
  if (csv.length > 1) return csv
  return line.trim().split(/\s{2,}|\s+/)
}

function coerceNumber(v: any): number | string {
  const s = String(v ?? '').trim()
  if (s === '') return ''
  const num = Number(s)
  return Number.isFinite(num) ? num : s
}

function parseSubjectTxt(text: string): ParsedSubject {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const metrics: SubjectMetrics = {}
  const order: string[] = []

  for (const line of lines) {
    if (!line) continue
    // Skip the special header line: "Measure:volume   sub-001"
    if (/^Measure:volume\b/i.test(line)) continue

    // key:value
    const c = line.indexOf(':')
    if (c > 0) {
      const k = line.slice(0, c).trim()
      const v = line.slice(c + 1).trim()
      if (k && !(k in metrics)) order.push(k)
      if (k) metrics[k] = coerceNumber(v)
      continue
    }

    // key <tab/comma/spaces> value  (assume last token is value)
    const parts = splitByAny(line)
    if (parts.length >= 2) {
      const val = parts[parts.length - 1]
      const key = parts.slice(0, -1).join(' ')
      if (key && !(key in metrics)) order.push(key)
      if (key) metrics[key] = coerceNumber(val)
    }
  }

  return { metrics, order }
}

export default function App() {
  // Inputs
  const [subjectFiles, setSubjectFiles] = useState<SubjectMap>({})
  const [participantsParsed, setParticipantsParsed] = useState<ParsedTable | null>(null)
  const [idColumn, setIdColumn] = useState<string>('')

  // First column content (row label). Use {id} (as in participants) or {base} (ID without extension).
  const [rowLabelTemplate, setRowLabelTemplate] = useState<string>('{id}')
  // Optional: append covariates from participants after measurements
  const [mergeCovariates, setMergeCovariates] = useState<boolean>(false)

  // Live preview of the final data.csv (subjects as rows, measurements as columns)
  const [preview, setPreview] = useState<string[][]>([])
  const [warnings, setWarnings] = useState<string[]>([])

  const idCandidates = useMemo(() => participantsParsed?.meta.fields ?? [], [participantsParsed])

  async function handleSubjectsInput(files: FileList | null) {
    const map: SubjectMap = {}
    if (!files) {
      setSubjectFiles(map)
      return
    }
    for (const f of Array.from(files)) {
      const full = normalize(f.name)     // e.g., "sub-001.txt"
      const base = stripExt(full)        // "sub-001"
      // Index both so we can match participants IDs with or without ".txt"
      map[full] = f
      map[base] = f
    }
    setSubjectFiles(map)
  }

  async function handleParticipantsInput(file: File | null) {
    setParticipantsParsed(null)
    setIdColumn('')
    if (!file) return
    const text = await file.text()
    const delimiter = sniffDelimiterFromFilename(file.name)
    const result = Papa.parse(text, { header: true, delimiter, skipEmptyLines: true }) as any
    setParticipantsParsed(result)
    if (result?.meta?.fields?.length) setIdColumn(result.meta.fields[0])
  }

  function resolveFileForId(idRaw: string): File | undefined {
    const id = normalize(idRaw)
    const base = stripExt(id)
    const variants = [
      id,           // "sub-001.txt" if that's what's in participants
      base,         // "sub-001"
      base + '.txt' // "sub-001.txt"
    ]
    for (const k of variants) {
      if (subjectFiles[k]) return subjectFiles[k]
    }
    return undefined
  }

  function formatRowLabel(idRaw: string) {
    const id = normalize(idRaw)
    const base = stripExt(id)
    return rowLabelTemplate.replace(/\{id\}/g, id).replace(/\{base\}/g, base)
  }

  /** Build the matrix: subjects as rows, measurements as columns */
  async function buildMatrix() {
    setWarnings([])
    if (!participantsParsed || !idColumn) {
      alert('Please provide participants.tsv/covariates.csv and choose the ID column.')
      return { header: [] as string[], rows: [] as string[][] }
    }
    const pRows = (participantsParsed.data || []) as any[]
    const subjectsOrder = pRows.map(r => normalize(r[idColumn])).filter(Boolean)
    if (!subjectsOrder.length) {
      alert('No IDs found in the selected column.')
      return { header: [] as string[], rows: [] as string[][] }
    }

    // Parse files in participants order, collect canonical column order from the first subject encountered.
    const warningsLocal: string[] = []
    const parsedById: Record<string, ParsedSubject> = {}
    let canonicalOrder: string[] | undefined

    for (const sid of subjectsOrder) {
      const file = resolveFileForId(sid)
      if (!file) {
        warningsLocal.push(`Missing file for ID: ${sid}`)
        continue
      }
      const text = await file.text()
      const parsed = parseSubjectTxt(text)
      parsedById[sid] = parsed
      if (!canonicalOrder && parsed.order.length) {
        // Use the *line order* from the first parsed subject as the canonical measurement column order
        canonicalOrder = [...parsed.order]
      }
    }

    // Create full set of measurement columns: start with canonical order, then append unseen keys by discovery order
    const metricCols: string[] = canonicalOrder ? [...canonicalOrder] : []
    const seen = new Set(metricCols)
    for (const sid of subjectsOrder) {
      const p = parsedById[sid]
      if (!p) continue
      for (const k of p.order) {
        if (!seen.has(k)) {
          seen.add(k)
          metricCols.push(k)
        }
      }
      // Include any keys discovered (in case a subject had values with no order captured)
      for (const k of Object.keys(p.metrics)) {
        if (!seen.has(k)) {
          seen.add(k)
          metricCols.push(k)
        }
      }
    }

    // Optionally append covariate columns (all participants columns except the ID column)
    const covariateCols = (participantsParsed.meta.fields || []).filter(c => c !== idColumn)
    const header = ['subject', ...metricCols, ...(mergeCovariates ? covariateCols : [])]

    // Build subject rows
    const outRows: string[][] = []
    for (const sid of subjectsOrder) {
      const p = parsedById[sid]
      const metrics = p?.metrics || {}
      const row: (string | number)[] = []
      row.push(formatRowLabel(sid))
      for (const k of metricCols) {
        row.push(metrics[k] ?? '')
      }
      if (mergeCovariates) {
        const rec = pRows.find(r => normalize(r[idColumn]) === sid) || {}
        for (const c of covariateCols) row.push(rec[c] ?? '')
      }
      outRows.push(row.map(v => (v as any).toString()))
    }

    setWarnings(warningsLocal)
    return { header, rows: outRows }
  }

  // Preview (first ~5 rows)
  async function previewCSV() {
    const { header, rows } = await buildMatrix()
    if (!header.length) return
    const sample = [header, ...rows.slice(0, 5)]
    setPreview(sample)
  }

  async function downloadCSV() {
    const { header, rows } = await buildMatrix()
    if (!header.length) return
    const csv = Papa.unparse([header, ...rows])
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    saveAs(blob, 'data.csv')
    alert('data.csv generated.')
  }

  return (
    <div className="card">
      <h1>FreeSurfer ASEG to CSV Conversion Tool</h1>
      <p className="hint">
        Upload per-subject ASEG <span className="mono">.txt</span> files and a participants/covariates file.
        The resulting table will have <b>subjects as rows</b> and <b>measurements as columns</b> with the subject id in the first column.
      </p>

      <div className="grid">
        <div className="field">
          <label>participants.tsv / covariates.csv</label><br/>
          <input type="file" accept=".tsv,.csv" onChange={(e) => handleParticipantsInput(e.target.files?.[0] ?? null)} />
          {idCandidates.length ? (
            <div style={{ marginTop: '0.5rem' }}>
              <label>ID column</label><br/>
              <select value={idColumn} onChange={(e) => setIdColumn(e.target.value)}>
                {idCandidates.map((f: string) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
          ) : null}
        </div>

        <div className="field">
          <label>Subject ASEG files (.txt)</label><br/>
          <input type="file" multiple accept=".txt" onChange={(e) => handleSubjectsInput(e.target.files)} />
        </div>

        <div className="field">
          <label>Row label template</label><br/>
          <input
            type="text"
            value={rowLabelTemplate}
            onChange={(e) => setRowLabelTemplate(e.target.value)}
            placeholder="{id} or {base}/fs_7.3.2/{base}"
            size={32}
          />
          <p className="hint">
            Use <span className="mono">{'{id}'}</span> for the participants ID exactly as written
            (e.g., <span className="mono">sub-001.txt</span>) or <span className="mono">{'{base}'}</span> for the ID without extension (e.g., <span className="mono">sub-001</span>).
          </p>
        </div>

        <div className="field">
          <label>Append covariates</label><br/>
          <input
            type="checkbox"
            checked={mergeCovariates}
            onChange={(e) => setMergeCovariates(e.target.checked)}
          /> <span className="hint">Include participants columns after measurements</span>
        </div>
      </div>

      {warnings.length ? (
        <div className="warn" style={{ marginTop: '1rem' }}>
          <b>Warnings:</b>
          <ul>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      ) : null}

      {preview.length ? (
        <>
          <div className="divider" />
          <h3>Preview (first {Math.max(0, preview.length - 1)} rows)</h3>
          <div style={{ overflow: 'auto', maxHeight: 420 }}>
            <table>
              <thead>
                <tr>
                  {preview[0].map((h, i) => <th key={i}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {preview.slice(1).map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => <td key={j}>{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <div className="divider" />

      {subjectFiles && participantsParsed && <div className="row">
        <button onClick={previewCSV}>Preview data.csv</button>
        <button onClick={downloadCSV}>Download data.csv</button>
      </div>}

    </div>
  )
}
