// Only accept explicit text values, never search arbitrary JSON for the command.
export function parseRemote(raw) {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  let value;
  try { value = JSON.parse(text); } catch {
    if (/^[<{[]/.test(text)) throw new Error('La API no devuelve texto ni JSON reconocido.');
    return text;
  }
  if (typeof value === 'string') return value.trim();
  if (value === null) return '';
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.error || value.success === false) throw new Error('La API ha devuelto un error.');
    for (const key of ['data', 'text', 'content']) {
      if (typeof value[key] === 'string') return value[key].trim();
      if (value[key] === null) return '';
    }
  }
  throw new Error('Formato de getdata.php no reconocido; revisa su respuesta.');
}
export const isCommand = text => text.trim().toUpperCase() === 'WIKISTOP';
export class CommandGate {
  constructor(consumed = false) { this.consumed = consumed; }
  observe(text) {
    if (!isCommand(text)) { this.consumed = false; return false; }
    if (this.consumed) return false;
    this.consumed = true;
    return true;
  }
}
export function beforeStop(text, phrase) {
  const tokens = value => [...value.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({
    word: m[0].normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(), index: m.index
  }));
  const source = tokens(text), target = tokens(phrase);
  if (!target.length) return null;
  for (let i = 0; i <= source.length - target.length; i++) {
    if (target.every((t, j) => source[i + j].word === t.word)) return text.slice(0, source[i].index).trim();
  }
  return null;
}
export function apiURL(path, user, data) {
  const url = new URL(path, 'https://appmaz.vip');
  url.searchParams.set('user', user);
  if (data !== undefined) url.searchParams.set('data', data);
  else url.searchParams.set('_', Date.now().toString());
  return url;
}
export function extractAnswer(data) {
  if (data.status && data.status !== 'completed') throw new Error('El modelo no terminó la respuesta.');
  const answer = typeof data.output_text === 'string' ? data.output_text :
    (data.output || []).flatMap(item => item.content || []).filter(c => c.type === 'output_text').map(c => c.text || '').join('');
  if (!answer.trim()) throw new Error('El modelo no devolvió una respuesta de texto.');
  return answer.trim();
}
