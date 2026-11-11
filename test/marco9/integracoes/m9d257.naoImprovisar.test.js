'use strict';

// Marco 9, M9-D257 — as 7 guardas automáticas do "Não improvisar" (Guia §13): cada uma passa no código real e FALHA diante de uma violação sintética, com arquivo e linha.
// Lê código-fonte; não usa banco. A lista de exceções começa vazia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const na = require('../../../scripts/lib/naoImprovisar');
const { arvore, chaveAws } = require('../_helpers/m9d257Fixture');

const [g1, g2, g3, g4, g5, g6, g7] = na.guards;
const RAIZ = path.join(__dirname, '..', '..', '..');
const limpo = (g, opts) => assert.deepEqual(g.scan(opts), [], `${g.name} deve passar no código real`);
const acha = (violacoes, arquivo, linha) => violacoes.find((v) => v.file === arquivo && v.line === linha && v.code === 'ARCH_RULE_VIOLATION');

test('nao_improvisar_1_sdk_fora_do_adapter', () => {
  limpo(g1);
  const raiz = arvore({
    'src/features/crm/servico.js': "'use strict';\n\nconst twilio = require(\"twilio\");\nmodule.exports = twilio;\n",
    'src/features/integrations/providers/messaging/real/twilio.adapter.js': "'use strict';\nconst twilio = require('twilio');\nmodule.exports = twilio;\n",
  });
  const v = g1.scan({ root: raiz });
  assert.ok(acha(v, 'src/features/crm/servico.js', 3), 'SDK importado num serviço de domínio reprova, com arquivo e linha');
  assert.equal(v.length, 1, 'o mesmo pacote dentro de providers/** é permitido');
  assert.equal(v[0].rule, 1);
});

test('nao_improvisar_2_segredo_fora_do_cofre', () => {
  limpo(g2);
  const raiz = arvore({
    '.env.example': `PORT=4001\nAWS_ACCESS_KEY_ID=${chaveAws()}\n`,
    'src/models/IntegrationFalso.js': "'use strict';\nmodule.exports = () => ({\n  apiToken: { type: 'STRING', field: 'api_token' },\n  secretRef: { type: 'STRING', field: 'secret_ref' },\n  secretExpiresAt: { type: 'DATE', field: 'secret_expires_at' },\n});\n",
    'migrations/20260101000999-falso.js': "'use strict';\nmodule.exports = { up: (q) => q.sequelize.query(`CREATE TABLE \"integration\".\"falso\" (\n  id uuid,\n  client_password varchar(80),\n  secret_ref varchar(160)\n);`) };\n",
    'src/features/integrations/registry/connections.service.js': "'use strict';\nmodule.exports = { criar: () => null };\n",
  });
  const v = g2.scan({ root: raiz });
  assert.ok(acha(v, '.env.example', 2), 'padrão de segredo no .env de exemplo');
  assert.ok(acha(v, 'src/models/IntegrationFalso.js', 3), 'coluna api_token numa tabela de integração');
  assert.ok(!v.some((x) => x.file === 'src/models/IntegrationFalso.js' && x.line > 3), 'secret_ref e secret_expires_at são só referência e rastro');
  assert.ok(acha(v, 'migrations/20260101000999-falso.js', 4), 'coluna client_password criada em tabela de integração');
  assert.ok(v.some((x) => x.file === 'src/features/integrations/registry/connections.service.js'), 'o cadastro sem validar o formato da referência do cofre');
});

test('nao_improvisar_3_webhook_sem_autenticacao', () => {
  limpo(g3);
  const raiz = arvore({
    'src/routes/novo.js': "'use strict';\nconst router = require('express').Router();\nrouter.post('/v1/novo/webhooks/evento', controller.receber);\nrouter.post('/v1/ok/webhooks/evento', ...integrationWebhooks.legacyAlias('ok', controller.receber));\nrouter.post('/v1/interna/signatures/:id/webhook', requirePermission('legal:sign'), controller.interna);\n",
    'src/features/integrations/webhooks/webhooks.handler.js': "'use strict';\nmodule.exports = { receiveWebhook: () => null };\n",
  });
  const v = g3.scan({ root: raiz });
  assert.ok(acha(v, 'src/routes/novo.js', 3), 'rota nova sem verificador de assinatura reprova');
  assert.ok(!v.some((x) => x.file === 'src/routes/novo.js' && x.line !== 3), 'o alias do framework e a rota autenticada passam');
  assert.ok(v.some((x) => x.file.endsWith('webhooks.handler.js')), 'o tratador único precisa chamar o verificador');
});

