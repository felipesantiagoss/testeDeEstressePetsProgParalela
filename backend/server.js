const app = require('./src/app'); // Importa a aplicação Express já configurada (rotas, middlewares) do arquivo src/app.js

const PORT = 3001; // Define a porta em que o servidor vai escutar requisições

// Inicia o servidor escutando na porta definida e executa a função de callback quando ele estiver pronto
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`); // Exibe no console a mensagem informando que o servidor subiu e o endereço de acesso
});
