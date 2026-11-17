// 分仓技能各自的图案：24 网格、1.6 描边、圆角连接，和 ui.jsx 里的图标同一族。
// 名字取自技能仓 skills/<name>/SKILL.md 的目录名；没配到的退回通用列表页图案。
const GLYPHS = {
  // 现房尾房：楼栋 + 逐户窗口
  'beijing-existing-home-inventory': 'M4 20V5.5h10V20M14 20V9h4v11M3 20h18M7 9h2M11 9h2M7 12.5h2M11 12.5h2M7 16h2M11 16h2M15.6 12h1.7M15.6 15.5h1.7',
  // 单盘解析：楼 + 放大镜
  'beijing-new-home-analysis': 'M4 20V9.5l5.5-3.5L15 9.5V14M2.5 20h14M16.4 13.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zM20.6 20.9 19 19.3',
  // 看房清单：清单 + 勾
  'beijing-new-home-shortlist': 'M4 6.5h9M4 12h9M4 17.5h5.5M16.5 6l1.6 1.6L21.5 4M16.5 14.5l1.6 1.6L21.5 12',
  // 年鉴库：书脊 + 横带
  'beijing-yearbook-library': 'M4 5h5.5v15H4zM11 5h4v15h-4zM16.5 6.2l3.8.8-2.1 12.6-3.8-.8M4 9.5h16.2',
  // 房号网签：销控网格
  'building-net-sign-report': 'M4 4.5h16v15H4zM4 9.5h16M4 14.5h16M9.4 4.5v15M14.6 4.5v15M6.7 7h.01M12 7h.01M17.2 12h.01M6.7 17h.01M12 17h.01',
  // 分仓发布：组合包 + 上升箭头
  'deploy-realestate': 'M4.5 11 12 7l7.5 4v6L12 21l-7.5-4zM4.5 11 12 15l7.5-4M12 15v6M12 6V2.6M9.6 5 12 2.6 14.4 5',
  // 网签 PDF：文档 + 下载
  'export-realestate-net-report': 'M6 3.5h7.5l4.5 4.5V20.5H6zM13.5 3.5V8H18M12 11.5v6M9.4 15.1 12 17.7l2.6-2.6',
  // 报告 PDF：文档 + 文字行
  'export-report-pdf': 'M6 3.5h7.5l4.5 4.5V20.5H6zM13.5 3.5V8H18M9 12h6M9 15h6M9 18h3.5',
  // 采光：日照
  'home-daylight-analysis': 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 3v2.2M12 18.8V21M4.2 12H6.4M17.6 12h2.2M6.5 6.5l1.6 1.6M15.9 15.9l1.6 1.6M6.5 17.5l1.6-1.6M15.9 8.1l1.6-1.6',
  // 土拍/板块报告：地块 + 定位
  'land-report-agent': 'M3.5 6.8 9 4.6l6 2.2 5.5-2.2v10.6L15 17.4l-6-2.2-5.5 2.2zM9 4.6v10.6M15 6.8v10.6M12 8.4a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z',
  // 数据查询：数据库
  'lanjing-data': 'M4.5 6.5c0-1.3 3.4-2.4 7.5-2.4s7.5 1.1 7.5 2.4S16.1 8.9 12 8.9 4.5 7.8 4.5 6.5zM4.5 6.5v11c0 1.3 3.4 2.4 7.5 2.4s7.5-1.1 7.5-2.4v-11M4.5 12c0 1.3 3.4 2.4 7.5 2.4s7.5-1.1 7.5-2.4',
  // 修订追查：回溯时钟
  'presale-revision-audit': 'M4.6 9.4A7.6 7.6 0 1 1 4.4 14M4.6 5.4v4h4M12 8.4V12l3 1.9',
  // 调度健康：脉搏
  'presale-schedule-health': 'M3 12h3.6l2.3-5.2 3.6 10.4 2.4-5.2H21',
  // 小红书图卡：卡片 + 走势
  'server-net-sign-card': 'M3.5 6.5h17v11h-17zM3.5 10.2h17M6.6 15.2l2.5-3 2.4 2 3-4.2',
}

const FALLBACK = 'M4 6.5h16M4 12h16M4 17.5h16'

/** 技能名 → 图案路径；认不出来的用通用列表图案。 */
export function skillGlyph(name) {
  return GLYPHS[name] ?? FALLBACK
}

/** 技能名 → 色板序号（0–5），跟风格页的 tone-N 共用一套底色。 */
export function glyphTone(name) {
  let sum = 0
  for (const char of String(name ?? '')) sum = (sum + char.codePointAt(0)) % 997
  return sum % 6
}

export function SkillGlyph({ name, size = 19 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={skillGlyph(name)} />
    </svg>
  )
}
