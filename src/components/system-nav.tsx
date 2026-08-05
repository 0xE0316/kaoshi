import Link from "next/link";
import { Activity, FileSpreadsheet } from "lucide-react";

export function SystemNav({ current }: { current: "import" | "monitor" }) {
  const items = [
    { key: "import", href: "/", label: "导入下单", icon: FileSpreadsheet },
    { key: "monitor", href: "/monitor", label: "任务监控", icon: Activity },
  ] as const;
  return <nav aria-label="系统主导航" className="flex flex-wrap gap-2">{items.map(item=>{const Icon=item.icon;return <Link key={item.key} href={item.href} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold transition ${current===item.key?"border-[#0fc6c2] bg-[#0fc6c2] text-white":"border-slate-200 bg-white text-slate-600 hover:border-[#0fc6c2]"}`}><Icon className="h-4 w-4"/>{item.label}</Link>})}</nav>;
}
