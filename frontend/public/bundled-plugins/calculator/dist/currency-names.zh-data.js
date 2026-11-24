/** 货币中文默认名称、检索关键词与算式别名静态表（UI 展示优先使用 i18n 的 getCurrencyName） */
export const CURRENCY_ZH_META = Object.freeze({
    CNY: { name: "人民币", keywords: ["元", "中国"], exprAliases: ["人民币"] },
    USD: { name: "美元", keywords: ["美金", "美国"], exprAliases: ["美元", "美金"] },
    EUR: { name: "欧元", keywords: ["欧洲"], exprAliases: ["欧元"] },
    JPY: { name: "日元", keywords: ["日本", "日币"], exprAliases: ["日元", "日币"] },
    GBP: { name: "英镑", keywords: ["英国"], exprAliases: ["英镑"] },
    KRW: { name: "韩元", keywords: ["韩国", "韩币"], exprAliases: ["韩元", "韩币"] },
    HKD: { name: "港币", keywords: ["港元", "香港"], exprAliases: ["港币", "港元"] },
    TWD: { name: "新台币", keywords: ["台币", "台湾"], exprAliases: ["新台币", "台币"] },
    SGD: { name: "新加坡元", keywords: ["新币", "新加坡"], exprAliases: ["新加坡元", "新币"] },
    AUD: { name: "澳元", keywords: ["澳币", "澳大利亚"], exprAliases: ["澳元", "澳币"] },
    CAD: { name: "加元", keywords: ["加币", "加拿大"], exprAliases: ["加元", "加币"] },
    CHF: { name: "瑞士法郎", keywords: ["瑞士"], exprAliases: ["瑞郎", "瑞士法郎"] },
    THB: { name: "泰铢", keywords: ["泰国"], exprAliases: ["泰铢"] },
    RUB: { name: "卢布", keywords: ["俄罗斯"], exprAliases: ["卢布"] },
    INR: { name: "印度卢比", keywords: ["印度"], exprAliases: ["卢比", "印度卢比"] },
    XAU: { name: "黄金（盎司）", keywords: ["黄金", "金价"], exprAliases: ["黄金"] },
    BTC: { name: "比特币", keywords: ["比特币"], exprAliases: ["比特币"] }
});
