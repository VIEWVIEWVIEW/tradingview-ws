"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCandles = exports.connect = void 0;
const axios_1 = __importDefault(require("axios"));
const ws_1 = __importDefault(require("ws"));
const randomstring_1 = __importDefault(require("randomstring"));
const MAX_BATCH_SIZE = 5000; // found experimentally
function parseMessage(message) {
    if (message.length === 0)
        return [];
    const events = message.toString().split(/~m~\d+~m~/).slice(1);
    return events.map(event => {
        if (event.substring(0, 3) === "~h~") {
            return { type: 'ping', data: `~m~${event.length}~m~${event}` };
        }
        const parsed = JSON.parse(event);
        if (parsed['session_id']) {
            return { type: 'session', data: parsed };
        }
        return { type: 'event', data: parsed };
    });
}
function connect(options = {}) {
    return __awaiter(this, void 0, void 0, function* () {
        let token = 'unauthorized_user_token';
        if (options.sessionId) {
            const resp = yield (0, axios_1.default)({
                method: 'get',
                url: 'https://www.tradingview.com/disclaimer/',
                headers: { "Cookie": `sessionid=${options.sessionId}` }
            });
            token = resp.data.match(/"auth_token":"(.+?)"/)[1];
        }
        const connection = new ws_1.default("wss://prodata.tradingview.com/socket.io/websocket", {
            origin: "https://prodata.tradingview.com"
        });
        const subscribers = new Set();
        function subscribe(handler) {
            subscribers.add(handler);
            return () => {
                subscribers.delete(handler);
            };
        }
        function send(name, params) {
            const data = JSON.stringify({ m: name, p: params });
            const message = "~m~" + data.length + "~m~" + data;
            connection.send(message);
        }
        function close() {
            return __awaiter(this, void 0, void 0, function* () {
                return new Promise((resolve, reject) => {
                    connection.on('close', resolve);
                    connection.on('error', reject);
                    connection.close();
                });
            });
        }
        return new Promise((resolve, reject) => {
            connection.on('error', error => reject(error));
            connection.on('message', message => {
                const payloads = parseMessage(message.toString());
                for (const payload of payloads) {
                    switch (payload.type) {
                        case 'ping':
                            connection.send(payload.data);
                            break;
                        case 'session':
                            send('set_auth_token', [token]);
                            resolve({ subscribe, send, close });
                            break;
                        case 'event':
                            const event = {
                                name: payload.data.m,
                                params: payload.data.p
                            };
                            subscribers.forEach(handler => handler(event));
                            break;
                        default:
                            throw new Error(`unknown payload: ${payload}`);
                    }
                }
            });
        });
    });
}
exports.connect = connect;
function getCandles({ connection, symbols, amount, timeframe = 60 }) {
    return __awaiter(this, void 0, void 0, function* () {
        if (symbols.length === 0)
            return [];
        const chartSession = "cs_" + randomstring_1.default.generate(12);
        const batchSize = amount && amount < MAX_BATCH_SIZE ? amount : MAX_BATCH_SIZE;
        return new Promise(resolve => {
            const allCandles = [];
            let currentSymIndex = 0;
            let symbol = symbols[currentSymIndex];
            let currentSymCandles = [];
            const unsubscribe = connection.subscribe(event => {
                // received new candles
                if (event.name === 'timescale_update') {
                    let newCandles = event.params[1]['sds_1']['s'];
                    if (newCandles.length > batchSize) {
                        // sometimes tradingview sends already received candles
                        newCandles = newCandles.slice(0, -currentSymCandles.length);
                    }
                    currentSymCandles = newCandles.concat(currentSymCandles);
                    return;
                }
                // loaded all requested candles
                if (event.name === 'series_completed') {
                    if (currentSymCandles.length % batchSize === 0 && (!amount || currentSymCandles.length < amount)) {
                        connection.send('request_more_data', [chartSession, 'sds_1', batchSize]);
                        return;
                    }
                    // loaded all candles for current symbol
                    if (amount)
                        currentSymCandles = currentSymCandles.slice(0, amount);
                    const candles = currentSymCandles.map(c => ({
                        timestamp: c.v[0],
                        open: c.v[1],
                        high: c.v[2],
                        low: c.v[3],
                        close: c.v[4],
                        volume: c.v[5]
                    }));
                    allCandles.push(candles);
                    // next symbol
                    if (symbols.length - 1 > currentSymIndex) {
                        currentSymCandles = [];
                        currentSymIndex += 1;
                        symbol = symbols[currentSymIndex];
                        connection.send('resolve_symbol', [
                            chartSession,
                            `sds_sym_${currentSymIndex}`,
                            '=' + JSON.stringify({ symbol, adjustment: 'splits' })
                        ]);
                        connection.send('modify_series', [
                            chartSession,
                            'sds_1',
                            `s${currentSymIndex}`,
                            `sds_sym_${currentSymIndex}`,
                            timeframe.toString(),
                            ''
                        ]);
                        return;
                    }
                    // all symbols loaded
                    unsubscribe();
                    resolve(allCandles);
                }
            });
            connection.send('chart_create_session', [chartSession, '']);
            connection.send('resolve_symbol', [
                chartSession,
                `sds_sym_0`,
                '=' + JSON.stringify({ symbol, adjustment: 'splits' })
            ]);
            connection.send('create_series', [
                chartSession, 'sds_1', 's0', 'sds_sym_0', timeframe.toString(), batchSize, ''
            ]);
        });
    });
}
exports.getCandles = getCandles;
//# sourceMappingURL=index.js.map