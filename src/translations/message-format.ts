import { FALLBACK_LOCALE, normalizeLocale } from './locales.js';
import { PluralCategory, pluralCategory } from './plural-rules.js';

/**
 * Sous-ensemble d'ICU MessageFormat (port de `message_format.dart`) : `{nom}`, `{1}`, `number`, `plural`
 * (catégories CLDR, `=N`, `offset:`, `#`), `select`. Apostrophes comme en ICU.
 */
export class MessageFormatError extends Error {}

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_FORMATTED_LENGTH = 8000;
const MAX_DEPTH = 3;
const CATEGORIES: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'] satisfies PluralCategory[];

type Node =
  | { k: 'text'; text: string }
  | { k: 'pound' }
  | { k: 'arg'; name: string; raw: string }
  | { k: 'number'; name: string; raw: string }
  | { k: 'plural'; name: string; offset: number; branches: Branch[]; raw: string }
  | { k: 'select'; name: string; branches: Branch[]; raw: string };

interface Branch {
  selector: string;
  body: Node[];
}

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  parseNodes(depth: number, inPlural: boolean, topLevel = false): Node[] {
    if (depth > MAX_DEPTH) throw new MessageFormatError('Too many nested plural/select blocks.');
    const nodes: Node[] = [];
    let text = '';
    const flush = (): void => {
      if (text) {
        nodes.push({ k: 'text', text });
        text = '';
      }
    };
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === '}') {
        if (topLevel) throw new MessageFormatError('Unexpected }.');
        break;
      }
      if (c === "'") {
        const next = s[this.i + 1];
        if (next === "'") {
          text += "'";
          this.i += 2;
          continue;
        }
        if (next === '{' || next === '}' || (inPlural && next === '#')) {
          this.i++;
          while (this.i < s.length) {
            if (s[this.i] === "'") {
              if (s[this.i + 1] === "'") {
                text += "'";
                this.i += 2;
                continue;
              }
              this.i++;
              break;
            }
            text += s[this.i];
            this.i++;
          }
          continue;
        }
        text += "'";
        this.i++;
        continue;
      }
      if (c === '#' && inPlural) {
        flush();
        nodes.push({ k: 'pound' });
        this.i++;
        continue;
      }
      if (c === '{') {
        flush();
        nodes.push(this.parseArgument(depth, inPlural));
        continue;
      }
      text += c;
      this.i++;
    }
    flush();
    return nodes;
  }

  private parseArgument(depth: number, outerPlural: boolean): Node {
    const start = this.i;
    this.i++;
    const name = this.identifier();
    if (!name) throw new MessageFormatError('Argument name expected.');
    this.skipSpaces();
    if (this.i >= this.s.length) throw new MessageFormatError('Missing }.');
    if (this.s[this.i] === '}') {
      this.i++;
      return { k: 'arg', name, raw: this.s.slice(start, this.i) };
    }
    if (this.s[this.i] !== ',') throw new MessageFormatError('Expected , or }.');
    this.i++;
    this.skipSpaces();
    const type = this.identifier();
    this.skipSpaces();
    switch (type) {
      case 'number': {
        if (this.s[this.i] === ',') {
          this.i++;
          this.identifier();
          this.skipSpaces();
        }
        this.expect('}');
        return { k: 'number', name, raw: this.s.slice(start, this.i) };
      }
      case 'plural': {
        this.expect(',');
        let offset = 0;
        this.skipSpaces();
        if (this.s.startsWith('offset:', this.i)) {
          this.i += 7;
          this.skipSpaces();
          const m = /^\d+/.exec(this.s.slice(this.i));
          if (!m) throw new MessageFormatError('Offset expected.');
          offset = Number(m[0]);
          this.i += m[0].length;
        }
        const branches = this.branches(depth, true, true);
        requireOther(branches);
        return { k: 'plural', name, offset, branches, raw: this.s.slice(start, this.i) };
      }
      case 'select': {
        this.expect(',');
        const branches = this.branches(depth, outerPlural, false);
        requireOther(branches);
        return { k: 'select', name, branches, raw: this.s.slice(start, this.i) };
      }
      default:
        throw new MessageFormatError(`Unknown argument type "${type}".`);
    }
  }

  private branches(depth: number, inPlural: boolean, plural: boolean): Branch[] {
    const out: Branch[] = [];
    for (;;) {
      this.skipSpaces();
      if (this.i >= this.s.length) throw new MessageFormatError('Missing }.');
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const m = /^(=\d+(?:\.\d+)?|[A-Za-z0-9_-]+)/.exec(this.s.slice(this.i));
      if (!m) throw new MessageFormatError('Branch selector expected.');
      const selector = m[1]!;
      this.i += selector.length;
      if (plural && !selector.startsWith('=') && !CATEGORIES.includes(selector)) {
        throw new MessageFormatError(`Unknown plural category "${selector}".`);
      }
      this.skipSpaces();
      this.expect('{');
      const body = this.parseNodes(depth + 1, inPlural);
      this.expect('}');
      out.push({ selector, body });
    }
  }

  private identifier(): string {
    const m = /^[A-Za-z0-9_]+/.exec(this.s.slice(this.i));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  }

  private skipSpaces(): void {
    while (this.i < this.s.length && ' \n\t\r'.includes(this.s[this.i]!)) this.i++;
  }

  private expect(c: string): void {
    this.skipSpaces();
    if (this.s[this.i] !== c) throw new MessageFormatError(`Expected ${c}.`);
    this.i++;
  }
}

