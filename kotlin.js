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

  function highlightXml(src) {
    return escapeHtml(src)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>')
      .replace(/(&lt;\/?)([\w:.-]+)/g, '$1<span class="tok-kw">$2</span>')
      .replace(/([\w:.-]+)(=)(&quot;.*?&quot;|".*?")/g, '<span class="tok-ann">$1</span>$2<span class="tok-str">$3</span>')
      .replace(/(\/?&gt;)/g, '<span class="tok-kw">$1</span>');
  }

  global.CDHighlight = function (filename, src) {
    if (/\.(xml|html)$/.test(filename)) return highlightXml(src);
    return highlightKotlin(src); // .kt, .kts, .json and plain text all pass here reasonably
  };
  global.CDHighlight.esc = escapeHtml; // exposed for viewport-mode rendering
})(window);
