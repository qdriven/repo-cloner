#!/usr/bin/env bash
# CloneIt 一键安装: 检查依赖 → 启动后台服务 → 引导安装浏览器插件
# 配置优先级: 命令行参数 > 环境变量 (CLONEIT_*) > 配置文件 (cloneit.config.json) > 默认值
#
#   scripts/install.sh                        后台启动服务 (nohup)
#   scripts/install.sh --autostart            改用 launchd 开机自启 (macOS)
#   scripts/install.sh --config FILE          指定配置文件路径
#   scripts/install.sh --browser chrome|edge  指定浏览器
#   scripts/install.sh -- --mirror URL        "--" 之后的参数原样传给 server
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO/extension"

autostart=0
cfg_args=()
cli_browser=()
server_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --autostart) autostart=1 ;;
    --config)  [[ $# -ge 2 ]] || { echo "missing value for --config" >&2; exit 2; }; cfg_args=(--config "$2"); shift ;;
    --browser) [[ $# -ge 2 ]] || { echo "missing value for --browser" >&2; exit 2; }; cli_browser=(--browser "$2"); shift ;;
    --) shift; server_args=("$@"); break ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

echo "==> 1/3 检查依赖"
command -v node >/dev/null || { echo "缺少 Node.js (>= 18)" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$major" -ge 18 ]] || { echo "Node.js 版本过低: $(node -v), 需要 >= 18" >&2; exit 1; }
command -v git >/dev/null || { echo "缺少 git" >&2; exit 1; }
command -v curl >/dev/null || { echo "缺少 curl" >&2; exit 1; }
echo "    node $(node -v), $(git --version)"

# 复用 server/core.mjs 解析最终生效的 port / browser / token
resolved="$(CLONEIT_CORE="$REPO/server/core.mjs" node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { parseConfig } = await import(pathToFileURL(process.env.CLONEIT_CORE).href);
  let c;
  try { c = parseConfig(process.argv.slice(1)); }
  catch (e) { console.error("error: " + e.message); process.exit(1); }
  console.log(":" + c.port);
  console.log(":" + (c.browser || ""));
  console.log(":" + (c.token ? "1" : "0"));
' -- ${cfg_args[@]+"${cfg_args[@]}"} ${server_args[@]+"${server_args[@]}"} ${cli_browser[@]+"${cli_browser[@]}"})" || exit 1

port=""; browser=""; has_token="0"; idx=0
while IFS= read -r line; do
  val="${line#:}"
  case $idx in
    0) port="$val" ;;
    1) browser="$val" ;;
    2) has_token="$val" ;;
  esac
  idx=$((idx + 1))
done <<<"$resolved"

echo "==> 2/3 启动后台服务"
if [[ $autostart -eq 1 ]]; then
  "$REPO/scripts/service.sh" enable ${cfg_args[@]+"${cfg_args[@]}"} ${server_args[@]+"${server_args[@]}"}
else
  "$REPO/scripts/service.sh" start ${cfg_args[@]+"${cfg_args[@]}"} ${server_args[@]+"${server_args[@]}"}
fi

echo "==> 3/3 安装浏览器插件"
if [[ -z "$browser" ]]; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then browser=chrome
  elif [[ -d "/Applications/Microsoft Edge.app" ]]; then browser=edge
  fi
fi
case "$(tr '[:upper:]' '[:lower:]' <<<"$browser")" in
  chrome) app="Google Chrome"; page="chrome://extensions/" ;;
  edge)   app="Microsoft Edge"; page="edge://extensions/" ;;
  *)      app=""; page="chrome://extensions/" ;;
esac

if [[ "$(uname)" == Darwin ]]; then
  printf '%s' "$EXT_DIR" | pbcopy
  if [[ -n "$app" ]]; then
    osascript -e "tell application \"$app\" to activate" \
              -e "tell application \"$app\" to open location \"$page\"" >/dev/null 2>&1 || true
  fi
  open -R "$EXT_DIR/manifest.json" || true
fi

token_tip=""
if [[ "$has_token" == "1" ]]; then token_tip="（已启用 token，需在 options 填入相同 token）"; fi

cat <<EOF
    浏览器不允许脚本静默安装解压版插件, 还差最后一步 (只需做一次):
      1. 在 ${app:-浏览器} 的 $page 打开右上角「开发者模式」
      2. 把 Finder 里选中的 extension 文件夹拖进扩展页,
         或点「加载已解压的扩展程序」→ Cmd+Shift+G 粘贴路径 (已复制到剪贴板):
         $EXT_DIR
      3. 插件 options 点「测试连接」, 服务地址 http://127.0.0.1:$port$token_tip

完成。管理服务: scripts/service.sh status | logs | restart | stop
EOF
