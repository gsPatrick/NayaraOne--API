'use strict';

// M9-D009 — rotas /v1/ai/memories: gravar, listar, invalidar, corrigir, DELETE recusado, permissões, idempotência e isolamento.
// Só roda no cluster descartável (login real dos usuários do seed de dois tenants; nunca chama MFA nem forja token).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  await grant('CI LEITURA', ['ai:use']);
  env = await startHttpEnv(Number(process.env.M9D009_HTTP_TEST_PORT) || 21709, [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]);
});
after(async () => {
  if (!env) return;
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['B:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

const decisao = (sourceId, extra = {}) => ({
  type: 'DECISION', scope: 'COMPANY', sourceType: 'KNOWLEDGE_ENTRY', sourceId, subjectType: 'Property', subjectId: 'aurora',
  value: { decision: 'prioridade: Aurora' }, ...extra,
});

test('m9d009_http_ciclo_salvar_invalidar_corrigir_e_historico', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  const gestor = tokens['A:gestor']; const leitura = tokens['A:leitura'];
  assert.equal((await call('GET', '/ai/memories', gestor)).status, 503, 'chave geral desligada');
  for (const t of [gestor, tokens['B:gestor']]) assert.equal((await call('PUT', '/settings/ia.habilitada', t, { value: true })).status, 200);
  assert.equal((await call('GET', '/ai/memories')).status, 401);
  const origem = await call('POST', '/ai/knowledge', gestor, { factKey: `memoria.origem.${Date.now()}`, subjectType: 'politica', title: 'Origem', value: { a: 1 }, classification: 'INTERNAL' });
  assert.equal(origem.status, 201, JSON.stringify(origem.body));
  const src = origem.body.data.id;

  const criada = await call('POST', '/ai/memories', gestor, decisao(src));
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  const m = criada.body.data;
  assert.equal(m.status, 'ACTIVE'); assert.equal(m.version, 1); assert.ok(m.expiresAt);
  assert.equal((await call('GET', `/ai/memories/${m.id}`, gestor)).body.data.value.decision, 'prioridade: Aurora');
  assert.ok((await call('GET', '/ai/memories?subjectType=Property&subjectId=aurora', leitura)).body.data.some((x) => x.id === m.id));

  // Recusas com código e mensagem em português.
  const livre = await call('POST', '/ai/memories', gestor, decisao(src, { value: { text: 'x'.repeat(4000) } }));
  assert.equal(livre.status, 422); assert.equal(livre.body.error.code, 'AI_MEMORY_FREE_TEXT_BLOCKED');
  assert.equal(livre.body.error.message, 'Memória só aceita fatos estruturados, não a conversa inteira.');
  const tipo = await call('POST', '/ai/memories', gestor, decisao(src, { type: 'CONVERSA' }));
  assert.equal(tipo.status, 400); assert.equal(tipo.body.error.code, 'AI_MEMORY_TYPE_INVALID');
  const sem = await call('POST', '/ai/memories', gestor, decisao(null));
  assert.equal(sem.status, 400); assert.equal(sem.body.error.code, 'AI_MEMORY_SOURCE_REQUIRED');
  const pref = await call('POST', '/ai/memories', leitura, decisao(src, { type: 'COMPANY_PREFERENCE', value: { preference: 'x' } }));
  assert.equal(pref.status, 403);

  // Idempotência: a segunda chamada devolve a mesma memória com 200.
  const chave = { 'Idempotency-Key': `idem-${Date.now()}` };
  const i1 = await call('POST', '/ai/memories', gestor, decisao(src, { subjectId: 'idem' }), chave);
  const i2 = await call('POST', '/ai/memories', gestor, decisao(src, { subjectId: 'idem' }), chave);
  assert.equal(i1.status, 201); assert.equal(i2.status, 200); assert.equal(i2.body.data.id, i1.body.data.id);

  // Corrigir: nova versão; a antiga some da lista de vigentes e fica no histórico.
  const corr = await call('POST', `/ai/memories/${m.id}/correct`, gestor, { value: { decision: 'prioridade: Boa Vista' } });
  assert.equal(corr.status, 201, JSON.stringify(corr.body));
  assert.equal(corr.body.data.version, 2); assert.equal(corr.body.data.supersedesId, m.id);
  assert.equal((await call('GET', '/ai/memories?status=SUPERSEDED', gestor)).body.data.find((x) => x.id === m.id).status, 'SUPERSEDED');
  assert.equal((await call('POST', `/ai/memories/${m.id}/correct`, gestor, { value: { decision: 'x' } })).body.error.code, 'AI_MEMORY_NOT_ACTIVE');

  // Invalidar: motivo obrigatório; quem só tem ai:use não invalida a memória de outra pessoa.
  const v2 = corr.body.data.id;
  assert.equal((await call('POST', `/ai/memories/${v2}/invalidate`, leitura, { reason: 'não é minha' })).status, 403);
  assert.equal((await call('POST', `/ai/memories/${v2}/invalidate`, gestor, {})).body.error.code, 'AI_MEMORY_INVALID');
  const inv = await call('POST', `/ai/memories/${v2}/invalidate`, gestor, { reason: 'Informação errada' });
  assert.equal(inv.status, 200, JSON.stringify(inv.body)); assert.equal(inv.body.data.status, 'INVALIDATED');
  const vigentes = (await call('GET', '/ai/memories?subjectType=Property&subjectId=aurora', gestor)).body.data;
  assert.ok(!vigentes.some((x) => x.id === v2 || x.id === m.id), 'invalidada e substituída não aparecem como vigentes');
  assert.ok((await call('GET', '/ai/memories?status=INVALIDATED', gestor)).body.data.some((x) => x.id === v2), 'continua no histórico');
});

test('m9d009_http_delete_recusado_e_isolamento_entre_empresas', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  const gestor = tokens['A:gestor'];
  const origem = await call('POST', '/ai/knowledge', gestor, { factKey: `memoria.iso.${Date.now()}`, subjectType: 'politica', title: 'Origem', value: { a: 1 }, classification: 'INTERNAL' });
  const m = (await call('POST', '/ai/memories', gestor, decisao(origem.body.data.id, { subjectId: 'iso' }))).body.data;
  const del = await call('DELETE', `/ai/memories/${m.id}`, gestor);
  assert.equal(del.status, 409); assert.equal(del.body.error.code, 'AI_MEMORY_DELETE_FORBIDDEN');
  assert.equal(del.body.error.message, 'Memória não é apagada; invalide-a.');
  assert.equal((await call('GET', `/ai/memories/${m.id}`, gestor)).status, 200, 'continua lá');
  // Empresa B: 404 sem revelar existência, lista sem a linha, e não invalida nem corrige.
  const b = tokens['B:gestor'];
  assert.equal((await call('GET', `/ai/memories/${m.id}`, b)).status, 404);
  assert.equal((await call('POST', `/ai/memories/${m.id}/invalidate`, b, { reason: 'tentativa' })).status, 404);
  assert.equal((await call('POST', `/ai/memories/${m.id}/correct`, b, { value: { decision: 'x' } })).status, 404);
  assert.ok(!(await call('GET', '/ai/memories?status=ACTIVE', b)).body.data.some((x) => x.id === m.id));
  // Origem da empresa A não vale para a empresa B.
  assert.equal((await call('POST', '/ai/memories', b, decisao(origem.body.data.id))).body.error.code, 'AI_MEMORY_SOURCE_INVALID');
});
