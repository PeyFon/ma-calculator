/**
 * @namespace MACalc
 */
window.MACalc = window.MACalc || {};

(function (MACalc) {
  const { createApp, ref, reactive, onMounted, watch } = Vue;

  // CORS 代理（用于腾讯接口）
  const CORS_PROXY = "https://api.allorigins.win/raw?url=";

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
   * 多代理兜底请求
   * @param {string} url - 目标URL
   * @returns {Promise<string>} 返回响应文本
   */
  async function fetchWithCorsProxies(url) {
    const proxies = [
      { name: 'jina', url: `https://r.jina.ai/http://${encodeURIComponent(url)}` },
      { name: 'codetabs', url: `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}` },
      { name: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` }
    ];

    let lastError;
    for (const proxy of proxies) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(proxy.url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) continue;
        const text = await response.text();

        if (text.includes('500 Internal Server Error') ||
            text.includes('400 Bad Request') ||
            text.includes('403 Forbidden')) {
          continue;
        }
        return text;
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(lastError?.message || '所有CORS代理均失败');
  }

  /**
   * 通过东方财富接口查询股票代码（使用 JSONP 绕过跨域限制）
   * @param {string} name - 股票名称或部分代码
   * @param {string} market - 目标市场 (CN/HK)
   * @returns {Promise<Object|null>}
   */
  async function searchStockCodeByName(name, market) {
    return new Promise((resolve) => {
      const callbackName = `cb_suggest_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(name)}&type=14&count=10&cb=${callbackName}`;

      const script = document.createElement('script');
      let timeoutId;
      
      const cleanup = () => {
          if (timeoutId) clearTimeout(timeoutId);
          if (script.parentNode) script.parentNode.removeChild(script);
          if (window[callbackName]) delete window[callbackName];
      };
      
      timeoutId = setTimeout(() => {
          cleanup();
          resolve(null);
      }, 5000);
      
      window[callbackName] = (data) => {
          cleanup();
          if (data && data.QuotationCodeTable && data.QuotationCodeTable.Data && data.QuotationCodeTable.Data.length > 0) {
              const stocks = data.QuotationCodeTable.Data;
              
              if (market === "HK") {
                  for (const stock of stocks) {
                      const code = stock.Code;
                      // 优先匹配5位数字代码 (港股如00700)
                      if (/^0\d{4}$/.test(code)) {
                          resolve({ code: code, name: stock.Name, fullCode: "hk" + code });
                          return;
                      }
                      // 匹配港股指数代码 (如HSTECH, HSI)
                      if (/^[A-Z]+$/.test(code) && (stock.Classify === 'UniversalIndex' || stock.SecurityType === '11')) {
                          resolve({ code: code, name: stock.Name, fullCode: "hk" + code });
                          return;
                      }
                  }
              } else {
                  for (const stock of stocks) {
                      const code = stock.Code;
                      if (/^\d{6}$/.test(code)) {
                          const prefix = stock.MktNum === "1" ? "sh" : "sz";
                          resolve({ code: code, name: stock.Name, fullCode: prefix + code });
                          return;
                      }
                  }
              }
          }
          resolve(null);
      };
      
      script.onerror = () => {
          cleanup();
          resolve(null);
      };
      
      script.src = url;
      document.head.appendChild(script);
    });
  }

  // 创建Vue实例
  const app = createApp({
    setup() {
      // 1. 基础响应式状态
      const a0 = ref(0);
      const ma5 = reactive({ a5: 0, ma5_1: 0, result: 0 });
      const ma10 = reactive({ a10: 0, ma10_1: 0, result: 0 });
      const ma20 = reactive({ a20: 0, ma20_1: 0, result: 0 });

      const stockInfo = reactive({
        name: "",
        code: "",
        high: 0,
        low: 0,
        open: 0,
        close: 0
      });

      const stockCode = ref("");
      const market = ref("CN");
      const loading = ref(false);
      const error = ref("");
      const dataFetched = ref(false);
      const searchHistory = ref([]);

      const showMA5 = ref(false);
      const showMA10 = ref(false);
      const showMA20 = ref(false);

      // 2. 核心计算方法
      const calculateMA5 = () => {
        ma5.result = (ma5.ma5_1 * 5 - ma5.a5 + (a0.value || 0)) / 5;
      };
      const calculateMA10 = () => {
        ma10.result = (ma10.ma10_1 * 10 - ma10.a10 + (a0.value || 0)) / 10;
      };
      const calculateMA20 = () => {
        ma20.result = (ma20.ma20_1 * 20 - ma20.a20 + (a0.value || 0)) / 20;
      };

      const calculateAll = () => {
        calculateMA5();
        calculateMA10();
        calculateMA20();
      };

      // 3. 搜索历史管理
      const loadSearchHistory = () => {
        try {
          const saved = localStorage.getItem("ma-calculator-search-history");
          if (saved) searchHistory.value = JSON.parse(saved);
        } catch (e) {
          searchHistory.value = [];
        }
      };

      const saveSearchHistory = () => {
        localStorage.setItem(
          "ma-calculator-search-history",
          JSON.stringify(searchHistory.value)
        );
      };

      const addSearchHistory = (code, name, historyMarket) => {
        searchHistory.value = searchHistory.value.filter(
          item => !(item.code === code && item.market === historyMarket)
        );
        searchHistory.value.unshift({
          code,
          name,
          market: historyMarket,
          time: Date.now()
        });
        if (searchHistory.value.length > 6)
          searchHistory.value = searchHistory.value.slice(0, 6);
        saveSearchHistory();
      };

      const removeSearchHistory = index => {
        searchHistory.value.splice(index, 1);
        saveSearchHistory();
      };

      const clearAllHistory = () => {
        if (confirm("确定要清空所有搜索历史吗？")) {
          searchHistory.value = [];
          saveSearchHistory();
        }
      };

      // 4. 数据抓取逻辑
      const fetchStockData = async () => {
        // 防抖：如果正在加载，直接返回
        if (loading.value) {
          return;
        }
        
        if (!stockCode.value) {
          error.value = "请输入股票代码或名称";
          return;
        }

        let actualCode = stockCode.value.trim();
        let searchedName = "";
        const currentMarket = market.value;

        loading.value = true;
        error.value = "";
        dataFetched.value = false;

        try {
          if (!MACalc.AdapterFactory) {
            throw new Error(
              "应用核心组件加载失败，请尝试刷新页面。如果持续出现，请检查网络是否能访问 CDN。"
            );
          }

          // 如果输入包含中文，进行搜索
          if (/[\u4e00-\u9fa5]/.test(actualCode)) {
            const searchResult = await searchStockCodeByName(
              actualCode,
              currentMarket
            );
            if (!searchResult) {
              throw new Error(
                `未找到"${actualCode}"对应的${currentMarket === "HK" ? "港股" : "A股"}，请确认名称是否准确。`
              );
            }
            actualCode = searchResult.code;
            searchedName = searchResult.name;
          }

          // 验证最终代码格式
          if (currentMarket === "HK") {
            // 支持数字代码(1-5位)或字母代码(港股指数如HSTECH, HSI)
            if (!(/^\d{1,5}$/.test(actualCode) || /^[A-Z]{2,10}$/.test(actualCode)))
              throw new Error("请输入正确的港股代码（1-5位数字或字母指数代码）");
          } else {
            if (!/^\d{6}$/.test(actualCode))
              throw new Error("请输入正确的 A 股代码（6位数字）");
          }

          // 优先用东方财富获取K线数据，失败则用腾讯财经备用
          let data = null;
          let usedProvider = '';
          
          // 优先东方财富
          try {
            const eastmoneyAdapter = MACalc.AdapterFactory.create('eastmoney', currentMarket);
            data = await eastmoneyAdapter.fetchStockData(actualCode, "", currentMarket);
            usedProvider = 'eastmoney';
          } catch (e) {
            console.warn('东方财富获取失败，切换到腾讯财经:', e.message);
            // 备用腾讯财经
            try {
              const tencentAdapter = MACalc.AdapterFactory.create('tencent', currentMarket);
              data = await tencentAdapter.fetchStockData(actualCode, "", currentMarket);
              usedProvider = 'tencent';
            } catch (e2) {
              throw new Error(`数据获取失败：东方财富(${e.message})、腾讯财经(${e2.message})均不可用`);
            }
          }
          
          console.log(`K线数据来源: ${usedProvider}`);

          // 填充数据
          a0.value = data.current;
          ma5.a5 = data.a5;
          ma5.ma5_1 = data.ma5_1;
          ma10.a10 = data.a10;
          ma10.ma10_1 = data.ma10_1;
          ma20.a20 = data.a20;
          ma20.ma20_1 = data.ma20_1;

          stockInfo.code = data.stockCode || actualCode;
          stockInfo.name = searchedName || data.stockName || "未知股票";
          stockInfo.high = data.high;
          stockInfo.low = data.low;
          stockInfo.open = data.open;
          stockInfo.close = data.close;

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

      const useSearchHistory = item => {
        market.value = item.market;
        stockCode.value = item.code;
        fetchStockData();
      };

      // 5. 监听与生命周期
      onMounted(() => {
        loadSearchHistory();
      });

      return {
        a0,
        ma5,
        ma10,
        ma20,
        stockInfo,
        stockCode,
        market,
        loading,
        error,
        dataFetched,
        searchHistory,
        showMA5,
        showMA10,
        showMA20,
        calculateMA5,
        calculateMA10,
        calculateMA20,
        calculateAll,
        fetchStockData,
        removeSearchHistory,
        useSearchHistory,
        clearAllHistory
      };
    }
  });

  // DOM加载完成后挂载Vue应用
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.mount("#app"));
  } else {
    app.mount("#app");
  }
})(window.MACalc);
