/**
 * @namespace MACalc
 */
window.MACalc = window.MACalc || {};

(function(MACalc) {
    const { createApp, ref, reactive, onMounted, watch } = Vue;

    // CORS 代理（用于腾讯接口）
    const CORS_PROXY = "https://corsproxy.io/?";

    /**
     * 解码 Unicode 转义序列
     * @param {string} str 
     * @returns {string}
     */
    function decodeUnicode(str) {
        if (!str) return "";
        return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
            return String.fromCharCode(parseInt(hex, 16));
        });
    }

    /**
     * 通过腾讯财经接口查询股票代码
     * @param {string} name - 股票名称或部分代码
     * @param {string} market - 目标市场 (CN/HK)
     * @returns {Promise<Object|null>}
     */
    async function searchStockCodeByName(name, market) {
        const targetUrl = `https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(name)}&t=all`;
        const searchUrl = `${CORS_PROXY}${encodeURIComponent(targetUrl)}`;

        try {
            const response = await fetch(searchUrl);
            const text = await response.text();
            const match = text.match(/v_hint="([^"]+)"/);
            if (!match) return null;

            const entries = match[1].split('^');
            for (const entry of entries) {
                if (!entry.trim()) continue;
                const parts = entry.split('~');
                if (parts.length >= 5) {
                    const prefix = parts[0];
                    const codeNum = parts[1];
                    const stockName = decodeUnicode(parts[2]);
                    const stockType = parts[4];

                    if (market === 'HK') {
                        if (prefix === 'hk' && stockType === 'GP' && /^\d{4,5}$/.test(codeNum)) {
                            return { code: codeNum, name: stockName, fullCode: prefix + codeNum };
                        }
                    } else {
                        if ((prefix === 'sh' || prefix === 'sz') && /^\d{6}$/.test(codeNum)) {
                            return { code: codeNum, name: stockName, fullCode: prefix + codeNum };
                        }
                    }
                }
            }
            return null;
        } catch (e) {
            console.error("搜索股票失败:", e);
            return null;
        }
    }

    createApp({
        setup() {
            // 1. 基础响应式状态
            const a0 = ref(0);
            const ma5 = reactive({ a5: 0, ma5_1: 0, result: 0 });
            const ma10 = reactive({ a10: 0, ma10_1: 0, result: 0 });
            const ma20 = reactive({ a20: 0, ma20_1: 0, result: 0 });

            const stockInfo = reactive({
                name: "", code: "", high: 0, low: 0, open: 0, close: 0
            });

            const showConfig = ref(false);
            const stockCode = ref("");
            const market = ref("CN");
            const loading = ref(false);
            const error = ref("");
            const configSaved = ref(false);
            const dataFetched = ref(false);
            const searchHistory = ref([]);

            // 模块折叠状态
            const showMA5 = ref(false);
            const showMA10 = ref(false);
            const showMA20 = ref(false);

            const apiConfig = reactive({
                provider: "alltick",
                apiKey: ""
            });

            const API_URLS = {
                alltick: "https://alltick.co/",
                itick: "https://itick.org/"
            };

            const currentApiUrl = Vue.computed(() => API_URLS[apiConfig.provider] || "");

            const apiKeys = reactive({
                alltick: "",
                itick: ""
            });

            // 2. 核心计算方法
            const calculateMA5 = () => { ma5.result = (ma5.ma5_1 * 5 - ma5.a5 + (a0.value || 0)) / 5; };
            const calculateMA10 = () => { ma10.result = (ma10.ma10_1 * 10 - ma10.a10 + (a0.value || 0)) / 10; };
            const calculateMA20 = () => { ma20.result = (ma20.ma20_1 * 20 - ma20.a20 + (a0.value || 0)) / 20; };

            const calculateAll = () => {
                calculateMA5();
                calculateMA10();
                calculateMA20();
            };

            // 3. 配置管理
            const loadApiConfig = () => {
                try {
                    const saved = localStorage.getItem("ma-calculator-api-config");
                    if (saved) {
                        const config = JSON.parse(saved);
                        if (config.provider) apiConfig.provider = config.provider;
                        if (config.apiKeys) {
                            Object.assign(apiKeys, config.apiKeys);
                            apiConfig.apiKey = apiKeys[apiConfig.provider] || "";
                        }
                    }
                } catch (e) {}
            };

            const saveApiConfig = () => {
                try {
                    apiKeys[apiConfig.provider] = apiConfig.apiKey;
                    const config = { provider: apiConfig.provider, apiKeys: { ...apiKeys } };
                    localStorage.setItem("ma-calculator-api-config", JSON.stringify(config));
                    return true;
                } catch (e) { return false; }
            };

            const saveConfig = () => {
                if (saveApiConfig()) {
                    configSaved.value = true;
                    setTimeout(() => { configSaved.value = false; }, 3000);
                }
            };

            // 4. 搜索历史管理
            const loadSearchHistory = () => {
                try {
                    const saved = localStorage.getItem('ma-calculator-search-history');
                    if (saved) searchHistory.value = JSON.parse(saved);
                } catch (e) { searchHistory.value = []; }
            };

            const saveSearchHistory = () => {
                localStorage.setItem('ma-calculator-search-history', JSON.stringify(searchHistory.value));
            };

            const addSearchHistory = (code, name, historyMarket) => {
                searchHistory.value = searchHistory.value.filter(
                    item => !(item.code === code && item.market === historyMarket)
                );
                searchHistory.value.unshift({ code, name, market: historyMarket, time: Date.now() });
                if (searchHistory.value.length > 6) searchHistory.value = searchHistory.value.slice(0, 6);
                saveSearchHistory();
            };

            const removeSearchHistory = (index) => {
                searchHistory.value.splice(index, 1);
                saveSearchHistory();
            };

            const clearAllHistory = () => {
                if (confirm('确定要清空所有搜索历史吗？')) {
                    searchHistory.value = [];
                    saveSearchHistory();
                }
            };

            // 5. 数据抓取逻辑
            const fetchStockData = async () => {
                if (!apiConfig.apiKey) { error.value = "请先在“配置API”中输入并保存您的 API Key"; return; }
                if (!stockCode.value) { error.value = "请输入股票代码或名称"; return; }

                let actualCode = stockCode.value.trim();
                let searchedName = "";
                const currentMarket = market.value;

                loading.value = true;
                error.value = "";
                dataFetched.value = false;

                try {
                    // 检查搜索组件是否已加载（通过命名空间访问）
                    if (!MACalc.AdapterFactory) {
                        throw new Error("应用核心组件加载失败，请尝试刷新页面。如果持续出现，请检查网络是否能访问 CDN。");
                    }

                    // 如果输入包含中文，先进行搜索
                    if (/[\u4e00-\u9fa5]/.test(actualCode)) {
                        const searchResult = await searchStockCodeByName(actualCode, currentMarket);
                        if (!searchResult) {
                            throw new Error(`未找到"${actualCode}"对应的${currentMarket === 'HK' ? '港股' : 'A股'}，请确认名称是否准确。`);
                        }
                        actualCode = searchResult.code;
                        searchedName = searchResult.name;
                    }

                    // 验证最终代码格式
                    if (currentMarket === 'HK') {
                        if (!/^\d{1,5}$/.test(actualCode)) throw new Error("请输入正确的港股代码（1-5位数字）");
                    } else {
                        if (!/^\d{6}$/.test(actualCode)) throw new Error("请输入正确的 A 股代码（6位数字）");
                    }

                    const adapter = MACalc.AdapterFactory.create(apiConfig.provider);
                    
                    // 并行获取名称（如果之前没搜到）和行情
                    const [stockName, data] = await Promise.all([
                        searchedName ? Promise.resolve(searchedName) : adapter.fetchStockName(actualCode, apiConfig.apiKey, currentMarket),
                        adapter.fetchStockData(actualCode, apiConfig.apiKey, currentMarket)
                    ]);

                    // 填充数据
                    a0.value = data.current;
                    ma5.a5 = data.a5; ma5.ma5_1 = data.ma5_1;
                    ma10.a10 = data.a10; ma10.ma10_1 = data.ma10_1;
                    ma20.a20 = data.a20; ma20.ma20_1 = data.ma20_1;

                    stockInfo.code = data.stockCode || actualCode;
                    stockInfo.name = stockName || data.stockName || "未知股票";
                    stockInfo.high = data.high; stockInfo.low = data.low;
                    stockInfo.open = data.open; stockInfo.close = data.close;

                    calculateAll();
                    addSearchHistory(actualCode, stockInfo.name, currentMarket);
                    dataFetched.value = true;
                } catch (e) {
                    error.value = e.message;
                    console.error("Fetch Error:", e);
                } finally {
                    loading.value = false;
                }
            };

            const useSearchHistory = (item) => {
                market.value = item.market;
                stockCode.value = item.code;
                fetchStockData();
            };

            // 6. 监听与生命周期
            watch(() => apiConfig.provider, (newProvider) => {
                apiConfig.apiKey = apiKeys[newProvider] || "";
            });

            onMounted(() => {
                loadApiConfig();
                loadSearchHistory();
            });

            return {
                a0, ma5, ma10, ma20, stockInfo, showConfig, stockCode, market,
                loading, error, configSaved, dataFetched, searchHistory, apiConfig,
                showMA5, showMA10, showMA20,
                currentApiUrl, calculateMA5, calculateMA10, calculateMA20, calculateAll, saveConfig,
                fetchStockData, removeSearchHistory, useSearchHistory, clearAllHistory
            };
        }
    }).mount("#app");

})(window.MACalc);


