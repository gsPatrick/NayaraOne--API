'use strict';

// DI-BI2-7 (resposta de 16/11/2026, itens 4, 5, 10, 13, 14, 15a e 18 do plano da segunda leva) — cada verificação de completude mede só o universo em que a regra
// da API exige o campo. Para cada uma: o registro FORA do universo, sem o campo, deixa de reprovar (antes reprovava: contava no total e nos nulos) e o registro DENTRO
// do universo sem o campo continua reprovando. Fontes gravadas por superusuário (sem gatilho), uma empresa nova por verificação. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('./marco9/_helpers/biEnv');
const quality = require('../src/features/analytics/quality');
const clock = require('../src/features/analytics/metrics/clock');

const { src } = bi;
let env;
const extra = [];
const scopeOf = (t) => ({ companyId: t.companyId, groupId: t.groupId });
const check = async (t, model, code) => (await bi.inTx(t, { commit: true }, (tx) => quality.executeChecks({ readModel: model, scope: scopeOf(t), mode: 'EVENT' }, tx))).find((r) => r.checkCode === code);

async function company(label) {
  const id = src.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `BI2 universo ${label} ${id.slice(0, 6)}` } });
  extra.push(id);
  return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
}

/** Fora do universo: aprova sem contar o registro; dentro: reprova com 1 nulo. */
async function assertUniverse(t, model, code, inside) {
  const out = await check(t, model, code);
  assert.deepEqual([out.status, out.observed.total, out.observed.nulls], ['PASSED', 0, 0], `${code}: o registro fora do universo não entra na conta (antes: FAILED com ele nos nulos)`);
  await inside();
  const failed = await check(t, model, code);
  assert.deepEqual([failed.status, failed.observed.nulls], ['FAILED', 1], `${code}: o registro do universo sem o campo continua reprovando`);
  assert.equal(failed.severity, 'CRITICAL');
}

