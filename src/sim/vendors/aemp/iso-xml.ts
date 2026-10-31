/**
 * ISO 15143-3 XML for the stand-ins (the AEMP providers that answer XML, and CNH FieldOps'
 * ISO-style telemetry, ../cnh). Element names and attributes as in ISO's edition-1 XSDs
 * (standards.iso.org/iso/15143/-3/ed-1: common.xsd, Locations.xsd, FaultCode.xsd,
 * CautionCode.xsd), the default namespace on the root. Pure string building.
 */

export const ISO_15143_3_NS = 'http://standards.iso.org/iso/15143/-3';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;',
  );

/** A node: an element with attributes and children, or a text leaf. */
export interface XmlNode {
  name: string;
  attrs?: Record<string, string | undefined>;
  /** Text content (a leaf) or children. */
  value?: string | number | boolean | XmlNode[];
}

/** `el('Hour', 412.5)`, `el('Location', [el('Latitude', 41.9)], { datetime })`. */
export function el(
  name: string,
  value?: XmlNode['value'],
  attrs?: Record<string, string | undefined>,
): XmlNode {
  return { name, value, attrs };
}

function render(n: XmlNode, indent: string): string {
  const attrs = Object.entries(n.attrs ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');
  if (n.value === undefined || (Array.isArray(n.value) && !n.value.length)) {
    return `${indent}<${n.name}${attrs}/>`;
  }
  if (!Array.isArray(n.value)) {
    return `${indent}<${n.name}${attrs}>${esc(String(n.value))}</${n.name}>`;
  }
  const inner = n.value.map((c) => render(c, `${indent}  `)).join('\n');
  return `${indent}<${n.name}${attrs}>\n${inner}\n${indent}</${n.name}>`;
}

/** A whole document: the XML declaration and `root` in the ISO 15143-3 namespace. */
export function isoXmlDocument(root: XmlNode): string {
  const withNs: XmlNode = { ...root, attrs: { xmlns: ISO_15143_3_NS, ...root.attrs } };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(withNs, '')}\n`;
}

/** `Links` elements as the XSD repeats them: `<Links><rel/><href/></Links>`. */
export function isoLinks(links: readonly { rel: string; href: string }[]): XmlNode[] {
  return links.map((l) => el('Links', [el('rel', l.rel), el('href', l.href)]));
}
