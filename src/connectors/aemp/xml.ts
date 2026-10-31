/**
 * A small XML reader for ISO 15143-3 (AEMP 2.0) responses (docs/contracts-1f.md part B: "parse XML
 * with a small hand-written reader over the fixed element set"; no new dependency). It reads the
 * subset of XML 1.0 the standard's documents use: a prolog, comments, CDATA, elements with
 * attributes, character and the five predefined entity references. It never fetches or expands
 * anything else: a DOCTYPE is refused (no external entities, no entity expansion).
 *
 * `xmlToObject()` turns the document into plain JSON-like values the AEMP schemas read the same
 * way as a JSON provider's body:
 *  - an element with only text → its text (trimmed; numbers stay strings: the schemas coerce),
 *  - an element with attributes or children → an object: attributes as keys (`datetime`,
 *    `version`, `snapshotTime`), children as keys, a repeated child as an array,
 *  - namespace prefixes are dropped (`iso:Fleet` → `Fleet`), `xmlns` attributes skipped,
 *  - the root element is wrapped: `{ Fleet: { … } }`, like Samsara's JSON.
 * Pure; no Node-only imports.
 */

export class AempXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AempXmlError';
  }
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** Largest document read (an AEMP page holds 100 machines: well under a megabyte). */
export const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return codePoint(Number.parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith('#')) return codePoint(Number.parseInt(ref.slice(1), 10), whole);
    const named = ENTITIES[ref];
    if (named === undefined) throw new AempXmlError(`unknown entity &${ref};`);
    return named;
  });
}

function codePoint(n: number, whole: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff)
    throw new AempXmlError(`bad reference ${whole}`);
  return String.fromCodePoint(n);
}

/** `iso:Fleet` → `Fleet`. */
const localName = (qname: string) => qname.slice(qname.indexOf(':') + 1);

const NAME_RE = /^[A-Za-z_][\w.:-]*/;

/** Parse an XML document into its root element. Throws AempXmlError on malformed input. */
export function parseXml(input: string): XmlElement {
  if (input.length > MAX_XML_BYTES) throw new AempXmlError('document too large');
  let i = input.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const fail = (msg: string): never => {
    throw new AempXmlError(`${msg} at offset ${i}`);
  };

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    const textEnd = lt === -1 ? input.length : lt;
    if (textEnd > i) {
      const text = input.slice(i, textEnd);
      const top = stack[stack.length - 1];
      if (top) top.text += decodeEntities(text);
      else if (text.trim()) fail('text outside the root element');
      i = textEnd;
      continue;
    }
    // At '<'.
    if (input.startsWith('<?', i)) {
      const end = input.indexOf('?>', i + 2);
      if (end === -1) fail('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      if (end === -1) fail('unterminated comment');
      i = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i + 9);
      if (end === -1) fail('unterminated CDATA section');
      const top = stack[stack.length - 1];
      if (!top) fail('CDATA outside the root element');
      (top as XmlElement).text += input.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (input.startsWith('<!', i)) fail('DOCTYPE and other declarations are not accepted');
    if (input.startsWith('</', i)) {
      const end = input.indexOf('>', i + 2);
      if (end === -1) fail('unterminated end tag');
      const name = input.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || localName(name) !== open.name) {
        fail(`end tag </${name}> does not match <${open?.name ?? '(none)'}>`);
      }
      i = end + 1;
      continue;
    }
    // Start tag.
    i += 1;
    const m = NAME_RE.exec(input.slice(i, i + 256));
    if (!m) fail('bad element name');
    const qname = (m as RegExpExecArray)[0];
    i += qname.length;
    const el: XmlElement = { name: localName(qname), attrs: {}, children: [], text: '' };
    let selfClosing = false;
    for (;;) {
      while (i < input.length && /\s/.test(input[i] as string)) i++;
      if (i >= input.length) fail('unterminated start tag');
      if (input.startsWith('/>', i)) {
        selfClosing = true;
        i += 2;
        break;
      }
      if (input[i] === '>') {
        i += 1;
        break;
      }
      const a = NAME_RE.exec(input.slice(i, i + 256));
      if (!a) fail('bad attribute name');
      const aname = (a as RegExpExecArray)[0];
      i += aname.length;
      while (/\s/.test(input[i] ?? '')) i++;
      if (input[i] !== '=') fail(`attribute ${aname} has no value`);
      i++;
      while (/\s/.test(input[i] ?? '')) i++;
      const quote = input[i];
      if (quote !== '"' && quote !== "'") fail(`attribute ${aname} is not quoted`);
      const close = input.indexOf(quote as string, i + 1);
      if (close === -1) fail(`unterminated attribute ${aname}`);
      const value = decodeEntities(input.slice(i + 1, close));
      i = close + 1;
      if (aname === 'xmlns' || aname.startsWith('xmlns:')) continue;
      el.attrs[localName(aname)] = value;
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) fail('more than one root element');
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) fail('document nested too deeply');
      stack.push(el);
    }
  }
  if (stack.length) throw new AempXmlError(`unclosed element <${stack[stack.length - 1]?.name}>`);
  if (!root) throw new AempXmlError('no root element');
  return root;
}

/** One element as a JSON-like value (see the file header). */
export function elementToValue(el: XmlElement): unknown {
  const keys = Object.keys(el.attrs);
  if (!el.children.length && !keys.length) return el.text.trim();
  const out: Record<string, unknown> = { ...el.attrs };
  for (const child of el.children) {
    const v = elementToValue(child);
    // elementToValue never returns an array, so an array here is a repeated child we built.
    const prev = out[child.name];
    if (prev === undefined) out[child.name] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else out[child.name] = [prev, v];
  }
  if (!el.children.length && el.text.trim()) out['#text'] = el.text.trim();
  return out;
}

/** The whole document as `{ <root name>: value }`. */
export function xmlToObject(input: string): Record<string, unknown> {
  const root = parseXml(input);
  return { [root.name]: elementToValue(root) };
}
