import type { ShipmentField } from "@/lib/types";

export const FIELD_LABELS: Record<ShipmentField, string> = {
  externalCode: "外部编码",
  storeName: "收货门店",
  recipientName: "收件人姓名",
  recipientPhone: "收件人电话",
  recipientAddress: "收件人地址",
  skuCode: "SKU物品编码",
  skuName: "SKU物品名称",
  skuQty: "SKU发货数量",
  skuSpec: "SKU规格型号",
  temperatureZone: "温层",
  remark: "备注",
};

export const PREVIEW_COLUMNS: Array<{
  field: ShipmentField;
  width: number;
}> = [
  { field: "externalCode", width: 180 },
  { field: "storeName", width: 220 },
  { field: "recipientName", width: 140 },
  { field: "recipientPhone", width: 150 },
  { field: "recipientAddress", width: 320 },
  { field: "skuCode", width: 160 },
  { field: "skuName", width: 220 },
  { field: "skuQty", width: 120 },
  { field: "skuSpec", width: 180 },
  { field: "temperatureZone", width: 110 },
  { field: "remark", width: 220 },
];

export const TEMPERATURE_OPTIONS = ["常温", "冷藏", "冷冻", "恒温"];

export const SHELL_CHANNELS = ["冷链快运", "冷链云仓", "中通冷运", "更多租户"];

export const SECTION_ITEMS = [
  {
    key: "dashboard",
    label: "概览",
    helper: "看看规则、导入和历史数据的整体情况",
  },
  {
    key: "import",
    label: "导入解析",
    helper: "上传文件、选择规则、试解析并确认结果",
  },
  {
    key: "rules",
    label: "规则管理",
    helper: "保存、复制、修改和复用解析规则",
  },
  {
    key: "shipments",
    label: "历史记录",
    helper: "查看已导入运单，按条件筛选回查",
  },
] as const;

export const SIDEBAR_ITEMS = [
  "首页",
  "运营运输管理",
  "经营管理中心",
  "运营操作管理",
  "财务管理",
  "基础管理",
  "天权设备监控",
  "服务质量",
  "天易大数据平台",
];

export const MIMO_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
export const MIMO_MODEL = "mimo-v2.5-pro";
export const MIMO_PROVIDER_LABEL = "小米 MiMo";
export const MIMO_TIMEOUT_MS = 30_000;
