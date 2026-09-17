#!/usr/bin/env bash
# 一键导出 PDF：resume.md / resume-v2.0.md → oh-my-cv 风格 PDF
# 用法:
#   ./export-pdf.sh resume.md        # 输出: 简历预览-v1-ohmycv风格.pdf（临时文件）
#   ./export-pdf.sh resume-v2.0.md   # 输出: 简历预览-v2.0-ohmycv风格.pdf（临时文件）
#   ./export-pdf.sh resume-dji.md    # 输出: 简历预览-dji-ohmycv风格.pdf（临时文件，投递大疆用）
# 依赖:
#   - Windows Chrome (默认路径: /mnt/c/Program Files/Google/Chrome/Application/chrome.exe)
#   - /tmp/mdtest 下的渲染依赖（npm 包 + iconify，见脚本内 BUILD_DIR 检查）
set -euo pipefail

cd "$(dirname "$0")"

MD_FILE="${1:-resume.md}"
BUILD_DIR="/tmp/mdtest"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
WIN_TEMP="C:\\Users\\17274\\AppData\\Local\\Temp"
WIN_TEMP_PATH="/mnt/c/Users/17274/AppData/Local/Temp"

# 生成对应的 json 名（与 make-import-json*.mjs 保持一致）
case "$MD_FILE" in
  resume.md)     JSON_FILE="ohmycv-data.json";     PDF_NAME="简历预览-ohmycv风格.pdf" ;;
  resume-v2.0.md) JSON_FILE="ohmycv-data-v2.0.json"; PDF_NAME="简历预览-v2.0-ohmycv风格.pdf" ;;
  resume-v3.0.md) JSON_FILE="ohmycv-data-v3.0.json"; PDF_NAME="简历预览-v3.0-ohmycv风格.pdf" ;;
  resume-v4.0.md) JSON_FILE="ohmycv-data-v4.0.json"; PDF_NAME="简历预览-v4.0-ohmycv风格.pdf" ;;
  resume-v5.0.md) JSON_FILE="ohmycv-data-v5.0.json"; PDF_NAME="简历预览-v5.0-ohmycv风格.pdf" ;;
  resume-v6.0.md) JSON_FILE="ohmycv-data-v6.0.json"; PDF_NAME="简历预览-v6.0-ohmycv风格.pdf" ;;
  resume-v7.0.md) JSON_FILE="ohmycv-data-v7.0.json"; PDF_NAME="简历预览-v7.0-ohmycv风格.pdf" ;;
  resume-dji.md)  JSON_FILE="ohmycv-data-dji.json";  PDF_NAME="简历预览-dji-ohmycv风格.pdf" ;;
  *) echo "未知 md 文件: $MD_FILE"; exit 1 ;;
esac

echo "==> 1/3 打包: $MD_FILE -> $JSON_FILE"
if [ "$MD_FILE" = "resume-dji.md" ]; then
  node make-import-json-dji.mjs
elif [ "$MD_FILE" = "resume-v7.0.md" ]; then
  node make-import-json-v7.mjs
elif [ "$MD_FILE" = "resume-v6.0.md" ]; then
  node make-import-json-v6.mjs
elif [ "$MD_FILE" = "resume-v5.0.md" ]; then
  node make-import-json-v5.mjs
elif [ "$MD_FILE" = "resume-v4.0.md" ]; then
  node make-import-json-v4.mjs
elif [ "$MD_FILE" = "resume-v3.0.md" ]; then
  node make-import-json-v3.mjs
elif [ "$MD_FILE" = "resume-v2.0.md" ]; then
  node make-import-json-v2.mjs
else
  node make-import-json.mjs
fi

echo "==> 2/3 渲染 HTML（复刻 oh-my-cv 管线）"
if [ ! -f "$BUILD_DIR/iconify.min.js" ] || [ ! -d "$BUILD_DIR/node_modules/markdown-it" ]; then
  echo "  初始化 $BUILD_DIR ..."
  mkdir -p "$BUILD_DIR"
  cd "$BUILD_DIR" && npm install markdown-it markdown-it-deflist js-yaml --silent
  curl -sL "https://code.iconify.design/3/3.1.0/iconify.min.js" -o iconify.min.js
  cd - >/dev/null
fi
# 每次都同步最新脚本，避免 BUILD_DIR 缓存的旧版本悄悄生效
cp build-ohmycv-preview.mjs "$BUILD_DIR/"
node "$BUILD_DIR/build-ohmycv-preview.mjs" "$JSON_FILE" "ohmycv-preview.html"

echo "==> 3/3 无头 Chrome 打印 PDF"
cp "$BUILD_DIR/ohmycv-preview.html" "$WIN_TEMP_PATH/ohmycv_preview.html"
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --user-data-dir="$WIN_TEMP\\chrome-profile-export" \
  --no-pdf-header-footer --virtual-time-budget=15000 \
  --print-to-pdf="$WIN_TEMP\\resume_export.pdf" \
  "file:///C:/Users/17274/AppData/Local/Temp/ohmycv_preview.html" 2>/dev/null

cp "$WIN_TEMP_PATH/resume_export.pdf" "$PDF_NAME"
echo "完成: $(pwd)/$PDF_NAME"
