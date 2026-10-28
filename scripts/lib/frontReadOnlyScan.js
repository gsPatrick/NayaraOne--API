'use strict';

/**
 * M9-D612 (3.1 item 3) — varredura estática do Front: nenhuma tela de BI tem campo editável ligado a valor de KPI
 * (`contenteditable` ou input/textarea/select cuja declaração cita kpi, métrica, indicador ou snapshot). "Tela de BI" = arquivo em
 * pasta analytics, bi, kpi, dashboard(s), centro-de-comando ou comando, ou que importa o cliente de API do BI (lib/api/analytics).
 * Filtros de período, busca etc. continuam livres: só vale quando a tag fala de valor de métrica.
 */
const fs = require('node:fs');
const path = require('node:path');

const BI_DIRS = new Set(['analytics', 'bi', 'kpi', 'kpis', 'dashboard', 'dashboards', 'centro-de-comando', 'centro-comando', 'comando']);
const BI_IMPORT = /lib\/api\/analytics/;
const EDITABLE_TAG = /<(?:input|textarea|select|Input|Textarea|Select|DecimalInput|CurrencyInput|MoneyInput|NumberInput)\b[\s\S]*?(?:\/>|<\/(?:select|textarea|Select|Textarea)>)/g;
const KPI_WORD = /kpi|metric|m[eé]trica|indicador|snapshot|valueNumeric/i;
const CONTENT_EDITABLE = /\bcontenteditable\b/gi;
const SOURCE_EXT = /\.(jsx?|tsx?)$/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function isBiFile(relative, text) {
  return relative.split(path.sep).slice(0, -1).some((seg) => BI_DIRS.has(seg.toLowerCase())) || BI_IMPORT.test(text);
}

/** Varre `<frontRoot>/app` e `<frontRoot>/components`. Devolve { scanned, violations: [{ file, line, rule }] }. */
function scanFrontForEditableKpi(frontRoot) {
  const files = [...walk(path.join(frontRoot, 'app'), []), ...walk(path.join(frontRoot, 'components'), [])];
  const violations = [];
  let scanned = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(frontRoot, file);
    if (!isBiFile(relative, text)) continue;
    scanned += 1;
    for (const m of text.matchAll(CONTENT_EDITABLE)) violations.push({ file: relative, line: lineOf(text, m.index), rule: 'contenteditable' });
    for (const m of text.matchAll(EDITABLE_TAG)) {
      if (KPI_WORD.test(m[0])) violations.push({ file: relative, line: lineOf(text, m.index), rule: 'campo editável ligado a valor de KPI' });
    }
  }
  return { scanned, violations };
}

/** Arquivos de tela de BI do Front (mesma definição de "tela de BI"): [{ relative, text }]. Reuso: M9-D603. */
function listBiSources(frontRoot) {
  const files = [...walk(path.join(frontRoot, 'app'), []), ...walk(path.join(frontRoot, 'components'), [])];
  const out = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(frontRoot, file);
    if (isBiFile(relative, text)) out.push({ relative, text });
  }
  return out;
}

module.exports = { scanFrontForEditableKpi, listBiSources };
