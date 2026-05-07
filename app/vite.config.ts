import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
    plugins: [
        react(),
        nodePolyfills({
            globals: { Buffer: true, global: true, process: true },
            protocolImports: true,
            include: [
                'assert',
                'buffer',
                'crypto',
                'events',
                'net',
                'path',
                'process',
                'stream',
                'tty',
                'util',
            ],
        }),
    ],
    server: {
        port: 5173,
        // Required for Barretenberg WASM to use SharedArrayBuffer (multithreaded proving).
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    // Aztec foundation uses top-level await; needs esnext.
    build: { target: 'esnext', sourcemap: true },
    optimizeDeps: {
        esbuildOptions: { target: 'esnext', sourcemap: true },
        include: [
            '@aztec/aztec.js/node',
            '@aztec/aztec.js/fields',
            '@aztec/aztec.js/addresses',
'@aztec/wallets/embedded',
            '@aztec/accounts/testing',
            '@aztec/foundation/curves/bn254',
            '@aztec/foundation/crypto/sync',
        ],
        // These packages load their .wasm via `new URL(..., import.meta.url)`.
        // Prebundling them breaks that URL resolution, so leave them as-is.
        exclude: [
            '@aztec/noir-acvm_js',
            '@aztec/noir-noirc_abi',
            '@aztec/bb.js',
        ],
    },
});
