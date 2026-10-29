'use strict';

/**
 * PublicPropertyReadModel (Marco 9, M9-D231). Esta é a lista COMPLETA e fechada dos campos públicos: o que não está aqui não
 * existe no read model (não é filtro, é ausência). O teste read_model_so_campos_publicos compara as colunas da tabela com ela.
 */
const PUBLIC_FIELDS = Object.freeze([
  'public_code', 'title', 'description_public', 'purpose', 'type', 'price_public', 'condo_fee_public', 'iptu_public', 'area_total',
  'area_built', 'bedrooms', 'bathrooms', 'parking_spots', 'neighborhood', 'city', 'state', 'lat_lng_public', 'photos_public',
  'video_public_url', 'features_public', 'published_at', 'read_model_version',
]);

/** Colunas de controle da tabela (chave, empresa, versão do conteúdo): não são dado de imóvel e não saem para fornecedor. */
const CONTROL_COLUMNS = Object.freeze(['id', 'group_id', 'company_id', 'property_id', 'content_hash', 'created_at', 'updated_at']);

const ADDRESS_VISIBILITIES = Object.freeze(['PUBLIC', 'APPROXIMATE', 'RESTRICTED']);
const PURPOSE_SALE = 'VENDA';
const PURPOSE_RENT = 'LOCAÇÃO';

module.exports = { PUBLIC_FIELDS, CONTROL_COLUMNS, ADDRESS_VISIBILITIES, PURPOSE_SALE, PURPOSE_RENT };
