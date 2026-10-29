'use strict';

// M9-D245 — fetchExternalUrl: tudo que o guarda recusa, e uma URL legítima aceita (servidor HTTPS local com certificado gerado na hora).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedIp } = require('../../../src/features/integrations/http/ssrf/ipRanges');
const { registerQuarantineSink } = require('../../../src/features/integrations/http/ssrf/quarantinePort');
const { montarAmbiente, pdf, HOST, IP_PUBLICO } = require('../_helpers/ssrfEnv');

const abertos = [];
const amb = async (handler, opts) => { const a = await montarAmbiente(handler, opts); abertos.push(a); return a; };
afterEach(async () => { registerQuarantineSink(null); while (abertos.length) await abertos.pop().fechar(); });

const recusado = (reason, status = 422, code = 'INTEGRATION_SSRF_BLOCKED') => (e) => e.statusCode === status && e.code === code && (!reason || e.reason === reason)
  && (status !== 422 || e.message === 'Endereço não permitido.');

test('ssrf_metadados_da_nuvem_bloqueado: 169.254.169.254 recusado mesmo quando o host consta da lista do fluxo, sem consultar DNS nem conectar', async () => {
  const a = await amb(pdf);
  await assert.rejects(a.buscar('https://169.254.169.254/latest/meta-data', { _params: { flowHosts: { import_by_url: ['169.254.169.254'] } } }), recusado('PRIVATE_IP'));
  assert.deepEqual([a.consultas.length, a.conexoes.length], [0, 0]);
  await assert.rejects(a.buscar('https://169.254.169.254/latest/meta-data'), recusado('NOT_ALLOWED_HOST'), 'fora da lista do fluxo também');
  await assert.rejects(a.buscar('https://metadata.google.internal/', { _params: { flowHosts: { import_by_url: ['metadata.google.internal'] } }, resolver: async () => [{ address: '169.254.169.254', family: 4 }] }), recusado('PRIVATE_IP'));
});

