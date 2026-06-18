# hash-wasm (vendored)

Pinned from npm `hash-wasm@4.12.0`.

ESM bundle: `esm/index.js` (copied from `dist/index.esm.js`).

Refresh:

```bash
cd frontend && npm pack hash-wasm@4.12.0
tar -xf hash-wasm-4.12.0.tgz package/dist/index.esm.js
cp package/dist/index.esm.js vendor/hash-wasm/esm/index.js
rm -rf package hash-wasm-4.12.0.tgz
```