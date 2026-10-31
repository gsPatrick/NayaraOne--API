'use strict';

// M9-D245 — parâmetros da empresa, auditoria dos bloqueios e uso do guarda pelos adaptadores de assinatura (Postgres real).
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, config } = require('../../integrations/dispatch/dispatchHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { readSsrfParams } = require('../../../src/features/integrations/http/ssrf/ssrf.params');
const { ClicksignSignatureAdapter, ZapSignSignatureAdapter } = require('../../../src/features/legal/adapters/SignatureAdapter');
const { montarAmbiente, pdf, HOST } = require('../_helpers/ssrfEnv');

let tenant;
let con;
const abertos = [];
const amb = async (handler, opts) => { const a = await montarAmbiente(handler, opts); abertos.push(a); return a; };
before(async () => { ({ tenant } = await carregarTenants()); con = await conexao(tenant, 'SIGNATURE'); });
afterEach(async () => { while (abertos.length) await abertos.pop().fechar(); });
after(async () => { await config(tenant, 'integration.ssrf.max_bytes', 26214400); await sequelize.close(); });

const dados = () => ({ tenant: ctxDe(tenant) });
const comEmpresa = (fn) => comTenant(tenant, (t) => fn({ ...dados(), transaction: t }));
const rejeita = (code, status) => (e) => e.code === code && (!status || e.statusCode === status);

test('ssrf_parametros_da_empresa_validados_e_lidos: formato inválido é recusado, o válido muda o comportamento da busca', async () => {
  const salvar = (k, v) => comTenant(tenant, (t) => upsertSetting(k, v, tenant, tenant.userId, t, { platform: true }));
  for (const [k, v] of [['integration.ssrf.allowed_schemes', 'http'], ['integration.ssrf.allowed_schemes', 'https,ftp'], ['integration.ssrf.max_redirects', 9], ['integration.ssrf.max_bytes', 10],
    ['integration.ssrf.fetch_allowlist', 'sem-formato'], ['integration.ssrf.fetch_allowlist', 'fluxo:'], ['integration.ssrf.fetch_allowlist', 'Fluxo Ruim:a.example.com'], ['integration.ssrf.fetch_allowlist', 'portal_photo:nao_e_host'],
    ['integration.ssrf.allowed_ports', '99999'], ['integration.ssrf.content_types', 'text/html'], ['integration.ssrf.timeout_ms', 10]]) {
    await assert.rejects(salvar(k, v), rejeita('SETTING_INVALID_VALUE', 400), `${k}=${v}`);
  }
  await salvar('integration.ssrf.allowed_schemes', 'https');
  await salvar('integration.ssrf.max_bytes', 2048);
  await salvar('integration.ssrf.fetch_allowlist', `import_by_url:${HOST};portal_photo:*.cdn-portal.example,fotos.portal.example`);
  const p = await comEmpresa((c) => readSsrfParams(c.tenant, c.transaction));
  assert.deepEqual([p.maxBytes, p.allowedSchemes, p.maxRedirects, p.timeoutMs, p.allowedPorts], [2048, ['https'], 0, 10000, [443]]);
  assert.deepEqual(p.flowHosts, { import_by_url: [HOST], portal_photo: ['*.cdn-portal.example', 'fotos.portal.example'] });

  // O limite da empresa vale na busca; a lista de hosts do fluxo vem dos parâmetros (nenhuma lista de teste).
  const a = await amb((req, res) => { res.setHeader('content-type', 'application/pdf'); res.end(Buffer.alloc(5000, 1)); });
  await assert.rejects(comEmpresa((c) => a.buscarComParametrosDaEmpresa(`https://${HOST}/grande.pdf`, c)), rejeita('INTEGRATION_FETCH_TOO_LARGE', 413));
  await config(tenant, 'integration.ssrf.max_bytes', 26214400);
  const ok = await comEmpresa((c) => a.buscarComParametrosDaEmpresa(`https://${HOST}/grande.pdf`, c));
  assert.equal(ok.bytes, 5000);
  // Redirecionamento: 0 por padrão, e o parâmetro da empresa libera um salto.
  const b = await amb((req, res) => { if (req.url === '/destino') return pdf(req, res); res.statusCode = 302; res.setHeader('location', '/destino'); res.end(); });
  await assert.rejects(comEmpresa((c) => b.buscarComParametrosDaEmpresa(`https://${HOST}/inicio`, c)), rejeita('INTEGRATION_SSRF_BLOCKED', 422));
  await config(tenant, 'integration.ssrf.max_redirects', 1);
  assert.equal((await comEmpresa((c) => b.buscarComParametrosDaEmpresa(`https://${HOST}/inicio`, c))).contentType, 'application/pdf');
  await config(tenant, 'integration.ssrf.max_redirects', 0);
  // Tipos aceitos: a lista da empresa estreita o que o fluxo aceitaria.
  await config(tenant, 'integration.ssrf.content_types', 'image/png');
  await assert.rejects(comEmpresa((c) => a.buscarComParametrosDaEmpresa(`https://${HOST}/grande.pdf`, c)), rejeita('INTEGRATION_FETCH_UNSUPPORTED_MEDIA', 415));
  await config(tenant, 'integration.ssrf.content_types', 'image/jpeg,image/png,image/webp,image/gif,application/pdf');
});

test('ssrf_bloqueio_vira_erro_de_integracao_HIGH_com_host_e_motivo_sem_a_url_completa', async () => {
  const a = await amb(pdf);
  // Quem chama captura a recusa e comita a transação: o erro registrado fica (se a transação voltasse, voltaria junto).
  const recusa = (url) => comEmpresa(async (c) => { try { await a.buscarComParametrosDaEmpresa(url, { ...c, connection: con }); return null; } catch (e) { return e; } });
  assert.ok(rejeita('INTEGRATION_SSRF_BLOCKED', 422)(await recusa('https://169.254.169.254/latest/meta-data?token=abc123')));
  assert.ok(rejeita('INTEGRATION_SSRF_BLOCKED')(await recusa(`https://${['user', 'senha'].join(':')}@foto.example.test/x?k=1`)));
  const interno = await amb(pdf, { dns: async () => [{ address: '10.0.0.5', family: 4 }] });
  const bloqueio = await comEmpresa(async (c) => { try { await interno.buscarComParametrosDaEmpresa(`https://${HOST}/x?token=abc123`, { ...c, connection: con }); return null; } catch (e) { return e; } });
  assert.equal(bloqueio.reason, 'PRIVATE_IP');
  const linhas = await comTenant(tenant, async (t) => (await sequelize.query(
    "SELECT severity, source, error_class, http_status, attempts, sanitized_payload FROM integration.integration_errors WHERE connection_id = :c AND error_code = 'INTEGRATION_SSRF_BLOCKED' ORDER BY created_at",
    { replacements: { c: con.id }, transaction: t }))[0]);
  assert.equal(linhas.length, 1, 'bloqueios repetidos na janela viram uma linha com a contagem (agrupamento da M9-D207)');
  const [e] = linhas;
  assert.deepEqual([e.severity, e.source, e.error_class, e.http_status], ['HIGH', 'CONTRACT', 'SECURITY', 422]);
  assert.ok(e.attempts >= 3, `uma tentativa por bloqueio (${e.attempts})`);
  assert.equal(e.sanitized_payload.flow, 'import_by_url');
  assert.ok(['NOT_ALLOWED_HOST', 'CREDENTIALS', 'PRIVATE_IP'].includes(e.sanitized_payload.reason), 'o motivo exato fica no registro');
  const texto = JSON.stringify(e);
  assert.ok(!texto.includes('abc123') && !texto.includes('senha') && !texto.includes('token') && !texto.includes('k=1'), 'nem query nem credencial no registro');
});

test('ssrf_adaptadores_de_assinatura_baixam_so_pelo_guarda: link do fornecedor para host interno, esquema errado ou host fora do fluxo é recusado', async () => {
  const clicksign = new ClicksignSignatureAdapter({ apiToken: 'token-de-teste' });
  const zapsign = new ZapSignSignatureAdapter({ apiToken: 'token-de-teste' });
  const links = ['https://169.254.169.254/latest/meta-data', 'http://app.clicksign.com/doc.pdf', 'https://evil.example/doc.pdf', 'https://2130706433/doc.pdf', 'https://user:x@app.clicksign.com/doc.pdf'];
  for (const link of links) {
    clicksign._request = async () => ({ data: [{ attributes: { filename: 'a.pdf' }, links: { files: { original: link } } }] });
    await assert.rejects(clicksign.downloadSignedDocument('env-1'), rejeita('INTEGRATION_SSRF_BLOCKED', 422), `clicksign ${link}`);
    zapsign._request = async () => ({ signed_file_url: link, filename: 'a.pdf' });
    await assert.rejects(zapsign.downloadSignedDocument('doc-1'), rejeita('INTEGRATION_SSRF_BLOCKED', 422), `zapsign ${link}`);
  }
});
