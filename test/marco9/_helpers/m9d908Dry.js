'use strict';

// Cenário do ensaio DRY3 dos testes M9-D908 (não é teste): fonte antiga falsa com pessoas de borda, RACI completo, fontes semeadas desligadas e exportação em diretório temporário.
const env = require('./m9d908Env');

const EDGE_BIRTHS = Object.freeze(['1992-02-29', '1999-12-31 23:59:59', '2000-01-01 00:00:00', '1985-04-12', '2026-10-31 00:00:00']);

/** Prepara a empresa e a fonte. `rows` = N pessoas (as primeiras com datas de borda). Devolve { legacy, names, taxIds, exported, dispose }. */
async function scenario(tenant, { rows = EDGE_BIRTHS.length, extra = [] } = {}) {
  await env.isolate(tenant);
  await env.completeRaci(tenant);
  const exported = env.useTempExport();
  const legacy = await env.installSource(tenant, { mode: 'WATERMARK', entity: 'PERSON' });
  const names = [];
  const taxIds = [];
  for (let i = 0; i < rows; i += 1) {
    const record = env.personRecord({ birthDate: EDGE_BIRTHS[i % EDGE_BIRTHS.length], preferredName: `Apelido ${i}` });
    names.push(record.legalName);
    taxIds.push(record.taxId);
    legacy.fake.row(`dry${i}`, new Date(Date.UTC(2030, 0, 1, 0, 0, i)), record);
  }
  for (const [index, record] of extra.entries()) legacy.fake.row(`extra${index}`, new Date(Date.UTC(2030, 0, 2, 0, 0, index)), record);
  return { legacy, names, taxIds, exported, dispose: () => legacy.dispose() };
}

/** Executa o ensaio como o gestor da empresa e devolve o relatório lido do banco. */
const runDry3 = (tenant) => env.dry.executeDryRun(tenant, { userId: tenant.userId });

module.exports = { ...env, scenario, runDry3, EDGE_BIRTHS };
