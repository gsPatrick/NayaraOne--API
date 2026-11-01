'use strict';

// M9-D870 (reabertura R5-M1, R5-L2 e R5-L4): módulos de governança, retenção, permissões e MFA só mudam com a permissão do dono; todo parâmetro governanca.* e mfa.* é
// classificado (protegido ou livre, com falha fechada para chave sem classificação); as tentativas negadas repetidas viram uma linha por janela. Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D870_MODULOS_TEST_PORT || require('../_helpers/portaLivre').portaLivre();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');
const { SETTINGS_SCHEMA, upsertSetting } = require('../../../src/features/settings/settings.service');
const { restrictedPermissionOf } = require('../../../src/features/settings/settingRestricted');
const { isPlatformOnly } = require('../../../src/features/settings/settingPlatform');
const { resetDeniedWindows } = require('../../../src/features/settings/settingDenied');
const { openTenantTx } = require('../../../src/features/core-governance/data-quality/retention.tenantTx');
const { GOVERNANCE_MODULES, moduleSettingKey } = require('../../../src/features/core-governance/governance.settings');

const WINDOW_KEY = 'governanca.flags.negadas_janela_s';
const NO_OWNER = ['settings:update', 'governance:flags:manage'];
const denials = async (companyId, key) => (await http.adminQuery("SELECT after_json FROM audit.audit_log WHERE company_id = $1 AND action = 'governance.setting.write_denied' AND after_json->>'key' = $2 ORDER BY occurred_at", [companyId, key])).rows;
const stored = async (companyId, key) => (await http.adminQuery('SELECT 1 FROM core.tenant_settings WHERE company_id = $1 AND key = $2 AND deleted_at IS NULL', [companyId, key])).rowCount;

// Famílias governanca.* que NÃO são de segurança (livres para quem tem settings:update). Chave nova fora desta lista e sem dono falha o teste: classifique-a.
const FREE_PREFIXES = ['governanca.bcp.', ...['alerta_', 'conflito_', 'duracao_', 'feriados', 'fontes_conflito', 'garantia_', 'janela_', 'papel_por_fonte', 'severidade_', 'tamanho_', 'varredura_'].map((n) => `governanca.calendario.${n}`), 'governanca.dados.bulk.', 'governanca.dados.merge.', 'governanca.dados.qualidade.', 'governanca.dados.dominios', 'governanca.dados.campos_criticos', ...['ambiente', 'detectores_hora', 'egress_x_media', 'fila_', 'gb_base', 'ia_custo', 'janela_dias', 'log_x_media', 'media_dias', 'moeda', 'orfao_dias', 'precos', 'storage_hora'].map((n) => `governanca.finops.${n}`), 'governanca.erros.', 'governanca.lineage.', 'governanca.ui.cache_fresco_s', 'governanca.api.paginacao.', 'governanca.api.idempotencia.', 'governanca.api.limpeza_job_minutos', 'governanca.api.aviso_dias', 'governanca.api.deprecacao.', 'governanca.api.consumidor.', 'governanca.api.externo.'];
const isProtected = (key) => Boolean(restrictedPermissionOf(key)) || isPlatformOnly(SETTINGS_SCHEMA[key]);

before(async () => { await http.start(['settings:update']); });
after(async () => {
  if (!http.state.skip) {
    await http.adminQuery('DELETE FROM core.tenant_settings WHERE key = ANY($1)', [[WINDOW_KEY, ...GOVERNANCE_MODULES.map((m) => moduleSettingKey(m.code))]]);
    await http.adminQuery("DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = 'CI GESTOR' AND p.code = 'settings:update'");
  }
  await http.stop();
});

test('m9d870 R5-M1 classificação fechada: todo governanca.* e mfa.* é protegido (dono) ou está na lista de livres', () => {
  const loose = Object.keys(SETTINGS_SCHEMA).filter((k) => /^(governanca|mfa)\./.test(k) && !isProtected(k) && !FREE_PREFIXES.some((p) => k.startsWith(p)));
  assert.deepEqual(loose, [], `chave sem classificação (dê um dono em settingSecurity.js ou inclua em FREE_PREFIXES): ${loose.join(', ')}`);
  const wronglyFree = FREE_PREFIXES.filter((p) => Object.keys(SETTINGS_SCHEMA).some((k) => k.startsWith(p) && isProtected(k)));
  assert.deepEqual(wronglyFree, [], 'prefixo livre com chave protegida: separe');
  for (const m of GOVERNANCE_MODULES) assert.ok(restrictedPermissionOf(moduleSettingKey(m.code)), `${m.code}: módulo sem dono`);
});

