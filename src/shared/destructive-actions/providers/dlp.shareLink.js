'use strict';

const AppError = require('../../../utils/AppError');
const { one, shortCode, blocker } = require('./sql');

const ADMIN_PERMISSION = 'governance:dlp:admin';

/** Impacto de revogar um link externo (linha 12): quem recebeu, o que o link abre, quantos acessos já teve e se ainda vale. */
async function dlpShareLink({ id, transaction, req }) {
  const l = await one(transaction, 'SELECT id, created_by, resource_type, recipient_label, status, expires_at, access_count FROM governance.share_links WHERE id = :id', { id }, 'Link não encontrado.', 'GOV_NOT_FOUND');
  // Só quem criou o link (ou o administrador do DLP) pode revogá-lo: a mesma regra do serviço, dita antes de pedir a confirmação.
  if (l.created_by !== req.auth.userId && !(req.auth.permissions || []).includes(ADMIN_PERMISSION)) throw new AppError('Você não pode revogar este link.', 403, 'GOV_LINK_NOT_OWNER');
  const finished = l.status !== 'ACTIVE' || new Date(l.expires_at) <= new Date();
  return {
    code: shortCode('LNK', id),
    label: `Link de ${l.resource_type}${l.recipient_label ? ` para ${l.recipient_label}` : ''}`,
    impact: {
      counts: { links: 1, accessesSoFar: Number(l.access_count) },
      totalAmountCents: 0,
      blockers: finished ? [blocker('LINK_NOT_ACTIVE', 'o link já foi revogado ou expirou')] : [],
      items: [{ type: 'SHARE_LINK', id: l.id, label: `${l.resource_type}${l.recipient_label ? ` · ${l.recipient_label}` : ''}`, expiresAt: l.expires_at }],
    },
  };
}

module.exports = { dlpShareLink };
