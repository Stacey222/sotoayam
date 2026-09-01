import { AppError } from "../errors.js";

export const CSV_MAX_BYTES = 256 * 1024;
export const CSV_MAX_ROWS = 500;
export const CSV_HEADERS = ["title", "owner_division", "description", "priority", "assignee", "deadline", "external_reference"] as const;

export type CsvTaskRow = Record<typeof CSV_HEADERS[number], string>;

export function parseTaskCsv(input: string): CsvTaskRow[] {
  if (Buffer.byteLength(input, "utf8") > CSV_MAX_BYTES) throw new AppError(413, "CSV_FILE_TOO_LARGE", "CSV exceeds the 256 KiB limit");
  if (input.includes("\u0000") || input.includes("\ufffd")) throw new AppError(400, "CSV_INVALID_ENCODING", "CSV must be valid UTF-8 text");
  const records = parseRecords(input.replace(/^\ufeff/, ""));
  if (records.length === 0) throw new AppError(400, "CSV_EMPTY", "CSV requires a header row");
  const headers = records[0]!.map((value) => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new AppError(400, "CSV_DUPLICATE_HEADER", "CSV contains duplicate headers");
  const allowed = new Set<string>(CSV_HEADERS);
  if (headers.some((header) => !allowed.has(header))) throw new AppError(400, "CSV_UNEXPECTED_COLUMN", "CSV contains an unexpected column");
  for (const required of ["title", "owner_division"]) {
    if (!headers.includes(required)) throw new AppError(400, "CSV_MISSING_HEADER", `CSV requires the ${required} header`);
  }
  const data = records.slice(1).filter((record) => record.some((value) => value.trim() !== ""));
  if (data.length > CSV_MAX_ROWS) throw new AppError(413, "CSV_ROW_LIMIT_EXCEEDED", "CSV exceeds the 500-row limit");
  return data.map((record) => {
    if (record.length > headers.length) throw new AppError(400, "CSV_MALFORMED", "CSV row has too many fields");
    const row = Object.fromEntries(CSV_HEADERS.map((header) => [header, ""])) as CsvTaskRow;
    headers.forEach((header, index) => { row[header as keyof CsvTaskRow] = record[index]?.trim() ?? ""; });
    return row;
  });
}

function parseRecords(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false; let afterQuote = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (afterQuote) {
      if (char === ",") { row.push(field); field = ""; afterQuote = false; }
      else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; afterQuote = false; }
      else if (char === "\r" && input[i + 1] === "\n") { /* handled by the following newline */ }
      else throw new AppError(400, "CSV_MALFORMED", "CSV has characters after a closing quote");
    } else if (char === '"') {
      if (field !== "") throw new AppError(400, "CSV_MALFORMED", "CSV quoting is malformed");
      quoted = true;
    } else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) throw new AppError(400, "CSV_MALFORMED", "CSV contains an unterminated quoted field");
  if (field !== "" || row.length > 0) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}
