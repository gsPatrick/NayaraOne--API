'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

/** A empresa do imóvel pelo identificador público (função SECURITY DEFINER da migration: a rota pública ainda não tem sessão de tenant). */
async function resolveTenant(publicId, transaction) {
  const [row] = await sequelize.query('SELECT group_id, company_id FROM marketing.resolve_public_page(:publicId)', { replacements: { publicId }, type: QueryTypes.SELECT, transaction });
  return row ? { groupId: row.group_id, companyId: row.company_id } : null;
}

/**
 * A linha da página (marketing.v_public_page) com os dias corridos desde a mudança de situação, contados no fuso da empresa
 * (dia da venda = 0). Só imóvel que já foi publicado alguma vez tem página.
 */
async function loadPageRow(publicId, tenant, timeZone, now, transaction) {
  const [row] = await sequelize.query(
    `SELECT v.*, ((:now::timestamptz AT TIME ZONE :zone)::date - (v.lifecycle_changed_at AT TIME ZONE :zone)::date) AS days_since
       FROM marketing.v_public_page v WHERE v.company_id = :companyId AND v.public_id = :publicId`,
    { replacements: { publicId, companyId: tenant.companyId, zone: timeZone, now: now.toISOString() }, type: QueryTypes.SELECT, transaction }
  );
  return row || null;
}

/** Páginas ATIVAS da empresa (para o sitemap), da mais recente à mais antiga. */
async function listActivePages(tenant, limit, transaction) {
  return sequelize.query(
    `SELECT v.public_id, v.tipo, v.bairro, v.cidade, v.quartos, v.finalidade, v.updated_at FROM marketing.v_public_page v
      WHERE v.company_id = :companyId AND v.publication_status = 'PUBLISHED' AND v.availability_status = 'AVAILABLE'
      ORDER BY v.updated_at DESC, v.public_id LIMIT :limit`,
    { replacements: { companyId: tenant.companyId, limit }, type: QueryTypes.SELECT, transaction }
  );
}

module.exports = { resolveTenant, loadPageRow, listActivePages };
