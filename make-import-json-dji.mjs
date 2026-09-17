import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const markdown = fs.readFileSync(path.join(dir, "resume-dji.md"), "utf8");

const PREVIEW_SELECTOR = "#resume-preview";

// 页面边距（与下方 styles.marginV / marginH 保持一致，照片定位依赖这两个值）
const MARGIN_V = 28; // 底部边距基准（build 脚本据此计算 bottom）
const MARGIN_V_TOP = 12; // 顶部边距（减少顶部留白，让上方文字更靠上）
const MARGIN_H = 45;
const PHOTO_TOP = 0; // 照片距页面顶部的位置（贴顶，比正文更靠上）

// 与 oh-my-cv 默认模板一致的自定义 CSS（供导入后直接渲染/导出）
const css = `/* Backbone CSS for Resume Template 1 */

/* Basic */

${PREVIEW_SELECTOR} [data-scope="vue-smart-pages"][data-part="page"] {
  background-color: white;
  color: black;
  text-align: justify;
  -moz-hyphens: auto;
  -ms-hyphens: auto;
  -webkit-hyphens: auto;
  hyphens: auto;
}

${PREVIEW_SELECTOR} p,
${PREVIEW_SELECTOR} li,
${PREVIEW_SELECTOR} dl {
  margin: 0;
}

/* Headings */

${PREVIEW_SELECTOR} h1,
${PREVIEW_SELECTOR} h2,
${PREVIEW_SELECTOR} h3 {
  font-weight: bold;
}

${PREVIEW_SELECTOR} h1 {
  font-size: 2.13em;
}

${PREVIEW_SELECTOR} h2,
${PREVIEW_SELECTOR} h3 {
  margin-bottom: 5px;
  font-size: 1.2em;
}

${PREVIEW_SELECTOR} h2 {
  border-bottom-style: solid;
  border-bottom-width: 1px;
}

/* Lists */

${PREVIEW_SELECTOR} ul,
${PREVIEW_SELECTOR} ol {
  padding-left: 1.5em;
  margin: 0.2em 0;
}

${PREVIEW_SELECTOR} ul {
  list-style-type: circle;
}

${PREVIEW_SELECTOR} ol {
  list-style-type: decimal;
}

/* Definition Lists */

${PREVIEW_SELECTOR} dl {
  display: flex;
}

${PREVIEW_SELECTOR} dl dt,
${PREVIEW_SELECTOR} dl dd:not(:last-child) {
  flex: 1;
}

/* Tex */

${PREVIEW_SELECTOR} :not(span.katex-display) > span.katex {
  font-size: 1em !important;
}

/* SVG & Images */

${PREVIEW_SELECTOR} svg.iconify {
  vertical-align: -0.2em;
}

${PREVIEW_SELECTOR} img {
  max-width: 100%;
}

/* Photo */

${PREVIEW_SELECTOR} [data-scope="vue-smart-pages"][data-part="page"] {
  position: relative;
}

${PREVIEW_SELECTOR} .resume-photo-anchor {
  height: 0;
  overflow: visible;
}

${PREVIEW_SELECTOR} .resume-photo {
  position: absolute;
  top: ${PHOTO_TOP}px;
  right: ${MARGIN_H}px;
  width: 78px;
  height: 105px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  background-color: white;
}

/* 教育背景（照片锚点后的首个标题）相对默认段间距下移 10px */

${PREVIEW_SELECTOR} .resume-photo-anchor + h2 {
  margin-top: 13px;
}

/* Company Header（公司与项目行区分样式） */

${PREVIEW_SELECTOR} .company-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 8px;
  row-gap: 2px;
  margin: 4px 0 6px;
  padding: 5px 8px;
  background-color: rgba(55, 123, 181, 0.07);
  border-left: 3px solid #377bb5;
}

${PREVIEW_SELECTOR} .company-name {
  font-size: 1.18em;
  font-weight: bold;
  color: #377bb5;
}

${PREVIEW_SELECTOR} .company-meta {
  color: #555;
}

${PREVIEW_SELECTOR} .company-date {
  margin-left: auto;
  color: #666;
  font-size: 0.92em;
}

/* Project Title（项目/经历标题行，与下方正文拉开区分度） */

${PREVIEW_SELECTOR} .project-title {
  color: #377bb5;
  font-size: 1.15em;
}

/* Header */

${PREVIEW_SELECTOR} .resume-header {
  text-align: center;
}

${PREVIEW_SELECTOR} .resume-header h1 {
  text-align: center;
  line-height: 1;
  margin: 0 0 8px; /* 去掉浏览器默认 h1 上边距，减少顶部留白 */
}

${PREVIEW_SELECTOR} .resume-header-item:not(.no-separator)::after {
  content: " | ";
}

/* Citations */

${PREVIEW_SELECTOR} [data-scope="cross-ref"][data-part="definitions"] {
  padding-left: 1.2em;
}

${PREVIEW_SELECTOR} [data-scope="cross-ref"][data-part="definition"] p {
  margin-left: 0.5em;
}

${PREVIEW_SELECTOR} [data-scope="cross-ref"][data-part="definition"]::marker {
  content: attr(data-label);
}

${PREVIEW_SELECTOR} [data-scope="cross-ref"][data-part="reference"] {
  font-size: 100%;
  top: 0;
}

/* Dark & print mode */
/* You might want to comment out the following lines if you change the background or text color. */

.dark ${PREVIEW_SELECTOR} [data-scope="vue-smart-pages"][data-part="page"] {
  background-color: hsl(213, 12%, 15%);
  color: hsl(216, 12%, 84%);
}

@media print {
  .dark ${PREVIEW_SELECTOR} [data-scope="vue-smart-pages"][data-part="page"] {
    background-color: white;
    color: black;
  }
}
`;

const now = new Date().toISOString();

const json = {
  version: "v1",
  data: {
    "1": {
      name: "张目远",
      markdown,
      css,
      styles: {
        marginV: MARGIN_V,
        marginTop: MARGIN_V_TOP,
        marginH: MARGIN_H,
        lineHeight: 1.24,
        paragraphSpace: 3,
        themeColor: "#377bb5",
        fontCJK: {
          name: "华康宋体",
          fontFamily: "HKST"
        },
        fontEN: {
          name: "Minion Pro"
        },
        fontSize: 15,
        paper: "A4"
      },
      updated_at: now,
      created_at: now
    }
  }
};

fs.writeFileSync(
  path.join(dir, "ohmycv-data-dji.json"),
  JSON.stringify(json, null, 2) + "\n",
  "utf8"
);

console.log("Wrote ohmycv-data-dji.json");
