const path = require('path');
const webpack = require('webpack');

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy',  value: 'require-corp' },
        ],
      },
    ];
  },
  webpack(config) {
    // The @zama-fhe/react-sdk/wagmi build uses `watchConnection` (pre-2.14 name).
    // Wagmi 2.14+ renamed it to `watchConnections`. We only replace the import
    // when it originates inside the @zama-fhe package to avoid circular aliases.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /^wagmi\/actions$/,
        (resource) => {
          if (resource.context && resource.context.includes('@zama-fhe')) {
            resource.request = path.resolve(__dirname, 'lib/wagmi-actions-shim.ts');
          }
        },
      ),
    );
    return config;
  },
};

module.exports = nextConfig;
