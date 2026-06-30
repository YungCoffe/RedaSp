export default async function handler(req, res) {
    // 1. Recebe o payload (user e senha) que vem do index.html
    const payload = req.body; 

    try {
        // 2. Encaminha exatamente esse payload para o endpoint oficial
        const response = await fetch('https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/LoginCompletoToken', {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': 'd701a2043aa24d7ebb37e9adf60d043b',
                'X-Product-Name': 'SalaDoFuturo',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
