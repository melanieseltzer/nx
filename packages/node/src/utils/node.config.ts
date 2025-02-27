import { appRootPath } from '@nrwl/devkit';
import { Configuration } from 'webpack';
import { merge } from 'webpack-merge';

import { getBaseWebpackPartial } from './config';
import { BuildNodeBuilderOptions } from './types';
import nodeExternals = require('webpack-node-externals');
import TerserPlugin = require('terser-webpack-plugin');

function getNodePartial(options: BuildNodeBuilderOptions) {
  const webpackConfig: Configuration = {
    output: {
      libraryTarget: 'commonjs',
    },
    target: 'node',
    node: false,
  };

  if (options.optimization) {
    webpackConfig.optimization = {
      minimize: true,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            mangle: false,
            keep_classnames: true,
          },
        }),
      ],
      concatenateModules: true,
    };
  }

  if (options.externalDependencies === 'all') {
    const modulesDir = `${appRootPath}/node_modules`;
    webpackConfig.externals = [nodeExternals({ modulesDir })];
  } else if (Array.isArray(options.externalDependencies)) {
    webpackConfig.externals = [
      function (context, callback: Function) {
        if (options.externalDependencies.includes(context.request)) {
          // not bundled
          return callback(null, `commonjs ${context.request}`);
        }
        // bundled
        callback();
      },
    ];
  }
  return webpackConfig;
}

export function getNodeWebpackConfig(options: BuildNodeBuilderOptions) {
  return merge([getBaseWebpackPartial(options), getNodePartial(options)]);
}
