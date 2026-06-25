const { Pool } = require('pg'); // Importa a classe Pool da biblioteca 'pg' (PostgreSQL), que gerencia um conjunto de conexões com o banco

// Cria um pool de conexões com o banco PostgreSQL usando as configurações abaixo
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost', // Endereço do servidor do banco; usa a variável de ambiente PG_HOST ou 'localhost' como padrão
  user: process.env.PG_USER || 'postgres', // Usuário do banco; usa PG_USER ou 'postgres' como padrão
  password: process.env.PG_PASSWORD || '123456', // Senha do banco; usa PG_PASSWORD ou '123456' como padrão
  database: process.env.PG_DATABASE || 'petz', // Nome do banco de dados; usa PG_DATABASE ou 'petz' como padrão
  port: parseInt(process.env.PG_PORT || '5432', 10), // Porta do banco convertida para número inteiro; usa PG_PORT ou 5432 como padrão
  max: parseInt(process.env.PG_POOL_MAX || '10', 10), // Número máximo de conexões simultâneas no pool; usa PG_POOL_MAX ou 10 como padrão
});

module.exports = pool; // Exporta o pool de conexões para ser reutilizado em outros arquivos da aplicação
