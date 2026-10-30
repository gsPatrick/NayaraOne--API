'use strict';

// M9-D437 adv_09 (Caderno §16: "Cross-company audience -> bloqueado"). Campanha da empresa A com pessoa da empresa B (ou id inexistente, ou filtro com a empresa B) na audiência: 422
// MKT_AUDIENCE_CROSS_COMPANY, nenhuma campanha nem audiência gravadas, e sob RLS a empresa A não lê a pessoa de B. Cenário da dona (M9-D412), sem lógica própria. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const campaigns = require('../../../../src/features/marketing/campaigns/campaigns.service');
const fx = require('../../../helpers/m9d412Fixtures');

const { tenants, asTenant, makePerson, makeTemplate, completeBody, q, uid, rejectsWith } = fx;
let A;
let B;
before(async () => { ({ a: A, b: B } = await tenants()); });
after(async () => { await sequelize.close(); });
const save = (t, body) => campaigns.saveCampaign(A, A.userId, body, { permissions: ['marketing:campaign:manage'] }, t);

test('adv_09_cross_company_audience_bloqueado: pessoa de outra empresa, id inexistente e filtro da empresa B', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const templateId = await makeTemplate(t, A);
    const mine = await makePerson(t, A);
    const foreign = await asTenant(t, A, B, () => makePerson(t, B, { name: 'QA-M9 Pessoa da outra empresa' }));
    const code = `QA-M9-${uid().slice(0, 8)}`;
    // (1) o efeito proibido não ocorreu: 422 com o código do livro, agendando ou só salvando
    await rejectsWith(assert, save(t, { ...completeBody({ templateId, personIds: [mine, foreign], code }), schedule: true }), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    await rejectsWith(assert, save(t, completeBody({ templateId, personIds: [mine, foreign], code })), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    await rejectsWith(assert, save(t, { ...completeBody({ templateId, personIds: [uid()], code }), schedule: true }), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    const seg = { kind: 'SEGMENT', purpose: 'X', filter: { companyId: B.companyId, roles: ['CLIENTE'] } };
    await rejectsWith(assert, save(t, { ...completeBody({ templateId, personIds: [mine], audiences: [seg], code }), schedule: true }), 422, 'MKT_AUDIENCE_CROSS_COMPANY');
    // nada gravado: nem campanha, nem audiência, nem membro, nem step
    assert.equal((await q(t, 'SELECT id FROM marketing.campaigns WHERE code = :code', { code })).length, 0, 'nenhuma campanha gravada');
    assert.equal((await q(t, 'SELECT id FROM marketing.campaign_audiences WHERE company_id = :c', { c: A.companyId })).length, 0, 'nenhuma audiência gravada');
    assert.equal((await q(t, 'SELECT id FROM marketing.campaign_audience_members WHERE company_id = :c', { c: A.companyId })).length, 0, 'nenhum membro gravado');
    // (2) o motivo é verificável: sob RLS a empresa A não lê a pessoa de B, e B continua lendo a sua
    assert.equal((await q(t, 'SELECT id FROM people.persons WHERE id = :id', { id: foreign })).length, 0, 'a empresa A não lê a pessoa de B');
    assert.equal((await asTenant(t, A, B, () => q(t, 'SELECT id FROM people.persons WHERE id = :id', { id: foreign }))).length, 1, 'a empresa B lê a sua pessoa');
    // controle positivo: a mesma campanha só com pessoa da própria empresa é aceita e a audiência guarda só a empresa A
    const ok = await save(t, { ...completeBody({ templateId, personIds: [mine], code }), schedule: true });
    const members = await q(t, 'SELECT person_id, company_id FROM marketing.campaign_audience_members WHERE campaign_id = :id', { id: ok.campaign.id });
    assert.deepEqual(members.map((m) => [m.person_id, m.company_id]), [[mine, A.companyId]]);
    assert.equal((await asTenant(t, A, B, () => q(t, 'SELECT id FROM marketing.campaigns WHERE id = :id', { id: ok.campaign.id }))).length, 0, 'a empresa B não lê a campanha de A');
  });
});
