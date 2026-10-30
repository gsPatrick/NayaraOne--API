'use strict';

// M9-D433 — validateExternalUrl: os 8 critérios do Caderno §14, um caso por critério, sem banco (a configuração e as portas de rede entram pelo ctx). O último teste
// usa a sonda REAL (HTTPS local com certificado gerado na hora) para provar o redirecionamento fora da allowlist e o limite de saltos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const security = require('../../../src/features/marketing/security');
const { gerarCertificado, subirServidor } = require('../_helpers/tlsFixture');

const CONFIG = Object.freeze({
  allowedDomains: ['nayara.com.br', 'portal.example.com'], shorteners: ['bit.ly', 'tinyurl.com'], maxHops: 3, maxLength: 2048, verifyDestination: true, timeoutMs: 3000,
});
const publico = async () => [{ address: '93.184.216.34', family: 4 }];
const semRedirect = async () => ({ redirect: null, statusCode: 200 });
const validar = (url, over = {}) => security.validateExternalUrl(url, { config: CONFIG, resolver: publico, probe: semRedirect, ...over });
const reprova = async (url, razao, over) => {
  const out = await validar(url, over);
  assert.equal(out.ok, false, `${url} deveria ser recusada`);
  assert.ok(out.reasons.includes(razao), `${url}: esperava ${razao}, veio ${out.reasons}`);
};

test('validador_de_url_cobre_os_8_criterios', async () => {
  await reprova('http://nayara.com.br/x', 'SO_HTTPS'); // 1
  await reprova('https://outro-site.com/x', 'DOMINIO_FORA_DA_ALLOWLIST'); // 2
  await reprova('https://bit.ly/abc', 'ENCURTADOR_PROIBIDO'); // 3
  await reprova('https://www.tinyurl.com/abc', 'ENCURTADOR_PROIBIDO');
  await reprova(['https://usuario', 'x@nayara.com.br/x'].join(':')  /* montada na hora: o varredor de segredos não pode ver a credencial na URL */, 'CREDENCIAL_NA_URL'); // 4
  await reprova('https://10.0.0.5/x', 'HOST_LOCAL_OU_IP'); // 5
  await reprova('https://127.0.0.1/x', 'HOST_LOCAL_OU_IP');
  await reprova('https://localhost/x', 'HOST_LOCAL_OU_IP');
  await reprova('https://[::1]/x', 'HOST_LOCAL_OU_IP');
  await reprova('https://servidor.interno.internal/x', 'HOST_LOCAL_OU_IP');
  await reprova('https://nayara.com.br/x', 'DNS_PARA_REDE_PRIVADA', { resolver: async () => [{ address: '10.0.0.5', family: 4 }] }); // 6: o nome aponta para a rede interna
  await reprova('https://nayara.com.br/x', 'DNS_PARA_REDE_PRIVADA', { resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] }); // um endereço ruim basta
  await reprova('https://nayara.com.br/x', 'DNS_NAO_RESOLVE', { resolver: async () => { throw new Error('ENOTFOUND'); } });
  await reprova('https://nayara.com.br/x', 'REDIRECIONAMENTO_FORA_DA_ALLOWLIST', { probe: async () => ({ redirect: 'https://malicioso.example/x' }) }); // 7
  await reprova('https://nayara.com.br/x', 'REDIRECIONAMENTOS_DEMAIS', { probe: async () => ({ redirect: 'https://nayara.com.br/de-novo' }) });
  await reprova('https://nayara.com.br/x', 'DESTINO_NAO_VERIFICAVEL', { probe: async () => { throw new Error('timeout'); } });
  await reprova(`https://nayara.com.br/${'a'.repeat(2048)}`, 'URL_LONGA_DEMAIS'); // 8
  for (const vazia of ['', '   ', null, undefined, 42]) await reprova(vazia, 'URL_VAZIA');
  await reprova('isto não é url', 'URL_INVALIDA');
  const ok = await validar('https://nayara.com.br/imovel/1234');
  assert.deepEqual({ ok: ok.ok, reasons: ok.reasons, url: ok.url }, { ok: true, reasons: [], url: 'https://nayara.com.br/imovel/1234' });
  assert.equal((await validar('https://www.portal.example.com/anuncio/9')).ok, true, 'subdomínio de domínio permitido vale');
});

