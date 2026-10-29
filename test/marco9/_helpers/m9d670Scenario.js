'use strict';

// Cenário de campanhas da M9-D670. Data-base 28/10/2026 (SP), mês 2026-10. O cenário "bom" tem custo ligado a todas as campanhas que rodaram; o "ruim"
// quebra cada regra de qualidade (campanha sem canal, sem centro de custo, leads demais sem campanha, vendas fora da janela).
const src = require('./m9d627Sources');

const { at } = require('./mktKpiEnv');

const campaign = (env, t, c) => src.insert(env, 'marketing.campaigns', t, {
  code: c.code, name: `QA-M9 ${c.code}`, objective: 'Vender o lançamento', owner_user_id: t.userId, status: c.status, cost_actual: '0.00', objective_metric: 'LEADS', target_value: 10, budget_amount: 12000,
  starts_at: c.startsAt || at('10-01', '03:00:00'), ends_at: c.endsAt || at('10-31', '03:00:00'), channels: c.channels, created_at: at('10-01'), updated_at: at('10-01'),
});
const costCenter = (env, t, code) => src.insert(env, 'finance.cost_centers', t, { code, name: `QA-M9 ${code}` });
const expense = (env, t, e) => src.insert(env, 'finance.financial_entries', t, {
  entry_type: 'DEBIT', nature: 'PAYABLE', amount: e.amount, status: e.status || 'SETTLED', settled_at: e.settledAt === undefined ? at('10-05') : e.settledAt, due_at: e.dueAt || at('10-05'),
  cost_center_id: e.costCenterId || null, origin_ref: e.originRef || null, is_third_party_funds: e.thirdParty === true, lock_version: 0,
});
const lead = (env, t, l) => src.insert(env, 'crm.opportunities', t, {
  person_id: l.person || src.uuid(), campaign_id: l.campaignId || null, lead_source: l.source === undefined ? 'SITE' : l.source, stage: l.stage || 'QUALIFICATION', closed_at: l.closedAt || null,
  attribution_valid: l.valid === undefined ? null : l.valid, created_at: l.at || at('10-10'), updated_at: l.at || at('10-10'),
});
const event = (env, t, e) => src.insert(env, 'marketing.attribution_events', t, {
  event_type: e.type, person_id: e.person || src.uuid(), campaign_id: e.campaignId || null, opportunity_id: e.opportunityId || null, touch_roles: e.roles || '{}',
  evidence_json: e.evidence || { origem: 'teste' }, valid: e.valid !== false, occurred_at: e.at || at('10-10'),
});

/** Lead com o evento LEAD_CREATED que o Marketing grava quando a referência é válida. */
async function attributedLead(env, t, campaignId, extra = {}) {
  const person = src.uuid();
  const id = await lead(env, t, { campaignId, person, ...extra });
  await event(env, t, { type: 'LEAD_CREATED', campaignId, person, opportunityId: id, at: extra.at });
  return { id, person };
}

/**
 * Cenário bom (empresa t). C1 WhatsApp em andamento (centro de custo), C2 e-mail+WhatsApp em andamento (referência `campaign:`), C3 e-mail encerrada em 20/10
 * (centro de custo), C4 encerrada em setembro, C5 rascunho sem canal. Custo: C1 2.000,10 + 1.199,90 (à 23:30 de 31/10 em SP); C2 100,00 liquidado e 500,00 pendente;
 * C3 50,25. Fora do custo: lançamento de novembro (00:30 de 01/11 em SP), de terceiros e sem ligação. Leads de outubro: C1 4 (3 com evento), C2 2, sem campanha 1;
 * um de setembro. Vendas ganhas em outubro: C1 2. Uma venda sem toque válido na janela (fora da janela). Toque FIRST de C2 num lead de C1.
 */
