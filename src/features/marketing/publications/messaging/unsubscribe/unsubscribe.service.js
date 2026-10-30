'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');
const AppError = require('../../../../../utils/AppError');
const { automatic } = require('../../../suppression');
const { verifyUnsubscribeToken } = require('./unsubscribe.token');

const invalidLink = () => AppError.notFound('Link de descadastro inválido.', 'MKT_UNSUBSCRIBE_LINK_INVALID');

/**
 * POST /marketing/unsubscribe (pública): o token assinado é a autorização. Descobre o grupo da empresa do token (função SECURITY DEFINER), abre a sessão do
 * tenant e cria a supressão de OPT_OUT da pessoa no canal (todas as finalidades; origem UNSUBSCRIBE_LINK), que cancela o que está agendado e emite
 * customer.opted_out. Repetir o mesmo link devolve o mesmo resultado (supressão já existente). `transaction`: só nos testes.
 */
async function unsubscribeByToken({ token, transaction: outer }) {
  const parsed = await verifyUnsubscribeToken(token);
  if (!parsed) throw invalidLink();
  const body = async (transaction) => {
    const [row] = await sequelize.query('SELECT marketing.resolve_company_group(:companyId) AS group_id', { replacements: { companyId: parsed.companyId }, type: QueryTypes.SELECT, transaction });
    if (!row || !row.group_id) throw invalidLink();
    const tenant = { groupId: row.group_id, companyId: parsed.companyId };
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction });
    const result = await automatic.handleUnsubscribeLink({ personId: parsed.personId, channel: parsed.channel }, tenant, transaction);
    return { unsubscribed: true, channel: parsed.channel, replay: result.replay };
  };
  return outer ? body(outer) : sequelize.transaction(body);
}

module.exports = { unsubscribeByToken };
