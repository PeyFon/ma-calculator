// Stock Data API Adapters
// Supports: AllTick, iTick

// 带超时的 fetch
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

class BaseAdapter {
    async fetchStockData(code, apiKey, market) {
        throw new Error('fetchStockData must be implemented');
    }
    
    // Helper: Determine exchange based on market
    // A股: SH/SZ (by code prefix), 港股: HK
    getExchange(code, market) {
        if (market === 'HK') return 'HK';
        return code.startsWith('6') ? 'SH' : 'SZ';
    }

    // Helper: Strip leading zeros from HK stock codes
    // 港股代码去前导零: 00700 -> 700, 01810 -> 1810
    normalizeHKCode(code) {
        return code.replace(/^0+/, '') || '0';
    }
    
    // Helper: Calculate MA from price array
    calculateMA(prices, period) {
        if (prices.length < period) return 0;
        const slice = prices.slice(-period);
        return slice.reduce((sum, p) => sum + p, 0) / period;
    }
}

// AllTick API Adapter
class AllTickAdapter extends BaseAdapter {
    // CORS代理（corsproxy.io 可用性最好）
    static CORS_PROXY = 'https://corsproxy.io/?';

    // 获取股票名称（先查这个，失败不影响K线查询）
    async fetchStockName(code, apiKey, market) {
        const exchange = this.getExchange(code, market);
        const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
        const fullCode = `${apiCode}.${exchange}`;
        
        const apiUrl = `https://quote.alltick.co/quote-stock-b-api/static_info`;
        
        const trace = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const query = {
            trace: trace,
            data: {
                symbol_list: [{ code: fullCode }]
            }
        };
        
        const encodedQuery = encodeURIComponent(JSON.stringify(query));
        const targetUrl = `${apiUrl}?token=${apiKey}&query=${encodedQuery}`;
        const proxyUrl = `${AllTickAdapter.CORS_PROXY}${encodeURIComponent(targetUrl)}`;
        
        try {
            const response = await fetchWithTimeout(proxyUrl);
            if (!response.ok) return null;
            
            const data = await response.json();
            if (data.ret === 200 && data.data?.static_info_list?.[0]) {
                const info = data.data.static_info_list[0];
                return info.name_cn || info.name_en || null;
            }
            return null;
        } catch (e) {
            return null; // 失败不抛错，让K线查询继续
        }
    }

    async fetchStockData(code, apiKey, market) {
        const exchange = this.getExchange(code, market);
        const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
        const fullCode = `${apiCode}.${exchange}`;

        // 官方文档地址: https://quote.alltick.co/quote-stock-b-api/kline
        const apiUrl = `https://quote.alltick.co/quote-stock-b-api/kline`;

        // 生成唯一追踪码
        const trace = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const query = {
            trace: trace,
            data: {
                code: fullCode,
                kline_type: 8,           // 日K线（整数，不是字符串）
                kline_timestamp_end: 0,  // 从最新交易日往前查
                query_kline_num: 25,     // 查询25根K线
                adjust_type: 0           // 除权
            }
        };

        const encodedQuery = encodeURIComponent(JSON.stringify(query));
        const targetUrl = `${apiUrl}?token=${apiKey}&query=${encodedQuery}`;

        // 使用 corsproxy.io 代理（跳过直连，避免 CORS 错误）
        const proxyUrl = `${AllTickAdapter.CORS_PROXY}${encodeURIComponent(targetUrl)}`;
        
        let response;
        try {
            response = await fetchWithTimeout(proxyUrl);
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error('请求超时，请检查网络连接');
            }
            throw new Error('跨域请求失败，请尝试使用 iTick 或检查网络');
        }

