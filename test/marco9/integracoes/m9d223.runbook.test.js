'use strict';

// Marco 9, M9-D223 — runbook obrigatório por provider (7 seções preenchidas) e o endpoint de saúde que devolve o runbookPath.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');
const { runConnectionHealthCheck } = require('../../../src/features/integrations/health/healthCheck');
const { SEED_PROVIDERS } = require('../../../src/features/integrations/providers/catalog.providers');
const { RUNBOOK_SECTIONS, runbookPathFor, validateRunbook, assertRunbook } = require('../../../src/features/integrations/health/runbooks');

const RAIZ = path.join(__dirname, '..', '..', '..');
let env;

before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['integration:read']);
  env = await startHttpEnv(Number(process.env.M9D223_HTTP_TEST_PORT) || 21723, [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]);
});
after(async () => {
  if (!env) return;
  setTimeout(() => process.exit(0), 300);
});

test('runbooks_existem_para_todos_os_providers', async () => {
  assert.equal(RUNBOOK_SECTIONS.length, 7);
  const ativos = SEED_PROVIDERS.map((p) => p.code);
  assert.equal(ativos.length, 18);
  const faltando = [];
  for (const codigo of ativos) {
    const arquivo = path.join(RAIZ, runbookPathFor(codigo));
    if (!fs.existsSync(arquivo)) { faltando.push(`${codigo}: arquivo ausente`); continue; }
    const problemas = validateRunbook(fs.readFileSync(arquivo, 'utf8'));
    if (problemas.length) faltando.push(`${codigo}: ${problemas.join('; ')}`);
    assert.doesNotThrow(() => assertRunbook(codigo), `${codigo}`);
  }
  assert.deepEqual(faltando, [], `INTEGRATION_RUNBOOK_MISSING:\n${faltando.join('\n')}`);
  // os providers do catálogo no banco são exatamente os do seed (a plataforma pode cadastrar mais: cada um nasce com o seu runbook)
  const { sequelize } = require('../../../src/models');
  const [rows] = await sequelize.query("SELECT code FROM integration.providers WHERE status = 'ACTIVE' AND code = ANY(ARRAY[:codes]::text[])", { replacements: { codes: ativos } });
  assert.equal(rows.length, ativos.length, 'todo provider do seed está ativo no catálogo e tem runbook');
});

test('runbook_incompleto_e_recusado_com_o_codigo_do_livro', () => {
  const completo = RUNBOOK_SECTIONS.map((s, i) => `## ${i + 1}. ${s}\n\nTexto de verdade da seção ${i + 1}, com mais de uma palavra.\n`).join('\n');
  assert.deepEqual(validateRunbook(`# Runbook\n\n${completo}`), []);
  const semUma = completo.replace(/## 5\. [^\n]*\n\n[^\n]*\n/, '');
  assert.ok(validateRunbook(semUma).some((p) => /Como rotacionar credencial/.test(p)), 'seção ausente apontada pelo nome');
  const vazia = completo.replace(/Texto de verdade da seção 3, com mais de uma palavra\./, '   ');
  assert.ok(validateRunbook(vazia).some((p) => /Diagnóstico/.test(p)), 'seção sem conteúdo');
  const placeholder = completo.replace(/Texto de verdade da seção 2, com mais de uma palavra\./, 'TODO');
  assert.ok(validateRunbook(placeholder).some((p) => /Sintomas/.test(p)), 'TODO não é conteúdo');
  assert.throws(() => assertRunbook('provider-que-nao-existe'), (e) => e.code === 'INTEGRATION_RUNBOOK_MISSING' && /sem runbook completo/.test(e.message));
});

test('health_endpoint_traz_runbook_path', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  const gestor = tokens['A:gestor'];
  const { tenantCI, conexaoAtiva } = require('../_helpers/m9d223Env');
  const tenantA = await tenantCI('A');
  const c = await conexaoAtiva(tenantA, 'MESSAGING');
  const teste = await runConnectionHealthCheck({ groupId: tenantA.groupId, companyId: tenantA.companyId }, c.id);
  assert.deepEqual([teste.status, teste.ok], ['CHECKED', true], 'o sandbox responde ao teste de saúde ativo');
  assert.equal((await call('GET', '/admin/integrations/messaging-sandbox/health')).status, 401);
  assert.equal((await call('GET', '/admin/integrations/messaging-sandbox/health', tokens['A:leitura'])).status, 403, 'sem integration:read');
  const r = await call('GET', '/admin/integrations/messaging-sandbox/health', gestor);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data;
  assert.equal(d.provider, 'messaging-sandbox');
  assert.equal(d.connectionId, c.id);
  assert.equal(d.runbookPath, 'docs/runbooks/integrations/messaging-sandbox.md');
  assert.equal(d.runbookPath, runbookPathFor('messaging-sandbox'), 'o caminho vem do módulo de runbooks');
  assert.ok(fs.existsSync(path.join(RAIZ, d.runbookPath)), 'o caminho devolvido existe no repositório');
  for (const campo of ['healthStatus', 'circuit', 'lastCheck', 'slo', 'environment']) assert.ok(campo in d, `campo ${campo}`);
  assert.deepEqual([d.lastCheck.ok, typeof d.lastCheck.latencyMs, d.circuit.state], [true, 'number', 'CLOSED'], 'último teste, latência e circuito');
  assert.doesNotMatch(JSON.stringify(r.body), /secret_?ref|password|token/i, 'sem segredo na resposta');
  assert.equal((await call('GET', '/admin/integrations/provider-inexistente/health', gestor)).status, 404);
  const outra = await call('GET', '/admin/integrations/messaging-sandbox/health', tokens['B:gestor']);
  assert.ok(outra.status === 404 || outra.body.data.connectionId !== c.id, 'connection de outra empresa não aparece');
});
