'use strict';

// Cenário do Correspondente para a M9-D661. Data-base 28/10/2026 (SP). Decisões de outubro: BANCO_A 3 aprovadas e 2 rejeitadas (5 = amostra mínima padrão),
// BANCO_B 1 aprovada e 1 rejeitada (abaixo da amostra); uma decisão em setembro (fora do mês). Casos sem decisão: 2 em análise, 1 enviado e 1 rascunho.
const bi = require('./biObrasJuridicoEnv');

const at = (day, time = '15:00:00') => `2026-${day}T${time}Z`; // 15:00Z = 12:00 em São Paulo
const hist = (env, t, caseId, status, occurred, applied = true) => bi.seed(env, t, 'correspondent.provider_status_history', {
  financing_case_id: caseId, raw_provider_status: status, normalized_status: status, occurred_at: occurred, applied, source: 'webhook',
});
const fcase = (env, t, status, extra = {}) => bi.seed(env, t, 'correspondent.financing_cases', { status, provider_code: 'BANCO_A', product: 'FINANCIAMENTO', updated_at: at('10-28'), ...extra });

/** Uma decisão: o caso, o envio e o desfecho `days` dias depois (dia de calendário). */
async function decided(env, t, { provider, outcome, sent, decidedAt, product = 'FINANCIAMENTO' }) {
  const id = await fcase(env, t, outcome, { provider_code: provider, product });
  if (sent) await hist(env, t, id, 'SUBMITTED', sent);
  await hist(env, t, id, outcome, decidedAt);
  return id;
}

async function casos(env, t) {
  const A = (outcome, sent, decidedAt) => decided(env, t, { provider: 'BANCO_A', outcome, sent, decidedAt });
  const B = (outcome, sent, decidedAt) => decided(env, t, { provider: 'BANCO_B', outcome, sent, decidedAt });
  const ids = { decided: [] };
  ids.decided.push(await A('APPROVED', at('10-01'), at('10-03')), await A('APPROVED', at('10-02'), at('10-06')), await A('APPROVED', at('10-03'), at('10-09')));
  ids.decided.push(await A('REJECTED', at('10-04'), at('10-12')), await A('REJECTED', at('10-05'), at('10-15')));
  ids.decided.push(await B('APPROVED', at('10-06'), at('10-08')), await B('REJECTED', at('10-07'), at('10-07')));
  ids.decided.push(await A('APPROVED', at('09-10'), at('09-15'))); // setembro: fora do mês da data-base
  for (const day of ['10-20', '10-10']) { // em análise (pendentes)
    const id = await fcase(env, t, 'UNDER_ANALYSIS');
    await hist(env, t, id, 'SUBMITTED', at('10-01'));
    await hist(env, t, id, 'UNDER_ANALYSIS', at(day));
    ids.analysis = [...(ids.analysis || []), id];
  }
  const sent = await fcase(env, t, 'SUBMITTED');
  await hist(env, t, sent, 'SUBMITTED', at('10-27'));
  ids.draft = await fcase(env, t, 'DRAFT', { provider_code: 'BANCO_B', updated_at: at('10-20') });
  ids.sent = sent;
  return ids;
}

/** Comissão (exemplo do livro): esperada 96.000,00; confirmada 54.000,00; recebida 31.000,00; a receber 23.000,00. As recebidas têm lançamento liquidado. */
async function comissoes(env, t, caseId) {
  const entry = (amount) => bi.seed(env, t, 'finance.financial_entries', { entry_type: 'CREDIT', nature: 'RECEIVABLE', amount, status: 'SETTLED', settled_at: at('10-20') });
  const e = async (provider_code, status, amount, withEntry = false) => bi.seed(env, t, 'correspondent.commission_entitlements', {
    financing_case_id: caseId, provider_code, status, base_amount: '100000.00', percentage: '1.00', amount, broker_share_pct: '100', manager_share_pct: '0', broker_amount: amount, manager_amount: '0.00',
    trigger_event: 'APPROVED', created_at: at('10-01'), updated_at: at('10-01'), ...(withEntry ? { financial_entry_id: await entry(amount) } : {}),
  });
  const ids = {};
  ids.expected = await e('BANCO_A', 'EXPECTED', '60000.00');
  await e('BANCO_B', 'EXPECTED', '36000.00');
  ids.confirmed = await e('BANCO_A', 'CONFIRMED', '13000.00');
  await e('BANCO_A', 'RECEIVABLE', '10000.00');
  ids.received = await e('BANCO_A', 'RECEIVED', '20000.00', true);
  await e('BANCO_B', 'RECEIVED', '11000.00', true);
  await e('BANCO_A', 'ADJUSTED', '999.00'); // ajuste: nunca conta
  return ids;
}

module.exports = { casos, comissoes, decided, fcase, hist, at };
