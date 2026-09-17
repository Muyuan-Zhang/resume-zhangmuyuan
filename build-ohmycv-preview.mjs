// 复刻 oh-my-cv 渲染管线，读取 ohmycv-data-v2.0.json 生成自包含预览 HTML
import fs from "node:fs";
import { load as yamlLoad } from "js-yaml";
import MarkdownIt from "markdown-it";
import MarkdownItDeflist from "markdown-it-deflist";

const RESUME_DIR = "/home/dev/workprojects/resume-zhangmuyuan";
const DATA_FILE = process.argv[2] || "ohmycv-data-v2.0.json";
const OUT_FILE = process.argv[3] || "ohmycv-preview.html";

const data = JSON.parse(fs.readFileSync(`${RESUME_DIR}/${DATA_FILE}`, "utf8"));
const resume = data.data["1"];
const markdown = resume.markdown;
const styles = resume.styles;
const userCss = resume.css;

// ---------- front matter ----------
const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
if (!fmMatch) throw new Error("front matter not found");
const fm = yamlLoad(fmMatch[1]);
let body = markdown.slice(fmMatch[0].length);
// 支持 oh-my-cv 的 \newpage 指令 → 分页 div（对应 markdown-it-latex-cmds + vue-smart-pages）
body = body.replace(/\\newpage\s*/g, '<div class="md-it-newpage"></div>');

// ---------- markdown-it ----------
const md = new MarkdownIt({ html: true }).use(MarkdownItDeflist);
const resolveDeflist = (html) =>
  html.replace(/<dl>([\s\S]*?)<\/dl>/g, (m) =>
    m.replace(/<\/dd>\n<dt>/g, "</dd>\n</dl>\n<dl>\n<dt>")
  );

// ---------- header ----------
const renderHeaderItem = (item, hasSeparator) => {
  const content = item.link
    ? `<a href="${item.link}" target="_blank" rel="noopener noreferrer">${item.text}</a>`
    : item.text;
  const element = `<span class="resume-header-item ${hasSeparator ? "" : "no-separator"}">
      ${content}
    </span>`;
  return item.newLine ? `<br>\n${element}` : element;
};
const headerHtml = [
  fm.name ? `<h1>${fm.name}</h1>\n` : "",
  (fm.header ?? [])
    .map((item, i, array) =>
      renderHeaderItem(item, i !== array.length - 1 && !array[i + 1].newLine)
    )
    .join("\n")
].join("");
const contentHtml =
  `<div class="resume-header">${headerHtml}</div>` + resolveDeflist(md.render(body));

// ---------- toolbar CSS ----------
const themeColor = styles.themeColor;
const toolbarCss = [
  `#resume-preview { font-family: ${styles.fontEN.fontFamily || styles.fontEN.name}, ${styles.fontCJK.fontFamily || styles.fontCJK.name}, Arial, Helvetica, sans-serif; }`,
  `#resume-preview { font-size: ${styles.fontSize}px; }`,
  `#resume-preview :not(.resume-header-item) > a { color: ${themeColor}; }`,
  `#resume-preview h1, #resume-preview h2, #resume-preview h3 { color: ${themeColor}; }`,
  `#resume-preview h2 { border-bottom-color: ${themeColor}; }`,
  `#resume-preview h2 { margin-top: ${styles.paragraphSpace}px; }`,
  `#resume-preview p, #resume-preview li { line-height: ${styles.lineHeight.toFixed(2)}; }`,
  `#resume-preview h2, #resume-preview h3 { line-height: ${(styles.lineHeight * 1.154).toFixed(2)}; }`,
  `#resume-preview dl { line-height: ${(styles.lineHeight * 1.038).toFixed(2)}; }`,
  `@media print { @page { size: ${styles.paper}; } }`
].join("\n");