test('nao_improvisar_4_retry_cego_apos_timeout', () => {
  limpo(g4);
  // O motor real classifica timeout de operação perigosa como UNKNOWN; um classificador que o trate como transitório (repetir às cegas) reprova.
  const cego = () => ({ class: 'TRANSIENT', code: 'ETIMEDOUT' });
  assert.ok(g4.scan({ classify: cego }).some((x) => x.rule === 4 && x.file.endsWith('retry.classify.js')));
  const raiz = arvore({ 'src/features/integrations/providers/bank/falso/falso.adapter.js': "'use strict';\nasync function enviar(c) {\n  for (let attempt = 0; attempt < 3; attempt += 1) {\n    try { return await c.post('/pagar'); } catch (e) { /* repete */ }\n  }\n}\nmodule.exports = { enviar };\n" });
  const v = g4.scan({ root: raiz });
  assert.ok(acha(v, 'src/features/integrations/providers/bank/falso/falso.adapter.js', 3), 'laço de repetição manual dentro de um provider');
});

test('nao_improvisar_5_dto_interno_completo', () => {
  limpo(g5);
  const raiz = arvore({
    'src/features/integrations/providers/portal/falso/falso.adapter.js': "'use strict';\nfunction montar(row) {\n  return row.toJSON();\n}\nmodule.exports = { montar };\n",
    'src/features/crm/envio.js': "'use strict';\nasync function enviar(dispatchService, person) {\n  return dispatchService.enqueue({ payload: { ...person }, operation: 'sendText' });\n}\nmodule.exports = { enviar };\n",
    'src/features/crm/ok.js': "'use strict';\nasync function enviar(dispatchService, texto) {\n  return dispatchService.enqueue({ payload: { to: texto }, operation: 'sendText' });\n}\nmodule.exports = { enviar };\n",
  });
  const v = g5.scan({ root: raiz });
  assert.ok(acha(v, 'src/features/integrations/providers/portal/falso/falso.adapter.js', 3), 'o adapter serializa a entidade inteira');
  assert.ok(acha(v, 'src/features/crm/envio.js', 3), 'a entidade espalhada no payload do envio');
  assert.ok(!v.some((x) => x.file === 'src/features/crm/ok.js'));
});

test('nao_improvisar_6_http_sucesso_nao_e_fato_financeiro', () => {
  limpo(g6);
  const OP = require('../../../src/features/integrations/providers/ports/operationPolicy').OPERATION_POLICY;
  const frouxa = { BANK: { ...OP.BANK, submitPayment: { ...OP.BANK.submitPayment, confirmation: 'ON_RESPONSE' } } };
  assert.ok(g6.scan({ policy: frouxa }).some((x) => x.rule === 6 && x.file.endsWith('operationPolicy.js')), 'BANK perigoso confirmado pela resposta HTTP');
  const raiz = arvore({
    'src/modules/finance/application/services/falso.service.js': "'use strict';\nconst bank = require('./bank-hub');\nasync function pagar(intent) {\n  await bank.callBankSubmit(intent);\n  intent.status = 'CONFIRMED';\n}\nmodule.exports = { pagar };\n",
    'src/modules/finance/application/services/bom.service.js': "'use strict';\nconst bank = require('./bank-hub');\nasync function confirmar(intent) {\n  await bank.applyStatusToDispatch(intent, 'PAID');\n  intent.status = 'CONFIRMED';\n}\nmodule.exports = { confirmar };\n",
    'src/modules/finance/application/services/manual.service.js': "'use strict';\nasync function baixar(intent) {\n  intent.status = 'EXECUTED';\n}\nmodule.exports = { baixar };\n",
  });
  const v = g6.scan({ root: raiz });
  assert.ok(acha(v, 'src/modules/finance/application/services/falso.service.js', 5), 'pagamento marcado pago logo depois do HTTP do banco');
  assert.ok(!v.some((x) => x.file.endsWith('bom.service.js') || x.file.endsWith('manual.service.js')));
});

