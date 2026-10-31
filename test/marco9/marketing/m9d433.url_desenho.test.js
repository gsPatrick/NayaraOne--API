'use strict';

// M9-D433 (reabertura da rodada 3: N-1 a N-8) — a extração de URL no texto é regra de DESENHO (todo token com forma de domínio, qualquer terminação e qualquer caixa, é candidato;
// separadores colados saem; abreviação, arquivo e número vão à revisão humana) e não lista de exceções. Tabela com as formas hostis e legítimas de TODAS as rodadas.
// A parte pura roda sem banco; o resto em Postgres real (rollback).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { factualResult } = require('../_helpers/mktFactualEnv');
const fx = require('../_helpers/m9d431Fixtures');
const mid = require('../_helpers/mktMidia');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const security = require('../../../src/features/marketing/security');

let tenant;
let cleanup;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); cleanup = fx.useTempSecretStore(); });
after(async () => { cleanup(); await sequelize.close(); });
const set = (t, key, value) => upsertSetting(key, value, tenant, tenant.userId, t);
async function configurar(t) {
  await set(t, 'marketing.url.dominios_permitidos', 'nayara.com.br, portal.example.com');
  await set(t, 'marketing.url.verificar_destino', false);
}
const ctx = (t) => ({ tenant, transaction: t });
const hostis = async (t, texto) => (await security.findDisallowedUrls(texto, ctx(t))).map((b) => b.url);
const kinds = (texto) => security.extractCandidates(texto).map((c) => `${c.kind}:${c.url}`);

// [texto, endereço esperado] das rodadas 1 a 3 (terminação com maiúscula, caractere colado antes, terminação fora da lista, IP em outras formas, @, caixa mista).
const HOSTIS = [
  ['Acesse evil.Com', 'evil.Com'], ['Visite evil.Net', 'evil.Net'], ['Veja evil.Org', 'evil.Org'], ['Veja evil.Br', 'evil.Br'], ['Veja my.Evil.Com', 'my.Evil.Com'], ['Veja evil.Рф', 'evil.Рф'],
  ['Acesse:evil.com/login', 'evil.com/login'], ['Site:evil.com/login', 'evil.com/login'], ['Veja _evil.com/x_', 'evil.com/x'], ['Aguarde...evil.com/x', 'evil.com/x'],
  ['Aguarde…evil.com/x', 'evil.com/x'], ['Veja:www.evil.com', 'www.evil.com'], ['Veja::evil.com/x', 'evil.com/x'], ['a:evil.com/x', 'evil.com/x'], ['link/evil.com/x', 'evil.com/x'],
  ['Veja (evil.com)', 'evil.com'], ['Veja "evil.com"', 'evil.com'], ['evil.lol', 'evil.lol'], ['evil.sh', 'evil.sh'], ['evil.kz', 'evil.kz'], ['evil.travel', 'evil.travel'],
  ['evil.中国', 'evil.中国'], ['2130706433/x', '2130706433/x'], ['127.1/x', '127.1/x'], ['0x7f000001/x', '0x7f000001/x'], ['@evil.com/x', 'evil.com/x'], ['Veja 1.2.3.4/x', '1.2.3.4/x'],
  ['mailto:a@evil.com', 'mailto:a@evil.com'], ['tel:+5511999999999', 'tel:+5511999999999'], ['sms:123', 'sms:123'], ['nayara.com.br:8080@evil.com', 'nayara.com.br:8080@evil.com'],
  ['nayara.com.br@evil.com/x', 'nayara.com.br@evil.com/x'], ['evil。com/login', 'evil.com/login'], ['https:evil.com', 'https:evil.com'], ['hxxps://evil.com', 'hxxps://evil.com'],
  ['evil.in/login', 'evil.in/login'], ['evil.zip/a', 'evil.zip/a'], ['Evil.Net/x', 'Evil.Net/x'],
];
const LEGITIMOS = ['maria.pro@nayara.com.br', 'jose.me@x.com', 'ana.co@x.com', 'Escreva para maria.pro@nayara.com.br', 'Preço R$ 1.000,00 em 10.12.2026', 'pi 3.14 e v1.2.3', 'e/ou km/h', 'versão 1.2.3.4x',
  'Fale com @maria hoje', 'Às 10:30, sala 2'];