const localFontCss = `#resume-preview { font-family: Georgia, "Minion Pro", "Noto Serif SC", "SimSun", "宋体", "Songti SC", Arial, sans-serif; }
/* SimSun/宋体 没有真正的粗体字形，中文 strong/b/标题会视觉上"加粗无效」；
   这里把粗体上下文优先切到有真实 Bold 字重的中文字体，避免打印后看不出加粗 */
#resume-preview strong, #resume-preview b,
#resume-preview h1, #resume-preview h2, #resume-preview h3 {
  font-family: Georgia, "Minion Pro", "Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Serif SC", Arial, sans-serif;
}`;

const iconify = fs.readFileSync("/tmp/mdtest/iconify.min.js", "utf8");
const markdownItJs = fs.readFileSync("/tmp/mdtest/node_modules/markdown-it/dist/markdown-it.cjs.js", "utf8");
const deflistJs = fs.readFileSync("/tmp/mdtest/node_modules/markdown-it-deflist/dist/markdown-it-deflist.min.js", "utf8");

// ---------- pagination ----------
const pageJs = `
const size = { width: ${(210 * 96 / 25.4).toFixed(1)}, height: ${((styles.paper === "A4" ? 297 : 279) * 96 / 25.4).toFixed(2)} };
const margins = { top: ${styles.marginTop ?? styles.marginV}, bottom: ${Math.max(styles.marginV - 10, 10)}, left: ${styles.marginH}, right: ${styles.marginH} };
const NEW_PAGE_CLASS = "md-it-newpage";
const elementHeight = (el) => {
  const s = window.getComputedStyle(el);
  return el.clientHeight + (parseInt(s.marginTop) || 0) + (parseInt(s.marginBottom) || 0);
};
const createPage = (size, margins) => {
  const page = document.createElement("div");
  page.dataset.scope = "vue-smart-pages";
  page.dataset.part = "page";
  page.style.height = size.height + "px";
  page.style.width = size.width + "px";
  page.style.padding = margins.top + "px " + margins.right + "px " + margins.bottom + "px " + margins.left + "px";
  return page;
};
const breakPage = (target) => {
  const maxHeight = size.height - margins.top - margins.bottom;
  const pages = document.createElement("div");
  let accHeight = 0;
  let page = createPage(size, margins);
  Array.from(target.children).forEach((child) => {
    const h = elementHeight(child);
    if (accHeight + h > maxHeight || child.className === NEW_PAGE_CLASS) {
      pages.appendChild(page);
      accHeight = 0;
      page = createPage(size, margins);
    }
    page.appendChild(child);
    accHeight += h;
  });
  pages.appendChild(page);
  target.innerHTML = pages.innerHTML;
};
const content = ${JSON.stringify(contentHtml)};
const target = document.getElementById("resume-preview");
target.innerHTML = content;
try { Iconify.scan(target); } catch (e) {}
requestAnimationFrame(() => requestAnimationFrame(() => {
  breakPage(target);
  document.body.setAttribute("data-ready", "1");
}));
`;

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>张目远 - 简历预览（oh-my-cv 风格）</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e8e8e8; }
  #resume-preview { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 16px 0; }
  #resume-preview [data-scope="vue-smart-pages"][data-part="page"] {
    box-shadow: 0 2px 10px rgba(0,0,0,.18);
  }
  ${toolbarCss}
  ${localFontCss}
  ${userCss}
  @media print {
    html, body { background: white; }
    #resume-preview { display: block; gap: 0; padding: 0; }
    #resume-preview [data-scope="vue-smart-pages"][data-part="page"] { box-shadow: none; }
  }
</style>
</head>
<body>
<div id="resume-preview"></div>
<script>${iconify}</script>
<script>${markdownItJs}</script>
<script>${deflistJs}</script>
<script>${pageJs}</script>
</body>
</html>
`;

fs.writeFileSync(`/tmp/mdtest/${OUT_FILE}`, html, "utf8");
console.log(`Wrote ${OUT_FILE}, ${html.length} bytes`);
