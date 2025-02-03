require('dotenv').config();
const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');

class TransactionMonitor {
    constructor() {
        this.ws = new WebSocket(process.env.SOLANA_WEBHOOK_URL);
        this.connection = new Connection(process.env.SOLANA_RPC_URL);

        this.targetAmounts = [0.001, 1000].map(x => x * 1000000000);
        // this.targetAmounts = [1.5, 2, 2.5, 3, 3.5, 4].map(x => x * 1000000000);
        this.subscriptions = {};  // lamports
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

    async handleAccountUpdate(message) {
        const logs = message.params.result.value;
        const signature = logs.signature;

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
    
            // Get first instruction (transfer instruction)
            const instruction = txInfo.transaction.message.instructions[0];
            if (!instruction) return;
    
            // Verify it's a SOL transfer (system program)
            const programId = txInfo.transaction.message.accountKeys[instruction.programIdIndex];
            if (programId.toString() !== '11111111111111111111111111111111') return;
    
            // Get transfer amount
            const balanceChange = txInfo.meta.preBalances[0] - txInfo.meta.postBalances[0];
            
            // Check if amount is within target range
            if (this.isTargetAmount(balanceChange)) {
                const recipient = txInfo.transaction.message.accountKeys[instruction.accounts[3]].toString();
                
                console.log('Outgoing transfer detected:', {
                    from: sender,
                    to: recipient,
                    amount: balanceChange / 1000000000,
                    signature
                });
            }
        } catch (error) {
            console.error('Error processing transfer:', error);
        }
    }


    // isTargetAmount(lamports) {
    //     return this.targetAmounts.some(target => 
    //         Math.abs(lamports - target) <= this.tolerance
    //     );
    // }

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

    notifyTransaction(txData) {
        console.log('Target transaction detected:', txData);
    }
}

const monitor = new TransactionMonitor();
monitor.start().catch(console.error);