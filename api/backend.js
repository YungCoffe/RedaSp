export default async function handler(req, res) {
    // Cabeçalhos que a API oficial exige para responder corretamente
    const API_HEADERS = {
        'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
        'X-Product-Name': 'SalaDoFuturo',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    const path = req.url;
    const method = req.method;

    try {
        // ROTA DE LOGIN
        if (path === '/api/login' && method === 'POST') {
            const response = await fetch('https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/Login', {
                method: 'POST',
                headers: API_HEADERS,
                body: JSON.stringify(req.body)
            });
            const data = await response.json();
            return res.status(response.status).json(data);
        }

        // ROTA DE LISTAR LIVROS
        if (path === '/api/books' && method === 'GET') {
            const response = await fetch('https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings', {
                method: 'GET',
                headers: { 
                    ...API_HEADERS, 
                    'Authorization': req.headers.authorization 
                }
            });
            const data = await response.json();
            return res.status(response.status).json(data);
        }

        // ROTA PARA COMPLETAR LIVRO
        if (path.includes('/complete') && method === 'POST') {
            const response = await fetch('https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings/complete', {
                method: 'POST',
                headers: { 
                    ...API_HEADERS, 
                    'Authorization': req.headers.authorization 
                }
            });
            const data = await response.json();
            return res.status(response.status).json(data);
        }

        return res.status(404).json({ error: 'Rota não encontrada' });
    } catch (error) {
        console.error('Erro no Backend:', error);
        return res.status(500).json({ error: 'Erro interno no servidor', details: error.message });
    }
}
