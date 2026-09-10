#!/usr/bin/env bash

sudo apt-get update
sudo apt-get install -y \
	build-essential clang libclang-dev cmake pkg-config autoconf \
	zlib1g-dev libbz2-dev liblzma-dev libcurl4-openssl-dev libssl-dev

# --- 2. Rust toolchain (skip if `rustc` already on PATH) ---
if ! command -v rustc >/dev/null 2>&1; then
	curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
	source "$HOME/.cargo/env"
fi

# --- 3. Python venv + maturin ---
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip maturin

# --- 4. Build the wheel -> ./dist/*.whl ---
maturin build --release --out dist
ls -l dist/*.whl

