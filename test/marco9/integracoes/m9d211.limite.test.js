'use strict';

// Marco 9, M9-D211 — limite WEBHOOK por IP e fornecedor sobre o contador compartilhado da M9-D843, antes de consultar a connection e com falha fechada.
process.env.PORT = process.env.M9D211_LIMITE_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const env = require('../_helpers/m9d211Env');
const { scopeKeyOf, platformCeiling } = require('../../../src/features/integrations/webhooks/webhooks.rateLimit');
const counter = require('../../../src/features/core-governance/api-governance/standards/rateLimit.counter');

let tenant;
let desligarCofre;
const HITS = path.join(__dirname, '../_helpers/m9d843Hits.js');
// O IP que o servidor enxerga na chamada local pode vir nas duas formas.
const IPS = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const filho = (chave, n) => new Promise((resolve, reject) => {
  execFile(process.execPath, [HITS, chave, String(n)], { env: process.env }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out.trim()))));
});

async function comLimiteLigado(fn) {
  process.env.API_RATE_LIMIT_ENABLED = 'true';
  try { return await fn(); } finally { delete process.env.API_RATE_LIMIT_ENABLED; }
}

test('webhook_rate_limit_compartilhado_d843_antes_da_connection', async () => {
  await comLimiteLigado(async () => {
    const provider = `qa-limite-${env.uniqueSuffix()}`.slice(0, 40).toLowerCase();
    const teto = platformCeiling();
    const metade = Math.ceil(teto / 2) + 1;
    // dois processos somam o MESMO contador do banco: nenhum passa do teto sozinho, juntos passam
    for (const ip of IPS) {
      const [a, b] = await Promise.all([filho(scopeKeyOf(ip, provider), metade), filho(scopeKeyOf(ip, provider), metade)]);
      assert.ok(metade <= teto && Math.max(a.last, b.last) <= metade * 2, 'cada processo sozinho fica abaixo do teto; só a soma passa dele');
    }
    const corpo = Buffer.from('{"id":"x","type":"t.e"}');
    // A janela do contador é de 60 s pelo relógio do banco: se virar no meio da semeadura, semeia de novo (no máximo 3 vezes).
    // A contagem de "canal desconhecido" é lida antes de CADA tentativa: a tentativa que caiu na janela nova passa do limite e consulta a
    // connection (conta um desconhecido, como deve); a prova vale para a tentativa que recebeu 429.
    let r;
    let antes;
    for (let i = 0; i < 3 && !(r && r.status === 429); i += 1) {
      if (i > 0) for (const ip of IPS) await Promise.all([filho(scopeKeyOf(ip, provider), metade), filho(scopeKeyOf(ip, provider), metade)]);
      antes = await env.desconhecidos('(desconhecido)');
      r = await env.postar(`/v1/webhooks/${provider}/${'q'.repeat(32)}`, corpo, {});
    }
    assert.equal(r.status, 429, 'acima do teto responde 429 antes de olhar a connection');
    assert.equal(r.json.error.code, 'INTEGRATION_RATE_LIMITED');
    assert.ok(Number(r.headers.get('retry-after')) >= 1, 'informa em segundos quando tentar de novo');
    assert.equal(await env.desconhecidos('(desconhecido)'), antes, 'a connection nem foi consultada: nada contado como canal desconhecido');
    // outro fornecedor não é afetado
    const livre = await env.postar(`/v1/webhooks/outro-${env.uniqueSuffix().toLowerCase()}/${'q'.repeat(32)}`, corpo, {});
    assert.equal(livre.status, 404);
  });
});

test('webhook_rate_limit_falha_fechada_sem_contador', async () => {
  await comLimiteLigado(async () => {
    const original = counter.hit;
    counter.hit = async () => { throw new Error('banco do contador fora'); };
    try {
      const r = await env.postar(`/v1/webhooks/messaging-sandbox/${'w'.repeat(32)}`, Buffer.from('{}'), {});
      assert.equal(r.status, 503, 'rota pública sem contador recusa, não deixa passar');
      assert.equal(r.json.error.code, 'INTEGRATION_RATE_LIMIT_UNAVAILABLE');
    } finally { counter.hit = original; }
  });
});

test('webhook_rate_limit_da_empresa_aperta_o_teto', async () => {
  await comLimiteLigado(async () => {
    const c = await env.criarCanal(tenant);
    const settings = require('../../../src/features/settings/settings.service');
    await env.comTenant(tenant, (t) => settings.upsertSetting('integration.webhook.rate_limit_per_minute', 10, tenant, tenant.userId, t));
    try {
      const corpo = Buffer.from(`{"id":"evt-lim-${env.uniqueSuffix()}","type":"t.e"}`);
      let r;
      for (let i = 0; i < 3 && !(r && r.status === 429); i += 1) {
        await Promise.all(IPS.map((ip) => filho(scopeKeyOf(ip, c.provider), 11)));
        r = await env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, corpo, env.assinar(c.segredo, corpo));
      }
      assert.equal(r.status, 429, 'o parâmetro da empresa (10 por minuto) vale depois que o canal identifica a empresa');
      assert.equal(r.json.error.code, 'INTEGRATION_RATE_LIMITED');
    } finally {
      await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.webhook.rate_limit_per_minute'", { c: tenant.companyId });
    }
  });
});
