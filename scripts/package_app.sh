set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$(swift build -c release --package-path "$project_dir" --show-bin-path)"
app_dir="$project_dir/dist/QJC System Status.app"
contents_dir="$app_dir/Contents"

rm -rf "$app_dir"
mkdir -p "$contents_dir/MacOS" "$contents_dir/Resources"
cp "$build_dir/QJCSystemStatus" "$contents_dir/MacOS/QJCSystemStatus"
cp "$project_dir/Resources/Info.plist" "$contents_dir/Info.plist"
cp -R "$build_dir/QJCSystemStatus_QJCSystemStatus.bundle" "$contents_dir/Resources/"
chmod +x "$contents_dir/MacOS/QJCSystemStatus"
codesign --force --deep --sign - "$app_dir"
echo "$app_dir"

