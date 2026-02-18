/**
 * @namespace MACalc
 */
window.MACalc = window.MACalc || {};

(function(MACalc) {
    /**
     * 带超时的 fetch 请求包装器
     * @param {string} url - 请求地址
     * @param {Object} [options={}] - fetch 配置项
     * @param {number} [timeout=15000] - 超时时间(ms)
     * @returns {Promise<Response>}
     * @throws {Error} 请求超时或网络错误
     */
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
            if (e.name === 'AbortError') {
                throw new Error('请求超时，可能是跨域代理服务响应缓慢，请稍后重试');
            }
            throw new Error(`网络连接异常: ${e.message}`);
        }
    }

    /**
     * 股票数据适配器基类
     * @class
     */
    class BaseAdapter {
        /**
         * 获取股票行情数据
         * @abstract
         * @param {string} code - 股票代码
         * @param {string} apiKey - API 密钥
         * @param {string} market - 市场类型 (CN/HK)
         */
        async fetchStockData(code, apiKey, market) {
            throw new Error('fetchStockData must be implemented');
        }
        
        /**
         * 根据代码和市场获取交易所标识
         * @param {string} code 
         * @param {string} market 
         * @returns {string} SH/SZ/HK
         */
        getExchange(code, market) {
            if (market === 'HK') return 'HK';
            return code.startsWith('6') ? 'SH' : 'SZ';
        }

        /**
         * 港股代码去前导零处理 (00700 -> 700)
         * @param {string} code 
         * @returns {string}
         */
        normalizeHKCode(code) {
            return code.replace(/^0+/, '') || '0';
        }
        
        /**
         * 计算简单移动平均线 (MA)
         * @param {number[]} prices - 价格数组
         * @param {number} period - 周期
         * @returns {number}
         */
        calculateMA(prices, period) {
            if (prices.length < period) return 0;
            const slice = prices.slice(-period);
            return slice.reduce((sum, p) => sum + p, 0) / period;
        }
    }

    /**
     * AllTick API 适配器
     * @extends BaseAdapter
     */
    class AllTickAdapter extends BaseAdapter {
        static CORS_PROXY = 'https://corsproxy.io/?';

        /**
         * 查询股票基本信息
         * @param {string} code 
         * @param {string} apiKey 
         * @param {string} market 
         * @returns {Promise<string|null>} 股票名称
         */
        async fetchStockName(code, apiKey, market) {
            const exchange = this.getExchange(code, market);
            const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
            const fullCode = `${apiCode}.${exchange}`;
            
            const apiUrl = `https://quote.alltick.co/quote-stock-b-api/static_info`;
            const trace = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            const query = {
                trace: trace,
                data: { symbol_list: [{ code: fullCode }] }
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
                return null;
            }
        }

        async fetchStockData(code, apiKey, market) {
            const exchange = this.getExchange(code, market);
            const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
            const fullCode = `${apiCode}.${exchange}`;
            const apiUrl = `https://quote.alltick.co/quote-stock-b-api/kline`;
            const trace = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const query = {
                trace: trace,
                data: {
                    code: fullCode,
                    kline_type: 8,
                    kline_timestamp_end: 0,
                    query_kline_num: 25,
                    adjust_type: 0
                }
            };

            const encodedQuery = encodeURIComponent(JSON.stringify(query));
            const targetUrl = `${apiUrl}?token=${apiKey}&query=${encodedQuery}`;
            const proxyUrl = `${AllTickAdapter.CORS_PROXY}${encodeURIComponent(targetUrl)}`;
            
            let response;
            try {
                response = await fetchWithTimeout(proxyUrl);
            } catch (e) {
                throw new Error(`AllTick 请求失败: ${e.message}`);
            }

            if (!response.ok) {
                if (response.status === 429) {
                    throw new Error('AllTick 代理限流中，请尝试切换 iTick 接口');
                }
                throw new Error(`API 响应异常 (HTTP ${response.status})`);
            }

            const data = await response.json();
            return this.parseAllTickData(data);
        }

        parseAllTickData(data) {
            if (data.ret !== 200 || !data.data || !data.data.kline_list) {
                throw new Error(data.msg || 'AllTick 返回了无效的数据格式');
            }

            const klines = data.data.kline_list;
            if (klines.length < 21) {
                throw new Error(`历史数据不足 (当前 ${klines.length} 条)，无法计算 20 日均线`);
            }

            const closes = klines.map(k => parseFloat(k.close_price));
            const latestKline = klines[klines.length - 1];

            return {
                current: closes[closes.length - 1],
                a5: closes[closes.length - 6],
                a10: closes[closes.length - 11],
                a20: closes[closes.length - 21],
                ma5_1: this.calculateMA(closes, 5),
                ma10_1: this.calculateMA(closes, 10),
                ma20_1: this.calculateMA(closes, 20),
                stockName: latestKline.name || '',
                stockCode: latestKline.code || '',
                high: parseFloat(latestKline.high_price) || 0,
                low: parseFloat(latestKline.low_price) || 0,
                open: parseFloat(latestKline.open_price) || 0,
                close: parseFloat(latestKline.close_price) || 0
            };
        }
    }

    /**
     * iTick API 适配器
     * @extends BaseAdapter
     */
    class ITickAdapter extends BaseAdapter {
        async fetchStockName(code, apiKey, market) {
            const exchange = this.getExchange(code, market);
            const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
            const url = `https://api.itick.org/stock/info?type=stock&region=${exchange}&code=${apiCode}`;
            
            try {
                const response = await fetchWithTimeout(url, { headers: { 'token': apiKey } });
                if (!response.ok) return null;
                const result = await response.json();
                return (result.code === 0 && result.data) ? result.data.n : null;
            } catch (e) {
                return null;
            }
        }

        async fetchStockData(code, apiKey, market) {
            const exchange = this.getExchange(code, market);
            const apiCode = market === 'HK' ? this.normalizeHKCode(code) : code;
            const url = `https://api.itick.org/stock/kline?region=${exchange}&code=${apiCode}&kType=8&limit=25`;
            
            let response;
            try {
                response = await fetchWithTimeout(url, { headers: { 'token': apiKey } });
            } catch (e) {
                throw new Error(`iTick 请求失败: ${e.message}`);
            }
            
            if (!response.ok) throw new Error(`API 响应异常 (HTTP ${response.status})`);
            
            const result = await response.json();
            if (result.code !== 0 || !result.data) {
                throw new Error(result.msg || 'iTick 返回了错误代码');
            }
            
            const klines = result.data;
            if (klines.length < 21) throw new Error(`历史数据不足，无法计算均线`);
            
            const closes = klines.map(k => parseFloat(k.c));
            const latestKline = klines[klines.length - 1];

            return {
                current: closes[closes.length - 1],
                a5: closes[closes.length - 6],
                a10: closes[closes.length - 11],
                a20: closes[closes.length - 21],
                ma5_1: this.calculateMA(closes, 5),
                ma10_1: this.calculateMA(closes, 10),
                ma20_1: this.calculateMA(closes, 20),
                stockName: latestKline.name || latestKline.n || '',
                stockCode: latestKline.code || latestKline.s || '',
                high: parseFloat(latestKline.h) || 0,
                low: parseFloat(latestKline.l) || 0,
                open: parseFloat(latestKline.o) || 0,
                close: parseFloat(latestKline.c) || 0
            };
        }
    }

    /**
     * 适配器工厂
     * @namespace MACalc.AdapterFactory
     */
    MACalc.AdapterFactory = {
        /**
         * 创建适配器实例
         * @param {string} provider - 服务商 (alltick/itick)
         * @returns {BaseAdapter}
         */
        create(provider) {
            const adapters = {
                'alltick': AllTickAdapter,
                'itick': ITickAdapter
            };
            const AdapterClass = adapters[provider];
            if (!AdapterClass) throw new Error(`不支持的服务商: ${provider}`);
            return new AdapterClass();
        }
    };

})(window.MACalc);

