'use strict';

// M9-D431 — apoio dos testes de atribuição: cofre de arquivos temporário (fora do repositório), campanha, mensagem, consentimento.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../src/models');
const { createFileMountedStore, setSecretStoreForTests } = require('../../../src/features/integrations/secrets');
const { recordConsent } = require('../../../src/features/people/personConsents.service');
const campaignFx = require('../../helpers/m9d412Fixtures');

const uid = () => crypto.randomUUID();
const q = (t, sql, replacements) => sequelize.query(sql, { transaction: t, replacements, type: QueryTypes.SELECT });
const DAY = 86400000;

/** Cofre `file-mounted` num diretório temporário FORA do repositório; devolve a função que apaga o diretório. */
function useTempSecretStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-cofre-'));
  setSecretStoreForTests(createFileMountedStore({ dir, masterKey: crypto.randomBytes(32).toString('hex') }));
  return () => fs.rmSync(dir, { recursive: true, force: true });
}

async function makeCampaign(t, tenant, code = `QA-M9-${uid().slice(0, 6)}`) {
  const [row] = await q(t,
    `INSERT INTO marketing.campaigns (id, group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, owner_user_id, status)
     VALUES (gen_random_uuid(), :g, :c, :code, 'QA-M9 campanha', 'Vender o lançamento da Rua das Acácias', 'SALES', 10, 12000, :o, 'DRAFT') RETURNING id, code`,
    { g: tenant.groupId, c: tenant.companyId, code, o: tenant.userId });
  return row;
}

async function makeMessage(t, tenant, personId, channel = 'EMAIL') {
  const [row] = await q(t,
    `INSERT INTO crm.messages (id, group_id, company_id, person_id, channel, direction, author_type, status)
     VALUES (gen_random_uuid(), :g, :c, :p, :ch, 'OUTBOUND', 'NAY', 'SENT') RETURNING id`, { g: tenant.groupId, c: tenant.companyId, p: personId, ch: channel });
  return row.id;
}

const optIn = (t, tenant, personId, channel = 'EMAIL') =>
  recordConsent(personId, { channel, purpose: 'MARKETING', status: 'OPT_IN' }, tenant.userId, t);

const events = (t, where = 'TRUE', replacements = {}) => q(t, `SELECT * FROM marketing.attribution_events WHERE ${where} ORDER BY occurred_at, id`, replacements);

module.exports = { ...campaignFx, uid, q, DAY, useTempSecretStore, makeCampaign, makeMessage, optIn, events };
