'use strict';

// Marco 9, M9-D212 — falha transitória com nova tentativa até esgotar, janela de retenção do corpo na fila morta, regressão do webhook do Correspondente.
process.env.PORT = process.env.M9D212_FALHA_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = require('../_helpers/m9d212Env');
const outbox = require('../../../src/engines/events/outbox');
const { purgeWebhookInbox } = require('../../../src/features/integrations/inbox');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

/** Falha transitória em toda tentativa até esgotar integration.inbox.max_attempts; devolve o evento já em fila morta. */
async function esgotar(c, ev) {
  const original = outbox.publishDomainEvent;
  outbox.publishDomainEvent = async () => { throw new Error('banco indisponível (simulado)'); };
  const historico = [];
  try {
    await env.enviar(c, ev);
    for (let i = 0; i < 8; i += 1) {
      const l = await env.linha(tenant, c.provider, ev.id);
      if (l.status === 'DEAD_LETTER') break;
      await env.vencer(tenant, l.id);
      await env.rodar(tenant);
      const depois = await env.linha(tenant, c.provider, ev.id);
      historico.push([depois.status, depois.attempts]);
    }
  } finally {
    outbox.publishDomainEvent = original;
  }
  return { l: await env.linha(tenant, c.provider, ev.id), historico };
}

test('intake_falha_transitoria_retry_e_esgota', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ status: 'DELIVERED' });
  const { l, historico } = await esgotar(c, ev);
  assert.deepEqual(historico.slice(0, 5), [['FAILED', 1], ['FAILED', 2], ['FAILED', 3], ['FAILED', 4], ['FAILED', 5]], 'cada falha agenda nova tentativa');
  assert.deepEqual(historico[5], ['DEAD_LETTER', 6], 'a 6ª tentativa esgota e vai à fila morta');
  assert.equal(l.dead_letter_reason, 'ATTEMPTS_EXHAUSTED');
  assert.equal((await env.outboxDe(tenant, l.id)).length, 0);
  const [erro] = await env.erros(tenant, c.provider, 'ATTEMPTS_EXHAUSTED');
  assert.equal(erro.sanitized_payload.status, 'DELIVERED', 'o erro leva o conteúdo sanitizado (campos do esquema)');
  assert.equal(erro.sanitized_payload.id, ev.id);
});

test('intake_dlq_attempts_exhausted_mantem_raw_pela_janela_e_depois_anula', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ status: 'READ' });
  const { l } = await esgotar(c, ev);
  assert.equal(l.dead_letter_reason, 'ATTEMPTS_EXHAUSTED');
  assert.ok(l.payload_raw, 'causa transitória: o corpo fica para o retry humano');
  await env.antigo(tenant, l.id, 3);
  await env.comTenant(tenant, (t) => purgeWebhookInbox(env.ctxDe(tenant), t));
  assert.ok((await env.linha(tenant, c.provider, ev.id)).payload_raw, 'dentro da janela de 7 dias o corpo continua guardado');
  await env.antigo(tenant, l.id, 8);
  await env.comTenant(tenant, (t) => purgeWebhookInbox(env.ctxDe(tenant), t));
  const depois = await env.linha(tenant, c.provider, ev.id);
  assert.equal(depois.payload_raw, null, 'passada a janela o corpo é anulado');
  assert.equal(depois.payload, null);
  assert.equal(depois.payload_hash, l.payload_hash, 'o hash fica');
  assert.ok((await env.erros(tenant, c.provider, 'ATTEMPTS_EXHAUSTED'))[0].sanitized_payload, 'resta o conteúdo sanitizado no erro');
});

test('intake_correspondente_regressao', () => {
  // Só a bateria do webhook do Correspondente (rollback por teste). O m9d240.webhook grava no banco compartilhado e deixaria a connection de financiamento ativa com segredo de cofre temporário para os testes seguintes.
  const arquivos = ['test/correspondent.webhooks.test.js'];
  const raiz = path.join(__dirname, '..', '..', '..');
  const { NODE_TEST_CONTEXT: _contexto, ...ambiente } = process.env; // sem isso o executor de testes se recusa a rodar arquivos dentro de um teste
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...arquivos], { cwd: raiz, env: { ...ambiente, NODE_ENV: 'test', PORT: require('../_helpers/portaLivre').portaLivre() }, encoding: 'utf8', timeout: 240000 });
  const resumo = `${r.stdout}`.split('\n').filter((x) => /^# (tests|pass|fail)|^ℹ (tests|pass|fail)/.test(x)).join(' | ');
  const passou = Number((/(?:ℹ|#) pass (\d+)/.exec(String(r.stdout)) || [])[1] || 0);
  assert.equal(passou >= 13, true, `a bateria deve rodar os 13 testes do webhook do Correspondente (rodou ${passou}): ${String(r.stdout).slice(-800)} ${String(r.stderr).slice(-800)}`);
  assert.equal(r.status, 0, `a bateria do webhook do Correspondente falhou: ${resumo}\n${String(r.stdout).slice(-1500)}`);
});