const REVISAO = [['Av.Paulista/Centro', 'Av.Paulista/Centro'], ['S.Paulo/SP', 'S.Paulo/SP'], ['Sr.Silva/Sra.Souza', 'Sr.Silva/Sra.Souza'], ['Rua.das.Flores/100', 'Rua.das.Flores/100'], ['Av.Paulista', 'Av.Paulista'],
  ['Sr.Silva', 'Sr.Silva'], ['foto.jpg', 'foto.jpg'], ['planta.pdf', 'planta.pdf'], ['R$ 1.500/mês', '1.500/mês']];

test('formas_hostis_de_todas_as_rodadas_sao_extraidas_como_bloqueaveis', () => {
  for (const [texto, url] of HOSTIS) assert.deepEqual(kinds(texto), [`HOSTILE:${url}`], texto);
});

test('texto_legitimo_nao_e_url_e_abreviacao_arquivo_e_numero_vao_a_revisao_sem_bloquear', () => {
  for (const texto of LEGITIMOS) assert.deepEqual(security.extractUrls(texto), [], texto);
  for (const [texto, url] of REVISAO) assert.deepEqual(kinds(texto), [`REVIEW:${url}`], texto);
  assert.deepEqual(kinds('Av.Evil/login'), ['HOSTILE:Av.Evil/login'], 'caminho em minúscula não é abreviação colada');
  assert.deepEqual(kinds('Bit.ly'), ['HOSTILE:Bit.ly'], 'terminação conhecida nunca é abreviação');
});

test('variantes_de_caixa_e_normalizacao_dao_o_mesmo_resultado', () => {
  for (const v of ['EVIL.COM/x', 'Evil.Com/X', 'ｅｖｉｌ.ｃｏｍ/x', 'ev​il.com/x']) assert.equal(security.extractCandidates(v).length, 1, v);
});

test('hostil_e_reprovada_e_revisao_passa_com_banco', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    for (const [texto] of HOSTIS) assert.ok((await hostis(t, texto)).length >= 1, texto);
    for (const texto of LEGITIMOS) assert.deepEqual(await hostis(t, texto), [], texto);
    for (const [texto] of REVISAO) assert.deepEqual(await hostis(t, `Fale com ${texto}`), [], texto);
    assert.deepEqual(await security.findReviewUrls('Fale com Sr.Silva em foto.jpg', ctx(t)), ['Sr.Silva', 'foto.jpg']);
    for (const ok of ['Acesse www.nayara.com.br', 'Veja:nayara.com.br/imovel/1', 'Veja NAYARA.COM.BR/x', 'Portal anuncio.portal.example.com']) assert.deepEqual(await hostis(t, ok), [], ok);
  });
});

test('mesmo_extrator_no_blog_titulo_renderizado_e_revisao_vira_finding_sem_reprovar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const texto = 'Casa de 3 quartos em bairro tranquilo.';
    for (const [title, body] of [['Acesse evil.Com', {}], ['Casa nova', { renderizado: 'Visite evil.Net' }], ['Casa nova', { renderizado: 'Veja:evil.com/login' }], ['Casa nova', { renderizado: 'Aguarde…evil.lol' }]]) {
      const r = await factualResult(t, tenant, texto, undefined, { title, body });
      assert.equal(r.status, 'FACT_CHECK_FAILED', `${title} ${JSON.stringify(body)}`);
    }
    const rev = await factualResult(t, tenant, texto, undefined, { title: 'Casa na Av.Paulista', body: { renderizado: 'Planta em planta.pdf' } });
    assert.equal(rev.status, 'FACT_CHECKED', JSON.stringify(rev.findings));
  });
});

