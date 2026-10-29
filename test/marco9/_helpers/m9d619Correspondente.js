'use strict';

// Fontes do Correspondente Bancário para os testes da M9-D619. Data-base 28/10/2026 (SP).
const bi = require('./biObrasJuridicoEnv');
const { at } = require('./m9d619Juridico');

/** Casos e histórico do provider (ver a tabela de resultados em m9d619.numeros.test.js). */
async function casos(env, t) {
  const fc = (status, extra = {}) => bi.seed(env, t, 'correspondent.financing_cases', { status, provider_code: 'BANCO_A', product: 'FINANCIAMENTO', updated_at: at('10-28'), ...extra });
  const hist = (financing_case_id, normalized_status, occurred_at, applied = true) => bi.seed(env, t, 'correspondent.provider_status_history', {
    financing_case_id, raw_provider_status: normalized_status, normalized_status, occurred_at, applied, source: 'webhook',
  });
  const f1 = await fc('UNDER_ANALYSIS');
  await hist(f1, 'SUBMITTED', at('10-01'));
  await hist(f1, 'UNDER_ANALYSIS', at('10-10'));
  const f2 = await fc('UNDER_ANALYSIS');
  await hist(f2, 'UNDER_ANALYSIS', at('10-20'));
  await hist(f2, 'UNDER_ANALYSIS', at('10-27'), false); // não aplicado: não conta como entrada no estágio
  const f3 = await fc('APPROVED');
  await hist(f3, 'SUBMITTED', at('10-02'));
  await hist(f3, 'APPROVED', at('10-05'));
  const f4 = await fc('REJECTED', { provider_code: 'BANCO_B' });
  await hist(f4, 'SUBMITTED', at('10-03'));
  await hist(f4, 'REJECTED', at('10-03', '21:00:00'));
  const f5 = await fc('APPROVED', { product: 'CONSORCIO' });
  await hist(f5, 'APPROVED', at('09-15'));
  await bi.seed(env, t, 'correspondent.provider_submissions', {
    financing_case_id: f5, provider_code: 'BANCO_A', idempotency_key: `k-${f5}`, snapshot_hash: 'h', request_snapshot: '{}', status: 'SUBMITTED', created_at: at('09-14'), updated_at: at('09-14'),
  });
  const f6 = await fc('APPROVED');
  await hist(f6, 'APPROVED', at('10-06'));
  const f7 = await fc('DRAFT', { provider_code: 'BANCO_B', updated_at: at('10-20') });
  return { f1, f2, f3, f4, f5, f6, f7 };
}

/** Comissão: BANCO_A esperada 1.500,50, confirmada 6.300,00 (confirmada + a receber + recebida), recebida 4.000,00; BANCO_B 250,00 / 100,00 / 100,00. */
async function comissoes(env, t, caseId) {
  const e = (provider_code, status, amount) => bi.seed(env, t, 'correspondent.commission_entitlements', {
    financing_case_id: caseId, provider_code, status, base_amount: '100000.00', percentage: '1.00', amount, broker_share_pct: '100', manager_share_pct: '0', broker_amount: amount, manager_amount: '0.00',
    trigger_event: 'APPROVED', created_at: at('10-01'), updated_at: at('10-01'),
  });
  const ids = {};
  ids.expected = await e('BANCO_A', 'EXPECTED', '1000.00');
  await e('BANCO_A', 'EXPECTED', '500.50');
  ids.confirmed = await e('BANCO_A', 'CONFIRMED', '2000.00');
  await e('BANCO_A', 'RECEIVABLE', '300.00');
  await e('BANCO_A', 'RECEIVED', '4000.00');
  await e('BANCO_A', 'ADJUSTED', '999.00');
  await e('BANCO_B', 'EXPECTED', '250.00');
  await e('BANCO_B', 'RECEIVED', '100.00');
  return ids;
}

module.exports = { casos, comissoes };
