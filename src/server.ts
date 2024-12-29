import express from 'express';
import axios from 'axios';

const app = express();
const port = process.env.PORT || 3000;

// Middleware para processar JSON
app.use(express.json());

// Estruturas para armazenar mensagens e timers
const messageBuffers = new Map<string, any[]>();
const timeouts = new Map<string, NodeJS.Timeout>();

// Função para enviar webhook agregado
async function sendAggregatedWebhook(id: string) {
    try {
        const messages = messageBuffers.get(id) || [];
        if (messages.length === 0) return;

        // Pegar o último webhook recebido
        const lastMessage = messages[messages.length - 1];

        // Criar mensagem agregada com todos os dados
        const aggregatedMessage = JSON.stringify({
            id,
            messages: messages, // Array com todos os webhooks recebidos
            timestamp: new Date().toISOString(),
            ...lastMessage // Incluindo todas as variáveis do último webhook recebido
        });

        // Enviar webhook agregado
        await axios.post(
            process.env.WEBHOOK_URL || 'https://n8n.appvendai.com.br/webhook-test/8ee2a9a5-184f-42fe-a197-3b8434227814', 
            aggregatedMessage,
            {
                validateStatus: () => true, // Aceita qualquer status code como sucesso
                headers: {
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('Webhook agregado enviado:', aggregatedMessage);

        // Limpar buffer após envio
        messageBuffers.delete(id);
        timeouts.delete(id);
    } catch (error) {
        console.error('Erro ao enviar webhook agregado:', error);
    }
}

// Endpoint para receber webhooks
app.post('/webhook', async (req: express.Request, res: express.Response) => {
    try {
        const { id, ...messageData } = req.body;
        
        if (!id) {
            return res.status(400).json({
                status: 'error',
                message: 'ID é obrigatório'
            });
        }

        console.log('Webhook recebido:', { id, ...messageData });

        // Cancelar timer anterior se existir
        if (timeouts.has(id)) {
            clearTimeout(timeouts.get(id));
        }

        // Adicionar nova mensagem ao buffer existente ou criar novo
        if (!messageBuffers.has(id)) {
            messageBuffers.set(id, []);
        }
        messageBuffers.get(id)?.push(messageData);

        // Configurar novo timer para esta mensagem
        const timeout = setTimeout(() => {
            sendAggregatedWebhook(id);
        }, 60000); // 60 segundos

        timeouts.set(id, timeout);
        
        res.status(200).json({
            status: 'success',
            message: 'Webhook recebido com sucesso',
            data: { id, ...messageData }
        });
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        res.status(500).json({
            status: 'error',
            message: 'Erro ao processar webhook'
        });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando em http://localhost:${port}`);
});
