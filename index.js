require('dotenv').config();
const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');

class TelegramNotifier {
    constructor(token) {
        // Enable polling mode
        this.bot = new TelegramBot(token, { polling: true });
        this.subscribers = new Set();
        this.storageFile = path.join(__dirname, 'subscribers.json');
        
        // Load existing subscribers
        this.loadSubscribers();


        // Listen for /start commands
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;
            this.subscribers.add(chatId);
            await this.saveSubscribers();
            this.bot.sendMessage(chatId, "Welcome! You'll now receive notifications for SOL transfers.");
            console.log('New subscriber:', chatId);
        });

        // Listen for /stop commands
        this.bot.onText(/\/stop/, async (msg) => {
            const chatId = msg.chat.id;
            this.subscribers.delete(chatId);
            await this.saveSubscribers();
            this.bot.sendMessage(chatId, "You've been unsubscribed from notifications.");
            console.log('Subscriber left:', chatId);
        });
    }

    async loadSubscribers() {
        try {
            const data = await fs.readFile(this.storageFile, 'utf8');
            const subscriberArray = JSON.parse(data);
            this.subscribers = new Set(subscriberArray);
            console.log('Loaded subscribers:', this.subscribers.size);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist yet, start with empty set
                console.log('No existing subscribers file, starting fresh');
                this.subscribers = new Set();
            } else {
                console.error('Error loading subscribers:', error);
            }
        }
    }

    async saveSubscribers() {
        try {
            const subscriberArray = Array.from(this.subscribers);
            await fs.writeFile(this.storageFile, JSON.stringify(subscriberArray));
            console.log('Saved subscribers:', this.subscribers.size);
        } catch (error) {
            console.error('Error saving subscribers:', error);
        }
    }


    async sendMessage(message) {
        try {
            // Send to all subscribers
            const sendPromises = Array.from(this.subscribers).map(chatId =>
                this.bot.sendMessage(chatId, message, { parse_mode: 'HTML' })
                    .catch(error => {
                        if (error.response?.statusCode === 403) {
                            // User has blocked the bot, remove them from subscribers
                            console.log('Removing blocked user:', chatId);
                            this.subscribers.delete(chatId);
                            this.saveSubscribers();
                        } else {
                            console.error(`Error sending to ${chatId}:`, error);
                        }
                    })
            );

            await Promise.all(sendPromises);
        } catch (error) {
            console.error('Failed to send Telegram message:', error);
        }
    }
}

class TransactionMonitor {
    constructor() {
        this.ws = new WebSocket(process.env.SOLANA_WEBHOOK_URL);
        this.connection = new Connection(process.env.SOLANA_RPC_URL);
        this.telegram = new TelegramNotifier(process.env.TELEGRAM_BOT_TOKEN);
        this.targetAmounts = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5].map(x => x * 1000000000);
        this.subscriptions = {};
        this.processedTxs = new Set();
        this.tolerance = 0.002 * 1000000000; // 0.002 SOL tolerance
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
            `To: <code>${txData.to}</code>\n` +
            `From: <code>${txData.from}</code>\n` +
            `Amount: <b>${txData.amount} SOL</b>\n` +
            `Signature: <a href="https://solscan.io/tx/${txData.signature}">View on Solscan</a>`;

        await this.telegram.sendMessage(message);
    }

    async handleAccountUpdate(message) {
        const logs = message.params.result.value;
        const signature = logs.signature;
    
        if (this.processedTxs.has(signature)) {
            return;
        }
        this.processedTxs.add(signature);
    
        if (this.processedTxs.size > 1000) {
            this.processedTxs.clear();
        }
    
        console.log('Full params:', JSON.stringify(message.params, null, 2));
        
        try {
            const txInfo = await this.connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0
            });

            if (!txInfo?.transaction?.message?.instructions) {
                console.log('No valid transaction instructions found');
                return;
            }
    
            if (!txInfo || !txInfo.meta) return;

            // Debug log to see both types of instructions
            console.log('Main instructions:', txInfo.transaction.message.instructions.length);
            console.log('Inner instructions:', txInfo.meta.innerInstructions?.length || 0);
        
            const sender = txInfo.transaction.message.accountKeys[0].toString();
            
            if (![process.env.WALLET_ADDRESS_1, process.env.WALLET_ADDRESS_2].includes(sender)) {
                return;
            }
    
            // Find transfer instruction (System Program instruction with exactly 2 accounts)
            const transferInstruction = txInfo.transaction.message.instructions
            .find(instruction => {
                const programId = txInfo.transaction.message.accountKeys[instruction.programIdIndex];
                
                // Must be system program
                if (programId.toString() !== '11111111111111111111111111111111') return false;
                
                // Must have exactly 2 accounts (source and destination)
                if (instruction.accounts.length !== 2) return false;

                // Extra logging to help debug
                console.log('System instruction accounts:', instruction.accounts);
                console.log('Account keys for these indices:', 
                    instruction.accounts.map(idx => txInfo.transaction.message.accountKeys[idx].toString())
                );

                return true;
            });

            if (!transferInstruction) {
            console.log('No valid transfer instructions found');
            return;
            }

            const balanceChange = txInfo.meta.preBalances[0] - txInfo.meta.postBalances[0];
    
            console.log('Balance change:', balanceChange / 1000000000, 'SOL');
            console.log('Target range:', this.targetAmounts.map(x => x / 1000000000), 'SOL');
    
            if (this.isTargetAmount(balanceChange)) {
                console.log('Debug - instruction accounts:', transferInstruction.accounts);
                console.log('Debug - all account keys:', txInfo.transaction.message.accountKeys.map(key => key.toString()));
    
                // For transfer instruction, the destination is always the second account
                const recipientIndex = transferInstruction.accounts[1];
                const recipient = txInfo.transaction.message.accountKeys[recipientIndex].toString();
    
                // console.log('Transfer detected:', {
                //     from: sender,
                //     to: recipient,
                //     amount: balanceChange / 1000000000,
                //     signature
                // });
    
                await this.notifyTransaction({
                    to: recipient,
                    from: sender,
                    amount: balanceChange / 1000000000,
                    signature
                });
            }
        } catch (error) {
            console.error('Error processing transfer:', error);
            await this.telegram.sendMessage(`❌ Error processing transfer: ${error.message}`);
        }
    }


    // isTargetAmount method
    isTargetAmount(lamports) {
        return this.targetAmounts.some(target => 
            Math.abs(lamports - target) <= this.tolerance
        );
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