test('m9d870 R5-M1 desligar o módulo DLP (ou outro) com só settings:update e flags:manage dá 403, nada é gravado e a tentativa é auditada', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const ownedByProfile = (code) => NO_OWNER.includes(restrictedPermissionOf(moduleSettingKey(code)));
  for (const mod of GOVERNANCE_MODULES.filter((m) => !ownedByProfile(m.code))) {
    const key = moduleSettingKey(mod.code);
    resetDeniedWindows();
    const res = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value: false });
    assert.equal(res.status, 403, `${key}: ${JSON.stringify(res.body)}`);
    assert.equal(await stored(A.companyId, key), 0, `${key}: nada gravado`);
    assert.ok((await denials(A.companyId, key)).length >= 1, `${key}: tentativa auditada`);
  }
  // a camada de escrita (usada também pelo registro de flags) recusa os mesmos, para todos os módulos
  for (const mod of GOVERNANCE_MODULES) {
    const key = moduleSettingKey(mod.code);
    const err = await openTenantTx({ ...A }, (tx) => upsertSetting(key, false, { ...A }, null, tx, { permissions: NO_OWNER })).then(() => null, (e) => e);
    if (ownedByProfile(mod.code)) assert.equal(err, null, 'o dono deste módulo é flags:manage, que o perfil tem');
    else assert.equal(err && err.code, 'SETTING_PERMISSION_REQUIRED', key);
  }
});

test('m9d870 R5-L4 retenção, agentes em claro, degradação, permissões por perfil e MFA exigem a permissão do dono', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const owners = {
    'governanca.retencao.prazo_meses.auditoria': ['governance:retention:manage', 1], 'governanca.retencao.integracao_automatica': ['governance:retention:manage', false],
    'governanca.ia.agentes_claro': ['governance:classification:manage', 'NAY'], 'governanca.finops.degradacao.ligada': ['governance:finops:manage', false],
    'governanca.permissoes.perfis_gestao': ['roles:update', 'QA'], 'governanca.permissoes.perfis_financeiro': ['roles:update', 'QA'],
    'mfa.step_up_ttl_minutes': ['roles:update', 5], 'mfa.required_for_sensitive_roles': ['roles:update', false], 'governanca.acoes.impacto_validade_min': ['governance:flags:manage', 1],
  };
  for (const [key, [owner, value]] of Object.entries(owners)) {
    assert.ok(SETTINGS_SCHEMA[key], `${key} existe no dicionário`);
    assert.equal(restrictedPermissionOf(key), owner, `${key}: dono`);
    if (owner === 'governance:flags:manage') continue; // o perfil de teste já tem a permissão do dono desta
    resetDeniedWindows();
    const res = await http.call('A:gestor', 'PUT', `/settings/${key}`, { value });
    assert.equal(res.status, 403, `${key}: ${JSON.stringify(res.body)}`);
    assert.equal(await stored(A.companyId, key), 0, `${key}: nada gravado`);
  }
});

test('m9d870 R5-L2 300 tentativas negadas na mesma chave viram uma linha por janela, com a contagem das suprimidas', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const key = 'governanca.dlp.justificativa_min';
  assert.equal((await http.call('A:gestor', 'PUT', `/settings/${WINDOW_KEY}`, { value: 2 })).status, 200, 'a janela é parâmetro do administrador (governance:flags:manage)');
  resetDeniedWindows();
  const already = (await denials(A.companyId, key)).length;
  const results = await Promise.all(Array.from({ length: 60 }, () => http.call('A:gestor', 'PUT', `/settings/${key}`, { value: 5 })));
  assert.ok(results.every((r) => r.status === 403));
  const first = (await denials(A.companyId, key)).slice(already);
  assert.equal(first.length, 1, 'uma linha para a rajada');
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal((await http.call('A:gestor', 'PUT', `/settings/${key}`, { value: 5 })).status, 403);
  const all = (await denials(A.companyId, key)).slice(already);
  assert.equal(all.length, 2, 'passada a janela, nova linha');
  assert.equal(all[1].after_json.suppressed, 59, 'a segunda linha carrega a contagem das suprimidas');
});
