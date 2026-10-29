'use strict';

// M9-D693 (3.2, 6) — entrada e saída do briefing: a NAY só recebe métricas dos painéis do papel Diretoria; o leitor sem permissão do domínio
// não vê o item (o gravado não muda); geração e leitura gravam BRIEF_GENERATE e BRIEF_READ no log de acesso, com mascaramento (D700).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const briefs = require('../../../src/features/analytics/briefs');

let env;
before(async () => { env = await e.setup(); });
after(async () => { await e.teardown(env); });

const A = () => env.tenantA;
const gen = (tx, runAgent, extra = {}) => briefs.generateBrief({ scope: e.scopeOf(A()), briefType: 'DAILY', now: new Date(e.NOW), ...extra }, { runAgent }, tx);
const read = (tx, perms, extra = {}) => briefs.getBriefForReader(e.readerOf(A(), perms), { briefType: 'DAILY', ...extra }, tx);
const logRows = async (action, tx) => (await e.sequelize.query(
  'SELECT action, resource_type AS "resourceType", resource_code AS "resourceCode", rows_returned AS "rowsReturned", user_id AS "userId" FROM analytics.access_log WHERE company_id = :c AND action = :a ORDER BY occurred_at DESC LIMIT 5',
  { replacements: { c: A().companyId, a: action }, transaction: tx }
))[0];

async function duasAreas(tx) {
  const fin = await e.metric(env, A(), tx, { current: '150', previous: '100' });
  const crm = await e.metric(env, A(), tx, { code: `crm.m9d693_${e.sup.sfx()}`, current: '70', previous: '100' });
  await e.panel(A(), tx, { metrics: [{ code: fin.code }, { code: crm.code }] });
  return { fin, crm };
}

test('m9d693 NAY só recebe métricas do papel Diretoria e o leitor sem permissão não vê o item', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const { fin, crm } = await duasAreas(tx);
    // painel exclusivo de outro papel: o indicador dele nunca chega à NAY
    const outro = await e.metric(env, A(), tx, { current: '1', previous: '9' });
    await e.panel(A(), tx, { metrics: [{ code: outro.code }], audienceRoles: ['Corretor'] });
    // domínio que a diretoria não enxerga pelo parâmetro (Comercial fora da lista)
    await e.setting(A(), tx, 'analytics.brief.dominios', 'Financeiro, Locação');
    const agent = e.agent();
    const out = await gen(tx, agent);
    const sent = e.entradaOf(agent.calls[0]);
    assert.deepEqual(sent.itens.map((i) => i.metricCode), [fin.code], 'só o indicador do painel da diretoria e de área permitida');
    assert.ok(!JSON.stringify(agent.calls[0]).includes(crm.code), 'o indicador do Comercial não vai à NAY');
    assert.ok(!JSON.stringify(agent.calls[0]).includes(outro.code), 'o indicador do painel de outro papel não vai à NAY');
    assert.equal(out.items.length, 1);
    // a NAY não recebe SQL, tabela nem registro individual: só chaves do contrato
    assert.deepEqual(Object.keys(sent).sort(), ['causasRegistradas', 'concomitantes', 'itens', 'periodo', 'periodoAnterior', 'tipo']);
  });
});

test('m9d693 leitor sem a permissão do domínio não vê o item e o briefing gravado não muda', async () => {
  await e.inTx(A(), {}, async (tx) => {
    const { fin, crm } = await duasAreas(tx);
    await gen(tx, e.agent());
    const completo = await read(tx, ['analytics:brief:read', 'finance:read', 'crm:opportunities:read']);
    assert.deepEqual(completo.items.map((i) => i.metricCodes[0]).sort(), [fin.code, crm.code].sort());
    const soFinanceiro = await read(tx, ['analytics:brief:read', 'finance:read']);
    assert.deepEqual(soFinanceiro.items.map((i) => i.metricCodes[0]), [fin.code], 'o item do Comercial some para quem não tem a permissão do domínio');
    assert.deepEqual(soFinanceiro.items.map((i) => i.ordem), [1].map((n, i) => soFinanceiro.items[i].ordem), 'a ordem original é preservada');
    const nenhum = await read(tx, ['analytics:brief:read']);
    assert.deepEqual(nenhum.items, []);
    assert.equal(nenhum.available, true);
    const [[gravado]] = await e.sequelize.query("SELECT jsonb_array_length(content->'itens') AS n FROM analytics.executive_briefs WHERE company_id = :c AND status = 'GENERATED' AND brief_type = 'DAILY'", { replacements: { c: A().companyId }, transaction: tx });
    assert.equal(gravado.n, 2, 'o gravado segue com os dois itens');
    // sem analytics:brief:read: 403 PERMISSION_DENIED com a permissão ausente
    await assert.rejects(read(tx, ['finance:read', 'analytics:read']), (err) => err.statusCode === 403 && err.code === 'PERMISSION_DENIED' && /analytics:brief:read/.test(err.message));
  });
});

test('m9d693 geração e leitura gravam BRIEF_GENERATE e BRIEF_READ no log de acesso', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await duasAreas(tx);
    await gen(tx, e.agent());
    const gerou = (await logRows('BRIEF_GENERATE', tx))[0];
    assert.ok(gerou, 'BRIEF_GENERATE');
    assert.deepEqual([gerou.resourceType, gerou.rowsReturned, gerou.userId], ['BRIEF', 2, null], 'gerado pelo job: sem usuário, com as linhas devolvidas');
    await read(tx, ['analytics:brief:read', 'finance:read']);
    const leu = (await logRows('BRIEF_READ', tx))[0];
    assert.ok(leu, 'BRIEF_READ');
    assert.deepEqual([leu.resourceType, leu.rowsReturned, leu.userId], ['BRIEF', 1, A().userId]);
  });
});

test('m9d693 outra empresa não lê o briefing da empresa A (RLS)', async () => {
  await e.inTx(A(), {}, async (tx) => {
    await duasAreas(tx);
    await gen(tx, e.agent());
    await e.asTenant(tx, env.tenantB);
    const deB = await briefs.getBriefForReader(e.readerOf(env.tenantB, ['analytics:brief:read', 'finance:read']), { briefType: 'DAILY' }, tx);
    assert.equal(deB, null, 'a empresa B não vê o briefing da A');
  });
});
