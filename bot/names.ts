const LATIN_TO_CYRILLIC: Record<string, string> = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

export function foldName(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXYabcehkmoptxy]/g, (ch) => LATIN_TO_CYRILLIC[ch] || ch)
    .toLowerCase();
}

export function compactName(raw: string): string {
  return foldName(raw).replace(/[^a-zа-я0-9]/gi, '');
}

export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const clean = foldName(query);
  if (!clean) return true;
  const hay = fields.map((f) => foldName(f || '')).join(' ');
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.every((t) => hay.includes(t))) return true;
  const compactHay = fields.map((f) => compactName(f || '')).join('');
  const compactQuery = compactName(query);
  return Boolean(compactQuery) && compactHay.includes(compactQuery);
}