        if (!response.ok) {
            const errorText = await response.text();
            // 429 表示代理服务限流
            if (response.status === 429) {
                throw new Error('AllTick 代理服务繁忙 (429)，请稍后重试或切换到 iTick');
            }
            throw new Error(`AllTick API 失败 (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        return this.parseAllTickData(data);
    }

    // 解析AllTick返回的数据
    parseAllTickData(data) {
        if (data.ret !== 200 || !data.data || !data.data.kline_list) {
            throw new Error(data.msg || 'AllTick 返回数据格式错误');
        }

        const klines = data.data.kline_list;
        if (klines.length < 21) {
            throw new Error(`数据不足: 只有 ${klines.length} 条记录，需要至少 21 条`);
        }

        const closes = klines.map(k => parseFloat(k.close_price));

        // 获取最新一条K线数据（当日）
        const latestKline = klines[klines.length - 1];

        return {
            // 均线计算数据
            current: closes[closes.length - 1],
            a5: closes[closes.length - 6],
            a10: closes[closes.length - 11],
            a20: closes[closes.length - 21],
            ma5_1: this.calculateMA(closes, 5),
            ma10_1: this.calculateMA(closes, 10),
            ma20_1: this.calculateMA(closes, 20),
            // 当日股票信息
            stockName: latestKline.name || '',
            stockCode: latestKline.code || '',
            high: parseFloat(latestKline.high_price) || 0,
            low: parseFloat(latestKline.low_price) || 0,
            open: parseFloat(latestKline.open_price) || 0,
            close: parseFloat(latestKline.close_price) || 0
        };
    }
}

// iTick API Adapter (支持CORS，浏览器可直接调用)
class ITickAdapter extends BaseAdapter {
    // 获取股票名称（先查这个，失败不影响K线查询）
    async fetchStockName(code, apiKey, market) {
        const exchange = this.getExchange(code, market);
        const region = exchange;
        const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
        
        const url = `https://api.itick.org/stock/info?type=stock&region=${region}&code=${apiCode}`;
        
        try {
            const response = await fetchWithTimeout(url, {
                headers: { 'token': apiKey }
            });
            if (!response.ok) return null;
            
            const result = await response.json();
            if (result.code === 0 && result.data) {
                return result.data.n || null; // n 是名称字段
            }
            return null;
        } catch (e) {
            return null; // 失败不抛错，让K线查询继续
        }
    }

    async fetchStockData(code, apiKey, market) {
        const exchange = this.getExchange(code, market);
        const region = exchange;
        const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
        
        // iTick API 直接调用（支持CORS）
        const url = `https://api.itick.org/stock/kline?region=${region}&code=${apiCode}&kType=8&limit=25`;
        
        let response;
        try {
            response = await fetchWithTimeout(url, {
                headers: { 'token': apiKey }
            });
        } catch (e) {
            if (e.name === 'AbortError') {
                throw new Error('请求超时，请检查网络连接');
            }
            throw new Error('网络请求失败: ' + e.message);
        }
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`iTick API 失败 (${response.status}): ${errorText}`);
        }
        
        const result = await response.json();
        if (result.code !== 0 || !result.data) {
            throw new Error(result.msg || 'iTick API 返回错误');
        }
        
        const klines = result.data;
        if (klines.length < 21) {
            throw new Error(`数据不足: 只有 ${klines.length} 条记录，需要至少 21 条`);
        }
        
        const closes = klines.map(k => parseFloat(k.c));

        // 获取最新一条K线数据（当日）
        const latestKline = klines[klines.length - 1];

        return {
            // 均线计算数据
            current: closes[closes.length - 1],
            a5: closes[closes.length - 6],
            a10: closes[closes.length - 11],
            a20: closes[closes.length - 21],
            ma5_1: this.calculateMA(closes, 5),
            ma10_1: this.calculateMA(closes, 10),
            ma20_1: this.calculateMA(closes, 20),
            // 当日股票信息
            stockName: latestKline.name || latestKline.n || '',
            stockCode: latestKline.code || latestKline.s || '',
            high: parseFloat(latestKline.h) || 0,
            low: parseFloat(latestKline.l) || 0,
            open: parseFloat(latestKline.o) || 0,
            close: parseFloat(latestKline.c) || 0
        };
    }
}

// Adapter Factory
const AdapterFactory = {
    create(provider) {
        const adapters = {
            'alltick': AllTickAdapter,
            'itick': ITickAdapter
        };
        
        const AdapterClass = adapters[provider];
        if (!AdapterClass) {
            throw new Error(`Unknown provider: ${provider}`);
        }
        
        return new AdapterClass();
    }
};
