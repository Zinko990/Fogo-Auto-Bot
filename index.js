const fs = require('fs');
const axios = require('axios');
const nacl = require('tweetnacl');
const Base58 = require('base-58');
const dotenv = require('dotenv');
const readline = require('readline');
const { HttpsProxyAgent } = require('https-proxy-agent');

dotenv.config();

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0",
];

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

const logger = {
  info: (msg) => console.log(`${colors.cyan}[i] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log(`---------------------------------------------`);
    console.log(`   Fogo Auto Bot - Airdrop Insiders   `);
    console.log(`---------------------------------------------${colors.reset}`);
    console.log();
  },
};

const FOGO_RPC_URL = "https://testnet.fogo.io/";
const VALIANT_API_URL = "https://api.valiant.trade";
const PAYMASTER_URL = "https://sessions-example.fogo.io/paymaster";
const EXPLORER_URL = "https://explorer.fogo.io/tx/";
const PUBLIC_FEE_PAYER = "8HnaXmgFJbvvJxSdjeNyWwMXZb85E35NM4XNg6rxuw3w";

const FOGO_MINT = "So11111111111111111111111111111111111111112";
const FUSD_MINT = "fUSDNGgHkZfwckbr5RLLvRbvqvRcTLdH9hcHJiq4jry";

const MIN_SWAP_AMOUNT = 0.00001; 
const MAX_SWAP_AMOUNT = 0.000015; 
const COUNTDOWN_HOURS = 24; 

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 
 * @param {string} query 
 * @returns {Promise<string>} 
 */
function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

/**
 * 
 * @returns {string[]} 
 */
function loadProxies() {
    try {
        const data = fs.readFileSync('proxies.txt', 'utf8');
        const proxies = data.split('\n').map(p => p.trim()).filter(p => p);
        if (proxies.length === 0) {
            logger.warn("proxies.txt is empty. Running without proxies.\n");
            return [];
        }
        logger.success(`${proxies.length} proxies loaded successfully.`);
        return proxies;
    } catch (error) {
        logger.warn("proxies.txt not found. Running without proxies.");
        return [];
    }
}

/**
 * 
 * @param {object} wallet 
 * @param {number} amountIn 
 * @param {string} direction 
 * @param {HttpsProxyAgent} proxyAgent 
 * @returns {Promise<number>} 
 */
async function performSwap(wallet, amountIn, direction, proxyAgent) {
    const isFogoToFusd = direction === 'FOGO_TO_FUSD';
    const fromToken = isFogoToFusd ? 'FOGO' : 'fUSD';
    const toToken = isFogoToFusd ? 'fUSD' : 'FOGO';

    logger.info(`Attempting to swap ${fromToken} -> ${toToken} for wallet ${wallet.publicKey}`);

    const httpConfig = proxyAgent ? { httpsAgent: proxyAgent } : {};
    const api = axios.create({
        ...httpConfig,
        headers: {
            'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://valiant.trade/'
        }
    });

    const params = {
        mintA: FOGO_MINT,
        mintB: FUSD_MINT,
        aForB: isFogoToFusd ? "true" : "false",
        isExactIn: "true",
        inputAmount: amountIn,
        feePayer: PUBLIC_FEE_PAYER,
    };

    try {
        logger.step(`1. Getting ${fromToken}->${toToken} swap quote...`);
        const quoteResponse = await api.get(`${VALIANT_API_URL}/dex/quote`, { params });
        const { tokenMinOut, poolAddress } = quoteResponse.data.quote;
        if (!tokenMinOut || !poolAddress) throw new Error("Failed to get a valid quote.");
        logger.success(`Quote received: Minimum receive ${tokenMinOut / (isFogoToFusd ? 1e6 : 1e9)} ${toToken}.`);

        logger.step(`2. Creating ${fromToken}->${toToken} swap transaction...`);
        const txsParams = { ...params, userAddress: wallet.publicKey, outputAmount: tokenMinOut, poolAddress, sessionAddress: wallet.publicKey };
        const txsResponse = await api.get(`${VALIANT_API_URL}/dex/txs/swap`, { params: txsParams });
        const { serializedTx } = txsResponse.data;
        if (!serializedTx) throw new Error("Failed to get transaction data.");
        logger.success("Transaction data created successfully.");

        logger.step("3. Signing transaction...");
        const rawTxBuffer = Buffer.from(serializedTx, 'base64');
        const numSignatures = rawTxBuffer[0];
        if (numSignatures < 2) throw new Error(`Unexpected tx format, expected 2 signatures, got ${numSignatures}`);
        const messageToSign = rawTxBuffer.slice(1 + (numSignatures * 64));
        const signature = nacl.sign.detached(messageToSign, wallet.keyPair.secretKey);
        const signedTxBuffer = Buffer.from(rawTxBuffer);
        signedTxBuffer.set(signature, 1 + 64);
        logger.success("Transaction signed successfully.");

        logger.step("4. Sending transaction to paymaster...");
        const finalTxBase64 = signedTxBuffer.toString('base64');
        const paymasterResponse = await axios.post(PAYMASTER_URL, { transaction: finalTxBase64 }, { headers: { 'Content-Type': 'application/json' }, ...httpConfig });
        const txHash = paymasterResponse.data;
        if (!txHash || typeof txHash !== 'string' || txHash.length < 80) throw new Error(`Paymaster error: ${JSON.stringify(txHash)}`);
        logger.success(`Transaction sent! Hash: ${colors.yellow}${EXPLORER_URL}${txHash}${colors.reset}`);

        logger.step("5. Waiting for transaction confirmation...");
        const confirmed = await confirmTransaction(txHash, api);
        if (confirmed) {
            logger.success(`Swap for wallet ${wallet.publicKey} confirmed!`);
            return parseInt(tokenMinOut);
        } else {
            logger.error(`Failed to confirm swap for wallet ${wallet.publicKey}.`);
            return 0;
        }
    } catch (error) {
        logger.error(`An error occurred during ${fromToken}->${toToken} swap:`);
        if (error.response) logger.error(`Error Data: ${JSON.stringify(error.response.data)}`);
        else logger.error(error.message);
        return 0;
    }
}

/**
 * 
 * @param {string} txHash T
 * @param {axios.AxiosInstance} api T
 * @returns {Promise<boolean>} 
 */
async function confirmTransaction(txHash, api, timeout = 90000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const response = await api.post(FOGO_RPC_URL, {
                jsonrpc: "2.0",
                id: "1",
                method: "getSignatureStatuses",
                params: [[txHash], { searchTransactionHistory: true }]
            });
            const result = response.data.result;
            if (result && result.value && result.value[0]) {
                const status = result.value[0];
                if (status.confirmationStatus === 'finalized' || status.confirmationStatus === 'confirmed') {
                    if (status.err) {
                        logger.error(`Transaction failed with error: ${JSON.stringify(status.err)}`);
                        return false;
                    }
                    logger.success(`Confirmation status: ${status.confirmationStatus}`);
                    return true;
                }
                logger.loading(`Current status: ${status.confirmationStatus}. Waiting...`);
            } else {
                logger.loading("No status yet, waiting...");
            }
        } catch (error) {
            logger.warn("Failed to check status, retrying...");
        }
        await delay(5000);
    }
    logger.error("Timeout while waiting for transaction confirmation.");
    return false;
}

/**
 * 
 * @param {number} hours 
 */
async function startCountdown(hours) {
    let totalSeconds = hours * 3600;
    logger.info(`All cycles complete. Starting a ${hours}-hour countdown until the next run...`);
    
    const timer = setInterval(() => {
        totalSeconds--;
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        process.stdout.write(`\r${colors.cyan}Next cycle in: ${h}h ${m}m ${s}s  ${colors.reset}`);
        if (totalSeconds <= 0) {
            clearInterval(timer);
            console.log(); 
            logger.success("Countdown finished. Starting new cycle.");
        }
    }, 1000);

    await delay(hours * 3600 * 1000);
}

async function main() {
    logger.banner();

    const privateKeys = Object.keys(process.env)
        .filter(key => key.startsWith('PRIVATE_KEY_'))
        .map(key => process.env[key]);

    if (privateKeys.length === 0) {
        logger.error("No PRIVATE_KEY_ found in the .env file.");
        return;
    }

    const wallets = privateKeys.map(pk => {
        try {
            const keyPair = nacl.sign.keyPair.fromSecretKey(Base58.decode(pk));
            return { keyPair, publicKey: Base58.encode(keyPair.publicKey) };
        } catch (e) {
            logger.error(`Failed to process private key: ${pk.substring(0, 5)}... Please check format.`);
            return null;
        }
    }).filter(w => w);

    logger.success(`${wallets.length} wallet(s) loaded successfully.`);
    const proxies = loadProxies();
    
    const cyclesStr = await askQuestion(`${colors.cyan}➤ Enter the number of daily transaction cycles to perform: ${colors.reset}`);
    const numCycles = parseInt(cyclesStr);

    if (isNaN(numCycles) || numCycles <= 0) {
        logger.error("Invalid number. Please enter a positive integer.");
        return;
    }

    let proxyIndex = 0;
    while (true) { 
        for (const wallet of wallets) {
            const proxy = proxies.length > 0 ? proxies[proxyIndex % proxies.length] : null;
            const proxyAgent = proxy ? new HttpsProxyAgent(proxy) : null;
            if (proxy) logger.info(`Using proxy: ${proxy.split('@')[1] || proxy}`);
            proxyIndex++;

            for (let i = 0; i < numCycles; i++) {
                logger.info(`--- Starting cycle ${i + 1}/${numCycles} for wallet ${wallet.publicKey} ---`);

                const randomAmountFogo = MIN_SWAP_AMOUNT + Math.random() * (MAX_SWAP_AMOUNT - MIN_SWAP_AMOUNT);
                const amountLamports = Math.floor(randomAmountFogo * 1e9);
                logger.info(`Generated random amount: ${randomAmountFogo.toFixed(6)} FOGO (${amountLamports} lamports)`);
                
                const fusdReceived = await performSwap(wallet, amountLamports, 'FOGO_TO_FUSD', proxyAgent);
                
                if (fusdReceived > 0) {
                    logger.info("Waiting 15 seconds before swapping back...");
                    await delay(15000);

                    await performSwap(wallet, fusdReceived, 'FUSD_TO_FOGO', proxyAgent);
                } else {
                    logger.error("Skipping swap back due to failure in the first swap.");
                }
                logger.info(`--- Cycle ${i + 1}/${numCycles} for wallet ${wallet.publicKey} finished. ---\n`);
                await delay(10000); 
            }
        }
        await startCountdown(COUNTDOWN_HOURS);
    }
}

main().catch(err => {
    logger.error("A fatal error occurred:");
    console.error(err);
});
