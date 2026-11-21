// Fast csv-reader 1.0.0 drop-in: identical output, indexOf+slice scanning.
// Semantics replicate vendor/csv-reader/index.js exactly (see design note):
// BOM dropped, LF/CRLF record ends, lone CR outside quotes dropped (stray_cr),
// quoted fields with "" escapes, CRLF/lone CR inside quotes read as LF,
// junk after closing quote appended (quote_junk), unterminated quote is a
// literal and the rest is re-read as unquoted (unterminated_quote), fields
// stay strings, short/long rows padded/cut to first record width.
// Pure: no clock/random/locale, no state kept between calls.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;
const CR_RE = /\r\n?/g;

function countLF(s) {
  let n = 0;
  let i = -1;
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
  return n;
}

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;
  let recordLine = 1;
  let recordRow = null;
  // Shared field-result slots: readUnquoted/readQuoted write these instead of
  // allocating a {value, ended, added} object per field (~780k fields/set).
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Unquoted field starting at pos, with initial value `value`.
  // Fast path: next delimiter via indexOf, bulk slice; slow char loop only
  // when the slice holds a CR (stray CR / CRLF handling).
  function readUnquoted(value) {
    let added = 0;
    fAdded = 0;
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end;
    let ended;
    if (ci === -1 && ni === -1) {
      end = len;
      ended = END;
    } else if (ni === -1 || (ci !== -1 && ci < ni)) {
      end = ci;
      ended = COMMA;
    } else {
      end = ni;
      ended = LINE_BREAK;
    }
    if (ended === LINE_BREAK) {
      if (end > pos && text.charCodeAt(end - 1) === 13) {
        const seg = text.slice(pos, end - 1);
        if (seg.indexOf('\r') === -1) {
          value = value === '' ? seg : value + seg;
          added += seg.length;
          pos = end + 1;
          line += 1;
          fValue = value; fEnded = ended; fAdded = added;
          return;
        }
      } else {
        const seg = text.slice(pos, end);
        if (seg.indexOf('\r') === -1) {
          value = value === '' ? seg : value + seg;
          added += seg.length;
          pos = end + 1;
          line += 1;
          fValue = value; fEnded = ended; fAdded = added;
          return;
        }
      }
    } else {
      const seg = text.slice(pos, end);
      if (seg.indexOf('\r') === -1) {
        value = value === '' ? seg : value + seg;
        added += seg.length;
        pos = ended === COMMA ? end + 1 : end;
        fValue = value; fEnded = ended; fAdded = added;
        return;
      }
    }
    // Slow path: segment holds a CR. Replicate the per-char loop exactly.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value; fEnded = COMMA; fAdded = added;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = added;
        return;
      }
      if (c === 13) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fValue = value; fEnded = LINE_BREAK; fAdded = added;
          return;
        }
        error('stray_cr');
        pos += 1;
        continue;
      }
      value += text[pos];
      added += 1;
      pos += 1;
    }
    fValue = value; fEnded = END; fAdded = added;
    return;
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    for (;;) {
      const qi = text.indexOf('"', pos);
      if (qi === -1) {
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (qi > pos) {
        const seg = text.slice(pos, qi);
        if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
          value = value === '' ? seg : value + seg;
        } else if (seg.indexOf('\r') === -1) {
          value = value === '' ? seg : value + seg;
          line += countLF(seg);
        } else {
          const norm = seg.replace(CR_RE, '\n');
          value = value === '' ? norm : value + norm;
          line += countLF(norm);
        }
      }
      if (qi + 1 < len && text.charCodeAt(qi + 1) === 34) {
        value += '"';
        pos = qi + 2;
        continue;
      }
      pos = qi + 1;
      if (pos >= len) { fValue = value; fEnded = END; fAdded = 0; return; }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value; fEnded = COMMA; fAdded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = 0;
        return;
      }
      if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value; fEnded = LINE_BREAK; fAdded = 0;
        return;
      }
      readUnquoted(value);
      if (fAdded > 0) error('quote_junk');
      return;
    }
  }

  for (;;) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted(); else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
