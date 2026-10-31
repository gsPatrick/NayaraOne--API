'use strict';

// Marco 9, M9-D227 — os parâmetros da contingência do WhatsApp, do portal e da assinatura existem no dicionário e são lidos pelo código, a regra mora nos ganchos do framework
// (nada de lógica de fornecedor no CRM) e a assinatura manual deixa de ser isenta do portão de evidência. Banco descartável.
process.env.PORT = process.env.M9D227_ARQ_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = require('../_helpers/m9d227Env');
const hooks = require('../../../src/features/integrations/contingency/contingency.domainHooks');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { readContingencyMessagingParams } = require('../../../src/features/crm/messaging/contingency/mc.params');
const { countingSignatures } = require('../../../src/features/legal/signatureRows');

let tenant;
before(async () => { tenant = (await env.carregarTenants()).tenant; });
after(async () => { await env.restaurar(tenant, CHAVES); await env.sequelize.close(); process.exit(0); });

const CHAVES = ['integration.whatsapp.alternate_requires_opt_in', 'integration.whatsapp.alternate_email_subject', 'integration.whatsapp.alternate_email_intro', 'integration.whatsapp.expired_template_name', 'integration.portal.manual_task_assignee_role'];
const SRC = path.join(__dirname, '../../../src');
const lerTudo = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? lerTudo(path.join(dir, d.name)) : (d.name.endsWith('.js') ? [{ file: path.join(dir, d.name), text: fs.readFileSync(path.join(dir, d.name), 'utf8') }] : [])));

test('contingencia_parametros_declarados_no_dicionario_e_lidos_pelo_codigo', async () => {
  const codigo = lerTudo(path.join(SRC, 'features'));
  for (const k of CHAVES) {
    assert.ok(SETTINGS_SCHEMA[k], `${k} declarado em SETTINGS_SCHEMA`);
    // Lido por getSetting, direto ou pelo auxiliar que recebe a chave (resolveDomainAssignee); o arquivo que só declara a chave (*.settings.js) não conta.
    const leitores = codigo.filter((f) => !/\.settings\.js$/.test(f.file) && f.text.includes(`'${k}'`) && /getSetting\(|resolveDomainAssignee\(/.test(f.text));
    assert.ok(leitores.length >= 1, `${k} é lido pelo código (parâmetro declarado que nada lê é defeito)`);
  }
  assert.deepEqual(await readContingencyMessagingParams(tenant), { alternateRequiresOptIn: true, alternateEmailSubject: 'Uma mensagem para você', alternateEmailIntro: 'Não conseguimos falar com você pelo WhatsApp neste momento; por isso enviamos esta mensagem por e-mail.', expiredTemplateName: '' });
  await env.parametro(tenant, 'integration.whatsapp.alternate_email_subject', 'Aviso da Nayara');
  await env.parametro(tenant, 'integration.whatsapp.alternate_requires_opt_in', false);
  const lido = await env.comTenant(tenant, (t) => readContingencyMessagingParams(tenant, t));
  assert.deepEqual([lido.alternateEmailSubject, lido.alternateRequiresOptIn], ['Aviso da Nayara', false]);
  for (const [k, v] of [['integration.whatsapp.alternate_email_subject', ''], ['integration.whatsapp.alternate_email_intro', 'x'.repeat(401)], ['integration.portal.manual_task_assignee_role', '']]) {
    await assert.rejects(env.parametro(tenant, k, v), (e) => e.statusCode === 400 && e.code === 'SETTING_INVALID_VALUE', `${k} recusa valor fora da regra`);
  }
});

test('contingencia_ganchos_do_dominio_registrados_no_framework', async () => {
  require('../../../src/features/crm/messaging');
  require('../../../src/features/integrations/portal');
  require('../../../src/features/legal/signature');
  assert.match(hooks.alternateSqlFilter('MESSAGING'), /MARKETING/, 'o marketing fica fora da troca para o alternativo');
  assert.equal(hooks.alternateSqlFilter('PORTAL'), '');
  const quais = (dominio) => { const r = hooks.registered(dominio); return { sqlFilter: r.sqlFilter, agedHandler: r.agedHandler, taskBuilder: r.taskBuilder, step: r.step, moved: r.moved }; };
  assert.deepEqual(quais('MESSAGING'), { sqlFilter: true, agedHandler: true, taskBuilder: true, step: true, moved: true });
  assert.deepEqual(quais('PORTAL'), { sqlFilter: false, agedHandler: true, taskBuilder: false, step: true, moved: false });
  assert.equal(hooks.registered('SIGNATURE').moved, true, 'o envelope acompanha o envio que troca de fornecedor');
  // O CRM não conhece fornecedor: nada de nome de provider em src/features/crm.
  const crm = lerTudo(path.join(SRC, 'features/crm'));
  const proibido = /(['"`])(messaging-sandbox|messaging-alt-sandbox|email-sandbox|signature-sandbox)\1/;
  assert.deepEqual(crm.filter((f) => proibido.test(f.text)).map((f) => path.basename(f.file)), []);
});

test('contingencia_assinatura_cancelada_so_deixa_de_contar_se_a_pessoa_assinou', async () => {
  const linhas = [
    { personId: 'a', status: 'CANCELLED' }, { personId: 'a', status: 'SIGNED' },
    { personId: 'b', status: 'CANCELLED' }, { personId: 'c', status: 'PENDING' },
  ];
  assert.deepEqual(countingSignatures(linhas).map((s) => `${s.personId}:${s.status}`), ['a:SIGNED', 'b:CANCELLED', 'c:PENDING'], 'a cancelada de quem não assinou continua bloqueando o contrato');
});
