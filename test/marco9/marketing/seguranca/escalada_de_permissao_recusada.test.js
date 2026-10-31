'use strict';

// M9-D441 segurança 3 (Caderno §14): escalada de permissão recusada. Usuário com o pacote do Assistente de Marketing (só ler e escrever conteúdo) tenta, por HTTP real, aprovar,
// publicar/agendar, ligar o kill switch, publicar automação, criar campanha e template: 403 MKT_FORBIDDEN com a permissão exigida, em TODAS as rotas /marketing/* que pedem mais que o pacote.
// Quem gerou o conteúdo, mesmo com a permissão de aprovar, não o aprova (SEPARATION_OF_DUTIES). Nenhum endpoint de MFA é chamado nem token forjado. Só em banco descartável.
process.env.PORT = process.env.M9D441_HTTP_TEST_PORT || '21741';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('../../_helpers/mktHttp');
const { marketingRoutes, concrete } = require('../../_helpers/mktRotas');

const PREFIX = 'QA-M9 D441 escalada';
const ASSISTENTE = ['marketing:content:read', 'marketing:content:write']; // o pacote do Assistente (marketing.permissions.js, DEFAULT_GRANTS)
const SKIP = !http.DISPOSABLE && http.SKIP_DISPOSABLE;
let sequelize;
before(async () => {
  if (!http.DISPOSABLE) return;
  ({ sequelize } = require('../../../../src/models'));
  await http.start([
    { label: 'D441 assistente', tenant: 'A', profile: 'gestor', permissions: ASSISTENTE },
    { label: 'D441 autor aprovador', tenant: 'A', profile: 'leitura', permissions: [...ASSISTENTE, 'marketing:content:approve'] },
  ]);
});
after(async () => {
  await http.stop(PREFIX);
  if (sequelize) await sequelize.close().catch(() => {});
  if (http.state.loaded) setTimeout(() => process.exit(0), 300);
});

test('escalada_de_permissao_recusada', { skip: SKIP }, async (ctx) => {
  if (http.state.skip) return;
  const rotas = marketingRoutes().filter((r) => r.permission);
  assert.ok(rotas.length >= 10, `as rotas do Marketing foram lidas do Express (${rotas.length})`);
  const id = crypto.randomUUID();
  let recusadas = 0;
  for (const r of rotas) {
    const res = await http.call('D441 assistente', r.method, concrete(r.path, id), r.method === 'GET' ? undefined : {});
    if (ASSISTENTE.includes(r.permission)) {
      assert.notEqual(res.status, 401, `${r.method} ${r.path}`);
      assert.ok(!(res.status === 403 && res.body && res.body.error && res.body.error.code === 'MKT_FORBIDDEN' && res.body.error.details && res.body.error.details.required === r.permission), `${r.method} ${r.path}: o Assistente tem ${r.permission}`);
    } else {
      assert.equal(res.status, 403, `${r.method} ${r.path} (${r.permission}): ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'MKT_FORBIDDEN');
      assert.equal(res.body.error.details.required, r.permission);
      recusadas += 1;
    }
  }
  // as chamadas citadas no livro, por nome: aprovar, publicar (agendar), kill switch, publicar automação
  const nomeadas = [
    ['POST', `/marketing/content/${id}/approve`, 'marketing:content:approve'], ['POST', `/marketing/content/${id}/schedule`, 'marketing:content:publish'],
    ['POST', '/marketing/kill-switch', 'marketing:killswitch:manage'], ['POST', `/marketing/automations/${id}/publish`, 'marketing:automation:publish'],
    ['POST', '/marketing/campaigns', 'marketing:campaign:manage'], ['POST', '/marketing/templates', 'marketing:template:manage'],
  ];
  for (const [method, path, permission] of nomeadas) {
    const res = await http.call('D441 assistente', method, path, method === 'POST' ? { scope: 'GLOBAL', active: true, reason: 'tentativa de escalada do assistente' } : undefined);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error.details.required, permission);
  }
  // o que o Assistente PODE: criar conteúdo (rascunho); aprovar o próprio conteúdo continua proibido mesmo para quem tem a permissão (separação de funções)
  const criado = await http.call('D441 autor aprovador', 'POST', '/marketing/content', { type: 'INSTITUTIONAL', title: `${PREFIX} conteúdo`, texto: 'Somos uma imobiliária de Salvador.' });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  const proprio = await http.call('D441 autor aprovador', 'POST', `/marketing/content/${criado.body.data.id}/approve`, {});
  assert.equal(proprio.status, 403, JSON.stringify(proprio.body));
  assert.equal(proprio.body.error.details.reason, 'SEPARATION_OF_DUTIES');
  assert.equal((await http.adminQuery('SELECT status FROM marketing.content_items WHERE id = $1', [criado.body.data.id])).rows[0].status, 'PENDING_APPROVAL', 'o conteúdo não foi aprovado');
  // sem token, nenhuma rota responde
  for (const r of rotas.slice(0, 5)) assert.equal((await http.call(null, r.method, concrete(r.path, id), r.method === 'GET' ? undefined : {})).status, 401);
  ctx.diagnostic(`${recusadas} rotas /marketing/* recusadas ao Assistente (403 MKT_FORBIDDEN com a permissão exigida), de ${rotas.length} com permissão`);
});
