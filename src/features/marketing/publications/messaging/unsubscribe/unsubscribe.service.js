'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const { automatic } = require('../../../suppression');
const { readSecretParams } = require('../../../../integrations/secrets/secretParams');
const { parseUnsubscribeToken, verifyUnsubscribeToken } = require('./unsubscribe.token');

const invalidLink = () => AppError.notFound('Link de descadastro inválido.', 'MKT_UNSUBSCRIBE_LINK_INVALID');

/**
 * POST /marketing/unsubscribe (pública): o token assinado é a autorização. Descobre o grupo da empresa do token (função SECURITY DEFINER), abre a sessão do
 * tenant e cria a supressão de OPT_OUT da pessoa no canal (todas as finalidades; origem UNSUBSCRIBE_LINK), que cancela o que está agendado e emite
 * customer.opted_out. Repetir o mesmo link devolve o mesmo resultado (supressão já existente). `transaction`: só nos testes.
 */
async function unsubscribeByToken({ token, transaction: outer }) {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) throw invalidLink();
  const body = async (transaction) => {
    const [row] = await sequelize.query('SELECT marketing.resolve_company_group(:companyId) AS group_id', { replacements: { companyId: parsed.companyId }, type: QueryTypes.SELECT, transaction });
    if (!row || !row.group_id) throw invalidLink();
    const tenant = { groupId: row.group_id, companyId: parsed.companyId };
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction });
    // Só depois de a empresa existir: token de empresa inventada nunca chega ao cofre. A verificação só lê (M9-D429 reabertura M-2); cofre fora usa a última chave lida (L-3).
    const { cacheTtlS } = await readSecretParams(tenant, transaction);
    if (!(await verifyUnsubscribeToken(token, { cacheTtlS }))) throw invalidLink();
    const result = await automatic.handleUnsubscribeLink({ personId: parsed.personId, channel: parsed.channel }, tenant, transaction);
    return { unsubscribed: true, channel: parsed.channel, replay: result.replay };
  };
  return outer ? body(outer) : sequelize.transaction(body);
}

module.exports = { unsubscribeByToken };
