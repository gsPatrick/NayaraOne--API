'use strict';

/**
 * M9-D627 — estados de crm.messages e o teto de frequência como o BI os lê. O BI é somente leitura (BI-001) e não importa serviço do
 * Marketing: os conjuntos abaixo repetem os do Marketing (automations/policy.statuses e cadence.defaults) e o teste m9d627 confere que
 * continuam iguais. Entregue = DELIVERED ou READ; falha = o que o cap não conta; contado = o que o provedor aceitou.
 */
const DELIVERED_STATUSES = Object.freeze(['DELIVERED', 'READ']);
const FAILED_STATUSES = Object.freeze(['FAILED', 'UNDELIVERED', 'BOUNCED']);
const FINAL_DELIVERY_STATUSES = Object.freeze([...DELIVERED_STATUSES, ...FAILED_STATUSES]); // M9-D671: a mensagem que ainda não chegou a nenhum destes está "sem status de entrega"
const COUNTED_STATUSES = Object.freeze(['SENT', 'DELIVERED', 'READ', 'UNKNOWN']);

const FREQUENCY_CAP_KEY = 'marketing.frequency_cap.global';
const FREQUENCY_CAP_DEFAULT = '3 mensagens por 7 dias por pessoa, canal e finalidade';
const CAP_RE = /^\s*(\d{1,4})\s+mensagens?\s+por\s+(\d{1,4})\s+dias?\b/i;

/** { messages, days } do texto "N mensagens por M dias ..."; null se o texto não segue o formato. */
function parseCap(text) {
  const m = CAP_RE.exec(String(text || ''));
  return m && Number(m[1]) >= 1 && Number(m[2]) >= 1 ? { messages: Number(m[1]), days: Number(m[2]) } : null;
}

/** Teto de frequência vigente da empresa (o mesmo parâmetro que o canSend usa). Ilegível: o padrão. */
async function readFrequencyCap(scope, transaction) {
  const { getSetting } = require('../../settings/settings.service');
  const raw = await getSetting(FREQUENCY_CAP_KEY, { companyId: scope.companyId, groupId: scope.groupId }, transaction, FREQUENCY_CAP_DEFAULT);
  return parseCap(raw) || parseCap(FREQUENCY_CAP_DEFAULT);
}

module.exports = { DELIVERED_STATUSES, FAILED_STATUSES, FINAL_DELIVERY_STATUSES, COUNTED_STATUSES, FREQUENCY_CAP_KEY, FREQUENCY_CAP_DEFAULT, parseCap, readFrequencyCap };
