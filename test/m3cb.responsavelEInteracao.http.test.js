'use strict';

// Livro do Marco 3 §18: "Trocar responsável em massa — Permissão específica + audit" (o PATCH comum não pode contornar) e "Apagar interação
// comprometedora — Soft delete/audit; críticos imutáveis" (CAD-18). Login real no seed de dois tenants (empresa A); banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/m3cbCarteiraEnv');

let env; let sequelize;
const as = (who) => env.tokens[`A:${who}`];
const auditoria = async (action, entityId) => (await H.admin('SELECT * FROM audit.audit_log WHERE action = $1 AND entity_id = $2 ORDER BY occurred_at', [action, entityId])).rows;
const dono = async (id) => (await H.admin('SELECT owner_user_id FROM crm.opportunities WHERE id = $1', [id])).rows[0].owner_user_id;

before(async () => {
  if (!H.DISPOSABLE) return;
  env = await H.subir(Number(process.env.M3CB_RESPONSAVEL_HTTP_PORT) || 34234);
  ({ sequelize } = require('../src/models'));
});
after(async () => { if (H.DISPOSABLE && env) await H.encerrar(); });

test('CAD-18 o PATCH comum não troca o responsável sem a permissão específica: 403 OPPORTUNITY_REASSIGN_FORBIDDEN e o dono não muda', { skip: H.SKIP }, async () => {
  const { opportunityId } = await H.oportunidadeDe(env, env.ids.maker, 'Responsável');
  const r = await env.call('PATCH', `/opportunities/${opportunityId}`, as('maker'), { ownerUserId: env.ids.checker, ownerChangeReason: 'Passando para o colega', nextAction: 'Outra ação' });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'OPPORTUNITY_REASSIGN_FORBIDDEN');
  assert.equal(await dono(opportunityId), env.ids.maker);
  const semTroca = await env.call('PATCH', `/opportunities/${opportunityId}`, as('maker'), { ownerUserId: env.ids.maker, nextAction: 'Mesmo dono, outra ação' });
  assert.equal(semTroca.status, 200, 'mandar o mesmo responsável não é troca');
  assert.equal(semTroca.body.data.nextAction, 'Mesmo dono, outra ação');
});

test('CAD-18 com a permissão, a troca pelo PATCH exige motivo e responsável ativo da empresa e audita opportunity.reassign com antes/depois', { skip: H.SKIP }, async () => {
  const { opportunityId } = await H.oportunidadeDe(env, env.ids.maker, 'Troca auditada');
  const semMotivo = await env.call('PATCH', `/opportunities/${opportunityId}`, as('gestor'), { ownerUserId: env.ids.checker });
  assert.equal(semMotivo.status, 400, JSON.stringify(semMotivo.body));
  assert.equal(semMotivo.body.error.code, 'OPPORTUNITY_REASSIGN_REASON_REQUIRED');
  const estranho = await env.call('PATCH', `/opportunities/${opportunityId}`, as('gestor'), { ownerUserId: '00000000-0000-4000-8000-000000000000', ownerChangeReason: 'Corretor saiu de férias' });
  assert.equal(estranho.status, 422, JSON.stringify(estranho.body));
  assert.equal(estranho.body.error.code, 'OPPORTUNITY_REASSIGN_INVALID_OWNER');
  assert.equal(await dono(opportunityId), env.ids.maker, 'as recusas não mudaram o dono');
  const ok = await env.call('PATCH', `/opportunities/${opportunityId}`, as('gestor'), { ownerUserId: env.ids.checker, ownerChangeReason: 'Corretor saiu de férias', temperature: 'HOT' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.ownerUserId, env.ids.checker);
  assert.equal(ok.body.data.temperature, 'HOT', 'os demais campos do PATCH valem na mesma transação');
  const [aud] = await auditoria('opportunity.reassign', opportunityId);
  assert.equal(aud.before_json.ownerUserId, env.ids.maker);
  assert.equal(aud.after_json.ownerUserId, env.ids.checker);
  assert.equal(aud.user_id || aud.actor_user_id, env.ids.gestor);
  assert.match(aud.reason, /Corretor saiu de férias/);
});

test('CAD-18 interação crítica imutável no banco: o papel da aplicação não apaga nem altera o conteúdo; o status de entrega continua mudando', { skip: H.SKIP }, async () => {
  const { personId, opportunityId } = await H.oportunidadeDe(env, env.ids.maker, 'Interação');
  const m = await env.call('POST', '/messages', as('gestor'), { personId, opportunityId, direction: 'INBOUND', authorType: 'CLIENT', channel: 'WHATSAPP', body: 'Reclamação registrada na conversa.' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  const id = m.body.data.id;
  const company = await H.companyA();
  // Papel da aplicação (DATABASE_URL, sem superusuário) e contexto da empresa, como numa requisição: o RLS deixa a linha visível e o gatilho decide.
  const comoApp = (sql) => sequelize.transaction(async (t) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', { replacements: { g: company.group_id, c: company.id }, transaction: t });
    const [rows] = await sequelize.query(`${sql} RETURNING id`, { replacements: { id }, transaction: t });
    assert.equal(rows.length, 1, 'a linha estava visível para o comando');
    return rows;
  });
  const [[{ su }]] = await sequelize.query('SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su');
  assert.equal(su, false, 'conectado com o papel da aplicação, sem superusuário');
  await assert.rejects(comoApp('DELETE FROM crm.messages WHERE id = :id'), /CRM_INTERACTION_IMMUTABLE/);
  for (const set of ["body = 'texto trocado'", "direction = 'OUTBOUND'", "channel = 'EMAIL'", "occurred_at = now() - interval '9 days'", "purpose = 'MARKETING'"]) {
    await assert.rejects(comoApp(`UPDATE crm.messages SET ${set} WHERE id = :id`), /CRM_INTERACTION_IMMUTABLE/, set);
  }
  await comoApp("UPDATE crm.messages SET status = 'READ' WHERE id = :id");
  const [linha] = (await H.admin('SELECT body, direction, channel, status FROM crm.messages WHERE id = $1', [id])).rows;
  assert.deepEqual(linha, { body: 'Reclamação registrada na conversa.', direction: 'INBOUND', channel: 'WHATSAPP', status: 'READ' });
  const del = await env.call('DELETE', `/messages/${id}`, as('gestor'));
  assert.equal(del.status, 404, 'não existe rota de exclusão de interação');
});
