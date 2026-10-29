'use strict';

// Objeto de domínio de imóvel com 40 campos (M9-D219): 12 públicos (os do portal) e 28 internos com valores marcadores.
const PUBLICOS = {
  public_code: 'IMV-A1B2C3D4',
  title: 'Apartamento com varanda no centro',
  description_public: 'Ótimo apartamento, luz natural o dia todo.',
  purpose: 'VENDA',
  type: 'RESIDENTIAL',
  price_public: '450000.00',
  condo_fee_public: '650.00',
  area_total: 82.5,
  bedrooms: 3,
  neighborhood: 'Centro',
  city: 'Curitiba',
  photos_public: ['m1', 'm2'],
};

const INTERNOS = [
  'owner_name', 'owner_document', 'owner_phone', 'owner_email', 'internal_code', 'registry_number', 'registry_office', 'street', 'street_number',
  'complement', 'zip_code', 'lat', 'lng', 'internal_notes', 'broker_notes', 'negotiation_margin', 'commission_rate', 'commission_amount',
  'iptu_debt', 'owner_debt_note', 'internal_occurrence', 'visit_lead_name', 'visit_lead_phone', 'negotiation_history', 'document_labels',
  'appraisal_value', 'key_location', 'created_by',
];

function imovelCom40Campos(marcador = 'CANARY-INTERNAL') {
  const interno = Object.fromEntries(INTERNOS.map((k) => [k, `${marcador}-${k}`]));
  return { ...PUBLICOS, ...interno };
}

module.exports = { imovelCom40Campos, PUBLICOS, INTERNOS };
