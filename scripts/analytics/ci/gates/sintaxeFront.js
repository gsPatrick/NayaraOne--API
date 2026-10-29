'use strict';

/**
 * M9-D705 etapa 2 (typecheck) — as telas e o cliente de API do BI no Front são lidos pelo compilador do TypeScript (diagnóstico de sintaxe e de
 * JSX; o Front é JavaScript, sem tsconfig) e qualquer erro reprova. O compilador vem do node_modules do Front (ou da API, se houver).
 */
const fs = require('node:fs');
const path = require('node:path');
const { listBiSources } = require('../../../lib/frontReadOnlyScan');

const FRONT_ROOT = path.join(__dirname, '..', '..', '..', '..', '..', 'NayaraOne--FRONT');

function carregarTypescript() {
  const base = [FRONT_ROOT, path.join(__dirname, '..', '..', '..', '..')];
  return require(require.resolve('typescript', { paths: base }));
}

function verificarSintaxe({ frontRoot = FRONT_ROOT } = {}) {
  const ts = carregarTypescript();
  const arquivos = listBiSources(frontRoot);
  const cliente = path.join(frontRoot, 'lib', 'api', 'analytics.js');
  if (fs.existsSync(cliente) && !arquivos.some((a) => a.relative === path.join('lib', 'api', 'analytics.js'))) arquivos.push({ relative: path.join('lib', 'api', 'analytics.js'), text: fs.readFileSync(cliente, 'utf8') });
  const problemas = [];
  for (const { relative, text } of arquivos) {
    const r = ts.transpileModule(text, { fileName: relative, reportDiagnostics: true, compilerOptions: { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    for (const d of r.diagnostics || []) {
      const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      problemas.push(`${relative}${pos ? `:${pos.line + 1}` : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
  return { ok: problemas.length === 0, verificados: arquivos.length, problemas };
}

module.exports = { verificarSintaxe };
