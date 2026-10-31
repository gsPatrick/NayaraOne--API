'use strict';

// Marco 9, M9-D249 — GET /v1/admin/integrations/errors (cursor) e GET /v1/admin/integrations/dispatches/:id (HTTP real).
process.env.PORT = process.env.M9D249_ENVIO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');
const errors = require('../../../src/features/integrations/errors');
const dispatch = require('../../../src/features/integrations/dispatch');
const { criar, chave } = require('../../integrations/dispatch/dispatchHelpers');

let tenants;
let tokenLeitura;
let tokenOutro;
let chamar;

before(async () => {
  tenants = await env.carregarTenants();
  tokenLeitura = env.tokenDe(tenants.tenant, ['integration:read']);
  tokenOutro = tenants.outro ? env.tokenDe(tenants.outro, ['integration:read']) : null;
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  const { tenant } = tenants;
  await env.sql(tenant, "UPDATE integration.integration_errors SET status = 'IGNORED' WHERE provider_code = 'qa-m9-d249' AND status = 'OPEN'");
  await env.sequelize.close();
  process.exit(0);
});

const ctx = () => env.ctxDe(tenants.tenant);

test('admin_get_errors_paginacao_por_cursor', async () => {
  const { tenant } = tenants;
  for (let i = 0; i < 120; i += 1) {
    await env.comTenant(tenant, (t) => errors.recordError(ctx(), {
      providerCode: 'qa-m9-d249', source: 'DISPATCH', errorClass: 'TRANSIENT', errorCode: `QA_M9_D249_${String(i).padStart(3, '0')}`, message: 'Fornecedor fora do ar.',
      payload: { token: 'abc', status: 'FORA' },
    }, t));
  }
  const vistos = [];
  let cursor = null;
  const paginas = [];
  do {
    const r = await chamar(tokenLeitura, 'GET', `/admin/integrations/errors?provider=qa-m9-d249&status=OPEN&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(r.status, 200);
    paginas.push(r.corpo.data.items.length);
    vistos.push(...r.corpo.data.items.map((e) => e.errorCode));
    cursor = r.corpo.data.nextCursor;
    assert.ok(paginas.length <= 4, 'não entra em laço');
  } while (cursor);
  assert.deepEqual(paginas, [50, 50, 20], '3 páginas por cursor');
  assert.equal(new Set(vistos).size, 120, 'sem repetição');
  assert.deepEqual([...vistos].sort(), Array.from({ length: 120 }, (_, i) => `QA_M9_D249_${String(i).padStart(3, '0')}`), 'sem lacuna');
  assert.equal(vistos[0], 'QA_M9_D249_119', 'ordem created_at desc');

  const padrao = await chamar(tokenLeitura, 'GET', '/admin/integrations/errors?provider=qa-m9-d249');
  assert.equal(padrao.corpo.data.items.length, 50, 'limite padrão 50');
  const maximo = await chamar(tokenLeitura, 'GET', '/admin/integrations/errors?provider=qa-m9-d249&limit=200');
  assert.equal(maximo.corpo.data.items.length, 120);
  assert.equal(maximo.corpo.data.nextCursor, null);
  const item = maximo.corpo.data.items[0];
  assert.equal(item.sanitizedPayload.token, '[REDACTED]', 'erro sanitizado (D207)');
  assert.match(item.createdAt, /-03:00$/);
  if (tokenOutro) {
    const outro = await chamar(tokenOutro, 'GET', '/admin/integrations/errors?provider=qa-m9-d249');
    assert.equal(outro.corpo.data.items.length, 0, 'erros de outra empresa não aparecem');
  }
});

async function envioComHistorico() {
  const { tenant } = tenants;
  const c = await env.conexao(tenant, 'BANK');
  await env.sql(tenant, "UPDATE integration.connections SET status = 'DISABLED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'", { c: tenant.companyId, p: c.providerCode });
  const { dispatch: d } = await criar(tenant, c.id, chave(), {
    snapshot: { valor: '100.00', token: 'abc-segredo', observacao: `Bear${'er '}abcdefghijklmnopqrstuvwxyz0123456789`, favorecido: 'Fulano', cpf: '123.456.789-09' },
  });
  await env.sql(tenant, "UPDATE integration.dispatches SET aggregate_type = 'Payable', aggregate_id = gen_random_uuid(), external_request_id = 'req-1', external_resource_id = 'res-1' WHERE id = :id", { id: d.id });
  await env.comTenant(tenant, async (t) => {
    await dispatch.transitionDispatch(ctx(), d.id, 'SENDING', {}, {}, t);
    await dispatch.transitionDispatch(ctx(), d.id, 'RETRY_WAIT', { lastErrorClass: 'TRANSIENT', lastErrorCode: 'HTTP_503', nextAttemptAt: new Date(Date.now() + 60000) }, { motivo: 'Fornecedor indisponível.' }, t);
  });
  await env.sql(tenant, `INSERT INTO integration.dispatch_attempts (group_id, company_id, dispatch_id, connection_id, provider_code, attempt_no, started_at, finished_at, outcome, error_class, error_code, http_status, latency_ms)
    VALUES (:g, :c, :d, :cn, :p, 1, now() - interval '2 minutes', now() - interval '119 seconds', 'ERROR', 'TRANSIENT', 'HTTP_503', 503, 900)`,
  { g: tenant.groupId, c: tenant.companyId, d: d.id, cn: c.id, p: c.providerCode });
  return { d, c };
}

test('admin_get_dispatch_linha_do_tempo', async () => {
  const { d, c } = await envioComHistorico();
  const r = await chamar(tokenLeitura, 'GET', `/admin/integrations/dispatches/${d.id}`);
  assert.equal(r.status, 200);
  const x = r.corpo.data;
  assert.equal(x.id, d.id);
  assert.equal(x.provider, c.providerCode);
  assert.equal(x.operation, 'submitPayment');
  assert.equal(x.opClass, 'DANGEROUS');
  assert.equal(x.status, 'RETRY_WAIT');
  assert.equal(x.payloadHash, d.payloadHash);
  assert.equal(x.idempotencyKey, d.idempotencyKey);
  assert.equal(x.externalRequestId, 'req-1');
  assert.equal(x.externalResourceId, 'res-1');
  assert.ok(x.nextAttemptAt, 'próxima tentativa');
  assert.match(x.nextAttemptAt, /-03:00$/);
  assert.equal(x.aggregate.type, 'Payable');
  assert.ok(x.aggregate.id);
  assert.equal(x.attempts.length, 1);
  assert.equal(x.attempts[0].attemptNo, 1);
  assert.equal(x.attempts[0].errorClass, 'TRANSIENT');
  assert.equal(x.attempts[0].errorCode, 'HTTP_503');
  assert.ok(x.attempts[0].startedAt && x.attempts[0].finishedAt);
  const passos = x.timeline.map((e) => `${e.from || '-'}>${e.to}`);
  assert.deepEqual(passos, ['->PENDING', 'PENDING>SENDING', 'SENDING>RETRY_WAIT'], 'linha do tempo da auditoria em ordem');
  assert.equal(x.timeline[2].reason, 'Fornecedor indisponível.');
  assert.ok(x.timeline.every((e) => /-03:00$/.test(e.at)));
});

test('admin_get_dispatch_outra_empresa_404', async (t) => {
  const { d } = await envioComHistorico();
  if (!tokenOutro) return t.skip('segunda empresa do seed ausente');
  const outro = await chamar(tokenOutro, 'GET', `/admin/integrations/dispatches/${d.id}`);
  assert.equal(outro.status, 404, 'nunca 403');
  assert.equal(outro.corpo.error.code, 'INTEGRATION_DISPATCH_NOT_FOUND');
  assert.equal(outro.corpo.error.message, 'Envio não encontrado.');
  const inexistente = await chamar(tokenLeitura, 'GET', '/admin/integrations/dispatches/00000000-0000-4000-8000-000000000000');
  assert.equal(inexistente.status, 404);
  const sem = await chamar(env.tokenDe(tenants.tenant, ['settings:read']), 'GET', `/admin/integrations/dispatches/${d.id}`);
  assert.equal(sem.status, 403);
});

test('admin_dispatch_payload_passa_por_redaction', async () => {
  const { d } = await envioComHistorico();
  const r = await chamar(tokenLeitura, 'GET', `/admin/integrations/dispatches/${d.id}`);
  const snap = r.corpo.data.payloadSnapshot;
  assert.equal(snap.token, '[REDACTED]', 'chave sensível');
  assert.ok(!JSON.stringify(r.corpo).includes('abcdefghijklmnopqrstuvwxyz0123456789'), 'valor com cara de Bearer');
  assert.ok(!JSON.stringify(r.corpo).includes('abc-segredo'));
  assert.ok(!JSON.stringify(r.corpo).includes('123.456.789-09'), 'documento pessoal sai mascarado');
  assert.equal(snap.valor, '100.00', 'o resto do conteúdo segue legível');
  // O envio guardado continua intacto (a redação é só da resposta).
  const bruto = await env.sql(tenants.tenant, 'SELECT payload_snapshot FROM integration.dispatches WHERE id = :id', { id: d.id });
  assert.equal(bruto[0].payload_snapshot.token, 'abc-segredo');
});
