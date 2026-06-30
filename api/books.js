export default async function handler(req, res) {
    // Verifica se existe token de autorização
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    try {
        const response = await fetch('https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings', {
            method: 'GET',
            headers: {
                'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
                'X-Product-Name': 'SalaDoFuturo',
                'Authorization': authHeader, // Repassa o token recebido do front
                'Accept': 'application/json'
            }
        });
        
        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (error) {
        return res.status(500).json({ error: 'Erro ao buscar livros: ' + error.message });
    }
}
