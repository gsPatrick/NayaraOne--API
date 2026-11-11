'use strict';
/**
 * Smoke do jurídico contra uma API publicada (etapas deploy_DEV e deploy_LAB da esteira, Guia M5 §17). Só login normal dos
 * usuários fictícios do seed de dois tenants do CI; nunca endpoint de MFA, nunca token gravado. Confere:
 *   saúde e versão (o commit publicado é o do artefato), rota do jurídico sem token 401, leitura com legal:read 200,
 *   criação só com legal:read 403, criação pelo gestor 201 (gravada NO banco do ambiente), leitura do contrato pela mesma
 *   empresa 200 e pela outra empresa 404 (RLS), e a conexão da API com a role de runtime sem superusuário nem BYPASSRLS.
 * Devolve a lista de verificações { item, ok, detalhe } (sem token, sem senha).
 */
const { Client } = require('pg');

async function chamar(base, metodo, rota, token, corpo) {
  const r = await fetch(`${base}${rota}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch (_) { /* corpo não JSON */ }
  return { status: r.status, json, codigo: json && json.error && json.error.code };
}

async function login(base, email, senha) {
  const r = await chamar(base, 'POST', '/api/v1/auth/login', null, { email, password: senha });
  return { status: r.status, token: r.json && r.json.data && r.json.data.accessToken };
}

async function consultar(adminUrl, sql, params) {
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

/** opts: { base, commitEsperado, senha, emailFor, adminUrl, runtimeRole } */
async function smokeJuridico(opts) {
  const { base, commitEsperado, senha, emailFor, adminUrl, runtimeRole } = opts;
  const v = [];
  const conferir = (item, ok, detalhe) => { v.push({ item, ok: Boolean(ok), detalhe }); console.log(`${ok ? 'OK   ' : 'FALHA'} ${item} (${detalhe})`); };

  const saude = await chamar(base, 'GET', '/api/health');
  conferir('GET /api/health -> 200', saude.status === 200, `HTTP ${saude.status}`);
  const versao = await chamar(base, 'GET', '/api/version');
  const publicado = versao.json && ((versao.json.data && versao.json.data.commit) || versao.json.commit);
  conferir('GET /api/version -> commit publicado = commit do artefato', versao.status === 200 && publicado === commitEsperado, `HTTP ${versao.status}, commit ${publicado}`);
  const anonimo = await chamar(base, 'GET', '/api/v1/legal/contracts');
  conferir('GET /api/v1/legal/contracts sem token -> 401', anonimo.status === 401, `HTTP ${anonimo.status}`);

  const leitor = await login(base, emailFor('A', 'leitura'), senha);
  conferir('POST /api/v1/auth/login (empresa A, perfil leitura) -> 200', leitor.status === 200 && leitor.token, `HTTP ${leitor.status}`);
  const lista = await chamar(base, 'GET', '/api/v1/legal/contracts', leitor.token);
  conferir('GET /api/v1/legal/contracts com legal:read -> 200', lista.status === 200, `HTTP ${lista.status}`);
  const corpo = { contractType: 'LEASE_RESIDENTIAL', totalValue: 1000 };
  const negado = await chamar(base, 'POST', '/api/v1/contracts', leitor.token, corpo);
  conferir('POST /api/v1/contracts só com legal:read -> 403', negado.status === 403, `HTTP ${negado.status} ${negado.codigo || ''}`);

  const gestor = await login(base, emailFor('A', 'gestor'), senha);
  conferir('POST /api/v1/auth/login (empresa A, perfil gestor) -> 200', gestor.status === 200 && gestor.token, `HTTP ${gestor.status}`);
  const criado = await chamar(base, 'POST', '/api/v1/contracts', gestor.token, corpo);
  const id = criado.json && criado.json.data && criado.json.data.id;
  conferir('POST /api/v1/contracts pelo gestor da empresa A -> 201 em rascunho', criado.status === 201 && id && criado.json.data.status === 'DRAFT', `HTTP ${criado.status}, status ${criado.json && criado.json.data && criado.json.data.status}`);
  const lido = await chamar(base, 'GET', `/api/v1/legal/contracts/${id}`, leitor.token);
  conferir('GET /api/v1/legal/contracts/:id pela mesma empresa -> 200', lido.status === 200 && lido.json.data.id === id, `HTTP ${lido.status}`);
  const outra = await login(base, emailFor('B', 'gestor'), senha);
  const cruzado = await chamar(base, 'GET', `/api/v1/legal/contracts/${id}`, outra.token);
  conferir('GET /api/v1/legal/contracts/:id pela empresa B -> 404 (RLS)', outra.status === 200 && cruzado.status === 404, `login B HTTP ${outra.status}; leitura HTTP ${cruzado.status} ${cruzado.codigo || ''}`);

  const gravado = await consultar(adminUrl, 'SELECT count(*)::int AS n FROM legal.contracts WHERE id = $1', [id || '00000000-0000-0000-0000-000000000000']);
  conferir('o contrato criado pela API está no banco deste ambiente', gravado[0].n === 1, `${gravado[0].n} linha(s)`);
  const role = await consultar(adminUrl, 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [runtimeRole]);
  conferir(`a API conecta como ${runtimeRole}, sem superusuário nem BYPASSRLS`, role.length === 1 && role[0].rolsuper === false && role[0].rolbypassrls === false, role.length ? `rolsuper ${role[0].rolsuper}, rolbypassrls ${role[0].rolbypassrls}` : 'role ausente');
  return v;
}

module.exports = { smokeJuridico, chamar, login };
