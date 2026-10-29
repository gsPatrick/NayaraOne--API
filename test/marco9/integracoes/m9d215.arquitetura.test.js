'use strict';

// Marco 9, M9-D215 — arquitetura da reconciliação: toda operação perigosa declara como consultar o fornecedor, só o motor de reconciliação e
// o retry humano reabrem um UNKNOWN perigoso, os parâmetros são lidos, os jobs são ligados e a configuração é validada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { OPERATION_POLICY } = require('../../../src/features/integrations/providers/ports/operationPolicy');
const { refusalReason } = require('../../../src/features/integrations/dispatch/dispatchStateMachine');
const { RECONCILE_SETTINGS_SCHEMA, parseIntervals } = require('../../../src/features/integrations/dispatch/reconcile/reconcile.settings');
const { classifyExternalStatus } = require('../../../src/features/integrations/dispatch/reconcile/reconcile.outcome');

const RAIZ = path.join(__dirname, '..', '..', '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
function arquivos(dir) {
  return fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

test('toda_operacao_perigosa_declara_como_reconciliar', () => {
  const perigosas = [];
  Object.entries(OPERATION_POLICY).forEach(([dominio, ops]) => Object.entries(ops).forEach(([nome, def]) => { if (def.opClass === 'DANGEROUS') perigosas.push([dominio, nome, def]); }));
  assert.ok(perigosas.length >= 9);
  perigosas.forEach(([dominio, nome, def]) => {
    if (def.reconcileStrategy === null) {
      assert.ok(['uploadDocument'].includes(nome), `${dominio}.${nome} perigosa sem consulta: só o envio de arquivo de financiamento (sem recurso para consultar)`);
      return;
    }
    const { status } = def.reconcileStrategy;
    assert.ok(status && PORTS[dominio].operations[status], `${dominio}.${nome}: a consulta de status ${status} precisa ser operação do port`);
    assert.equal(PORTS[dominio].operations[nome].reconcileStrategy, def.reconcileStrategy, 'o port expõe a estratégia da operação');
  });
  // Operação segura não tem estratégia: repete com backoff.
  assert.equal(PORTS.MESSAGING.operations.sendText.reconcileStrategy, null);
  assert.deepEqual(PORTS.SOCIAL.operations.publishPost.reconcileStrategy, { key: 'findPostByKey', status: 'getPostStatus', reference: 'findByReference' });
});

test('so_o_motor_de_reconciliacao_reabre_unknown_perigoso', () => {
  assert.ok(refusalReason('UNKNOWN', 'RETRY_WAIT', { criticalityOp: 'DANGEROUS' }), 'sem reconciliação a máquina recusa');
  assert.equal(refusalReason('UNKNOWN', 'RETRY_WAIT', { criticalityOp: 'DANGEROUS', reconciled: true }), null);
  const usos = arquivos('src/features/integrations').filter((f) => /reconciled\s*:\s*true/.test(ler(f)));
  assert.deepEqual(usos.map((f) => path.basename(f)).sort(), ['reconcile.apply.js'], 'só reconcile.apply.js passa reconciled:true');
  assert.ok(refusalReason('DEAD_LETTER', 'RETRY_WAIT', { reconciled: true }), 'a fila morta não sai por reconciliação');
});

test('parametros_da_reconciliacao_declarados_e_lidos', () => {
  const chaves = Object.keys(RECONCILE_SETTINGS_SCHEMA);
  assert.deepEqual(chaves.sort(), ['integration.dispatch.orphan_interval_s', 'integration.unknown.max_reconcile_attempts', 'integration.unknown.reconcile_intervals_s', 'integration.unknown.reconcile_job_interval_s']);
  const leitor = ler('src/features/integrations/dispatch/reconcile/reconcile.params.js');
  chaves.forEach((k) => assert.ok(leitor.includes(`'${k}'`), `${k} é lido`));
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  chaves.forEach((k) => assert.ok(SETTINGS_SCHEMA[k], `${k} está no SETTINGS_SCHEMA`));
  assert.deepEqual(parseIntervals('30,120,600,3600,21600'), [30, 120, 600, 3600, 21600]);
  ['', 'a,b', '30,,5', '0', '-5', '30;60'].forEach((x) => assert.equal(parseIntervals(x), null, `inválido: ${x}`));
  assert.throws(() => RECONCILE_SETTINGS_SCHEMA['integration.unknown.reconcile_intervals_s'].validate('k', '30,x'), (e) => e.code === 'SETTING_INVALID_VALUE');
});

test('jobs_da_reconciliacao_estao_ligados', () => {
  const app = ler('app.js');
  assert.match(app, /startIntegrationReconcileJob\(\)/);
  assert.match(app, /startIntegrationDispatchOrphanJob\(\)/);
  assert.match(ler('src/engines/jobs/integrationReconcileJob.js'), /integration\.unknown\.reconcile_job_interval_s/);
});

test('status_do_fornecedor_para_o_destino_do_envio', () => {
  ['PAID', 'COMPLETED', 'PUBLISHED', 'SIGNED'].forEach((s) => assert.equal(classifyExternalStatus(s), 'CONFIRMED'));
  ['FAILED', 'REJECTED', 'CANCELLED'].forEach((s) => assert.equal(classifyExternalStatus(s), 'FAILED'));
  ['PROCESSING', 'PENDING', 'QUEUED', 'QUALQUER_OUTRO'].forEach((s) => assert.equal(classifyExternalStatus(s), 'IN_PROGRESS'));
});
