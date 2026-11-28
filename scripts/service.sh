#!/usr/bin/env bash
# KeepIt 后台服务管理 (macOS / Linux)
# 配置优先级: 命令行参数 > 环境变量 (KEEPIT_*) > 配置文件 (keepit.config.json) > 默认值
#
#   scripts/service.sh start   [--config FILE] [server 参数...]   后台启动 (nohup)
#   scripts/service.sh stop | restart | status | logs
#   scripts/service.sh enable  [--config FILE] [server 参数...]   注册 launchd 开机自启 (macOS)
#   scripts/service.sh disable                                    取消开机自启
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$REPO/server/keepit-server.mjs"
RUN_DIR="$REPO/.run"
PID_FILE="$RUN_DIR/keepit.pid"
LOG_FILE="$RUN_DIR/keepit.log"
LABEL="com.innate.keepit"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

die() { echo "error: $*" >&2; exit 1; }

default_workspace() {
  local up; up="$(cd "$REPO/../.." && pwd)"
  if [[ -d "$up/references" ]]; then echo "$up"; else pwd; fi
}

node_bin() {
  local n; n="$(command -v node)" || die "未找到 node (需要 Node.js >= 18)"
  # fnm/nvm 的 shell 路径是临时的, launchd 需要真实路径
  if command -v realpath >/dev/null 2>&1; then realpath "$n"; else readlink -f "$n" 2>/dev/null || echo "$n"; fi
}

