'use strict';

// Marco 9, M9-D252 — teste adversarial 10 do livro (seção 19): SSRF por URL. Metadados da nuvem, IP privado, decimal, rebinding e redirect: todos bloqueados, sem consultar DNS nem conectar
// quando a forma já é proibida. Sem rede externa: servidor HTTPS local com certificado gerado na hora.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente, pdf, HOST, IP_PUBLICO } = require('../_helpers/ssrfEnv');

const abertos = [];
const amb = async (handler, opts) => { const a = await montarAmbiente(handler, opts); abertos.push(a); return a; };
afterEach(async () => { while (abertos.length) await abertos.pop().fechar(); });

const bloqueado = (motivo) => (e) => e.statusCode === 422 && e.code === 'INTEGRATION_SSRF_BLOCKED' && e.message === 'Endereço não permitido.' && e.reason === motivo;

test('adv_ssrf_url_interna_bloqueada', async () => {
  // 1) Metadados da nuvem: recusado mesmo com o host na lista do fluxo, sem DNS e sem conexão; e o nome que resolve para o endereço de metadados.
  const a = await amb(pdf);
  await assert.rejects(a.buscar('https://169.254.169.254/latest/meta-data', { _params: { flowHosts: { import_by_url: ['169.254.169.254'] } } }), bloqueado('PRIVATE_IP'));
  await assert.rejects(a.buscar('https://169.254.169.254/latest/meta-data'), bloqueado('NOT_ALLOWED_HOST'));
  await assert.rejects(a.buscar('https://metadata.google.internal/', { _params: { flowHosts: { import_by_url: ['metadata.google.internal'] } }, resolver: async () => [{ address: '169.254.169.254', family: 4 }] }), bloqueado('PRIVATE_IP'));
  assert.deepEqual([a.consultas.length, a.conexoes.length], [0, 0], 'o endereço de metadados nunca chega ao DNS nem à rede');

  // 2) IP privado, loopback e link-local, direto no nome que resolve para eles (ou para uma mistura com um IP público).
  for (const interno of ['10.0.0.5', '172.16.0.1', '192.168.1.1', '127.0.0.1', '::1', 'fe80::1']) {
    const b = await amb(pdf, { dns: async () => [{ address: interno, family: interno.includes(':') ? 6 : 4 }] });
    await assert.rejects(b.buscar(`https://${HOST}/a.jpg`), bloqueado('PRIVATE_IP'), `${HOST} -> ${interno}`);
    assert.equal(b.conexoes.length, 0, `${interno}: nunca conecta`);
  }
  const mista = await amb(pdf, { dns: async () => [{ address: IP_PUBLICO, family: 4 }, { address: '10.1.1.1', family: 4 }] });
  await assert.rejects(mista.buscar(`https://${HOST}/a.jpg`), bloqueado('PRIVATE_IP'), 'cada IP resolvido é validado');

  // 3) IP em decimal, octal, hexadecimal, abreviado e IPv6 literal: bloqueados antes do DNS.
  const c = await amb(pdf);
  for (const url of ['https://2130706433/', 'https://0177.0.0.1/', 'https://0x7f.0.0.1/', 'https://0x7f000001/', 'https://127.1/']) await assert.rejects(c.buscar(url), bloqueado('NUMERIC_HOST_FORM'), url);
  for (const url of ['https://[::1]/', 'https://[::ffff:127.0.0.1]/']) await assert.rejects(c.buscar(url), bloqueado('IPV6_LITERAL'), url);
  assert.deepEqual([c.consultas.length, c.conexoes.length], [0, 0], 'as formas alternativas nem chegam ao DNS');

  // 4) Rebinding: resolve uma vez e conecta ao IP validado; a segunda resolução (que devolveria 127.0.0.1) nunca acontece.
  let consultas = 0;
  const d = await amb(pdf, { dns: async () => { consultas += 1; return consultas === 1 ? [{ address: IP_PUBLICO, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; } });
  await d.buscar(`https://${HOST}/doc.pdf`);
  assert.equal(consultas, 1, 'uma só resolução');
  assert.deepEqual(d.conexoes, [IP_PUBLICO], 'a conexão foi presa ao IP validado');

  // 5) Redirect: não é seguido por padrão; seguido, cada salto repete as verificações (interno, esquema inseguro, host fora da lista).
  let destino = 'http://localhost/admin';
  const e = await amb((req, res) => { res.statusCode = 302; res.setHeader('location', destino); res.end(); });
  await assert.rejects(e.buscar(`https://${HOST}/a.pdf`), bloqueado('REDIRECT'), 'redirect não é seguido por padrão');
  const seguindo = { _params: { maxRedirects: 2 } };
  await assert.rejects(e.buscar(`https://${HOST}/a.pdf`, seguindo), bloqueado('SCHEME'), 'redirect para http://localhost');
  destino = 'https://169.254.169.254/latest/meta-data';
  await assert.rejects(e.buscar(`https://${HOST}/a.pdf`, seguindo), bloqueado('NOT_ALLOWED_HOST'), 'redirect para os metadados da nuvem');
  destino = 'https://10.0.0.5/segredo';
  await assert.rejects(e.buscar(`https://${HOST}/a.pdf`, seguindo), (err) => err.code === 'INTEGRATION_SSRF_BLOCKED', 'redirect para IP privado');
});
