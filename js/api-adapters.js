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
            
            // jina.ai 代理返回 Markdown 格式，需要提取 JSON
            const isJinaProxy = url.includes('r.jina.ai/http');
            if (isJinaProxy) {
                const text = await response.text();
                const mdMatch = text.match(/\{[\s\S]*\}/);
                if (mdMatch) {
                    const jsonStr = mdMatch[0];
                    const blob = new Blob([jsonStr], { type: 'application/json' });
                    return new Response(blob, { status: response.status, statusText: response.statusText });
                }
            }
            
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
     * JSONP 辅助方法
     * @param {string} url - 请求URL
     * @param {string} callbackName - 回调函数名
     * @param {number} timeout - 超时时间(ms)
     * @returns {Promise<any>}
     */
    function fetchJSONP(url, callbackName, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            let timeoutId;
            
            // 清理函数
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                if (script.parentNode) script.parentNode.removeChild(script);
                if (window[callbackName]) delete window[callbackName];
            };
            
            // 设置超时
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('JSONP 请求超时'));
            }, timeout);
            
            // 绑定回调
            window[callbackName] = (data) => {
                cleanup();
                resolve(data);
            };
            
            // 错误处理
            script.onerror = () => {
                cleanup();
                reject(new Error('JSONP 请求失败'));
            };
            
            script.src = url;
            document.head.appendChild(script);
        });
    }

    /**
     * 针对腾讯股票数据特殊格式的 Script 注入辅助方法
     * 不使用回调函数，而是监听脚本加载完成，然后读取全局变量
     * @param {string} url - 请求URL
     * @param {string} varName - 全局变量名
     * @param {number} timeout - 超时时间(ms)
     * @returns {Promise<any>}
     */
    function fetchScriptVar(url, varName, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            let timeoutId;
            
            const cleanup = () => {
                if (timeoutId) clearTimeout(timeoutId);
                if (script.parentNode) script.parentNode.removeChild(script);
            };
            
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('脚本请求超时'));
            }, timeout);
            
            script.onload = () => {
                cleanup();
                if (window[varName] !== undefined) {
                    const data = window[varName];
                    resolve(data);
                } else {
                    reject(new Error(`未找到全局变量 ${varName}`));
                }
            };
            
            script.onerror = () => {
                cleanup();
                reject(new Error('脚本请求失败'));
            };
            
            script.src = url;
            document.head.appendChild(script);
        });
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
            // 6开头的是上交所股票
            if (code.startsWith('6')) {
                return 'SH';
            }
            // 000 开头的判断：
            // A股中，000xxx 既有上证指数也有深证股票
            // 上证指数通常是：000001(上证指数), 000300(沪深300), 000016(上证50), 000688(科创50)等
            // 但是深证 A 股也是 000xxx 开头。
            // 这里的逻辑需要和搜索结果配合。如果搜索出来的 MktNum 是 1 则是 SH。
            // 默认情况下，000开头的 A 股（非指数）在深交所。
            // 鉴于本项目主要通过搜索获取，此处做一个基础兜底判断：
            // 典型的上证指数代码 (000001, 000300, 000010, 000016, 000905等)
            const shIndices = ['000001', '000002', '000003', '000010', '000016', '000300', '000905', '000688'];
            if (shIndices.includes(code)) {
                return 'SH';
            }
            // 其他 000, 001, 002, 300, 399 均属于深圳
            if (code.startsWith('000') || code.startsWith('001') || code.startsWith('002') || code.startsWith('300') || code.startsWith('399')) {
                return 'SZ';
            }
            // 默认
            return 'SZ';
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
        static CORS_PROXY = 'https://r.jina.ai/http://';

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
                // iTick K线接口不返回 name/code/open 字段，这些通过 fetchStockName 单独获取
                stockName: '',
                stockCode: apiCode,
                high: parseFloat(latestKline.h) || 0,
                low: parseFloat(latestKline.l) || 0,
                open: 0,  // K线接口不返回开盘价
                close: parseFloat(latestKline.c) || 0
            };
        }
    }

    /**
     * 东方财富 API 适配器
     * @extends BaseAdapter
     * 无需API Key，直接使用 JSONP 访问
     */
    class EastMoneyAdapter extends BaseAdapter {
        // 请求间隔（毫秒）
        static REQUEST_INTERVAL = 2000;
        
        // 最大等待时间（毫秒）
        static MAX_WAIT_TIME = 30000;
        
        // 最大重试次数
        static MAX_RETRIES = 3;

        constructor() {
            super();
            this.lastRequestTime = 0;
        }

        /**
         * 等待指定时间
         * @param {number} ms - 毫秒
         * @returns {Promise<void>}
         */
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /**
         * 检查并等待请求间隔
         * @returns {Promise<void>}
         */
        async waitForInterval() {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            
            if (timeSinceLastRequest < EastMoneyAdapter.REQUEST_INTERVAL) {
                const waitTime = EastMoneyAdapter.REQUEST_INTERVAL - timeSinceLastRequest;
                await this.sleep(waitTime);
            }
            
            this.lastRequestTime = Date.now();
        }

        /**
         * 获取东方财富市场前缀
         * @param {string} code 
         * @returns {string} 0=深交所, 1=上交所
         */
        getSecid(code) {
            // 6开头的是上交所股票
            if (code.startsWith('6')) {
                return '1.'; // 上交所 -> 1.600000
            }
            // 典型的上证指数代码
            const shIndices = ['000001', '000002', '000003', '000010', '000016', '000300', '000905', '000688'];
            if (shIndices.includes(code)) {
                return '1.'; 
            }
            // 其他(000, 001, 002, 300, 399等)都是深交所
            return '0.'; 
        }

        /**
         * 通过东方财富搜索API获取股票名称 (当前已被app.js内直连腾讯接口取代，此为备用)
         * @param {string} code 
         * @param {string} apiKey (不使用)
         * @param {string} market 
         * @returns {Promise<string|null>}
         */
        async fetchStockName(code, apiKey, market) {
            return null; // app.js 已经全部统一使用腾讯接口查名称，此处留空即可
        }

        /**
         * 获取股票日K线数据（支持跨域JSONP直连，无需代理）
         * @param {string} code 
         * @param {string} apiKey (不使用)
         * @param {string} market 
         * @returns {Promise<Object>}
         */
        async fetchStockData(code, apiKey, market) {
            if (market === 'HK') {
                throw new Error('东方财富暂不支持港股，请切换到A股市场');
            }

            const secid = this.getSecid(code);
            const callbackName = `cb_eastmoney_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const klineUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&end=20500101&lmt=25&cb=${callbackName}`;

            let totalWaitTime = 0;
            let retryCount = 0;

            while (retryCount < EastMoneyAdapter.MAX_RETRIES) {
                try {
                    // 使用原生的 JSONP 方法请求东财数据，直接绕过 CORS
                    const data = await fetchJSONP(klineUrl, callbackName, 10000);
                    return this.parseEastMoneyData(data, code);
                } catch (error) {
                    retryCount++;
                    await this.sleep(1000 * retryCount);
                }
            }

            throw new Error('东方财富数据请求失败，请检查网络');
        }

        parseEastMoneyData(data, code) {
            if (data.data?.klines?.length < 21) {
                throw new Error(`历史数据不足 (当前 ${data.data?.klines?.length || 0} 条)，无法计算 20 日均线`);
            }

            const klines = data.data.klines;
            // K线数据格式: "日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率"
            const closes = klines.map(k => parseFloat(k.split(',')[2]));
            
            // 获取最新一条的详细信息
            const latestData = klines[klines.length - 1].split(',');

            return {
                current: closes[closes.length - 1],
                a5: closes[closes.length - 6],
                a10: closes[closes.length - 11],
                a20: closes[closes.length - 21],
                ma5_1: this.calculateMA(closes, 5),
                ma10_1: this.calculateMA(closes, 10),
                ma20_1: this.calculateMA(closes, 20),
                stockName: data.data.name || '',
                stockCode: code,
                high: parseFloat(latestData[3]) || 0,
                low: parseFloat(latestData[4]) || 0,
                open: parseFloat(latestData[1]) || 0,
                close: parseFloat(latestData[2]) || 0
            };
        }
    }

    /**
     * 腾讯财经 API 适配器
     * @extends BaseAdapter
     * 用于港股数据，A股也支持
     * 特性：直接使用 Script 注入访问
     */
    class TencentAdapter extends BaseAdapter {
        // 请求间隔（毫秒）
        static REQUEST_INTERVAL = 2000;
        
        // 最大重试次数
        static MAX_RETRIES = 3;

        constructor() {
            super();
            this.lastRequestTime = 0;
        }

        /**
         * 等待指定时间
         * @param {number} ms - 毫秒
         * @returns {Promise<void>}
         */
        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        /**
         * 检查并等待请求间隔
         * @returns {Promise<void>}
         */
        async waitForInterval() {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            
            if (timeSinceLastRequest < TencentAdapter.REQUEST_INTERVAL) {
                const waitTime = TencentAdapter.REQUEST_INTERVAL - timeSinceLastRequest;
                await this.sleep(waitTime);
            }
            
            this.lastRequestTime = Date.now();
        }

        /**
         * 获取腾讯市场前缀
         * @param {string} code 
         * @param {string} market 
         * @returns {string}
         */
        getTencentPrefix(code, market) {
            if (market === 'HK') {
                // 港股指数代码 (如HSTECH, HSI) 保持原样
                if (/^[A-Z]+$/.test(code)) {
                    return 'hk' + code;
                }
                // 港股股票代码需要补齐5位：00700 -> hk00700
                const padded = String(code).padStart(5, '0');
                return 'hk' + padded;
            }
            // 6开头的是上交所股票
            if (code.startsWith('6')) {
                return 'sh' + code;
            }
            // 典型的上证指数代码
            const shIndices = ['000001', '000002', '000003', '000010', '000016', '000300', '000905', '000688'];
            if (shIndices.includes(code)) {
                return 'sh' + code;
            }
            // 其他(000, 001, 002, 300, 399等)都是深交所
            return 'sz' + code;
        }

        /**
         * 通过腾讯接口获取股票名称（支持A股和港股）
         * 使用 Script 注入方式，解决跨域问题
         * @param {string} code 
         * @param {string} apiKey (不使用)
         * @param {string} market 
         * @returns {Promise<string|null>}
         */
        async fetchStockName(code, apiKey, market) {
            const prefix = this.getTencentPrefix(code, market);
            const url = `https://qt.gtimg.cn/q=${prefix}`;
            // 腾讯 qt 接口返回如: v_sz000001="..."
            const varName = `v_${prefix}`;
            
            try {
                // 直接使用 Script 注入方式
                const dataStr = await fetchScriptVar(url, varName, 10000);
                if (dataStr && typeof dataStr === 'string') {
                    const parts = dataStr.split('~');
                    if (parts.length > 1) {
                        return parts[1] || null;
                    }
                }
                return null;
            } catch (e) {
                console.warn("腾讯名称接口请求失败", e);
                return null;
            }
        }

        /**
         * 获取股票日K线数据
         * @param {string} code 
         * @param {string} apiKey (不使用)
         * @param {string} market 
         * @returns {Promise<Object>}
         */
        async fetchStockData(code, apiKey, market) {
            // 腾讯财经API - 获取历史K线
            const prefix = this.getTencentPrefix(code, market);
            // 我们可以利用 _var 参数让它返回指定的变量名，天然支持类似 JSONP 的写法
            // 例如: https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz000001,day,,,320,qfq&_var=klineData_sz000001
            const varName = `klineData_${prefix}_${Date.now()}`;
            const klineUrl = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix},day,,,320,qfq&_var=${varName}`;
            
            try {
                // 通过 script 标签跨域加载，完成后从全局变量里取数据
                const data = await fetchScriptVar(klineUrl, varName, 15000);
                return this.parseTencentData(data, code, market);
            } catch (e) {
                throw new Error(`数据请求失败，请稍后重试: ${e.message}`);
            }
        }
        
        parseTencentData(data, code, market) {
            // 腾讯返回数据结构: { data: { "hk00700": { day: [...], qt: {...} } } }
            // 注意：港股返回的是 day 字段，不是 qfqday
            const prefix = this.getTencentPrefix(code, market);
            const stockData = data.data && data.data[prefix];
            
            // 尝试获取 K 线数据（支持 day 和 qfqday 两种格式）
            let klines = stockData?.day || stockData?.qfqday;
            
            if (!stockData || !klines || klines.length < 21) {
                const available = klines?.length || 0;
                throw new Error(`历史数据不足 (当前 ${available} 条)，无法计算 20 日均线`);
            }

            // 从 qt 字段获取股票名称：qt 格式 ["100", "股票名称", "代码", ...]
            let stockName = '';
            if (stockData.qt && stockData.qt[prefix]) {
                stockName = stockData.qt[prefix][1] || '';
            }
            
            // day数据格式: ["2024-01-02", 开盘, 收盘, 最高, 最低, 成交量, 成交额]
            const closes = klines.map(k => parseFloat(k[2]));
            
            // 获取最新一条
            const latestData = klines[klines.length - 1];

            return {
                current: closes[closes.length - 1],
                a5: closes[closes.length - 6],
                a10: closes[closes.length - 11],
                a20: closes[closes.length - 21],
                ma5_1: this.calculateMA(closes, 5),
                ma10_1: this.calculateMA(closes, 10),
                ma20_1: this.calculateMA(closes, 20),
                stockName: stockName,
                stockCode: code,
                high: parseFloat(latestData[3]) || 0,
                low: parseFloat(latestData[4]) || 0,
                open: parseFloat(latestData[1]) || 0,
                close: parseFloat(latestData[2]) || 0
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
         * @param {string} provider - 服务商 (eastmoney/tencent)
         * @param {string} market - 市场 (CN/HK)
         * @returns {BaseAdapter}
         */
        create(provider, market) {
            // 港股自动切换到腾讯
            if (market === 'HK') {
                return new TencentAdapter();
            }
            
            const adapters = {
                'eastmoney': EastMoneyAdapter,
                'tencent': TencentAdapter
            };
            const AdapterClass = adapters[provider] || EastMoneyAdapter;
            return new AdapterClass();
        }
    };

})(window.MACalc);

