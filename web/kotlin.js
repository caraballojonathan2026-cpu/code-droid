/*
 * kotlin.js — dependency-free Kotlin/XML/Gradle syntax highlighter (~4KB).
 * Single-pass tokenizer: emits HTML with span classes (tok-kw, tok-str, ...).
 * Fast enough for files of many thousands of lines.
 */
'use strict';

(function (global) {
  const KEYWORDS = new Set(('package import fun val var class object interface when if else for while do return break continue ' +
    'override private public protected internal data companion suspend init this super null true false is in as try catch finally ' +
    'throw by lazy lateinit vararg out infix inline crossinline noinline reified sealed enum annotation constructor abstract open ' +
    'typealias operator const external inner tailrec final get set field it where actual expect typeof').split(' '));

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Master regex — alternatives are tried in order; comments & strings first so they win.
  const MASTER = new RegExp([
    /(\/\/[^\n]*)/.source,                                   // 1 line comment
    /(\/\*[\s\S]*?(?:\*\/|$))/.source,                       // 2 block comment
    /("""[\s\S]*?(?:"""|$))/.source,                         // 3 raw string
    /("(?:\\.|[^"\\\n])*")/.source,                          // 4 string
    /('(?:\\.|[^'\\\n])+')/.source,                          // 5 char
    /(@\s*[A-Za-z_][\w.]*)/.source,                          // 6 annotation
    /\b(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFLuU]*)\b/.source, // 7 number
    /\b([A-Za-z_][\w]*)\b/.source,                           // 8 identifier (kw/typ/fun/plain)
    /(\s+|.)/.source,                                        // 9 anything else
  ].join('|'), 'g');

  const CLASSES = ['tok-com', 'tok-com', 'tok-str', 'tok-str', 'tok-str', 'tok-ann', 'tok-num'];

  function highlightKotlin(src) {
    let out = '';
    let last = 0;
    MASTER.lastIndex = 0;
    let m;
    while ((m = MASTER.exec(src))) {
      if (m.index > last) out += escapeHtml(src.slice(last, m.index));
      const text = m[0];
      let cls = null;
      for (let g = 1; g <= 8; g++) {
        if (m[g] !== undefined) {
          if (g <= 7) cls = CLASSES[g - 1];
          else { // identifier
            if (KEYWORDS.has(m[8])) cls = 'tok-kw';
            else if (/^[A-Z]/.test(m[8])) cls = 'tok-typ';
            else { // function call? look ahead
              const rest = src.slice(m.index + text.length);
              if (/^\s*\(/.test(rest)) cls = 'tok-fun';
            }
          }
          break;
        }
      }
      out += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
      last = m.index + text.length;
      if (text === '' ) MASTER.lastIndex++; // safety
    }
    if (last < src.length) out += escapeHtml(src.slice(last));
    // keep trailing newline visible so the pre matches textarea height
    if (out.endsWith('\n')) out += ' ';
    return out;
  }

  const XML_OUTSIDE = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[?!][\s\S]*?(?:>|$)|<\/?[A-Za-z_:][\w:.-]*/g;
  const XML_INSIDE = /\s+|\/?>|([A-Za-z_:][\w:.-]*)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s>"'</]*))?|("[^"]*"|'[^']*')|[\s\S]/g;

  function highlightXml(src) {
    let out = '';
    let pos = 0;
    while (pos < src.length) {
      XML_OUTSIDE.lastIndex = pos;
      const m = XML_OUTSIDE.exec(src);
      if (!m) { out += escapeHtml(src.slice(pos)); break; }
      if (m.index > pos) out += escapeHtml(src.slice(pos, m.index));
      const tok = m[0];
      pos = m.index + tok.length;
      if (tok.startsWith('<!--') || tok.startsWith('<?') || (tok.startsWith('<!') && !tok.startsWith('<![CDATA['))) {
        out += `<span class="tok-com">${escapeHtml(tok)}</span>`;
      } else if (tok.startsWith('<![CDATA[')) {
        out += `<span class="tok-str">${escapeHtml(tok)}</span>`;
      } else {
        const slash = tok.startsWith('</') ? '</' : '<';
        const name = tok.slice(slash.length);
        out += `${escapeHtml(slash)}<span class="tok-kw">${escapeHtml(name)}</span>`;
        while (pos < src.length) {
          if (src[pos] === '<') break; // unclosed tag before next tag
          XML_INSIDE.lastIndex = pos;
          const im = XML_INSIDE.exec(src);
          if (!im || im.index !== pos) { out += escapeHtml(src[pos++]); continue; }
          const itok = im[0];
          pos += itok.length;
          if (itok === '>' || itok === '/>') {
            out += `<span class="tok-kw">${escapeHtml(itok)}</span>`;
            break;
          } else if (im[1] !== undefined) {
            out += `<span class="tok-ann">${escapeHtml(im[1])}</span>`;
            if (im[2] !== undefined) out += `${escapeHtml(im[2])}<span class="tok-str">${escapeHtml(im[3])}</span>`;
          } else if (im[4] !== undefined) {
            out += `<span class="tok-str">${escapeHtml(im[4])}</span>`;
          } else {
            out += escapeHtml(itok);
          }
        }
      }
    }
    if (out.endsWith('\n')) out += ' ';
    return out;
  }

  global.CDHighlight = function (filename, src) {
    if (/\.(xml|html)$/.test(filename)) return highlightXml(src);
    return highlightKotlin(src); // .kt, .kts, .json and plain text all pass here reasonably
  };
  global.CDHighlight.esc = escapeHtml; // exposed for viewport-mode rendering
})(window);
