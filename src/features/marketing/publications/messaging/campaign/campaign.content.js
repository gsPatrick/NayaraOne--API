'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../../models');

const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

/** Primeiro nome da pessoa (variável de template permitida): vem do cadastro, nunca do texto livre. */
async function firstNameOf(personId, tenant, transaction) {
  const [row] = await run(
    `SELECT split_part(btrim(COALESCE(NULLIF(btrim(preferred_name), ''), legal_name)), ' ', 1) AS first_name FROM people.persons
      WHERE id = :personId AND company_id = :companyId AND deleted_at IS NULL`, { personId, companyId: tenant.companyId }, transaction);
  return row ? row.first_name : null;
}

/**
 * O que o step envia: o texto APROVADO do conteúdo (versão corrente: o texto já com a marca, se houver) e o título como assunto; sem conteúdo, o
 * corpo do template do step, com as variáveis primeiroNome/nome (o primeiro nome do cadastro) quando o template as declara. Devolve
 * { text?, subject, templateId?, variables? }; o assunto de e-mail sem conteúdo é o nome da campanha.
 */
async function resolveStepContent(ctx) {
  const { tenant, campaign, step, personId, transaction } = ctx;
  const [named] = await run('SELECT name FROM marketing.campaigns WHERE id = :id AND company_id = :companyId', { id: campaign.id, companyId: tenant.companyId }, transaction);
  const campaignName = named ? named.name : campaign.code;
  if (step.contentItemId) {
    const [item] = await run(
      `SELECT i.title, v.body_json FROM marketing.content_items i JOIN marketing.content_versions v ON v.id = i.current_version_id AND v.company_id = i.company_id
        WHERE i.id = :id AND i.company_id = :companyId AND i.deleted_at IS NULL`, { id: step.contentItemId, companyId: tenant.companyId }, transaction);
    const body = (item && item.body_json) || {};
    const text = typeof body.renderizado === 'string' && body.renderizado.trim() ? body.renderizado : body.texto;
    if (item && typeof text === 'string' && text.trim()) return { text, subject: item.title || campaignName, templateId: step.templateId || null };
  }
  const [template] = await run('SELECT variables_json FROM marketing.templates WHERE id = :id AND company_id = :companyId', { id: step.templateId, companyId: tenant.companyId }, transaction);
  const declared = new Set(((template && template.variables_json) || []).map((v) => v.name));
  const first = await firstNameOf(personId, tenant, transaction);
  const variables = Object.fromEntries(['primeiroNome', 'nome'].filter((n) => declared.has(n) && first).map((n) => [n, first]));
  return { subject: campaignName, templateId: step.templateId, variables };
}

module.exports = { resolveStepContent };
