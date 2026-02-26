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
     * 无需API Key，直接使用CORS代理访问
     * 特性：5秒间隔请求 + 代理切换 + 指数退避重试
     */
    class EastMoneyAdapter extends BaseAdapter {
        // CORS代理列表（corsproxy.io优先，r.jina.ai对东方财富有限制）
        static CORS_PROXIES = [
            'https://corsproxy.io/?',
            'https://r.jina.ai/http://'
        ];

        // 请求间隔（毫秒）
        static REQUEST_INTERVAL = 2000;
        
        // 最大等待时间（毫秒）
        static MAX_WAIT_TIME = 30000;
        
        // 最大重试次数
        static MAX_RETRIES = 3;

        constructor() {
            super();
            this.proxyIndex = 0;
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
         * 获取当前代理URL
         * @returns {string}
         */
        getCurrentProxy() {
            return EastMoneyAdapter.CORS_PROXIES[this.proxyIndex];
        }

        /**
         * 切换到下一个代理
         */
        switchProxy() {
            this.proxyIndex = (this.proxyIndex + 1) % EastMoneyAdapter.CORS_PROXIES.length;
        }

        /**
         * 构建代理URL
         * @param {string} url - 目标URL
         * @returns {string}
         */
        buildProxyUrl(url) {
            const proxy = this.getCurrentProxy();
            
            // jina.ai代理格式：https://r.jina.ai/http:// + 目标URL(不带协议)
            if (proxy.includes('r.jina.ai')) {
                // 移除协议前缀
                let targetUrl = url;
                if (url.startsWith('http://')) {
                    targetUrl = url.substring(7);
                } else if (url.startsWith('https://')) {
                    targetUrl = url.substring(8);
                }
                return `${proxy}${encodeURIComponent(targetUrl)}`;
            }
            
            // corsproxy.io格式：https://corsproxy.io/?url= + 完整URL
            if (proxy.includes('corsproxy.io')) {
                return `${proxy}${encodeURIComponent(url)}`;
            }
            
            // 其他代理：完整URL编码
            return `${proxy}${encodeURIComponent(url)}`;
        }

        /**
         * 获取东方财富市场前缀
         * @param {string} code 
         * @returns {string} 0=深交所, 1=上交所
         */
        getSecid(code) {
            return code.startsWith('6') ? '1.' : '0.';
        }

        /**
         * 通过东方财富搜索API获取股票名称
         * @param {string} code 
         * @param {string} apiKey (不使用)
         * @param {string} market 
         * @returns {Promise<string|null>}
         */
        async fetchStockName(code, apiKey, market) {
            if (market === 'HK') return null; // 东方财富主要支持A股
            
            // 等待间隔
            await this.waitForInterval();
            
            const searchUrl = `https://searchapi.eastmoney.com/api/suggest/get?input=${code}&type=14&count=1`;
            const proxyUrl = this.buildProxyUrl(searchUrl);
            
            try {
                const response = await fetchWithTimeout(proxyUrl, {}, 10000);
                const text = await response.text();
                
                // 提取JSON
                const mdMatch = text.match(/\{[\s\S]*\}/);
                if (!mdMatch) return null;
                
                const data = JSON.parse(mdMatch[0]);
                if (data.QuotationCodeTable?.Data?.length > 0) {
                    return data.QuotationCodeTable.Data[0].Name || null;
                }
                return null;
            } catch (e) {
                return null;
            }
        }

        /**
         * 获取股票日K线数据（带限流和重试机制）
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
            const klineUrl = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}${code}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=0&end=20500101&lmt=25`;

            // 等待请求间隔
            await this.waitForInterval();

            let totalWaitTime = 0;
            let retryCount = 0;

            while (retryCount < EastMoneyAdapter.MAX_RETRIES) {
                try {
                    const proxyUrl = this.buildProxyUrl(klineUrl);
                    const response = await fetchWithTimeout(proxyUrl, {}, 15000);

                    if (!response.ok) {
                        // 限流或其他错误
                        if (response.status === 429 || response.status >= 500) {
                            // 指数退避
                            const waitTime = Math.pow(2, retryCount) * 1000;
                            totalWaitTime += waitTime;
                            
                            if (totalWaitTime >= EastMoneyAdapter.MAX_WAIT_TIME) {
                                // 切换代理重试
                                this.switchProxy();
                                totalWaitTime = 0;
                                retryCount++;
                                await this.sleep(1000);
                                continue;
                            }
                            
                            await this.sleep(waitTime);
                            retryCount++;
                            continue;
                        }
                        throw new Error(`API响应异常 (HTTP ${response.status})`);
                    }

                    const text = await response.text();
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        const mdMatch = text.match(/\{[\s\S]*\}/);
                        if (mdMatch) {
                            data = JSON.parse(mdMatch[0]);
                        } else {
                            throw new Error('数据解析失败');
                        }
                    }

                    return this.parseEastMoneyData(data, code);

                } catch (error) {
                    // 网络错误或其他异常
                    totalWaitTime += 2000;
                    
                    if (totalWaitTime >= EastMoneyAdapter.MAX_WAIT_TIME) {
                        // 切换代理重试
                        this.switchProxy();
                        totalWaitTime = 0;
                        retryCount++;
                        await this.sleep(1000);
                        continue;
                    }
                    
                    await this.sleep(2000);
                    retryCount++;
                }
            }

            throw new Error('数据请求失败，请稍后重试');
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
     * 特性：5秒间隔请求 + 代理切换 + 指数退避重试
     */
    class TencentAdapter extends BaseAdapter {
        // CORS代理列表
        static CORS_PROXIES = [
            'https://r.jina.ai/http://',
            'https://corsproxy.io/?'
        ];

        // 请求间隔（毫秒）
        static REQUEST_INTERVAL = 2000;
        
        // 最大等待时间（毫秒）
        static MAX_WAIT_TIME = 30000;
        
        // 最大重试次数
        static MAX_RETRIES = 3;

        constructor() {
            super();
            this.proxyIndex = 0;
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
         * 获取当前代理URL
         * @returns {string}
         */
        getCurrentProxy() {
            return TencentAdapter.CORS_PROXIES[this.proxyIndex];
        }

        /**
         * 切换到下一个代理
         */
        switchProxy() {
            this.proxyIndex = (this.proxyIndex + 1) % TencentAdapter.CORS_PROXIES.length;
        }

        /**
         * 构建代理URL
         * @param {string} url - 目标URL
         * @returns {string}
         */
        buildProxyUrl(url) {
            const proxy = this.getCurrentProxy();
            
            // jina.ai代理格式：https://r.jina.ai/http:// + 目标URL(不带协议)
            if (proxy.includes('r.jina.ai')) {
                // 移除协议前缀
                let targetUrl = url;
                if (url.startsWith('http://')) {
                    targetUrl = url.substring(7);
                } else if (url.startsWith('https://')) {
                    targetUrl = url.substring(8);
                }
                return `${proxy}${encodeURIComponent(targetUrl)}`;
            }
            
            // corsproxy.io格式：https://corsproxy.io/?url= + 完整URL
            if (proxy.includes('corsproxy.io')) {
                return `${proxy}${encodeURIComponent(url)}`;
            }
            
            // 其他代理：完整URL编码
            return `${proxy}${encodeURIComponent(url)}`;
        }

        /**
         * 获取腾讯市场前缀
         * @param {string} code 
         * @param {string} market 
         * @returns {string}
         */
        getTencentPrefix(code, market) {
            if (market === 'HK') {
                // 港股代码需要补齐5位：00700 -> hk00700
                const padded = String(code).padStart(5, '0');
                return 'hk' + padded;
            }
            return code.startsWith('6') ? 'sh' + code : 'sz' + code;
        }

        /**
         * 通过腾讯接口获取股票名称（支持A股和港股）
         * @param {string} code 
         * @param {string} apiKey (不使用)
         * @param {string} market 
         * @returns {Promise<string|null>}
         */
        async fetchStockName(code, apiKey, market) {
            // 等待间隔
            await this.waitForInterval();
            
            const prefix = this.getTencentPrefix(code, market);
            const url = `https://qt.gtimg.cn/q=${prefix}`;
            const proxyUrl = this.buildProxyUrl(url);
            
            try {
                const response = await fetchWithTimeout(proxyUrl, {}, 10000);
                const text = await response.text();
                
                // 解析返回数据：var v_sz000001="1~平安银行~000001~12.34~..." 或 v_hk00700="61~腾讯控股~00700~..."
                // 支持两种格式：var v_xxx="..." 和 v_xxx="..."
                let match = text.match(/var\s+v_\w+="([^"]+)"/);
                if (!match) match = text.match(/v_\w+="([^"]+)"/);
                
                if (match) {
                    const parts = match[1].split('~');
                    if (parts.length > 1) {
                        return parts[1] || null;
                    }
                }
                return null;
            } catch (e) {
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
            // 使用web.ifzq.gtimg.cn获取K线数据
            const prefix = this.getTencentPrefix(code, market);
            const klineUrl = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix},day,,,320,qfq`;
            
            // 等待请求间隔
            await this.waitForInterval();

            let totalWaitTime = 0;
            let retryCount = 0;

            while (retryCount < TencentAdapter.MAX_RETRIES) {
                try {
                    const proxyUrl = this.buildProxyUrl(klineUrl);
                    const response = await fetchWithTimeout(proxyUrl, {}, 15000);

                    if (!response.ok) {
                        if (response.status === 429 || response.status >= 500) {
                            const waitTime = Math.pow(2, retryCount) * 1000;
                            totalWaitTime += waitTime;
                            
                            if (totalWaitTime >= TencentAdapter.MAX_WAIT_TIME) {
                                this.switchProxy();
                                totalWaitTime = 0;
                                retryCount++;
                                await this.sleep(1000);
                                continue;
                            }
                            
                            await this.sleep(waitTime);
                            retryCount++;
                            continue;
                        }
                        throw new Error(`API响应异常 (HTTP ${response.status})`);
                    }

                    const text = await response.text();
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        const mdMatch = text.match(/\{[\s\S]*\}/);
                        if (mdMatch) {
                            data = JSON.parse(mdMatch[0]);
                        } else {
                            throw new Error('数据解析失败');
                        }
                    }

                    return this.parseTencentData(data, code, market);

                } catch (error) {
                    totalWaitTime += 2000;
                    
                    if (totalWaitTime >= TencentAdapter.MAX_WAIT_TIME) {
                        this.switchProxy();
                        totalWaitTime = 0;
                        retryCount++;
                        await this.sleep(1000);
                        continue;
                    }
                    
                    await this.sleep(2000);
                    retryCount++;
                }
            }

            throw new Error('数据请求失败，请稍后重试');
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

