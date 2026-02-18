const { createApp, ref, reactive, onMounted, watch } = Vue;

// CORS 代理（用于腾讯接口）
const CORS_PROXY = "https://corsproxy.io/?";

// 解码Unicode转义序列（如 \u6e56\u5317 -> 湖北）
function decodeUnicode(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

// 通过腾讯财经接口查询股票代码（支持中文名称搜索）
async function searchStockCodeByName(name) {
  // 腾讯财经搜索接口（通过CORS代理）
  const targetUrl = `https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(name)}&t=all`;
  const searchUrl = `${CORS_PROXY}${encodeURIComponent(targetUrl)}`;

  try {
    const response = await fetch(searchUrl);
    const text = await response.text();

    // 解析返回数据，格式类似: v_hint="qid..."
    const match = text.match(/v_hint="([^"]+)"/);
    if (!match) return null;

    const data = match[1];
    // 数据格式: sz^000422^名称^... 或 sz~000422~名称~
    // 可能是 ^ 或 ~ 分隔
    const delimiter = data.includes("^") ? "^" : "~";
    const parts = data.split(delimiter);

    if (parts.length >= 3) {
      const prefix = parts[0]; // 如 sz
      const codeNum = parts[1]; // 000422
      const stockName = decodeUnicode(parts[2]); // 解码Unicode

      const fullCode = prefix + codeNum;

      // 验证是A股（6位数字）
      if (/^\d{6}$/.test(codeNum)) {
        return {
          code: codeNum,
          name: stockName,
          fullCode: fullCode
        };
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
    // Original state
    const ao = ref(0);
    const ma5 = reactive({ a5: 0, ma5_1: 0, result: 0 });
    const ma10 = reactive({ a10: 0, ma10_1: 0, result: 0 });
    const ma20 = reactive({ a20: 0, ma20_1: 0, result: 0 });

    // 股票信息
    const stockInfo = reactive({
      name: "",
      code: "",
      high: 0,
      low: 0,
      open: 0,
      close: 0
    });

    // API integration state
    const showConfig = ref(false);
    const stockCode = ref("");
    const loading = ref(false);
    const error = ref("");
    const configSaved = ref(false);
    const dataFetched = ref(false);

    const apiConfig = reactive({
      provider: "alltick", // 默认 AllTick
      apiKey: ""
    });

    // API 提供商地址映射
    const API_URLS = {
      alltick: "https://alltick.co/",
      itick: "https://itick.org/"
    };

    // 当前选择的 API 地址
    const currentApiUrl = Vue.computed(() => {
      return API_URLS[apiConfig.provider] || "";
    });

    // 存储所有服务商的API Keys
    const apiKeys = reactive({
      alltick: "",
      itick: ""
    });

    // 从localStorage加载配置
    const loadApiConfig = () => {
      try {
        const saved = localStorage.getItem("ma-calculator-api-config");
        if (saved) {
          const config = JSON.parse(saved);

          // 加载provider
          if (config.provider) {
            apiConfig.provider = config.provider;
          }

          // 加载所有服务商的keys
          if (config.apiKeys) {
            Object.assign(apiKeys, config.apiKeys);
            // 设置当前provider的key
            apiConfig.apiKey = apiKeys[apiConfig.provider] || "";
          }
        }
      } catch (e) {
        console.error("Failed to load config:", e);
      }
    };

    // 保存配置到localStorage
    const saveApiConfig = () => {
      try {
        // 先保存当前provider的key到apiKeys对象
        apiKeys[apiConfig.provider] = apiConfig.apiKey;

        const config = {
          provider: apiConfig.provider,
          apiKeys: { ...apiKeys }
        };

        localStorage.setItem(
          "ma-calculator-api-config",
          JSON.stringify(config)
        );
        return true;
      } catch (e) {
        console.error("Failed to save config:", e);
        return false;
      }
    };

    // 监听provider变化，自动切换对应的apiKey
    watch(
      () => apiConfig.provider,
      newProvider => {
        apiConfig.apiKey = apiKeys[newProvider] || "";
      }
    );

    // Save configuration
    const saveConfig = () => {
      if (saveApiConfig()) {
        configSaved.value = true;
        setTimeout(() => {
          configSaved.value = false;
        }, 3000);
      }
    };

    // Fetch stock data from API
    const fetchStockData = async () => {
      if (!apiConfig.apiKey) {
        error.value = "请先配置API Key";
        return;
      }

      if (!stockCode.value) {
        error.value = "请输入股票代码";
        return;
      }

      // 获取输入内容
      let actualCode = stockCode.value.trim();
      let searchedName = "";

      // 检查是否是中文名称（包含中文）
      if (/[\u4e00-\u9fa5]/.test(actualCode)) {
        // 通过腾讯接口搜索股票代码
        error.value = "正在搜索股票...";
        const searchResult = await searchStockCodeByName(actualCode);

        if (!searchResult) {
          error.value = `未找到"${actualCode}"对应的股票，请输入准确的公司名称或6位股票代码`;
          return;
        }

        actualCode = searchResult.code;
        searchedName = searchResult.name;
      }

      // 验证股票代码格式（6位数字）
      if (!/^\d{6}$/.test(actualCode)) {
        error.value = "股票代码必须是6位数字";
        return;
      }

      loading.value = true;
      error.value = "";
      dataFetched.value = false;

      try {
        const adapter = AdapterFactory.create(apiConfig.provider);

        // 先查股票名称（可选，失败不阻塞）
        let stockName = null;
        try {
          stockName = await adapter.fetchStockName(
            actualCode,
            apiConfig.apiKey
          );
        } catch (e) {
          // 忽略名称查询错误
        }

        // 再查K线数据
        const data = await adapter.fetchStockData(actualCode, apiConfig.apiKey);

        // Auto-fill all fields
        ao.value = data.current;
        ma5.a5 = data.a5;
        ma5.ma5_1 = data.ma5_1;
        ma10.a10 = data.a10;
        ma10.ma10_1 = data.ma10_1;
        ma20.a20 = data.a20;
        ma20.ma20_1 = data.ma20_1;

        // 填充股票信息（优先用搜索到的名称，其次用API返回的）
        stockInfo.code = data.stockCode || actualCode;
        stockInfo.name = searchedName || stockName || data.stockName || "";
        stockInfo.high = data.high || 0;
        stockInfo.low = data.low || 0;
        stockInfo.open = data.open || 0;
        stockInfo.close = data.close || 0;

        // 自动计算所有均线
        calculateMA5();
        calculateMA10();
        calculateMA20();

        dataFetched.value = true;
      } catch (e) {
        error.value = `获取失败: ${e.message}`;
        console.error("API Error:", e);
      } finally {
        loading.value = false;
      }
    };

    // Original calculation functions
    const calculateMA5 = () => {
      ma5.result = (ma5.ma5_1 * 5 - ma5.a5 + ao.value) / 5;
    };

    const calculateMA10 = () => {
      ma10.result = (ma10.ma10_1 * 10 - ma10.a10 + ao.value) / 10;
    };

    const calculateMA20 = () => {
      ma20.result = (ma20.ma20_1 * 20 - ma20.a20 + ao.value) / 20;
    };

    // Load saved config on mount
    onMounted(() => {
      loadApiConfig();
    });

    return {
      ao,
      ma5,
      ma10,
      ma20,
      calculateMA5,
      calculateMA10,
      calculateMA20,
      showConfig,
      stockCode,
      loading,
      error,
      configSaved,
      dataFetched,
      apiConfig,
      saveConfig,
      fetchStockData,
      stockInfo,
      currentApiUrl
    };
  }
}).mount("#app");