before(async () => {
  env = await bi.setup();
  clock.setClock(() => new Date(bi.NOW.getTime() + 60000));
});
after(async () => {
  clock.resetClock();
  const ids = extra;
  if (ids.length) {
    await env.admin.transaction(async (transaction) => {
      await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
      for (const table of ['inventory.receipt_items', 'inventory.receipts', 'inventory.inventory_items', 'construction.maintenance_cases', 'construction.projects', 'legal.contracts',
        'finance.financial_entries', 'real_estate.property_price_history', 'analytics.data_quality_checks', 'core.tenant_settings']) {
        await env.admin.query(`DELETE FROM ${table} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
      }
      await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
    });
  }
  await bi.teardown(env);
});

test('item 4: data final planejada só de obra iniciada (a passagem READY -> ACTIVE exige a data); planejada e cancelada ficam fora', async () => {
  const t = await company('obra');
  for (const status of ['PLANNED', 'BUDGETED', 'READY', 'CANCELLED']) await src.project(env, t, { property: src.uuid(), status });
  await assertUniverse(t, 'rm_project_progress', 'project_progress_planned_end_date_completeness', () => src.project(env, t, { property: src.uuid(), status: 'ACTIVE' }));
});

test('item 5: causa raiz só do chamado de pós-obra fechado (o fechamento exige a causa)', async () => {
  const t = await company('posobra');
  await src.maintenance(env, t, { property: src.uuid(), status: 'OPEN', created: '2026-10-20T15:00:00Z' });
  await assertUniverse(t, 'rm_postwork_cost', 'postwork_cost_root_cause_code_completeness', () => src.maintenance(env, t, { property: src.uuid(), status: 'CLOSED', created: '2026-10-20T15:00:00Z' }));
});

test('item 10: custo médio só de item que já teve recebimento confirmado; item de serviço e recebimento em rascunho ficam fora', async () => {
  const t = await company('estoque');
  const item = (type) => src.insert(env, 'inventory.inventory_items', t, { name: `Item ${type}`, item_type: type, status: 'ACTIVE', average_cost: null });
  const receipt = async (itemId, status) => {
    const r = await src.insert(env, 'inventory.receipts', t, { destination_location_id: src.uuid(), status });
    await src.insert(env, 'inventory.receipt_items', t, { receipt_id: r, inventory_item_id: itemId, quantity: '1' });
  };
  await item('CONSUMABLE'); // nunca recebido
  await receipt(await item('CONSUMABLE'), 'DRAFT');
  await receipt(await item('SERVICE_ITEM'), 'COMPLETED');
  await assertUniverse(t, 'rm_inventory_health', 'inventory_health_item_cost_completeness', async () => receipt(await item('CONSUMABLE'), 'COMPLETED'));
});

test('item 13: valor do contrato só de locação a partir de APPROVED (o valor congela ali); aditivo, venda e rascunho ficam fora; tipos de locação são parâmetro', async () => {
  const t = await company('contrato');
  await src.contract(env, t, { type: 'ADDENDUM', status: 'ACTIVE' });
  await src.contract(env, t, { type: 'SALE', status: 'ACTIVE' });
  for (const status of ['DRAFT', 'LEGAL_REVIEW']) await src.contract(env, t, { type: 'LEASE', status });
  await assertUniverse(t, 'rm_rental_contracts', 'rental_contracts_total_value_completeness', () => src.contract(env, t, { type: 'LEASE', status: 'APPROVED' }));
  await bi.setSetting(env, t, 'analytics.locacao.tipos_contrato', 'PROPERTY_ADMIN');
  assert.equal((await check(t, 'rm_rental_contracts', 'rental_contracts_total_value_completeness')).status, 'PASSED', 'com LEASE fora dos tipos de locação o contrato sai da conta');
});

test('item 14: vencimento da inadimplência só do recebível próprio de contrato de locação (o mesmo recorte do read model)', async () => {
  const t = await company('inadimplencia');
  const sale = await src.contract(env, t, { type: 'SALE', status: 'ACTIVE', value: '1000.00' });
  const lease = await src.contract(env, t, { type: 'LEASE', status: 'ACTIVE', value: '1000.00' });
  await src.entry(env, t, { nature: 'RECEIVABLE', amount: '10.00', status: 'PENDING' }); // sem contrato: é do Financeiro
  await src.entry(env, t, { nature: 'RECEIVABLE', amount: '10.00', status: 'PENDING', contract: sale });
  await src.entry(env, t, { nature: 'RECEIVABLE', amount: '10.00', status: 'PENDING', contract: lease, third: true });
  await assertUniverse(t, 'rm_rental_arrears', 'rental_arrears_due_at_completeness', () => src.entry(env, t, { nature: 'RECEIVABLE', amount: '10.00', status: 'PENDING', contract: lease }));
});

test('item 15a: centro de resultado só da receita liquidada (M4:83); despesa sem centro de resultado fica fora; a competência segue nas duas', async () => {
  const t = await company('setor');
  const settled = (nature, center) => src.insert(env, 'finance.financial_entries', t, {
    entry_type: nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature, amount: '10.00', status: 'SETTLED', settled_at: '2026-10-20T15:00:00Z', competence_month: '2026-10', result_center_id: center, is_third_party_funds: false,
  });
  await settled('PAYABLE', null);
  await assertUniverse(t, 'rm_finance_sector_margin', 'sector_margin_center_completeness', () => settled('RECEIVABLE', null));
  const comp = await check(t, 'rm_finance_sector_margin', 'sector_margin_competence_completeness');
  assert.deepEqual([comp.status, comp.observed.total], ['PASSED', 2], 'a competência continua medida na receita e na despesa');
});

test('item 18: preço anterior só da alteração de preço; a linha de criação da oferta (OFFER_CREATED) fica fora', async () => {
  const t = await company('preco');
  const history = (reason) => src.insert(env, 'real_estate.property_price_history', t, { offer_id: src.uuid(), old_price: null, new_price: '2500.00', changed_at: '2026-10-20T15:00:00Z', changed_by: src.uuid(), reason_code: reason });
  await history('OFFER_CREATED');
  await assertUniverse(t, 'rm_property_price_changes', 'price_changes_old_price_completeness', () => history('AJUSTE'));
});
