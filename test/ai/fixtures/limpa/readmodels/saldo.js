'use strict';
// Fixture limpa: consulta só no pacote readmodels/ é permitida.
module.exports = async (sequelize) => sequelize.query('SELECT 1');
