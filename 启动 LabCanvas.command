#!/bin/zsh
LABCANVAS_ROOT=${0:A:h}
if [[ -d "$HOME/Applications/LabCanvas.app" ]]; then
  open "$HOME/Applications/LabCanvas.app"
elif [[ -d "$LABCANVAS_ROOT/release/mac-arm64/LabCanvas.app" ]]; then
  open "$LABCANVAS_ROOT/release/mac-arm64/LabCanvas.app"
else
  cd "$LABCANVAS_ROOT" || exit 1
  [[ -d node_modules ]] || npm ci
  [[ -f dist/index.html ]] || npm run build
  npm run desktop
fi
