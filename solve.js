// solve.js — a faster drop-in for makefun-site 1.0.0.
//
// Same answers as makefun-site 1.0.0 on every input, byte for byte, at a
// fraction of the CPU time. ES module, dependency-free, no clock, no
// randomness, no environment, no cache kept from one case to the next.
//
// Where the time goes (and what this file does about it):
//  - Markdown lexing ran a dozen regexes per line: this lexer classifies a
//    line by its first character and renders each block in the same pass
//    that lexes it, producing html, toc, excerpt and the word count once.
//  - Inline rendering sliced and re-scanned strings per strong/em/link:
//    this one scans once with index bounds into the original string and
//    batches plain runs into the output buffer.
//  - slugify paid NFKD + a unicode property regex per title/heading/tag:
//    slugs are cached per case and pure-ASCII text skips NFKD entirely
//    (NFKD is the identity on ASCII, and ASCII holds no combining marks).
//  - Templates were re-rendered per page from a scope chain: an include
//    whose free variables resolve to the same values renders the same
//    string, so such renders are memoised per case (keyed on the resolved
//    values, plus the include depth) — the header/footer/nav/card renders
//    shared by every page are computed once. A card is also computed once
//    per post and reused by its page, instead of being built twice.
//  - Front matter is parsed by hand (no regex per line); dates, slugs and
//    tag lists are validated character by character, with the exact same
//    error strings as the reference.
//  - Sorts that only need code-unit order use the default string sort
//    (already code-unit order) instead of a comparator closure.

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

// ------------------------------------------------------------------ text

/** The HTML escape table. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;
const COMBINING = /\p{M}/gu;

/**
 * The slug of `text`, exactly as the reference: NFKD, combining marks
 * dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the
 * cut dropped), and "untitled" when nothing is left.
 */