function requireOther(branches: Branch[]): void {
  if (!branches.some((b) => b.selector === 'other')) {
    throw new MessageFormatError('The "other" branch is required.');
  }
}

function str(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) return String(v);
  return String(v);
}

function sameNumber(a: string, b: string): boolean {
  const x = Number(a.trim());
  const y = Number(b.trim());
  return a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y) && x === y;
}

function shift(text: string, offset: number): string {
  if (offset === 0) return text;
  const n = Number(text.trim());
  if (!Number.isFinite(n) || text.trim() === '') return text;
  return String(n - offset);
}

function separators(lang: string): [string, string] {
  switch (lang) {
    case 'fr':
      return [' ', ','];
    case 'ru': case 'uk': case 'pl': case 'cs': case 'bg': case 'fi': case 'sv': case 'no': case 'hu': case 'lt': case 'hr':
      return [' ', ','];
    case 'de': case 'es': case 'it': case 'pt': case 'tr': case 'nl': case 'id': case 'da': case 'el': case 'ro': case 'vi':
      return ['.', ','];
    default:
      return [',', '.'];
  }
}

/** Sépare les milliers et applique le séparateur décimal de la langue. */
export function formatNumber(locale: string, text: string): string {
  const m = /^\s*(-?)(\d{1,30})(?:\.(\d+))?\s*$/.exec(text);
  if (!m) return text;
  const lang = (normalizeLocale(locale) ?? FALLBACK_LOCALE).split('-')[0]!;
  const [group, decimal] = separators(lang);
  const digits = m[2]!;
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += group;
    out += digits[i];
  }
  return `${m[1]}${out}${m[3] === undefined ? '' : decimal + m[3]}`;
}

export class ParsedMessage {
  private constructor(private readonly nodes: Node[]) {}

  static parse(source: string): ParsedMessage {
    if (source.length > MAX_MESSAGE_LENGTH) {
      throw new MessageFormatError(`Text longer than ${MAX_MESSAGE_LENGTH} characters.`);
    }
    return new ParsedMessage(new Parser(source).parseNodes(0, false, true));
  }

  /** Noms des arguments utilisés (positionnels inclus : `1`, `2`…). */
  argumentNames(): Set<string> {
    const out = new Set<string>();
    const walk = (nodes: Node[]): void => {
      for (const n of nodes) {
        if (n.k === 'arg' || n.k === 'number') out.add(n.name);
        else if (n.k === 'plural' || n.k === 'select') {
          out.add(n.name);
          for (const b of n.branches) walk(b.body);
        }
      }
    };
    walk(this.nodes);
    return out;
  }

  format(locale: string, args: Record<string, unknown>, missing?: string[]): string {
    let out = '';
    const write = (nodes: Node[], pound: string | null): void => {
      for (const n of nodes) {
        switch (n.k) {
          case 'text':
            out += n.text;
            break;
          case 'pound':
            out += pound ?? '#';
            break;
          case 'arg': {
            const v = args[n.name];
            if (v === undefined || v === null) {
              missing?.push(n.name);
              out += n.raw;
            } else out += str(v);
            break;
          }
          case 'number': {
            const v = args[n.name];
            if (v === undefined || v === null) {
              missing?.push(n.name);
              out += n.raw;
            } else out += formatNumber(locale, str(v));
            break;
          }
          case 'plural': {
            const v = args[n.name];
            if (v === undefined || v === null) {
              missing?.push(n.name);
              out += n.raw;
              break;
            }
            const text = str(v);
            const shifted = shift(text, n.offset);
            let chosen = n.branches.find((b) => b.selector.startsWith('=') && sameNumber(b.selector.slice(1), text));
            if (!chosen) {
              const cat = pluralCategory(locale, shifted);
              chosen = [...n.branches].reverse().find((b) => b.selector === cat);
              chosen ??= n.branches.find((b) => b.selector === 'other');
            }
            if (chosen) write(chosen.body, formatNumber(locale, shifted));
            break;
          }
          case 'select': {
            const v = args[n.name];
            if (v === undefined || v === null) {
              missing?.push(n.name);
              out += n.raw;
              break;
            }
            const text = str(v);
            const chosen = [...n.branches].reverse().find((b) => b.selector === text) ?? n.branches.find((b) => b.selector === 'other');
            if (chosen) write(chosen.body, pound);
            break;
          }
        }
      }
    };
    write(this.nodes, null);
    return out.length > MAX_FORMATTED_LENGTH ? out.slice(0, MAX_FORMATTED_LENGTH) : out;
  }
}
