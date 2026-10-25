/** SQLite stores UTC without an offset; PostgreSQL returns an explicit offset. */
export function normalizeLogTimestamp(value: string): string {
  const normalized = value.replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
}
