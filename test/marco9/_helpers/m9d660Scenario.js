'use strict';

// Cenário do Jurídico para a M9-D660. Data-base 28/10/2026 (SP). Reaproveita os prazos e as exigências da M9-D619 e acrescenta processos com risco e
// valores em quantidade suficiente para a regra de qualidade (sem classificação até 10%) valer.
const bi = require('./biObrasJuridicoEnv');
const juridico = require('./m9d619Juridico');

const { at } = juridico;

/** Processos ativos: HIGH 3, MEDIUM 4, LOW 2 e 1 sem nível (10% de 10: no limite); fora: encerrado (fase CLOSED), arquivado e excluído. */
async function processos(env, t, { withoutRisk = 1 } = {}) {
  const c = (extra) => bi.seed(env, t, 'legal.legal_cases', { status: 'OPEN', ...extra });
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(await c({ case_type: 'EVICTION', risk_level: 'HIGH', estimated_amount: '100000.00', confirmed_amount: i === 0 ? '120000.00' : null }));
  for (let i = 0; i < 4; i += 1) ids.push(await c({ case_type: 'LABOR', risk_level: 'MEDIUM', estimated_amount: '50000.00' }));
  for (let i = 0; i < 2; i += 1) ids.push(await c({ case_type: 'LABOR', risk_level: 'LOW' })); // sem valor estimado: conta em withoutValue
  for (let i = 0; i < withoutRisk; i += 1) ids.push(await c({ case_type: 'LABOR', estimated_amount: '1000.50' }));
  await c({ case_type: 'LABOR', risk_level: 'LOW', phase: 'CLOSED', estimated_amount: '999.00', confirmed_amount: '7000.00' }); // encerrado: sai do estimado, o confirmado fica
  await c({ case_type: 'LABOR', status: 'ARCHIVED', risk_level: 'MEDIUM', estimated_amount: '111.00' });
  await c({ case_type: 'LABOR', risk_level: 'CRITICAL', estimated_amount: '5.00', deleted_at: at('10-01') });
  return ids;
}

/** Prazos e exigências (M9-D619): o primeiro processo ativo recebe os prazos. */
async function tudo(env, t, options) {
  const cases = await processos(env, t, options);
  const deadlines = await juridico.prazos(env, t, cases[0]);
  const reqs = await juridico.exigencias(env, t);
  return { cases, deadlines, reqs };
}

module.exports = { processos, tudo, at };
