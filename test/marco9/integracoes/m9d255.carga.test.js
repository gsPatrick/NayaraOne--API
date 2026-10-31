'use strict';

// Marco 9, M9-D255 3.3 — teste de carga das integrações contra os sandboxes (HTTP real para os webhooks, worker real para os envios). Roda em banco descartável (COMMITA).
process.env.PORT = process.env.M9D255_CARGA_PORT || require('../_helpers/portaLivre').portaLivre();
process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE = '100000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../_helpers/m9d255Env');
const { readLoadParams, loadVolume, PADROES } = require('../../../src/features/integrations/load/load.params');
const { executarCarga } = require('../../../scripts/int-load/executar');
const { gravarRelatorio } = require('../../../scripts/int-load/relatorio');

let tenant;
let relatorio;
let desligarCofre;
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d255-carga-'));
const PEQUENO = { webhooksPerS: 2, dispatchesPerS: 1, durationMin: 1, duplicatePercent: 10, concurrency: 10 };

before(async () => {
  ({ tenant } = await env.carregarTenants());
  desligarCofre = env.useTempSecretStore();
  relatorio = await executarCarga(env, tenant, loadVolume(PEQUENO), { prazoMs: 120000 });
});
after(async () => { desligarCofre(); await env.limparPendentes(tenant); await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = 'messaging-sandbox' AND status = 'ACTIVE'", { c: tenant.companyId }); fs.rmSync(pasta, { recursive: true, force: true }); await env.sequelize.close(); process.exit(0); });

test('carga_webhooks_sem_perda', async () => {
  const w = relatorio.webhooks;
  assert.equal(w.enviados, 120, '2 por segundo durante 1 minuto');
  assert.deepEqual([w.distintos, w.repetidos], [108, 12]);
  assert.equal(w.aceitos, 108, 'cada evento distinto foi aceito uma vez');
  assert.equal(w.devolvidosComoDuplicados, 12, 'a reentrega do fornecedor volta como duplicada, sem nova linha');
  assert.equal(w.linhasNaInbox, w.esperadoNaInbox, 'contagem da inbox = enviados menos repetidos');
  assert.equal(w.linhasNaInbox, 108);
  assert.deepEqual([relatorio.totais.webhooksPerdidos, relatorio.totais.webhooksDuplicados], [0, 0], JSON.stringify(relatorio.violacoes));
  // O volume do livro vem dos parâmetros: 50/s e 20/s por 5 min = 15.000 webhooks e 6.000 envios.
  const livro = loadVolume(PADROES);
  assert.deepEqual([livro.webhooks.total, livro.dispatches.total], [15000, 6000]);
  const lido = await env.comTenant(tenant, (t) => readLoadParams(tenant, t));
  assert.deepEqual(lido, PADROES, 'sem configuração da empresa valem os padrões do parametros.csv');
  await env.config(tenant, 'integration.load.webhooks_per_s', 7);
  assert.equal((await env.comTenant(tenant, (t) => readLoadParams(tenant, t))).webhooksPerS, 7, 'o parâmetro da empresa muda o tamanho da carga');
  await env.limparConfig(tenant, ['integration.load.webhooks_per_s']);
  // Relatório arquivado.
  const arquivo = gravarRelatorio(relatorio, pasta);
  const gravado = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  assert.deepEqual([gravado.ok, gravado.totais.webhooksPerdidos], [true, 0]);
  assert.ok(!/postgres|password|secret/i.test(JSON.stringify(gravado)), 'o relatório não leva segredo nem conexão');
});

test('carga_dispatch_sem_duplicata', async () => {
  const d = relatorio.dispatches;
  assert.equal(d.pedidos, 60, '1 por segundo durante 1 minuto');
  assert.deepEqual([d.distintos, d.repetidos], [54, 6]);
  assert.equal(d.criados, 54, 'repetir a intenção devolve o mesmo envio, não cria outro');
  assert.equal(d.enviosNoBanco, 54, 'um envio por chave de idempotência');
  assert.equal(relatorio.totais.dispatchesDuplicados, 0, JSON.stringify(relatorio.violacoes.dispatchesDuplicados));
  assert.equal(relatorio.totais.dispatchesPerdidos, 0, JSON.stringify(relatorio.violacoes.dispatchesPerdidos));
  assert.equal(relatorio.totais.filaNaoDrenada, 0, 'fila totalmente drenada ao fim');
  assert.equal(d.filaDrenada, true);
  assert.ok(d.rodadasDoWorker >= 2, 'duas rodadas do worker ao mesmo tempo');
  assert.equal(relatorio.ok, true);
});
