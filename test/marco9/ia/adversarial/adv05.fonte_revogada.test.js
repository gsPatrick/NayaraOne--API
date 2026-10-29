'use strict';

// Suíte adversarial da NAY (M9-D042), teste 5 do livro. Dona: M9-D024. Provider sandbox, banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); });
after(async () => { await F.sequelize.close(); });

test('adv_fonte_revogada_nao_usada_como_vigente', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await F.cenarioRag(tenantA, tx);
    const v1 = await F.documento(tenantA, tx, F.DOCUMENTOS.politicaV1, { status: 'REVOKED' });
    const v2 = await F.documento(tenantA, tx, F.DOCUMENTOS.politicaV2, { version: 2 });
    const res = await F.H.rodar(c, 'qual o desconto máximo da política de desconto? [[RESPOSTA:O desconto máximo é de 7% [1].]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.match(res.answer, /7%/);
    assert.doesNotMatch(res.answer, /5%/);
    const fontes = await F.H.fontes(res.runId, tx);
    const de = (id) => fontes.find((f) => f.source_ref === id);
    assert.equal(de(v2.sourceId).used_in_answer, true);
    assert.equal(de(v1.sourceId).used_in_answer, false, 'v1 fica registrada como não usada');
    assert.equal(de(v1.sourceId).status_at_retrieval, 'REVOGADA');
  });
});
