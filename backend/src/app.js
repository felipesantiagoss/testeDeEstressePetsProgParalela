const express = require('express'); // Importa o framework Express, usado para criar o servidor web e suas rotas
const cors = require('cors'); // Importa o middleware CORS, que permite requisições vindas de outras origens (ex.: o front-end)
const animaisRoutes = require('./routes/animais'); // Importa o arquivo de rotas relacionadas aos animais

const app = express(); // Cria a aplicação Express (a instância principal do servidor)

app.use(cors()); // Habilita o CORS em toda a aplicação, liberando acesso de outros domínios
app.use(express.json()); // Habilita o middleware que interpreta o corpo das requisições no formato JSON

app.use('/api/animais', animaisRoutes); // Registra as rotas de animais sob o caminho base '/api/animais'

module.exports = app; // Exporta a aplicação configurada para ser usada em outros arquivos (ex.: server.js)