test('ssrf_ip_privado_loopback_linklocal_bloqueados: todas as faixas proibidas e o nome que resolve para uma delas, ou para uma mistura', async () => {
  const proibidos = ['10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.8.8.8', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '100.64.0.1', '100.127.255.255',
    '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.1.1', 'ff02::1', '255.255.255.255', '240.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', '::ffff:7f00:1', '::', '192.0.2.1', '198.51.100.7', '2001:db8::1', 'não é ip'];
  proibidos.forEach((ip) => assert.equal(isBlockedIp(ip), true, ip));
  ['93.184.216.34', '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '1.1.1.1'].forEach((ip) => assert.equal(isBlockedIp(ip), false, ip));

  for (const interno of ['10.0.0.5', '127.0.0.1', '192.168.0.9', '::1']) {
    const a = await amb(pdf, { dns: async () => [{ address: interno, family: interno.includes(':') ? 6 : 4 }] });
    await assert.rejects(a.buscar(`https://${HOST}/a.jpg`), recusado('PRIVATE_IP'), `${HOST} -> ${interno}`);
    assert.equal(a.conexoes.length, 0, 'nunca chega a conectar');
  }
  const mista = await amb(pdf, { dns: async () => [{ address: IP_PUBLICO, family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await assert.rejects(mista.buscar(`https://${HOST}/a.jpg`), recusado('PRIVATE_IP'), 'cada IP resolvido é validado');
});

test('ssrf_formas_alternativas_de_ip_bloqueadas: decimal, octal, hexadecimal, abreviado, IPv6 literal e punycode', async () => {
  const a = await amb(pdf);
  const formas = {
    'https://2130706433/': 'NUMERIC_HOST_FORM', 'https://0177.0.0.1/': 'NUMERIC_HOST_FORM', 'https://0x7f.0.0.1/': 'NUMERIC_HOST_FORM', 'https://0x7f000001/': 'NUMERIC_HOST_FORM',
    'https://127.1/': 'NUMERIC_HOST_FORM', 'https://017700000001/': 'NUMERIC_HOST_FORM', 'https://16843009/': 'NUMERIC_HOST_FORM', 'https://1.1/': 'NUMERIC_HOST_FORM',
    'https://[::1]/': 'IPV6_LITERAL', 'https://[::ffff:127.0.0.1]/': 'IPV6_LITERAL', 'https://[2606:4700::1111]/x': 'IPV6_LITERAL',
    'https://xn--80ak6aa92e.com/a': 'PUNYCODE', 'https://foto.xn--e1afmkfd.test/a': 'PUNYCODE',
  };
  for (const [url, motivo] of Object.entries(formas)) await assert.rejects(a.buscar(url), recusado(motivo), url);
  assert.deepEqual([a.consultas.length, a.conexoes.length], [0, 0], 'nenhuma delas chega ao DNS ou à rede');
  // Punycode só passa se o host consta explicitamente da lista do fluxo.
  const liberado = await amb(pdf, { dns: async () => [{ address: IP_PUBLICO, family: 4 }] });
  await assert.rejects(liberado.buscar('https://xn--80ak6aa92e.com/a', { _params: { flowHosts: { import_by_url: ['xn--80ak6aa92e.com'] } } }), (e) => e.code === 'INTEGRATION_FETCH_FAILED', 'passa pelas verificações e só falha porque o certificado de teste não é dele');
});

test('ssrf_dns_rebinding_usa_ip_validado: resolve uma vez e conecta ao IP validado, sem segunda resolução', async () => {
  let consultas = 0;
  const a = await amb(pdf, { dns: async () => { consultas += 1; return consultas === 1 ? [{ address: IP_PUBLICO, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; } });
  const r = await a.buscar(`https://${HOST}/doc.pdf`);
  assert.equal(r.bytes, Buffer.from('%PDF-1.4 teste').length);
  assert.equal(consultas, 1, 'a segunda resolução (que devolveria 127.0.0.1) nunca acontece');
  assert.deepEqual(a.conexoes, [IP_PUBLICO], 'a conexão foi presa ao IP validado, com o nome original só no SNI e no Host');
});

test('ssrf_redirect_para_interno_bloqueado: 302 não é seguido por padrão; seguido, cada salto repete todas as verificações', async () => {
  let destino = 'http://localhost/admin';
  const a = await amb((req, res) => {
    if (req.url === '/ok') return pdf(req, res);
    res.statusCode = 302; res.setHeader('location', destino); res.end();
  });
  await assert.rejects(a.buscar(`https://${HOST}/a.pdf`), recusado('REDIRECT'), 'max_redirects = 0');
  const seguindo = { _params: { maxRedirects: 2 } };
  await assert.rejects(a.buscar(`https://${HOST}/a.pdf`, seguindo), recusado('SCHEME'), 'http://localhost');
  destino = 'https://169.254.169.254/latest/meta-data';
  await assert.rejects(a.buscar(`https://${HOST}/a.pdf`, seguindo), recusado('NOT_ALLOWED_HOST'));
  destino = 'https://outro.example.test/a.pdf';
  await assert.rejects(a.buscar(`https://${HOST}/a.pdf`, seguindo), recusado('NOT_ALLOWED_HOST'), 'host fora da lista do fluxo');
  destino = '/ok';
  assert.equal((await a.buscar(`https://${HOST}/a.pdf`, seguindo)).contentType, 'application/pdf', 'salto legítimo dentro do limite');
  destino = '/loop';
  await assert.rejects(a.buscar(`https://${HOST}/loop`, seguindo), recusado('REDIRECT'), 'passou do limite de saltos');
});

test('ssrf_esquema_nao_https_bloqueado: file, http, ftp, gopher, data e javascript', async () => {
  const a = await amb(pdf);
  for (const url of ['file:///etc/passwd', `http://${HOST}/a.pdf`, 'ftp://foto.example.test/a.pdf', 'gopher://foto.example.test/1', 'data://text/html,<script>', 'javascript://x/%0aalert(1)']) {
    await assert.rejects(a.buscar(url), recusado('SCHEME'), url);
  }
  for (const url of ['data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'nao-e-url', '', '//foto.example.test/a']) await assert.rejects(a.buscar(url), recusado('URL_INVALID'), url);
  await assert.rejects(a.buscar(`https://${HOST}:8443/a.pdf`), recusado('PORT'), 'porta fora de 443 e da lista');
  await assert.rejects(a.buscar(`https://${HOST}:0/a.pdf`), recusado(null));
  assert.equal((await a.buscar(`https://${HOST}:8443/a.pdf`, { _params: { allowedPorts: [443, 8443] } })).contentType, 'application/pdf', 'porta liberada pela lista');
  await assert.rejects(a.buscar(`https://${HOST}/a`, { flow: 'fluxo_inexistente' }), recusado('FLOW_UNKNOWN'));
  assert.deepEqual([a.consultas.length, a.conexoes.length > 0], [1, true], 'só a URL legítima da porta liberada consultou o DNS');
});

test('ssrf_limite_de_tamanho_corta_leitura: passa do máximo, a leitura é cortada e o servidor perde a conexão; Content-Length acima do máximo nem começa', async () => {
  let enviados = 0; let encerrou = false;
  const a = await amb((req, res) => {
    res.setHeader('content-type', 'application/pdf');
    const pedaco = Buffer.alloc(1024, 65);
    const t = setInterval(() => { enviados += 1; if (enviados > 5000) { clearInterval(t); res.end(); } else res.write(pedaco); }, 0);
    res.on('close', () => { encerrou = true; clearInterval(t); });
  });
  await assert.rejects(a.buscar(`https://${HOST}/grande.pdf`, { _params: { maxBytes: 4096 } }), recusado(null, 413, 'INTEGRATION_FETCH_TOO_LARGE'));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(encerrou && enviados < 500, `a leitura foi cortada (servidor enviou ${enviados} KiB de 5000)`);
  const b = await amb((req, res) => { res.setHeader('content-type', 'application/pdf'); res.setHeader('content-length', '99999999'); res.write('x'); setTimeout(() => res.end(), 50); });
  await assert.rejects(b.buscar(`https://${HOST}/anunciado.pdf`), recusado(null, 413, 'INTEGRATION_FETCH_TOO_LARGE'), 'o padrão é 25 MiB e o tamanho anunciado vale');
  const { PADROES } = require('../../../src/features/integrations/http/ssrf/ssrf.params');
  assert.equal(PADROES.maxBytes, 25 * 1024 * 1024);
  assert.equal(PADROES.timeoutMs, 10000);
});

test('ssrf_credenciais_embutidas_bloqueadas: user:pass, só usuário e só senha', async () => {
  const a = await amb(pdf);
  for (const url of [`https://${['user', 'pass'].join(':')}@${HOST}/a.pdf`, `https://user@${HOST}/a.pdf`, `https://:pass@${HOST}/a.pdf`, `https://foto.example.test%40evil.example@${HOST}/`]) {
    await assert.rejects(a.buscar(url), recusado('CREDENTIALS'), url);
  }
  assert.deepEqual([a.consultas.length, a.conexoes.length], [0, 0]);
});

test('ssrf_conteudo_vai_para_quarentena: o conteúdo é entregue à quarentena e volta marcado, nunca como liberado; HTML e tipo fora da lista são recusados antes de ler', async () => {
  const recebidos = [];
  registerQuarantineSink(async (item) => { recebidos.push(item); return { quarantineId: 'q-1' }; });
  const a = await amb((req, res) => {
    if (req.url.startsWith('/pagina')) { res.setHeader('content-type', 'text/html'); return res.end('<script>alert(1)</script>'); }
    if (req.url.startsWith('/zip')) { res.setHeader('content-type', 'application/zip'); return res.end('PK'); }
    return pdf(req, res);
  });
  const r = await a.buscar(`https://${HOST}/doc.pdf`);
  assert.equal(r.quarantine.status, 'QUARANTINED');
  assert.equal(r.quarantine.released, false);
  assert.deepEqual(r.quarantine.ref, { quarantineId: 'q-1' });
  assert.equal(recebidos.length, 1);
  assert.equal(recebidos[0].sha256, r.sha256);
  assert.deepEqual(recebidos[0].origin, { flow: 'import_by_url', host: HOST });
  assert.equal(recebidos[0].contentType, 'application/pdf');
  assert.ok(Buffer.isBuffer(recebidos[0].buffer) && recebidos[0].buffer.equals(r.buffer));
  await assert.rejects(a.buscar(`https://${HOST}/pagina.html`), recusado(null, 415, 'INTEGRATION_FETCH_UNSUPPORTED_MEDIA'));
  await assert.rejects(a.buscar(`https://${HOST}/zip`), recusado(null, 415, 'INTEGRATION_FETCH_UNSUPPORTED_MEDIA'));
  assert.equal(recebidos.length, 1, 'o que foi recusado nunca chega à quarentena');
  // Sem sink registrado (antes da M9-D247) o conteúdo também vem marcado, sem gravação nem link.
  registerQuarantineSink(null);
  const sem = await a.buscar(`https://${HOST}/doc.pdf`);
  assert.deepEqual([sem.quarantine.status, sem.quarantine.released, sem.quarantine.sink], ['QUARANTINED', false, 'none']);
});

test('ssrf_url_legitima_aceita_e_falhas_de_rede_nao_vazam_detalhe', async () => {
  const a = await amb(pdf);
  const ok = await a.buscar(`https://${HOST}/contrato.pdf?assinatura=abc`);
  assert.deepEqual([ok.contentType, ok.host, ok.buffer.toString()], ['application/pdf', HOST, '%PDF-1.4 teste']);
  const semDns = await amb(pdf, { dns: async () => { throw new Error('ENOTFOUND detalhe interno do resolvedor 10.9.9.9'); } });
  await assert.rejects(semDns.buscar(`https://${HOST}/a.pdf`), (e) => e.code === 'INTEGRATION_SSRF_BLOCKED' && e.message === 'Endereço não permitido.' && !JSON.stringify(e).includes('10.9.9.9') && e.reason === 'DNS_FAILED');
  const lento = await amb(() => {});
  await assert.rejects(lento.buscar(`https://${HOST}/a.pdf`, { _params: { timeoutMs: 1000 } }), recusado(null, 504, 'INTEGRATION_FETCH_TIMEOUT'));
});
