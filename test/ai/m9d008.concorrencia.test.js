'use strict';

// M9-D008 — duas homologações simultâneas de versões do mesmo fact_key são serializadas (advisory lock + FOR UPDATE): sobra UMA
// só versão HOMOLOGATED e nenhuma falha por violação de unicidade. Commita dados: só roda no cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../testHelpers');
const knowledge = require('../../src/modules/ai/knowledge');
const { sequelize, q, uid, carregarPessoas, ctxDe, prepararTenants } = require('../helpers/aiRuns');

const SKIP = process.env.DISPOSABLE_DB === '1' ? false : 'precisa do cluster descartável (nunca commitar no banco do .env)';
let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

test('m9d008_uma_homologada_por_fact_key_concorrente', { skip: SKIP }, async () => {
  const factKey = `politica.concorrente.${uid().slice(0, 8)}`;
  const autor = ctxDe(tenantA);
  const aprovador1 = ctxDe(tenantA);
  const aprovador2 = ctxDe(tenantA);
  const ids = [];
  await withTenantTransaction(tenantA, async (tx) => {
    for (let i = 1; i <= 2; i += 1) {
      ids.push((await knowledge.createEntry(autor, { factKey, subjectType: 'politica', title: `v${i}`, value: { n: i }, classification: 'INTERNAL' }, tx)).id);
    }
  });
  const resultados = await Promise.allSettled([
    withTenantTransaction(tenantA, (tx) => knowledge.homologate(aprovador1, ids[0], tx)),
    withTenantTransaction(tenantA, (tx) => knowledge.homologate(aprovador2, ids[1], tx)),
  ]);
  // Uma ordem possível supera a v1 pela v2; a outra recusa a v1 por já existir a v2 (nunca erro de unicidade).
  for (const r of resultados) {
    if (r.status === 'rejected') assert.equal(r.reason.code, 'AI_KNOWLEDGE_STALE_VERSION', String(r.reason && r.reason.message));
  }
  const linhas = await withTenantTransaction(tenantA, (tx) => q('SELECT version, status FROM ai.knowledge_entries WHERE fact_key = :k ORDER BY version', { k: factKey }, tx));
  assert.equal(linhas.filter((l) => l.status === 'HOMOLOGATED').length, 1, JSON.stringify(linhas));
  assert.equal(linhas.find((l) => l.version === 2).status, 'HOMOLOGATED', 'a versão mais nova é a que sobra');
});
