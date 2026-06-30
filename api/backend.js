export default async function handler(req, res) {
    const API_HEADERS = {
        'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
        'X-Product-Name': 'SalaDoFuturo',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };

    try {
        if (req.url === '/api/login' && req.method === 'POST') {
            const response = await fetch('https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken', {
                method: 'POST',
                headers: API_HEADERS,
                body: JSON.stringify(req.body)
            });
            return res.status(response.status).json(await response.json());
        }

        if (req.url === '/api/books' && req.method === 'GET') {
            const response = await fetch('https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings', {
                method: 'GET',
                headers: { ...API_HEADERS, 'Authorization': req.headers.authorization }
            });
            return res.status(response.status).json(await response.json());
        }

        return res.status(404).json({ error: 'Not found' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