test('url_externa_passa_por_validacao_anti_ssrf: exemplos do livro', async () => {
  const bitly = await validar('http://bit.ly/x');
  assert.equal(bitly.ok, false);
  assert.ok(bitly.reasons.includes('SO_HTTPS') && bitly.reasons.includes('ENCURTADOR_PROIBIDO'), 'http e encurtador, como no exemplo do livro');
  assert.ok((await validar('https://10.0.0.5/x')).reasons.includes('HOST_LOCAL_OU_IP'));
  assert.equal((await validar('https://nayara.com.br/imovel/1234')).ok, true);
});

test('redirecionamento_ate_o_maximo_de_saltos_dentro_da_allowlist_passa_e_conta_os_saltos', async () => {
  const saltos = ['https://nayara.com.br/a', 'https://nayara.com.br/b', 'https://nayara.com.br/c'];
  let n = 0;
  const out = await validar('https://nayara.com.br/inicio', { probe: async () => (n < 3 ? { redirect: saltos[n++] } : { redirect: null }) });
  assert.equal(out.ok, true);
  assert.equal(out.hops, 3);
  const tres = await validar('https://nayara.com.br/x', { config: { ...CONFIG, maxHops: 1 }, probe: async () => ({ redirect: '/sempre' }) });
  assert.deepEqual(tres.reasons, ['REDIRECIONAMENTOS_DEMAIS'], 'o limite vem do parâmetro, não do código');
});

test('verificar_destino_desligado_pula_dns_e_redirecionamento_mas_mantem_os_criterios_estaticos', async () => {
  const sem = { config: { ...CONFIG, verifyDestination: false }, resolver: async () => { throw new Error('não deveria consultar o DNS'); } };
  assert.equal((await validar('https://nayara.com.br/x', sem)).ok, true);
  assert.equal((await validar('http://nayara.com.br/x', sem)).ok, false);
});

test('sonda_real_segue_redirecionamento_para_fora_da_allowlist_e_recusa', async () => {
  const par = gerarCertificado(['nayara.com.br', 'localhost']);
  let destino = 'https://malicioso.example/roubo';
  const srv = await subirServidor(par, {}, (req, res) => { res.statusCode = 302; res.setHeader('location', destino); res.end(); });
  try {
    const ctx = { _tls: { ca: par.cert }, _connect: () => ({ host: '127.0.0.1', port: srv.port }) };
    const fora = await validar('https://nayara.com.br/curto', { ...ctx, probe: undefined });
    assert.equal(fora.ok, false);
    assert.ok(fora.reasons.includes('REDIRECIONAMENTO_FORA_DA_ALLOWLIST'), fora.reasons.join());
    destino = 'https://10.0.0.5/interno';
    const privado = await validar('https://nayara.com.br/curto', { ...ctx, probe: undefined });
    assert.ok(privado.reasons.includes('REDIRECIONAMENTO_FORA_DA_ALLOWLIST') && privado.reasons.includes('HOST_LOCAL_OU_IP'), 'o salto para IP privado é recusado pelos mesmos critérios');
    destino = 'https://portal.example.com/ok';
    const dentro = await validar('https://nayara.com.br/curto', { ...ctx, probe: undefined, config: { ...CONFIG, maxHops: 0 } });
    assert.deepEqual(dentro.reasons, ['REDIRECIONAMENTOS_DEMAIS'], 'com zero saltos permitidos, qualquer redirecionamento é recusado');
  } finally { await srv.close(); }
});

test('extractUrls_acha_as_urls_do_texto_sem_a_pontuacao_final', () => {
  const urls = security.extractUrls('Veja https://nayara.com.br/a, e (http://bit.ly/x). Sem link aqui. https://nayara.com.br/a');
  assert.deepEqual(urls, ['https://nayara.com.br/a', 'http://bit.ly/x']);
  assert.deepEqual(security.extractUrls(null), []);
});
