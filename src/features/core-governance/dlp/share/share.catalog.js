'use strict';

const contract = require('./resources/contract');
const inspection = require('./resources/inspection');
const file = require('./resources/file');

/**
 * Recursos que podem virar link externo (M9-D823). Cada um sabe conferir que existe e que quem compartilha pode (`assertShareable`), ler o dado como a leitura autenticada o
 * devolve (`load`) e a classe de cada campo (`fields`, o padrão do catálogo enquanto o registro M9-D910 não a assume). `permission` é a do módulo de origem (aplicada pelo guard).
 */
const RESOURCES = Object.freeze([contract, inspection, file]);
const getResource = (code) => RESOURCES.find((resource) => resource.code === code) || null;
const listResources = () => RESOURCES.map(({ code, label, permission }) => ({ code, label, permission }));

module.exports = { RESOURCES, getResource, listResources };
