'use strict';

/**
 * Regra 6 — "Não permitir NAY SQL livre". Nenhuma ferramenta da NAY tem parâmetro de texto livre que sirva de consulta (nome como
 * sql, query, consulta, statement, where, expression ou raw, sem lista fechada de valores), e as ferramentas de BI (`analytics.*`,
 * `bi.*`) são só de leitura de read model: categoria READ, risco LOW, sem aprovação humana e com permissão `analytics:*`.
 */
const { violation } = require('./files');

const SQL_TOKENS = new Set(['sql', 'statement', 'where', 'expression', 'raw']); // sempre suspeitos
const QUERY_TOKENS = new Set(['query', 'consulta']); // busca textual é normal (knowledge.search); em ferramenta de BI é consulta livre
const tokensOf = (name) => name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-.]/);
const isFreeQuery = (name, prop, isBi) => tokensOf(name).some((t) => SQL_TOKENS.has(t) || (isBi && QUERY_TOKENS.has(t))) || /\bsql\b/i.test(prop.description || '');
const BI_TOOL = /^(analytics|bi)\./;

function walkProps(schema, trail, visit) {
  if (!schema || typeof schema !== 'object') return;
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    visit([...trail, key], prop);
    walkProps(prop, [...trail, key], visit);
    if (prop && prop.items) walkProps(prop.items, [...trail, key], visit);
  }
}

function checkRule6(definitions) {
  const out = [];
  for (const def of definitions) {
    walkProps(def.inputSchema, [], (trail, prop) => {
      const name = trail[trail.length - 1];
      if (prop && prop.type === 'string' && !prop.enum && isFreeQuery(name, prop, BI_TOOL.test(def.name))) {
        out.push(violation(6, def.name, `Parâmetro de texto livre "${trail.join('.')}" parece consulta (SQL livre); use filtros fechados.`));
      }
    });
    if (BI_TOOL.test(def.name)) {
      if (def.category !== 'READ' || def.riskLevel !== 'LOW') out.push(violation(6, def.name, 'Ferramenta de BI da NAY precisa ser só de leitura (category READ, riskLevel LOW).'));
      if (def.requiresHumanApproval) out.push(violation(6, def.name, 'Ferramenta de BI da NAY não é de escrita: não deveria exigir aprovação.'));
      if (!/^analytics:/.test(def.permissionCode || '')) out.push(violation(6, def.name, 'Ferramenta de BI da NAY deve exigir uma permissão analytics:*.'));
    }
  }
  return { scanned: definitions.length, violations: out };
}

module.exports = { checkRule6 };