test('envio_direto_recusa_forma_hostil_em_texto_assunto_preheader_e_variavel_array_ou_objeto', async () => {
  const env = require('../_helpers/mktMsgEnv');
  const { useTempSecretStore } = require('../_helpers/mktSecretStore');
  const off = useTempSecretStore();
  try {
    const { a: A } = await env.tenants();
    await withRollbackTenantTransaction(A, async (t) => {
      const p = await env.readyPerson(t, A);
      const base = (over) => ({ channel: 'EMAIL', personId: p, purpose: 'MARKETING', actionKey: env.key(), subject: 'Oi', text: 'Olá', unsubscribeUrl: 'https://www.exemplo.test/d?t=1', ...over });
      const casos = [{ text: 'Acesse evil.Com' }, { preheader: 'evil.Net' }, { subject: 'Veja:evil.com/x' }, { text: 'Visite evil.lol' }, { text: '2130706433/x' }, { text: 'Escreva @evil.com/x' },
        { variables: { lista: ['ok', 'Aguarde...evil.com/x'] } }, { variables: { obj: { a: { b: 'link/evil.com/x' } } } }, { text: 'Ligue mailto:a@evil.com' }];
      for (const over of casos) {
        const input = base(over);
        await assert.rejects(() => env.send(t, A, input), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', JSON.stringify(over));
        assert.equal(await env.byKey(t, A, input.actionKey), undefined, 'nada é gravado nem enviado');
      }
      assert.equal((await env.send(t, A, base({ text: 'Visite a Av.Paulista, 100' }))).status, 'SENT', 'abreviação não bloqueia o envio');
    });
  } finally { off(); }
});

test('legenda_do_reel_passa_pela_regra_de_url', async () => {
  const c = await mid.setup();
  await mid.withRollbackTenantTransaction(c.tenant, async (t) => {
    await set(t, 'marketing.url.verificar_destino', false);
    const f = await mid.authorizedFile(t, c.tenant, { mime: 'image/jpeg', name: 'fachada.jpg' });
    for (const text of ['Veja evil.com/login', 'Acesse:evil.Com', 'bit.ly/x']) {
      await assert.rejects(mid.assemble(t, c.tenant, { midias: [f.id], operacoes: [{ op: 'CAPTION', text }] }), (e) => e.statusCode === 422 && e.code === 'MKT_URL_NOT_ALLOWED', text);
    }
    assert.equal(await mid.count(t, 'marketing.media_derivatives'), 0, 'legenda reprovada não gera derivado');
    const ok = await mid.assemble(t, c.tenant, { midias: [f.id], operacoes: [{ op: 'CAPTION', text: 'Sala ampla' }] });
    assert.equal(ok.derivative.transform_log.operations[0].op, 'CAPTION');
  });
});

test('teto_de_urls_conferidas_por_passo_vem_do_parametro_e_recusa_sem_consulta_de_rede', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    const muitas = Array.from({ length: 6 }, (_, i) => `https://nayara.com.br/i/${i}`).join(' ');
    assert.deepEqual(await hostis(t, muitas), []);
    await set(t, 'marketing.url.max_urls_verificadas', 5);
    let consultas = 0;
    const bad = await security.findDisallowedUrls(muitas, { ...ctx(t), probe: async () => { consultas += 1; return {}; }, resolver: async () => { consultas += 1; return []; } });
    assert.equal(bad.length, 1);
    assert.deepEqual(bad[0].reasons, ['URLS_DEMAIS_NO_TEXTO']);
    assert.equal(consultas, 0, 'nenhuma consulta de DNS nem de redirecionamento acima do teto');
    for (const ruim of [0, 201, 'x']) await assert.rejects(() => set(t, 'marketing.url.max_urls_verificadas', ruim), (e) => e.statusCode >= 400 && e.statusCode < 500, String(ruim));
  });
});

test('extensoes_de_arquivo_vem_do_parametro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await configurar(t);
    assert.deepEqual(await security.findReviewUrls('Veja foto.jpg', ctx(t)), ['foto.jpg']);
    await set(t, 'marketing.url.extensoes_arquivo', 'png');
    assert.deepEqual(await security.findReviewUrls('Veja foto.jpg', ctx(t)), []);
    assert.deepEqual(await hostis(t, 'Veja foto.jpg'), ['foto.jpg'], 'fora da lista de extensões é endereço');
    for (const ruim of ['', 'a.b', 'jpg;pdf']) await assert.rejects(() => set(t, 'marketing.url.extensoes_arquivo', ruim), (e) => e.statusCode >= 400 && e.statusCode < 500, ruim);
  });
});
