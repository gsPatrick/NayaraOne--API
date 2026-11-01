'use strict';

const { getSetting } = require('./settings.service');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const logger = require('../../utils/logger');
const { KEYS: FLAG_KEYS, FLAGS_SETTING_DEFAULTS } = require('../core-governance/feature-flags/flags.settings');

/**
 * Tentativa negada de gravar chave protegida (M9-D870, reabertura R4-L3): a recusa (403) desfaz a transação da requisição, então a linha de `audit.audit_log` é gravada numa
 * transação própria, depois da recusa. Nunca lança: falhar em auditar não muda a resposta 403.
 */
const ACTION = 'governance.setting.write_denied';
const ENTITY = 'core.tenant_setting';

/**
 * Agregação (M9-D870 R5-L2): a tentativa negada do mesmo usuário na mesma chave e pelo mesmo caminho dentro da janela (`governanca.flags.negadas_janela_s`, 60 s) grava UMA linha; as
 * repetidas só incrementam a contagem em memória, que sai em `suppressed` na linha da janela seguinte. Assim 300 PUTs negados não viram 300 linhas.
 */
const windows = new Map();
const MAX_TRACKED = 5000;

function shouldAudit(who, key, via, windowS, now) {
  const id = `${who.companyId}|${who.userId}|${key}|${via}`;
  const state = windows.get(id);
  if (state && now - state.startedAt < windowS * 1000) { state.suppressed += 1; return null; }
  const suppressed = state ? state.suppressed : 0;
  if (!state && windows.size >= MAX_TRACKED) windows.delete(windows.keys().next().value);
  windows.set(id, { startedAt: now, suppressed: 0 });
  return { suppressed };
}
const resetDeniedWindows = () => windows.clear();

/** `key`: a chave do dicionário; `via`: o caminho (PUT /settings, PATCH /feature-flags...). Quem chama só passa chave protegida; toda recusa 403 (permissão da rota, camada de escrita, plataforma ou dono) é auditada. */
async function auditDeniedSettingWrite(req, { key, via, err }) {
  try {
    if (!err || err.statusCode !== 403 || !key || !req.auth || !req.withTenantTransaction) return;
    const details = err.details || {};
    await req.withTenantTransaction(async (transaction) => {
      const windowS = Number(await getSetting(FLAG_KEYS.deniedWindowS, { groupId: req.auth.groupId, companyId: req.auth.companyId }, transaction, FLAGS_SETTING_DEFAULTS[FLAG_KEYS.deniedWindowS]));
      const verdict = shouldAudit(req.auth, key, via, windowS > 0 ? windowS : FLAGS_SETTING_DEFAULTS[FLAG_KEYS.deniedWindowS], Date.now());
      if (!verdict) return;
      await registrarAuditoria({
        groupId: req.auth.groupId, companyId: req.auth.companyId, actorUserId: req.auth.userId, action: ACTION, entityType: ENTITY, entityId: null,
        beforeJson: null, afterJson: { key, via, code: err.code, required: details.required || null, suppressed: verdict.suppressed }, reason: 'Tentativa negada de alterar parâmetro protegido.',
      }, transaction);
    });
  } catch (error) {
    logger.warn({ err: error, key }, 'Falha ao auditar tentativa negada em chave protegida.');
  }
}

module.exports = { auditDeniedSettingWrite, resetDeniedWindows, ACTION, ENTITY };