async function bom(env, t) {
  const ids = {};
  ids.c1 = await campaign(env, t, { code: `QA-C1-${src.uuid().slice(0, 6)}`, status: 'RUNNING', channels: '{WHATSAPP}' });
  ids.c2 = await campaign(env, t, { code: `QA-C2-${src.uuid().slice(0, 6)}`, status: 'RUNNING', channels: '{EMAIL,WHATSAPP}' });
  ids.c3 = await campaign(env, t, { code: `QA-C3-${src.uuid().slice(0, 6)}`, status: 'ENDED', channels: '{EMAIL}', endsAt: at('10-20') });
  ids.c4 = await campaign(env, t, { code: `QA-C4-${src.uuid().slice(0, 6)}`, status: 'ENDED', channels: '{EMAIL}', startsAt: at('08-01'), endsAt: at('09-20') });
  ids.c5 = await campaign(env, t, { code: `QA-C5-${src.uuid().slice(0, 6)}`, status: 'DRAFT', channels: '{}' });
  const codeOf = async (id) => (await env.admin.query('SELECT code FROM marketing.campaigns WHERE id = :id', { replacements: { id } }))[0][0].code;
  const cc1 = await costCenter(env, t, await codeOf(ids.c1));
  const cc3 = await costCenter(env, t, await codeOf(ids.c3));
  const costCenter4 = await costCenter(env, t, await codeOf(ids.c4));
  await expense(env, t, { amount: '2000.10', costCenterId: cc1 });
  await expense(env, t, { amount: '1199.90', costCenterId: cc1, settledAt: '2026-11-01T02:30:00Z' }); // 23:30 de 31/10 em SP: ainda é outubro
  await expense(env, t, { amount: '77.00', costCenterId: cc1, settledAt: '2026-11-01T03:30:00Z' }); // 00:30 de 01/11 em SP: novembro
  await expense(env, t, { amount: '100.00', originRef: `campaign:${ids.c2}` });
  await expense(env, t, { amount: '500.00', originRef: `campaign:${ids.c2}`, status: 'PENDING', settledAt: null, dueAt: at('10-25') });
  await expense(env, t, { amount: '50.25', costCenterId: cc3, settledAt: at('10-18') });
  await expense(env, t, { amount: '30.00', costCenterId: costCenter4, settledAt: at('09-10') }); // setembro
  await expense(env, t, { amount: '999.00', costCenterId: cc1, thirdParty: true }); // dinheiro de terceiro: fora
  await expense(env, t, { amount: '888.00' }); // sem ligação com campanha: fora
  const person = src.uuid();
  ids.leads = [];
  for (let i = 0; i < 3; i += 1) ids.leads.push((await attributedLead(env, t, ids.c1)).id);
  ids.leads.push(await lead(env, t, { campaignId: ids.c1 })); // C1 sem o evento de atribuição: lead da campanha, mas não atribuído
  const firstOfC2 = await attributedLead(env, t, ids.c1, { person });
  ids.leads.push(firstOfC2.id);
  await event(env, t, { type: 'CLICK', campaignId: ids.c2, person, roles: '{FIRST}', at: at('10-05') }); // o primeiro toque do lead acima foi da C2
  for (let i = 0; i < 2; i += 1) ids.leads.push((await attributedLead(env, t, ids.c2)).id);
  ids.leads.push(await lead(env, t, {})); // sem campanha
  await lead(env, t, { campaignId: ids.c1, at: at('09-20') }); // setembro: fora do mês
  await lead(env, t, { source: null, campaignId: ids.c1 }); // sem origem de marketing: não é lead de marketing
  for (let i = 0; i < 2; i += 1) await lead(env, t, { campaignId: ids.c1, stage: 'CLOSED_WON', closedAt: at('10-15'), at: at('09-01') });
  await event(env, t, { type: 'SALE', evidence: { attribution: 'NAO_ATRIBUIDA', reason: 'SEM_TOQUE_VALIDO_NA_JANELA' }, at: at('10-12') });
  return ids;
}

/** Cenário ruim (empresa t): C1 sem canal, C2 sem centro de custo, 4 de 10 leads sem campanha, 1 de 2 vendas fora da janela. */
async function ruim(env, t) {
  const ids = {};
  ids.semCanal = await campaign(env, t, { code: `QA-RC-${src.uuid().slice(0, 6)}`, status: 'RUNNING', channels: '{}' });
  ids.semCusto = await campaign(env, t, { code: `QA-RS-${src.uuid().slice(0, 6)}`, status: 'RUNNING', channels: '{SITE}' });
  for (let i = 0; i < 6; i += 1) await attributedLead(env, t, ids.semCusto);
  for (let i = 0; i < 4; i += 1) await lead(env, t, {});
  await lead(env, t, { campaignId: ids.semCusto, stage: 'CLOSED_WON', closedAt: at('10-15'), at: at('09-01') });
  await event(env, t, { type: 'SALE', evidence: { attribution: 'NAO_ATRIBUIDA', reason: 'SEM_TOQUE_VALIDO_NA_JANELA' }, at: at('10-12') });
  return ids;
}

module.exports = { campaign, costCenter, expense, lead, event, attributedLead, bom, ruim, at };
