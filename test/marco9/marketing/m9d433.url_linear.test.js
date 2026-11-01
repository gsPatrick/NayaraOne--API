'use strict';

// M9-D433 (reabertura da rodada 4: G-1, M-1, M-3, L-1, L-4, L-6) — o extrator de URL é uma TOKENIZAÇÃO LINEAR: nenhum separador é listado, a varredura de texto grande
// é linear, número legal (CNPJ, decreto, processo) não é endereço, encurtador real nunca é abreviação e as listas configuradas não afrouxam a base.
// A parte pura roda sem banco; o fechamento por ponto de saída roda em Postgres real (rollback).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { factualResult } = require('../_helpers/mktFactualEnv');
const fx = require('../_helpers/m9d431Fixtures');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const security = require('../../../src/features/marketing/security');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });

const kinds = (texto, config) => security.extractCandidates(texto, config).map((c) => `${c.kind}:${c.url}`);
// Cada caractere abaixo, colado antes do domínio, depois dele ou como fronteira, não esconde o endereço. Nenhum é listado no extrator: qualquer não-domínio é fronteira.
const COLADOS = ['–', '—', '{', '}', '~', '^', '?', '#', '$', '%', '&', '+', '‮', '‎', '͏', '︎', '=', '*', '·', '•', '→', '»', '€', '£', '¿', '§', '¬', '∕'];

test('qualquer_caractere_colado_ao_dominio_e_fronteira_e_o_endereco_continua_extraido', () => {
  for (const c of COLADOS) {
    for (const texto of [`Acesse${c}evil.com/login`, `Acesse ${c}evil.com/login`, `Acesse evil.com/login${c}`]) {
      const hits = security.extractCandidates(texto).filter((h) => h.kind === 'HOSTILE');
      assert.ok(hits.some((h) => h.url.includes('evil.com/login')), `${JSON.stringify(texto)} -> ${JSON.stringify(hits)}`);
    }
  }
});

test('invisiveis_entidades_e_percentuais_nao_escondem_o_endereco', () => {
  for (const t of ['evil.com‎/login', 'ev‏il.com/x', 'evil︎.com/x', 'evil͏.com/x', 'ev⁦il.com/x', 'evil.com%2Flogin', 'evil%2Ecom/x', 'evil&#46;com/x', 'evil&period;com&sol;x', 'evil.com./login', 'ｅｖｉｌ.ｃｏｍ/ｘ']) {
    assert.equal(security.extractCandidates(t).filter((h) => h.kind === 'HOSTILE').length, 1, JSON.stringify(t));
  }
});

test('numero_legal_nao_e_endereco_e_nao_bloqueia_nem_vai_a_revisao', () => {
  for (const t of ['Nayara Ltda, CNPJ 12.345.678/0001-90', 'Decreto 10.123/19', 'Contrato 2020.123/45', 'Processo 12.345.678/9', 'Inscrição 123.456.7890/001', 'R$ 1.500/mês', 'Lei 8.245/91', 'Art. 10.2/3', 'versão 2.3.4']) {
    assert.deepEqual(security.extractCandidates(t), [], t);
  }
  assert.deepEqual(kinds('Veja 127.1/x'), ['HOSTILE:127.1/x']);
  assert.deepEqual(kinds('Veja 2130706433'), ['HOSTILE:2130706433'], 'decimal longo que aponta para a própria máquina, mesmo sem caminho');
  assert.deepEqual(kinds('Veja 0x7f000001'), ['HOSTILE:0x7f000001'], 'hexadecimal sem caminho');
  assert.deepEqual(kinds('Veja 0177.0.0.1'), ['HOSTILE:0177.0.0.1'], 'octal');
  assert.deepEqual(security.extractCandidates('Protocolo 1234567'), [], 'número comum de 7 dígitos não é endereço');
});

