#!/bin/bash
# Mac：双击启动「多发」。真正的启动步骤在 scripts/start.js（Windows 的 启动多发.bat 也调用它）
#   · 启动成功后本终端窗口自动收起；退出时（点界面左上角的电源图标或关掉独立 Chrome 窗口）本窗口一起关掉
cd "$(dirname "$0")"

if ! command -v node > /dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 22 或更新版本：https://nodejs.org/zh-cn/download"
  read -r -p "按回车关闭本窗口…" _
  exit 1
fi

# 让服务知道要收起/关闭的是哪个终端窗口
DUOFA_TTY="$(tty 2>/dev/null)"
case "$DUOFA_TTY" in /dev/ttys*) ;; *) DUOFA_TTY="" ;; esac
export DUOFA_TTY

node scripts/start.js || read -r -p "按回车关闭本窗口…" _
