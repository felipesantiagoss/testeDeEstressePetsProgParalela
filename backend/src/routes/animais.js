const { Router } = require('express'); // Importa a função Router do Express, usada para criar um agrupador de rotas
const controller = require('../controllers/animaisController'); // Importa o controller que contém as funções que tratam cada requisição

const router = Router(); // Cria uma nova instância de roteador para registrar as rotas dos animais

router.get('/',          controller.listar);        // GET '/'       -> lista todos os animais
router.get('/:id',       controller.buscarPorId);    // GET '/:id'    -> busca um animal específico pelo id
router.post('/',         controller.criar);          // POST '/'      -> cria um novo animal
router.put('/:id',       controller.atualizar);      // PUT '/:id'    -> atualiza todos os dados de um animal pelo id
router.delete('/:id',    controller.remover);        // DELETE '/:id' -> remove um animal pelo id
router.patch('/:id/status', controller.toggleStatus); // PATCH '/:id/status' -> alterna (liga/desliga) o status do animal
router.post('/:id/adotar', controller.adotar);       // POST '/:id/adotar'  -> registra a adoção do animal indicado pelo id

module.exports = router; // Exporta o roteador configurado para ser usado na aplicação (em app.js)