test('nao_improvisar_7_integracao_sem_health_runbook_contrato', () => {
  limpo(g7);
  assert.ok(Array.isArray(g7.scan.pendentes), 'as famílias com suíte pendente por demanda aparecem à parte (a lista da M9-D222 só encolhe e pode chegar a vazia, quando todas têm suíte)');
  const deps = {
    registry: { list: () => [{ providerCode: 'novo-sandbox' }], instantiate: () => ({}) },
    contract: { coverage: () => ({ pending: [], uncovered: ['novo-sandbox'], withoutApi: [] }) },
    assertRunbook: () => { throw Object.assign(new Error('falta'), { details: { problemas: ['sem seção Rollback'] } }); },
    readReport: () => null,
  };
  const v = g7.scan({ deps });
  assert.ok(v.some((x) => /sem healthCheck/.test(x.message)), 'sem healthCheck');
  assert.ok(v.some((x) => /runbook/.test(x.message) && /Rollback/.test(x.message)), 'sem runbook completo');
  assert.ok(v.some((x) => /relatório de contrato verde/.test(x.message)), 'sem relatório de contrato verde');
  assert.ok(v.some((x) => /sem suíte de contrato e sem pendência/.test(x.message)), 'adapter novo fora da cobertura da M9-D222');
  assert.ok(v.every((x) => x.rule === 7 && x.file && x.line >= 1));
});

test('nao_improvisar_lista_de_excecoes_vazia_e_violacao_sintetica_derruba_o_portao', () => {
  // A lista de exceções do repositório começa (e segue) vazia; item sem aprovação do Patrick é violação.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts/lib/naoImprovisar/excecoes.json'), 'utf8')).excecoes, []);
  const dir = arvore({ 'excecoes.json': JSON.stringify({ excecoes: [{ rule: 1, file: 'src/features/crm/servico.js', reason: 'teste' }] }) });
  const { invalidas } = na.loadExceptions(path.join(dir, 'excecoes.json'));
  assert.equal(invalidas.length, 1, 'exceção sem approvedBy reprova');
  const aprovada = arvore({ 'excecoes.json': JSON.stringify({ excecoes: [{ rule: 1, file: 'src/features/crm/servico.js', line: 3, reason: 'migração', approvedBy: 'Patrick' }] }) });
  const raiz = arvore({ 'src/features/crm/servico.js': "'use strict';\n\nconst twilio = require('twilio');\n" });
  assert.equal(na.runGuard(g1, { root: raiz }).length, 1);
  assert.equal(na.runGuard(g1, { root: raiz, excecoes: path.join(aprovada, 'excecoes.json') }).length, 0, 'com exceção aprovada (approvedBy) a violação não reprova');
  // O portão de CI imprime arquivo e linha e sai com 1; no código real sai com 0.
  const ruim = spawnSync('node', ['scripts/checkNaoImprovisar.js', '--raiz', raiz], { cwd: RAIZ, encoding: 'utf8' });
  assert.equal(ruim.status, 1);
  assert.match(ruim.stderr, /ARCH_RULE_VIOLATION Regra de arquitetura de integrações violada/);
  assert.match(ruim.stderr, /src\/features\/crm\/servico\.js:3 \[ARCH_RULE_VIOLATION\] regra 1/);
  assert.equal(spawnSync('node', ['scripts/checkNaoImprovisar.js'], { cwd: RAIZ, encoding: 'utf8' }).status, 0);
  // A esteira (etapa 1) e o package.json rodam o portão.
  const etapa1 = JSON.stringify(JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts/int-ci/estagios.json'), 'utf8')).etapas[0].comandos);
  assert.match(etapa1, /guard:nao-improvisar/);
  assert.match(JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).scripts['guard:nao-improvisar'], /checkNaoImprovisar\.js/);
});