function slugify(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is JavaScript whitespace (\s). */
function isWS(code) {
  if (code < 128) return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `raw` is a YYYY-MM-DD date from 1970-01-01 to 2099-12-31. */
function fmDateOk(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const cc = raw.charCodeAt(i);
    if (cc < 48 || cc > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysIn(y, mo);
}

/** Whether `raw` is a template name: [a-z0-9-]+, non-empty. */
function fmNameOk(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const cc = raw.charCodeAt(i);
    if (!((cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45)) return false;
  }
  return true;
}

/** Whether `raw` is a slug: [a-z0-9]+(-[a-z0-9]+)*, at most 64 chars. */
function fmSlugOk(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let i = 0;
  for (;;) {
    const cc = raw.charCodeAt(i);
    if (!((cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57))) return false;
    i++;
    while (i < raw.length) {
      const c2 = raw.charCodeAt(i);
      if ((c2 >= 97 && c2 <= 122) || (c2 >= 48 && c2 <= 57)) {
        i++;
        continue;
      }
      break;
    }
    if (i === raw.length) return true;
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
    if (i === raw.length) return false;
  }
}

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return fmDateOk(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const cc = t.charCodeAt(j);
          if (cc === 34 || cc === 91 || cc === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return fmNameOk(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return fmSlugOk(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const firstNL = text.indexOf('\n');
  const firstLine = firstNL === -1 ? text : text.slice(0, firstNL);
  if (firstLine !== '---') return { error: 'no front matter' };
  let lineStart = firstNL + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - lineStart === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      closeStart = lineStart;
      closeEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = firstNL + 1;
  let lineNo = 2;
  while (pos < closeStart) {
    const nl = text.indexOf('\n', pos);
    const le = nl === -1 ? closeStart : nl;
    const line = text.slice(pos, le);
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const cc = line.charCodeAt(k);
      if (cc !== 32 && cc !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      let k = 0;
      while (k < line.length) {
        const cc = line.charCodeAt(k);
        if ((cc >= 97 && cc <= 122) || cc === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      let rEnd = raw.length;
      while (rEnd > 0) {
        const cc = raw.charCodeAt(rEnd - 1);
        if (cc === 32 || cc === 9) rEnd--;
        else break;
      }
      raw = raw.slice(0, rEnd);
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = le + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** The characters that end a plain inline run: \ ` * [ & < > " '. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/** The next index from `i` holding a special inline character, or `hi`. */
function nextSpecial(s, i, hi) {
  SPECIAL_RE.lastIndex = i;
  const m = SPECIAL_RE.exec(s);
  if (m === null || m.index >= hi) return hi;
  return m.index;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether a line holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const cc = line.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A fence's language when `line` opens one, else null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const cc = line.charCodeAt(j);
    const ok = (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 95 || cc === 43 || cc === 45;
    if (!ok) break;
    j++;
  }
  for (; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  const cc = line.charCodeAt(n);
  if (cc !== 32 && cc !== 9) return null;
  let b = line.length;
  while (b > n + 1 && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  const text = line.slice(n + 1, b);
  if (text === '') return null;
  return { depth: n, text };
}

/** Whether `line` is a thematic break (--- or *** plus spaces/tabs). */
function isHR(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const cc = line.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet item's text when `line` opens one, else null. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's number and text when `line` opens one, else null. */
function orderedOf(line) {
  let j = 0;
  while (j < 9) {
    const cc = line.charCodeAt(j);
    if (cc < 48 || cc > 57) break;
    j++;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { num: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item (two spaces, then non-space). */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= line.length) return false;
  return !isWS(line.charCodeAt(j));
}

/** Whether `line` ends a paragraph: blank, fence, heading or break. */
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j <= hi - wlen; j++) {
    if (s[j] === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s[lo..hi)` rendered inline into `parts`; `env.link(target)` is a link's href. */
function inlineInto(s, env, lo, hi, parts) {
  let i = lo;
  while (i < hi) {
    // A plain run has no character needing any treatment: copy it whole.
    // (The shared regex is always re-aimed with lastIndex before each
    // exec, so the recursion through here stays correct.)
    const j = nextSpecial(s, i, hi);
    if (j > i) {
      parts.push(s.slice(i, j));
      i = j;
    }
    if (i >= hi) break;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < hi && ESCAPABLE.has(s[i + 1])) {
        parts.push(escapeHtml(s[i + 1]));
        i += 2;
      } else {
        parts.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k < hi && k > i + 1) {
        parts.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2, hi);
        if (k > i + 2) {
          parts.push('<strong>');
          inlineInto(s, env, i + 2, k, parts);
          parts.push('</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1, hi);
      if (k > i + 1) {
        parts.push('<em>');
        inlineInto(s, env, i + 1, k, parts);
        parts.push('</em>');
        i = k + 1;
      } else {
        parts.push('*');
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = -1;
      if (k !== -1 && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m >= hi) m = -1;
      }
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        parts.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, env, i + 1, k, parts);
        parts.push('</a>');
        i = m + 1;
      } else {
        parts.push('[');
        i++;
      }
      continue;
    }
    parts.push(ESCAPES[c]);
    i++;
  }
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const parts = [];
  inlineInto(s, env, 0, s.length, parts);
  return parts.join('');
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (every level
 * 2 and 3 heading), its excerpt (the first paragraph's inline HTML) and
 * its word count. `slugCache` is the case's slugify cache.
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const words = countWords(src);
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const parts = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      parts.push('<pre><code', lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`, '>');
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      parts.push('</code></pre>\n');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      let slug = slugCache.get(hd.text);
      if (slug === undefined) {
        slug = slugify(hd.text);
        slugCache.set(hd.text, slug);
      }
      const id = uniqueSlug(slug, ids);
      const html = inlineStr(hd.text, env);
      parts.push('<h', String(hd.depth), ' id="', id, '">', html, '</h', String(hd.depth), '>\n');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else parts.push('<blockquote>\n<p>', inlineStr(kept.join('\n'), env), '</p>\n</blockquote>\n');
      continue;
    }
    const b = bulletOf(line);
    const o = b === null ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const start = isOrdered ? o.num : 1;
      const items = [];
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(l);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const item of items) parts.push('<li>', inlineStr(item.join('\n'), env), '</li>\n');
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The free names a template reads: every first path segment it (and the
 * templates it includes, in the same scope) looks up that no `for` of its
 * own binds. A template's render is a pure function of these names' values
 * (plus its include depth), so an include can be memoised on them.
 */
function collectDeps(nodes, templates, bound, deps, seen) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) deps.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) deps.add(n.path[0]);
      collectDeps(n.then, templates, bound, deps, seen);
      if (n.else !== null) collectDeps(n.else, templates, bound, deps, seen);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) deps.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      collectDeps(n.body, templates, b2, deps, seen);
    } else if (n.kind === 'include') {
      if (seen.has(n.name)) continue;
      const t = templates.get(n.name);
      if (t === undefined) continue;
      seen.add(n.name);
      collectDeps(t, templates, bound, deps, seen);
      seen.delete(n.name);
    }
  }
}

/** Names whose values are stable across a case's renders (so memoising on them pays). */
const MEMO_NAMES = new Set(['site', 'tags', 'recent', 'p', 't', 'h']);

const UNDEF = Object.freeze({});

function memoGet(root, keys) {
  let m = root;
  for (const k of keys) {
    m = m.get(k);
    if (m === undefined) return undefined;
  }
  return m;
}

function memoSet(root, keys, value) {
  let m = root;
  for (let i = 0; i < keys.length - 1; i++) {
    let nx = m.get(keys[i]);
    if (nx === undefined) {
      nx = new Map();
      m.set(keys[i], nx);
    }
    m = nx;
  }
  m.set(keys[keys.length - 1], value);
}

/**
 * `nodes` rendered into `parts` in `scope` ({ vars, parent }). `ctx` holds
 * the parsed templates, their dependency info and the case's memo cache.
 */
function renderNodes(nodes, scope, ctx, depth, parts) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const info = ctx.info.get(n.name);
        if (info === undefined || !info.memoizable) {
          renderNodes(t, scope, ctx, depth + 1, parts);
          break;
        }
        const keys = [n.name, depth + 1];
        for (const d of info.deps) {
          const v = lookup(scope, [d]);
          keys.push(v === undefined ? UNDEF : v);
        }
        const hit = memoGet(ctx.memo, keys);
        if (hit !== undefined) {
          parts.push(hit);
          break;
        }
        const sub = [];
        renderNodes(t, scope, ctx, depth + 1, sub);
        const s = sub.join('');
        memoSet(ctx.memo, keys, s);
        parts.push(s);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------- build

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Whether `target` carries a URI scheme. */
function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let j = 1; j < target.length; j++) {
    const cc = target.charCodeAt(j);
    if (cc === 58) return true;
    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 43 || cc === 45 || cc === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort()) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const info = new Map();
  for (const [name, nodes] of templates) {
    const deps = new Set();
    collectDeps(nodes, templates, new Set(), deps, new Set());
    const depList = [...deps].sort();
    info.set(name, { deps: depList, memoizable: depList.every((d) => MEMO_NAMES.has(d)) });
  }
  const ctx = { templates, info, memo: new Map() };
  const slugCache = new Map();
  const slugifyCached = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugify(text);
      slugCache.set(text, s);
    }
    return s;
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is
  // not .md is static.
  const files = [...input.files].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and
  // dropped, and so is a draft.
  const kept = [];
  const broken = new Set();
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugifyCached(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static
  // files they name. html, toc, excerpt and the word count come out of a
  // single pass over the body.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and
  // older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => (y.data.date < x.data.date ? -1 : y.data.date > x.data.date ? 1 : x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugifyCached(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugifyCached(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugifyCached(name);
      const t = bySlug.get(slug);
      return t === undefined ? { name, slug, url: '', posts: [] } : t;
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0));

  // A post's card, as lists show it — computed once per post.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));

  /** A page as its layout reads it (its card, computed once, plus the page's own fields). */
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const parts = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
