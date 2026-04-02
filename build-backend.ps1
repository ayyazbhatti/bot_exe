# Build the Rust backend. Requires Visual Studio Build Tools with C++ workload.
# If you see "link.exe not found", install: https://visualstudio.microsoft.com/visual-cpp-build-tools/
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot
cargo build --release --manifest-path backend/Cargo.toml
