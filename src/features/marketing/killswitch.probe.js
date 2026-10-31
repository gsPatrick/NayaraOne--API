'use strict';

const crypto = require('node:crypto');
const { sequelize } = require('../../models');
const { withSavepoint } = require('./killswitch.savepoint');
const { registerProbe } = require('../core-governance/feature-flags/kill-switch/probes/registry');
const { GLOBAL_KEY, PROBE_NAME, PROBE_VERSION } = require('./killswitch.constants');
const { readKillState, isOutboundBlocked } = require('./killswitch.state');

/** Porta do envio por canal: quem monta os adapters (publications/adapters/index.js) registra { sendToChannel, sandboxRecordCount }; o kill switch não importa os adapters (que o consultam em cada envio). */
let channelPort = null;
function registerChannelPort(port) {
  if (port !== null && (!port || typeof port.sendToChannel !== 'function' || typeof port.sandboxRecordCount !== 'function')) throw new TypeError('A porta de canal do probe precisa de sendToChannel e sandboxRecordCount.');
  channelPort = port;
}

const ROLLBACK = Symbol('killswitch.probe.rollback');
const FALLBACK_CHANNEL = 'EMAIL';
const channelOfKey = (key) => (key === GLOBAL_KEY ? null : key.split('.')[2].toUpperCase());

/** Cria num savepoint que SEMPRE volta atrás uma campanha e um fluxo de teste já com o kill switch ligado e confere que o estado os bloqueia. */
async function coverCampaignAndAutomation(tenant, ownerUserId, transaction) {
  const seen = {};
  try {
    await withSavepoint(transaction, async (tx) => {
      const tag = crypto.randomBytes(4).toString('hex');
      const [[campaign]] = await sequelize.query(
        `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, budget_justification, owner_user_id, kill_switch_active, kill_switch_at, kill_switch_reason)
         VALUES (:g, :c, :code, 'Teste do kill switch', 'Prova automática do kill switch', 'LEADS', 1, 0, 'Teste do kill switch', :owner, true, now(), 'probe') RETURNING id`,
        { transaction: tx, replacements: { g: tenant.groupId, c: tenant.companyId, code: `KP-${tag}`, owner: ownerUserId } }
      );
      const [[flow]] = await sequelize.query(
        `INSERT INTO marketing.automation_flows (group_id, company_id, code, name, owner_user_id, kill_switch_active, kill_switch_at, kill_switch_reason)
         VALUES (:g, :c, :code, 'Teste do kill switch', :owner, true, now(), 'probe') RETURNING id`,
        { transaction: tx, replacements: { g: tenant.groupId, c: tenant.companyId, code: `KP-${tag}`, owner: ownerUserId } }
      );
      const byCampaign = await readKillState(tenant, { campaignId: campaign.id }, tx);
      const byAutomation = await readKillState(tenant, { automationId: flow.id }, tx);
      seen.campaignBlocked = byCampaign.blocked && byCampaign.active.some((a) => a.scope === 'CAMPAIGN');
      seen.automationBlocked = byAutomation.blocked && byAutomation.active.some((a) => a.scope === 'AUTOMATION');
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return seen;
}

/**
 * Probe do kill switch do Marketing (M9-D872 §3.1, M9-D425 "testado periodicamente"). O drill já deixou o switch ACIONADO; aqui se prova que a função parou: (1) o estado lido pelo
 * runner e pelo disparo diz "bloqueado" para o escopo do switch; (2) uma tentativa REAL de envio pelo ponto de saída de canal (modo SANDBOX) é recusada com MKT_KILL_SWITCH_ACTIVE e
 * nenhum registro é criado no sandbox (zero envios); (3) uma campanha e uma automação de teste (criadas e desfeitas na hora) com o switch próprio ligado também ficam bloqueadas.
 */
async function run({ tenant, flag, transaction }) {
  const channel = channelOfKey(flag.key) || FALLBACK_CHANNEL;
  const adapters = channelPort;
  if (!adapters) throw new Error('Probe do kill switch sem a porta de canal registrada (carregue publications/adapters).');
  const before = adapters.sandboxRecordCount(tenant.companyId, channel);
  const decision = await isOutboundBlocked(tenant, { channel }, transaction);
  const expectedScope = flag.key === GLOBAL_KEY ? 'GLOBAL' : 'CHANNEL';
  let attempt = { refused: false };
  try {
    await adapters.sendToChannel(channel, { to: 'probe@exemplo.test', text: 'probe', subject: 'probe' }, { tenant, transaction, mode: 'SANDBOX', idempotencyKey: `kill-probe-${crypto.randomUUID()}` });
  } catch (err) {
    attempt = { refused: err.code === 'MKT_KILL_SWITCH_ACTIVE', code: err.code };
  }
  const sent = adapters.sandboxRecordCount(tenant.companyId, channel) - before;
  const covered = await coverCampaignAndAutomation(tenant, flag.ownerUserId, transaction);
  const stateOk = decision.blocked && decision.blockedBy.some((b) => b.scope === expectedScope);
  const pass = stateOk && attempt.refused && sent === 0 && covered.campaignBlocked === true && covered.automationBlocked === true;
  return { pass, evidence: { key: flag.key, channel, stateBlocked: stateOk, attempt, sent, ...covered } };
}

const probe = registerProbe({
  name: PROBE_NAME, version: PROBE_VERSION, run,
  description: 'Com o kill switch acionado: estado bloqueado, envio pelo canal recusado (zero envios) e campanha e automação de teste bloqueadas.',
});

module.exports = { probe, run, registerChannelPort };
