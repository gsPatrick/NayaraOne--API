'use strict';

// M9-D419 — dado sensível não serve de critério de segmentação: lista fechada em parâmetro (marketing.segment.campos_proibidos),
// recusa 422 MKT_SEGMENT_SENSITIVE_FIELD em qualquer nível do filtro. Banco descartável; rollback; duas empresas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const { upsertSetting, SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const settings = require('../../../src/features/marketing/campaigns/segment.settings');
const env = require('../_helpers/mktOptOut');

const { makeTemplate, completeBody, readyPerson } = env;
let A;
let B;
before(async () => { ({ a: A, b: B } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const PERMS = { permissions: ['marketing:campaign:manage'] };
const PROHIBITED = ['renda_exata', 'renda', 'saude', 'deficiencia', 'cpf', 'cnpj', 'rg', 'documento', 'restricao_credito', 'divida', 'score_credito', 'orientacao_sexual', 'religiao', 'etnia'];

async function save(t, tenant, filter, kind = 'SEGMENT') {
  const templateId = await makeTemplate(t, tenant);
  const person = await readyPerson(t, tenant);
  return campaigns.saveCampaign(tenant, tenant.userId, completeBody({ templateId, personIds: [person], audiences: [{ kind, purpose: 'MARKETING', filter }] }), PERMS, t);
}
const refused = (promise, code = 'MKT_SEGMENT_SENSITIVE_FIELD') => assert.rejects(promise, (e) => { assert.equal(e.statusCode, 422); assert.equal(e.code, code); assert.match(e.message, /dado sens/); return true; });

test('segmento_por_dado_sensivel_recusado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await refused(save(t, A, { renda_exata: '10000' }));
    await refused(save(t, A, { roles: ['LEAD'], rendaExata: { min: 1 } }), 'MKT_SEGMENT_SENSITIVE_FIELD');
    // segmento com campos seguros do CRM continua válido
    const ok = await save(t, A, { roles: ['LEAD'], opportunityStages: ['NEW'] });
    assert.equal(ok.created, true);
  });
});

test('segmento_com_qualquer_campo_da_lista_proibida_e_recusado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    for (const field of PROHIBITED) {
      await refused(save(t, A, { [field]: 'x' }), 'MKT_SEGMENT_SENSITIVE_FIELD');
      await refused(save(t, A, { roles: ['LEAD'], criterios: [{ grupo: { [field]: 1 } }] }), 'MKT_SEGMENT_SENSITIVE_FIELD'); // aninhado
      await refused(save(t, A, { personIds: [env.uid()], [field.toUpperCase()]: 1 }, 'PERSON_LIST'), 'MKT_SEGMENT_SENSITIVE_FIELD'); // qualquer tipo de público
    }
    await refused(save(t, A, { campo: 'score_credito' }), 'MKT_SEGMENT_SENSITIVE_FIELD'); // o nome do campo como valor
  });
});

test('campo_fora_das_listas_tambem_e_recusado_e_a_lista_e_parametro_da_empresa', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await assert.rejects(save(t, A, { cor_do_carro: 'azul' }), (e) => e.statusCode === 400 && e.code === 'MKT_CAMPAIGN_VALIDATION');
    assert.deepEqual((await settings.readForbiddenSegmentFields(A, t)).sort(), [...PROHIBITED].sort());
    await upsertSetting(settings.FORBIDDEN_KEY, 'renda_exata, profissao', A, A.userId, t);
    await refused(save(t, A, { profissao: 'x' }));
    await assert.rejects(save(t, A, { cpf: 'x' }), (e) => e.code === 'MKT_CAMPAIGN_VALIDATION', 'cpf saiu da lista desta empresa, mas segue fora dos campos permitidos');
    await assert.rejects(upsertSetting(settings.FORBIDDEN_KEY, 'Renda Exata!', A, A.userId, t), (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE');
  });
  await withRollbackTenantTransaction(B, async (t) => {
    assert.ok((await settings.readForbiddenSegmentFields(B, t)).includes('profissao') === false, 'a lista de uma empresa não vale para outra');
    await refused(save(t, B, { renda: 1 }));
  });
  assert.ok(SETTINGS_SCHEMA[settings.FORBIDDEN_KEY]);
});
