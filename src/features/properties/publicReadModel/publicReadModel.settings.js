'use strict';

/**
 * Parâmetros da publicação do site e dos portais (M9-D231): `integration.publication.approx_radius_m` — raio (metros) da
 * coordenada aproximada de imóvel com endereço APPROXIMATE. O livro fixa 300 m; a empresa só pode DIMINUIR (50 a 300).
 */
const APPROX_RADIUS_KEY = 'integration.publication.approx_radius_m';
const APPROX_RADIUS_DEFAULT = 300;
const APPROX_RADIUS_MIN = 50;

const PUBLICATION_SETTINGS_SCHEMA = Object.freeze({
  [APPROX_RADIUS_KEY]: { type: 'integer', min: APPROX_RADIUS_MIN, max: APPROX_RADIUS_DEFAULT },
});

module.exports = { PUBLICATION_SETTINGS_SCHEMA, APPROX_RADIUS_KEY, APPROX_RADIUS_DEFAULT, APPROX_RADIUS_MIN };