# 复用 server/core.mjs 解析 CLI > KEEPIT_* > keepit.config.json > 默认值
resolve_cfg() {
  local node; node="$(node_bin)"
  local out
  out="$(KEEPIT_CORE="$REPO/server/core.mjs" "$node" --input-type=module -e '
    import path from "node:path";
    import os from "node:os";
    import { pathToFileURL } from "node:url";
    const expand = (p) => p === "~" ? os.homedir() : (p.startsWith("~/") || p.startsWith("~\\")) ? path.join(os.homedir(), p.slice(2)) : p;
    const { parseConfig } = await import(pathToFileURL(process.env.KEEPIT_CORE).href);
    const raw = process.argv.slice(1);
    const normArgv = [];
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if ((a === "--workspace" || a === "--config") && raw[i + 1]) {
        normArgv.push(a, path.resolve(expand(raw[++i])));
      } else {
        normArgv.push(a);
      }
    }
    let cfg;
    try { cfg = parseConfig(normArgv); }
    catch (e) { console.error("error: " + e.message); process.exit(1); }
    const normEnvCfg = process.env.KEEPIT_CONFIG?.trim() ? path.resolve(expand(process.env.KEEPIT_CONFIG.trim())) : "";
    const normEnvWs = process.env.KEEPIT_WORKSPACE?.trim()
      ? process.env.KEEPIT_WORKSPACE.split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((d) => path.resolve(expand(d))).join(path.delimiter)
      : "";
    const emit = (v) => console.log(":" + String(v ?? "").replace(/[\r\n]/g, ""));
    emit(cfg.port);
    emit(cfg.token || "");
    emit(cfg.workspaceExplicit ? "1" : "0");
    emit(cfg.workspaces[0]?.dir || "");
    emit(cfg.loadedConfigFile || "");
    emit(normEnvCfg);
    emit(normEnvWs);
    for (const a of normArgv) emit(a);
  ' -- "$@")" || exit 1

  NORM_ARGS=()
  local i=0 line val
  while IFS= read -r line; do
    val="${line#:}"
    case $i in
      0) PORT="$val" ;;
      1) TOKEN="$val" ;;
      2) WS_EXPLICIT="$val" ;;
      3) CFG_WS0="$val" ;;
      4) LOADED_CFG="$val" ;;
      5) if [[ -n "$val" ]]; then export KEEPIT_CONFIG="$val"; fi ;;
      6) if [[ -n "$val" ]]; then export KEEPIT_WORKSPACE="$val"; fi ;;
      *) NORM_ARGS+=("$val") ;;
    esac
    i=$((i + 1))
  done <<<"$out"

  if [[ "$WS_EXPLICIT" == "1" ]]; then
    WORKSPACE="$CFG_WS0"
  else
    WORKSPACE="$(default_workspace)"
  fi
  [[ -d "$WORKSPACE" ]] || die "workspace 目录不存在: $WORKSPACE"

  SERVER_ARGS=()
  if [[ "$WS_EXPLICIT" == "0" ]]; then SERVER_ARGS+=(--workspace "$WORKSPACE"); fi
  if [[ ${#NORM_ARGS[@]} -gt 0 ]]; then SERVER_ARGS+=("${NORM_ARGS[@]}"); fi
}

ping_ok() {
  local h=()
  if [[ -n "$TOKEN" ]]; then h=(-H "X-KeepIt-Token: $TOKEN"); fi
  curl -fsS -m 2 ${h[@]+"${h[@]}"} "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1
}

pid_alive() { [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }
launchd_loaded() { [[ "$(uname)" == Darwin ]] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

wait_ready() {
  for _ in $(seq 1 20); do ping_ok && return 0; sleep 0.25; done
  return 1
}

cmd_start() {
  resolve_cfg "$@"
  if ping_ok; then echo "KeepIt 已在运行: http://127.0.0.1:$PORT"; return 0; fi
  mkdir -p "$RUN_DIR"
  local node; node="$(node_bin)"
  "$node" -e '
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const [cwd, logFile, pidFile, bin, ...args] = process.argv.slice(1);
    const out = fs.openSync(logFile, "a");
    const child = spawn(bin, args, { cwd, detached: true, stdio: ["ignore", out, out] });
    fs.writeFileSync(pidFile, String(child.pid) + "\n");
    child.unref();
  ' "$WORKSPACE" "$LOG_FILE" "$PID_FILE" "$node" "$SERVER" ${SERVER_ARGS[@]+"${SERVER_ARGS[@]}"}
  if wait_ready; then
    echo "KeepIt 已启动: http://127.0.0.1:$PORT  (pid $(cat "$PID_FILE"))"
    if [[ -n "$LOADED_CFG" ]]; then echo "  config:    $LOADED_CFG"; fi
    echo "  workspace: $WORKSPACE"
    echo "  log:       $LOG_FILE"
  else
    die "启动失败, 查看日志: $LOG_FILE"
  fi
}

cmd_stop() {
  resolve_cfg "$@"
  if launchd_loaded; then
    echo "服务由 launchd 托管 (会自动拉起), 请用: $0 disable"; return 1
  fi
  if pid_alive; then
    local pid; pid="$(cat "$PID_FILE")"
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    rm -f "$PID_FILE"
    echo "KeepIt 已停止"
  else
    rm -f "$PID_FILE"
    if ping_ok; then die "端口 $PORT 上的服务不是由本脚本启动的, 请手动结束"; else echo "KeepIt 未在运行"; fi
  fi
}

cmd_status() {
  resolve_cfg "$@"
  if ping_ok; then
    local mode="手动启动"
    if launchd_loaded; then mode="launchd 开机自启"; fi
    echo "运行中: http://127.0.0.1:$PORT  ($mode)"
    if [[ -n "$LOADED_CFG" ]]; then echo "  config:    $LOADED_CFG"; fi
    echo "  workspace: $WORKSPACE"
    echo "  log:       $LOG_FILE"
  else
    echo "未运行"; return 1
  fi
}

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

cmd_enable() {
  [[ "$(uname)" == Darwin ]] || die "enable 仅支持 macOS (launchd); 其他系统请用 start"
  resolve_cfg "$@"
  if pid_alive; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; sleep 0.5; fi
  if launchd_loaded; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; fi
  mkdir -p "$RUN_DIR" "$(dirname "$PLIST")"
  local node; node="$(node_bin)"
  local prog="" a
  for a in "$node" "$SERVER" ${SERVER_ARGS[@]+"${SERVER_ARGS[@]}"}; do
    prog+="    <string>$(xml_escape "$a")</string>"$'\n'
  done
  local env_xml="    <key>PATH</key><string>$(xml_escape "$(dirname "$node"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")</string>"$'\n'
  local k v
  for k in KEEPIT_CONFIG KEEPIT_WORKSPACE KEEPIT_PORT KEEPIT_TOKEN KEEPIT_MIRROR KEEPIT_PROXY \
           KEEPIT_MAX_CONCURRENT KEEPIT_RETRY KEEPIT_FULL KEEPIT_NO_PULL KEEPIT_CLONE_TIMEOUT KEEPIT_WATCH_CLIPBOARD; do
    v="$(printenv "$k" || true)"
    if [[ -n "$v" ]]; then env_xml+="    <key>$k</key><string>$(xml_escape "$v")</string>"$'\n'; fi
  done
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$prog  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$WORKSPACE")</string>
  <key>EnvironmentVariables</key>
  <dict>
$env_xml  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_FILE")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_FILE")</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  wait_ready || die "launchd 已注册但服务未就绪, 查看日志: $LOG_FILE"
  echo "KeepIt 已注册开机自启并启动: http://127.0.0.1:$PORT"
  if [[ -n "$LOADED_CFG" ]]; then echo "  config: $LOADED_CFG"; fi
  echo "  plist:  $PLIST"
}

cmd_disable() {
  [[ "$(uname)" == Darwin ]] || die "disable 仅支持 macOS"
  if launchd_loaded; then launchctl bootout "gui/$(id -u)/$LABEL" || true; fi
  rm -f "$PLIST"
  echo "已取消开机自启"
}

sub="${1:-status}"; shift || true
case "$sub" in
  start)   cmd_start "$@" ;;
  stop)    cmd_stop "$@" ;;
  restart)
    resolve_cfg "$@"
    if launchd_loaded; then launchctl kickstart -k "gui/$(id -u)/$LABEL" && wait_ready && echo "KeepIt 已重启 (launchd)"
    else cmd_stop "$@" || true; cmd_start "$@"; fi ;;
  status)  cmd_status "$@" ;;
  logs)    touch "$LOG_FILE" 2>/dev/null || true; tail -n 50 -f "$LOG_FILE" ;;
  enable)  cmd_enable "$@" ;;
  disable) cmd_disable ;;
  *) sed -n '2,8p' "$0"; exit 2 ;;
esac
