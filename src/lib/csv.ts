// Shared CSV export utility for System Console tool dashboards
// (Security Monitor and five later phases). Deliberately generic —
// plain array of flat objects in, browser download out — so every
// call site just shapes its own rows and calls downloadCsv(); no
// per-tool CSV logic should be duplicated elsewhere.

/** Escapes one CSV field: wraps in double quotes (and doubles any
 * internal quotes) whenever the value contains a comma, a double
 * quote, or a newline — the minimum RFC 4180 requires. Anything else
 * is left unquoted. */
function escapeCsvField(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Builds a CSV string from an array of flat objects (header row from
 * the keys of the first row, then one row per object) and triggers a
 * browser download of it as `filename`. No-ops when `rows` is empty —
 * there's no header to derive and nothing worth downloading.
 */
export function downloadCsv(filename: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return;

  const headers = Object.keys(rows[0]);
  const lines = [
    headers.map(escapeCsvField).join(","),
    ...rows.map((row) => headers.map((key) => escapeCsvField(row[key])).join(",")),
  ];
  const csv = lines.join("\r\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
