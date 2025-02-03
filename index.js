require('dotenv').config();
const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');

class TelegramNotifier {
    constructor(token, chatId) {
        this.bot = new TelegramBot(token, { polling: false });
        this.chatId = chatId;
    }

    async sendMessage(message) {
        try {
            await this.bot.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            console.error('Failed to send Telegram message:', error);
        }
    }
}

class TransactionMonitor {
    constructor() {
        this.ws = new WebSocket(process.env.SOLANA_WEBHOOK_URL);
        this.connection = new Connection(process.env.SOLANA_RPC_URL);
        this.telegram = new TelegramNotifier(
            process.env.TELEGRAM_BOT_TOKEN,
            process.env.TELEGRAM_CHAT_ID
        );
        this.targetAmounts = [0.001, 1000].map(x => x * 1000000000);
        this.subscriptions = {};  // lamports
        this.processedTxs = new Set();  // To track processed transactions
    }

    subscribeToLogs(address) {
        const request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "logsSubscribe",
            "params": [
                {
                    "mentions": [ address ]
                },
                {
                    "commitment": "confirmed"
                }
            ]
        };
        this.ws.send(JSON.stringify(request));
    }

    startPing() {
        setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
                console.log('Ping sent');
            }
        }, 30000);
    }

    async start() {
        const addresses = [
            process.env.WALLET_ADDRESS_1,
            process.env.WALLET_ADDRESS_2
        ].filter(Boolean);

        this.ws.on('open', () => {
            console.log('WebSocket connected');
            addresses.forEach(addr => this.subscribeToLogs(addr));
            this.startPing();
        });

        this.ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log('Received message:', message);

                if (message.result) {
                    // Store subscription ID with corresponding address
                    this.subscriptions[message.result] = addresses[message.id - 1];
                }

                if (message.method === 'logsNotification') {
                    await this.handleAccountUpdate(message);
                }
            } catch (e) {
                console.error('Failed to parse message:', e);
            }
        });

        this.ws.on('error', console.error);
        this.ws.on('close', () => console.log('WebSocket closed'));
    }

    async notifyTransaction(txData) {
        console.log('Target transaction detected:', txData);
        
        const message = `🔔 <b>New Transfer Detected</b>\n\n` +
            `From: <code>${txData.from}</code>\n` +
            `To: <code>${txData.to}</code>\n` +
            `Amount: <b>${txData.amount} SOL</b>\n` +
            `Signature: <a href="https://solscan.io/tx/${txData.signature}">View on Solscan</a>`;

        await this.telegram.sendMessage(message);
    }

    async handleAccountUpdate(message) {
        const logs = message.params.result.value;
        const signature = logs.signature;

        // Check if we've already processed this transaction
        if (this.processedTxs.has(signature)) {
            return;
        }
        this.processedTxs.add(signature);

        // Add a cleanup for old signatures every 1000 transactions
        if (this.processedTxs.size > 1000) {
            this.processedTxs.clear();
        }

        console.log('Full params:', JSON.stringify(message.params, null, 2));
        console.log('Context:', JSON.stringify(message.params.result.context, null, 2));
        console.log('Value:', JSON.stringify(message.params.result.value, null, 2));
        
        try {
            const txInfo = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });
    
            if (!txInfo || !txInfo.meta) return;
    
            // Get transaction sender
            const sender = txInfo.transaction.message.accountKeys[0].toString();
            
            // Check if sender is one of our monitored wallets
            if (![process.env.WALLET_ADDRESS_1, process.env.WALLET_ADDRESS_2].includes(sender)) {
                return;
            }

            // Check if this is a nonce transaction
            const isNonceTransaction = logs.logs.some(log => 
                log.includes('Initialize nonce account') || 
                log.includes('Advance nonce account')
            );

            // For nonce transactions, we need to check both SOL transfer instructions
            if (isNonceTransaction) {
                txInfo.transaction.message.instructions.forEach((instruction) => {
                    const programId = txInfo.transaction.message.accountKeys[instruction.programIdIndex];
                    
                    if (programId.toString() === '11111111111111111111111111111111') {
                        const balanceChange = txInfo.meta.preBalances[0] - txInfo.meta.postBalances[0];

                        console.log('Balance change:', balanceChange / 1000000000, 'SOL');
                        console.log('Target range:', this.targetAmounts.map(x => x / 1000000000), 'SOL');
                        
                        if (this.isTargetAmount(balanceChange)) {
                            console.log('Debug - instruction accounts:', instruction.accounts);
                            console.log('Debug - all account keys:', txInfo.transaction.message.accountKeys.map(key => key.toString()));
                            const recipient = txInfo.transaction.message.accountKeys[3].toString();

                            if (recipient) {
                                this.notifyTransaction({
                                    from: sender,
                                    to: recipient,
                                    amount: balanceChange / 1000000000,
                                    signature
                                });
                            }
                        }
                    }
                });
            } else {
                // Handle regular transfer
                const instruction = txInfo.transaction.message.instructions[0];
                if (!instruction) return;

                const programId = txInfo.transaction.message.accountKeys[instruction.programIdIndex];
                if (programId.toString() !== '11111111111111111111111111111111') return;

                const balanceChange = txInfo.meta.preBalances[0] - txInfo.meta.postBalances[0];

                console.log('Balance change:', balanceChange / 1000000000, 'SOL');
                console.log('Target range:', this.targetAmounts.map(x => x / 1000000000), 'SOL');
                
                if (this.isTargetAmount(balanceChange)) {
                    console.log('Debug - instruction accounts:', instruction.accounts);
                    console.log('Debug - all account keys:', txInfo.transaction.message.accountKeys.map(key => key.toString()));
                    
                    const recipientIndex = instruction.accounts[1];
                    const recipient = txInfo.transaction.message.accountKeys[recipientIndex].toString();                
                    
                    this.notifyTransaction({
                        from: sender,
                        to: recipient,
                        amount: balanceChange / 1000000000,
                        signature
                    });
                }
            }
        } catch (error) {
            console.error('Error processing transfer:', error);
            await this.telegram.sendMessage(`❌ Error processing transfer: ${error.message}`);
        }
    }

    isTargetAmount(lamports) {
        return lamports >= this.targetAmounts[0] && lamports <= this.targetAmounts[1];
    }

    async isNewWallet(address) {
        try {
            const history = await this.connection.getSignaturesForAddress(
                new PublicKey(address),
                { limit: 2 }
            );
            return history.length <= 1;
        } catch (error) {
            return false;
        }
    }
}

const monitor = new TransactionMonitor();
monitor.start().catch(console.error);