test('encurtador_real_nunca_e_abreviacao_e_a_lista_configurada_nao_afrouxa_a_base', () => {
  for (const t of ['Rb.gy/Abc12', 'Veja Rb.gy/Abc12', 'Bit.ly/x', 'T.ly/x', 'S.id/x', 'tinyurl.com/x']) assert.equal(security.extractCandidates(t)[0].kind, 'HOSTILE', t);
  assert.deepEqual(kinds('Ab.lol/Login'), ['REVIEW:Ab.lol/Login'], 'ambíguo de baixo risco vai à revisão humana, nunca é ignorado');
  // L-4: lista de terminações e de encurtadores do administrador SOMA à base; uma lista curta não transforma evil.Com em abreviação nem rb.gy em ambíguo.
  assert.deepEqual(kinds('Veja evil.Com', { tlds: ['zzz'], shorteners: ['outro.link'], fileExtensions: ['png'] }), ['HOSTILE:evil.Com']);
  assert.deepEqual(kinds('Veja Av.Com', { tlds: ['zzz'] }), ['HOSTILE:Av.Com']);
  assert.deepEqual(kinds('Veja Rb.gy/Abc12', { shorteners: ['outro.link'] }), ['HOSTILE:Rb.gy/Abc12']);
  assert.deepEqual(kinds('Veja outro.link/x', { shorteners: ['outro.link'] }), ['HOSTILE:outro.link/x']);
  assert.deepEqual(kinds('Veja Sr.Zzz', { tlds: ['zzz'] }), ['HOSTILE:Sr.Zzz']);
  assert.deepEqual(kinds('Compre.Agora'), ['REVIEW:Compre.Agora'], 'duas palavras coladas depois do ponto final vão à revisão');
});

test('credencial_email_e_arroba_seguem_a_regra_sem_regex_de_retrocesso', () => {
  assert.deepEqual(security.extractCandidates('Escreva para maria.pro@nayara.com.br ou jose.me@x.com'), []);
  assert.deepEqual(kinds('nayara.com.br@evil.com/x'), ['HOSTILE:nayara.com.br@evil.com/x']);
  assert.deepEqual(kinds('nayara.com.br:8080@evil.com'), ['HOSTILE:nayara.com.br:8080@evil.com']);
  assert.deepEqual(kinds('Veja evil.com/login@nayara.com.br'), ['HOSTILE:evil.com/login@nayara.com.br'], 'arroba depois de um caminho não é e-mail: o endereço inteiro é lido (rodada 5, M-1)');
  assert.deepEqual(kinds('@evil.com/x'), ['HOSTILE:evil.com/x']);
});

test('varredura_de_texto_grande_e_linear', () => {
  const MB = 1000000;
  const formas = {
    arrobas: 'a'.repeat(MB) + '@', porcentos: 'x' + '%'.repeat(MB) + '@a.b/', doisPontos: 'a:'.repeat(MB / 2), arrobasRepetidos: 'a@'.repeat(MB / 2), barras: 'a/'.repeat(MB / 2),
    rotulos: 'a.'.repeat(MB / 2), hifens: 'a-'.repeat(MB / 2), numeros: '1234567/'.repeat(MB / 8), emails: 'x@a.com/ '.repeat(MB / 9), caminho: `evil.com/${'x'.repeat(MB)}`,
  };
  for (const [nome, texto] of Object.entries(formas)) {
    const start = process.hrtime.bigint();
    security.extractCandidates(texto);
    security.stripUrls(texto);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 2000, `${nome}: ${ms.toFixed(0)} ms para 1 MB (duas varreduras)`);
  }
});

test('cnpj_e_numero_legal_nao_bloqueiam_conteudo_nem_envio', async () => {
  const env = require('../_helpers/mktMsgEnv');
  const { useTempSecretStore } = require('../_helpers/mktSecretStore');
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('marketing.url.dominios_permitidos', 'nayara.com.br', tenant, tenant.userId, t);
    await upsertSetting('marketing.url.verificar_destino', false, tenant, tenant.userId, t);
    for (const texto of ['Nayara Ltda, CNPJ 12.345.678/0001-90', 'Decreto 10.123/19', 'Processo 12.345.678/9']) {
      assert.deepEqual(await security.findDisallowedUrls(texto, { tenant, transaction: t }), [], texto);
      assert.deepEqual(await security.findReviewUrls(texto, { tenant, transaction: t }), [], texto);
    }
    const r = await factualResult(t, tenant, 'Casa de 3 quartos em bairro tranquilo.', undefined, { title: 'Nayara Ltda, CNPJ 12.345.678/0001-90', body: { renderizado: 'Decreto 10.123/19' } });
    assert.equal(r.status, 'FACT_CHECKED', JSON.stringify(r.findings));
  });
  const off = useTempSecretStore();
  try {
    const { a: A } = await env.tenants();
    await withRollbackTenantTransaction(A, async (t) => {
      const p = await env.readyPerson(t, A);
      const out = await env.send(t, A, { channel: 'EMAIL', personId: p, purpose: 'MARKETING', actionKey: env.key(), subject: 'Oi', text: 'Nayara Ltda, CNPJ 12.345.678/0001-90', unsubscribeUrl: 'https://www.exemplo.test/d?t=1' });
      assert.equal(out.status, 'SENT');
    });
  } finally { off(); }
});
