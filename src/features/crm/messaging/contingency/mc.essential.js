'use strict';

/**
 * Mensagem essencial x não essencial no WhatsApp fora (M9-D227 3.1 item 3): marketing é a única mensagem NÃO essencial (livro: "fila + canal alternativo/manual conforme política";
 * campanha velha enviada fora de hora prejudica o cliente). Tudo o mais (transacional, atendimento, cobrança) é essencial.
 */
const isMarketingPurpose = (purpose) => String(purpose || '').trim().toUpperCase() === 'MARKETING';

/** Trecho de SQL (alias `d` = integration.dispatches) que tira do alternativo o envio de mensagem de marketing: ela aguarda na fila. */
const NOT_MARKETING_SQL = 'AND NOT EXISTS (SELECT 1 FROM "crm"."messages" m WHERE m.dispatch_id = d.id AND UPPER(COALESCE(m.purpose, \'\')) = \'MARKETING\')';

module.exports = { isMarketingPurpose, NOT_MARKETING_SQL };
