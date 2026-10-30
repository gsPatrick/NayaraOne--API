'use strict';

/**
 * Tabela-base de campos do read model público -> campos de um portal sandbox (M9-D232). Cada portal parte dela e declara o que muda: campos obrigatórios próprios
 * (`obrigatorios`), os enums de finalidade e de tipo de imóvel, e a capacidade exigida pelo vídeo (campo omitido quando o portal não a tem).
 */
const TIPOS_BASE = ['RESIDENTIAL', 'HOUSE', 'APARTMENT', 'COMMERCIAL', 'LAND', 'FARM'];

function fieldsFor({ obrigatorios = [] } = {}) {
  const req = (campo) => obrigatorios.includes(campo);
  return [
    { from: 'listingRef', to: 'codigo', required: true },
    { from: 'title', to: 'titulo', required: true },
    { from: 'description_public', to: 'descricao' },
    { from: 'purpose', to: 'finalidade', required: true },
    { from: 'type', to: 'tipoImovel', required: true },
    { from: 'price_public', to: 'preco', required: true },
    { from: 'condo_fee_public', to: 'condominio' },
    { from: 'area_total', to: 'areaTotal' },
    { from: 'area_built', to: 'areaConstruida' },
    { from: 'bedrooms', to: 'quartos' },
    { from: 'bathrooms', to: 'banheiros', required: req('bathrooms') },
    { from: 'parking_spots', to: 'vagas' },
    { from: 'neighborhood', to: 'bairro' },
    { from: 'city', to: 'cidade' },
    { from: 'state', to: 'uf' },
    { from: 'photos_public', to: 'fotos' },
    { from: 'video_public_url', to: 'video', capability: 'video' },
    { from: 'features_public', to: 'caracteristicas' },
  ];
}

const enumDe = (valores, mapa) => Object.fromEntries(valores.map((v) => [v, mapa[v] || v]));

module.exports = { fieldsFor, enumDe, TIPOS_BASE };
