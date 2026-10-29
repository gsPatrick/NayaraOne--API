'use strict';

/** docs/ERROR_CODES.md gerado do catálogo (M9-D843 §3.4). Linhas de tabela no formato lido pelo lint do OpenAPI (M9-D840, regra 9). */
function renderMarkdown(entries) {
  const lines = [
    '# Catálogo de códigos de erro da API',
    '',
    'Gerado por `node scripts/gerarErrorCatalog.js` a partir de `src/features/core-governance/api-governance/standards/errorCatalog.data.json`. Não edite à mão.',
    '',
    'Corpo de erro único: `{"success":false,"error":{"code","message","details?","traceId"}}`; `traceId` é o `X-Correlation-Id` da requisição.',
    '',
    '| Código | Status | Mensagem | Módulo | Desde | Descontinuado |',
    '|---|---|---|---|---|---|',
  ];
  for (const e of entries) lines.push(`| \`${e.code}\` | ${e.status} | ${String(e.message).replace(/\|/g, '\\|')} | ${e.module} | ${e.since} | ${e.deprecated ? 'sim' : 'não'} |`);
  return `${lines.join('\n')}\n`;
}

module.exports = { renderMarkdown };
