'use strict';

/**
 * Condições para o imóvel estar no read model (M9-D231 regra 4): disponível (`availability_status=AVAILABLE`), publicação
 * autorizada (`publication_status=PUBLISHED`, que só se alcança depois das regras de vídeo, fotos e documentos mínimos do módulo
 * de Imóveis) e com oferta ativa (sem oferta não há preço nem finalidade). Devolve { ok, reasons }.
 */
function publishability(source) {
  const reasons = [];
  if (!source || !source.property) return { ok: false, reasons: ['NOT_FOUND'] };
  const { property, offers } = source;
  if (property.availabilityStatus !== 'AVAILABLE') reasons.push('NOT_AVAILABLE');
  if (property.publicationStatus !== 'PUBLISHED') reasons.push('PUBLICATION_NOT_ALLOWED');
  if (!offers || offers.length === 0) reasons.push('NO_ACTIVE_OFFER');
  return { ok: reasons.length === 0, reasons };
}

module.exports = { publishability };
