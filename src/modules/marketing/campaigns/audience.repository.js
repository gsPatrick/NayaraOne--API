'use strict';

const { run } = require('./campaigns.repository');
const { buildPersonQuery } = require('./audience.resolver');

/** SQL das audiências da campanha (campaign_audiences) e da lista materializada (campaign_audience_members). */
const listAudiences = (campaignId, tenant, transaction) => run(
  `SELECT * FROM marketing.campaign_audiences WHERE campaign_id = :campaignId AND company_id = :companyId AND deleted_at IS NULL ORDER BY created_at, id`,
  { campaignId, companyId: tenant.companyId }, transaction
);

/** Quantas das pessoas pedidas existem na empresa (RLS e filtro explícito): a diferença é pessoa de outra empresa ou inexistente. */
async function countVisiblePersons(personIds, tenant, transaction) {
  const [row] = await run(
    'SELECT count(*)::int AS n FROM people.persons WHERE id IN (:ids) AND company_id = :companyId AND deleted_at IS NULL',
    { ids: personIds, companyId: tenant.companyId }, transaction
  );
  return row.n;
}

/** Rascunho: a lista de audiências é trocada por inteiro (exclusão lógica das antigas, sem lista materializada ainda). */
async function replaceAudiences(campaignId, audiences, tenant, actor, transaction) {
  await run(
    'UPDATE marketing.campaign_audiences SET deleted_at = now(), updated_by = :actor WHERE campaign_id = :campaignId AND company_id = :companyId AND deleted_at IS NULL RETURNING id',
    { campaignId, companyId: tenant.companyId, actor: actor || null }, transaction
  );
  for (const a of audiences) {
    await run(
      `INSERT INTO marketing.campaign_audiences (id, group_id, company_id, campaign_id, kind, filter_json, purpose, created_by, updated_by)
       VALUES (gen_random_uuid(), :groupId, :companyId, :campaignId, :kind, CAST(:filter AS jsonb), :purpose, :actor, :actor) RETURNING id`,
      { groupId: tenant.groupId, companyId: tenant.companyId, campaignId, kind: a.kind, filter: JSON.stringify(a.filter), purpose: a.purpose, actor: actor || null }, transaction
    );
  }
}

/** Pessoas distintas de todas as audiências (antes de congelar), para checar o teto de envio em massa. */
async function countDistinctPersons(audiences, tenant, now, transaction) {
  if (audiences.length === 0) return 0;
  const replacements = {};
  const unions = audiences.map((a, i) => {
    const built = buildPersonQuery({ kind: a.kind, filter: a.filter_json }, tenant, now);
    const renamed = Object.keys(built.replacements).reduce((sql, key) => sql.replace(new RegExp(`:${key}\\b`, 'g'), `:${key}_${i}`), built.sql);
    for (const [key, value] of Object.entries(built.replacements)) replacements[`${key}_${i}`] = value;
    return renamed;
  });
  const [row] = await run(`SELECT count(*)::int AS n FROM (${unions.join(' UNION ')}) u`, replacements, transaction);
  return row.n;
}

/** Congela a audiência: materializa as pessoas e grava size_frozen/frozen_at. Devolve o tamanho. */
async function freezeAudience(audience, tenant, actor, now, transaction) {
  const built = buildPersonQuery({ kind: audience.kind, filter: audience.filter_json }, tenant, now);
  await run(
    `INSERT INTO marketing.campaign_audience_members (group_id, company_id, campaign_id, audience_id, person_id, created_by)
     SELECT :groupId, :companyId, :campaignId, :audienceId, s.person_id, :actor FROM (${built.sql}) s
     ON CONFLICT (audience_id, person_id) DO NOTHING RETURNING id`,
    { ...built.replacements, groupId: tenant.groupId, companyId: tenant.companyId, campaignId: audience.campaign_id, audienceId: audience.id, actor: actor || null }, transaction
  );
  const [row] = await run('SELECT count(*)::int AS n FROM marketing.campaign_audience_members WHERE audience_id = :id', { id: audience.id }, transaction);
  await run('UPDATE marketing.campaign_audiences SET size_frozen = :n, frozen_at = now(), updated_by = :actor WHERE id = :id RETURNING id',
    { n: row.n, actor: actor || null, id: audience.id }, transaction);
  return row.n;
}

async function countDistinctMembers(campaignId, tenant, transaction) {
  const [row] = await run('SELECT count(DISTINCT person_id)::int AS n FROM marketing.campaign_audience_members WHERE campaign_id = :campaignId AND company_id = :companyId',
    { campaignId, companyId: tenant.companyId }, transaction);
  return row.n;
}

module.exports = { listAudiences, countVisiblePersons, replaceAudiences, countDistinctPersons, freezeAudience, countDistinctMembers };
